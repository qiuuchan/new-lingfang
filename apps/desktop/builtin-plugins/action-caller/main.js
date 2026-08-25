// action-caller/main.js — LF-06 内置 fixture（runtime_type: nodejs）。
//
// 由桌面壳以「action invocation」会话启动（start_builtin_plugin 的 actionInvocation=true），
// 该会话经 register_action_session 武装了 action_invocation_id + action_context，
// 使本进程可合法调用桥路由 /actions/call（否则 route_action_call 返回 action_dependency_denied）。
//
// 启动时：裸 fetch 直连桥调 demo.hello，把真实响应（或失败码）写 result.json，然后 exit 0。
// 不 import plugin-sdk（规避内置插件 SDK 分发问题，与 IMPROVEMENT_PLAN_3 I1 约定一致）。

const http = require('http');
const fs = require('fs');
const path = require('path');

const BRIDGE_URL = process.env.LINGFANG_PLUGIN_BRIDGE_URL || '';
const BRIDGE_TOKEN = process.env.LINGFANG_PLUGIN_BRIDGE_TOKEN || '';
// 用自身模块目录定位 result.json（cwd 也是插件目录，但显式取模块目录更稳）。
const RESULT_PATH = path.join(__dirname, 'result.json');

function writeResult(payload) {
  try {
    fs.writeFileSync(RESULT_PATH, JSON.stringify(payload, null, 2) + '\n');
    console.error(`[action-caller] 已写入 ${RESULT_PATH}: ${JSON.stringify(payload)}`);
  } catch (err) {
    console.error(`[action-caller] 写 result.json 失败：${err && err.message}`);
  }
}

function fail(code, message) {
  writeResult({ ok: false, error_code: code, error_message: message });
  process.exit(0);
}

if (!BRIDGE_URL || !BRIDGE_TOKEN) {
  fail('action_runtime_unavailable', '缺少桥 URL/Token 环境变量（未以 action invocation 会话启动）');
}

const body = JSON.stringify({ dependency_id: 'demo.hello', input: { name: 'lingfang' } });
const url = new URL(BRIDGE_URL);
const reqPath = '/actions/call';

const req = http.request(
  {
    protocol: url.protocol,
    host: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: reqPath,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'X-LingFang-Plugin-Token': BRIDGE_TOKEN,
    },
  },
  (res) => {
    let data = '';
    res.on('data', (chunk) => (data += chunk));
    res.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        return fail('action_execution_failed', `桥返回非 JSON 响应（status=${res.statusCode}）：{data}`);
      }
      // 桥成功时 body 即前端回传的 result 本身（如 {greeting:"..."}，见 route_action_call
      // 成功分支直接返回 Ok(result)）；失败时为 {code,message,status,requestId}（非 /v1/ 路径）。
      if (res.statusCode >= 200 && res.statusCode < 300 && parsed && !parsed.code) {
        writeResult({ ok: true, result: parsed });
      } else if (parsed && parsed.code) {
        writeResult({
          ok: false,
          error_code: parsed.code || 'action_execution_failed',
          error_message: parsed.message || 'unknown action error',
        });
      } else {
        fail('action_execution_failed', `桥返回意外形状（status=${res.statusCode}）：${data}`);
      }
      process.exit(0);
    });
  }
);

req.on('error', (err) => fail('action_runtime_unavailable', `桥请求失败：${err.message}`));
req.setTimeout(30_000, () => {
  req.destroy();
  fail('action_timeout', '桥请求超时（30s）');
});
req.write(body);
