#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFile,
} from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = resolve(process.argv[2] ?? join(repoRoot, 'apps', 'desktop', 'runtimes'));
// 真实锁文件位于仓库根目录下的 apps/desktop/runtime-lock.json（已提交），
// 而非 apps/desktop/runtimes/（该目录被 gitignore 且无锁文件）。
const lockPath = join(repoRoot, 'apps', 'desktop', 'runtime-lock.json');

if (!existsSync(lockPath)) fail(`missing lock file: ${lockPath}`);
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));

for (const entry of lock.materializedFiles ?? []) {
  await materialize(entry);
}

// ── B3: 公共可下载来源（https://）运行时支持 ──────────────────────────────
// 当 runtime 的 source 是一个 https:// URL 时，脚本负责：
//   1) 下载归档到 runtimeRoot/.download/ 并做 sha256 + size 硬校验；
//   2) 归档内文件的解压交由带 7z 的 Windows 构建主机完成（本环境不假设 7z 存在）。
// 若 sourceSha256/sourceSize 尚未就绪（TODO / 0），则打印 NOTICE 并跳过，
// 不硬失败——因为本环境尚未抓取二进制。
const downloadDir = join(runtimeRoot, '.download');

for (const [name, rt] of Object.entries(lock.runtimes ?? {})) {
  const source = rt.source;
  // 旧式来源（repository-history:）：本次不处理，静默跳过。
  if (typeof source !== 'string' || !source.startsWith('https://')) continue;

  const expectedSha = rt.sourceSha256;
  const expectedSize = Number(rt.sourceSize) || 0;
  if (!expectedSha || expectedSha === 'TODO_FETCH_AND_FILL' || expectedSize <= 0) {
    process.stdout.write(
      `[runtimes] skip ${name}: public source not ready (fill sourceSha256/sourceSize)\n`,
    );
    continue;
  }

  // 统计该运行时声明的待解压文件数（keyFiles / requiredFiles）。
  const pendingFiles = [
    ...(rt.keyFiles ?? []),
    ...(rt.requiredFiles ?? []),
  ];
  await downloadAndVerify(name, source, expectedSha, expectedSize, pendingFiles.length);
}

async function downloadAndVerify(name, url, expectedSha, expectedSize, pendingCount) {
  mkdirSync(downloadDir, { recursive: true });

  // ── B3: 预载复用（CI 用 curl 断点续传预取 / 本地缓存）。
  // 命中即跳过网络下载，但 sha256 + size 仍然硬校验——信任根不降级。
  for (const entry of readdirSync(downloadDir)) {
    if (!entry.startsWith(`.${name}.`)) continue;
    const candidate = join(downloadDir, entry);
    const stat = statSync(candidate);
    if (!stat.isFile() || stat.size !== expectedSize) continue;
    if ((await sha256(candidate)) !== expectedSha) continue;
    process.stdout.write(
      `[runtimes] reused pre-fetched ${entry} (sha256 OK); ` +
        `extraction of ${pendingCount} files pending\n`,
    );
    return;
  }

  const tmp = join(downloadDir, `.${name}.${Date.now()}.tmp`);
  let buffer;
  // 网络类错误重试；sha/size 不匹配是确定性失败，不进入重试。
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok || !res.body)
        fail(`download failed (${res.status}) for ${url}`);
      buffer = Buffer.from(await res.arrayBuffer());
      break;
    } catch (error) {
      if (attempt >= 3)
        fail(`download error after ${attempt} attempts for ${url}: ${error?.message ?? error}`);
      process.stdout.write(
        `[runtimes] download attempt ${attempt} failed for ${url} (${error?.message ?? error}); retrying\n`,
      );
      await new Promise((resolveRetry) => setTimeout(resolveRetry, 5000 * attempt));
    }
  }
  if (buffer.length !== expectedSize)
    fail(`size mismatch for ${url}: got ${buffer.length}, expected ${expectedSize}`);
  const actual = createHash('sha256').update(buffer).digest('hex');
  if (actual !== expectedSha)
    fail(`sha256 mismatch for ${url}: got ${actual}, expected ${expectedSha}`);

  await writeFile(tmp, buffer);
  process.stdout.write(
    `[runtimes] downloaded & verified ${url} (sha256 OK); ` +
      `extraction of ${pendingCount} files pending — run on Windows build host with 7z\n`,
  );
}

async function materialize(entry) {
  const target = join(runtimeRoot, entry.path);
  if (await matches(target, entry)) return;
  const partsRoot = resolve(runtimeRoot, entry.partsRoot ?? '.');

  for (const part of entry.parts ?? []) {
    const partPath = join(partsRoot, part);
    if (!existsSync(partPath) || !statSync(partPath).isFile())
      fail(`missing runtime part: ${part}`);
  }
  if (!entry.parts?.length) fail(`no runtime parts configured: ${entry.path}`);

  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.materializing`;
  rmSync(temporary, { force: true });
  try {
    for (const [index, part] of entry.parts.entries()) {
      const output = createWriteStream(temporary, { flags: index === 0 ? 'wx' : 'a' });
      await pipeline(createReadStream(join(partsRoot, part)), output);
    }
    if (!(await matches(temporary, entry)))
      fail(`materialized file checksum mismatch: ${entry.path}`);
    renameSync(temporary, target);
    process.stdout.write(`[runtimes] materialized ${entry.path}\n`);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

async function matches(path, entry) {
  if (!existsSync(path)) return false;
  const stat = statSync(path);
  if (!stat.isFile() || stat.size !== entry.size) return false;
  return (await sha256(path)) === entry.sha256;
}

function sha256(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

function fail(message) {
  process.stderr.write(`[runtimes] ${message}\n`);
  process.exit(1);
}
