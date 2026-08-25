// build 命令：校验插件工作区 → 打包为 .lfplugin v4 产物（见 design.md §2.3）。
// 调用 validateManifest 校验 manifest，然后通过 archive.ts 的 packWorkspace 生成 ZIP。
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateManifest, type ManifestResult } from '../../manifest/index.ts';
import { packWorkspace } from '../util/archive.ts';
import { log } from '../log.ts';
import { parseArgs } from '../parser.ts';
import { validateRootReadme } from '../util/readme.ts';
import { resolvePluginPath } from '../util/resolvePath.ts';

export interface BuildOptions {
  path?: string; // 默认 process.cwd()
  out?: string; // 默认 <id>-<version>.lfplugin 在 cwd
  json?: boolean; // JSON 输出模式
}

export interface BuildError {
  code: string;
  message: string;
}

export interface BuildResult {
  ok: boolean;
  outputPath: string;
  sizeBytes: number;
  fileCount: number;
  sha256Prefix: string;
  errors: BuildError[];
}

/**
 * 构建命令：校验 + 打包 + 输出。
 *
 * @param argv  CLI 参数（不含 node / script 名）
 * @param opts  选项（可通过编程方式传入，优先级低于 argv）
 * @returns     退出码：0 成功，1 失败
 */
export async function buildCommand(argv: string[], opts?: BuildOptions): Promise<number> {
  const parsed = parseArgs(argv);

  // 1. 解析插件路径（LF-05 / g2-sdk-friction #2：防 cwd 固定导致的二次拼接）
  const pluginPath = resolvePluginPath(parsed.positional[0] ?? opts?.path ?? process.cwd());

  // 2. 读取 manifest.json
  const manifestPath = path.join(pluginPath, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return printError(
      'manifest_not_found',
      `manifest.json 不存在，期望路径: ${manifestPath}`,
      opts?.json ?? false
    );
  }

  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf-8');
  } catch (e) {
    return printError(
      'manifest_read_error',
      `无法读取 manifest.json: ${(e as Error).message}`,
      opts?.json ?? false
    );
  }

  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(raw);
  } catch (e) {
    return printError(
      'manifest_invalid_json',
      `manifest.json 不是合法的 JSON: ${(e as SyntaxError).message}`,
      opts?.json ?? false
    );
  }

  // 3. 校验 manifest
  const manifestResult: ManifestResult = validateManifest(parsedManifest);
  if (!manifestResult.success) {
    const lines = manifestResult.errors.map((e) => `  [${e.code}] ${e.path}: ${e.message}`);
    return printError(
      'manifest_validation_failed',
      `manifest 校验失败:\n${lines.join('\n')}`,
      opts?.json ?? false
    );
  }

  const manifest = manifestResult.manifest;

  // 4. 检查入口文件存在（快速失败，在 packWorkspace 之前）
  const entryPath = path.join(pluginPath, manifest.entry);
  if (!existsSync(entryPath)) {
    return printError(
      'entry_not_found',
      `入口文件不存在: ${manifest.entry}（完整路径: ${entryPath}）`,
      opts?.json ?? false
    );
  }

  const readmeError = validateRootReadme(pluginPath);
  if (readmeError) return printError(readmeError.code, readmeError.message, opts?.json ?? false);

  // 5. 打包
  let packResult;
  try {
    packResult = await packWorkspace({ workspaceDir: pluginPath, manifest });
  } catch (e) {
    return printError('pack_failed', `打包失败: ${(e as Error).message}`, opts?.json ?? false);
  }

  // 6. 确定输出路径
  const resolvedOut =
    opts?.out ??
    (parsed.flags.out && typeof parsed.flags.out === 'string' ? parsed.flags.out : undefined);
  const outputPath = path.resolve(resolvedOut ?? packResult.suggestedFilename);

  // 7. 写入文件
  try {
    await writeFile(outputPath, packResult.buffer);
  } catch (e) {
    return printError(
      'write_failed',
      `写入输出文件失败: ${(e as Error).message}`,
      opts?.json ?? false
    );
  }

  // 8. 输出结果
  const json = opts?.json ?? parsed.flags.json === true;
  if (json) {
    const result: BuildResult = {
      ok: true,
      outputPath,
      sizeBytes: packResult.buffer.length,
      fileCount: packResult.files.length + 2, // +2 for _meta.json + manifest.json
      sha256Prefix: packResult.sha256Prefix,
      errors: [],
    };
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    log.success(`已打包：${outputPath}`);
    log.raw(`  大小：${packResult.buffer.length} 字节`);
    log.raw(`  文件：${packResult.files.length + 2} 个`);
    log.raw(`  SHA256：${packResult.sha256Prefix}`);
    log.raw(`  推荐发布名：${packResult.suggestedFilename}`);
  }

  return 0;
}

// ── 错误输出 ──────────────────────────────────────────────────────────

function printError(code: string, message: string, json: boolean): number {
  if (json) {
    const result: BuildResult = {
      ok: false,
      outputPath: '',
      sizeBytes: 0,
      fileCount: 0,
      sha256Prefix: '',
      errors: [{ code, message }],
    };
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    log.error(`${code}: ${message}`);
  }
  return 1;
}
