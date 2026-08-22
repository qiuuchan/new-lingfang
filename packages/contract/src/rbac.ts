// RBAC（角色 + 权限码 + 插件授权）契约（见 .trellis 权限系统完善任务）。
//
// 设计要点：
//  - 角色分两层 scope：PLATFORM（平台级，管平台资源，全局唯一）/ TEAM（团队级，归属某 team）。
//  - 权限码为代码注册表预定义（不可由用户自由新增），字符串形如 "team.member.invite"。
//  - 权限按「模块 → 操作」两级组织：moduleKey（如 team.plugin）+ moduleLabel（如「插件管理」），
//    前端按模块折叠展示两级勾选树。group 字段 = moduleKey，保留向后兼容。
//  - 权限组（PermissionGroup）显示名可由管理员自定义：覆盖内置 moduleLabel，不影响权限码本身。
//  - 角色编码 code：可选、同 scope+teamId 下唯一（如 admin/operator）。内置角色 seed 固定 code。
//  - 插件授权走独立表：团队管理员为团队内插件按 user/role 设置 allow/deny，deny 优先。
//  - 契约字段一律 camelCase（与 collab-api HTTP 响应 / Prisma 模型对齐，见 identity.ts CONTRACT-07）。
//
// 注意：identity.ts 中的 TenantRole（owner|admin|developer|member）为历史 dead schema，
// 实际角色以本文件 Role 模型为准；新代码不要引用 TenantRole。
import { z } from 'zod';

/** 角色 scope：PLATFORM 平台级（全局）/ TEAM 团队级（归属某 team）。 */
export const RoleScope = z.enum(['PLATFORM', 'TEAM']);
export type RoleScope = z.infer<typeof RoleScope>;

/** 插件授权主体类型：USER 指定用户 / ROLE 指定角色（对该角色下所有成员生效）。 */
export const PluginGrantSubject = z.enum(['USER', 'ROLE']);
export type PluginGrantSubject = z.infer<typeof PluginGrantSubject>;

/** 插件授权效果：ALLOW 放行 / DENY 拒绝（deny 优先，见 resolvePluginAccess）。 */
export const PluginGrantEffect = z.enum(['ALLOW', 'DENY']);
export type PluginGrantEffect = z.infer<typeof PluginGrantEffect>;

/** 权限码注册表镜像（HTTP 响应，供前端 admin 展示/分组勾选）。权限码本体由后端 permission-codes.ts 定义。 */
export const PermissionEntry = z.object({
  code: z.string().min(1),
  label: z.string(),
  scope: RoleScope,
  /** 分组键（= moduleKey，向后兼容保留）。通常取 code 去掉最后一段 action。 */
  group: z.string(),
  /** 模块键：权限所属功能模块（如 team.plugin）。等于 group，新代码优先用 moduleKey。 */
  moduleKey: z.string(),
  /** 模块显示名（如「插件管理」），前端两级树父级标题。 */
  moduleLabel: z.string(),
  /** 模块排序（升序），同模块多权限共享同一值。 */
  moduleOrder: z.number().int().default(0),
  description: z.string().default(''),
  createdAt: z.string().datetime(),
});
export type PermissionEntry = z.infer<typeof PermissionEntry>;

/** 权限模块定义（两级结构的父级：模块 → 操作列表）。 */
export const PermissionModule = z.object({
  moduleKey: z.string().min(1),
  moduleLabel: z.string(),
  scope: RoleScope,
  sortOrder: z.number().int().default(0),
  /** 是否内置模块（不可删除显示名覆盖）。前端按此判定可编辑性。 */
  isSystem: z.boolean().default(true),
});
export type PermissionModule = z.infer<typeof PermissionModule>;

/**
 * 权限组（可编辑分组显示名）。
 * 管理员可对每个 moduleKey 自定义显示名（覆盖内置 moduleLabel）；不可新增/删除权限码本身。
 * 内置分组（isSystem=true，seed 写入）不可删；自定义覆盖行（isSystem=false）可删。
 */
export const PermissionGroup = z.object({
  scope: RoleScope,
  groupKey: z.string().min(1),
  displayName: z.string().min(1),
  sortOrder: z.number().int().default(0),
  isSystem: z.boolean().default(false),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PermissionGroup = z.infer<typeof PermissionGroup>;

/** 角色（HTTP 响应，对齐 Prisma Role 模型 camelCase）。 */
export const Role = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** 角色编码：可选、同 scope+teamId 下唯一（如 admin/operator）。内置角色固定（platform_admin/team_admin/team_member）。 */
  code: z.string().nullable(),
  scope: RoleScope,
  teamId: z.string().nullable(),
  isSystem: z.boolean().default(false),
  description: z.string().default(''),
  permissions: z.array(z.string()).default([]),
  memberCount: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Role = z.infer<typeof Role>;

/**
 * 团队成员（HTTP 响应，对齐 team.service.ts currentMembers 返回结构）。
 *
 * RBAC 扩展（向后兼容）：roleName/roleCode/teamRoleId 为 optional，
 * 经 teamRoleId 关联到 Role 取值；旧客户端忽略这些字段仍可正常工作。
 * role（TeamRole 枚举）保留以兼容过渡期；新展示请优先用 roleName。
 */
export const TeamMember = z.object({
  teamId: z.string().min(1),
  userId: z.string().min(1),
  role: z.string(),
  teamRoleId: z.string().nullable().optional(),
  roleName: z.string().nullable().optional(),
  roleCode: z.string().nullable().optional(),
  joinedAt: z.string().datetime(),
  user: z.object({
    id: z.string().min(1),
    email: z.string().email(),
    displayName: z.string().min(1),
    status: z.string(),
  }),
});
export type TeamMember = z.infer<typeof TeamMember>;

/** 插件授权行（HTTP 响应，对齐 Prisma PluginGrant 模型 camelCase）。 */
export const PluginGrantRow = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1),
  packageId: z.string().min(1),
  subjectKind: PluginGrantSubject,
  subjectId: z.string().min(1),
  effect: PluginGrantEffect,
  createdBy: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type PluginGrantRow = z.infer<typeof PluginGrantRow>;

// ——— 请求体 DTO（创建/更新角色、设置插件授权） ———

/** 角色编码正则：小写字母/数字开头，允许小写字母、数字、下划线、连字符，1-64 字符。 */
export const ROLE_CODE_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const CreateRoleRequest = z.object({
  name: z.string().min(1).max(64),
  code: z
    .union([
      z
        .string()
        .regex(ROLE_CODE_REGEX, '编码只能包含小写字母、数字、下划线、连字符，须以字母或数字开头')
        .max(64),
      z.null(),
    ])
    .optional(),
  description: z.string().max(255).optional(),
  permissions: z.array(z.string().min(1)).default([]),
});
export type CreateRoleRequest = z.infer<typeof CreateRoleRequest>;

export const UpdateRoleRequest = z.object({
  name: z.string().min(1).max(64).optional(),
  code: z
    .union([
      z
        .string()
        .regex(ROLE_CODE_REGEX, '编码只能包含小写字母、数字、下划线、连字符，须以字母或数字开头')
        .max(64),
      z.null(),
    ])
    .optional(),
  description: z.string().max(255).optional(),
  permissions: z.array(z.string().min(1)).optional(),
});
export type UpdateRoleRequest = z.infer<typeof UpdateRoleRequest>;

export const AssignRoleRequest = z.object({
  userId: z.string().min(1),
  roleId: z.string().min(1),
});
export type AssignRoleRequest = z.infer<typeof AssignRoleRequest>;

export const SetPluginGrantRequest = z.object({
  subjectKind: PluginGrantSubject,
  subjectId: z.string().min(1),
  effect: PluginGrantEffect,
});
export type SetPluginGrantRequest = z.infer<typeof SetPluginGrantRequest>;

// ——— 权限组 DTO（管理员自定义分组显示名）———

/** upsert 权限组显示名请求体。groupKey 为已注册模块键（不允许新增模块）。 */
export const UpsertPermissionGroupRequest = z.object({
  groupKey: z.string().min(1).max(64),
  displayName: z.string().min(1).max(64),
});
export type UpsertPermissionGroupRequest = z.infer<typeof UpsertPermissionGroupRequest>;
