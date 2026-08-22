// ESM loader hooks 实现：补全 .ts 扩展。
// 通过 loader-hooks.mjs 的 register() 调用激活。

import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

function fileExists(url) {
  try {
    return existsSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

function tryResolveTsExtension(specifier, parentURL) {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    return null; // bare import
  }
  if (!parentURL.startsWith('file:')) return null;

  // specifier 已经带扩展
  const direct = new URL(specifier, parentURL);
  if (fileExists(direct)) return null;

  // 试 .ts / .tsx / .mts / .cts
  for (const ext of TS_EXTENSIONS) {
    const candidate = new URL(specifier + ext, parentURL);
    if (fileExists(candidate)) return candidate.href;
  }

  // 试 index.ts（目录模块）
  const indexCandidate = new URL(specifier + '/index.ts', parentURL);
  if (fileExists(indexCandidate)) return indexCandidate.href;

  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL && context.parentURL.startsWith('file:')) {
    const rewritten = tryResolveTsExtension(specifier, context.parentURL);
    if (rewritten) {
      return nextResolve(rewritten, context);
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  // 让 .ts 文件走 Node 内置 strip-types（不要自己读 source）
  return nextLoad(url, context);
}
