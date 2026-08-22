#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  const tmp = join(downloadDir, `.${name}.${Date.now()}.tmp`);
  try {
    const res = await fetch(url);
    if (!res.ok || !res.body)
      fail(`download failed (${res.status}) for ${url}`);

    const buf = Buffer.from(await res.arrayBuffer());
    // size 硬校验
    if (buf.length !== expectedSize)
      fail(`size mismatch for ${url}: got ${buf.length}, expected ${expectedSize}`);
    // sha256 硬校验（产品核心要求）
    const actual = createHash('sha256').update(buf).digest('hex');
    if (actual !== expectedSha)
      fail(`sha256 mismatch for ${url}: got ${actual}, expected ${expectedSha}`);

    await writeFile(tmp, buf);
    process.stdout.write(
      `[runtimes] downloaded & verified ${url} (sha256 OK); ` +
        `extraction of ${pendingCount} files pending — run on Windows build host with 7z\n`,
    );
    // 归档保留在 .download/ 下，供 CI/构建主机解压；不在此清理。
  } catch (error) {
    rmSync(tmp, { force: true });
    if (error && typeof error.message === 'string' && error.message.includes('mismatch'))
      throw error;
    fail(`download/verify error for ${url}: ${error?.message ?? error}`);
  }
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
