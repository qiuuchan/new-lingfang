// clientActionRegistry.ts — client-action 注册表的生产者。
//
// 背景：clientActionBridge.ts 实现了 plugin-action-bridge-call 的监听与回传，但 registry 需要
// 由「插件加载路径」填充——本模块就是那个生产者。对每一个 LoadedPlugin，读取其 manifest.actions，
// 把声明了 client 端 handler.entry 的 action 的源码经 read_plugin_file 取出，注册进桥的 registry
// （key = 契约 action_id）。这样 nodejs/python 经 sdk.actions.call(action_id) 调 client-action
// 时，桥能找到 handler 真正执行并回传，而不是回 action_dependency_unresolved。
//
// 失败容忍：单个 action 的源码读取/解析出错仅 console.warn 跳过，不影响其余 action 注册——
// 与「未注册回 action_dependency_unresolved」的既有语义一致（调用方仍能拿到明确错误而非静默挂起）。

import type { LoadedPlugin } from '@/lib/types';
import { tauriInvoke } from '@/lib/api';
import {
  registerClientActionHandler,
  unregisterClientActionsForPlugin,
} from './clientActionBridge';

const CLIENT_MODULE_RE = /\.(ts|js|mjs|cjs)$/i;

type RawAction = {
  action_id?: unknown;
  handler?: {
    entry?: unknown;
    export?: unknown;
    callable?: unknown;
  };
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 为单个已加载插件注册其声明的 client-action 处理器。
 * 幂等：重复调用会覆盖同一 action_id 的注册；配合 unregisterClientActionsForPlugin 用于更新/卸载。
 */
export async function registerClientActionsForPlugin(plugin: LoadedPlugin): Promise<void> {
  const manifest = plugin.manifest;
  if (!manifest || typeof manifest !== 'object') return;
  const actions = (manifest as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return;

  for (const raw of actions as RawAction[]) {
    if (!raw || typeof raw !== 'object') continue;
    const actionId = raw.action_id;
    if (!isNonEmptyString(actionId)) continue;
    const handler = raw.handler;
    if (!handler || typeof handler !== 'object') continue;
    const entry = handler.entry;
    const exportName = handler.export ?? handler.callable;
    if (!isNonEmptyString(entry) || !isNonEmptyString(exportName)) continue;
    // 仅处理 client 端模块（.ts/.js/.mjs/.cjs）；其余（nodejs/python 内联 handler）不在此桥执行。
    if (!CLIENT_MODULE_RE.test(entry)) continue;

    try {
      const source = await tauriInvoke<string>('read_plugin_file', {
        pluginId: plugin.id,
        file: entry,
      });
      registerClientActionHandler(actionId, {
        pluginId: plugin.id,
        source,
        exportName,
      });
    } catch (error) {
      console.warn(
        `client-action 注册跳过（action=${actionId}, plugin=${plugin.id}, entry=${entry}）：`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

/** 插件卸载/更新时，反注册其全部已登记的 client-action。 */
export function deregisterClientActionsForPlugin(pluginId: string): void {
  unregisterClientActionsForPlugin(pluginId);
}
