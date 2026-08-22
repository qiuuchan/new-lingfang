// 全局右键上下文菜单：刷新 / 复制 / 粘贴 / 控制台。
// 拦截 webview 原生右键菜单，弹一个主题化（shadcn 变量）的轻量菜单。
// - 刷新：window.location.reload()（与 main.tsx 一致）
// - 复制/粘贴：document.execCommand —— 对当前选区/焦点元素生效（WebView2 桌面上下文允许 paste）
// - 控制台：Rust toggle_devtools 命令开关开发者工具（需 Cargo tauri devtools 特性）
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { RotateCwIcon, CopyIcon, ClipboardPasteIcon, TerminalSquareIcon } from 'lucide-react';
import { tauriInvoke } from '@/lib/api';

interface Pos {
  x: number;
  y: number;
}

interface MenuItemDef {
  key: string;
  icon: ReactNode;
  label: string;
  shortcut?: string;
  onClick: () => void | Promise<void>;
}

export function ContextMenu({ children }: { children?: ReactNode }) {
  const [pos, setPos] = useState<Pos | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      setPos({ x: e.clientX, y: e.clientY });
    };
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      setPos(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPos(null);
    };
    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const run = useCallback(async (fn: () => void | Promise<void>) => {
    setPos(null);
    try {
      await fn();
    } catch {
      /* execCommand 在无选区/无焦点时静默失败，忽略 */
    }
  }, []);

  const items: MenuItemDef[] = [
    {
      key: 'refresh',
      icon: <RotateCwIcon className="size-4" />,
      label: '刷新',
      shortcut: 'Ctrl+R',
      onClick: () => window.location.reload(),
    },
    {
      key: 'copy',
      icon: <CopyIcon className="size-4" />,
      label: '复制',
      shortcut: 'Ctrl+C',
      onClick: () => document.execCommand('copy'),
    },
    {
      key: 'paste',
      icon: <ClipboardPasteIcon className="size-4" />,
      label: '粘贴',
      shortcut: 'Ctrl+V',
      onClick: () => document.execCommand('paste'),
    },
    {
      key: 'devtools',
      icon: <TerminalSquareIcon className="size-4" />,
      label: '控制台',
      onClick: () => {
        void tauriInvoke('toggle_devtools');
      },
    },
  ];

  return (
    <>
      {children}
      {pos && (
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-[9999] min-w-[188px] rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
          style={{
            left: Math.max(8, Math.min(pos.x, window.innerWidth - 200)),
            top: Math.max(8, Math.min(pos.y, window.innerHeight - 196)),
          }}
        >
          {items.map((it) => (
            <button
              key={it.key}
              role="menuitem"
              onClick={() => run(it.onClick)}
              className="flex w-full items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-left outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent"
            >
              {it.icon}
              <span className="flex-1">{it.label}</span>
              {it.shortcut && <span className="text-xs text-muted-foreground">{it.shortcut}</span>}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
