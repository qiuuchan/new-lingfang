// window-drag.ts — 窗口拖动共享工具。
//
// 背景：tauri.conf.json 设 decorations:false，必须自实现拖动。data-tauri-drag-region 属性在
// 主窗口 DOM 内生效，但在 portal 渲染的 Dialog/Sheet 内不生效（Tauri 已知限制），故 portal 弹窗
// 必须用 onMouseDown 手动调 getCurrentWindow().startDragging()。本工具统一两种模式，消除重复。
//
// 用法：
//   1. 任何顶部容器/弹窗 header：{...dragRegionProps}
//   2. 仅左键（button===0）触发；交互元素（button/input/a/select/[role=button]）跳过，避免误触拖动。

import type { MouseEvent } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

/** 交互元素选择器：命中则不触发拖动（点击优先）。 */
const INTERACTIVE_SELECTOR = 'button, input, a, select, textarea, [role="button"]';

/**
 * 通用窗口拖动 handler：左键按下 + 非交互元素时调 startDragging。
 * 同时给 data-tauri-drag-region（主窗口 DOM 内的原生拖动）与 portal 弹窗兜底。
 */
export function onWindowDragStart(e: MouseEvent): void {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (target.closest(INTERACTIVE_SELECTOR)) return;
  // 无 Tauri 壳（浏览器直连 dev server）时 getCurrentWindow 不完整，跳过拖动（避免抛错）。
  if (
    typeof window === 'undefined' ||
    !(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  )
    return;
  void getCurrentWindow().startDragging();
}

/**
 * 展开属性：给任意顶部容器/header 加 {...dragRegionProps} 即获得双保险拖动。
 * - data-tauri-drag-region：主窗口 DOM 内的原生拖动
 * - onMouseDown：portal 内（Dialog/Sheet）兜底手动 startDragging
 */
export const dragRegionProps = {
  'data-tauri-drag-region': true,
  onMouseDown: onWindowDragStart,
} as const;
