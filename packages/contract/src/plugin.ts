// 插件与能力契约（见 docs/02 §B）。
// CONTRACT-04 修复：Plugin（HTTP 响应类型，dead schema）的 visibility/status 枚举对齐
// collab-api plugin-package.ts publicPlugin 实际输出（visibility 含 public、status enabled/disabled）。
// 注意：PluginManifest 的 visibility 仍仅允许 private/tenant（上传入口不应携带 public，
// public 由市场审核赋予），不要改。
import { z } from 'zod';
import { StrictSemVer } from './semver.ts';
import {
  ACTION_DEPENDENCY_MAX_COUNT,
  ACTION_MAX_COUNT,
  PluginAction,
  PluginActionDependency,
} from './plugin-action.ts';
import { SharedNamespaceDeclaration } from './plugin-shared-state.ts';

// 运行时类型四值：client（浏览器侧 HTML/iframe）/ cloud（云端执行）/
// nodejs / python（脚本型，由桌面壳本地预览执行，见 R3）。
export const RuntimeType = z.enum(['client', 'cloud', 'nodejs', 'python', 'workflow']);
export type RuntimeType = z.infer<typeof RuntimeType>;

export const CapabilityKind = z.enum([
  'ui.view',
  'fs.pick',
  'fs.read',
  'fs.write',
  'net.fetch',
  'clipboard',
  'llm.chat',
  'image.generate',
  'image.edit',
  'storage.kv',
  'system.info',
  'system.screenshot',
  'system.notify',
  'plugin.upload',
  'plugin.submitMarketplace',
  'video.generate',
  'audio.generate',
]);
export type CapabilityKind = z.infer<typeof CapabilityKind>;

export const CapabilityRisk = z.enum(['none', 'low', 'medium', 'high']);
export type CapabilityRisk = z.infer<typeof CapabilityRisk>;

// manifest 边界字段为 snake_case，与 manifest.json 自洽（运行时实际在用，不要改 camelCase）。
export const PluginCapability = z.object({
  kind: CapabilityKind,
  reason: z.string().max(500).default(''),
  risk: CapabilityRisk.default('low'),
  requires_admin: z.boolean().default(false),
  // fs.read / fs.write 的路径白名单模板（$HOME 等由宿主展开）。
  // QX-23 缺陷修复：此前缺失导致 validate/build 往返把 paths 剥离，
  // 安装后 fs.read 恒 OutOfScope（fail-closed 但功能断裂）。
  paths: z.array(z.string()).default([]),
  scope: z.record(z.unknown()).optional(),
});
export type PluginCapability = z.infer<typeof PluginCapability>;

// 插件清单（也是 AI 生成时必须产出的 manifest.json 结构）。
// manifest 边界字段为 snake_case，与 manifest.json 自洽。
export const PluginManifest = z
  .object({
    id: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(128),
    version: StrictSemVer,
    description: z.string().max(4096).default(''),
    runtime_type: RuntimeType.default('client'),
    entry: z.string().trim().min(1).max(512),
    // manifest 上传入口 visibility 仅允许 private/tenant；public 由审核流程赋予，不在上传字段。
    visibility: z.enum(['private', 'tenant']).default('tenant'),
    capabilities: z.array(PluginCapability).max(64).default([]),
    // Action exports and dependencies are optional for backwards compatibility.
    actions: z.array(PluginAction).max(ACTION_MAX_COUNT).default([]),
    action_dependencies: z
      .array(PluginActionDependency)
      .max(ACTION_DEPENDENCY_MAX_COUNT)
      .default([]),
    shared_namespaces: z.array(SharedNamespaceDeclaration).max(16).default([]),
  })
  .superRefine((manifest, ctx) => {
    const actionIds = new Set<string>();
    manifest.actions.forEach((action, index) => {
      if (actionIds.has(action.action_id))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['actions', index, 'action_id'],
          message: 'action_id must be unique within a manifest',
        });
      actionIds.add(action.action_id);
      if (manifest.runtime_type === 'cloud' || manifest.runtime_type === 'workflow') {
        if (action.handler)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['actions', index, 'handler'],
            message: `${manifest.runtime_type} actions must not declare a package handler`,
          });
      } else if (!action.handler) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['actions', index, 'handler'],
          message: `${manifest.runtime_type} actions require a handler`,
        });
      } else if (manifest.runtime_type === 'python' && !('callable' in action.handler)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['actions', index, 'handler'],
          message: 'python actions require a callable handler',
        });
      } else if (manifest.runtime_type !== 'python' && !('export' in action.handler)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['actions', index, 'handler'],
          message: `${manifest.runtime_type} actions require an export handler`,
        });
      }
    });
    const dependencyIds = new Set<string>();
    manifest.action_dependencies.forEach((dependency, index) => {
      if (dependencyIds.has(dependency.dependency_id))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['action_dependencies', index, 'dependency_id'],
          message: 'dependency_id must be unique within a manifest',
        });
      dependencyIds.add(dependency.dependency_id);
    });
    const namespaceNames = new Set<string>();
    manifest.shared_namespaces.forEach((namespace, index) => {
      if (namespaceNames.has(namespace.name))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['shared_namespaces', index, 'name'],
          message: 'shared namespace name must be unique',
        });
      namespaceNames.add(namespace.name);
    });
  });
export type PluginManifest = z.infer<typeof PluginManifest>;

// CONTRACT-04 修复：已发布插件的 HTTP 响应 dead schema（无运行时消费者）。
// 对齐 collab-api plugin-package.ts publicPlugin 实际返回：
//  - visibility 大写枚举 PRIVATE/TEAM/PUBLIC（后端 plugin-package.ts:191 原样透传 Prisma 值）。
//  - status 大写枚举 ENABLED/DISABLED（后端 plugin-package.ts:190 原样透传 Prisma 值）。
// 注意此为 HTTP 响应类型，与 PluginManifest（manifest 边界）的 visibility 取值集合不同——
// 前者只允许 private/tenant（上传），后者反映审核后的实际可见范围（含 public）。
export const Plugin = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().default(''),
  teamId: z.string().nullable(),
  authorUserId: z.string().nullable(),
  runtimeType: z.enum(['CLIENT', 'CLOUD', 'NODEJS', 'PYTHON']),
  entry: z.string().min(1),
  capabilities: z.array(PluginCapability).default([]),
  visibility: z.enum(['PRIVATE', 'TEAM', 'PUBLIC']).default('PRIVATE'),
  status: z.enum(['ENABLED', 'DISABLED']).default('ENABLED'),
  reviewStatus: z.enum(['DRAFT', 'PENDING', 'APPROVED', 'REJECTED']).default('DRAFT'),
  marketplace: z.boolean().default(false),
  priceCents: z.number().int().nonnegative().default(0),
  installCount: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Plugin = z.infer<typeof Plugin>;

// CONTRACT-04 修复：安装记录同样对齐 Prisma 大写枚举。
export const PluginInstallation = z.object({
  teamId: z.string().min(1),
  pluginId: z.string().min(1),
  version: z.string().min(1),
  status: z.enum(['INSTALLED', 'DISABLED']).default('INSTALLED'),
  installedBy: z.string().min(1),
  installedAt: z.string().datetime(),
});
export type PluginInstallation = z.infer<typeof PluginInstallation>;

// PluginGrant 字段为 snake_case。legacy plugin_id 已退役，package_id 是唯一插件身份。
export const PluginGrant = z.object({
  tenant_id: z.string().min(1),
  package_id: z.string().min(1),
  subject_kind: z.enum(['user', 'role']),
  subject_id: z.string().min(1),
  effect: z.enum(['allow', 'deny']),
});
export type PluginGrant = z.infer<typeof PluginGrant>;

/** 授权解析：deny 优先；user 级优先于 role 级；无 grant 默认可用。管理员无运行时绕过。 */
export function resolveGrant(grants: PluginGrant[], userId: string, role: string): boolean {
  const userGrants = grants.filter((g) => g.subject_kind === 'user' && g.subject_id === userId);
  if (userGrants.some((g) => g.effect === 'deny')) return false;
  if (userGrants.some((g) => g.effect === 'allow')) return true;
  const roleGrants = grants.filter((g) => g.subject_kind === 'role' && g.subject_id === role);
  if (roleGrants.some((g) => g.effect === 'deny')) return false;
  if (roleGrants.some((g) => g.effect === 'allow')) return true;
  return true;
}
