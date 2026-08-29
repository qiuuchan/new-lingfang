// .qplugin v4 打包器：与桌面壳 `plugin_artifact_v4.rs::inspect_artifact` 兼容。
// 真源：.trellis/tasks/07-13-plugin-dev-sdk/research/qplugin-format.md
//
// 关键约束：
// - ZIP 根级文件（无顶层目录）
// - _meta.json 固定内容（紧凑 JSON）
// - manifest.json pretty-printed
// - 文件字典序，固定 date=new Date(0)，权限 0o644，Deflate level 6，platform UNIX
// - 排除：data, .git, .venv, venv, node_modules, .qianxia, __pycache__, .pytest_cache,
//   .mypy_cache, *.pyc, *.pyo, _meta.json（由本模块创建）, manifest.json（同上）

import { createHash } from 'node:crypto';
import { type Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

// 大小限制（与 plugin_artifact_v4.rs 第 12-15 行对齐）
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 60 * 1024 * 1024;
const MAX_FILES = 1500;

// 排除路径段（plugin_artifact_v4.rs 第 17-27 行）
const EXCLUDED_SEGMENTS = new Set([
  'data',
  '.git',
  '.venv',
  'venv',
  'node_modules',
  '.qianxia',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
]);

// _meta.json 固定内容（紧凑 JSON，与 Rust 第 52 行 b"{...}" 一致）
const META_JSON_CONTENT = '{"format":"qianxia-plugin","formatVersion":4}';

export interface CollectedFile {
  /** ZIP 内部路径（始终用正斜杠）。 */
  zipPath: string;
  /** 文件系统绝对路径。 */
  absPath: string;
  /** 文件大小（字节）。 */
  size: number;
}

export interface CollectOptions {
  /** 是否跟踪符号链接（默认 false，与 Rust 行为一致——拒绝符号链接）。 */
  followSymlinks?: boolean;
}

export interface PackOptions {
  /** 工作区目录（插件根，含 manifest.json）。 */
  workspaceDir: string;
  /** 已校验的 manifest 对象（用于决定 entry 路径）。 */
  manifest: {
    id: string;
    name: string;
    version: string;
    description?: string;
    runtime_type: string;
    entry: string;
    visibility?: string;
    capabilities?: unknown[];
    [key: string]: unknown;
  };
}

export interface PackResult {
  /** ZIP 字节流。 */
  buffer: Buffer;
  /** 收集到的文件清单（不含 _meta.json / manifest.json）。 */
  files: CollectedFile[];
  /** 总未压缩字节数。 */
  totalUncompressed: number;
  /** 输出文件的推荐名称 `<id>-<version>.qplugin`。 */
  suggestedFilename: string;
  /** ZIP 内容的 SHA256（前 16 字符），与桌面壳 release_id 计算方式一致。 */
  sha256Prefix: string;
}

/**
 * 路径安全检查：拒绝绝对路径、`..`、反斜杠（ZIP 标准要求正斜杠）。
 * 与 plugin_artifact_v4.rs::normalized_relative 对齐。
 */
function normalizeRelative(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`路径为空`);
  }
  if (input.includes('\\')) {
    throw new Error(`路径包含反斜杠：${input}`);
  }
  // 标准化：把 Windows 风格转 POSIX（仅用于比较，不影响原值）
  const segments = input.split('/');
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      throw new Error(`路径包含 .. ：${input}`);
    }
    out.push(seg);
  }
  if (out.length === 0) {
    throw new Error(`路径为空（仅 . 或 /）：${input}`);
  }
  return out.join('/');
}

/**
 * 判断 ZIP 路径是否包含排除段。
 * 与 plugin_artifact_v4.rs::should_exclude 对齐。
 */
function containsExcludedSegment(zipPath: string): boolean {
  const segments = zipPath.split('/');
  for (const seg of segments) {
    if (EXCLUDED_SEGMENTS.has(seg)) return true;
  }
  // .pyc / .pyo 后缀排除
  if (zipPath.endsWith('.pyc') || zipPath.endsWith('.pyo')) return true;
  return false;
}

/**
 * 递归收集工作区文件，跳过排除项。
 * 与 plugin_artifact_v4.rs::collect_workspace_source_files 对齐。
 *
 * 返回的文件**不**含 `_meta.json` 和 `manifest.json`（由 packWorkspace 单独写入）。
 */
export async function collectWorkspaceFiles(
  workspaceDir: string,
  _opts: CollectOptions = {}
): Promise<CollectedFile[]> {
  const collected: CollectedFile[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      throw new Error(`无法读取目录：${dir}`);
    }
    // 按名称排序保证字典序收集（最终输出再次排序）
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const absPath = join(dir, entry.name);
      // 相对 workspaceDir 的路径
      const relPath = relative(workspaceDir, absPath);
      // ZIP 内部用正斜杠
      const zipPath = relPath.split(sep).join('/');

      // 跳过 _meta.json 和 manifest.json（packWorkspace 单独写）
      if (zipPath === '_meta.json' || zipPath === 'manifest.json') continue;

      // 符号链接：跳过（与 Rust 一致——Rust 拒绝，但收集阶段跳过更友好）
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        // 排除目录段
        if (EXCLUDED_SEGMENTS.has(entry.name)) continue;
        await walk(absPath);
        continue;
      }

      if (!entry.isFile()) continue;

      // 排除路径段检查（防止单文件名匹配）
      if (containsExcludedSegment(zipPath)) continue;

      // 标准化路径校验
      try {
        normalizeRelative(zipPath);
      } catch {
        continue; // 跳过非法路径
      }

      let st;
      try {
        st = await stat(absPath);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (st.size > MAX_FILE_BYTES) {
        throw new Error(`文件过大（${st.size} > ${MAX_FILE_BYTES}）：${zipPath}`);
      }
      collected.push({ zipPath, absPath, size: st.size });
    }
  }

  await walk(workspaceDir);

  if (collected.length === 0) {
    throw new Error('工作区无任何可打包文件（仅 manifest.json + _meta.json 之外应有入口文件）');
  }
  if (collected.length > MAX_FILES) {
    throw new Error(`文件数超限（${collected.length} > ${MAX_FILES}）`);
  }

  // 按字典序排序（与 Rust 第 151 行 files.sort_by 对齐）
  collected.sort((a, b) => (a.zipPath < b.zipPath ? -1 : a.zipPath > b.zipPath ? 1 : 0));

  // 总解压大小限制
  const totalUncompressed = collected.reduce((sum, f) => sum + f.size, 0);
  if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
    throw new Error(`总大小超限（${totalUncompressed} > ${MAX_UNCOMPRESSED_BYTES}）`);
  }

  return collected;
}

/**
 * 打包工作区为 .qplugin v4 字节流。
 *
 * 使用方式：
 * ```ts
 * const result = await packWorkspace({ workspaceDir, manifest });
 * await writeFile('my-plugin-1.0.0.qplugin', result.buffer);
 * ```
 */
export async function packWorkspace(opts: PackOptions): Promise<PackResult> {
  const { workspaceDir, manifest } = opts;

  // 收集文件
  const files = await collectWorkspaceFiles(workspaceDir);

  // 验证 manifest.entry 在收集结果中（与 Rust inspect 第 362-368 行一致）
  const entryZipPath = (() => {
    try {
      return normalizeRelative(manifest.entry);
    } catch (e) {
      throw new Error(`manifest.entry 路径非法：${(e as Error).message}`);
    }
  })();
  const entryExists = files.some((f) => f.zipPath === entryZipPath);
  if (!entryExists) {
    throw new Error(
      `manifest.entry "${entryZipPath}" 不在打包文件列表中（可能被排除段过滤或文件不存在）`
    );
  }

  // 创建 ZIP
  const zip = new JSZip();

  // 文件选项：固定时间戳（new Date(0) = 1970-01-01）+ unix 0o644 权限
  // 与 Rust SimpleFileOptions::default()
  //   .last_modified_time(DateTime::default())
  //   .unix_permissions(0o644)
  //   .compression_method(CompressionMethod::Deflated)
  // 对齐
  const fileOptions = {
    date: new Date(0),
    unixPermissions: 0o644,
    // 关键：jszip 默认 createFolders=true 会自动生成中间目录条目（如 `ui/`），
    // 而 Rust inspect_artifact 明确拒绝目录条目（plugin_artifact_v4.rs:297-298）。
    // 设为 false 让 ZIP 只含扁平文件条目（路径含 `/` 但无目录 entry）。
    createFolders: false,
  };

  // 1. _meta.json（紧凑 JSON，无换行）
  zip.file('_meta.json', META_JSON_CONTENT, fileOptions);

  // 2. manifest.json（pretty-printed，2 空格缩进）
  // 与 Rust serde_json::to_vec_pretty 对齐
  const manifestJson = JSON.stringify(manifest, null, 2);
  zip.file('manifest.json', manifestJson, fileOptions);

  // 3. 所有源文件（已字典序）
  let totalUncompressed = 0;
  for (const file of files) {
    const content = await readFile(file.absPath);
    totalUncompressed += content.length;
    zip.file(file.zipPath, content, fileOptions);
  }

  // 生成 ZIP buffer
  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'UNIX',
  });

  if (buffer.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`ZIP 大小超限（${buffer.length} > ${MAX_ARCHIVE_BYTES}）`);
  }

  // SHA256 前缀（与桌面壳 release_id "local-<sha256[..16]>" 一致）
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const sha256Prefix = sha256.slice(0, 16);

  // 推荐文件名
  const safeId = manifest.id.replace(/[^a-zA-Z0-9-_.]/g, '-');
  const suggestedFilename = `${safeId}-${manifest.version}.qplugin`;

  return {
    buffer,
    files,
    totalUncompressed,
    suggestedFilename,
    sha256Prefix,
  };
}

/**
 * 从 import.meta.url 或 __filename 推断包根目录。
 * 用于 CLI 在 dev 模式下定位自身。
 */
export function packageRootFromMetaUrl(metaUrl: string): string {
  return dirname(dirname(dirname(fileURLToPath(new URL(metaUrl)))));
}
