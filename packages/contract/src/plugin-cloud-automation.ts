import { z } from 'zod';
import { ActionTarget } from './plugin-action.ts';
import { WorkflowExecutionScope, WorkflowJsonValue } from './plugin-workflow.ts';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const IsoDateTime = z.string().datetime();
const Identifier = z.string().trim().min(1).max(256);

export const CloudDeploymentEnvironment = z.enum(['PREVIEW', 'PRODUCTION']);
export type CloudDeploymentEnvironment = z.infer<typeof CloudDeploymentEnvironment>;
export const CloudDeploymentStatus = z.enum(['DRAFT', 'VERIFYING', 'READY', 'DISABLED', 'RETIRED']);
export type CloudDeploymentStatus = z.infer<typeof CloudDeploymentStatus>;

export const CloudActionDeploymentTarget = ActionTarget.extend({
  environment: CloudDeploymentEnvironment,
}).strict();
export type CloudActionDeploymentTarget = z.infer<typeof CloudActionDeploymentTarget>;

export const CloudActionDeployment = z
  .object({
    id: Identifier,
    target: CloudActionDeploymentTarget,
    deployment_key: Identifier,
    supersedes_deployment_id: Identifier.nullable(),
    endpoint_host: z.string().trim().min(1).max(253),
    status: CloudDeploymentStatus,
    secret_version: z.number().int().positive(),
    timeout_ms: z.number().int().min(1_000).max(300_000),
    max_concurrency: z.number().int().min(1).max(1_000),
    rate_limit_per_minute: z.number().int().min(1).max(1_000_000),
    response_limit_bytes: z
      .number()
      .int()
      .min(1_024)
      .max(16 * 1024 * 1024),
    last_health_at: IsoDateTime.nullable(),
    last_health_ok: z.boolean().nullable(),
    last_health_error_code: z.string().max(128),
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
  })
  .strict();
export type CloudActionDeployment = z.infer<typeof CloudActionDeployment>;

export const CloudActionRouting = z
  .object({
    target: CloudActionDeploymentTarget.omit({ package_id: true, sha256: true }),
    stable_deployment_id: Identifier,
    candidate_deployment_id: Identifier.nullable(),
    candidate_percent: z.number().int().min(0).max(100),
    generation: z.number().int().nonnegative(),
    updated_at: IsoDateTime,
  })
  .strict();
export type CloudActionRouting = z.infer<typeof CloudActionRouting>;

export const WorkflowCloudBinding = z
  .object({
    node_path: z.string().trim().min(1).max(2048),
    deployment_id: Identifier,
    routing_generation: z.number().int().nonnegative(),
    environment: CloudDeploymentEnvironment,
    policy_decision_id: Identifier,
  })
  .strict();
export type WorkflowCloudBinding = z.infer<typeof WorkflowCloudBinding>;

export const AutomationScheduleKind = z.enum(['ONCE', 'DAILY', 'WEEKLY']);
export const AutomationScheduleStatus = z.enum([
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'MISSED',
  'DELETED',
]);
export const AutomationScheduleSyncState = z.enum(['PENDING', 'SYNCED', 'ERROR']);

const LocalTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const TimeZone = z.string().trim().min(1).max(128);
export const AutomationScheduleTrigger = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ONCE'), run_at: IsoDateTime }).strict(),
  z.object({ kind: z.literal('DAILY'), time_zone: TimeZone, local_time: LocalTime }).strict(),
  z
    .object({
      kind: z.literal('WEEKLY'),
      time_zone: TimeZone,
      day_of_week: z.number().int().min(1).max(7),
      local_time: LocalTime,
    })
    .strict(),
]);
export type AutomationScheduleTrigger = z.infer<typeof AutomationScheduleTrigger>;

export const AutomationSchedule = z
  .object({
    id: Identifier,
    workflow_release_id: Identifier,
    workflow_release_sha256: Digest,
    trigger: AutomationScheduleTrigger,
    input: WorkflowJsonValue,
    input_schema_sha256: Digest,
    status: AutomationScheduleStatus,
    generation: z.number().int().positive(),
    scheduler_key: Identifier,
    next_run_at: IsoDateTime.nullable(),
    last_scheduled_for: IsoDateTime.nullable(),
    last_run_id: Identifier.nullable(),
    consecutive_failures: z.number().int().nonnegative(),
    sync_state: AutomationScheduleSyncState,
    sync_error_code: z.string().max(128),
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
  })
  .strict();
export type AutomationSchedule = z.infer<typeof AutomationSchedule>;

export const CreateAutomationScheduleRequest = z
  .object({
    workflow_release_id: Identifier,
    workflow_release_sha256: Digest,
    trigger: AutomationScheduleTrigger,
    input: WorkflowJsonValue,
  })
  .strict();
export type CreateAutomationScheduleRequest = z.infer<typeof CreateAutomationScheduleRequest>;

export const AutomationScheduleFirePayload = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('REPEAT'),
      schedule_id: Identifier,
      generation: z.number().int().positive(),
      scheduler_key: Identifier,
    })
    .strict(),
  z
    .object({
      kind: z.literal('ONCE'),
      schedule_id: Identifier,
      generation: z.number().int().positive(),
      scheduled_for: IsoDateTime,
      occurrence_key: z.string().trim().min(1).max(512),
    })
    .strict(),
]);
export type AutomationScheduleFirePayload = z.infer<typeof AutomationScheduleFirePayload>;

export const AutomationOutboxKind = z.enum([
  'UPSERT_SCHEDULE',
  'REMOVE_SCHEDULE',
  'ENQUEUE_RUN',
  'ENQUEUE_ACTION',
  'CANCEL_RUN',
]);
export const AutomationOutboxStatus = z.enum(['PENDING', 'PROCESSING', 'DONE', 'FAILED']);
export const AutomationOutboxRecord = z
  .object({
    id: Identifier,
    kind: AutomationOutboxKind,
    aggregate_id: Identifier,
    generation: z.number().int().nonnegative(),
    payload: z.record(WorkflowJsonValue),
    status: AutomationOutboxStatus,
    available_at: IsoDateTime,
    attempts: z.number().int().nonnegative(),
    locked_by: Identifier.nullable(),
    locked_until: IsoDateTime.nullable(),
    last_error_code: z.string().max(128),
  })
  .strict();
export type AutomationOutboxRecord = z.infer<typeof AutomationOutboxRecord>;

export const CloudUsageSourceKind = z.enum(['ACTION_INVOCATION', 'WORKFLOW_ATTEMPT']);
export const CloudUsageEventKind = z.enum(['EXECUTION']);
export const CloudUsageOutcome = z.enum([
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
  'TIMED_OUT',
  'RESULT_UNKNOWN',
]);
export const CloudUsageEvent = z
  .object({
    id: Identifier,
    team_id: Identifier,
    source_kind: CloudUsageSourceKind,
    source_id: Identifier,
    event_kind: CloudUsageEventKind,
    target: ActionTarget,
    deployment_id: Identifier,
    execution_scope: WorkflowExecutionScope,
    duration_ms: z.number().int().nonnegative(),
    request_bytes: z.number().int().nonnegative(),
    response_bytes: z.number().int().nonnegative(),
    artifact_input_bytes: z.number().int().nonnegative(),
    artifact_output_bytes: z.number().int().nonnegative(),
    outcome: CloudUsageOutcome,
    pricing_dimensions: z.record(z.union([z.string(), z.number().finite(), z.boolean()])),
    occurred_at: IsoDateTime,
  })
  .strict();
export type CloudUsageEvent = z.infer<typeof CloudUsageEvent>;

export const CloudAutomationErrorCode = z.enum([
  'cloud_automation_disabled',
  'cloud_endpoint_not_ready',
  'cloud_endpoint_target_mismatch',
  'cloud_endpoint_redirect_denied',
  'cloud_endpoint_network_denied',
  'cloud_endpoint_signature_invalid',
  'cloud_endpoint_response_too_large',
  'cloud_endpoint_response_invalid',
  'cloud_endpoint_timeout',
  'cloud_endpoint_unavailable',
  'cloud_routing_conflict',
  'cloud_deployment_in_use',
  'cloud_quota_exceeded',
  'cloud_result_unknown',
  'automation_schedule_invalid',
  'automation_schedule_stale_generation',
  'automation_schedule_missed',
  'automation_queue_unavailable',
  'automation_outbox_exhausted',
]);
export type CloudAutomationErrorCode = z.infer<typeof CloudAutomationErrorCode>;

export const CloudWorkflowAttemptTransport = z
  .object({
    transport_job_id: Identifier.nullable(),
    delivery_state: z.enum(['NONE', 'QUEUED', 'CLAIMED', 'DELIVERED', 'UNKNOWN']),
    request_sha256: Digest.nullable(),
    response_sha256: Digest.nullable(),
    endpoint_http_status: z.number().int().min(100).max(599).nullable(),
    request_bytes: z.number().int().nonnegative(),
    response_bytes: z.number().int().nonnegative(),
  })
  .strict();
export type CloudWorkflowAttemptTransport = z.infer<typeof CloudWorkflowAttemptTransport>;

export const CloudWorkflowRunScheduleContext = z
  .object({
    schedule_id: Identifier,
    schedule_generation: z.number().int().positive(),
    scheduled_for: IsoDateTime,
    occurrence_key: z.string().trim().min(1).max(512),
  })
  .strict();
export type CloudWorkflowRunScheduleContext = z.infer<typeof CloudWorkflowRunScheduleContext>;
