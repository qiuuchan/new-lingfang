// plugins-runtime.ts — 宿主能力落点（零服务器架构）。
//
// 前端 client 插件（iframe 内 window.sdk / __qianxiaInvoke）与 client-action adapter
// 最终都汇聚到这里，经 Tauri 命令触达 Rust capability 网关。契约 / 网关分派细节见
// capability.rs（其注释也指向本文件）。
//
// 路由策略（与 capability.rs 注释一致）：
// - net.fetch 走独立命令 plugin_net_fetch（自带声明校验 + SSRF 守卫 + 30s/10MiB），
//   不进同步网关分派（invoke_capability 是同步函数，而 plugin_net_fetch 是 async reqwest）。
// - 下列五个 AI kind 走 C2 决策新增的 client_* 宿主代理命令（relay 凭据由宿主保管，
//   iframe 永不持有）：llm.chat → client_llm_chat / image.generate → client_image_generate /
//   image.edit → client_image_edit / video.generate → client_video_generate /
//   audio.generate → client_audio_generate。Rust 侧并行实现，前端只调命令名。
// - storage.kv / fs.pick / system.notify 走 client_host_caps 的宿主代理命令
//   （声明自校验；kv 按插件隔离持久化到 data/kv.json，pick 用原生对话框，notify 用系统通知）。
// - ui.view 是纯宿主 UI 行为：直接入队 uiViewHost（App 根部 <UiViewHost> 渲染），
//   不经 Rust——内容仅 Markdown/JSON 文本渲染，插件无法向宿主页注入 HTML/脚本。
// - 其余 capability kind 走 invoke_capability 命令（三重校验 + 执行，见 capability.rs::invoke）。
// - plugin.upload / plugin.submitMarketplace 保持网关 NotSupported：
//   属平台市场审核流交互（需平台凭据/流程），零服务器桌面壳不越权伪造。

import { tauriInvoke } from './api';
import { enqueueUiView } from './uiViewHost';

export type CapabilityRuntimeError = Error & { code?: string };

export type CapabilityCode =
  | 'capability_not_declared'
  | 'capability_not_supported'
  | 'capability_out_of_scope'
  | 'capability_invalid_path'
  | 'net_fetch_ssrf_blocked'
  | 'relay_not_configured'
  | 'relay_error'
  | 'kv_value_too_large'
  | 'kv_quota_exceeded'
  | 'capability_error';

// 网关返回的是 Result<_, String> 裸字符串；这里按文案归一化为结构化 { code, message }，
// 便于前端 SDK / 插件据此分支处理（而非只能比对中文文案）。
export function normalizeCapabilityError(err: unknown): CapabilityRuntimeError {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : err && typeof err === 'object' && 'message' in err
          ? String((err as { message: unknown }).message)
          : String(err);
  let code: CapabilityCode = 'capability_error';
  if (message.includes('未声明能力')) code = 'capability_not_declared';
  else if (message.includes('暂未实现')) code = 'capability_not_supported';
  else if (message.includes('SSRF') || message.includes('内网')) code = 'net_fetch_ssrf_blocked';
  // QX-05 / g2-sdk-friction #5：kv 配额错误先于泛化「超出」匹配——kv 文案含「超出」
  // （value 超出 N 字节上限 / 条目数超出 N 上限），若后置会被 capability_out_of_scope 吞掉。
  else if (message.includes('kv_value_too_large')) code = 'kv_value_too_large';
  else if (message.includes('kv_quota_exceeded')) code = 'kv_quota_exceeded';
  else if (message.includes('授权范围') || message.includes('超出')) code = 'capability_out_of_scope';
  else if (message.includes('非法文件路径')) code = 'capability_invalid_path';
  else if (message.includes('relay_not_configured')) code = 'relay_not_configured';
  else if (message.includes('relay_error')) code = 'relay_error';
  const error = new Error(message) as CapabilityRuntimeError;
  error.code = code;
  return error;
}

// 统一入口：client 插件（window.sdk / __qianxiaInvoke）与 client-action adapter 都最终调用本函数。
export async function invokeRuntime(
  pluginId: string,
  kind: string,
  args: unknown
): Promise<unknown> {
  try {
    if (kind === 'net.fetch') {
      // net.fetch 由独立命令处理（异步 reqwest + SSRF 守卫）；不混入同步网关分派。
      return await tauriInvoke('plugin_net_fetch', { pluginId, args });
    }
    // C2 决策：五个 AI kind 走宿主 client_* 代理命令（relay 凭据由宿主保管，iframe 不持有）。
    switch (kind) {
      case 'llm.chat':
        return await tauriInvoke('client_llm_chat', { pluginId, args });
      case 'image.generate':
        return await tauriInvoke('client_image_generate', { pluginId, args });
      case 'image.edit':
        return await tauriInvoke('client_image_edit', { pluginId, args });
      case 'video.generate':
        return await tauriInvoke('client_video_generate', { pluginId, args });
      case 'audio.generate':
        return await tauriInvoke('client_audio_generate', { pluginId, args });
      // 本地宿主能力（client_host_caps.rs，声明自校验）。
      case 'storage.kv':
        return await tauriInvoke('client_storage_kv', { pluginId, args });
      case 'fs.pick':
        return await tauriInvoke('client_fs_pick', { pluginId, args });
      case 'system.notify':
        return await tauriInvoke('client_system_notify', { pluginId, args });
      // 纯前端落点：入队宿主视图队列，关闭时 resolve。
      case 'ui.view': {
        const content =
          args && typeof args === 'object' && 'content' in (args as Record<string, unknown>)
            ? (args as Record<string, unknown>).content
            : args;
        return await enqueueUiView(content);
      }
    }
    return await tauriInvoke('invoke_capability', { pluginId, kind, args });
  } catch (err) {
    throw normalizeCapabilityError(err);
  }
}
