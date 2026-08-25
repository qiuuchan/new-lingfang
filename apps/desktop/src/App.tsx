import { createContext, useContext, useState, useCallback, useEffect, useMemo, lazy, Suspense, type ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { tauriInvoke, tauriListen } from '@/lib/api';
import type { LoadedPlugin } from '@/lib/types';
import { Sidebar } from '@/components/Sidebar';
import { TitleBar } from '@/components/TitleBar';
import { PanelDialog } from '@/components/PanelDialog';
import { SettingsPanel } from '@/components/SettingsPanel';
import { UiViewHost } from '@/components/UiViewHost';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { ListSkeleton, PageTransition } from '@/lib/motion';
import type { PluginCenterTab } from '@/pages/plugins/PluginCenterBody';
import {
  INSTALLATIONS_CHANGED_EVENT,
  listInstallations,
  loadInstalledPlugin,
} from '@/lib/plugin-registry';
import { registerClientActionsForPlugin } from '@/lib/clientActionRegistry';

const PluginCenterBody = lazy(() =>
  import('@/pages/plugins/PluginCenterBody').then((m) => ({ default: m.PluginCenterBody }))
);
const PluginRunner = lazy(() =>
  import('@/pages/plugins/PluginRunner').then((m) => ({ default: m.PluginRunner }))
);

interface AppContextValue {
  view: View;
  setView: (v: View) => void;
  runningPlugin: LoadedPlugin | null;
  setRunningPlugin: (p: LoadedPlugin | null) => void;
  clearRunningPlugin: (pluginId: string) => void;
  runningPlugins: Record<string, LoadedPlugin>;
  pinnedPlugins: LoadedPlugin[];
  recentPlugins: LoadedPlugin[];
  pinPlugin: (p: LoadedPlugin) => void;
  unpinPlugin: (id: string) => void;
  isPinned: (id: string) => boolean;
  removeFromRecent: (id: string) => void;
  openPluginCenter: (tab?: PluginCenterTab) => void;
  settingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;
}

type View = 'run-plugins';

const AppContext = createContext<AppContextValue | null>(null);

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用');
  return ctx;
}

const pinKey = 'mt:pins';
function loadPins(): string[] {
  try {
    const raw = localStorage.getItem(pinKey);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
function savePins(pins: LoadedPlugin[]) {
  try {
    localStorage.setItem(pinKey, JSON.stringify(pins.map((plugin) => plugin.installationId).filter(Boolean)));
  } catch {
    /* localStorage 不可用则忽略 */
  }
}

const RECENT_MAX = 5;
const recentKey = 'mt:recent';
function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(recentKey);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
function saveRecent(recent: LoadedPlugin[]) {
  try {
    localStorage.setItem(recentKey, JSON.stringify(recent.map((plugin) => plugin.installationId).filter(Boolean)));
  } catch {
    /* localStorage 不可用则忽略 */
  }
}

async function hydrateInstallationPreferences(ids: string[]): Promise<LoadedPlugin[]> {
  if (!ids.length) return [];
  try {
    const installed = new Set((await listInstallations()).map((item) => item.installationId));
    const loaded = await Promise.all(
      ids.filter((id) => installed.has(id)).map((id) => loadInstalledPlugin(id).catch(() => null))
    );
    const plugins = loaded.filter((plugin): plugin is LoadedPlugin => Boolean(plugin));
    // A3：为每个已加载插件注册其 client-action 处理器（填充 clientActionBridge 的 registry）。
    await Promise.all(plugins.map((plugin) => registerClientActionsForPlugin(plugin)));
    return plugins;
  } catch {
    return [];
  }
}

export default function App() {
  const [view, setViewState] = useState<View>('run-plugins');
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(loadSidebarOpen);
  const [runningPlugin, setRunningPluginState] = useState<LoadedPlugin | null>(null);
  const [runningPlugins, setRunningPlugins] = useState<Record<string, LoadedPlugin>>({});
  const [pinnedPlugins, setPinnedPlugins] = useState<LoadedPlugin[]>([]);
  const [recentPlugins, setRecentPlugins] = useState<LoadedPlugin[]>([]);
  const [pluginCenterTab, setPluginCenterTab] = useState<PluginCenterTab>('installed');
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);

  const setRunningPlugin = useCallback((plugin: LoadedPlugin | null) => {
    if (!plugin) {
      setRunningPluginState(null);
      return;
    }
    setRunningPluginState(plugin);
    setRunningPlugins((prev) => ({ ...prev, [plugin.id]: plugin }));
    if (!plugin.installationId) return;
    setRecentPlugins((prev) => {
      const next = [plugin, ...prev.filter((item) => item.id !== plugin.id)].slice(0, RECENT_MAX);
      saveRecent(next);
      return next;
    });
  }, []);

  const clearRunningPlugin = useCallback((pluginId: string) => {
    setRunningPlugins((prev) => {
      const next = { ...prev };
      delete next[pluginId];
      return next;
    });
    setRunningPluginState((current) => (current?.id === pluginId ? null : current));
  }, []);

  const removeFromRecent = useCallback((pluginId: string) => {
    setRecentPlugins((prev) => {
      const next = prev.filter((x) => x.id !== pluginId);
      saveRecent(next);
      return next;
    });
  }, []);

  const setView = useCallback((nextView: View) => {
    setViewState(nextView);
  }, []);

  const openPluginCenter = useCallback(
    (tab?: PluginCenterTab) => {
      if (tab) setPluginCenterTab(tab);
      setRunningPlugin(null);
      setViewState('run-plugins');
    },
    [setRunningPlugin]
  );

  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  useEffect(() => {
    const pinIds = loadPins();
    void hydrateInstallationPreferences(pinIds).then((plugins) => {
      setPinnedPlugins(plugins);
      savePins(plugins);
    });
  }, []);

  useEffect(() => {
    const refreshPreferences = () => {
      void hydrateInstallationPreferences(loadPins()).then((plugins) => {
        setPinnedPlugins(plugins);
        savePins(plugins);
      });
      void hydrateInstallationPreferences(loadRecent()).then((plugins) => {
        const next = plugins.slice(0, RECENT_MAX);
        setRecentPlugins(next);
        saveRecent(next);
      });
    };
    window.addEventListener(INSTALLATIONS_CHANGED_EVENT, refreshPreferences);
    return () => window.removeEventListener(INSTALLATIONS_CHANGED_EVENT, refreshPreferences);
  }, []);

  useEffect(() => {
    const recentIds = loadRecent();
    void hydrateInstallationPreferences(recentIds).then((plugins) => {
      setRecentPlugins(plugins.slice(0, RECENT_MAX));
      saveRecent(plugins.slice(0, RECENT_MAX));
    });
  }, []);

  // LF-06（Defect #1 修复）：内置 client 插件的 action handler 此前只在「打开插件」
  // （PluginRunner.tsx:110）或 pin/recent 水合时注册。全新机器 pin/recent 为空时，
  // 内置 client action（如 action-demo 的 demo.hello）不会被注册，导致进程插件经桥
  // 调它时回 action_dependency_unresolved。这里在 App 启动期对内置 client 插件
  // 主动注册，保证内置 action 始终可被调用（与 LF-06 harness 先「打开 action-demo」双层保障）。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const installations = await listInstallations();
        const builtinIds = installations
          .filter((item) => item.origin === 'builtin')
          .map((item) => item.installationId);
        const plugins = (
          await Promise.all(
            builtinIds.map((id) => loadInstalledPlugin(id).catch(() => null))
          )
        ).filter((plugin): plugin is LoadedPlugin => Boolean(plugin));
        if (cancelled) return;
        const clientPlugins = plugins.filter(
          (plugin) =>
            (plugin.manifest as { runtime_type?: string } | undefined)?.runtime_type === 'client'
        );
        await Promise.all(clientPlugins.map((plugin) => registerClientActionsForPlugin(plugin)));
      } catch {
        /* 启动期注册失败不阻断主流程 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 小视口进入时自动收起一次
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const media = window.matchMedia('(max-width: 767px)');
    const handleChange = (event: MediaQueryListEvent) => {
      if (event.matches) setSidebarOpen(false);
    };
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  // 侧栏开合持久化
  useEffect(() => {
    try {
      localStorage.setItem('mt:sidebar-open', sidebarOpen ? '1' : '0');
    } catch {
      /* 忽略配额/禁用 */
    }
  }, [sidebarOpen]);

  // Ctrl/Cmd+K 唤起全局搜索（简化版：仅触发浏览器默认搜索）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        // 简化版：不实现自定义搜索面板
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // 关窗拦截（简化版：直接退出）
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    tauriListen('close-requested', () => {
      void tauriInvoke('quit_app');
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* 无 Tauri 壳（浏览器预览）静默忽略 */
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // 全局监听插件退出事件
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    tauriListen<{ pluginId: string; exitCode?: number | null; stderrTail?: string }>(
      'plugin:exited',
      (event) => {
        const pluginId = event.payload?.pluginId;
        if (pluginId) clearRunningPlugin(pluginId);
      }
    )
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* 无 Tauri 壳静默忽略 */
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [clearRunningPlugin]);

  const pinPlugin = useCallback((p: LoadedPlugin) => {
    if (!p.installationId) return;
    setPinnedPlugins((prev) => {
      if (prev.some((x) => x.id === p.id)) return prev;
      const next = [...prev, p];
      savePins(next);
      return next;
    });
  }, []);

  const unpinPlugin = useCallback((id: string) => {
    setPinnedPlugins((prev) => {
      const next = prev.filter((x) => x.id !== id);
      savePins(next);
      return next;
    });
  }, []);

  const isPinned = useCallback((id: string) => pinnedPlugins.some((x) => x.id === id), [pinnedPlugins]);

  const handleCloseChoice = useCallback((action: 'tray' | 'quit' | 'cancel') => {
    if (action === 'tray') {
      void getCurrentWindow().hide();
    } else if (action === 'quit') {
      void tauriInvoke('quit_app');
    }
  }, []);

  const ctx: AppContextValue = useMemo(
    () => ({
      view,
      setView,
      runningPlugin,
      setRunningPlugin,
      clearRunningPlugin,
      runningPlugins,
      pinnedPlugins,
      recentPlugins,
      pinPlugin,
      unpinPlugin,
      isPinned,
      removeFromRecent,
      openPluginCenter,
      settingsOpen,
      openSettings,
      closeSettings,
    }),
    [
      view,
      setView,
      runningPlugin,
      setRunningPlugin,
      clearRunningPlugin,
      runningPlugins,
      pinnedPlugins,
      recentPlugins,
      isPinned,
      pinPlugin,
      unpinPlugin,
      removeFromRecent,
      openPluginCenter,
      settingsOpen,
      openSettings,
      closeSettings,
    ]
  );

  return (
    <AppContext.Provider value={ctx}>
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
        <TitleBar
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
        />
        <div className="flex min-h-0 flex-1">
          <Sidebar collapsed={!sidebarOpen} />
          <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            {runningPlugin ? (
              <div className="min-h-0 flex-1">
                <Suspense fallback={null}>
                  <PluginRunner
                    plugin={runningPlugin}
                    onBack={() => {
                      setRunningPlugin(null);
                      setViewState('run-plugins');
                    }}
                  />
                </Suspense>
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-hidden">
                <Suspense fallback={<ListSkeleton rows={6} />}>
                  <PageTransition viewKey={view} className="flex h-full min-h-0 flex-col">
                    <PluginCenterBody
                      tab={pluginCenterTab}
                      onTabChange={setPluginCenterTab}
                      onRun={setRunningPlugin}
                    />
                  </PageTransition>
                </Suspense>
              </div>
            )}
          </main>
        </div>
      </div>
      <PanelDialog
        open={settingsOpen}
        onOpenChange={(open) => (open ? openSettings() : closeSettings())}
        title="设置"
        description="Relay 凭据与应用偏好"
      >
        <SettingsPanel onClose={closeSettings} />
      </PanelDialog>
      <Toaster position="top-right" richColors closeButton />
      <UiViewHost />
    </AppContext.Provider>
  );
}

function loadSidebarOpen(): boolean {
  try {
    if (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 767px)').matches)
      return false;
    return localStorage.getItem('mt:sidebar-open') === '1';
  } catch {
    return false;
  }
}
