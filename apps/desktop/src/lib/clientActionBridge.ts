// clientActionBridge.ts — 把 Rust 侧的 plugin-action-bridge-call 事件接到前端 client-action 执行。
//
// 背景：nodejs/python 插件进程经 localhost 桥调 /actions/call 路由时，Rust（plugin_llm_bridge.rs:609）
// 会 emit("plugin-action-bridge-call")，期望前端执行对应 action 并经 respond_plugin_action_bridge
// 命令（:352）回传结果。此前前端无监听者，进程端会挂到超时——这是 action 桥事件链断掉的最后一环。
//
// 本模块补全该监听：收到事件后用 executeClientActionAdapter 在沙箱 iframe 内执行 client 导出的
// action handler，handler 经 onCapability → invokeRuntime 触达能力网关；结果回传。
//
// 注意：client-action 处理器需由插件加载路径注册进本模块的 registry（registerClientActionHandler，
// 见 clientActionRegistry.ts 生产者）。未注册 action 会显式回传 action_dependency_unresolved，
// 使进程不再静默挂起（而非无响应）。
//
// key 约定：registry 以契约 PluginAction.action_id（如 "video_generator"）为 key。Rust 经
// plugin-action-bridge-call 发出的 caller 载荷（plugin_package_manager.rs:710）只含调用方
// installation_id，**不含 actionId**；真实被调的 action id 在 args.dependency_id
// （SDK 的 sdk.actions.call(dependency, input) 即发此字段）。故取 actionId 必须优先用
// args.dependency_id，回退到 caller.id，否则永远查不到已注册 handler。

import { tauriInvoke, tauriListen } from './api';
import { invokeRuntime } from './plugins-runtime';
import { executeClientActionAdapter } from './plugin-action-client-adapter';

export interface ClientActionHandler {
  pluginId: string;
  /** client-action 导出的 JS/TS 模块源码（注入沙箱 iframe 经 import 解析）。 */
  source: string;
  /** 导出名，形如 "default" / "handler" / "mod.handler"。 */
  exportName: string;
}

const handlers = new Map<string, ClientActionHandler>();
// 副索引：pluginId → 该插件注册的 action_id 列表，便于卸载/更新时反注册。
const pluginActions = new Map<string, Set<string>>();
let listening = false;

export function registerClientActionHandler(actionId: string, handler: ClientActionHandler): void {
  handlers.set(actionId, handler);
  let set = pluginActions.get(handler.pluginId);
  if (!set) {
    set = new Set();
    pluginActions.set(handler.pluginId, set);
  }
  set.add(actionId);
}

export function unregisterClientActionsForPlugin(pluginId: string): void {
  const set = pluginActions.get(pluginId);
  if (!set) return;
  for (const actionId of set) handlers.delete(actionId);
  pluginActions.delete(pluginId);
}

export function initClientActionBridge(): void {
  if (listening) return;
  listening = true;
  void tauriListen<{
    request_id: string;
    caller?:
      | {
          actionId?: string;
          id?: string;
          pluginId?: string;
          plugin_id?: string;
          package_id?: string;
          installation_id?: string;
        }
      | string;
    args?: unknown;
  }>('plugin-action-bridge-call', (event) => {
    const { request_id, caller, args } = event.payload;
    void runClientAction(request_id, caller, args).catch((err) => {
      void tauriInvoke('respond_plugin_action_bridge', {
        requestId: request_id,
        error: {
          code: (err as { code?: string })?.code ?? 'action_execution_failed',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    });
  });
}

async function runClientAction(
  requestId: string,
  caller: unknown,
  args: unknown
): Promise<void> {
  const argsObj = (args && typeof args === 'object' ? args : null) as
    | { dependency_id?: unknown; input?: unknown }
    | null;
  const callerObj =
    caller && typeof caller === 'object'
      ? (caller as {
          actionId?: string;
          id?: string;
          pluginId?: string;
          plugin_id?: string;
        })
      : null;
  // 真实被调 action id 在 args.dependency_id（SDK 发出）；回退到 caller.actionId / caller.id。
  const actionId =
    (typeof argsObj?.dependency_id === 'string' && argsObj.dependency_id) ||
    callerObj?.actionId ||
    callerObj?.id ||
    (typeof caller === 'string' ? caller : undefined);
  if (!actionId) {
    throw Object.assign(new Error('plugin-action-bridge-call 缺少 action 标识'), {
      code: 'action_bridge_unknown_caller',
    });
  }
  const handler = handlers.get(actionId);
  if (!handler) {
    // 未注册 client-action 处理器：显式回传错误，避免 nodejs/python 进程在桥上挂到超时。
    throw Object.assign(new Error(`未注册 client-action 处理器：${actionId}`), {
      code: 'action_dependency_unresolved',
    });
  }
  const result = await executeClientActionAdapter({
    invocationId: requestId,
    source: handler.source,
    exportName: handler.exportName,
    input: ((argsObj?.input ?? {}) as Record<string, unknown>) ?? {},
    timeoutMs: 24 * 60 * 60 * 1000, // 与 BridgeSession 24h 超时对齐
    onCapability: (kind, a) => invokeRuntime(handler.pluginId, kind, a),
  });
  await tauriInvoke('respond_plugin_action_bridge', { requestId, result });
}
