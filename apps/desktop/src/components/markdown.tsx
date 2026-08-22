import { useState, type ReactNode, type ReactElement } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { CopyIcon, CheckIcon } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

// 固定 github-dark 主题（父 PRD 决策 4：暂不跟随亮/暗切换）。
// 必须作为显式资源引入，确保 hljs 的 .hljs / .hljs-keyword 等颜色类生效。
import 'highlight.js/styles/github-dark.css';

// 从 React 节点树递归提取纯文本。
// react-markdown v10 传给 pre 的是含大量 hljs span 的元子树，非纯字符串，
// 必须递归读取 props.children 才能拼出整块代码（用于复制按钮）。
function extractText(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (node === null || node === undefined || node === false || node === true) return '';
  if (Array.isArray(node)) return node.map((child) => extractText(child)).join('');
  // React 元素：递归读取其 children
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (element.props && 'children' in element.props) return extractText(element.props.children);
  return '';
}

// 代码块右上角复制按钮：挂在外层 pre 包装层（非 code 内），
// 避免 rehype-highlight 把 fenced 拆成大量 span 后按钮被重复挂载、或取不到完整文本。
function CodeBlockActions({ getText }: { getText: () => string }) {
  const [state, setState] = useState<'idle' | 'copied'>('idle');

  const onCopy = async () => {
    const text = getText();
    try {
      // 优先用标准 Clipboard API（Tauri webview 的 tauri://localhost 满足 secure context）
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // 回退：execCommand（兼容非 secure context 的旧 webview）
        fallbackCopy(text);
      }
      setState('copied');
      toast.success('已复制代码');
      // 1.5s 后复位图标态
      window.setTimeout(() => setState('idle'), 1500);
    } catch {
      // clipboard API 抛错时再尝试 execCommand，仍失败则提示用户手动复制
      if (fallbackCopy(text)) {
        setState('copied');
        toast.success('已复制代码');
        window.setTimeout(() => setState('idle'), 1500);
      } else {
        toast.error('复制失败，请手动选取');
      }
    }
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={state === 'copied' ? '已复制' : '复制代码'}
      className="absolute right-3 top-3 inline-flex size-8 items-center justify-center rounded-lg bg-white/10 text-white/80 opacity-0 backdrop-blur-sm shadow-lg transition-all hover:scale-105 hover:bg-white/20 hover:text-white group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none"
    >
      {state === 'copied' ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
    </button>
  );
}

// execCommand 剪贴板回退：临时插入隐藏 textarea 触发复制。
// 返回是否复制成功。
function fallbackCopy(text: string): boolean {
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

// fenced 代码块容器：暗色底（对齐 github-dark）+ 最大高度纵向滚动 + 横向不换行滚动。
// 复制按钮挂在外层包装 div，hover 时显形，避免常态视觉干扰。
function PreBlock({ children }: { children?: ReactNode }) {
  return (
    <div className="group relative my-2">
      <CodeBlockActions getText={() => extractText(children)} />
      <pre className="max-h-96 overflow-auto rounded-xl border border-white/10 bg-[#0d1117] p-4 text-xs font-mono leading-relaxed shadow-lg">
        {children}
      </pre>
    </div>
  );
}

const COMPONENTS: Components = {
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="my-0.5 leading-relaxed">{children}</li>,
  h1: ({ children }) => <h1 className="my-2.5 text-lg font-bold tracking-tight">{children}</h1>,
  h2: ({ children }) => <h2 className="my-2 text-base font-semibold tracking-tight">{children}</h2>,
  h3: ({ children }) => <h3 className="my-1.5 text-sm font-semibold">{children}</h3>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  // react-markdown v10 已移除 inline prop：fenced 代码块（带 ```lang）的 code 元素带
  // className="language-(\w+)"；inline code 无该前缀。据此区分两种观感。
  code: ({ className, children, ...props }) => {
    const match = /language-(\w+)/.exec(className || '');
    if (match) {
      // fenced 代码：交给 rehype-highlight 注入的 hljs span 着色，
      // code 元素仅继承字体，不再加灰底药丸（背景由 pre 包装层提供）。
      return (
        <code className={cn('font-mono text-xs', className)} {...props}>
          {children}
        </code>
      );
    }
    // inline 代码：维持灰底药丸观感（与 fenced 暗色高亮块明确区分）
    return (
      <code
        className="rounded-md bg-black/10 px-1.5 py-0.5 font-mono text-[0.85em] shadow-sm dark:bg-white/10"
        {...props}
      >
        {children}
      </code>
    );
  },
  // pre 指向独立组件引用（hooks 必须在组件函数体内调用），
  // 复制按钮与最大高度/横向滚动均在此处提供。
  pre: PreBlock,
  a: ({ children, href }) => (
    <a
      href={href}
      className="font-medium text-primary underline decoration-primary/30 underline-offset-2 transition-colors hover:decoration-primary"
    >
      {children}
    </a>
  ),
  // 表格美化：react-markdown 默认渲染为浏览器裸 table（无边框圆角、行间无分隔），
  // 在气泡内显得呆板。这里包一层圆角边框容器 + 表头底色 + 行分隔线 + 偶数行浅底，
  // 列数多时外层 overflow-x-auto 横向滚动（气泡 max-w 受限）。
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-xl border border-border/60 shadow-sm">
      <table className="w-full text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="border-b border-border/60 bg-muted/60 text-left">{children}</thead>
  ),
  // divide-y 画行间分隔线；偶数行浅底提升多行可读性（斑马纹）。
  tbody: ({ children }) => (
    <tbody className="divide-y divide-border/40 [&_tr:nth-child(even)]:bg-muted/30">
      {children}
    </tbody>
  ),
  th: ({ children }) => <th className="px-4 py-2.5 font-semibold">{children}</th>,
  td: ({ children }) => <td className="px-4 py-2.5 align-top">{children}</td>,
};

export function safePluginReadmeHref(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function Markdown({
  children,
  pluginReadme = false,
}: {
  children: string;
  pluginReadme?: boolean;
}) {
  const components = pluginReadme
    ? ({
        ...COMPONENTS,
        a: ({ children: linkChildren, href }: { children?: ReactNode; href?: string }) => {
          const safeHref = safePluginReadmeHref(href);
          return safeHref ? (
            <a
              href={safeHref}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-primary underline decoration-primary/30 underline-offset-2"
            >
              {linkChildren}
            </a>
          ) : (
            <span className="text-muted-foreground" title="插件说明仅支持 HTTP(S) 外部链接">
              {linkChildren}
            </span>
          );
        },
        img: ({ alt }: { alt?: string }) => (
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            [图片未显示{alt ? `：${alt}` : ''}]
          </span>
        ),
      } satisfies Components)
    : COMPONENTS;
  return (
    <div className="text-sm">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={components}
        skipHtml={pluginReadme}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
