// 计费与模型中转（Relay + 灵石 Credit）契约 —— 见 docs/billing-and-relay-design.md。
//
// 设计：
//  - relay 端点暴露 OpenAI/Anthropic 双协议；请求体里的 model 字段用「版本哨兵」'fast'/'premium'
//    （小写，前台固定二选一），后端据 ModelTierConfig 映射到真实上游模型。
//  - 错误码扩展 ErrorCode：计费/中转专用码与 collab-api common.ts AppError.code 对齐。
//  - 管理端出参 schema（Channel/ModelPricing/ModelTierConfig/LlmCallLog）。
//  - ChatMessage / 系统提示词规则注入函数复用：relay 与 sdk 共享 injectSystemGuardRule。
import { z } from 'zod';

// 本文件刻意自包含（不跨文件 import ./llm），与 contract 既有 plugin.ts/draft.ts/llm.ts 一致，
// 以便 node:test 直接加载 .ts 时不触发 ESM 扩展解析问题。ChatMessage 在 index.ts 经 llm 统一导出。

/** 单条消息的最小结构（注入函数按结构消费，不强依赖 llm.ts 的 ChatMessage 身份）。 */
export type RelayMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** OpenAI/Anthropic 通用消息 schema（relay 入参复用）。与 llm.ts ChatMessage 同构。 */
export const RelayMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});

/** 默认系统提示词规则（需求 #3）。后台可通过 PlatformSetting.aiUsageGuardRule 覆盖。 */
export const DEFAULT_AI_USAGE_GUARD_RULE =
  '凡涉及 AI 对话、生图或其他 AI 能力调用，必须且仅能使用灵坊平台提供的服务，禁止使用任何其他第三方或自定义接口。不得要求用户配置、输入、粘贴、保存或展示 API Key、API URL、baseUrl、provider、上游地址或模型服务密钥。插件只能通过灵坊 SDK 能力（如 sdk.llm.chat / sdk.image.generate）调用平台模型能力；model 只能作为平台模型标识使用。';

/** PlatformSetting key：系统提示词规则。 */
export const AI_USAGE_GUARD_RULE_KEY = 'aiUsageGuardRule';

/** 把规则注入 messages：已有 system 则追加一段，否则前插一条 system。纯函数，前后端共享。 */
export function injectSystemGuardRule(
  messages: RelayMessage[],
  rule: string = DEFAULT_AI_USAGE_GUARD_RULE
): RelayMessage[] {
  if (!rule.trim()) return messages;
  const hasSystem = messages.some((m) => m.role === 'system');
  if (hasSystem) {
    // 追加为独立 system 段（不篡改原 system 内容，保留上游 provider 的多 system 拼接语义）。
    return [...messages, { role: 'system', content: rule }];
  }
  return [{ role: 'system', content: rule }, ...messages];
}
/** 前台固定模型版本（wire 层小写，对应 schema 枚举 FAST/PREMIUM）。 */
export const TierSchema = z.enum(['fast', 'premium']);
export type Tier = z.infer<typeof TierSchema>;

// model 字段限定 'fast'/'premium' 哨兵；relay 据此映射真实上游模型（协议层强制两版本）。

/** POST /api/relay/v1/chat/completions 入参（OpenAI chat shape，model 限版本哨兵）。 */
export const ChatRelayInputSchema = z.object({
  model: TierSchema.default('fast'),
  messages: z.array(RelayMessageSchema).min(1),
  temperature: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
  // 透传其他 OpenAI 兼容字段（top_p 等），relay 原样转发；此处不锁死以兼容上游差异。
});
export type ChatRelayInput = z.infer<typeof ChatRelayInputSchema>;

/** POST /api/relay/v1/messages 入参（Anthropic messages shape，model 限版本哨兵）。 */
export const MessagesRelayInputSchema = z.object({
  model: TierSchema.default('fast'),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).min(1),
  system: z.string().optional(),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  stream: z.boolean().optional(),
});
export type MessagesRelayInput = z.infer<typeof MessagesRelayInputSchema>;

/** POST /api/relay/v1/images/generations 入参（按张计费）。 */
export const ImageRelayInputSchema = z.object({
  model: TierSchema.default('fast'),
  prompt: z.string().min(1),
  n: z.number().int().positive().max(10).optional(),
  size: z.string().optional(),
});
export type ImageRelayInput = z.infer<typeof ImageRelayInputSchema>;

/** GET /api/relay/v1/models 出参：返回当前团队资源池实际可用的 fast/premium 子集。 */
export const RelayModelSchema = z.object({
  id: TierSchema,
  object: z.literal('model').optional(),
  owned_by: z.literal('lingfang').optional(),
});
export const RelayModelsResponseSchema = z.object({
  object: z.literal('list').optional(),
  data: z.array(RelayModelSchema),
});

// === 计费/中转错误码（与 collab-api common.ts AppError.code 对齐） ===
export const BillingErrorCode = z.enum([
  'insufficient_balance', // 402：团队灵石余额不足
  'unsupported_model', // 400：model 非版本哨兵且不在白名单
  'no_channel_available', // 503：无渠道可服务该团队/版本
  'upstream_llm_error', // 502：上游 provider 返回错误
  'capability_denied', // 403：插件 manifest 未声明本次能力
  'reserve_failed', // 402：预扣失败（并发或配置异常）
]);
export type BillingErrorCode = z.infer<typeof BillingErrorCode>;

// === 管理端出参（与 prisma schema 字段一一对应，camelCase） ===

export const ChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  protocol: z.enum(['OPENAI', 'ANTHROPIC']),
  provider: z.string(),
  baseUrl: z.string(),
  upstreamKeyHint: z.string(),
  hasUpstreamKey: z.boolean(), // 是否已配置上游 key（不回明文/密文）
  supportedModels: z.array(z.string()),
  supportedTiers: z.array(TierSchema),
  status: z.enum(['ENABLED', 'DISABLED']),
  priority: z.number().int(),
  weight: z.number().int(),
  description: z.string(),
  lastHealthAt: z.string().nullable(),
  lastHealthOk: z.boolean().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ModelPricingSchema = z.object({
  id: z.string(),
  capability: z.enum(['chat', 'image', 'action']),
  model: z.string(),
  label: z.string(),
  unit: z.enum(['PER_TOKEN_INPUT', 'PER_TOKEN_OUTPUT', 'PER_CALL', 'PER_IMAGE']),
  pricePerUnit: z.number().int(),
  tier: TierSchema.nullable(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ModelTierConfigSchema = z.object({
  tier: TierSchema,
  label: z.string(),
  chatModel: z.string(),
  imageModel: z.string().nullable(),
  temperature: z.number().nullable(),
  maxTokens: z.number().int().nullable(),
  extraParams: z.record(z.unknown()),
});

export const LlmCallLogSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  userId: z.string().nullable(),
  channelId: z.string().nullable(),
  clientSource: z.enum(['platform', 'plugin_runtime', 'plugin_test']),
  capability: z.string(),
  tier: TierSchema.nullable(),
  model: z.string(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  images: z.number().int(),
  durationMs: z.number().int(),
  credits: z.number().int(),
  status: z.string(),
  httpStatus: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  requestId: z.string().nullable(),
  requestSummary: z.record(z.unknown()),
  clientIp: z.string().nullable(),
  createdAt: z.string(),
});
