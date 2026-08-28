// manifest 业务规则（见 design.md §3）。
// 每条规则签名：(manifest: PluginManifest) => ManifestError[]
// 返回空数组表示通过，非空数组为违反。
import { CapabilityKind as CapabilityKindSchema } from '@lingfang/contract';
import type { PluginManifest } from '@lingfang/contract';

export interface ManifestError {
  code: string;
  path: string;
  message: string;
  /** 严重程度：'error' 阻塞校验（默认），'warning' 仅提示、不阻塞。 */
  severity?: 'error' | 'warning';
}

// M1：id 不为空，匹配 ^[a-zA-Z][a-zA-Z0-9-_.]*$
const ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9-_.]*$/;

export function ruleId(manifest: PluginManifest): ManifestError[] {
  if (!ID_PATTERN.test(manifest.id)) {
    return [
      {
        code: 'invalid_id',
        path: 'id',
        message: `id "${manifest.id}" 不合法：必须以英文字母开头，只能包含字母、数字、连字符(-)、下划线(_)、点号(.)`,
      },
    ];
  }
  return [];
}

// M2：version 是有效 semver（Zod 已校验），额外禁止 0.0.0 与 0.0.0-xxx
export function ruleVersion(manifest: PluginManifest): ManifestError[] {
  const v = manifest.version;
  if (v === '0.0.0' || v.startsWith('0.0.0-')) {
    return [
      {
        code: 'invalid_version',
        path: 'version',
        message: `version "${v}" 不允许以 0.0.0 开头`,
      },
    ];
  }
  return [];
}

// M3-M6：entry 扩展名与 runtime_type 匹配
export function ruleEntryRuntimeMatch(manifest: PluginManifest): ManifestError[] {
  const { runtime_type, entry } = manifest;

  // client → .html
  if (runtime_type === 'client' && !entry.endsWith('.html')) {
    return [
      {
        code: 'entry_runtime_mismatch',
        path: 'entry',
        message: `client 运行时入口必须以 .html 结尾，实际："${entry}"`,
      },
    ];
  }

  // nodejs → .js / .mjs / .cjs
  if (
    runtime_type === 'nodejs' &&
    !entry.endsWith('.js') &&
    !entry.endsWith('.mjs') &&
    !entry.endsWith('.cjs')
  ) {
    return [
      {
        code: 'entry_runtime_mismatch',
        path: 'entry',
        message: `nodejs 运行时入口必须以 .js / .mjs / .cjs 结尾，实际："${entry}"`,
      },
    ];
  }

  // python → .py
  if (runtime_type === 'python' && !entry.endsWith('.py')) {
    return [
      {
        code: 'entry_runtime_mismatch',
        path: 'entry',
        message: `python 运行时入口必须以 .py 结尾，实际："${entry}"`,
      },
    ];
  }

  // cloud → URL (https?://)
  if (runtime_type === 'cloud' && !/^https?:\/\//.test(entry)) {
    return [
      {
        code: 'entry_runtime_mismatch',
        path: 'entry',
        message: `cloud 运行时入口必须是 URL (https?://...)，实际："${entry}"`,
      },
    ];
  }

  return [];
}

// M11：cloud / workflow 运行时本地桌面壳不支持（仅警告，不阻塞）。
// 这两个 runtime_type 仅由平台云端托管；本地桌面工作台是零服务端模型，
// 不会运行它们。保留 entry 既有规则（如 cloud 仍需 URL）不变，这里仅补充提示。
export function ruleRuntimeLocallySupported(manifest: PluginManifest): ManifestError[] {
  const { runtime_type } = manifest;
  if (runtime_type === 'cloud' || runtime_type === 'workflow') {
    return [
      {
        code: 'runtime_locally_unsupported',
        path: 'runtime_type',
        severity: 'warning',
        message: `runtime_type "${runtime_type}" 由平台云端托管，本地桌面工作台（零服务端模型）不支持；该插件需通过平台云端运行。`,
      },
    ];
  }
  return [];
}

// M7：capabilities[].kind 必须在 CapabilityKind 枚举中
const VALID_CAPABILITY_KINDS = new Set<string>(CapabilityKindSchema.options);

export function ruleKnownCapability(manifest: PluginManifest): ManifestError[] {
  const errors: ManifestError[] = [];
  for (let i = 0; i < manifest.capabilities.length; i++) {
    const cap = manifest.capabilities[i];
    if (!VALID_CAPABILITY_KINDS.has(cap.kind)) {
      errors.push({
        code: 'unknown_capability',
        path: `capabilities[${i}].kind`,
        message: `未知能力 "${cap.kind}"，合法值：${CapabilityKindSchema.options.join(', ')}`,
      });
    }
  }
  return errors;
}

// M8：capabilities[].reason 当 risk >= medium 时不应为空
export function ruleMissingReason(manifest: PluginManifest): ManifestError[] {
  const errors: ManifestError[] = [];
  for (let i = 0; i < manifest.capabilities.length; i++) {
    const cap = manifest.capabilities[i];
    if ((cap.risk === 'medium' || cap.risk === 'high') && !cap.reason.trim()) {
      errors.push({
        code: 'missing_reason',
        path: `capabilities[${i}].reason`,
        message: `能力 "${cap.kind}" 风险等级为 ${cap.risk}，必须填写 reason 说明用途`,
      });
    }
  }
  return errors;
}

// M9：capabilities 不允许重复声明同一 kind
export function ruleDuplicateCapability(manifest: PluginManifest): ManifestError[] {
  const errors: ManifestError[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < manifest.capabilities.length; i++) {
    const kind = manifest.capabilities[i].kind;
    if (seen.has(kind)) {
      errors.push({
        code: 'duplicate_capability',
        path: `capabilities[${i}].kind`,
        message: `能力 "${kind}" 重复声明`,
      });
    }
    seen.add(kind);
  }
  return errors;
}

// M10：entry 文件路径安全（不包含 ..、非绝对路径、无反斜杠）
export function ruleUnsafeEntryPath(manifest: PluginManifest): ManifestError[] {
  const { entry } = manifest;

  if (entry.includes('..')) {
    return [
      {
        code: 'unsafe_entry_path',
        path: 'entry',
        message: `entry 路径不能包含 ".."："${entry}"`,
      },
    ];
  }

  // 绝对路径：Unix 以 / 开头，Windows 以盘符 C:\ 等形式
  if (entry.startsWith('/') || /^[A-Za-z]:[/\\]/.test(entry)) {
    return [
      {
        code: 'unsafe_entry_path',
        path: 'entry',
        message: `entry 不能是绝对路径："${entry}"`,
      },
    ];
  }

  // 反斜杠（Windows 路径分隔符）
  if (entry.includes('\\')) {
    return [
      {
        code: 'unsafe_entry_path',
        path: 'entry',
        message: `entry 路径不能包含反斜杠 "\\"："${entry}"`,
      },
    ];
  }

  return [];
}

// LF-23：fs.read / fs.write 必须声明非空 paths 白名单——
// 空白名单意味着该能力恒 OutOfScope（fail-closed 但功能断裂），是配置错误而非运行时报错。
export function ruleFsScopeRequiresPaths(manifest: PluginManifest): ManifestError[] {
  const errors: ManifestError[] = [];
  for (let i = 0; i < manifest.capabilities.length; i++) {
    const cap = manifest.capabilities[i];
    if ((cap.kind === 'fs.read' || cap.kind === 'fs.write') && (cap.paths?.length ?? 0) === 0) {
      errors.push({
        code: 'fs_scope_requires_paths',
        path: `capabilities[${i}].paths`,
        message: `能力 "${cap.kind}" 必须声明非空 paths 白名单（如 ["$HOME/Documents"]）`,
      });
    }
  }
  return errors;
}

/** 所有业务规则的有序数组，供测试逐条验证。 */
export const RULES: Array<(manifest: PluginManifest) => ManifestError[]> = [
  ruleId,
  ruleVersion,
  ruleEntryRuntimeMatch,
  ruleRuntimeLocallySupported,
  ruleKnownCapability,
  ruleMissingReason,
  ruleDuplicateCapability,
  ruleUnsafeEntryPath,
  ruleFsScopeRequiresPaths,
];
