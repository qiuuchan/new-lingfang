//! e2e-update-verify.mjs — LF-17 更新链路真机闭环（环回 update-feed 双向断言）。
//!
//! 目标（LF-10 遗留 L1 第 4 点）：兑现「检测 → 下载 → 验签 → 覆盖 → 重启 → 新版自报版本号」
//! 的整条真实链路 + 篡改对照。这是 updater.exe update 模式首次真机运行，预期暴露集成缺陷，
//! 暴露即修并回写单测/runbook。
//!
//! 链路形态：
//!   [旧版安装实例] --CDP invoke--> check_update(feedUrl=环回) -> download_update(sha 硬校验)
//!     -> apply_update(spawn updater.exe update 模式) -> window.close() 让主进程退出
//!     -> updater 等 pid 退出 → 跑 setup --silent --target 覆盖 → 重启新 main.exe
//!     -> CDP 重连 -> get_app_version 断言新版版本号
//!
//! 篡改对照：feed 指向同一 URL 但服务端返回改一字节的包，sha256 必然不符 →
//! download_update 必须拒绝、临时文件清理、目标 main.exe 不被覆盖。
//!
//! 前置（LF-16/LF-18 产物）：
//!   - 旧版 SFX 安装器 `target/release/LingFang-Setup-*.exe`（LF-18 重建产物，v0.1.11）
//!     —— 用其 --silent 安装出「旧版安装实例」；
//!   - 纯 installer 二进制 `target/release/installer.exe` —— 充当 updater.exe 副本与
//!     新版 setup 的 SFX 壳；
//!   - 新版 main.exe（v0.1.12）由本脚本临时改 tauri.conf.json version 后经
//!     `tauri build --no-bundle` 构建（LF-18 缺陷 B：裸 cargo build 会烘焙 devUrl）。
//!     构建一次后缓存在 tmpRoot/work/，重跑复用。
//!
//! 用法：
//!   LINGFANG_SETUP_EXE=<旧版安装器> node scripts/e2e-update-verify.mjs
//!   或省略 LINGFANG_SETUP_EXE，自动探测 target/release/LingFang-Setup-*.exe。
//!   E2E_UPDATE_SKIP_NEW_BUILD=1  跳过新版构建（复用缓存，仅调试链路用）

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const requireFromDesktop = createRequire(path.resolve('apps/desktop/package.json'));
const { chromium } = requireFromDesktop('@playwright/test');

const REPO_ROOT = process.cwd();
const MAIN_EXE = 'lingfang-desktop.exe';
const UPDATER_EXE = 'updater.exe';
const OLD_VERSION = '0.1.11';
const NEW_VERSION = '0.1.12';
const TEMP_SETUP_NAME = `LingFang-Setup-${NEW_VERSION}.exe`;

let failed = 0;
const log = (msg) => console.log(`[e2e-update] ${msg}`);
const ok = (msg) => console.log(`  ✅ ${msg}`);
const fail = (msg) => {
  console.error(`  ❌ ${msg}`);
  failed += 1;
};
function assert(cond, msg) {
  if (!cond) fail(msg);
  else ok(msg);
}

// ── 基础工具 ────────────────────────────────────────────────────────────

function findSetupExe() {
  if (process.env.LINGFANG_SETUP_EXE && fs.existsSync(process.env.LINGFANG_SETUP_EXE)) {
    return process.env.LINGFANG_SETUP_EXE;
  }
  const cands = fs
    .readdirSync(path.join(REPO_ROOT, 'target/release'))
    .filter((f) => /^LingFang-Setup-.*\.exe$/.test(f));
  if (cands.length === 0) return null;
  return path.join(REPO_ROOT, 'target/release', cands.sort().at(-1));
}

function findInstallerBin() {
  for (const name of ['installer.exe', 'lingfang-installer.exe']) {
    const p = path.join(REPO_ROOT, 'target/release', name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const sha256File = (file) =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: true, stdio: 'ignore' });
}

// ── 降权启动（与 e2e-desktop-smoke.mjs 同款；WebView2 在 elevated 下禁 CDP 端口）──

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
  if (cr.status !== 0) {
    throw new Error(`Task Scheduler 注册失败：exit=${cr.status} err=${cr.stderr}`);
  }
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

function spawnShell(exe, port, webviewDataDir) {
  const appEnv = {
    ...process.env,
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
  // WebView2 首启有初始导航（about:blank → tauri.localhost → SPA 挂载），
  // 立即 evaluate 会撞上「Execution context was destroyed」；等稳定后再取页面。
  await new Promise((r) => setTimeout(r, 2500));
  const page = context.pages().find((p) => /tauri/i.test(p.url())) ?? context.pages()[0];
  assert(page, `CDP 连接成功并找到桌面壳页面 (${port})`);
  if (!page) return null;
  // LF-18 缺陷 B 诊断：release 未经 tauri CLI 构建会把 devUrl 烘进产物。
  if (/localhost:1420/.test(page.url())) {
    fail(`安装实例指向 dev server localhost:1420——release 构建未经 tauri CLI（${page.url()}）`);
  }
  return { browser, page };
}

const invoke = (page, cmd, args = {}) =>
  page.evaluate(
    ([c, a]) => window.__TAURI__.core.invoke(c, a),
    [cmd, args],
  );

async function appVersion(page) {
  return invoke(page, 'get_app_version');
}

async function waitProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    if ((out.stdout ?? '').trim() === '') return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function waitAppProcess(installDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='${MAIN_EXE}'" | ` +
          `Where-Object { $_.ExecutablePath -like '${installDir}*' } | ` +
          'Sort-Object CreationDate -Descending | Select-Object -First 1 -ExpandProperty ProcessId',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const pid = parseInt((out.stdout ?? '').trim(), 10);
    if (pid > 0) return pid;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`等待 ${MAIN_EXE} 重启进程超时（${installDir}）`);
}

// ── 环回 update-feed 服务器（零依赖）──

function startFeedServer(fixtureDir) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const rel = url.pathname.replace(/^\//, '');
    const file = path.join(fixtureDir, rel);
    if (!file.startsWith(fixtureDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': rel.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      'Content-Length': body.length,
    });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// 清理 cmdline 命中指定用户数据目录的残留 WebView2 进程（旧实例退出后可能
// 短暂存留，占用 CDP 端口导致新版实例绑定失败）。updater 无该 cmdline 参数，不受影响。
function killWebView2ForDataDir(dataDir) {
  try {
    const out = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${dataDir}*' } | ` +
          'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return (out.stdout ?? '').trim();
  } catch {
    return '';
  }
}

// 找空闲端口（bind :0 拿到后立即释放，随后交给 WebView2 绑定）。
function freePort() {
  const srv = http.createServer();
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// ── 主流程 ──────────────────────────────────────────────────────────────

async function buildNewMain(tmpRoot) {
  // 调试/复用开关：E2E_UPDATE_NEW_MAIN 指向已构建的 0.1.12 主程序时直接复用
  // （如上一轮失败的构建产物），跳过 tauri build 重编译。
  if (process.env.E2E_UPDATE_NEW_MAIN) {
    const p = path.resolve(process.env.E2E_UPDATE_NEW_MAIN);
    if (!fs.existsSync(p)) throw new Error(`E2E_UPDATE_NEW_MAIN 指向的文件不存在：${p}`);
    log(`复用 E2E_UPDATE_NEW_MAIN=${p}`);
    return p;
  }
  const cached = path.join(tmpRoot, 'work', `new-main-${NEW_VERSION}.exe`);
  fs.mkdirSync(path.dirname(cached), { recursive: true }); // work/ 必须先建，copyFileSync 目标父目录缺失会报 ENOENT
  if (fs.existsSync(cached)) {
    log(`复用缓存的${NEW_VERSION}主程序：${cached}`);
    return cached;
  }
  const confPath = path.join(REPO_ROOT, 'apps/desktop/src-tauri/tauri.conf.json');
  const orig = fs.readFileSync(confPath, 'utf8');
  const bumped = orig.replace(`"version": "${OLD_VERSION}"`, `"version": "${NEW_VERSION}"`);
  if (bumped === orig) {
    throw new Error(`tauri.conf.json 未找到 "${OLD_VERSION}" 版本字段，无法构建 ${NEW_VERSION} 主程序`);
  }
  fs.writeFileSync(confPath, bumped);
  log(`临时把 tauri.conf.json 版本改为 ${NEW_VERSION} 并构建 release 主程序（需数分钟）…`);
  try {
    const r = spawnSync(
      'pnpm',
      ['-C', 'apps/desktop', 'exec', 'tauri', 'build', '--no-bundle'],
      { cwd: REPO_ROOT, stdio: 'inherit', shell: true, timeout: 15 * 60_000 },
    );
    if (r.status !== 0) throw new Error(`tauri build --no-bundle 失败（exit=${r.status}）`);
  } finally {
    fs.writeFileSync(confPath, orig); // 恢复原始字节
  }
  if (fs.readFileSync(confPath, 'utf8') !== orig) {
    throw new Error('tauri.conf.json 恢复失败——工作树被污染，请手工检查');
  }
  const built = path.join(REPO_ROOT, 'target/release', MAIN_EXE);
  fs.copyFileSync(built, cached);
  log(`新版主程序已产出：${cached}`);
  return cached;
}

async function assembleNewSetup(tmpRoot, newMain) {
  const payloadRoot = path.join(tmpRoot, 'work', 'payload-root');
  fs.mkdirSync(payloadRoot, { recursive: true });
  fs.copyFileSync(newMain, path.join(payloadRoot, MAIN_EXE));
  const payloadZip = path.join(tmpRoot, 'work', 'payload.zip');
  if (fs.existsSync(payloadZip)) fs.unlinkSync(payloadZip);
  const ar = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${path.join(payloadRoot, MAIN_EXE)}' -DestinationPath '${payloadZip}' -CompressionLevel Optimal`,
    ],
    { stdio: 'pipe' },
  );
  if (ar.status !== 0) {
    throw new Error(`Compress-Archive 打包 payload 失败：${ar.stderr}`);
  }
  // zip 魔数硬门槛（LF-18 缺陷 A 同款防护：绝不拼非 zip payload）。
  const head = fs.readFileSync(payloadZip).subarray(0, 4);
  if (!head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    throw new Error(`payload.zip 不是合法 zip（PK 头缺失）：${payloadZip}`);
  }
  const installerBin = findInstallerBin();
  if (!installerBin) throw new Error('未找到 target/release/installer.exe（请先 cargo build --release -p lingfang-installer）');
  const setup = path.join(tmpRoot, 'work', TEMP_SETUP_NAME);
  fs.copyFileSync(installerBin, setup);
  const payloadBytes = fs.readFileSync(payloadZip);
  fs.appendFileSync(setup, payloadBytes);
  // SFX trailer（sfx.rs 格式）：`[exe][payload.zip][MAGIC(8) + payload_len(u32 LE)]`。
  // 缺少 trailer 时 locate_payload 返回 None → install 模式报「本安装包不含内嵌 payload」。
  const MAGIC = Buffer.from('LFSFX\0\0\0', 'latin1');
  const trailer = Buffer.alloc(12);
  MAGIC.copy(trailer, 0);
  trailer.writeUInt32LE(payloadBytes.length, 8);
  fs.appendFileSync(setup, trailer);
  return setup;
}

async function installOldApp(setupExe, oldInstall) {
  fs.rmSync(oldInstall, { recursive: true, force: true });
  fs.mkdirSync(oldInstall, { recursive: true });
  log(`安装旧版实例（--silent --target）：${setupExe}`);
  const r = spawnSync(setupExe, ['--silent', '--target', oldInstall], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`旧版安装失败（exit=${r.status}）`);
  const main = path.join(oldInstall, MAIN_EXE);
  if (!fs.existsSync(main)) {
    throw new Error(`旧版安装 exit=0 但目标目录无主程序（LF-18 缺陷 A 形态）`);
  }
  ok(`旧版实例就绪：${oldInstall}（主程序 + updater 在目录内）`);
}

async function prepareFeedFixture(tmpRoot, setupPath) {
  const dir = path.join(tmpRoot, 'feed');
  fs.mkdirSync(dir, { recursive: true });
  const setupBytes = fs.readFileSync(setupPath);
  const sha = createHash('sha256').update(setupBytes).digest('hex');

  // 真实（成功）setup：字节原样。
  fs.writeFileSync(path.join(dir, TEMP_SETUP_NAME), setupBytes);

  // 篡改 setup：改一字节（feed 的 sha256 仍为真实值 → 下载侧必不匹配）。
  const tampered = Buffer.from(setupBytes);
  tampered[tampered.length - 1] ^= 0x01;
  const tamDir = path.join(dir, 'tampered');
  fs.mkdirSync(tamDir, { recursive: true });
  fs.writeFileSync(path.join(tamDir, TEMP_SETUP_NAME), tampered);
  return { dir, sha };
}

// 在服务器端口确定后写入 feed（成功版 / 篡改版各一份 latest.json）。
function writeFeedJson(dir, sub, feedPort, sha, size) {
  const isTampered = sub === 'tampered';
  const feed = {
    version: NEW_VERSION,
    notes: `LF-17 e2e 环回 feed（${isTampered ? '篡改' : '成功'}版）`,
    pub_date: new Date().toISOString(),
    setup: {
      url: `http://127.0.0.1:${feedPort}/${isTampered ? 'tampered/' : ''}${TEMP_SETUP_NAME}`,
      sha256: sha,
      minisig_url: '',
      size,
    },
  };
  const target = sub ? path.join(dir, sub, 'latest.json') : path.join(dir, 'latest.json');
  fs.writeFileSync(target, JSON.stringify(feed, null, 2));
}

async function run() {
  const tmpRoot = path.join(os.tmpdir(), `lingfang-update-e2e-${Date.now()}`);
  fs.mkdirSync(tmpRoot, { recursive: true });
  // 清理可能残留的下载临时目录（上一次失败运行的半成品会让「临时包已清理」断言假阴性）。
  fs.rmSync(path.join(os.tmpdir(), 'lingfang-update'), { recursive: true, force: true });
  const oldInstall = path.join(tmpRoot, 'old-install');
  const webviewData = path.join(tmpRoot, 'webview-data');
  let appHandle = null;

  log(`tmpRoot=${tmpRoot}`);

  try {
    // 1. 旧版安装实例
    const setupExe = findSetupExe();
    if (!setupExe) {
      throw new Error('未找到旧版 SFX 安装器（target/release/LingFang-Setup-*.exe）。先跑 LF-18 重建安装器。');
    }
    await installOldApp(setupExe, oldInstall);

    // 2. 新版主程序 + setup（构建一次后缓存）
    const newMain = await buildNewMain(tmpRoot);
    const newSetup = await assembleNewSetup(tmpRoot, newMain);

    // 3. 环回 feed（真实 + 篡改两个版本）
    const { dir, sha } = await prepareFeedFixture(tmpRoot, newSetup);
    const server = await startFeedServer(dir);
    const feedPort = server.address().port;
    const newSetupSize = fs.statSync(newSetup).size;
    writeFeedJson(dir, '', feedPort, sha, newSetupSize);
    writeFeedJson(dir, 'tampered', feedPort, sha, newSetupSize);
    log(`环回 feed 服务器：http://127.0.0.1:${feedPort}/（含 /tampered/ 篡改版）`);

    // 4. 启动旧版实例（0.1.11）
    const port = await freePort();
    log(`启动旧版实例并等待 CDP(${port})…`);
    appHandle = spawnShell(path.join(oldInstall, MAIN_EXE), port, webviewData);
    await waitForCdp(port, 90_000);
    let { browser, page } = await connectPage(port);
    if (!page) throw new Error('旧版实例 CDP 连接失败');

    // 5. 篡改对照（先做：复用旧实例，顺序避免临时包同名冲突）
    log('—— 篡改对照：feed 指向篡改包，download_update 必须拒绝 ——');
    const beforeHash = sha256File(path.join(oldInstall, MAIN_EXE));
    const vBefore = await appVersion(page);
    assert(vBefore === OLD_VERSION, `篡改前实例版本=${vBefore}（期望 ${OLD_VERSION}）`);

    const tamInfo = await invoke(page, 'check_update', {
      feedUrl: `http://127.0.0.1:${feedPort}/tampered/latest.json`,
    });
    assert(tamInfo && tamInfo.version === NEW_VERSION, '篡改 feed 检测到新版（check_update 返回信息）');

    const tamResult = await page.evaluate(
      ([c, args]) =>
        window.__TAURI__.core.invoke(c, args).then(
          (okVal) => ({ ok: true, value: okVal }),
          (err) => ({ ok: false, message: String(err) }),
        ),
      [
        'download_update',
        {
          info: {
            version: tamInfo.version,
            notes: tamInfo.notes,
            pubDate: '',
            setupUrl: tamInfo.setupUrl,
            setupSha256: tamInfo.setupSha256,
            setupMinisigUrl: '',
            setupSize: tamInfo.setupSize,
          },
          pubkey: null,
        },
      ],
    );
    assert(tamResult.ok === false, `篡改包被拒绝（err=${tamResult.message}）`);
    assert(/sha256|校验/i.test(tamResult.message ?? ''), `错误信息说明 sha256 失败（${tamResult.message}）`);

    const tmpTemp = path.join(os.tmpdir(), 'lingfang-update', TEMP_SETUP_NAME);
    assert(!fs.existsSync(tmpTemp), '篡改失败后临时安装包被清理');
    const afterHash = sha256File(path.join(oldInstall, MAIN_EXE));
    assert(beforeHash === afterHash, '篡改对照：目标 main.exe 未被覆盖（hash 不变）');

    // 6. 成功闭环
    log('—— 成功闭环：check → download → apply → 退出 → 覆盖 → 重启 → 新版自报 ——');
    const info = await invoke(page, 'check_update', {
      feedUrl: `http://127.0.0.1:${feedPort}/latest.json`,
    });
    assert(info && info.version === NEW_VERSION, `check_update 检测到 ${NEW_VERSION}`);

    const dl = await page.evaluate(
      ([c, args]) =>
        window.__TAURI__.core.invoke(c, args).then(
          (okVal) => ({ ok: true, value: okVal }),
          (err) => ({ ok: false, message: String(err) }),
        ),
      [
        'download_update',
        {
          info: {
            version: info.version,
            notes: info.notes,
            pubDate: '',
            setupUrl: info.setupUrl,
            setupSha256: info.setupSha256,
            setupMinisigUrl: '',
            setupSize: info.setupSize,
          },
          pubkey: null,
        },
      ],
    );
    assert(dl.ok === true, `download_update 成功（路径=${dl.ok ? dl.value : dl.message}）`);
    assert(fs.existsSync(dl.value), '临时安装包真实落盘');

    const appPid = appHandle.pid;
    const applyResult = await page.evaluate(
      ([c, p]) =>
        window.__TAURI__.core.invoke(c, p).then(
          (v) => ({ ok: true, value: v }),
          (err) => ({ ok: false, message: String(err) }),
        ),
      ['apply_update', { setupPath: dl.value }],
    );
    assert(applyResult.ok === true, `apply_update 拉起 updater.exe（err=${applyResult.message}）`);

    // 7. 让主进程干净退出（quit_app = app.exit(0)），updater 存活继续覆盖。
    //    不用 window.close()：Tauri v2 里 JS 的 window.close() 不触发 close-requested，
    //    主进程不会退出（LF-17 真机实测，updater 的 30s 等待因此超时）。
    log('退出旧实例（invoke quit_app），等待 updater 接管…');
    await invoke(page, 'quit_app').catch(() => {});
    const exited = await waitProcessExit(appPid, 30_000);
    assert(exited, '旧实例主进程已退出');
    if (browser) await browser.close().catch(() => {});
    // 旧 WebView2 子进程可能短暂残留并占用 CDP 端口，清理命中隔离数据目录的进程
    // （updater 的 cmdline 不含该目录，不受影响）。
    killWebView2ForDataDir(webviewData);

    // 8. 等 updater 覆盖完成并重启新版
    const newPid = await waitAppProcess(oldInstall, 120_000);
    ok(`新版实例已重启（PID=${newPid}）`);
    // updater 覆盖需要时间（解压 + 重启），CDP 端口可能先被新实例占用
    await waitForCdp(port, 90_000);
    const re = await connectPage(port);
    if (!re) throw new Error('新版实例 CDP 连接失败');
    browser = re.browser;
    page = re.page;
    const vAfter = await appVersion(page);
    assert(vAfter === NEW_VERSION, `重启后实例自报版本=${vAfter}（期望 ${NEW_VERSION}）`);
    const updaterGone = !fs.existsSync(path.join(os.tmpdir(), 'lingfang-update', TEMP_SETUP_NAME));
    assert(updaterGone, 'updater 覆盖后删除临时安装包');

    await browser.close().catch(() => {});
    server.close();

    // 清理运行中的新版实例（避免残留进程）
    killTree(newPid);
    fs.rmSync(tmpRoot, { recursive: true, force: true });

    if (failed > 0) {
      console.error(`\n[e2e-update] 共 ${failed} 项断言失败`);
      process.exit(1);
    }
    console.log('\n[e2e-update] ✅ 双向断言全部通过：成功闭环 + 篡改拒绝');
    process.exit(0);
  } catch (err) {
    console.error(`\n[e2e-update] ❌ 流程异常：${err.stack ?? err}`);
    if (appHandle?.pid) killTree(appHandle.pid);
    console.error(`现场保留：${tmpRoot}`);
    process.exit(1);
  }
}

run();
