// @lingfang/plugin-sdk：插件作者用的类型化能力客户端（见 docs/02 §B-5）。
// 插件不直连网络、不持 LLM key——所有越权操作经宿主注入的桥 __lingfangInvoke，
// 由壳的 capability 网关三重校验后执行。

import {
  ArtifactRefV1,
  type ArtifactRefV1 as ArtifactRefV1Type,
  type CapabilityKind,
} from '@lingfang/contract';

export {
  SharedRecoveryError,
  applySharedChange,
  compareSharedDecimal,
  inspectSharedCursor,
  isSharedCursorExpired,
  mergeSharedValue,
  recoverSharedReplicaAfterCursorExpiry,
  type SharedCursorDisposition,
  type SharedReplica,
} from './shared-recovery';

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
type ChatInput = { messages: ChatMessage[]; model?: 'fast' | 'premium'; timeoutMs?: number };
type ImageGenerateInput = {
  prompt: string;
  model?: 'fast' | 'premium';
  size?: string;
  n?: number;
  timeoutMs?: number;
};
type ImageGenerateResult = { images: string[] };
type ImageEditImage = { filename: string; mimeType: string; data: string };
type ImageEditInput = {
  prompt: string;
  images: ImageEditImage[];
  model?: 'fast' | 'premium';
  size?: string;
  n?: number;
  timeoutMs?: number;
};
type ImageEditResult = { images: string[] };
// 视频生成（RBFLow 动作迁移）：image + video base64 + seconds（参考视频时长，按秒计费）+ tier。
// data 为 base64 无前缀；image_filename/video_filename 可选（给上游 RBFLow 工作流节点用）。
// 返回 { task_id, call_log_id }：task_id 供 stream/download 代理路由用。
type VideoGenerateInput = {
  image: string;
  video: string;
  seconds: number;
  model?: 'fast' | 'premium';
  image_filename?: string;
  video_filename?: string;
  image_mime_type?: string;
  video_mime_type?: string;
  callback_url?: string;
  timeoutMs?: number;
};
type VideoGenerateResult = {
  task_id: string;
  call_log_id: string;
  charged: boolean;
  credits: number;
};
type PluginFile = { path: string; content: string };
type PluginUploadInput = { manifest: unknown; files: PluginFile[]; priceCents?: number };
type PluginSubmitMarketplaceInput = { pluginId: string; priceCents?: number };
type ActionCallOptions = { idempotencyKey?: string; signal?: AbortSignal };
type ArtifactCreateInput = { dataBase64: string; mediaType: string };
type ArtifactMaterialized = {
  dataBase64: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
};
type SharedRevision = string;
type SharedValue<T = unknown> = {
  key: string;
  value: T;
  schema_version: number;
  revision: SharedRevision;
};
type SharedSetInput<T = unknown> = {
  namespace: string;
  key: string;
  value: T;
  schema_version: number;
};
type SharedCompareAndSetInput<T = unknown> = SharedSetInput<T> & {
  expected_revision: SharedRevision;
};
type SharedListInput = {
  namespace: string;
  page_cursor?: string;
  limit?: number;
  relist_token?: string;
};
type SharedListResult<T = unknown> = {
  values: SharedValue<T>[];
  next_page_cursor: string | null;
  snapshot_cursor: SharedRevision;
  relist_token: string;
};

export type PluginAiErrorInit = {
  code?: string;
  status?: number;
  requestId?: string;
  cause?: unknown;
};

// LF-05 / g2-sdk-friction #1：AI 桥错误的稳定错误码常量。
// 与宿主侧 plugins-runtime.ts 的归一化语义对齐（relay_not_configured / relay_error），
// 插件按 code 判断即可，不再依赖 message 字符串前缀。
export const PluginAiErrorCode = {
  RelayNotConfigured: 'relay_not_configured',
  RelayError: 'relay_error',
  RequestTimeout: 'request_timeout',
  BridgeUnavailable: 'bridge_unavailable',
  UnsupportedModel: 'unsupported_model',
  PluginAiError: 'plugin_ai_error',
} as const;

export type PluginAiErrorCodeValue =
  (typeof PluginAiErrorCode)[keyof typeof PluginAiErrorCode];

export class PluginAiError extends Error {
  readonly code?: string;
  readonly status?: number;
  readonly requestId?: string;

  constructor(message: string, init: PluginAiErrorInit = {}) {
    super(message, { cause: init.cause });
    this.name = 'PluginAiError';
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId;
  }
}

export type PluginActionErrorInit = {
  code?: string;
  status?: number;
  requestId?: string;
  cause?: unknown;
};

/** Stable action failure surfaced by sdk.actions.call. */
export class PluginActionError extends Error {
  readonly code?: string;
  readonly status?: number;
  readonly requestId?: string;

  constructor(message: string, init: PluginActionErrorInit = {}) {
    super(message, { cause: init.cause });
    this.name = 'PluginActionError';
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId;
  }
}

// SDK-04 修复：桥层调用默认 30s 超时，避免宿主不回复（容器卸载、后端 hang 等）时插件 await 永久挂起。
// 超时后 reject 友好错误。宿主若已自带超时（如桌面 plugins-runtime.ts 的 30s）则两者取先到者。
const DEFAULT_BRIDGE_TIMEOUT_MS = 30_000;
const AI_BRIDGE_TIMEOUT_MS = 180_000;
// Published actions may declare a timeout up to 24 hours. The authoritative
// deadline still lives in the host invocation; this timer only prevents a
// missing/obsolete host bridge from leaving the plugin promise pending forever.
const ACTION_BRIDGE_TIMEOUT_MS = 24 * 60 * 60 * 1000 + 30_000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function pluginAiError(
  error: unknown,
  fallback: PluginAiErrorInit & { message?: string } = {}
): PluginAiError {
  if (error instanceof PluginAiError) return error;
  const source = record(error);
  const nested = record(source.error);
  // 裸字符串拒绝（宿主 Result<_, String> 的常见 reject 形态，如 client_ai_proxy.rs 的
  // `relay_not_configured:` / `relay_error:` 前缀）也要能提取出 message 参与前缀归一。
  const rawString =
    typeof error === 'string' && error.trim().length > 0 ? error.trim() : undefined;
  const message =
    nonEmptyString(nested.message) ??
    nonEmptyString(source.message) ??
    (error instanceof Error ? nonEmptyString(error.message) : undefined) ??
    rawString ??
    fallback.message ??
    '平台 AI 调用失败';
  // LF-05 / g2-sdk-friction #1：宿主 Rust 侧以裸前缀字符串返回（relay_not_configured: /
  // relay_error:），npm SDK 形态（nodejs/python 插件与单测）此前只把它透传为 message，
  // code 落成泛化的 plugin_ai_error → 与 client iframe 形态不一致。这里按前缀补归一化，
  // 使三种运行形态下「relay 未配置 / relay 错误」都拿到稳定 code（语义对齐 pluginActionError
  // 对 bridge 前缀的既有处理）。relay_not_configured 先于 relay_error 匹配（更具体）。
  const relayUnconfigured = message.includes('relay_not_configured');
  const relayFailure = !relayUnconfigured && message.includes('relay_error');
  const statusValue = nested.status ?? source.status ?? fallback.status;
  return new PluginAiError(message, {
    code:
      nonEmptyString(nested.code) ??
      nonEmptyString(source.code) ??
      (nonEmptyString(source.message) ? nonEmptyString(source.error) : undefined) ??
      (relayUnconfigured
        ? PluginAiErrorCode.RelayNotConfigured
        : relayFailure
          ? PluginAiErrorCode.RelayError
          : undefined) ??
      fallback.code,
    status:
      typeof statusValue === 'number'
        ? statusValue
        : relayUnconfigured
          ? 503
          : relayFailure
            ? 502
            : undefined,
    requestId:
      nonEmptyString(nested.requestId) ?? nonEmptyString(source.requestId) ?? fallback.requestId,
    cause: error,
  });
}

function pluginActionError(
  error: unknown,
  fallback: PluginActionErrorInit & { message?: string } = {}
): PluginActionError {
  if (error instanceof PluginActionError) return error;
  const source = record(error);
  const nested = record(source.error);
  const rawMessage =
    nonEmptyString(nested.message) ??
    nonEmptyString(source.message) ??
    (error instanceof Error ? nonEmptyString(error.message) : undefined);
  const bridgeUnavailable = rawMessage?.startsWith('capability bridge 未注入:') === true;
  const bridgeTimedOut = rawMessage?.startsWith('capability 调用超时:') === true;
  const statusValue = nested.status ?? source.status ?? fallback.status;
  return new PluginActionError(rawMessage ?? fallback.message ?? '插件 Action 调用失败', {
    code:
      nonEmptyString(nested.code) ??
      nonEmptyString(source.code) ??
      (bridgeUnavailable ? 'action_runtime_unavailable' : undefined) ??
      (bridgeTimedOut ? 'action_timeout' : undefined) ??
      fallback.code,
    status: typeof statusValue === 'number' ? statusValue : undefined,
    requestId:
      nonEmptyString(nested.requestId) ?? nonEmptyString(source.requestId) ?? fallback.requestId,
    cause: error,
  });
}

function platformModel(value: unknown): 'fast' | 'premium' {
  if (value === undefined) return 'fast';
  if (value === 'fast' || value === 'premium') return value;
  throw new PluginAiError('仅支持平台模型档位 fast 或 premium', {
    code: 'unsupported_model',
    status: 400,
  });
}

function localhostBridgeBase(value: string): string {
  try {
    const url = new URL(value);
    const loopback =
      url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    if (
      url.protocol !== 'http:' ||
      !loopback ||
      url.username ||
      url.password ||
      (url.pathname !== '/' && url.pathname !== '')
    ) {
      throw new Error('invalid bridge URL');
    }
    return url.toString().replace(/\/$/, '');
  } catch (cause) {
    throw new PluginAiError('宿主注入的本地桥地址无效', {
      code: 'bridge_invalid',
      status: 503,
      cause,
    });
  }
}

// SDK-05 修复：net.fetch 的 init 可能含 AbortSignal / 函数等不可结构化克隆字段，
// postMessage 会抛 DataCloneError。这里白名单过滤为可序列化字段。
type SerializableFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  mode?: string;
  credentials?: string;
};

function sanitizeFetchInit(init: unknown): SerializableFetchInit {
  if (!init || typeof init !== 'object') return {};
  const raw = init as Record<string, unknown>;
  const out: SerializableFetchInit = {};
  if (typeof raw.method === 'string') out.method = raw.method;
  if (raw.headers && typeof raw.headers === 'object') {
    // 仅保留字符串值的 headers（键值对），丢弃非字符串。
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.headers as Record<string, unknown>)) {
      if (typeof v === 'string') headers[k] = v;
    }
    out.headers = headers;
  }
  if (typeof raw.body === 'string') out.body = raw.body;
  if (typeof raw.mode === 'string') out.mode = raw.mode;
  if (typeof raw.credentials === 'string') out.credentials = raw.credentials;
  return out;
}

// SDK-05 修复：storage.set / ui.render 等入参若不可序列化，应给出业务友好错误而非裸 DataCloneError。
// 此函数用于抛出可读错误；实际序列化失败由 postMessage 路径兜底，但提前预检能给更清晰的码。
function assertSerializable(value: unknown, label: string): void {
  try {
    // 用 JSON.stringify 探测是否可序列化（注意：JSON.stringify 对函数/undefined 会丢弃而非抛错，
    // 但对循环引用会抛 TypeError）。这里主要防循环引用；函数字段已在 sanitize 阶段过滤。
    JSON.stringify(value);
  } catch (e) {
    throw new Error(
      `${label} 包含不可序列化的值（如循环引用），无法传递给宿主：${(e as Error).message}`
    );
  }
}

type ScriptBridgeEnv = {
  process?: { env?: Record<string, string | undefined> };
  fetch?: typeof fetch;
};

// 脚本桥路由表：capability → localhost 桥路径（LINGFANG_PLUGIN_BRIDGE_URL 是基础 endpoint，不含路径后缀）。
// Rust 端 plugin_llm_bridge.rs 的 route_request 据此分发：/llm/chat、/image/generate。
const SCRIPT_BRIDGE_PATH: Record<string, string> = {
  'llm.chat': '/llm/chat',
  'image.generate': '/image/generate',
  'image.edit': '/image/edit',
  'video.generate': '/video/generate',
  'actions.call': '/actions/call',
  'artifacts.create': '/artifacts/create',
  'artifacts.materialize': '/artifacts/materialize',
  'artifacts.import': '/artifacts/import',
};

// Node.js / Python 脚本插件的本地桥回退：window.__lingfangInvoke 不存在时（脚本无 DOM）走 localhost HTTP 桥。
// 桥用当前进程会话 token 鉴权，宿主转发到平台 relay（真正计费在 relay 侧扣当前团队灵石）。
// 支持能力：llm.chat（返回 {content:string}）、image.generate（返回 {images:string[]}）。
async function invokeScriptBridge<T>(capability: string, args: unknown): Promise<T | null> {
  const path = SCRIPT_BRIDGE_PATH[capability];
  if (!path) return null;
  const g = globalThis as unknown as ScriptBridgeEnv;
  const baseValue = g.process?.env?.LINGFANG_PLUGIN_BRIDGE_URL;
  const token = g.process?.env?.LINGFANG_PLUGIN_BRIDGE_TOKEN;
  if (!baseValue || !token || typeof g.fetch !== 'function') return null;
  const base = localhostBridgeBase(baseValue);
  const input = record(args);
  const body =
    capability === 'llm.chat' ||
    capability === 'image.generate' ||
    capability === 'image.edit' ||
    capability === 'video.generate'
      ? { ...input, model: platformModel(input.model) }
      : input;
  const res = await g.fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-LingFang-Plugin-Token': token,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const fallback = {
      status: res.status,
      requestId: res.headers.get('x-request-id') ?? undefined,
      message: `平台调用失败：HTTP ${res.status}`,
    };
    if (capability.startsWith('actions.') || capability.startsWith('artifacts.'))
      throw pluginActionError(data, fallback);
    throw pluginAiError(data, fallback);
  }
  if (capability === 'llm.chat') {
    return (typeof data.content === 'string' ? data.content : '') as T;
  }
  if (capability.startsWith('actions.') || capability.startsWith('artifacts.')) return data as T;
  // video.generate：桥透传 { task_id, call_log_id, charged, credits }，直接回传。
  if (capability === 'video.generate') return data as T;
  // image.generate / image.edit：返回 { images: string[] }
  return { images: Array.isArray(data.images) ? (data.images as string[]) : [] } as T;
}

// 桥调用默认超时（与桌面 plugins-runtime.ts 的 RUNTIME_BRIDGE_TIMEOUT_MS 对齐）。
// 宿主可能未注入带超时的桥（旧版或未升级的容器），SDK 自身加一层超时兜底。
async function invoke<T>(
  capability: CapabilityKind | string,
  args: unknown = {},
  timeoutMs = DEFAULT_BRIDGE_TIMEOUT_MS
): Promise<T> {
  const bridge = (
    globalThis as unknown as { __lingfangInvoke?: (c: string, a: unknown) => Promise<unknown> }
  ).__lingfangInvoke;
  const operation =
    typeof bridge === 'function'
      ? (bridge(capability, args) as Promise<T>)
      : (async () => {
          const scriptResult = await invokeScriptBridge<T>(capability, args);
          if (scriptResult !== null) return scriptResult;
          throw new Error(`capability bridge 未注入: ${capability}`);
        })();
  // SDK-04：用 Promise.race 加超时兜底，避免桥返回的 Promise 永不 settle。
  if (timeoutMs <= 0) return operation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`capability 调用超时: ${capability}`)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function invokeAi<T>(
  capability: 'llm.chat' | 'image.generate' | 'image.edit' | 'video.generate',
  input: Record<string, unknown>
): Promise<T> {
  const args = { ...input, model: platformModel(input.model) };
  // timeoutMs 是 SDK 层仅有的超时控制，不应透传给宿主桥（宿主另有自身计时）。
  delete (args as Record<string, unknown>).timeoutMs;
  // 调用级超时覆盖：clamp 到 [1000, 180_000]，超出边界则收敛而非报错。
  // SDK 与宿主各有一层超时计时，取先到者；调用级仅能缩短或保持默认上限，不能突破 180s。
  const AI_TIMEOUT_MIN_MS = 1_000;
  const AI_TIMEOUT_MAX_MS = 180_000;
  let timeoutMs = AI_BRIDGE_TIMEOUT_MS;
  if (typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)) {
    timeoutMs = Math.min(AI_TIMEOUT_MAX_MS, Math.max(AI_TIMEOUT_MIN_MS, Math.trunc(input.timeoutMs)));
  }
  try {
    return await invoke<T>(capability, args, timeoutMs);
  } catch (error) {
    const timedOut = error instanceof Error && error.message.startsWith('capability 调用超时:');
    const bridgeUnavailable =
      error instanceof Error && error.message.startsWith('capability bridge 未注入:');
    throw pluginAiError(
      error,
      timedOut
        ? {
            code: PluginAiErrorCode.RequestTimeout,
            status: 408,
            message: `平台 AI 调用超时: ${capability}`,
          }
        : bridgeUnavailable
          ? { code: PluginAiErrorCode.BridgeUnavailable, status: 503 }
          : { code: PluginAiErrorCode.PluginAiError }
    );
  }
}

async function invokeAction<TOutput>(
  dependencyId: string,
  input: Record<string, unknown>,
  options: ActionCallOptions = {}
): Promise<TOutput> {
  const dependency = dependencyId.trim();
  if (!dependency)
    throw new PluginActionError('dependencyId 不能为空', {
      code: 'action_dependency_denied',
      status: 400,
    });
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PluginActionError('Action input 必须是 JSON 对象', {
      code: 'action_input_invalid',
      status: 400,
    });
  }
  if (
    options.idempotencyKey !== undefined &&
    (!options.idempotencyKey.trim() || options.idempotencyKey.length > 256)
  ) {
    throw new PluginActionError('idempotencyKey 必须是 1 到 256 个字符', {
      code: 'action_idempotency_conflict',
      status: 400,
    });
  }
  assertSerializable(input, 'actions.call input');
  if (options.signal?.aborted)
    throw new PluginActionError('Action 调用已取消', { code: 'action_cancelled' });

  const operation = invoke<TOutput>(
    'actions.call',
    {
      dependency_id: dependency,
      input,
      ...(options.idempotencyKey === undefined ? {} : { idempotency_key: options.idempotencyKey }),
    },
    ACTION_BRIDGE_TIMEOUT_MS
  );
  let abortHandler: (() => void) | undefined;
  const abort =
    options.signal &&
    new Promise<never>((_, reject) => {
      abortHandler = () =>
        reject(new PluginActionError('Action 调用已取消', { code: 'action_cancelled' }));
      options.signal?.addEventListener('abort', abortHandler, { once: true });
    });
  try {
    return await (abort ? Promise.race([operation, abort]) : operation);
  } catch (error) {
    throw pluginActionError(error, { code: 'action_execution_failed' });
  } finally {
    if (abortHandler) options.signal?.removeEventListener('abort', abortHandler);
  }
}

function artifactRef(value: unknown): ArtifactRefV1Type {
  const parsed = ArtifactRefV1.safeParse(value);
  if (!parsed.success)
    throw new PluginActionError('ArtifactRef 无效', {
      code: 'action_artifact_invalid',
      status: 400,
    });
  return parsed.data;
}

function artifactCreateInput(input: ArtifactCreateInput): {
  data_base64: string;
  media_type: string;
} {
  const mediaType = input?.mediaType?.trim();
  if (!mediaType || mediaType.length > 256 || /[\u0000-\u001f\u007f]/.test(mediaType)) {
    throw new PluginActionError('mediaType 无效', { code: 'action_artifact_invalid', status: 400 });
  }
  const dataBase64 = input?.dataBase64?.trim();
  if (
    !dataBase64 ||
    dataBase64.length > 400 * 1024 * 1024 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64)
  ) {
    throw new PluginActionError('dataBase64 必须是有效且受限的 base64', {
      code: 'action_artifact_invalid',
      status: 400,
    });
  }
  return { data_base64: dataBase64, media_type: mediaType };
}

// SDK-08 修复：sdk 不再导出原始 invoke 入口，避免插件作者绕过类型化分组直接传任意字符串 kind。
// 8 组类型化 API 已覆盖 CapabilityKind 全部 kind；如确需调用未封装的 kind，应通过 capability 网关
// 显式声明并扩展 sdk.xxx 组。注释而非删除：保留此说明以提醒未来维护者不要把 invoke 重新挂回 sdk。
export const sdk = {
  actions: {
    /** Call only a dependency alias declared by the current plugin manifest. */
    call: <TOutput = Record<string, unknown>>(
      dependencyId: string,
      input: Record<string, unknown>,
      options?: ActionCallOptions
    ) => invokeAction<TOutput>(dependencyId, input, options),
  },
  artifacts: {
    /** Create an invocation-scoped artifact from bytes; storage keys stay host-owned. */
    create: (input: ArtifactCreateInput) =>
      invoke<ArtifactRefV1Type>(
        'artifacts.create',
        artifactCreateInput(input),
        ACTION_BRIDGE_TIMEOUT_MS
      ),
    /** Materialize only an ArtifactRef granted to the current invocation. */
    materialize: (ref: ArtifactRefV1Type) =>
      invoke<ArtifactMaterialized>(
        'artifacts.materialize',
        { artifact_ref: artifactRef(ref) },
        ACTION_BRIDGE_TIMEOUT_MS
      ),
    /** Import a preview ArtifactRef through the host's explicit trust boundary. */
    import: (ref: ArtifactRefV1Type) =>
      invoke<ArtifactRefV1Type>(
        'artifacts.import',
        { artifact_ref: artifactRef(ref) },
        ACTION_BRIDGE_TIMEOUT_MS
      ),
  },
  fs: {
    pick: (opts?: { accept?: string[] }) => invoke<string[]>('fs.pick', opts ?? {}),
    // SDK-01 修复：fs.read 实际返回 {content}（文件）/ {entries}（目录）对象，而非裸字符串。
    // 原契约 Promise<string> 与 Rust capability.rs 返回结构不一致，按契约编写的插件会拿到 [object Object]。
    read: (path: string) =>
      invoke<{ content: string } | { entries: string[] }>('fs.read', { path }),
    write: (path: string, content: string) => invoke<void>('fs.write', { path, content }),
  },
  net: {
    // SDK-05 修复：init 白名单过滤为可序列化字段，丢弃 AbortSignal/函数等。
    fetch: (url: string, init?: unknown) =>
      invoke<unknown>('net.fetch', { url, init: sanitizeFetchInit(init) }),
  },
  clipboard: {
    readText: () => invoke<string>('clipboard', { op: 'read' }),
    writeText: (text: string) => invoke<void>('clipboard', { op: 'write', text }),
  },
  storage: {
    get: (key: string) => invoke<unknown>('storage.kv', { op: 'get', key }),
    // SDK-05 修复：预检 value 可序列化（主要防循环引用），给业务友好错误而非 DataCloneError。
    set: (key: string, value: unknown) => {
      assertSerializable(value, 'storage.set value');
      return invoke<void>('storage.kv', { op: 'set', key, value });
    },
    // LF-07：管理 API。list 仅回传键名（值可达 256KB 不回传）；delete 不存在返回 {deleted:false}；
    // count 返回条目数。三者均走 storage.kv 网关，受 capability 与 30s 超时约束。
    list: (prefix?: string) =>
      invoke<{ keys: string[] }>('storage.kv', {
        op: 'list',
        ...(prefix !== undefined ? { prefix } : {}),
      }).then((r) => r.keys),
    delete: (key: string) =>
      invoke<{ deleted: boolean }>('storage.kv', { op: 'delete', key }),
    count: () => invoke<{ count: number }>('storage.kv', { op: 'count' }).then((r) => r.count),
  },
  shared: {
    get: <T = unknown>(namespace: string, key: string) =>
      invoke<SharedValue<T> | null>('shared.get', { namespace, key }),
    set: <T = unknown>(input: SharedSetInput<T>) => {
      assertSerializable(input.value, 'shared.set value');
      return invoke<SharedValue<T>>('shared.set', input);
    },
    compareAndSet: <T = unknown>(input: SharedCompareAndSetInput<T>) => {
      assertSerializable(input.value, 'shared.compareAndSet value');
      return invoke<SharedValue<T>>('shared.compare_and_set', input);
    },
    delete: (namespace: string, key: string, expected_revision: SharedRevision) =>
      invoke<{ revision: SharedRevision }>('shared.delete', { namespace, key, expected_revision }),
    list: <T = unknown>(input: SharedListInput) =>
      invoke<SharedListResult<T>>('shared.list', input),
  },
  system: {
    // SDK-08 修复：补齐 system.info 分组，原 invoke 泄漏（可 sdk.invoke('system.info')）现收敛为正式方法。
    info: () => invoke<unknown>('system.info', {}),
    screenshot: () => invoke<string>('system.screenshot', {}),
    notify: (title: string, body?: string) => invoke<void>('system.notify', { title, body }),
  },
  // 不含 apiKey / apiUrl / baseUrl / provider：实际路由由平台 relay + 团队渠道配置决定。
  // model 仅是平台模型标识（fast / premium），不是上游地址或密钥配置。
  llm: {
    chat: (input: ChatInput) => invokeAi<string>('llm.chat', input),
  },
  // 计费/中转：生图走平台 relay（/api/relay/v1/images/generations），按张计费，按团队灵石结算。
  // 输入 prompt 必填；model 默认 fast；返回 { images: string[] }（url 或 data:base64）。
  // 系统提示词已由平台强制注入：必须且仅能使用灵坊平台服务（需求 #3）。
  image: {
    generate: (input: ImageGenerateInput) => invokeAi<ImageGenerateResult>('image.generate', input),
    // 计费/中转：图片编辑（带参考图）走平台 relay（/api/relay/v1/images/edits），multipart 透传，按张计费。
    // 输入 prompt + images（参考图，data 为 base64 无前缀）；model 默认 fast；返回 { images: string[] }（url 或 data:base64）。
    edit: (input: ImageEditInput) => invokeAi<ImageEditResult>('image.edit', input),
  },
  // 视频生成（RBFLow 动作迁移）：image + video base64 + seconds → 桥先按秒扣灵石（PER_SECOND）→
  // 注入平台 RBFLow 凭证转发 → 返回 { task_id, call_log_id }。
  // 防绕过：插件不持有任何 RBFLow 凭证；stream/download 进度与下载走桥 GET /video/stream、/video/download
  // （非 capability，插件自行拼路径调桥，不经此 SDK namespace）。
  video: {
    generate: (input: VideoGenerateInput) => invokeAi<VideoGenerateResult>('video.generate', input),
  },
  plugin: {
    upload: (input: PluginUploadInput) => invoke<unknown>('plugin.upload', input),
    submitMarketplace: (input: PluginSubmitMarketplaceInput) =>
      invoke<unknown>('plugin.submitMarketplace', input),
  },
  ui: {
    // SDK-05 修复：content 预检可序列化（防 DOM 节点 / 循环引用）。
    render: (content: unknown) => {
      assertSerializable(content, 'ui.render content');
      return invoke<void>('ui.view', { content });
    },
  },
};

export type {
  ChatMessage,
  ChatInput,
  ImageGenerateInput,
  ImageGenerateResult,
  ImageEditImage,
  ImageEditInput,
  ImageEditResult,
  VideoGenerateInput,
  VideoGenerateResult,
  PluginFile,
  PluginUploadInput,
  PluginSubmitMarketplaceInput,
  ActionCallOptions,
  ArtifactCreateInput,
  ArtifactMaterialized,
  SharedRevision,
  SharedValue,
  SharedSetInput,
  SharedCompareAndSetInput,
  SharedListInput,
  SharedListResult,
};
