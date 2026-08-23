// UiViewHost.tsx — ui.view 能力的宿主渲染出口（挂在 App 根部）。
//
// 展示队列中的插件视图请求；string 内容走 Markdown（react-markdown 默认不执行
// 原始 HTML，安全），其余类型序列化为 JSON 文本。绝不使用 dangerouslySetInnerHTML。

import { useEffect, useState } from 'react';
import { Markdown } from '@/components/markdown';
import { closeCurrentUiView, subscribeUiView, type UiViewRequest } from '@/lib/uiViewHost';

function extractTitle(content: unknown): string | null {
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const t = (content as { title?: unknown }).title;
    if (typeof t === 'string' && t.trim()) return t.trim();
  }
  return null;
}

export function UiViewHost() {
  const [req, setReq] = useState<UiViewRequest | null>(null);

  useEffect(() => subscribeUiView(setReq), []);

  if (!req) return null;
  const title = extractTitle(req.content) ?? '插件视图';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-6">
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border bg-background shadow-2xl">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <span className="font-medium">{title}</span>
          <button
            type="button"
            className="rounded px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={closeCurrentUiView}
          >
            关闭
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm">
          {typeof req.content === 'string' ? (
            <Markdown>{req.content}</Markdown>
          ) : (
            <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed">
              {JSON.stringify(req.content, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
