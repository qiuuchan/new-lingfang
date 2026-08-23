// uiViewHost.ts — ui.view 能力的宿主侧落点（纯前端实现）。
//
// ui.view 语义是「插件请求宿主展示一段内容」。它本质是宿主 UI 行为，不经 Rust 网关：
// invokeRuntime 对 ui.view 直接入队到本模块，由挂载在 App 根部的 <UiViewHost> 消费渲染。
// 安全边界：内容只经 Markdown / JSON 文本渲染（react-markdown 默认不执行原始 HTML），
// 绝不 dangerouslySetInnerHTML，插件无法向宿主页注入脚本。

export interface UiViewRequest {
  /** 原始 content：string 走 Markdown 渲染；其余安全序列化为 JSON 文本。 */
  content: unknown;
  resolve: () => void;
}

let queue: UiViewRequest[] = [];
let listeners: Array<(current: UiViewRequest | null) => void> = [];

function current(): UiViewRequest | null {
  return queue[0] ?? null;
}

function emit() {
  const cur = current();
  for (const l of listeners) l(cur);
}

/** 插件调用入口：入队并返回 Promise，在宿主关闭该视图时 resolve。 */
export function enqueueUiView(content: unknown): Promise<void> {
  return new Promise((resolve) => {
    queue.push({ content, resolve });
    emit();
  });
}

/** UiViewHost 关闭当前视图时调用：resolve 当前请求并展示下一个（若有）。 */
export function closeCurrentUiView(): void {
  const [head] = queue;
  if (!head) return;
  queue = queue.slice(1);
  try {
    head.resolve();
  } catch {
    /* 插件 iframe 可能已销毁，忽略 resolve 失败 */
  }
  emit();
}

/** 供 React 组件订阅（返回退订函数）。 */
export function subscribeUiView(listener: (current: UiViewRequest | null) => void): () => void {
  listeners.push(listener);
  listener(current());
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

/** 测试辅助：清空队列（不 resolve）。 */
export function resetUiViewForTests(): void {
  queue = [];
  listeners = [];
}
