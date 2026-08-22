// Client runtime 插件的宿主注入全局类型。
//
// 桌面壳在 iframe srcDoc 注入 `window.sdk`，结构与 @lingfang/plugin-sdk 导出的 sdk 一致。
// TS 用户用法：
//
// ```ts
// import type { ClientPluginEntry } from '@lingfang/plugin-sdk/types/client-entry';
// declare const sdk: ClientPluginEntry;
// await sdk.llm.chat({ messages: [...] });
// ```
//
// 该文件仅类型重导出，无运行时代码。

import type { sdk } from '../index.js';

export type ClientPluginEntry = typeof sdk;

declare global {
  interface Window {
    sdk?: ClientPluginEntry;
    __lingfangInvoke?: (capability: string, args: unknown) => Promise<unknown>;
  }
}

// 确保 SDK 类型自身使用一致。该 export 仅用于类型空间，不影响运行时。
export {};
