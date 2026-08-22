// pluginRunnerHost.ts — 纯函数版 client-iframe 宿主消息处理器（A2 覆盖）。
//
// 从 PluginRunner.tsx 的 useEffect 抽出，便于在无 jsdom 的 node 环境下单测。
// 保留与 React 组件中完全一致的安全守卫与派发逻辑。
import { invokeRuntime } from '@/lib/plugins-runtime';

export function handleClientHostMessage(
  event: { source?: unknown; origin?: unknown; data?: unknown },
  opts: {
    frame: { contentWindow: unknown | null };
    pluginId: string;
    invokeRuntime: (pluginId: string, kind: string, args: unknown) => Promise<unknown>;
    postReply: (reply: {
      __lf_host_reply: true;
      requestId: string;
      result?: unknown;
      error?: { code?: string; message?: string };
    }) => void;
  }
): void {
  if (event.source !== opts.frame.contentWindow) return;
  if (event.origin !== 'null') return; // srcdoc + sandbox 无 allow-same-origin → origin 恒为 'null'
  const m = event.data as
    | { __lf_host_call?: boolean; requestId?: string; kind?: string; args?: unknown }
    | null;
  if (!m || m.__lf_host_call !== true || typeof m.requestId !== 'string' || typeof m.kind !== 'string')
    return;
  void opts
    .invokeRuntime(opts.pluginId, m.kind, m.args as unknown)
    .then(
      (result) =>
        opts.postReply({ __lf_host_reply: true, requestId: m.requestId as string, result }),
      (error: { code?: string; message: string }) =>
        opts.postReply({
          __lf_host_reply: true,
          requestId: m.requestId as string,
          error: { code: error.code, message: error.message },
        })
    );
}

// 保留对真实依赖的引用，确保模块在导入时即解析 invokeRuntime（与组件行为一致）。
export { invokeRuntime };
