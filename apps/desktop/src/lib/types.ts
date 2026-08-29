import type { PluginCapability } from '@qianxia/contract';
import { formatTimestamp } from './time';

export interface DraftFile {
  path: string;
  content: string;
  /**
   * 是否为二进制文件。true 时 content 为 base64 编码的字节（.qplugin v3 导入/导出路径用，
   * 写盘走 write_plugin_file_bytes 命令）。默认 false（content 为 UTF-8 文本）。
   * 可选字段，向后兼容旧消费者（默认当文本处理）。
   */
  binary?: boolean;
}

export interface LoadedPlugin {
  id: string;
  name: string;
  description?: string;
  readmeMarkdown?: string;
  version: string;
  /** 已安装版本（PluginInstallation.version，仅已安装的市场插件有）。
   *  前端对比 version（云端最新版）vs installedVersion 判断是否有更新。 */
  installedVersion?: string;
  builtin?: boolean;
  entry: string;
  status?: string;
  source?: 'builtin' | 'published' | 'installed' | 'platform' | 'team' | 'marketplace';
  installationId?: string;
  packageId?: string;
  releaseId?: string;
  releaseSha256?: string;
  installationOrigin?: 'builtin' | 'local' | 'team' | 'marketplace' | 'dev';
  /** 用户显式运行后预览的 pending client 制品；iframe onLoad 成功后才能原子激活。 */
  pendingActivation?: { releaseId: string };
  // 作者用户 ID（来自后端 publicPlugin.authorUserId）：用于前端判断「能否修改该插件」。
  // 权限规则（与后端 ensurePluginManager 一致）：作者本人 或 当前用户是 TEAM_ADMIN 可改。
  authorUserId?: string;
  // 运行时类型（manifest.runtime_type）：决定插件运行方式（client=软件内 iframe，nodejs/python=独立进程）。
  // 来源：collab-api 的 publicPlugin 与桌面端内置插件 manifest 解析。
  // task 06-16-plugin-system-rebuild 组C：Plugins.tsx 据此渲染「运行」/「打开」按钮分派。
  runtime_type?: 'client' | 'nodejs' | 'python' | 'cloud' | 'workflow';
  capabilities?: Array<PluginCapability | { kind?: string } | string>;
  files?: DraftFile[];
  manifest?: unknown;
  reviewStatus?: string;
  reviewReason?: string;
  marketplace?: boolean;
  priceCents?: number;
  updatedAt?: string;
  // 本地草稿插件标记（task 06-25-local-draft-storage）
  draft?: boolean;
  local?: boolean;
  versionCount?: number; // 历史版本数（.versions/vN 目录数）
}

/** 通用时间格式化：ISO 字符串 → zh-CN 本地时间（24h），解析失败返回 '—'。
 *  委托给 lib/time 的 formatTimestamp，兼容旧版 epoch.毫秒Z 格式（Task 4a 修复）。 */
export function formatTime(iso: string | null | undefined): string {
  return formatTimestamp(iso);
}
