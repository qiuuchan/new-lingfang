// publish 命令：上传 .lfplugin 到注册中心 POST /api/plugin-registry/releases。
// 真源：.trellis/tasks/07-13-plugin-dev-sdk/research/publish-endpoint.md
//
// 关键约束（与 design.md §2.4 一致）：
// - 非 multipart：raw binary body + Content-Type: application/octet-stream
// - 元数据通过自定义 header 传递（x-plugin-package-id / x-plugin-source-kind / x-plugin-source-label-b64 / x-client）
// - JWT 认证（Authorization: Bearer <token>）
// - BASE 和 TOKEN 优先取 opts 参数，其次取环境变量 LINGFANG_API_BASE / LINGFANG_TOKEN

import { readFile, stat, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { log } from '../log.ts';
import { pathExists } from '../util/fs.ts';
import { resolvePluginPath } from '../util/resolvePath.ts';

// ── Types ──────────────────────────────────────────────────────────────

export interface PublishOptions {
  /** 插件工作区目录 或 .lfplugin 文件路径（默认：当前目录） */
  path?: string;
  /** API 基址（默认：环境变量 LINGFANG_API_BASE） */
  base?: string;
  /** JWT 认证 token（默认：环境变量 LINGFANG_TOKEN） */
  token?: string;
  /** 发布到已有 package 的 ID（对应 header: x-plugin-package-id） */
  packageId?: string;
  /** 来源类型枚举值（对应 header: x-plugin-source-kind） */
  sourceKind?: string;
  /** 人类可读来源标签（UTF-8，≤ 80 字符解码后；自动 base64url 编码为 header: x-plugin-source-label-b64） */
  sourceLabel?: string;
  /** 客户端类型（如 "desktop"；对应 header: x-client） */
  clientKind?: string;
  /** 如果为 true 且 path 是工作区，先 build 生成 .lfplugin（默认：path 非 .lfplugin 文件时为 true） */
  build?: boolean;
  /** 传递给 build 命令的输出路径 */
  out?: string;
}

export interface PublishResult {
  ok: boolean;
  releaseId?: string;
  packageId?: string;
  version?: string;
  errors: Array<{ code: string; message: string }>;
}

// ── Helpers ────────────────────────────────────────────────────────────

function resolveToken(opts?: Pick<PublishOptions, 'token'>): string {
  if (opts?.token) return opts.token;
  const env = process.env['LINGFANG_TOKEN'];
  if (env) return env;
  throw new Error('缺少认证 token（设置 LINGFANG_TOKEN 环境变量或通过 --token 传入）');
}

function resolveBase(opts?: Pick<PublishOptions, 'base'>): string {
  if (opts?.base) return opts.base;
  const env = process.env['LINGFANG_API_BASE'];
  if (env) return env;
  throw new Error('缺少 API 地址（设置 LINGFANG_API_BASE 环境变量或通过 --base 传入）');
}

/** 判断路径是否是可构建的工作区（目录 + 包含 manifest.json）。 */
async function isWorkspace(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    if (!s.isDirectory()) return false;
    return pathExists(path.join(p, 'manifest.json'));
  } catch {
    return false;
  }
}

/**
 * base64url 编码（RFC 4648 §5，无 padding）。
 * Node.js ≥ 15.7 原生支持 `Buffer.toString('base64url')`，项目要求 Node.js ≥ 20。
 */
function base64urlEncode(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64url');
}

/**
 * 尝试 lazy-import 并执行 build 命令，返回生成的 .lfplugin 文件路径。
 *
 * 实现策略：把产物写到唯一临时目录（避免污染 cwd），文件名按 archive.ts
 * 的 suggestedFilename 规则推导（`<safeId>-<version>.lfplugin`），然后显式
 * 通过 opts.out 传给 buildCommand 以拿到确定路径。
 *
 * @param workspacePath 工作区目录（含 manifest.json）
 * @param out           可选自定义输出路径（透传给 build）
 * @returns             生成的 .lfplugin 绝对路径；失败返回 null
 */
async function runBuild(workspacePath: string, out?: string): Promise<string | null> {
  let explicitOut = out;

  // 若调用方未指定 out，则按 archive.ts 的命名规则推导并写到临时目录。
  // 这一步必须显式：buildCommand 在 opts.out 缺省时写到 process.cwd()，
  // publish 在 cwd 不确定时无法可靠回收产物路径。
  if (!explicitOut) {
    const derived = await deriveSuggestedFilename(workspacePath);
    if (!derived) return null;
    const tempDir = await mkdtemp(path.join(tmpdir(), 'lingfang-publish-'));
    explicitOut = path.join(tempDir, derived);
  }

  try {
    const { buildCommand } = await import('./build.ts');
    const code = await buildCommand([workspacePath], { out: explicitOut, json: true });
    if (code !== 0) {
      log.error('构建失败，无法继续发布');
      return null;
    }
    if (!existsSync(explicitOut)) {
      log.error(`内部错误：build 返回成功但产物未生成：${explicitOut}`);
      return null;
    }
    return explicitOut;
  } catch (e) {
    log.error(`构建失败：${(e as Error).message ?? String(e)}`);
    return null;
  }
}

/**
 * 读取工作区 manifest.json 并按 archive.ts 的 suggestedFilename 规则
 * 推导产物文件名（`<safeId>-<version>.lfplugin`）。
 * 失败返回 null。
 */
async function deriveSuggestedFilename(workspacePath: string): Promise<string | null> {
  try {
    const manifestPath = path.join(workspacePath, 'manifest.json');
    const raw = await readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as { id?: unknown; version?: unknown };
    if (typeof manifest.id !== 'string' || typeof manifest.version !== 'string') {
      log.error(`manifest.json 缺少 id 或 version 字段：${manifestPath}`);
      return null;
    }
    // 与 archive.ts packWorkspace.suggestedFilename 对齐
    const safeId = manifest.id.replace(/[^a-zA-Z0-9-_.]/g, '-');
    return `${safeId}-${manifest.version}.lfplugin`;
  } catch (e) {
    log.error(`无法读取工作区 manifest.json：${(e as Error).message}`);
    return null;
  }
}

// ── Main Command ───────────────────────────────────────────────────────

/**
 * 发布插件到注册中心。
 *
 * 调用约定（与 index.ts 调度器对齐）：
 *   publishCommand(argv, opts)  ← argv = CLI 剩余位置参数，opts = 解析后的 flags
 *
 * @param argv  位置参数（argv[0] = path，作为 opts.path 的 fallback）
 * @param opts  选项（来自 CLI --flags 或代码调用）
 * @returns     退出码（0 = 成功，1 = 失败）
 */
export async function publishCommand(argv: string[], opts?: PublishOptions): Promise<number> {
  // ── 1. 解析配置 ──────────────────────────────────────────────────
  const resolvedPath = opts?.path ?? (argv.length > 0 ? argv[0] : process.cwd());
  // LF-05 / g2-sdk-friction #2：路径归一化防二次拼接（cwd 固定为 packages/plugin-sdk 的场景）。
  const targetPath = resolvePluginPath(resolvedPath);

  let token: string;
  let base: string;
  try {
    token = resolveToken(opts);
    base = resolveBase(opts);
  } catch (e) {
    log.error((e as Error).message);
    return 1;
  }

  // 规范化 base URL：去掉尾随斜杠
  const baseUrl = base.replace(/\/+$/, '');

  // ── 2. 确定 artifact 来源 ────────────────────────────────────────
  let artifactPath: string;

  // 情况 A：路径以 .lfplugin 结尾且文件存在 → 直接使用
  if (targetPath.endsWith('.lfplugin') && (await pathExists(targetPath))) {
    artifactPath = targetPath;
    log.info(`使用已有制品：${artifactPath}`);
  }
  // 情况 B：工作区目录 → 构建（除非显式跳过）
  else if (await isWorkspace(targetPath)) {
    if (opts?.build === false) {
      log.error(
        '当前为工作区目录，未找到 .lfplugin 制品。请先运行 lingfang-plugin build，或去掉 --no-build 选项让 publish 自动构建。'
      );
      return 1;
    }

    const built = await runBuild(targetPath, opts?.out);
    if (!built) return 1;
    artifactPath = built;
  }
  // 情况 C：既不是 .lfplugin 文件也不是有效工作区
  else {
    if (await pathExists(targetPath)) {
      if ((await stat(targetPath)).isDirectory()) {
        log.error(
          `目录 "${targetPath}" 不像插件工作区（缺少 manifest.json），请确认路径是否正确。`
        );
      } else {
        log.error(`文件 "${targetPath}" 不是 .lfplugin 插件制品。`);
      }
    } else {
      log.error(`路径 "${targetPath}" 不存在。`);
    }
    return 1;
  }

  // ── 3. 读取 artifact ─────────────────────────────────────────────
  let fileBuffer: Buffer;
  try {
    fileBuffer = await readFile(artifactPath);
    if (fileBuffer.length === 0) {
      log.error('制品文件为空，无法发布。');
      return 1;
    }
  } catch (e) {
    log.error(`无法读取制品文件：${(e as Error).message}`);
    return 1;
  }

  // ── 4. 构建请求 ──────────────────────────────────────────────────
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/octet-stream',
  };

  if (opts?.packageId) {
    headers['x-plugin-package-id'] = opts.packageId;
  }
  if (opts?.sourceKind) {
    headers['x-plugin-source-kind'] = opts.sourceKind;
  }
  if (opts?.sourceLabel) {
    headers['x-plugin-source-label-b64'] = base64urlEncode(opts.sourceLabel);
  }
  if (opts?.clientKind) {
    headers['x-client'] = opts.clientKind;
  }

  const url = `${baseUrl}/api/plugin-registry/releases`;

  // ── 5. 发送请求（raw binary body）────────────────────────────────
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      // Buffer 在 Node.js 20+ 是 Uint8Array 子类，运行时 fetch 接受它；
      // 但 @types/node 的 BodyInit 联合类型不接受 ArrayBufferLike 泛型参数。
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: fileBuffer as any,
    });
  } catch (e) {
    const err = e as Error;
    log.error(`网络请求失败：${err.message ?? String(err)}`);
    log.info(`请确认 API 地址可访问：${baseUrl}`);
    log.info(`提示：如果使用 localhost，桌面壳需要允许 localhost 网络访问。`);
    return 1;
  }

  // ── 6. 处理响应 ──────────────────────────────────────────────────
  if (response.ok) {
    // 201 Created — 成功
    let body: Record<string, unknown> | undefined;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      log.error('服务器返回了无法识别的响应格式。');
      return 1;
    }

    const pkg = body?.['package'] as Record<string, unknown> | undefined;
    const release = body?.['release'] as Record<string, unknown> | undefined;

    log.success('发布成功');
    if (pkg?.['id']) {
      log.raw(`  包 ID：${String(pkg['id'])}`);
    }
    if (release?.['id']) {
      log.raw(`  版本 ID：${String(release['id'])}`);
    }
    if (release?.['version']) {
      log.raw(`  版本号：${String(release['version'])}`);
    }

    return 0;
  }

  // 非 2xx —— 打印错误
  let errorMsg = `发布失败（HTTP ${response.status}）`;
  try {
    const errorBody = (await response.json()) as Record<string, unknown>;
    if (errorBody?.['message'] && typeof errorBody['message'] === 'string') {
      errorMsg = errorBody['message'];
    }
  } catch {
    // JSON 解析失败 → 使用默认错误消息
  }

  log.error(errorMsg);

  // 针对常见错误码给出额外提示（从 research/publish-endpoint.md 第 167-182 行）
  if (response.status === 401) {
    log.info('提示：token 可能已过期，请重新登录获取新 token。');
  } else if (response.status === 403) {
    log.info(
      '提示：当前团队没有上传插件的权限（需要 team.plugin.upload 或 team.plugin.edit_draft 权限）。'
    );
  } else if (response.status === 413) {
    log.info('提示：插件制品过大（上限 300 MiB）。');
  } else if (response.status === 409) {
    log.info('提示：版本冲突——该版本号已存在，或包已归档。');
  }

  return 1;
}
