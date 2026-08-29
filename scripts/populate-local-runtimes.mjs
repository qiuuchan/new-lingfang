#!/usr/bin/env node

// populate-local-runtimes.mjs — 新克隆开发者一键灌装 runtimes（QX-11 / 阶段 L3）。
//
// 让新克隆的开发者一条命令把 node/python/ffmpeg/chromium 灌进 apps/desktop/runtimes/，
// 对齐 verify-bundled-runtimes.mjs 的 keyFiles 口径。设计原则：**本地优先 + 远程回退**，
// 且**可重跑 + 备份式重灌**（满足工单「runtimes 移走 → 重灌 → runtime:verify 通过」关键验证项）。
//
// 源选择顺序：
//   1. 环境变量 QIANXIA_RUNTIME_BUNDLE 指向本地 runtimes-bundle.zip（+ 同目录 .minisig）→ 用之；
//   2. 本地 apps/desktop/runtimes/ 已通过 verify-bundled-runtimes.mjs（idempotent）→ exit 0，不动；
//   3. 远程回退：从 GitHub Release 下载 runtimes-bundle.zip + .minisig（需 QIANXIA_RUNTIME_PUBKEY），
//      验签后解压；本环境无 Release/密钥时明确提示并打印手工步骤，不假阳性。
//
// minisign 验签：复用 plugin_security.rs 同信任根公钥（QIANXIA_RUNTIME_PUBKEY）。
// 本机无 minisign 时按 ci.yml 方式拉取 minisign-0.12-win64.zip 自解压（临时目录，不入库）。
//
// 用法：
//   pnpm -C apps/desktop runtime:populate           # 一键（本地优先）
//   node scripts/populate-local-runtimes.mjs --force # 强制重灌（先备份现有 runtimes）
//   QIANXIA_RUNTIME_BUNDLE=../runtimes-bundle.zip node scripts/populate-local-runtimes.mjs
//
// 退出码：0=成功；1=失败（含未配置密钥的明确提示，防假阳性）。

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = resolve(repoRoot, 'apps', 'desktop', 'runtimes');
const lockPath = resolve(repoRoot, 'apps', 'desktop', 'runtime-lock.json');
const desktopDir = resolve(repoRoot, 'apps', 'desktop');
const FORCE = process.argv.includes('--force');

function log(msg) {
  console.log(`[populate] ${msg}`);
}
function warn(msg) {
  console.warn(`[populate][warn] ${msg}`);
}
function fail(msg) {
  console.error(`[populate][error] ${msg}`);
  process.exit(1);
}

// ── ci.yml publish-runtimes 的 populate 手工步骤摘要（失败回退指引）────────────
const MANUAL_STEPS = `
──────── 手工灌装指引（ci.yml publish-runtimes 的 populate 段摘要）────────
  $lock = Get-Content apps/desktop/runtime-lock.json -Raw | ConvertFrom-Json
  $rt   = 'apps/desktop/runtimes'

  # node
  Invoke-WebRequest $lock.runtimes.node.source -OutFile node-dist.zip
  Expand-Archive node-dist.zip -DestinationPath node-tmp -Force
  Move-Item node-tmp\\* "$rt/nodejs"
  $env:PATH = "$((Resolve-Path "$rt/nodejs").Path);$env:PATH"
  & "$rt/nodejs/npm.cmd" install -g --prefix "$rt/nodejs" 'pnpm@9'

  # python（install_only_stripped）
  Invoke-WebRequest $lock.runtimes.python.source -OutFile python-dist.tar.gz
  New-Item -ItemType Directory -Force -Path "$rt/python" | Out-Null
  tar -xzf python-dist.tar.gz -C "$rt/python" --strip-components=1
  & "$rt/python/python.exe" -m ensurepip --upgrade
  # python/Scripts/pip.cmd 垫片见 ci.yml 段落

  # ffmpeg（取 materialize 校验过的归档）
  tar -xf <ffmpeg-archive> -C ff-tmp && Copy-Item ff-tmp/*/bin/*.exe "$rt/ffmpeg/"

  # chromium（CfT 官方包，按 ms-playwright 布局）
  Invoke-WebRequest "$($lock.runtimes.chromium.source)/chrome-win64.zip" -OutFile cft-chrome.zip
  Invoke-WebRequest "$($lock.runtimes.chromium.source)/chrome-headless-shell-win64.zip" -OutFile cft-hss.zip
  Expand-Archive cft-chrome.zip -DestinationPath "$rt/chromium/ms-playwright/chromium-1228" -Force
  Expand-Archive cft-hss.zip  -DestinationPath "$rt/chromium/ms-playwright/chromium_headless_shell-1228" -Force

  完成后再跑：pnpm -C apps/desktop runtime:verify
────────────────────────────────────────────────────────────────────────────
`;

// ── 本地已灌装判定：复用 verify-bundled-runtimes.mjs（子进程，exit 0 = 通过）──
function verifyLocalRuntimes() {
  const r = spawnSync('node', [resolve(repoRoot, 'scripts', 'verify-bundled-runtimes.mjs'), runtimeRoot], {
    stdio: 'ignore',
  });
  return r.status === 0;
}

// ── minisign 可用性 / 自拉取 ──────────────────────────────────────────────
function findMinisign() {
  const probe = spawnSync('minisign', ['-V'], { stdio: 'ignore' });
  if (probe.status === 0) return 'minisign';
  const local = resolve(repoRoot, 'scripts', '.minisign-cache', 'minisign.exe');
  if (existsSync(local)) return local;
  return null;
}

function ensureMinisign() {
  let bin = findMinisign();
  if (bin) return bin;
  log('本机无 minisign，按 ci.yml 方式拉取 minisign-0.12-win64.zip 自解压（临时目录，不入库）…');
  const cacheDir = resolve(repoRoot, 'scripts', '.minisign-cache');
  mkdirSync(cacheDir, { recursive: true });
  const zip = resolve(cacheDir, 'minisign.zip');
  const dl = spawnSync('curl', ['-L', '--retry', '8', '--retry-all-errors', '--retry-delay', '5', '-o', zip,
    'https://github.com/jedisct1/minisign/releases/download/0.12/minisign-0.12-win64.zip'], { stdio: 'inherit' });
  if (dl.status !== 0) fail('minisign 下载失败，无法验签（请手动安装 minisign 或设置 QIANXIA_RUNTIME_PUBKEY 跳过远程回退）');
  // 解压取 x86_64 minisign.exe
  const tmp = resolve(cacheDir, 'tmp');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const ex = spawnSync('tar', ['-xf', zip, '-C', tmp], { stdio: 'ignore' });
  if (ex.status !== 0) {
    // 退回 powershell Expand-Archive
    spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force '${zip}' '${tmp}'`], { stdio: 'ignore' });
  }
  const found = (() => {
    const stack = [tmp];
    while (stack.length) {
      const dir = stack.pop();
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (/minisign.*\.exe$/i.test(e.name) && /x86_64/i.test(p)) return p;
      }
    }
    return null;
  })();
  if (!found) fail('minisign.exe 解压未找到');
  bin = resolve(cacheDir, 'minisign.exe');
  renameSync(found, bin);
  return bin;
}

// ── 验签 bundle + 解压 ─────────────────────────────────────────────────────
function sha256Of(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (c) => hash.update(c));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

function verifyBundleSignature(bundleZip, pubkey) {
  const minisign = ensureMinisign();
  const pubPath = resolve(repoRoot, 'scripts', '.minisign-cache', 'bundle.pubkey');
  writeFileSync(pubPath, pubkey.replace(/\r\n/g, '\n').replace(/\n$/, '') + '\n');
  const sigPath = bundleZip + '.minisig';
  if (!existsSync(sigPath)) fail(`缺少签名文件：${sigPath}`);
  const r = spawnSync(minisign, ['-V', '-p', pubPath, '-m', bundleZip, '-x', sigPath], { stdio: 'inherit' });
  if (r.status !== 0) fail('runtimes-bundle.zip minisign 验签失败（信任根不匹配或包被篡改）');
  log('runtimes-bundle.zip 验签通过 ✅');
}

function extractZip(zip, dest) {
  // Windows 优先用 powershell Expand-Archive；其他平台回退 unzip
  const ps = spawnSync('powershell', ['-NoProfile', '-Command',
    `Expand-Archive -Force '${zip}' '${dest}'`], { stdio: 'ignore' });
  if (ps.status === 0) return;
  const u = spawnSync('unzip', ['-o', zip, '-d', dest], { stdio: 'ignore' });
  if (u.status !== 0) throw new Error('解压 bundle 失败（无 powershell Expand-Archive 且无 unzip）');
}

// ── 备份式重灌：把现有 runtimes 备份，解压新 bundle，verify 失败则回滚 ────────
function repopulateFromBundle(bundleZip, { verifySig, pubkey }) {
  if (verifySig) verifyBundleSignature(bundleZip, pubkey);

  const backupDir = resolve(repoRoot, 'apps', 'desktop', `runtimes.bak.${Date.now()}`);
  const existingEntries = (() => {
    if (!existsSync(runtimeRoot) || !statSync(runtimeRoot).isDirectory()) return [];
    return readdirSync(runtimeRoot).filter((n) => n !== '.download' && n !== '.gitkeep');
  })();
  const hadExisting = existingEntries.length > 0;

  if (hadExisting) {
    log(`备份现有 runtimes → ${backupDir}`);
    renameSync(runtimeRoot, backupDir);
  }
  mkdirSync(runtimeRoot, { recursive: true });

  try {
    log(`解压 bundle → ${runtimeRoot}`);
    // bundle 内结构为 runtimes/...（tar -C apps/desktop 打包），解压后落到 runtimeRoot
    extractZip(bundleZip, resolve(repoRoot, 'apps', 'desktop'));
    log('校验 runtimes（runtime:verify）…');
    if (!verifyLocalRuntimes()) {
      throw new Error('重灌后 verify-bundled-runtimes 未通过');
    }
    if (hadExisting) {
      log(`清理备份 ${backupDir}`);
      rmSync(backupDir, { recursive: true, force: true });
    }
    log('runtimes 重灌并通过校验 ✅');
  } catch (e) {
    warn(`重灌失败：${e.message}`);
    if (hadExisting && existsSync(backupDir)) {
      warn(`回滚到备份 ${backupDir}`);
      rmSync(runtimeRoot, { recursive: true, force: true });
      renameSync(backupDir, runtimeRoot);
    }
    fail(`${e.message}；已回滚。${MANUAL_STEPS}`);
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────
function main() {
  if (!existsSync(lockPath)) fail(`缺少锁文件：${lockPath}`);

  // 1. 显式本地 bundle
  const envBundle = process.env.QIANXIA_RUNTIME_BUNDLE;
  if (envBundle && existsSync(envBundle)) {
    log(`使用本地 bundle：${envBundle}`);
    const pubkey = process.env.QIANXIA_RUNTIME_PUBKEY ?? '';
    repopulateFromBundle(envBundle, { verifySig: !!pubkey, pubkey });
    return;
  }

  // 2. 本地已灌装（幂等）→ 不动
  if (!FORCE && existsSync(runtimeRoot)) {
    // 必须确有文件（而非空目录）才认作已灌装
    const hasFiles = readdirSync(runtimeRoot).filter((n) => n !== '.download' && n !== '.gitkeep').length > 0;
    if (hasFiles && verifyLocalRuntimes()) {
      log('本地 runtimes 已通过校验，无需重灌（幂等）。如需强制重灌加 --force。');
      process.exit(0);
    }
    if (hasFiles) warn('本地 runtimes 存在但未通过校验，尝试远程回退重灌…');
  }

  // 3. 远程回退：GitHub Release
  const pubkey = process.env.QIANXIA_RUNTIME_PUBKEY;
  if (!pubkey) {
    warn('未配置 QIANXIA_RUNTIME_PUBKEY，无法验签远程 bundle；跳过远程回退。');
    warn('本环境若无 Release / 安装器，请在本机（具备密钥与 Release 的机器）复核安装闭环。');
    console.error(MANUAL_STEPS);
    process.exit(1);
  }

  const tag = process.env.QIANXIA_RUNTIME_RELEASE_TAG ?? 'latest';
  const dl = resolve(repoRoot, 'apps', 'desktop', 'runtimes-bundle.zip');
  log(`从 GitHub Release（${tag}）下载 runtimes-bundle.zip …`);
  // gh 不传 tag 即取最新 Release；字面量 'latest' 会被当成 tag 名导致找不到。
  const ghArgs = ['release', 'download'];
  if (tag !== 'latest') ghArgs.push(tag);
  ghArgs.push('-R', process.env.QIANXIA_RUNTIME_REPO ?? 'qiuuchan/new-qianxia',
    '-p', 'runtimes-bundle.zip', '-p', 'runtimes-bundle.zip.minisig', '-D', resolve(repoRoot, 'apps', 'desktop'));
  const gh = spawnSync('gh', ghArgs, { stdio: 'inherit' });
  if (gh.status !== 0) {
    warn('gh release download 失败（可能无此 Release / 未登录 / 无 gh）。');
    console.error(MANUAL_STEPS);
    process.exit(1);
  }
  repopulateFromBundle(dl, { verifySig: true, pubkey });
}

main();
