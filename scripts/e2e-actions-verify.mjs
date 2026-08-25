#!/usr/bin/env node
// e2e-actions-verify.mjs — LF-06 action 桥真机闭环验证（IMPROVEMENT_PLAN_3 阶段 I1）。
//
// 目标：把「进程插件经桥调 /actions/call → 前端执行 client-action handler → 回传真实结果」
// 这条此前从未真机跑通过的链路，固化为可重复的闭环断言。
//
// 链路：
//   1. 打开内置 client 插件 action-demo（其声明 demo.hello action）→ 触发前端把
//      demo.hello 的 handler 注册进 clientActionBridge 的 registry（见 App.tsx 启动期注册 +
//      PluginRunner 打开即注册，双层保障）。
//   2. 以「action invocation」会话启动内置进程插件 action-caller（start_builtin_plugin
//      actionInvocation=true）：该会话经 register_action_session 武装了
//      action_invocation_id + action_context，使其能合法调用 /actions/call（否则回
//      action_dependency_denied）。
//   3. action-caller 裸 fetch 直连桥调 demo.hello，把真实响应写 result.json。
//   4. 轮询 result.json（经 Tauri read_plugin_file 读插件目录，规避 materialized 路径不固定），
//      断言 ok:true 且 greeting 含输入名 "lingfang" —— 即真机拿到了真实结果，而非
//      action_dependency_unresolved 占位。
//
// 反向稳定对照：clientActionBridge.spec.ts 已断言「handler 未注册 → action_dependency_unresolved」，
// 锁定「无 armed session / 无 handler 即失败」的稳态；本脚本只验证正向闭环打通。
//
// 用法（cwd = apps/desktop）：
//   pnpm exec node ../../scripts/e2e-actions-verify.mjs          # 先构建再验证
//   E2E_SKIP_BUILD=1 pnpm exec node ../../scripts/e2e-actions-verify.mjs  # 复用 target/debug
//
// 依赖 @playwright/test（仅用其 CDP 连接）。仅 Windows（WebView2）。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const desktopDir = path.join(repoRoot, 'apps', 'desktop');

const requireFromDesktop = createRequire(path.join(desktopDir, 'package.json'));
const { chromium } = requireFromDesktop('@playwright/test');

const DEMO_NAME = 'Action Demo'; // builtin-plugins/action-demo/manifest.json name
const DEMO_ID = 'builtin.action-demo';
const CALLER_ID = 'builtin.action-caller';
const EXE_CANDIDATES = ['lingfang-desktop.exe', '灵坊工作台.exe', 'main.exe'];
const OVERALL_TIMEOUT_MS = 6 * 60 * 1000;
const CALLER_TIMEOUT_MS = 60_000; // 等 action-caller 跑完并落 result.json

function log(msg) {
  console.log(`[e2e-actions] ${msg}`);
}

function assert(cond, label) {
  if (!cond) throw new Error(`断言失败：${label}`);
  log(`✔ ${label}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function findDebugExe() {
  const debugDir = path.join(repoRoot, 'target', 'debug');
  if (!fs.existsSync(debugDir)) return null;
  let best = null;
  for (const name of EXE_CANDIDATES) {
    const p = path.join(debugDir, name);
    if (fs.existsSync(p)) {
      const mtime = fs.statSync(p).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: p, mtime };
    }
  }
  return best?.path ?? null;
}

function buildDesktop() {
  log('构建 debug 产物（tauri build --no-bundle --debug）…');
  const r = spawnSync('pnpm', ['exec', 'tauri', 'build', '--no-bundle', '--debug'], {
    cwd: desktopDir,
    stdio: 'inherit',
    shell: true,
  });
  if (r.status !== 0) throw new Error(`tauri build 失败（exit=${r.status}）`);
}

function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: true, stdio: 'ignore' });
}

async function waitForCdp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      /* WebView2 尚未就绪 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`等待 CDP(${port}) 超时`);
}

async function run() {
  const skipBuild = process.env.E2E_SKIP_BUILD === '1';
  let exe = findDebugExe();
  if (!skipBuild || !exe) {
    buildDesktop();
    exe = findDebugExe();
  }
  if (!exe) throw new Error(`target/debug 下未找到产物（候选：${EXE_CANDIDATES.join(', ')}）`);
  log(`产物：${exe}`);

  const port = await freePort();
  log(`启动桌面壳，CDP 端口 ${port} …`);
  const child = spawn(exe, [], {
    cwd: path.dirname(exe),
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: 'ignore',
    detached: true,
  });

  const timer = setTimeout(() => {
    killTree(child.pid);
    console.error(`[e2e-actions] 总超时（${OVERALL_TIMEOUT_MS / 1000}s），已强制退出`);
    process.exit(1);
  }, OVERALL_TIMEOUT_MS);

  try {
    await waitForCdp(port, 90_000);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    const page = context.pages().find((p) => /tauri/i.test(p.url())) ?? context.pages()[0];
    assert(page, 'CDP 连接成功并找到桌面壳页面');

    page.on('console', (msg) => log(`[console:${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => log(`[pageerror] ${err?.message ?? err}`));

    const invoke = (cmd, args) =>
      page.evaluate(
        ([c, a]) => window.__TAURI__.core.invoke(c, a),
        [cmd, args ?? {}]
      );

    // 1. 打开 action-demo（注册 demo.hello client-action handler）
    log('等待插件中心渲染…');
    await page.waitForSelector(`text=${DEMO_NAME}`, { timeout: 30_000 });
    assert(true, `插件中心渲染，已安装列表含「${DEMO_NAME}」`);

    const row = page.locator('div.divide-y > div', { hasText: DEMO_NAME }).first();
    await row.getByRole('button', { name: '运行', exact: true }).click();
    // client-action 注册在打开即发生；给前端一点时间完成 registerClientActionsForPlugin。
    await page.waitForTimeout(2_000);
    log('已打开 action-demo（demo.hello handler 应已注册）');

    // 2. 以 action invocation 会话启动 action-caller。
    // 注意：action-caller 是一次性的「发请求→写 result.json→exit(0)」脚本，
    // 瞬时退出会被 spawn 监视误判为「秒退崩溃」并令 start_builtin_plugin 返回 Err；
    // 但其 result.json 已落盘，故此处吞掉启动返回错误，转而轮询 result.json 判定真机结果。
    log('以 actionInvocation=true 启动 action-caller 进程插件…');
    try {
      const startResult = await invoke('start_builtin_plugin', {
        pluginId: CALLER_ID,
        actionInvocation: true,
      });
      if (startResult && typeof startResult.pid === 'number') {
        log(`action-caller 进程已启动（pid=${startResult.pid}）`);
      } else {
        log('action-caller 已启动（一次性脚本，启动接口可能回崩溃误报，继续轮询 result.json）');
      }
    } catch (err) {
      log(`start_builtin_plugin 返回异常（一次性脚本秒退误报，继续轮询 result.json）：${err?.message ?? err}`);
    }

    // 3+4. 轮询 action-caller 的 result.json，断言真机拿到真实结果
    log('轮询 action-caller 的 result.json …');
    const deadline = Date.now() + CALLER_TIMEOUT_MS;
    let lastRaw = null;
    let parsed = null;
    while (Date.now() < deadline) {
      try {
        const raw = await invoke('read_plugin_file', { pluginId: CALLER_ID, file: 'result.json' });
        lastRaw = raw;
        parsed = JSON.parse(raw);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (!parsed) {
      throw new Error(
        `轮询 result.json 超时（${CALLER_TIMEOUT_MS / 1000}s）；最后读到：${String(lastRaw ?? '<无>')}`
      );
    }
    assert(parsed.ok === true, `action-caller 拿到真实结果（ok=true）；raw=${JSON.stringify(parsed)}`);
    const greeting =
      (parsed.result && parsed.result.greeting) ||
      (parsed.result && typeof parsed.result === 'string' ? parsed.result : '');
    assert(
      typeof greeting === 'string' && greeting.includes('lingfang'),
      `demo.hello 真实返回 greeting 含输入名「lingfang」：${JSON.stringify(greeting)}`
    );

    log('action 桥真机闭环验证通过 ✅');
  } finally {
    clearTimeout(timer);
    killTree(child.pid);
  }
}

run().catch((err) => {
  console.error(`[e2e-actions] 失败：${err?.stack ?? err}`);
  process.exit(1);
});
