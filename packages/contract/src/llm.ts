// LLM 相关契约（旧 BYOK/provider 兼容层）。
//
// 当前产品主链路已迁移到 `billing.ts` 的平台 relay：插件、Agent、桌面创建器均走
// `/api/relay/v1/*`，用户界面不再提供个人 API Key / API URL / provider 配置。
// 本文件保留旧 provider/binding schema 供历史类型引用；新模型调用契约不要从这里新增入口。
//
// 旧设计（06-14-model-gateway-final-single-provider）曾包含：
//  - 应用界面零 provider 概念：用户只看到「一个 apiKey 输入 + 拉取模型 + 模型选择」。
//  - 平台 Admin 维护多 provider（LlmGateway 表）+ 设一个「当前启用」（isActive=true，全表最多一条）。
//  - 应用拉取当前启用 provider 的 apiUrl，用户填 key 用它。Admin 切 provider，用户无感知（重填 key + 拉模型）。
//  - TenantLlmBinding 去 gatewayId，userId @unique（一个用户一条 apiKey 绑定）。
//
// 契约：
//  - ActiveProviderSchema：GET /api/llm/active-provider 出参（当前启用 provider 的 provider/apiUrl + defaultModels）。
//  - TenantBindingPublicSchema：GET /api/llm/binding 出参（当前用户单条，脱敏，零解密，无 gatewayId/provider）。
//  - BindingUpsertInputSchema：PUT /api/llm/binding 入参（apiKey 可选语义见 design.md B5）。
//  - ProviderCreateInputSchema / ProviderUpdateInputSchema：平台 Admin provider 增改入参。
//  - LlmErrorCode：错误码（含 no_active_provider）。
//  - ChatMessage：plugin-sdk 的本地 ChatMessage 与之同名但未复用契约；此处保留以便未来插件复用。
//  - ErrorCode：业务通用错误码集合（与 collab-api common.ts AppError.code 对齐）。
import { z } from 'zod';

export const ChatMessage = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

// 统一错误码（显式失败，不伪造结果）。
// 注意：与 collab-api common.ts AppError 的 code 字段对齐——以下 code 名均为后端实际产出的稳定码。
export const ErrorCode = z.enum([
  'llm_binding_missing',
  'generation_invalid',
  'capability_denied',
  'unauthorized',
  'not_found',
  'bad_request',
  'forbidden',
  'insufficient_balance',
  'payment_required',
  'upstream_llm_error',
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

// LLM 网关/绑定专属错误码（与 collab-api common.ts AppError.code 对齐，前端按 code 分支处理）。
export const LlmErrorCode = z.enum([
  'no_active_provider', // 平台未配置当前启用 provider（无 isActive=true），应用提示「平台尚未配置模型服务」
  'provider_not_found', // Admin 操作目标 provider 不存在
  'provider_active_not_deletable', // 试图删除当前启用的 provider（需先切换到其他 provider）
  'binding_not_found', // 当前用户尚未绑定（config-only PUT 无原密可改 / decrypt 无绑定）
  'llm_key_decrypt_failed', // 密文被篡改/密钥不匹配，AES-GCM tag 校验失败
  'llm_key_not_configured', // 服务端 LLM_KEY_ENCRYPTION_KEY 未配置，无法加解密
  'install_unsupported', // 保留兼容旧客户端；桌面端不再自动安装运行时
  'install_failed', // 保留兼容旧客户端；运行时应随应用内置打包
]);
export type LlmErrorCode = z.infer<typeof LlmErrorCode>;

// === 平台 Admin provider 目录契约 ===

/** GET /api/admin/llm-providers 单条出参（含 DISABLED + isActive 全字段）。 */
export const LlmProviderAdminSchema = z.object({
  id: z.string(),
  provider: z.string(),
  name: z.string(),
  apiUrl: z.string(),
  status: z.enum(['ENABLED', 'DISABLED']),
  models: z.array(z.string()).default([]),
  description: z.string().default(''),
  sortOrder: z.number().default(0),
  isActive: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LlmProviderAdmin = z.infer<typeof LlmProviderAdminSchema>;

// === 当前启用 provider 契约（应用拉取用） ===

/** GET /api/llm/active-provider 出参（当前启用 provider 的 provider/apiUrl + defaultModels，不暴露「有多个」）。
 *  无启用 provider → 404 `no_active_provider`。 */
export const ActiveProviderSchema = z.object({
  name: z.string().optional(), // 展示名（可选，应用通常不展示）
  provider: z.string(), // provider 类型（用于客户端选择兼容 CLI/protocol，不在用户界面展示）
  apiUrl: z.string(), // 拉取模型用的 API 基址
  defaultModels: z.array(z.string()).default([]), // provider 声明的默认模型清单（占位/兜底）
});
export type ActiveProvider = z.infer<typeof ActiveProviderSchema>;

// === 用户绑定契约（单条，无 gatewayId/provider） ===

/** GET /api/llm/binding 出参（当前用户单条，脱敏，零解密）。
 *  去 gatewayId/provider/gatewayName/apiUrl/gatewayStatus/gatewayModels/effectiveModels。
 *  modelOverride 为用户从拉取结果选的模型列表（string[]|null）。 */
export const TenantBindingPublicSchema = z.object({
  id: z.string(),
  apiKeyHint: z.string(), // 脱敏串（如 sk-1***wxyz），非密文非明文
  keyFingerprint: z.string(), // sha256(明文).slice(0,16)，稳定标识「这是哪个 key」
  enabled: z.boolean(),
  modelOverride: z.array(z.string()).nullable(), // 用户从拉取结果选的模型列表；null=未选
  updatedBy: z.object({ id: z.string(), displayName: z.string() }).nullable(),
  updatedAt: z.string(),
});
export type TenantBindingPublic = z.infer<typeof TenantBindingPublicSchema>;

/** PUT /api/llm/binding 入参（无 gatewayId，按 userId 唯一 upsert）。
 *  apiKey 语义（design.md B5）：
 *  - undefined：保留原密，仅改 enabled/modelOverride（kind=config_only）；
 *  - 非空：重新加密 + 轮换 hint/fingerprint（kind=key_rotated 或 create）。 */
export const BindingUpsertInputSchema = z.object({
  apiKey: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  modelOverride: z.array(z.string()).nullable().optional(),
});
export type BindingUpsertInput = z.infer<typeof BindingUpsertInputSchema>;

// === 平台 Admin provider 增改入参 ===

/** POST /api/admin/llm-providers 入参。
 *  - provider 为 String（非 enum），平台维护白名单（见 enums.ts LLM_PROVIDER）。
 *  - apiUrl 服务端规范化去尾斜杠（service 内 normalizeApiUrl）。
 *  - name 唯一（DB 约束 + seed upsert 幂等）。
 *  - isActive 不在此设，通过 PATCH /:id/activate 端点事务维护唯一。 */
export const ProviderCreateInputSchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1),
  apiUrl: z.string().min(1),
  models: z.array(z.string()).optional(),
  description: z.string().optional(),
  sortOrder: z.number().min(0).optional(),
  status: z.enum(['ENABLED', 'DISABLED']).optional(),
});
export type ProviderCreateInput = z.infer<typeof ProviderCreateInputSchema>;

/** PATCH /api/admin/llm-providers/:id 入参（全可选）。 */
export const ProviderUpdateInputSchema = ProviderCreateInputSchema.partial();
export type ProviderUpdateInput = z.infer<typeof ProviderUpdateInputSchema>;
