// 插件草稿契约——产品核心对象（见 docs/02 §A、docs/01 §10 生成数据流）。
// CONTRACT-03 修复：枚举对齐桌面端 plugin-draft.ts 实际产出的 stage/status/value 集合。
// 原枚举过窄（status 仅 generating/ready/invalid/published、diagnostic status 仅 pass/fail、
// stage 仅 schema/security/preview），桌面端实际产出 partial/chat/warn/diagnostics/local-cli 等
// 一直被契约拒绝，导致 PluginDraft 作为校验依据名存实亡。
import { z } from 'zod';

export const PluginDraftFile = z.object({
  path: z.string().min(1),
  content: z.string(),
});
export type PluginDraftFile = z.infer<typeof PluginDraftFile>;

export const PluginDraftTurn = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  at: z.string().datetime(),
});
export type PluginDraftTurn = z.infer<typeof PluginDraftTurn>;

// 桌面端实际产出阶段：schema/security/preview（契约校验）+ diagnostics（汇总诊断）+ local-cli（CLI 工具判定）。
export const PluginDraftDiagnosticStage = z.enum([
  'schema',
  'security',
  'preview',
  'diagnostics',
  'local-cli',
]);
export const PluginDraftDiagnosticStatus = z.enum(['pass', 'fail', 'warn']);
export const PluginDraftDiagnostic = z.object({
  stage: PluginDraftDiagnosticStage,
  status: PluginDraftDiagnosticStatus,
  message: z.string(),
});
export type PluginDraftDiagnostic = z.infer<typeof PluginDraftDiagnostic>;

// 草稿状态：generating/ready/invalid/published（最终态）+ partial（部分产出但未完成）+ chat（对话态，未触发结构化产出）。
export const PluginDraftStatus = z.enum([
  'generating',
  'ready',
  'invalid',
  'published',
  'partial',
  'chat',
]);
export type PluginDraftStatus = z.infer<typeof PluginDraftStatus>;

export const PluginDraft = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1).optional(),
  tenant_id: z.string().min(1).optional(),
  createdBy: z.string().min(1).optional(),
  created_by: z.string().min(1).optional(),
  title: z.string().default(''),
  sourcePrompt: z.string().optional(),
  source_prompt: z.string().optional(),
  status: PluginDraftStatus.default('generating'),
  files: z.array(PluginDraftFile).default([]),
  turns: z.array(PluginDraftTurn).default([]),
  diagnostics: z.array(PluginDraftDiagnostic).default([]),
  updatedAt: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
});
export type PluginDraft = z.infer<typeof PluginDraft>;

// —— 请求 ——
export const CreateDraftRequest = z.object({
  title: z.string().optional(),
  prompt: z.string().min(1), // 用户首次的自然语言描述
});
export type CreateDraftRequest = z.infer<typeof CreateDraftRequest>;

// 生成/迭代：再来一句描述
export const GenerateRequest = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
});
export type GenerateRequest = z.infer<typeof GenerateRequest>;
