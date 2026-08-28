//! e2e-kb-station-verify.mjs — LF-23 R1 真用插件（知识库工作站）真机闭环。
//!
//! CDP 驱动 kb-station iframe 内 `window.__kb` 钩子（与按钮同路径），走
//! 导入 → 列表 → 持久化 → 检索 → LLM 问答 全链：
//!   1. importText 粘贴导入 → 切片数 ≥1
//!   2. listDocs 命中导入文档（storage.kv 持久化）
//!   3. search 关键词检索 → 命中片段含关键词（客户端 JS 打分）
//!   4. ask 检索+问答 → relay-adapter(MOCK) 返回 → 答案渲染（无错误降级）
//!   5. fs.read 白名单路径读取 $HOME/Documents 下真实 .md 文件（导入闭环）
//!   6. 页面 reload 后文档仍在（kv 跨刷新持久化）
//!
//! 前置：release 桌面壳 + kb-station 已 build（脚本自动补）。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const requireFromDesktop = createRequire(path.resolve('apps/desktop/package.json'));
const { chromium } = requireFromDesktop('@playwright/test');

const REPO_ROOT = process.cwd();
const MAIN_EXE = 'lingfang-desktop.exe';
const PLUGIN = { id: 'com.lingfang.kb-station', name: '知识库工作站' };
const KB_ARTIFACT = path.join(REPO_ROOT, 'packages/plugin-sdk', 'com.lingfang.kb-station-0.1.0.lfplugin');

let failed = 0;
const log = (msg) => console.log(`[e2e-kb] ${msg}`);
const ok = (msg) => console.log(`  ✅ ${msg}`);
const fail = (msg) => {
  console.error(`  ❌ ${msg}`);
  failed += 1;
};
const assert = (cond, msg) => (cond ? ok(msg) : fail(msg));

function isElevated() {
  try {
    const out = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        '$id=[System.Security.Principal.WindowsIdentity]::GetCurrent();' +
          '$p=New-Object System.Security.Principal.WindowsPrincipal($id);' +
          '$p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' },
    );
    return out.stdout.trim() === 'True';
  } catch {
    return false;
  }
}

async function spawnElevated(exe, env) {
  const taskName = `LingFangE2E_${process.pid}_${Date.now()}`;
  const launcherPath = path.join(os.tmpdir(), `${taskName}.bat`);
  const bat = [
    '@echo off',
    `set "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=${env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS ?? ''}"`,
    `set "WEBVIEW2_USER_DATA_FOLDER=${env.WEBVIEW2_USER_DATA_FOLDER ?? ''}"`,
    `cd /d "${path.dirname(exe)}"`,
    `start "" "${exe}"`,
    '',
  ].join('\r\n');
  fs.writeFileSync(launcherPath, bat, 'latin1');
  const psCreate = [
    '$ErrorActionPreference="Stop"',
    `$tn="${taskName}"`,
    `$lp="${launcherPath}"`,
    `$act=New-ScheduledTaskAction -Execute "cmd.exe" -Argument ('/c "' + $lp + '"')`,
    `$prin=New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType Interactive -RunLevel Limited`,
    `Register-ScheduledTask -TaskName $tn -Action $act -Principal $prin -Force | Out-Null`,
    `Start-ScheduledTask -TaskName $tn`,
    `$i=Get-ScheduledTaskInfo -TaskName $tn`,
    `"LastTaskResult=0x{0:X}" -f $i.LastTaskResult`,
  ].join('; ');
  const cr = spawnSync('powershell', ['-NoProfile', '-Command', psCreate], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (cr.status !== 0) throw new Error(`Task Scheduler 注册失败：exit=${cr.status} err=${cr.stderr}`);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const out = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='${path.basename(exe)}'" | ` +
            'Sort-Object CreationDate -Descending | Select-Object -First 1 -ExpandProperty ProcessId',
        ],
        { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' },
      );
      const pid = parseInt((out.stdout ?? '').trim(), 10);
      if (pid > 0) return { pid, env };
    } catch {
      /* 继续轮询 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Task Scheduler 降权启动后未找到 ${path.basename(exe)} 进程`);
}

function spawnShell(exe, port, webviewDataDir, extraEnv = {}) {
  const appEnv = {
    ...process.env,
    ...extraEnv,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: webviewDataDir,
  };
  if (isElevated()) return spawnElevated(exe, appEnv);
  const child = spawn(exe, [], {
    cwd: path.dirname(exe),
    env: appEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  return { pid: child.pid, env: appEnv };
}

async function waitForCdp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      /* 未就绪 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`等待 CDP(${port}) 超时`);
}

async function connectPage(port) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  await new Promise((r) => setTimeout(r, 2500));
  const page = context.pages().find((p) => /tauri/i.test(p.url())) ?? context.pages()[0];
  assert(page, `CDP 连接成功并找到桌面壳页面 (${port})`);
  return { browser, page };
}

const evaluateWithTimeout = (page, fn, arg, timeoutMs = 20_000, label = 'evaluate') =>
  Promise.race([
    page.evaluate(fn, arg),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 超时 ${timeoutMs}ms`)), timeoutMs)),
  ]);

function freePort() {
  const srv = http.createServer();
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: true, stdio: 'ignore' });
}

// ── 主流程 ───────────────────────────────────────────────────────────────

async function run() {
  const tmpRoot = path.join(os.tmpdir(), `lingfang-kb-e2e-${Date.now()}`);
  fs.mkdirSync(tmpRoot, { recursive: true });
  const webviewData = path.join(tmpRoot, 'webview-data');
  let appHandle = null;
  let adapter = null;
  const port = await freePort();
  const KB_DOC = '灵坊工作台是一个零服务器的 Tauri v2 桌面插件平台。' +
    '它运行第三方插件，所有特权调用都经过能力网关检查。' +
    '客户端插件在沙箱 iframe 中运行，nodejs 与 python 插件是普通操作系统进程。' +
    '插件的安全模型分三档：iframe 沙箱、进程生命周期围栏、安装时信任。';

  log(`tmpRoot=${tmpRoot}，CDP port=${port}`);

  try {
    // 0. relay-adapter（MOCK：llm.chat 返回确定性内容）
    const adapterPort = await freePort();
    adapter = spawn(process.execPath, [path.join(REPO_ROOT, 'scripts/relay-adapter.mjs')], {
      env: { ...process.env, RELAY_ADAPTER_PORT: String(adapterPort), RELAY_ADAPTER_MOCK: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    await new Promise((r) => setTimeout(r, 1500));
    log(`relay-adapter(MOCK) http://127.0.0.1:${adapterPort}`);

    // 1. 桌面壳（release 产物 + relay 凭据 env）
    const exe = path.join(REPO_ROOT, 'target/release', MAIN_EXE);
    if (!fs.existsSync(exe)) throw new Error(`未找到 release 桌面壳：${exe}`);
    appHandle = spawnShell(exe, port, webviewData, {
      LINGFANG_RELAY_API_BASE: `http://127.0.0.1:${adapterPort}`,
      LINGFANG_RELAY_TOKEN: 'mock-token',
    });
    await waitForCdp(port, 90_000);
    const { browser, page } = await connectPage(port);

    // 2. 清场并导入 kb-station
    if (!fs.existsSync(KB_ARTIFACT)) {
      const r = spawnSync('pnpm', ['-C', 'packages/plugin-sdk', 'cli:dev', 'build', 'packages/plugin-sdk/examples/kb-station'], {
        cwd: REPO_ROOT, stdio: 'inherit', shell: true,
      });
      if (r.status !== 0) throw new Error('kb-station 构建失败');
    }
    const existing = await evaluateWithTimeout(
      page,
      (cmd) =>
        window.__TAURI__.core.invoke(cmd).then(
          (v) => (v ?? []).map((i) => ({ installationId: i.installationId, packageId: i.packageId })),
          () => [],
        ),
      'list_plugin_installations',
    );
    const match = (existing ?? []).find((i) => String(i.packageId).includes(PLUGIN.id));
    if (match?.installationId) {
      await evaluateWithTimeout(
        page,
        ([cmd, id]) => window.__TAURI__.core.invoke(cmd, { installationId: id }).catch(() => null),
        ['uninstall_plugin_installation', match.installationId],
      );
    }
    const imported = await evaluateWithTimeout(
      page,
      ([cmd, artifactPath]) =>
        window.__TAURI__.core.invoke(cmd, {
          input: { artifactPath, expectedSha256: null, packageId: null, releaseId: null, origin: 'local', protected: false },
        }).then((v) => ({ ok: true, origin: v.origin }), (e) => ({ ok: false, msg: String(e) })),
      ['install_plugin_artifact', KB_ARTIFACT],
    );
    assert(imported.ok && imported.origin === 'local', `导入 kb-station（${imported.ok ? `origin=${imported.origin}` : imported.msg}）`);

    // 3. 打开 kb-station
    log('打开知识库工作站…');
    await page.reload();
    await page.waitForSelector('text=知识库工作站', { timeout: 30_000 });
    const row = page.locator('div.divide-y > div', { hasText: '知识库工作站' }).first();
    await row.getByRole('button', { name: '运行', exact: true }).click();
    await page.locator('iframe[sandbox="allow-scripts"]', { hasTitle: '知识库工作站' }).waitFor({ state: 'visible', timeout: 30_000 });
    // ⚠️ 用 frame.evaluate（page 同款参数语义）；locator.evaluate 会把数组参数
    // 序列化成空对象（LF-23 实测：['a','b'] → {} → 解构报 object is not iterable）。
    // frame 定位按「嵌套 iframe」取（srcdoc 的 url 在 Playwright 里是 about:srcdoc）。
    const kbFrame = page.frames().find((f) => f.parentFrame() !== null);
    assert(kbFrame, '找到 kb-station iframe');
    const kbEval = (fn, arg) => kbFrame.evaluate(fn, arg);

    // 4. 粘贴导入 → 切片 → 列表
    log('驱动 window.__kb 走导入/检索/问答全链…');
    const importResult = await kbEval(async ([title, text]) => {
      const r = await window.__kb.importText(title, text);
      return { id: r.id, chunks: r.chunks };
    }, ['e2e-灵坊安全模型', KB_DOC]);
    assert(importResult.chunks >= 1, `粘贴导入生成 ${importResult.chunks} 个切片`);

    const docs = await kbEval(() => window.__kb.listDocs());
    const found = docs.find((d) => d.title === 'e2e-灵坊安全模型');
    assert(Boolean(found), `listDocs 包含导入文档（${docs.length} 篇，标题=${found?.title}）`);

    // 5. 关键词检索（客户端 JS 打分）
    const hits = await kbEval((q) => window.__kb.search(q), '能力网关');
    assert(
      hits.length >= 1 && hits[0].text.includes('能力网关'),
      `关键词检索命中（${hits.length} 条，命中文本含「能力网关」）`,
    );

    // 6. LLM 问答（MOCK relay → 确定性回答）
    const askState = await kbEval(async (q) => {
      const hits = await window.__kb.search(q);
      const context = hits.map((h, i) => '【片段 ' + (i + 1) + '】' + h.text).join('\n\n');
      try {
        const out = await window.sdk.llm.chat({
          messages: [
            { role: 'system', content: '你是本地知识库助手。仅依据检索片段回答。' },
            { role: 'user', content: '检索片段：\n' + context + '\n\n问题：' + q },
          ],
        });
        return { ok: true, answer: (out && out.content) || '' };
      } catch (e) {
        return { ok: false, err: ((e && e.message) || String(e)), code: (e && e.code) || '' };
      }
    }, '这个项目是什么？');
    assert(askState.ok && askState.answer.length > 0, `LLM 问答返回（${askState.ok ? '长度 ' + askState.answer.length : askState.err}）`);
    assert(
      askState.ok && /链路已通|工作台|插件/.test(askState.answer),
      `答案内容含 MOCK 链路标识或主题词（${String(askState.answer).slice(0, 60)}…）`,
    );

    // 7. fs.read 白名单闭环：$HOME/Documents 下建测试文件并读取导入
    const docFile = path.join(os.homedir(), 'Documents', 'kb-e2e-note.md');
    fs.writeFileSync(docFile, '灵坊工作台的 fs.read 能力要求路径白名单声明。\n本文件用于 LF-23 e2e 验证。', 'utf8');
    const fsRead = await kbEval(async (p) => {
      try {
        const content = await window.sdk.fs.read(p);
        const text = typeof content === 'string' ? content : (content && (content.content ?? content.text)) ?? '';
        return { ok: true, text };
      } catch (e) {
        return { ok: false, err: ((e && e.message) || String(e)), code: (e && e.code) || '' };
      }
    }, docFile.replace(/\\/g, '/'));
    assert(
      fsRead.ok && fsRead.text.includes('白名单'),
      `fs.read 白名单内读取成功（${fsRead.ok ? '内容含「白名单」' : fsRead.err}）`,
    );
    // 越界路径负向：白名单外（$HOME/Downloads）应拒绝。
    const outOfScope = await kbEval(async (p) => {
      try {
        await window.sdk.fs.read(p);
        return { ok: true };
      } catch (e) {
        return { ok: false, code: (e && e.code) || '' };
      }
    }, path.join(os.homedir(), 'Downloads', 'kb-e2e-nope.md').replace(/\\/g, '/'));
    assert(
      !outOfScope.ok && /scope/i.test(outOfScope.code ?? ''),
      `fs.read 白名单外路径被拒（code=${outOfScope.code}）`,
    );
    // 用插件导入该文件（走文件导入闭环）
    const fileImport = await kbEval(async (p) => {
      const content = await window.sdk.fs.read(p);
      const text = typeof content === 'string' ? content : (content && (content.content ?? content.text)) ?? '';
      return window.__kb.importText('e2e-文件导入', text);
    }, docFile.replace(/\\/g, '/'));
    assert(fileImport.chunks >= 1, `文件导入闭环（${fileImport.chunks} 个切片）`);
    fs.rmSync(docFile, { force: true });

    // 8. 持久化：页面 reload 后重新打开插件，文档仍在（storage.kv 跨刷新）
    await page.reload();
    await page.waitForSelector('text=知识库工作站', { timeout: 30_000 });
    const row2 = page.locator('div.divide-y > div', { hasText: '知识库工作站' }).first();
    await row2.getByRole('button', { name: '运行', exact: true }).click();
    await page.locator('iframe[sandbox="allow-scripts"]', { hasTitle: '知识库工作站' }).waitFor({ state: 'visible', timeout: 30_000 });
    const kbFrame2 = page.frames().find((f) => f.parentFrame() !== null);
    const kbEval2 = (fn, arg) => kbFrame2.evaluate(fn, arg);
    const docsAfter = await kbEval2(() => window.__kb.listDocs());
    const titles = docsAfter.map((d) => d.title);
    assert(
      titles.includes('e2e-灵坊安全模型') && titles.includes('e2e-文件导入'),
      `reload 后文档持久化（${titles.join(' / ')}）`,
    );

    await browser.close().catch(() => {});
    adapter?.kill();

    if (failed > 0) {
      console.error(`\n[e2e-kb] 共 ${failed} 项断言失败`);
      process.exit(1);
    }
    console.log('\n[e2e-kb] ✅ kb-station 真机闭环全部通过（导入/列表/检索/问答/fs.read/持久化）');
    process.exit(0);
  } catch (err) {
    console.error(`\n[e2e-kb] ❌ 流程异常：${err.stack ?? err}`);
    if (appHandle?.pid) killTree(appHandle.pid);
    adapter?.kill();
    console.error(`现场保留：${tmpRoot}`);
    process.exit(1);
  }
}

run();
