// plugins-runtime.ts — 宿主能力落点（零服务器架构）。
//
// 前端 client 插件（iframe 内 window.sdk / __lingfangInvoke）与 client-action adapter
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
// - 其余 capability kind 走 invoke_capability 命令（三重校验 + 执行，见 capability.rs::invoke）。
// - 下列 kind 桌面壳尚未实现后端落点（契约已定义）：ui.view / fs.pick / storage.kv /
//   system.notify / plugin.upload / plugin.submitMarketplace。它们经 invoke_capability 会返回
//   CapError::NotSupported（「插件已声明但桌面壳暂未实现」），前端归一化为 capability_not_supported。

import { tauriInvoke } from './api';

export type CapabilityRuntimeError = Error & { code?: string };

export type CapabilityCode =
  | 'capability_not_declared'
  | 'capability_not_supported'
  | 'capability_out_of_scope'
  | 'capability_invalid_path'
  | 'net_fetch_ssrf_blocked'
  | 'relay_not_configured'
  | 'relay_error'
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
  else if (message.includes('授权范围') || message.includes('超出')) code = 'capability_out_of_scope';
  else if (message.includes('非法文件路径')) code = 'capability_invalid_path';
  else if (message.includes('relay_not_configured')) code = 'relay_not_configured';
  else if (message.includes('relay_error')) code = 'relay_error';
  const error = new Error(message) as CapabilityRuntimeError;
  error.code = code;
  return error;
}

// 统一入口：client 插件（window.sdk / __lingfangInvoke）与 client-action adapter 都最终调用本函数。
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
    }
    return await tauriInvoke('invoke_capability', { pluginId, kind, args });
  } catch (err) {
    throw normalizeCapabilityError(err);
  }
}
