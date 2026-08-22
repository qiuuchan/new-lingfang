#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = resolve(process.argv[2] ?? join(repoRoot, 'apps', 'desktop', 'runtimes'));
// 真实锁文件位于仓库根目录下的 apps/desktop/runtime-lock.json（已提交），
// 而非 apps/desktop/runtimes/（该目录被 gitignore 且无锁文件）。
const lockPath = join(repoRoot, 'apps', 'desktop', 'runtime-lock.json');

if (!existsSync(lockPath)) fail(`missing lock file: ${lockPath}`);
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
if (lock.platform !== 'windows-x64') fail(`unsupported runtime platform: ${lock.platform}`);
verifyPlaywrightLock(lock);

for (const relativePath of lock.requiredFiles ?? []) {
  const path = join(runtimeRoot, relativePath);
  if (!existsSync(path) || !statSync(path).isFile()) fail(`missing required file: ${relativePath}`);
}

for (const entry of lock.keyFiles ?? []) {
  const path = join(runtimeRoot, entry.path);
  if (!existsSync(path)) fail(`missing key file: ${entry.path}`);
  const stat = statSync(path);
  if (!stat.isFile()) fail(`key path is not a file: ${entry.path}`);
  if (stat.size !== entry.size)
    fail(`size mismatch: ${entry.path} expected=${entry.size} actual=${stat.size}`);
  const digest = await sha256(path);
  if (digest !== entry.sha256) fail(`sha256 mismatch: ${entry.path}`);
}

for (const entry of lock.materializedFiles ?? []) {
  await verifyFile(entry);
}

const summary = Object.entries(lock.runtimes)
  .map(([name, value]) => `${name}=${value.version ?? value.browserVersion}`)
  .join(', ');
process.stdout.write(`[runtimes] verified ${lock.keyFiles.length} key files (${summary})\n`);

function sha256(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

async function verifyFile(entry) {
  const path = join(runtimeRoot, entry.path);
  if (!existsSync(path)) fail(`missing materialized file: ${entry.path}`);
  const stat = statSync(path);
  if (!stat.isFile()) fail(`materialized path is not a file: ${entry.path}`);
  if (stat.size !== entry.size)
    fail(`size mismatch: ${entry.path} expected=${entry.size} actual=${stat.size}`);
  const digest = await sha256(path);
  if (digest !== entry.sha256) fail(`sha256 mismatch: ${entry.path}`);
}

function verifyPlaywrightLock(runtimeLock) {
  const require = createRequire(import.meta.url);
  let packagePath;
  try {
    const testPackage = require.resolve('@playwright/test/package.json', { paths: [repoRoot] });
    const playwrightPackage = createRequire(testPackage).resolve('playwright/package.json');
    packagePath = createRequire(playwrightPackage).resolve('playwright-core/package.json');
  } catch {
    fail('playwright-core is not installed; run pnpm install before verification');
  }
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  const browsersJson = JSON.parse(
    readFileSync(join(dirname(packagePath), 'browsers.json'), 'utf8')
  );
  const chromium = browsersJson.browsers.find((browser) => browser.name === 'chromium');
  const expected = runtimeLock.runtimes.chromium;
  if (packageJson.version !== expected.playwrightVersion) {
    fail(
      `Playwright version drift: lock=${expected.playwrightVersion} installed=${packageJson.version}`
    );
  }
  if (
    !chromium ||
    chromium.revision !== expected.revision ||
    chromium.browserVersion !== expected.browserVersion
  ) {
    fail(
      `Chromium revision drift: lock=${expected.revision}/${expected.browserVersion} installed=${chromium?.revision}/${chromium?.browserVersion}`
    );
  }
}

function fail(message) {
  process.stderr.write(`[runtimes] ${message}\n`);
  process.exit(1);
}
