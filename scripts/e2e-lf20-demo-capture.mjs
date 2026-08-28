//! e2e-lf20-demo-capture.mjs — LF-20 README Demo 素材采集（真机、真实 UI 操作）。
//!
//! CDP 驱动桌面壳真实 UI（点击/输入，非 window.__kb 钩子）走 kb-station 完整流程：
//!   插件中心 → 运行「知识库工作站」→ 文件导入（fs.read 白名单 $HOME/Documents）
//!   → 关键词检索 → 检索并 LLM 问答（宿主 markdown 弹层展示回答）。
//! 输出（提交进仓库，README 引用）：
//!   docs/assets/kb-demo.gif               — 帧序列合成的 Demo GIF（≤60s、<5MB）
//!   docs/assets/kb-plugin-center.png      — 插件中心（能看到 kb-station）
//!   docs/assets/kb-docs.png               — 导入后文档列表
//!   docs/assets/kb-search.png             — 关键词检索命中
//!   docs/assets/kb-ask.png                — LLM 问答 markdown 弹层
//!
//! 前置：release 桌面壳 + kb-station artifact（脚本自动补 build）+ bundled ffmpeg
//! （apps/desktop/runtimes/ffmpeg/ffmpeg.exe）。
//! LLM 走 relay-adapter MOCK_KB 模式（RELAY_ADAPTER_MOCK_KB=1，自然语言回答，
//! 无 key 可复现；见 scripts/relay-adapter.mjs）。

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
const FFMPEG = path.join(REPO_ROOT, 'apps/desktop/runtimes/ffmpeg/ffmpeg.exe');
const ASSETS_DIR = path.join(REPO_ROOT, 'docs/assets');
const DEMO_DOC_FILE = path.join(os.homedir(), 'Documents', '灵坊工作台-产品笔记.md');

// 演示文档（真实产品笔记，内容与 kb-station 检索/问答结果一致）。
const DEMO_DOC_TEXT = `灵坊工作台是一个零服务器的 Tauri v2 桌面插件平台。

插件在本地桌面壳中运行，所有特权调用都要经过能力网关检查。客户端插件运行在沙箱 iframe 中，nodejs 与 python 插件是普通操作系统进程，真实防线是安装时信任（minisign 验签）。

本地知识库场景：把 .md 与 .txt 文档导入插件，自动按段落切片，随后用关键词全文检索，最后带着检索片段向 LLM 提问。

内置插件包括计算器、2048、Markdown 笔记与动作演示；第三方插件通过 .lfplugin 制品导入，v1 政策仅接受 client 运行时。`;

const FPS = 2.5; // GIF 目标帧率（帧间隔 400ms，帧序列均匀）
const FRAME_MS = Math.round(1000 / FPS);

let failed = 0;
const log = (msg) => console.log(`[lf20-capture] ${msg}`);
const ok = (msg) => console.log(`  ✅ ${msg}`);
const fail = (msg) => { console.error(`  ❌ ${msg}`); failed += 1; };
const assert = (cond, msg) => (cond ? ok(msg) : fail(msg));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function isElevated() {
  try {
    const out = spawnSync('powershell', ['-NoProfile', '-Command',
      '$id=[System.Security.Principal.WindowsIdentity]::GetCurrent();' +
      '$p=New-Object System.Security.Principal.WindowsPrincipal($id);' +
      '$p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)'],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
    return out.stdout.trim() === 'True';
  } catch { return false; }
}

async function spawnElevated(exe, env) {
  const taskName = `LingFangDemo_${process.pid}_${Date.now()}`;
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
  ].join('; ');
  const cr = spawnSync('powershell', ['-NoProfile', '-Command', psCreate], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (cr.status !== 0) throw new Error(`Task Scheduler 注册失败：exit=${cr.status}`);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const out = spawnSync('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='${path.basename(exe)}'" | ` +
        'Sort-Object CreationDate -Descending | Select-Object -First 1 -ExpandProperty ProcessId'],
        { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
      const pid = parseInt((out.stdout ?? '').trim(), 10);
      if (pid > 0) return { pid, env };
    } catch { /* 继续轮询 */ }
    await pause(500);
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
  const child = spawn(exe, [], { cwd: path.dirname(exe), env: appEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  return { pid: child.pid, env: appEnv };
}

async function waitForCdp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch { /* 未就绪 */ }
    await pause(500);
  }
  throw new Error(`等待 CDP(${port}) 超时`);
}

async function connectPage(port) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  await pause(2500); // WebView2 首帧导航竞态（LF-17 实测）
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
    srv.listen(0, '127.0.0.1', () => { const port = srv.address().port; srv.close(() => resolve(port)); });
  });
}

function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: true, stdio: 'ignore' });
}

// ── 帧序列采集（均匀 400ms 间隔，保证 ffmpeg 按 FPS 合成无跳帧） ──

async function shot(page, framesDir) {
  const idx = fs.readdirSync(framesDir).filter((f) => f.endsWith('.png')).length + 1;
  const p = path.join(framesDir, `f-${String(idx).padStart(4, '0')}.png`);
  await page.screenshot({ path: p });
  return p;
}

async function hold(page, framesDir, ms) {
  const n = Math.max(1, Math.round(ms / FRAME_MS));
  for (let i = 0; i < n; i++) {
    await shot(page, framesDir);
    await pause(FRAME_MS);
  }
}

async function still(page, name) {
  const p = path.join(ASSETS_DIR, name);
  await page.screenshot({ path: p });
  ok(`截图 ${name}（${Math.round(fs.statSync(p).size / 1024)} KB）`);
}

// ── 主流程 ───────────────────────────────────────────────────────────────

async function run() {
  const tmpRoot = path.join(os.tmpdir(), `lingfang-lf20-demo-${Date.now()}`);
  const framesDir = path.join(tmpRoot, 'frames');
  const webviewData = path.join(tmpRoot, 'webview-data');
  fs.mkdirSync(framesDir, { recursive: true });
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  let appHandle = null;
  let adapter = null;
  const port = await freePort();

  log(`tmpRoot=${tmpRoot}，CDP port=${port}，输出=${ASSETS_DIR}`);
  if (!fs.existsSync(FFMPEG)) throw new Error(`未找到 bundled ffmpeg：${FFMPEG}`);

  try {
    // 0. relay-adapter（MOCK_KB：自然语言回答，演示可复现）
    const adapterPort = await freePort();
    adapter = spawn(process.execPath, [path.join(REPO_ROOT, 'scripts/relay-adapter.mjs')], {
      env: { ...process.env, RELAY_ADAPTER_PORT: String(adapterPort), RELAY_ADAPTER_MOCK_KB: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    await pause(1500);
    log(`relay-adapter(MOCK_KB) http://127.0.0.1:${adapterPort}`);

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
      const r = spawnSync('pnpm', ['-C', 'packages/plugin-sdk', 'cli:dev', 'build', 'packages/plugin-sdk/examples/kb-station'],
        { cwd: REPO_ROOT, stdio: 'inherit', shell: true });
      if (r.status !== 0) throw new Error('kb-station 构建失败');
    }
    const existing = await evaluateWithTimeout(page,
      (cmd) => window.__TAURI__.core.invoke(cmd).then(
        (v) => (v ?? []).map((i) => ({ installationId: i.installationId, packageId: i.packageId })),
        () => []),
      'list_plugin_installations');
    const match = (existing ?? []).find((i) => String(i.packageId).includes(PLUGIN.id));
    if (match?.installationId) {
      await evaluateWithTimeout(page,
        ([cmd, id]) => window.__TAURI__.core.invoke(cmd, { installationId: id }).catch(() => null),
        ['uninstall_plugin_installation', match.installationId]);
    }
    const imported = await evaluateWithTimeout(page,
      ([cmd, artifactPath]) => window.__TAURI__.core.invoke(cmd, {
        input: { artifactPath, expectedSha256: null, packageId: null, releaseId: null, origin: 'local', protected: false },
      }).then((v) => ({ ok: true, origin: v.origin }), (e) => ({ ok: false, msg: String(e) })),
      ['install_plugin_artifact', KB_ARTIFACT]);
    assert(imported.ok && imported.origin === 'local', `导入 kb-station（${imported.ok ? `origin=${imported.origin}` : imported.msg}）`);
    await page.reload();
    await page.waitForSelector('text=知识库工作站', { timeout: 30_000 });

    // 3. 演示文档落地（$HOME/Documents，fs.read 白名单内）
    fs.writeFileSync(DEMO_DOC_FILE, DEMO_DOC_TEXT, 'utf8');
    log(`演示文档：${DEMO_DOC_FILE}`);

    // ── 帧序列：插件中心 → 打开 kb-station → 导入 → 检索 → 问答 ──
    log('开始采集帧序列…');

    // 3.1 插件中心（能看到「知识库工作站」卡片）
    const centerRow = page.locator('div.divide-y > div', { hasText: PLUGIN.name }).first();
    await centerRow.waitFor({ state: 'visible', timeout: 15_000 });
    await hold(page, framesDir, 3000); // 开场：插件中心
    await still(page, 'kb-plugin-center.png');

    // 3.2 点击「运行」打开 kb-station
    await centerRow.getByRole('button', { name: '运行', exact: true }).click();
    await page.locator('iframe[sandbox="allow-scripts"]', { hasTitle: PLUGIN.name }).waitFor({ state: 'visible', timeout: 30_000 });
    await hold(page, framesDir, 2500); // 插件空态（加载文档中）

    const kbFrame = page.frames().find((f) => f.parentFrame() !== null);
    assert(kbFrame, '找到 kb-station iframe');
    const fk = kbFrame; // 真实 UI 操作一律走 frame 内元素

    // 3.3 输入文件路径（真实键入）→ 从文件读取并导入
    const docPathForInput = DEMO_DOC_FILE.replace(/\\/g, '/');
    await fk.locator('#filePath').pressSequentially(docPathForInput, { delay: 12 });
    await hold(page, framesDir, 1200); // 路径输入完成
    await fk.locator('#btnReadFile').click();
    await fk.locator('#importStatus').filter({ hasText: '已导入' }).waitFor({ state: 'visible', timeout: 20_000 });
    await hold(page, framesDir, 3000); // 导入成功：状态 + 文档列表
    await still(page, 'kb-docs.png');

    // 3.4 关键词检索
    await fk.locator('#query').pressSequentially('能力网关', { delay: 60 });
    await hold(page, framesDir, 800);
    await fk.locator('#btnSearch').click();
    await fk.locator('#hits .hit, #hits .empty').first().waitFor({ state: 'visible', timeout: 15_000 });
    await hold(page, framesDir, 2500);
    await still(page, 'kb-search.png');

    // 3.5 检索并 LLM 问答（宿主 markdown 弹层）
    await fk.locator('#query').fill('');
    await fk.locator('#query').pressSequentially('灵坊工作台是什么？', { delay: 50 });
    await hold(page, framesDir, 800);
    await fk.locator('#btnAsk').click();

    // 诊断轮询：askStatus / #answer / 弹层（ui.view 弹层打开后 promise 挂起直至关闭，
    // 故以弹层出现为准；若流程失败则 askStatus 会给出失败原因）。
    const popupLoc = page.locator('div.fixed.inset-0.z-\\[100\\]').first();
    let diag = { status: '', answerHidden: true };
    const diagDeadline = Date.now() + 25_000;
    while (Date.now() < diagDeadline) {
      diag = await fk.evaluate(() => ({
        status: (document.getElementById('askStatus')?.textContent ?? '').trim(),
        answerHidden: document.getElementById('answer')?.hidden ?? true,
      }));
      const popupVisible = await popupLoc.isVisible().catch(() => false);
      if (popupVisible || /失败|无命中/.test(diag.status)) break;
      await pause(500);
    }
    log(`ask 诊断：status=${JSON.stringify(diag.status)} answerHidden=${diag.answerHidden}`);
    const popupVisible = await popupLoc.isVisible().catch(() => false);
    assert(popupVisible, `宿主 markdown 弹层出现（askStatus=${JSON.stringify(diag.status)}）`);
    await hold(page, framesDir, 3500); // 回答弹层定格
    await still(page, 'kb-ask.png');
    // 关闭弹层 → ui.view promise resolve → 内联 #answer 出现（流程完整性收尾）。
    // 护栏：弹层未出现（ask 已失败）时跳过，避免 30s 点击超时掩盖真实错误。
    if (popupVisible) {
      await popupLoc.getByRole('button', { name: '关闭' }).click();
      await fk.locator('#answer').waitFor({ state: 'visible', timeout: 5_000 });
      await hold(page, framesDir, 1500);
    }

    // 4. 合成 GIF
    const totalFrames = fs.readdirSync(framesDir).filter((f) => f.endsWith('.png')).length;
    const durSec = totalFrames / FPS;
    assert(totalFrames >= 30, `帧序列 ${totalFrames} 帧（GIF 约 ${durSec.toFixed(1)}s）`);
    const gifPath = path.join(ASSETS_DIR, 'kb-demo.gif');
    const palettePath = path.join(tmpRoot, 'palette.png');
    const scale = 'scale=900:-1:flags=lanczos';
    // 合成 GIF（瞬时文件锁偶发失败，重试一次；错误取 stderr 尾部，避免 banner 淹没真因）
    const gifArgs = [
      '-y', '-framerate', String(FPS), '-i', path.join(framesDir, 'f-%04d.png'),
      '-vf', `${scale},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`,
      '-loop', '0', gifPath,
    ];
    let r1 = spawnSync(FFMPEG, gifArgs, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    if (r1.status !== 0) {
      log(`ffmpeg 首次失败（重试一次）：${String(r1.stderr ?? '').slice(-400)}`);
      r1 = spawnSync(FFMPEG, gifArgs, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    }
    if (r1.status !== 0) throw new Error(`ffmpeg 合成失败：${String(r1.stderr ?? '').slice(-400)}`);
    const gifSizeMB = fs.statSync(gifPath).size / 1024 / 1024;
    assert(gifSizeMB < 5, `GIF ${gifSizeMB.toFixed(2)} MB（<5MB）`);
    assert(durSec <= 60, `GIF 时长 ${durSec.toFixed(1)}s（≤60s）`);
    log(`GIF 输出：${gifPath}（${totalFrames} 帧 / ${durSec.toFixed(1)}s / ${gifSizeMB.toFixed(2)} MB）`);
    if (palettePath) fs.rmSync(palettePath, { force: true });

    // 5. 降采样截图（README 中段用，900px 宽）
    for (const name of ['kb-plugin-center.png', 'kb-docs.png', 'kb-search.png', 'kb-ask.png']) {
      const src = path.join(ASSETS_DIR, name);
      if (!fs.existsSync(src)) continue;
      const tmpOut = path.join(tmpRoot, `scaled-${name}`);
      const r = spawnSync(FFMPEG, ['-y', '-i', src, '-vf', 'scale=900:-1:flags=lanczos', tmpOut],
        { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
      if (r.status === 0) {
        fs.copyFileSync(tmpOut, src);
        fs.rmSync(tmpOut, { force: true });
        ok(`降采样 ${name}（${Math.round(fs.statSync(src).size / 1024)} KB）`);
      }
    }

    await browser.close();
  } finally {
    // 清理：演示文档（应用侧数据在隔离 webview 目录，随 tmp 删除）
    fs.rmSync(DEMO_DOC_FILE, { force: true });
    killTree(appHandle?.pid);
    killTree(adapter?.pid);
  }

  if (failed > 0) {
    console.error(`[lf20-capture] ${failed} 项断言失败`);
    process.exit(1);
  }
  log('完成');
}

run().catch((e) => {
  console.error(`[lf20-capture] 失败：${e.stack || e}`);
  process.exit(1);
});
