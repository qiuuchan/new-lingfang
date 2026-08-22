// 本地定时任务契约（Local Scheduler）。
//
// 与云端 `plugin-cloud-automation.ts` 的 `AutomationSchedule` 划清边界：
// - 云端 AutomationSchedule 绑定 workflow_release_id + scheduler_key + outbox + sync_state，
//   服务于「云端工作流调度」，依赖 collab-api 后端 + 云 executor。
// - 本地 LocalSchedule 仅在桌面端运行时触发，配置持久化到本地磁盘，不补跑、不重试、串行执行。
//
// 命名约定：所有类型加 `Local` 前缀（LocalSchedule / LocalScheduleRun / ...），
// 避免与云端同名类型混淆，迁移时不会误用。
//
// 决策记录（见 .trellis/tasks/07-20-local-scheduler/prd.md「Technical Decisions」）：
// - 形态：持久化本地 + 在线触发（不补跑）
// - 执行体：AGENT_PROMPT / PLUGIN_ACTION / NOTIFY（不做 workflow）
// - 并发：串行，最大并发 1
// - 超时：默认 30 分钟硬超时
// - 时区：显式 time_zone（IANA 名），默认系统时区
// - runs 保留：每任务最近 200 条
import { z } from 'zod';

// —— 共享原子 ——
const Identifier = z.string().trim().min(1).max(128);
const IsoDateTime = z.string().datetime();
// Cron 表达式：5 或 6 字段（分 时 日 月 周 [秒]）。空格分隔，字段允许 * / - , 数字。
// 不强制完整 cron 语法校验（交给 Rust 端 croner 解析失败时报错），仅做基本形态校验。
const CronExpression = z
  .string()
  .trim()
  .min(9, 'cron 表达式过短')
  .max(128, 'cron 表达式过长')
  .regex(
    /^[\d*/,-]+(\s+[\d*/,-]+){4,5}$/,
    'cron 表达式格式无效（需 5 或 6 字段：分 时 日 月 周 [秒]）'
  );
const TimeZone = z
  .string()
  .trim()
  .min(1, '时区不能为空')
  .max(64, '时区名称过长')
  .refine((value) => {
    try {
      // 仅校验 IANA 时区名可被运行时识别（无效会抛 RangeError）。
      Intl.DateTimeFormat(undefined, { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, '时区必须是有效的 IANA 名称（如 Asia/Shanghai）');

// WorkflowJsonValue 与 plugin-workflow.ts 一致语义（任意 JSON 值）。
// 本地复用一份避免循环依赖。
type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };
const WorkflowJsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.array(WorkflowJsonValue),
    z.record(WorkflowJsonValue),
  ])
);

// —— 触发器 ——
export const LocalScheduleTriggerKind = z.enum(['ONCE', 'CRON']);
export type LocalScheduleTriggerKind = z.infer<typeof LocalScheduleTriggerKind>;

export const LocalScheduleTrigger = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('ONCE'),
      // 一次性触发的绝对时间（UTC ISO 字符串）。
      run_at: IsoDateTime,
    })
    .strict(),
  z
    .object({
      kind: z.literal('CRON'),
      // 标准 cron 表达式（5 字段：分 时 日 月 周）。
      cron: CronExpression,
      // IANA 时区名（如 Asia/Shanghai）。前端默认填系统时区。
      time_zone: TimeZone,
    })
    .strict(),
]);
export type LocalScheduleTrigger = z.infer<typeof LocalScheduleTrigger>;

// —— Payload（执行体）——
export const LocalTaskType = z.enum(['AGENT_PROMPT', 'PLUGIN_ACTION', 'NOTIFY']);
export type LocalTaskType = z.infer<typeof LocalTaskType>;

export const LocalTaskPayload = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('AGENT_PROMPT'),
      // Agent prompt（上限 10000 字符）。
      prompt: z.string().trim().min(1, 'prompt 不能为空').max(10000, 'prompt 超过 10000 字符上限'),
    })
    .strict(),
  z
    .object({
      type: z.literal('PLUGIN_ACTION'),
      // 目标插件 ID + action 名 + 入参（任意 JSON）。
      plugin_id: Identifier,
      action: Identifier,
      input: WorkflowJsonValue,
    })
    .strict(),
  z
    .object({
      type: z.literal('NOTIFY'),
      title: z.string().trim().min(1, '标题不能为空').max(200, '标题过长'),
      body: z.string().trim().max(2000, '正文过长').default(''),
    })
    .strict(),
]);
export type LocalTaskPayload = z.infer<typeof LocalTaskPayload>;

// —— 任务 ——
export const LocalScheduleStatus = z.enum(['ACTIVE', 'PAUSED', 'COMPLETED', 'DELETED']);
export type LocalScheduleStatus = z.infer<typeof LocalScheduleStatus>;

// 单任务最大执行时长（ms）。默认 30 分钟；范围 1 秒 ~ 60 分钟。
export const LOCAL_SCHEDULE_TIMEOUT_MS_DEFAULT = 1_800_000;
export const LOCAL_SCHEDULE_TIMEOUT_MS_MIN = 1_000;
export const LOCAL_SCHEDULE_TIMEOUT_MS_MAX = 3_600_000;

export const LocalSchedule = z
  .object({
    id: Identifier,
    name: z.string().trim().min(1, '任务名称不能为空').max(100, '任务名称过长'),
    trigger: LocalScheduleTrigger,
    payload: LocalTaskPayload,
    status: LocalScheduleStatus,
    // 单次执行硬超时（ms）。超时强制 kill + 记 TIMEOUT。
    timeout_ms: z
      .number()
      .int()
      .min(LOCAL_SCHEDULE_TIMEOUT_MS_MIN)
      .max(LOCAL_SCHEDULE_TIMEOUT_MS_MAX)
      .default(LOCAL_SCHEDULE_TIMEOUT_MS_DEFAULT),
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
    // 最近一次 run 的 ID（运行时维护，写入时由 Rust 端填充）。
    last_run_id: Identifier.nullable().default(null),
    // 下次触发时间（UTC ISO 字符串）。ACTIVE 状态必有；其他状态可为 null。
    next_run_at: IsoDateTime.nullable().default(null),
  })
  .strict();
export type LocalSchedule = z.infer<typeof LocalSchedule>;

// 创建请求（不含 id / created_at / updated_at / last_run_id / next_run_at，由后端生成）。
export const LocalScheduleCreateInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    trigger: LocalScheduleTrigger,
    payload: LocalTaskPayload,
    timeout_ms: z
      .number()
      .int()
      .min(LOCAL_SCHEDULE_TIMEOUT_MS_MIN)
      .max(LOCAL_SCHEDULE_TIMEOUT_MS_MAX)
      .optional(),
    // 初始状态：默认 ACTIVE，可传 PAUSED 创建即暂停。
    status: LocalScheduleStatus.default('ACTIVE'),
  })
  .strict();
export type LocalScheduleCreateInput = z.infer<typeof LocalScheduleCreateInput>;

// 更新请求（部分字段；trigger / payload / timeout_ms 任一提供即覆盖；status 用于 pause/resume）。
export const LocalScheduleUpdateInput = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    trigger: LocalScheduleTrigger.optional(),
    payload: LocalTaskPayload.optional(),
    timeout_ms: z
      .number()
      .int()
      .min(LOCAL_SCHEDULE_TIMEOUT_MS_MIN)
      .max(LOCAL_SCHEDULE_TIMEOUT_MS_MAX)
      .optional(),
    status: LocalScheduleStatus.optional(),
  })
  .strict();
export type LocalScheduleUpdateInput = z.infer<typeof LocalScheduleUpdateInput>;

// —— 运行记录 ——
export const LocalScheduleRunStatus = z.enum([
  'RUNNING',
  'SUCCESS',
  'FAILED',
  'TIMEOUT',
  'SKIPPED',
]);
export type LocalScheduleRunStatus = z.infer<typeof LocalScheduleRunStatus>;

export const LocalScheduleRun = z
  .object({
    id: Identifier,
    task_id: Identifier,
    started_at: IsoDateTime,
    // RUNNING 状态为 null；其余状态必填。
    finished_at: IsoDateTime.nullable(),
    status: LocalScheduleRunStatus,
    // SKIPPED 时的原因（如 "no session" / "previous run still active"）。
    skip_reason: z.string().max(200).nullable(),
    // FAILED / TIMEOUT 时的错误摘要。
    error: z.string().max(2000).nullable(),
    // 成功时的输出摘要：
    // - NOTIFY  → title + body
    // - PLUGIN_ACTION → action 输出截断
    // - AGENT_PROMPT  → 最后一条 assistant 消息摘要
    output_summary: z.string().max(2000).nullable(),
    duration_ms: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type LocalScheduleRun = z.infer<typeof LocalScheduleRun>;

// 前端回写 run 结果（AGENT_PROMPT 跑完后调用）。
export const LocalScheduleRunRecordInput = z
  .object({
    id: Identifier,
    task_id: Identifier,
    started_at: IsoDateTime,
    finished_at: IsoDateTime,
    status: z.enum(['SUCCESS', 'FAILED']),
    error: z.string().max(2000).nullable(),
    output_summary: z.string().max(2000).nullable(),
  })
  .strict();
export type LocalScheduleRunRecordInput = z.infer<typeof LocalScheduleRunRecordInput>;

// 每任务保留的 run 记录上限（超出自动 GC 最旧的）。
export const LOCAL_SCHEDULE_RUNS_KEEP = 200;
