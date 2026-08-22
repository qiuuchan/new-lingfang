// my-treasure 桌面端边界层。
// 零服务器架构：不连接任何后端，全部能力经 Tauri 命令与本地文件系统完成。
// 市场数据源：GitHub 仓库原始索引（marketplace.json）+ Release 产物下载。

// Tauri 命令调用（桌面环境注入 __TAURI__，需 tauri.conf.json 开 withGlobalTauri）。
export async function tauriInvoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  const inv = (window as unknown as { __TAURI__?: { core?: { invoke?: Function } } }).__TAURI__
    ?.core?.invoke;
  if (!inv) throw new Error('需在桌面环境中运行');
  return inv(cmd, args) as Promise<T>;
}

export async function tauriListen<T = unknown>(
  event: string,
  handler: (event: { payload: T }) => void
): Promise<() => void> {
  const listen = (window as unknown as { __TAURI__?: { event?: { listen?: Function } } })
    ?.__TAURI__?.event?.listen;
  if (!listen) throw new Error('需在桌面环境中运行');
  return listen(event, handler) as Promise<() => void>;
}

export interface ApiError extends Error {
  code?: string;
  status?: number;
}

// 统一错误信息提取：tauriInvoke 调 Tauri 命令时，Rust 侧 Result<_, String> 的错误以
// 「裸字符串」形式 reject，而非 Error 对象。此函数归一化任意来源错误为可读字符串。
export function errorMessage(err: unknown, fallback = ''): string {
  if (typeof err === 'string') return err.trim() || fallback;
  if (err instanceof Error) return err.message || fallback;
  if (err && typeof err === 'object') {
    const obj = err as { message?: unknown; error?: unknown };
    if (typeof obj.message === 'string' && obj.message) return obj.message;
    if (typeof obj.error === 'string' && obj.error) return obj.error;
    try {
      const json = JSON.stringify(err);
      if (json && json !== '{}') return json;
    } catch {
      /* 含循环引用等无法序列化，落到兜底 */
    }
  }
  return fallback;
}

// 仓库即市场：市场索引地址（可由用户在其配置中覆盖）。
// 默认值指向本项目开源的插件市场索引仓库。
let marketplaceIndexUrl: string = import.meta.env.VITE_MARKETPLACE_INDEX_URL as string;
let marketplaceBaseUrl: string = import.meta.env.VITE_MARKETPLACE_BASE_URL as string;

export function configureMarketplace(indexUrl: string, baseUrl?: string): void {
  marketplaceIndexUrl = indexUrl.trim();
  if (baseUrl) marketplaceBaseUrl = baseUrl.trim();
}

export function marketplaceIndex(): string {
  return marketplaceIndexUrl;
}

export function marketplaceBase(): string {
  return marketplaceBaseUrl;
}

// 拉取市场索引（GET JSON，超时 abort，口径与后端封装一致）。
export async function fetchMarketplaceIndex<T = unknown>(timeoutMs = 15_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(marketplaceIndexUrl, { signal: controller.signal });
    if (!res.ok) throw new Error(`市场索引不可用：HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError')
      throw new Error('市场索引响应超时，请检查网络后重试。');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}