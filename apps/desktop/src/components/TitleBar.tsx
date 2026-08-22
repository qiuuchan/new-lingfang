import {
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  MinusIcon,
  SquareIcon,
  XIcon,
  CopyIcon,
  SparklesIcon,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { cn } from '@/lib/utils';
import { dragRegionProps } from '@/lib/window-drag';

// 自定义标题栏（隐藏系统 decorations 后承载窗口拖拽 + 最小化/最大化/关闭 + 侧边栏折叠）。
// 拖动逻辑抽到 lib/window-drag.ts（dragRegionProps），主窗口 DOM 与 portal 弹窗统一复用。

interface TitleBarProps {
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  /** 标题栏文案（默认 '灵坊工作台'）。登录态等无侧边栏场景可传平台名展示。 */
  label?: string;
}

export function TitleBar({ sidebarOpen, onToggleSidebar, label = '灵坊工作台' }: TitleBarProps) {
  const hasTauri =
    typeof window !== 'undefined' &&
    Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  const appWindow = hasTauri ? getCurrentWindow() : null;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!appWindow) return;
    let unlisten: (() => void) | undefined;
    appWindow
      .isMaximized()
      .then(setMaximized)
      .catch(() => {});
    appWindow
      .onResized(() => {
        appWindow
          .isMaximized()
          .then(setMaximized)
          .catch(() => {});
      })
      .then((fn) => {
        unlisten = fn as unknown as () => void;
      })
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, [appWindow]);

  const hasSidebar = typeof onToggleSidebar === 'function';
  return (
    <div
      {...dragRegionProps}
      className="grid h-10 shrink-0 select-none grid-cols-[1fr_auto] items-center border-b bg-background/95 shadow-sm backdrop-blur"
    >
      <div className="flex h-full min-w-0 items-center gap-2.5 px-3" {...dragRegionProps}>
        {hasSidebar && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleSidebar!();
            }}
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
            title={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
          >
            {sidebarOpen ? (
              <PanelLeftCloseIcon className="size-[18px]" />
            ) : (
              <PanelLeftOpenIcon className="size-[18px]" />
            )}
          </button>
        )}
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <SparklesIcon className="size-3.5" />
          </span>
          <span className="truncate text-sm font-semibold text-foreground" data-tauri-drag-region>
            {label}
          </span>
        </div>
      </div>

      {appWindow && (
        <div className="flex h-full items-center justify-end gap-1 pr-2">
          <WinBtn title="最小化" onClick={() => appWindow.minimize()}>
            <MinusIcon className="size-4" />
          </WinBtn>
          <WinBtn title={maximized ? '还原' : '最大化'} onClick={() => appWindow.toggleMaximize()}>
            {maximized ? (
              <CopyIcon className="size-3.5 rotate-180" />
            ) : (
              <SquareIcon className="size-3.5" />
            )}
          </WinBtn>
          <WinBtn title="关闭" danger onClick={() => appWindow.close()}>
            <XIcon className="size-4" />
          </WinBtn>
        </div>
      )}
    </div>
  );
}

function WinBtn({
  children,
  title,
  onClick,
  danger,
}: {
  children: ReactNode;
  title: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        'inline-flex h-7 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors',
        danger
          ? 'hover:bg-destructive/15 hover:text-destructive'
          : 'hover:bg-accent hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}
