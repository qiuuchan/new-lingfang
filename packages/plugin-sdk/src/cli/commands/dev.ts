// dev 命令：把插件目录注册为 dev 安装（免打包直读，v1 仅 client 运行时）。
// 校验 manifest + 目录结构后，向宿主注册目录；无 Tauri 运行时时 best-effort 提示。
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { validateManifest, type ManifestResult } from '../../manifest/index.ts';
import type { PluginManifest } from '@lingfang/contract';
import { log } from '../log.ts';
import { resolvePluginPath } from '../util/resolvePath.ts';

export interface DevOptions {
  path?: string;
  json?: boolean;
}

export interface DevResult {
  ok: boolean;
  installationId?: string;
  origin: string;
  dir: string;
  errors: string[];
}

/**
 * dev 命令：校验插件目录并注册为 dev 安装。
 *
 * @param argv  CLI 位置参数（第一个作为 path，可被 opts.path 覆盖）
 * @param opts  选项：path 指定插件目录（默认 process.cwd()），json=true 输出 JSON
 * @returns     退出码：0 成功，1 失败
 */
export async function devCommand(argv: string[], opts?: DevOptions): Promise<number> {
  // 1. 解析目录（绝对路径；LF-05 / g2-sdk-friction #2 路径归一化防二次拼接）
  const dir = resolvePluginPath(opts?.path ?? argv[0] ?? process.cwd());
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return printError('dir_not_found', `目录不存在或不是目录: ${dir}`, opts?.json ?? false, dir);
  }

  // 2. 读取 manifest.json
  const manifestPath = path.join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return printError(
      'manifest_not_found',
      `manifest.json 不存在，期望路径: ${manifestPath}`,
      opts?.json ?? false,
      dir
    );
  }

  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf-8');
  } catch (e) {
    return printError(
      'manifest_read_error',
      `无法读取 manifest.json: ${(e as Error).message}`,
      opts?.json ?? false,
      dir
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return printError(
      'manifest_invalid_json',
      `manifest.json 不是合法的 JSON: ${(e as SyntaxError).message}`,
      opts?.json ?? false,
      dir
    );
  }

  // 3. manifest 校验（Schema + 业务规则）
  const result: ManifestResult = validateManifest(parsed);
  if (!result.success) {
    const lines = result.errors.map((e) => `  [${e.code}] ${e.path}: ${e.message}`);
    return printError(
      'manifest_validation_failed',
      `manifest 校验失败:\n${lines.join('\n')}`,
      opts?.json ?? false,
      dir
    );
  }
  const manifest: PluginManifest = result.manifest;

  // 4. v1 仅支持 client 运行时（F2 政策 / LF-02）
  const runtimeType = manifest.runtime_type ?? 'client';
  if (runtimeType !== 'client') {
    return printError(
      'runtime_not_supported',
      `v1 dev 安装仅支持 client 运行时（F2 政策 / LF-02）。当前 runtime_type="${runtimeType}"。` +
        ` nodejs/python 进程插件在 v1 下仅限内置或一方签名插件。`,
      opts?.json ?? false,
      dir
    );
  }

  // 5. 入口文件存在性
  const entryPath = path.join(dir, manifest.entry);
  if (!existsSync(entryPath)) {
    return printError(
      'entry_not_found',
      `入口文件不存在: ${manifest.entry}（完整路径: ${entryPath}）`,
      opts?.json ?? false,
      dir
    );
  }

  // 6. 向宿主注册（best-effort，无 Tauri 时仅提示）
  let installationId: string | undefined;
  try {
    const reg = await registerDevDir(dir, manifest.id);
    installationId = reg.installationId;
  } catch (e) {
    return printError(
      'register_failed',
      `dev 注册失败: ${(e as Error).message}`,
      opts?.json ?? false,
      dir
    );
  }

  // 7. 输出结果
  const json = opts?.json ?? false;
  if (json) {
    const out: DevResult = {
      ok: true,
      installationId,
      origin: 'dev',
      dir,
      errors: [],
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    log.success(`dev 安装已注册：${dir} (origin=dev)`);
    if (installationId) {
      log.raw(`  安装 ID：${installationId}`);
    } else {
      log.raw('  注意：当前环境无桌面宿主，dev 目录已就绪，请在宿主中打开插件以监听变更。');
    }
  }

  return 0;
}

// ── 宿主注册（可插拔，best-effort） ──────────────────────────────────

/**
 * 向宿主注册 dev 目录。
 *
 * - 若运行在桌面壳内（存在 window.__TAURI__），调用 `register_dev_dir` 命令；
 * - 否则视为 CLI 独立运行（无 Tauri），不抛错，仅返回一个未定义 installationId
 *   （由调用方提示用户回到宿主中打开插件）。
 *
 * 亦支持通过全局钩子 `__LINGFANG_DEV_REGISTER__` 注入自定义注册实现（测试 / 集成用）。
 */
export async function registerDevDir(
  dir: string,
  packageId?: string
): Promise<{ installationId: string }> {
  const g = globalThis as unknown as {
    __LINGFANG_DEV_REGISTER__?: (input: { dir: string; packageId?: string }) => Promise<{
      installationId: string;
    }>;
    window?: { __TAURI__?: { core?: { invoke?: Function } } };
  };

  if (typeof g.__LINGFANG_DEV_REGISTER__ === 'function') {
    return g.__LINGFANG_DEV_REGISTER__({ dir, packageId });
  }

  const tauriCore = g.window?.__TAURI__?.core;
  if (tauriCore?.invoke) {
    const res = (await tauriCore.invoke('register_dev_dir', {
      dir,
      packageId,
    })) as { installationId: string } | { installation_id: string } | string;
    if (typeof res === 'string') return { installationId: res };
    const obj = res as { installationId?: string; installation_id?: string };
    const id = obj.installationId ?? obj.installation_id;
    if (!id) throw new Error('宿主未返回 installationId');
    return { installationId: id };
  }

  // 无 Tauri 运行时：仅返回空 installationId，由调用方决定提示文案（避免污染 JSON 输出）。
  return { installationId: '' };
}

// ── 错误输出 ──────────────────────────────────────────────────────────

function printError(code: string, message: string, json: boolean, dir: string): number {
  if (json) {
    const out: DevResult = {
      ok: false,
      origin: 'dev',
      dir,
      errors: [`${code}: ${message}`],
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    log.error(`${code}: ${message}`);
  }
  return 1;
}
