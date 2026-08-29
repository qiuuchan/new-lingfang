// PluginCenterBody.tsx — 零服务器架构下的插件中心主界面
import { useCallback, useEffect, useState } from 'react';
import {
  BoxIcon,
  DownloadIcon,
  InfoIcon,
  Loader2Icon,
  PackageCheckIcon,
  RefreshCwIcon,
  Trash2Icon,
} from 'lucide-react';
import { toast } from 'sonner';
import { Markdown } from '@/components/markdown';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorMessage, tauriInvoke } from '@/lib/api';
import {
  installationOriginBadge,
  signatureStatusLabel,
  type PluginSignatureStatus,
} from '@/lib/installationProvenance';
import type { LoadedPlugin } from '@/lib/types';
import {
  downloadRelease,
  importLocalArtifact,
  listInstallations,
  loadInstalledPlugin,
  selectPluginArtifact,
  uninstallInstallation,
  type Installation,
  type TransferProgress,
} from '@/lib/plugin-registry';

export type PluginCenterTab = 'installed' | 'market';

export function PluginCenterBody({
  tab,
  onTabChange,
  onRun,
}: {
  tab: PluginCenterTab;
  onTabChange: (tab: PluginCenterTab) => void;
  onRun: (plugin: LoadedPlugin) => void;
}) {
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [installedPlugins, setInstalledPlugins] = useState<Record<string, LoadedPlugin>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<Installation | null>(null);
  const [detailPlugin, setDetailPlugin] = useState<LoadedPlugin | null>(null);
  // F3：详情页签名状态（非阻断展示；未配置公钥/未签名均为琥珀提示）。
  const [signatureStatus, setSignatureStatus] = useState<PluginSignatureStatus | null>(null);

  useEffect(() => {
    if (!detailPlugin) {
      setSignatureStatus(null);
      return;
    }
    let cancelled = false;
    tauriInvoke<PluginSignatureStatus>('verify_plugin_signature_command', {
      pluginId: detailPlugin.id,
    })
      .then((status) => {
        if (!cancelled) setSignatureStatus(status);
      })
      .catch(() => {
        if (!cancelled) setSignatureStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [detailPlugin]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const nextInstallations = await listInstallations();
      setInstallations(nextInstallations);
      const loaded = await Promise.all(
        nextInstallations.map(async (installation) => {
          try {
            return [
              installation.installationId,
              await loadInstalledPlugin(installation.installationId),
            ] as const;
          } catch {
            return null;
          }
        })
      );
      setInstalledPlugins(
        Object.fromEntries(
          loaded.filter((item): item is readonly [string, LoadedPlugin] => Boolean(item))
        )
      );
    } catch (caught) {
      setError(errorMessage(caught, '本机安装项加载失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const installFromUrl = async (url: string, sha256: string | null, packageId: string | null) => {
    setBusyKey(url);
    setProgress(null);
    try {
      await downloadRelease(url, sha256, packageId, setProgress);
      toast.success('插件安装成功');
      await reload();
    } catch (caught) {
      toast.error(errorMessage(caught, '安装失败'));
    } finally {
      setBusyKey('');
      setProgress(null);
    }
  };

  const importLocal = async () => {
    const path = await selectPluginArtifact();
    if (!path) return;
    setBusyKey(path);
    try {
      await importLocalArtifact(path);
      toast.success('本地插件导入成功');
      await reload();
    } catch (caught) {
      toast.error(errorMessage(caught, '导入失败'));
    } finally {
      setBusyKey('');
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <div className="mx-auto max-w-6xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">插件</h1>
            <p className="text-sm text-muted-foreground">本机安装项是唯一运行入口</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={importLocal} disabled={!!busyKey}>
              导入本地插件
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void reload()}
              disabled={loading}
            >
              <RefreshCwIcon className={loading ? 'animate-spin' : ''} />
              刷新
            </Button>
          </div>
        </div>

        {error && (
          <Alert
            variant="destructive"
            className="mb-4 border-destructive/40 bg-destructive/5 text-destructive"
          >
            <AlertDescription className="text-destructive">{error}</AlertDescription>
          </Alert>
        )}
        {progress && (
          <div className="mb-4 rounded-lg border bg-muted/50 p-3 text-sm">
            <div className="mb-1 font-medium">{progress.message}</div>
            {progress.total && (
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${(progress.transferred / progress.total) * 100}%` }}
                />
              </div>
            )}
          </div>
        )}

        <Tabs
          value={tab}
          onValueChange={(value) => {
            onTabChange(value as PluginCenterTab);
          }}
        >
          <TabsList className="flex w-full max-w-xl">
            <TabsTrigger value="installed">
              <PackageCheckIcon />
              已安装
            </TabsTrigger>
            <TabsTrigger value="market">
              <DownloadIcon />
              插件市场
            </TabsTrigger>
          </TabsList>

          <TabsContent value="installed" className="mt-4">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
              </div>
            ) : installations.length === 0 ? (
              <Empty className="h-40 border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <BoxIcon />
                  </EmptyMedia>
                  <EmptyTitle>本机还没有安装插件</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="divide-y rounded-lg border">
                {installations.map((installation) => {
                  const plugin = installedPlugins[installation.installationId];
                  const busy = busyKey === installation.installationId;
                  // F3：来源徽标（builtin 由「受保护」覆盖，local 琥珀提示）。
                  const originBadge = installationOriginBadge(installation.origin);
                  return (
                    <div
                      key={installation.installationId}
                      className="flex min-h-20 items-center gap-4 px-4 py-3"
                    >
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
                        <BoxIcon className="size-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate font-medium">
                            {plugin?.name || installation.packageId}
                          </span>
                          {installation.protected && <Badge variant="outline">受保护</Badge>}
                          {originBadge && (
                            <Badge
                              variant="outline"
                              className={
                                originBadge.tone === 'amber'
                                  ? 'border-amber-500/40 text-amber-700 dark:text-amber-400'
                                  : undefined
                              }
                            >
                              {originBadge.label}
                            </Badge>
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                          <span>活动版本 v{installation.activeRelease.version}</span>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button size="sm" disabled={!plugin || busy} onClick={() => plugin && onRun(plugin)}>
                          运行
                        </Button>
                        <Button
                          variant="outline"
                          size="icon-sm"
                          title="插件详情"
                          disabled={!plugin || busy}
                          onClick={() => plugin && setDetailPlugin(plugin)}
                        >
                          <InfoIcon />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title={installation.protected ? '内置插件不可卸载' : '卸载'}
                          disabled={installation.protected || busy}
                          onClick={() => setUninstallTarget(installation)}
                        >
                          {busy ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </TabsContent>

          <TabsContent value="market" className="mt-4">
            <div className="rounded-lg border p-8 text-center">
              <DownloadIcon className="mx-auto size-12 text-muted-foreground" />
              <h3 className="mt-4 text-lg font-semibold">插件市场</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                市场功能即将上线，敬请期待。
              </p>
              <p className="mt-4 text-xs text-muted-foreground">
                当前版本支持通过「导入本地插件」按钮安装 .qplugin 文件。
              </p>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <Dialog
        open={Boolean(uninstallTarget)}
        onOpenChange={(open) => !open && setUninstallTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>彻底卸载插件？</DialogTitle>
            <DialogDescription>
              将删除插件代码、运行环境和全部插件数据。此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUninstallTarget(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (!uninstallTarget) return;
                setBusyKey(uninstallTarget.installationId);
                try {
                  await uninstallInstallation(uninstallTarget.installationId);
                  toast.success('插件已卸载');
                  setUninstallTarget(null);
                  await reload();
                } catch (caught) {
                  toast.error(errorMessage(caught, '卸载失败'));
                } finally {
                  setBusyKey('');
                }
              }}
            >
              <Trash2Icon />
              确认卸载
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(detailPlugin)} onOpenChange={(open) => !open && setDetailPlugin(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{detailPlugin?.name}</DialogTitle>
            <DialogDescription>{detailPlugin?.description}</DialogDescription>
          </DialogHeader>
          {detailPlugin && (
            <div className="text-xs">
              {signatureStatus ? (
                <span
                  className={
                    signatureStatusLabel(signatureStatus).ok
                      ? 'text-green-600'
                      : 'text-amber-700 dark:text-amber-400'
                  }
                >
                  {signatureStatusLabel(signatureStatus).ok ? '✓ ' : '⚠ '}
                  {signatureStatusLabel(signatureStatus).text}
                </span>
              ) : (
                <span className="text-muted-foreground">签名状态：无法获取</span>
              )}
            </div>
          )}
          {detailPlugin?.readmeMarkdown && (
            <div className="max-h-96 overflow-y-auto">
              <Markdown>{detailPlugin.readmeMarkdown}</Markdown>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailPlugin(null)}>
              关闭
            </Button>
            {detailPlugin && (
              <Button onClick={() => onRun(detailPlugin)}>运行</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
