import type { PluginReleaseSourceKind } from '@lingfang/contract';

export type PluginProvenance = {
  sourceKind: PluginReleaseSourceKind;
  sourceLabel: string;
};

export const DEFAULT_SOURCE_LABELS: Record<PluginReleaseSourceKind, string> = {
  LINGFANG_CREATOR: '灵枋创建器',
  EXTERNAL_TOOL: '外部开发工具',
  LOCAL_ARTIFACT: '本地 .lfplugin 制品',
  COPIED_INSTALLATION: '已安装插件副本',
  API: 'API',
  LEGACY_MIGRATION: '旧版迁移',
  UNKNOWN: '来源未知',
};

export const CREATOR_PROVENANCE = {
  sourceKind: 'LINGFANG_CREATOR',
  sourceLabel: DEFAULT_SOURCE_LABELS.LINGFANG_CREATOR,
} as const satisfies PluginProvenance;

export const EXTERNAL_TOOL_PROVENANCE = {
  sourceKind: 'EXTERNAL_TOOL',
  sourceLabel: DEFAULT_SOURCE_LABELS.EXTERNAL_TOOL,
} as const satisfies PluginProvenance;

export const LOCAL_ARTIFACT_PROVENANCE = {
  sourceKind: 'LOCAL_ARTIFACT',
  sourceLabel: DEFAULT_SOURCE_LABELS.LOCAL_ARTIFACT,
} as const satisfies PluginProvenance;

const SOURCE_KINDS = new Set<PluginReleaseSourceKind>(
  Object.keys(DEFAULT_SOURCE_LABELS) as PluginReleaseSourceKind[]
);

export function isPluginSourceKind(value: unknown): value is PluginReleaseSourceKind {
  return typeof value === 'string' && SOURCE_KINDS.has(value as PluginReleaseSourceKind);
}

function containsAbsoluteLocalPath(value: string): boolean {
  if (/(?:file:\/\/|(?:^|[^a-zA-Z0-9])[a-zA-Z]:[\\/]|\\\\|~[\\/])/i.test(value)) return true;
  const withoutWebUrls = value.replace(/\bhttps?:\/\/\S+/gi, '');
  for (let index = 0; index < withoutWebUrls.length; index += 1) {
    if (withoutWebUrls[index] !== '/' || /[\s/]/.test(withoutWebUrls[index + 1] || '')) continue;
    const previous = withoutWebUrls[index - 1] || '';
    if (index === 0 || /[\s\p{P}\p{S}]/u.test(previous)) return true;
  }
  return false;
}

export function sanitizePluginSourceLabel(value: unknown): string {
  const raw = String(value ?? '')
    .trim()
    .replace(/[\u0000-\u001f\u007f]/g, '');
  if (containsAbsoluteLocalPath(raw)) return '';
  return [...raw].slice(0, 80).join('');
}

export function normalizePluginProvenance(
  input?: Partial<PluginProvenance> | null,
  fallbackKind: PluginReleaseSourceKind = 'UNKNOWN'
): PluginProvenance {
  const sourceKind = isPluginSourceKind(input?.sourceKind) ? input.sourceKind : fallbackKind;
  const sourceLabel = sanitizePluginSourceLabel(input?.sourceLabel);
  return { sourceKind, sourceLabel: sourceLabel || DEFAULT_SOURCE_LABELS[sourceKind] };
}
