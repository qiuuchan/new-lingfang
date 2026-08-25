// validate 命令：manifest 校验 + 目录结构检查（见 design.md §2.2）。
// 调用 validateManifest 做 Schema + 业务规则双层校验，然后检查入口文件、
// package.json、requirements.txt 等目录结构。
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { validateManifest, type ManifestResult } from '../../manifest/index.ts';
import type { PluginManifest } from '@lingfang/contract';
import { validateRootReadme } from '../util/readme.ts';
import { resolvePluginPath } from '../util/resolvePath.ts';

export interface ValidateOptions {
  path?: string;
  json?: boolean;
}

export interface ValidateError {
  code: string;
  path: string;
  message: string;
}

export interface ValidateResult {
  valid: boolean;
  manifestPath: string;
  errors: ValidateError[];
  warnings: ValidateError[];
}

/**
 * 校验插件目录：manifest 格式 + 目录结构。
 *
 * @param argv  CLI 位置参数（暂未使用，留待后续扩展）
 * @param opts  选项：path 指定插件目录（默认 process.cwd()），json=true 输出 JSON
 * @returns     退出码：0 表示通过，1 表示有错误
 */
export async function validateCommand(_argv: string[], opts?: ValidateOptions): Promise<number> {
  // LF-05 / g2-sdk-friction #2：路径归一化防二次拼接（cwd 固定为 packages/plugin-sdk 时，
  // 仓库根相对路径会被叠加）。绝对路径原样，相对路径先按 cwd、再按工作区根解析。
  const pluginPath = resolvePluginPath(opts?.path ?? process.cwd());
  const manifestPath = path.join(pluginPath, 'manifest.json');
  const errors: ValidateError[] = [];
  let manifest: PluginManifest | null = null;

  // 1. 检查 manifest.json 是否存在
  if (!existsSync(manifestPath)) {
    errors.push({
      code: 'manifest_not_found',
      path: manifestPath,
      message: `manifest.json 不存在，期望路径: ${manifestPath}`,
    });
    printResult(manifestPath, errors, opts?.json ?? false, []);
    return 1;
  }

  // 2. 读取并解析 JSON
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf-8');
  } catch (e) {
    errors.push({
      code: 'manifest_read_error',
      path: manifestPath,
      message: `无法读取 manifest.json: ${(e as Error).message}`,
    });
    printResult(manifestPath, errors, opts?.json ?? false, []);
    return 1;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    errors.push({
      code: 'manifest_invalid_json',
      path: manifestPath,
      message: `manifest.json 不是合法的 JSON: ${(e as SyntaxError).message}`,
    });
    printResult(manifestPath, errors, opts?.json ?? false, []);
    return 1;
  }

  // 3. Schema + 业务规则校验
  const result: ManifestResult = validateManifest(parsed);

  if (!result.success) {
    for (const e of result.errors) {
      errors.push({ code: e.code, path: e.path, message: e.message });
    }
    printResult(manifestPath, errors, opts?.json ?? false, []);
    return 1;
  }

  manifest = result.manifest;

  // 非阻塞警告（例如 cloud/workflow 运行时本地不支持）：仅提示，不影响退出码
  const warnings: ValidateError[] = result.warnings.map((w) => ({
    code: w.code,
    path: w.path,
    message: w.message,
  }));

  // 4. 目录结构检查（仅 manifest 通过后执行）
  const dirErrors = checkDirectoryStructure(pluginPath, manifest);
  errors.push(...dirErrors);
  const readmeError = validateRootReadme(pluginPath);
  if (readmeError) errors.push(readmeError);

  printResult(manifestPath, errors, opts?.json ?? false, warnings);

  return errors.length > 0 ? 1 : 0;
}

// ── 目录结构检查 ──────────────────────────────────────────────────────

function checkDirectoryStructure(pluginPath: string, manifest: PluginManifest): ValidateError[] {
  const errors: ValidateError[] = [];

  // 入口文件存在性
  const entryPath = path.join(pluginPath, manifest.entry);
  if (!existsSync(entryPath)) {
    errors.push({
      code: 'entry_not_found',
      path: manifest.entry,
      message: `入口文件不存在: ${manifest.entry}`,
    });
  } else {
    const stat = statSync(entryPath);
    if (!stat.isFile()) {
      errors.push({
        code: 'entry_not_file',
        path: manifest.entry,
        message: `entry 路径不是文件: ${manifest.entry}`,
      });
    }
  }

  // nodejs 运行时：检查 package.json 格式
  if (manifest.runtime_type === 'nodejs') {
    const pkgPath = path.join(pluginPath, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        JSON.parse(readFileSync(pkgPath, 'utf-8'));
      } catch {
        errors.push({
          code: 'package_json_invalid',
          path: 'package.json',
          message: 'package.json 不是合法的 JSON',
        });
      }
    }
  }

  // python 运行时：检查 requirements.txt 格式
  if (manifest.runtime_type === 'python') {
    const reqPath = path.join(pluginPath, 'requirements.txt');
    if (existsSync(reqPath)) {
      try {
        const content = readFileSync(reqPath, 'utf-8');
        const lines = content.split('\n');
        const PIP_PATTERN = /^[a-zA-Z0-9_.-]+(?:[<>=!~]=?.*)?$/;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line === '' || line.startsWith('#')) continue;
          if (!PIP_PATTERN.test(line)) {
            errors.push({
              code: 'requirements_invalid_format',
              path: `requirements.txt:${i + 1}`,
              message: `requirements.txt 第 ${i + 1} 行格式不合法: "${line}"`,
            });
          }
        }
      } catch {
        errors.push({
          code: 'requirements_read_error',
          path: 'requirements.txt',
          message: '无法读取 requirements.txt',
        });
      }
    }
  }

  return errors;
}

// ── 输出 ───────────────────────────────────────────────────────────────

function printResult(
  manifestPath: string,
  errors: ValidateError[],
  json: boolean,
  warnings: ValidateError[] = []
): void {
  if (json) {
    const output: ValidateResult = {
      valid: errors.length === 0,
      manifestPath,
      errors,
      warnings,
    };
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    return;
  }

  // 人类可读模式：中文输出，✓/✗ 逐项显示
  const lines: string[] = [];
  const hasManifestCheck = errors.some(
    (e) => e.code === 'manifest_not_found' || e.code === 'manifest_read_error'
  );
  const hasJsonError = errors.some((e) => e.code === 'manifest_invalid_json');
  const hasManifestErrors = errors.some(
    (e) =>
      e.code !== 'manifest_not_found' &&
      e.code !== 'manifest_read_error' &&
      e.code !== 'manifest_invalid_json' &&
      e.code !== 'entry_not_found' &&
      e.code !== 'entry_not_file' &&
      e.code !== 'package_json_invalid' &&
      e.code !== 'requirements_invalid_format' &&
      e.code !== 'requirements_read_error'
  );
  const hasEntryNotFound = errors.some((e) => e.code === 'entry_not_found');
  const hasEntryNotFile = errors.some((e) => e.code === 'entry_not_file');
  const hasPkgJsonError = errors.some((e) => e.code === 'package_json_invalid');
  const hasReqError = errors.some(
    (e) => e.code === 'requirements_invalid_format' || e.code === 'requirements_read_error'
  );

  lines.push(`\n验证插件: ${manifestPath}\n`);

  // manifest.json 存在性
  if (hasManifestCheck) {
    lines.push('✗ manifest.json 不存在');
  } else {
    lines.push('✓ manifest.json 存在');
  }

  // JSON 格式（仅在 manifest 存在时有效）
  if (!hasManifestCheck) {
    if (hasJsonError) {
      const err = errors.find((e) => e.code === 'manifest_invalid_json');
      lines.push(`✗ JSON 格式错误: ${err?.message || ''}`);
    } else {
      lines.push('✓ JSON 格式正确');
    }
  }

  // manifest schema + 业务规则
  if (!hasManifestCheck && !hasJsonError) {
    if (hasManifestErrors) {
      lines.push('✗ manifest 校验失败:');
      for (const e of errors) {
        if (
          e.code !== 'entry_not_found' &&
          e.code !== 'entry_not_file' &&
          e.code !== 'package_json_invalid' &&
          e.code !== 'requirements_invalid_format' &&
          e.code !== 'requirements_read_error'
        ) {
          lines.push(`   - [${e.code}] ${e.path}: ${e.message}`);
        }
      }
    } else {
      lines.push('✓ manifest 校验通过');
    }
  }

  // 入口文件
  if (!hasManifestCheck && !hasJsonError && !hasManifestErrors) {
    if (hasEntryNotFound) {
      const err = errors.find((e) => e.code === 'entry_not_found');
      lines.push(`✗ 入口文件不存在: ${err?.message || ''}`);
    } else if (hasEntryNotFile) {
      const err = errors.find((e) => e.code === 'entry_not_file');
      lines.push(`✗ 入口不是文件: ${err?.message || ''}`);
    } else {
      lines.push('✓ 入口文件存在');
    }
  }

  // package.json（仅 nodejs）
  if (!hasManifestCheck && !hasJsonError && !hasManifestErrors) {
    if (hasPkgJsonError) {
      lines.push('✗ package.json 格式错误');
    } else if (errors.length === 0 || hasEntryNotFound || hasEntryNotFile || hasReqError) {
      // 只显示如果其他地方没有错误或仅入口/req有错
    }
  }

  // requirements.txt（仅 python）
  if (!hasManifestCheck && !hasJsonError && !hasManifestErrors) {
    if (hasReqError) {
      for (const e of errors) {
        if (e.code === 'requirements_invalid_format' || e.code === 'requirements_read_error') {
          lines.push(`✗ requirements.txt 问题: ${e.message}`);
        }
      }
    }
  }

  // 非阻塞警告（不影响退出码）
  if (warnings.length > 0) {
    lines.push('\n⚠ 警告（不影响校验通过）:');
    for (const w of warnings) {
      lines.push(`   - [${w.code}] ${w.path}: ${w.message}`);
    }
  }

  // 总结
  if (errors.length === 0 && warnings.length === 0) {
    lines.push('\n结果: ✓ 全部通过');
  } else if (errors.length === 0) {
    lines.push(`\n结果: ✓ 通过（含 ${warnings.length} 个警告）`);
  } else {
    lines.push(`\n结果: ✗ ${errors.length} 个错误`);
  }

  console.log(lines.join('\n'));
}
