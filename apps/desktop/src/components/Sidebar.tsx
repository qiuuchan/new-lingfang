// Sidebar.tsx — 精简版侧边栏（零服务器架构）
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '@/App';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { LoadedPlugin } from '@/lib/types';
import {
  PackageIcon,
  SearchIcon,
  PinIcon,
  PinOffIcon,
  HistoryIcon,
  XIcon,
  SettingsIcon,
  type LucideIcon,
} from 'lucide-react';

const WIDTH_DEFAULT = 224;
const WIDTH_MIN = 200;
const WIDTH_MAX = 320;
const WIDTH_STORAGE = 'mt:sidebar-width';
const COLLAPSED_WIDTH = 56;

function loadWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_STORAGE);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, n)) : WIDTH_DEFAULT;
  } catch {
    return WIDTH_DEFAULT;
  }
}

export function Sidebar({
  collapsed,
}: {
  collapsed: boolean;
}) {
  const {
    setRunningPlugin,
    runningPlugin,
    runningPlugins,
    pinnedPlugins,
    recentPlugins,
    isPinned,
    pinPlugin,
    unpinPlugin,
    removeFromRecent,
    openPluginCenter,
    openSettings,
  } = useApp();

  const [width, setWidth] = useState(loadWidth);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(WIDTH_DEFAULT);

  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_STORAGE, String(width));
    } catch {
      /* 忽略配额/禁用 */
    }
  }, [width]);

  const onDragStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    dragging.current = true;
    startX.current = event.clientX;
    startWidth.current = width;
    const onMove = (moveEvent: MouseEvent) => {
      if (!dragging.current) return;
      const delta = moveEvent.clientX - startX.current;
      setWidth(Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, startWidth.current + delta)));
    };
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [width]);

  const onResetWidth = useCallback(() => setWidth(WIDTH_DEFAULT), []);

  const runPlugin = useCallback(
    (plugin: LoadedPlugin) => {
      if (runningPlugin?.installationId === plugin.installationId) return;
      setRunningPlugin(plugin);
    },
    [runningPlugin, setRunningPlugin]
  );

  const stopPlugin = useCallback(
    (plugin: LoadedPlugin) => {
      if (runningPlugin?.installationId !== plugin.installationId) return;
      setRunningPlugin(null);
    },
    [runningPlugin, setRunningPlugin]
  );

  const isRunning = (plugin: LoadedPlugin) => Boolean(runningPlugins[plugin.id]);

  return (
    <aside
      className={cn(
        'flex h-full flex-col border-r bg-card transition-[width] duration-200',
        collapsed && 'w-14'
      )}
      style={collapsed ? undefined : { width }}
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        {!collapsed && <span className="text-sm font-semibold">插件工作台</span>}
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        {!collapsed && (
          <Button
            variant="outline"
            size="sm"
            className="mb-3 w-full justify-start gap-2"
            onClick={() => openPluginCenter('installed')}
          >
            <PackageIcon className="size-4" />
            浏览插件
          </Button>
        )}

        {!collapsed && (
          <Button
            variant="outline"
            size="sm"
            className="mb-3 w-full justify-start gap-2"
            onClick={() => openSettings()}
          >
            <SettingsIcon className="size-4" />
            设置
          </Button>
        )}

        {pinnedPlugins.length > 0 && (
          <div className="mb-4">
            {!collapsed && (
              <div className="mb-1 px-2 text-xs font-medium text-muted-foreground">已固定</div>
            )}
            <PluginList
              plugins={pinnedPlugins}
              collapsed={collapsed}
              isRunning={isRunning}
              runningPlugin={runningPlugin}
              onRun={runPlugin}
              onStop={stopPlugin}
              onUnpin={unpinPlugin}
              pinned
            />
          </div>
        )}

        {recentPlugins.length > 0 && (
          <div>
            {!collapsed && (
              <div className="mb-1 px-2 text-xs font-medium text-muted-foreground">最近使用</div>
            )}
            <PluginList
              plugins={recentPlugins}
              collapsed={collapsed}
              isRunning={isRunning}
              runningPlugin={runningPlugin}
              onRun={runPlugin}
              onStop={stopPlugin}
              onRemove={removeFromRecent}
            />
          </div>
        )}

        {pinnedPlugins.length === 0 && recentPlugins.length === 0 && !collapsed && (
          <div className="px-2 text-sm text-muted-foreground">
            运行插件后会出现在这里。
          </div>
        )}
      </div>

      {!collapsed && (
        <div
          className="group flex h-8 cursor-col-resize items-center justify-center border-t hover:bg-accent"
          onMouseDown={onDragStart}
          onDoubleClick={onResetWidth}
          title="拖拽调整宽度 / 双击复位"
        >
          <div className="h-0.5 w-8 rounded-full bg-border transition-colors group-hover:bg-primary" />
        </div>
      )}
    </aside>
  );
}

function PluginList({
  plugins,
  collapsed,
  isRunning,
  runningPlugin,
  onRun,
  onStop,
  onUnpin,
  onRemove,
  pinned,
}: {
  plugins: LoadedPlugin[];
  collapsed: boolean;
  isRunning: (plugin: LoadedPlugin) => boolean;
  runningPlugin: LoadedPlugin | null;
  onRun: (plugin: LoadedPlugin) => void;
  onStop: (plugin: LoadedPlugin) => void;
  onUnpin?: (id: string) => void;
  onRemove?: (id: string) => void;
  pinned?: boolean;
}) {
  return (
    <div className="space-y-1">
      {plugins.map((plugin) => {
        const running = isRunning(plugin);
        const active = runningPlugin?.installationId === plugin.installationId;
        const Icon = PackageIcon;
        return (
          <div
            key={plugin.installationId || plugin.id}
            className={cn(
              'group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
              active ? 'bg-primary/10 text-primary' : 'hover:bg-accent'
            )}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              onClick={() => (running ? onStop(plugin) : onRun(plugin))}
            >
              <Icon className={cn('size-4 shrink-0', running && 'text-green-500')} />
              {!collapsed && (
                <>
                  <span className="truncate">{plugin.name}</span>
                  {running && <span className="ml-auto text-xs text-green-500">运行中</span>}
                </>
              )}
            </button>
            {!collapsed && (
              <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                {pinned && onUnpin && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    title="取消固定"
                    onClick={() => onUnpin(plugin.id)}
                  >
                    <PinOffIcon className="size-3" />
                  </Button>
                )}
                {!pinned && onUnpin && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    title="固定到侧栏"
                    onClick={() => onUnpin(plugin.id)}
                  >
                    <PinIcon className="size-3" />
                  </Button>
                )}
                {onRemove && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    title="从最近移除"
                    onClick={() => onRemove(plugin.id)}
                  >
                    <XIcon className="size-3" />
                  </Button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
