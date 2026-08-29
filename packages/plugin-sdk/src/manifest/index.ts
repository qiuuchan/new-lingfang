// manifest 校验入口：Zod schema + 业务规则双层校验。
// 导出 validateManifest 函数和 ManifestError / ManifestResult 类型。
// 同时透传 @qianxia/contract 的类型，让插件作者只需 import 这一个入口。
import { PluginManifest as PluginManifestSchema } from '@qianxia/contract';
import type { PluginManifest } from '@qianxia/contract';
import { RULES, type ManifestError } from './rules.ts';

export type { ManifestError } from './rules.ts';
export type {
  PluginManifest,
  PluginCapability,
  CapabilityKind,
  RuntimeType,
} from '@qianxia/contract';

export type ManifestResult =
  | { success: true; manifest: PluginManifest; warnings: ManifestError[] }
  | { success: false; errors: ManifestError[]; warnings: ManifestError[] };

/**
 * 校验插件 manifest（任意 JSON 输入）。
 *
 * 1. Zod schema 校验（字段类型、必填、枚举约束）
 * 2. 业务规则校验（id 命名、version 合法性、entry 匹配等规则）
 *
 * 返回 ManifestResult：success=true 时 manifest 为解析后的 PluginManifest；
 * success=false 时 errors 包含所有阻塞性违规（Zod + 业务规则合并）。
 * warnings 始终包含非阻塞性提示（如 cloud/workflow 本地不支持），
 * 无论 success 为 true 或 false 都会附带返回，但不会导致校验失败。
 */
export function validateManifest(input: unknown): ManifestResult {
  const parsed = PluginManifestSchema.safeParse(input);

  if (!parsed.success) {
    const errors: ManifestError[] = parsed.error.issues.map((issue) => ({
      code: 'schema_invalid',
      path: issue.path.join('.'),
      message: issue.message,
    }));
    return { success: false, errors, warnings: [] };
  }

  const manifest = parsed.data;

  // 逐条运行业务规则，按严重程度分流：error 阻塞，warning 仅提示
  const businessErrors: ManifestError[] = [];
  const warnings: ManifestError[] = [];
  for (const rule of RULES) {
    for (const err of rule(manifest)) {
      if (err.severity === 'warning') {
        warnings.push(err);
      } else {
        businessErrors.push(err);
      }
    }
  }

  if (businessErrors.length > 0) {
    return { success: false, errors: businessErrors, warnings };
  }

  return { success: true, manifest, warnings };
}
