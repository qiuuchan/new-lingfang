#!/usr/bin/env node
// e2e-install-verify.mjs — 干净机器安装实证（QX-11 / 阶段 L2）。
//
// 实证「Release 产物 → 干净环境安装 → 启动 → 插件可用」最后一公里：
//   - 全新目标目录（无 runtimes 缓存 + 隔离 WebView2 用户数据目录）；
//   - 若有 SFX 安装器 → 跑 `QianXia-Setup-*.exe --silent --target <目标目录>`；
//   - 启动安装实例 → CDP 断言：插件中心加载 / 内置 notes 打开 / storage.kv 真落盘 /
//     四 runtime keyFiles 在位（对齐 verify-bundled-runtimes.mjs 口径）。
//
// 环境降级（本环境为开发 checkout，无 Release / 无安装器 exe）：
//   本地找不到安装器时，明确「跳过 --silent 安装」，改用 target/debug 调试壳做启动闭环断言，
//   安装器闭环标记为「待本机（具备 Release 的机器）复核」。其余 CDP 断言仍全跑。
//
// 复用 e2e-desktop-smoke.mjs / e2e-actions-verify.mjs 的 CDP + 杀进程树惯例。
//
// 用法（cwd = apps/desktop）：
//   pnpm test:install                       # 先构建再验证
//   E2E_SKIP_BUILD=1 pnpm test:install     # 复用 target/debug
//   QIANXIA_SETUP_EXE=../path/to/QianXia-Setup-x.exe pnpm test:install
//   E2E_INSTALLER_SKIP=1 pnpm test:install # 跳过安装器自动探测，强制用 target/debug 调试壳做断言（CI/本机复核降级）
//
// 依赖 @playwright/test（仅用 CDP 连接）。仅 Windows（WebView2）。任一断言失败 → 退出码 1。

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, rmSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const desktopDir = path.join(repoRoot, 'apps', 'desktop');

const requireFromDesktop = createRequire(path.join(desktopDir, 'package.json'));
const { chromium } = requireFromDesktop('@playwright/test');

const NOTES_NAME = 'Markdown 笔记';
const EXE_CANDIDATES = ['qianxia-desktop.exe', '千匣台.exe', 'main.exe'];
const SETUP_CANDIDATES = ['QianXia-Setup-*.exe', '千匣台-Setup-*.exe'];
const OVERALL_TIMEOUT_MS = 5 * 60 * 1000;

// runtime keyFiles 口径对齐 verify-bundled-runtimes.mjs（runtime-lock.json）
const lock = JSON.parse(readFileSync(path.join(desktopDir, 'runtime-lock.json'), 'utf8'));
const RUNTIME_ROOT = path.join(desktopDir, 'runtimes');
const KEY_FILES = lock.keyFiles ?? [];
const REQUIRED_FILES = lock.requiredFiles ?? [];

function log(msg) {
  console.log(`[e2e-install] ${msg}`);
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

function findExe(dir, candidates) {
  if (!existsSync(dir)) return null;
  let best = null;
  for (const glob of candidates) {
    const base = glob.replace('*', '');
    const re = new RegExp('^' + glob.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, (m) => (m === '*' ? '.*' : '\\' + m)) + '$', 'i');
    for (const name of readdirSync(dir)) {
      if (re.test(name)) {
        const p = path.join(dir, name);
        const mtime = statSync(p).mtimeMs;
        if (!best || mtime > best.mtime) best = { path: p, mtime };
      }
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

function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: true, stdio: 'ignore' });
}

function isElevated() {
  try {
    const out = spawnSync('powershell', [
      '-NoProfile', '-Command',
      '$id=[System.Security.Principal.WindowsIdentity]::GetCurrent();' +
        '$p=New-Object System.Security.Principal.WindowsPrincipal($id);' +
        '$p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)',
    ], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
    return out.stdout.trim() === 'True';
  } catch {
    return false;
  }
}

async function spawnElevated(exe, env) {
  log('检测到 elevated 上下文，降权（Basic User 令牌）启动桌面壳…');
  const quoted = `"${exe}"`;
  spawnSync('runas', ['/env', '/trustlevel:0x20000', quoted], { env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const out = spawnSync('powershell', [
        '-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='${path.basename(exe)}'" | ` +
          'Where-Object { $_.CommandLine -like "*qianxia*" } | ' +
          'Sort-Object CreationDate -Descending | Select-Object -First 1 -ExpandProperty ProcessId',
      ], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
      const pid = parseInt(out.stdout.trim(), 10);
      if (pid > 0) {
        log(`桌面壳已启动（PID=${pid}，降权模式）`);
        return { pid, env, child: null };
      }
    } catch {
      /* 轮询 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('runas 降权启动后未找到 qianxia-desktop 进程');
}

function sha256Of(p) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(p);
    s.on('data', (c) => h.update(c));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

// 四 runtime keyFiles 在位（对齐 verify-bundled-runtimes.mjs 口径）
async function assertRuntimeKeyFiles() {
  if (KEY_FILES.length === 0) {
    log('（runtime-lock.json 无 keyFiles，跳过 keyFiles 断言）');
    return;
  }
  let ok = 0;
  for (const entry of KEY_FILES) {
    const fp = path.join(RUNTIME_ROOT, entry.path);
    if (!existsSync(fp) || !statSync(fp).isFile()) {
      throw new Error(`runtime keyFile 缺失：${entry.path}`);
    }
    const st = statSync(fp);
    if (st.size !== entry.size) {
      throw new Error(`runtime keyFile 大小不符：${entry.path} expected=${entry.size} actual=${st.size}`);
    }
    const digest = await sha256Of(fp);
    if (digest !== entry.sha256) {
      throw new Error(`runtime keyFile sha256 不符：${entry.path}`);
    }
    ok++;
  }
  assert(true, `四 runtime keyFiles 在位且 sha256 命中（${ok}/${KEY_FILES.length}）`);

  // requiredFiles 存在性（非哈希）兜底
  let reqOk = 0;
  for (const rel of REQUIRED_FILES) {
    const fp = path.join(RUNTIME_ROOT, rel);
    if (existsSync(fp) && statSync(fp).isFile()) reqOk++;
    else throw new Error(`runtime requiredFile 缺失：${rel}`);
  }
  assert(true, `runtime requiredFiles 全部存在（${reqOk}/${REQUIRED_FILES.length}）`);
}

async function run() {
  const skipBuild = process.env.E2E_SKIP_BUILD === '1';
  const targetDir = path.join(repoRoot, 'target', `e2e-install-${process.pid}-${Date.now()}`);
  mkdirSync(targetDir, { recursive: true });
  log(`干净目标目录：${targetDir}`);

  // ── 安装器来源选择 ──
  let setupExe = process.env.QIANXIA_SETUP_EXE ?? null;
  if (!setupExe && process.env.E2E_INSTALLER_SKIP !== '1') {
    setupExe = findExe(path.join(repoRoot, 'target', 'release'), SETUP_CANDIDATES);
  }
  let usedInstaller = false;
  let launchExe;

  if (setupExe && existsSync(setupExe)) {
    log(`找到安装器：${setupExe} → 跑 --silent --target`);
    const r = spawnSync(`"${setupExe}"`, ['--silent', '--target', targetDir], {
      cwd: path.dirname(setupExe),
      stdio: 'inherit',
      shell: true,
      timeout: 10 * 60 * 1000,
    });
    if (r.status !== 0) {
      log(`⚠️ 安装器返回非零（exit=${r.status}），后续启动断言改用调试壳复核`);
    } else {
      usedInstaller = true;
      // 安装器落地 exe 同级 runtimes/（命中 runtime_resolver 的 exe 同级分支）
      const installedExe = findExe(targetDir, EXE_CANDIDATES);
      launchExe = installedExe ?? null;
      if (!launchExe) {
        // QX-18：静默安装 exit=0 但目录里没有主程序 = 「假成功」级安装链路缺陷
        // （2026-08-27 实测形态：GNU tar 静默产出非 zip payload，安装器 zip 层在
        // 垃圾数据上误解析为空归档 + 兜底复制自身为 updater.exe）。此处必须硬失败，
        // 不允许退化成调试壳把断言跑绿——那正是工单警告的「复用必假阳性」。
        console.error('[e2e-install] ❌ 硬失败：安装器 exit=0 但目标目录无主程序。');
        console.error(`   目标目录（保留现场）：${targetDir}`);
        try {
          for (const e of readdirSync(targetDir)) {
            const st = statSync(path.join(targetDir, e));
            console.error(`   - ${e}${st.isDirectory() ? '/' : ''} (${st.size} bytes)`);
          }
        } catch {
          /* 目录不可读时仅打印路径 */
        }
        process.exit(2);
      }
    }
  } else {
    log('未验证：本环境无 SFX 安装器（或已显式 E2E_INSTALLER_SKIP=1 跳过探测）。');
    log('→ 跳过 --silent 安装；安装器闭环标记为「待本机（具备 Release 的机器）复核」。');
    log('→ 改用 target/debug 调试壳做启动闭环断言（其余 CDP 断言全跑）。');
  }

  // 调试壳退化路径：复用 target/debug
  if (!launchExe) {
    if (!skipBuild || !findExe(path.join(repoRoot, 'target', 'debug'), EXE_CANDIDATES)) {
      buildDesktop();
    }
    launchExe = findExe(path.join(repoRoot, 'target', 'debug'), EXE_CANDIDATES);
  }
  if (!launchExe) throw new Error('target/debug 与安装目标目录均未找到可用 exe');
  log(`启动产物：${launchExe}${usedInstaller ? '（安装器落地）' : '（调试壳降级）'}`);

  const port = await freePort();
  const webviewDataDir = path.join(repoRoot, `.e2e-install-webview2-${process.pid}-${Date.now()}`);
  const appEnv = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: webviewDataDir,
  };

  let child;
  if (isElevated()) {
    child = await spawnElevated(launchExe, appEnv);
  } else {
    child = spawn(launchExe, [], {
      cwd: path.dirname(launchExe),
      env: appEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
  }

  const cleanup = () => {
    killTree(child.pid);
    spawnSync('rmdir', ['/s', '/q', webviewDataDir], { shell: true, stdio: 'ignore' });
    rmSync(targetDir, { recursive: true, force: true });
  };

  const timer = setTimeout(() => {
    cleanup();
    console.error(`[e2e-install] 总超时（${OVERALL_TIMEOUT_MS / 1000}s），已强制退出`);
    process.exit(1);
  }, OVERALL_TIMEOUT_MS);

  try {
    await waitForCdp(port, 90_000);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    const page = context.pages().find((p) => /tauri/i.test(p.url())) ?? context.pages()[0];
    assert(page, 'CDP 连接成功并找到桌面壳页面');
    log(`页面 URL: ${page.url()}`);
    // QX-18 诊断：release 产物若未经 tauri CLI 构建（custom-protocol 未启用），
    // devUrl（localhost:1420）会被烘焙进二进制，安装实例启动即白屏指向 dev server。
    if (/localhost:1420/.test(page.url())) {
      console.error(
        '[e2e-install] ❌ 硬失败：安装实例指向 dev server localhost:1420 ——' +
          '桌面壳 release 构建未经 tauri CLI，前端资产未烘焙。' +
          '请用 `tauri build --no-bundle` 构建（勿直接 cargo build）后重试。',
      );
      process.exit(3);
    }

    // 1. 插件中心加载
    await page.waitForSelector(`text=${NOTES_NAME}`, { timeout: 30_000 });
    assert(true, `插件中心渲染，已安装列表含「${NOTES_NAME}」`);

    // 2. 打开 notes → iframe
    const row = page.locator('div.divide-y > div', { hasText: NOTES_NAME }).first();
    await row.getByRole('button', { name: '运行', exact: true }).click();
    const iframeLocator = page.locator('iframe[sandbox="allow-scripts"]', { hasTitle: NOTES_NAME });
    await iframeLocator.waitFor({ state: 'visible', timeout: 30_000 });
    assert(true, 'PluginRunner 渲染 iframe（sandbox="allow-scripts"）');

    const frame = () =>
      page.frames().find((f) => f.parentFrame() !== null && f.url().includes('srcdoc')) ??
      page.frames().find((f) => f.parentFrame() !== null);

    async function inFrame(fn, arg) {
      const deadline = Date.now() + 30_000;
      let lastErr;
      while (Date.now() < deadline) {
        const f = frame();
        if (f) {
          try {
            return await f.evaluate(fn, arg);
          } catch (e) {
            lastErr = e;
          }
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      throw lastErr ?? new Error('iframe 不可用');
    }

    // 3. storage.kv 真落盘
    const marker = `e2e-install-${Date.now()}`;
    assert(
      await inFrame(async (m) => {
        await window.sdk.storage.set('e2e_install', m);
        const v = await window.sdk.storage.get('e2e_install');
        return JSON.stringify(v ?? null).includes(m);
      }, marker),
      'storage.kv set/get 真实成功（经 client_storage_kv 落盘）',
    );

    // 4. 四 runtime keyFiles 在位（对齐 verify-bundled-runtimes.mjs）
    await assertRuntimeKeyFiles();

    log('全部断言通过 ✅');
    if (!usedInstaller) {
      log('────────────────────────────────────────────────────────────');
      log('待本机复核项：SFX 安装器 --silent 安装闭环（本环境无 Release / 安装器 exe）。');
      log('在具备 Release 的机器上：QIANXIA_SETUP_EXE=... pnpm test:install 即跑完整闭环。');
      log('────────────────────────────────────────────────────────────');
    }
  } finally {
    clearTimeout(timer);
    cleanup();
  }
}

run().catch((err) => {
  console.error(`[e2e-install] 失败：${err?.stack ?? err}`);
  process.exit(1);
});
