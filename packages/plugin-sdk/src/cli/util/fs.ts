// 跨平台文件操作工具 — 纯 Node.js 标准库。
// 文件系统路径用 path.join（OS 决定），manifest 内部路径用 path.posix.join（始终 /）。

import { mkdir, cp, writeFile as _writeFile, access } from 'node:fs/promises';
import path from 'node:path';

/** 递归拷贝目录（不覆盖已有文件，保留目录结构） */
export async function copyDir(src: string, dest: string): Promise<void> {
  await cp(src, dest, { recursive: true, errorOnExist: false });
}

/** 确保目录存在（幂等） */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** 写文件（字符串或 Buffer） */
export async function writeFile(filePath: string, content: string | Uint8Array): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await _writeFile(filePath, content, 'utf-8');
}

/** 检查路径是否存在 */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** 用 POSIX 分隔符拼接（用于 manifest 内部路径） */
export function posixJoin(...segments: string[]): string {
  return path.posix.join(...segments);
}

/** 用 OS 分隔符拼接（用于文件系统操作） */
export function osJoin(...segments: string[]): string {
  return path.join(...segments);
}
