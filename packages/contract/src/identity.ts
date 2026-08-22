// 身份与租户契约（见 docs/02 §A）。
// CONTRACT-02 / CONTRACT-07 修复：原契约字段全为 snake_case，与已收敛到 NestJS+Prisma+PostgreSQL 的
// collab-api HTTP DTO 命名（一律 camelCase）系统性漂移；现在 dead schema（HTTP 响应类型）已对齐后端，
// 仍保留运行时实际在用的 PluginManifest/CapabilityKind/PluginCapability/RuntimeType 等 manifest 边界
// （snake_case 与 manifest.json 自洽）。
import { z } from 'zod';

// 契约仅保留 manifest 边界需要的 TenantRole 别名（与 PluginGrant 主体配合使用）。
// HTTP 响应侧的 user/team/session 不再以 dead schema 形式声明（见本文件末注释）。
//
// ⚠️ DRIFT 收敛（RBAC 任务）：TenantRole（owner|admin|developer|member）为历史 dead schema，
// 与实际 Prisma 角色模型（TeamRole=TEAM_ADMIN|MEMBER）不符。实际角色系统以 ./rbac.ts 的 Role 模型为准
// （PLATFORM/TEAM 两层 scope + 预定义权限码）。新代码请勿引用 TenantRole 做业务判断；
// 此处仅保留供 PluginGrant resolveGrant() 的 role 字符串参数兼容，后续随插件授权重构一并清理。
export const TenantRole = z.enum(['owner', 'admin', 'developer', 'member']);
export type TenantRole = z.infer<typeof TenantRole>;

// —— 请求 ——
// CONTRACT-07 修复：对齐 collab-api auth.controller.ts 的真实注册请求体（camelCase + 申请相关字段）。
export const RegisterRequest = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1),
  wantsTeamAdmin: z.boolean().optional(),
  teamName: z.string().optional(),
  reason: z.string().optional(),
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const LoginRequest = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

// CONTRACT-07 修复：登录响应与 auth.service.ts sessionFor 返回结构对齐——
// 嵌套 user/team/application/onboarding，而非扁平 user_id/tenant_id/role。
// 注意：HTTP 响应契约当前为 dead schema（无运行时消费者），声明意图仅是"对齐未来可能的客户端校验"。
export const AuthSession = z.object({
  token: z.string().min(1).optional(),
  user: z.object({
    id: z.string().min(1),
    email: z.string().email(),
    displayName: z.string().min(1),
    platformRole: z.enum(['NONE', 'PLATFORM_ADMIN']),
    status: z.enum(['ACTIVE', 'DISABLED']),
  }),
  team: z
    .object({
      id: z.string().min(1),
      name: z.string().min(1),
      slug: z.string().min(1),
      role: z.string().min(1),
    })
    .nullable(),
  application: z
    .object({
      id: z.string().min(1),
      status: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
      teamName: z.string().min(1),
      reviewReason: z.string().optional(),
    })
    .nullable(),
  onboarding: z.enum([
    'NEEDS_INVITATION',
    'PENDING_APPROVAL',
    'APPLICATION_REJECTED',
    'TEAM_SPACE',
    'TEAM_ADMIN_SPACE',
    'PLATFORM_ADMIN_WEB_ONLY',
  ]),
});
export type AuthSession = z.infer<typeof AuthSession>;

// 原本还声明了 User/Tenant/Membership/CreateTenantRequest/InviteMemberRequest 等 dead schema，
// 这些类型在后端是 Prisma 模型直接序列化 camelCase，前端用本地类型（types.ts）消费；
// 为避免契约继续声明不存在的 HTTP 边界而误导，已移除——manifest 边界所需的类型在 plugin.ts 中保留。
