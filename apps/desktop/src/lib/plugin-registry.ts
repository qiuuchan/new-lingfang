// plugin-registry.ts — 零服务器架构下的插件注册表
// 所有数据通过 Tauri 命令与本地文件系统交互，无后端依赖。
import { Channel, isTauri } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import type { LocalPluginInstallation } from '@qianxia/contract';
import { errorMessage, tauriInvoke } from '@/lib/api';
import type { LoadedPlugin } from '@/lib/types';

export type Installation = LocalPluginInstallation;

export const INSTALLATIONS_CHANGED_EVENT = 'lf:plugin-installations-changed';

export type PluginArtifactInspection = {
  sha256: string;
  sizeBytes: number;
  uncompressedSizeBytes: number;
  manifest: Record<string, unknown>;
  files: Array<{ path: string; sizeBytes: number }>;
};

function notifyInstallationsChanged() {
  window.dispatchEvent(new CustomEvent(INSTALLATIONS_CHANGED_EVENT));
}

export type TransferProgress = {
  stage: 'inspecting' | 'packing' | 'downloading' | 'verifying' | 'installing' | 'finished';
  message: string;
  transferred: number;
  total: number | null;
};

type TransferEvent =
  | { event: 'Stage'; data: { stage: TransferProgress['stage']; message: string } }
  | { event: 'Started'; data: { totalBytes: number | null } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

type InstalledPayload = {
  installation: Installation;
  manifest: Record<string, unknown>;
  entryContent: string;
  readmeMarkdown: string;
};

function progressChannel(onProgress?: (progress: TransferProgress) => void) {
  const channel = new Channel<TransferEvent>();
  let stage: TransferProgress['stage'] = 'downloading';
  let message = '';
  let transferred = 0;
  let total: number | null = null;

  channel.onmessage = (event) => {
    if (event.event === 'Stage') {
      stage = event.data.stage;
      message = event.data.message;
    } else if (event.event === 'Started') {
      total = event.data.totalBytes;
      transferred = 0;
    } else if (event.event === 'Progress') {
      transferred += event.data.chunkLength;
    } else if (event.event === 'Finished') {
      stage = 'finished';
    }
    onProgress?.({ stage, message, transferred, total });
  };
  return channel;
}

export async function listInstallations(): Promise<Installation[]> {
  return tauriInvoke<Installation[]>('list_plugin_installations');
}

export async function loadInstalledPlugin(installationId: string): Promise<LoadedPlugin> {
  const payload = await tauriInvoke<InstalledPayload>('load_installed_plugin', { installationId });
  return installedPayloadToPlugin(payload, payload.installation.activeRelease);
}

export async function previewPendingInstalledPlugin(installationId: string): Promise<LoadedPlugin> {
  const payload = await tauriInvoke<InstalledPayload>('preview_pending_installed_plugin', {
    installationId,
  });
  const release = payload.installation.pendingRelease;
  if (!release) throw new Error('安装项没有待激活版本');
  return installedPayloadToPlugin(payload, release, release.releaseId);
}

export async function activatePendingClientPlugin(installationId: string): Promise<Installation> {
  const installation = await tauriInvoke<Installation>('activate_pending_client_plugin', {
    installationId,
  });
  notifyInstallationsChanged();
  return installation;
}

export async function discardPendingPluginUpdate(
  installationId: string,
  reason?: string
): Promise<Installation> {
  const installation = await tauriInvoke<Installation>('discard_pending_plugin_update', {
    installationId,
    reason,
  });
  notifyInstallationsChanged();
  return installation;
}

function installedPayloadToPlugin(
  payload: InstalledPayload,
  release: Installation['activeRelease'],
  pendingReleaseId?: string
): LoadedPlugin {
  const manifest = payload.manifest;
  const entry = String(manifest.entry || 'ui/index.html');
  const runtime = String(manifest.runtime_type || 'client') as LoadedPlugin['runtime_type'];
  return {
    id: payload.installation.installationId,
    installationId: payload.installation.installationId,
    packageId: payload.installation.packageId,
    releaseId: release.releaseId,
    releaseSha256: release.sha256,
    installationOrigin: payload.installation.origin,
    pendingActivation: pendingReleaseId ? { releaseId: pendingReleaseId } : undefined,
    name: String(manifest.name || payload.installation.packageId),
    description: String(manifest.description || ''),
    readmeMarkdown: payload.readmeMarkdown || '',
    version: release.version,
    entry,
    runtime_type: runtime,
    source: payload.installation.origin === 'builtin' ? 'builtin' : 'installed',
    builtin: payload.installation.protected,
    manifest,
  };
}

export async function downloadRelease(
  url: string,
  sha256: string | null,
  packageId: string | null,
  onProgress?: (progress: TransferProgress) => void
): Promise<Installation> {
  const installation = await tauriInvoke<Installation>('install_plugin_from_url', {
    input: {
      url,
      sha256,
      packageId,
      origin: 'marketplace',
      protected: false,
    },
    onEvent: progressChannel(onProgress),
  });
  notifyInstallationsChanged();
  return installation;
}

export async function importLocalArtifact(artifactPath: string): Promise<Installation> {
  const installation = await tauriInvoke<Installation>('install_plugin_artifact', {
    input: {
      artifactPath,
      expectedSha256: null,
      packageId: null,
      releaseId: null,
      origin: 'local',
      protected: false,
    },
  });
  notifyInstallationsChanged();
  return installation;
}

export async function startInstalledPlugin(
  plugin: LoadedPlugin,
  registryAccessGranted: boolean
): Promise<{ pid: number; started_at: string }> {
  return tauriInvoke('start_installed_plugin', {
    installationId: plugin.installationId || plugin.id,
    registryAccessGranted,
  });
}

export async function stopInstalledPlugin(installationId: string): Promise<void> {
  await tauriInvoke('stop_installed_plugin', { installationId });
}

export async function rollbackInstallation(installationId: string): Promise<Installation> {
  const installation = await tauriInvoke<Installation>('rollback_plugin_installation', {
    installationId,
  });
  notifyInstallationsChanged();
  return installation;
}

export async function uninstallInstallation(installationId: string): Promise<void> {
  await tauriInvoke('uninstall_plugin_installation', { installationId });
  notifyInstallationsChanged();
}

export async function selectPluginArtifact(): Promise<string | null> {
  if (!isTauri()) return null;
  const path = await openDialog({
    filters: [{ name: 'QianXia Plugin', extensions: ['qplugin'] }],
    multiple: false,
    directory: false,
  });
  return path;
}

export function inspectLocalArtifact(artifactPath: string): Promise<PluginArtifactInspection> {
  return tauriInvoke<PluginArtifactInspection>('inspect_qplugin_v4', { artifactPath });
}

export { errorMessage };
