import { z } from 'zod';
import { ActionTarget, RestrictedJsonSchema } from './plugin-action.ts';

export const WORKFLOW_MAX_NODES = 64;
export const WORKFLOW_MAX_EDGES = 256;
export const WORKFLOW_MAX_PARALLEL = 8;
export const WORKFLOW_MAX_NESTING_DEPTH = 4;
export const WORKFLOW_MAX_EXPANDED_NODES = 128;

export const WorkflowNodeId = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/);
const JsonPointer = z
  .string()
  .max(1024)
  .refine(
    (value) =>
      value === '' ||
      (value.startsWith('/') &&
        value
          .split('/')
          .slice(1)
          .every((part) => !/~(?:[^01]|$)/.test(part))),
    'must be a valid RFC 6901 JSON Pointer'
  );
export type WorkflowJsonValue =
  null | string | number | boolean | WorkflowJsonValue[] | { [key: string]: WorkflowJsonValue };
export const WorkflowJsonValue: z.ZodType<WorkflowJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.array(WorkflowJsonValue),
    z.record(WorkflowJsonValue),
  ])
);
const BindingSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workflow_input'), source_pointer: JsonPointer }).strict(),
  z
    .object({
      kind: z.literal('node_output'),
      node_id: WorkflowNodeId,
      source_pointer: JsonPointer,
    })
    .strict(),
  z.object({ kind: z.literal('literal'), value: WorkflowJsonValue }).strict(),
]);
export const WorkflowBinding = z
  .object({ target_pointer: JsonPointer, source: BindingSource })
  .strict();
export type WorkflowBinding = z.infer<typeof WorkflowBinding>;

export const WorkflowDefinitionNodeV1 = z
  .object({
    node_id: WorkflowNodeId,
    declared_version_range: z.string().trim().min(1).max(128),
    target: ActionTarget,
    depends_on: z
      .array(WorkflowNodeId)
      .max(WORKFLOW_MAX_NODES)
      .transform((items) => [...new Set(items)].sort()),
    input_bindings: z.array(WorkflowBinding).max(256),
    retry_limit: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  })
  .strict();

export const WorkflowDefinitionV1 = z
  .object({
    definition_version: z.literal('1'),
    input_schema: RestrictedJsonSchema,
    output_schema: RestrictedJsonSchema,
    nodes: z.array(WorkflowDefinitionNodeV1).min(1).max(WORKFLOW_MAX_NODES),
    output_bindings: z.array(WorkflowBinding).max(256),
  })
  .strict()
  .superRefine((definition, ctx) => {
    const ids = new Set<string>();
    let edges = 0;
    definition.nodes.forEach((node, index) => {
      if (ids.has(node.node_id))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'node_id'],
          message: 'node_id must be unique',
        });
      ids.add(node.node_id);
      edges += node.depends_on.length;
      const targets = new Set<string>();
      node.input_bindings.forEach((binding, bindingIndex) => {
        if (targets.has(binding.target_pointer))
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes', index, 'input_bindings', bindingIndex, 'target_pointer'],
            message: 'target pointer must be unique',
          });
        targets.add(binding.target_pointer);
      });
    });
    if (edges > WORKFLOW_MAX_EDGES)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nodes'],
        message: `workflow may contain at most ${WORKFLOW_MAX_EDGES} dependency edges`,
      });
    definition.nodes.forEach((node, index) =>
      node.depends_on.forEach((dependency) => {
        if (!ids.has(dependency))
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes', index, 'depends_on'],
            message: `unknown dependency: ${dependency}`,
          });
        if (dependency === node.node_id)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes', index, 'depends_on'],
            message: 'node cannot depend on itself',
          });
      })
    );
    const outputTargets = new Set<string>();
    definition.output_bindings.forEach((binding, index) => {
      if (outputTargets.has(binding.target_pointer))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['output_bindings', index, 'target_pointer'],
          message: 'target pointer must be unique',
        });
      outputTargets.add(binding.target_pointer);
    });
  });
export type WorkflowDefinitionV1 = z.infer<typeof WorkflowDefinitionV1>;

export const WorkflowExecutionScope = z.enum(['PRODUCTION', 'PREVIEW']);
export type WorkflowExecutionScope = z.infer<typeof WorkflowExecutionScope>;
export const WorkflowExecutionTarget = z.enum(['DESKTOP', 'CLOUD']);
export type WorkflowExecutionTarget = z.infer<typeof WorkflowExecutionTarget>;
export const WorkflowRunStatus = z.enum([
  'PENDING',
  'RUNNING',
  'FAILING',
  'SUCCEEDED',
  'FAILED',
  'CANCELING',
  'CANCELED',
]);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatus>;
export const WorkflowStepStatus = z.enum([
  'PENDING',
  'READY',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'SKIPPED',
  'CANCELED',
]);
export type WorkflowStepStatus = z.infer<typeof WorkflowStepStatus>;
export const WorkflowErrorCode = z.enum([
  'workflow_invalid',
  'workflow_cycle_detected',
  'workflow_limit_exceeded',
  'workflow_mapping_invalid',
  'workflow_policy_denied',
  'workflow_run_conflict',
  'workflow_executor_unavailable',
  'workflow_executor_session_invalid',
  'workflow_inventory_changed',
  'workflow_installation_mismatch',
  'workflow_lease_expired',
  'workflow_cancelled',
  'workflow_side_effect_unknown',
  'workflow_step_failed',
]);

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const IsoDate = z.string().datetime();
const NullableIsoDate = IsoDate.nullable();

export const WorkflowExecutionPlanNode = z
  .object({
    node_id: WorkflowNodeId,
    declared_version_range: z.string().trim().min(1).max(128),
    target: ActionTarget,
    depends_on: z.array(WorkflowNodeId).max(WORKFLOW_MAX_NODES),
    input_bindings: z.array(WorkflowBinding).max(256),
    retry_limit: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    execution_semantics: z.enum(['read_only', 'idempotent', 'side_effect']),
    cloud_capable: z.boolean(),
  })
  .strict();
export type WorkflowExecutionPlanNode = z.infer<typeof WorkflowExecutionPlanNode>;

/**
 * Immutable workflow dependency snapshot embedded in a root execution plan.
 * Child runs select one of these exact slices by release id; they never resolve
 * the node's declared SemVer range again at execution time.
 */
export const WorkflowFrozenSubplan = z
  .object({
    workflow_release_id: z.string().min(1),
    workflow_release_sha256: Digest,
    definition_sha256: Digest,
    max_parallelism: z.number().int().min(1).max(WORKFLOW_MAX_PARALLEL),
    nodes: z.array(WorkflowExecutionPlanNode).min(1).max(WORKFLOW_MAX_NODES),
    output_bindings: z.array(WorkflowBinding).max(256),
  })
  .strict();
export type WorkflowFrozenSubplan = z.infer<typeof WorkflowFrozenSubplan>;

export const WorkflowExecutionPlan = z
  .object({
    plan_version: z.literal('1'),
    workflow_release_id: z.string().min(1),
    workflow_release_sha256: Digest,
    definition_sha256: Digest,
    execution_target: WorkflowExecutionTarget,
    execution_scope: WorkflowExecutionScope,
    max_parallelism: z.number().int().min(1).max(WORKFLOW_MAX_PARALLEL),
    nodes: z.array(WorkflowExecutionPlanNode).min(1).max(WORKFLOW_MAX_EXPANDED_NODES),
    workflow_subplans: z
      .array(WorkflowFrozenSubplan)
      .max(WORKFLOW_MAX_NESTING_DEPTH * WORKFLOW_MAX_NODES)
      .default([]),
    output_bindings: z.array(WorkflowBinding).max(256),
    desktop_executor: z
      .object({
        session_id: z.string().min(1),
        inventory_sha256: Digest,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type WorkflowExecutionPlan = z.infer<typeof WorkflowExecutionPlan>;

export const WorkflowPreflightDiagnostic = z
  .object({
    severity: z.enum(['ERROR', 'WARNING', 'INFO']),
    code: z.string().trim().min(1).max(128),
    message: z.string().trim().min(1).max(1000),
    path: z.array(z.union([z.string(), z.number().int().nonnegative()])).max(32),
    node_id: WorkflowNodeId.nullable(),
  })
  .strict();
export type WorkflowPreflightDiagnostic = z.infer<typeof WorkflowPreflightDiagnostic>;

export const WorkflowRunCreateRequest = z
  .object({
    workflow_release_id: z.string().trim().min(1).max(256),
    sha256: Digest,
    execution_target: WorkflowExecutionTarget,
    execution_scope: WorkflowExecutionScope.default('PRODUCTION'),
    input: z.record(WorkflowJsonValue),
    idempotency_key: z.string().trim().min(1).max(256),
    deadline_at: IsoDate,
    desktop_executor_session_id: z.string().trim().min(1).max(256).optional(),
  })
  .strict();
export type WorkflowRunCreateRequest = z.infer<typeof WorkflowRunCreateRequest>;

export const WorkflowPreflightRequest = WorkflowRunCreateRequest.omit({ idempotency_key: true });
export type WorkflowPreflightRequest = z.infer<typeof WorkflowPreflightRequest>;

export const WorkflowPreflightResponse = z
  .object({
    eligible: z.boolean(),
    workflow_release_id: z.string().min(1),
    execution_target: WorkflowExecutionTarget,
    execution_scope: WorkflowExecutionScope,
    plan: WorkflowExecutionPlan.nullable(),
    diagnostics: z.array(WorkflowPreflightDiagnostic).max(512),
  })
  .strict();
export type WorkflowPreflightResponse = z.infer<typeof WorkflowPreflightResponse>;

export const WorkflowRunError = z
  .object({
    code: z.string().max(128),
    message: z.string().max(1000),
  })
  .strict()
  .nullable();

export const WorkflowAttemptCounts = z
  .object({
    pending: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    canceled: z.number().int().nonnegative(),
  })
  .strict();

export const WorkflowRunSummary = z
  .object({
    id: z.string().min(1),
    workflow_release_id: z.string().min(1),
    root_run_id: z.string().min(1).nullable(),
    parent_step_attempt_id: z.string().min(1).nullable(),
    execution_target: WorkflowExecutionTarget,
    execution_scope: WorkflowExecutionScope,
    trigger_kind: z.enum(['MANUAL', 'SCHEDULE']),
    status: WorkflowRunStatus,
    plan_sha256: Digest,
    attempt_counts: WorkflowAttemptCounts,
    deadline_at: IsoDate,
    result_retain_until: IsoDate,
    created_at: IsoDate,
    started_at: NullableIsoDate,
    completed_at: NullableIsoDate,
    error: WorkflowRunError,
  })
  .strict();
export type WorkflowRunSummary = z.infer<typeof WorkflowRunSummary>;

export const WorkflowStepAttemptDTO = z
  .object({
    id: z.string().min(1),
    run_id: z.string().min(1),
    node_id: WorkflowNodeId,
    full_node_path: z.string().min(1).max(2048),
    attempt_number: z.number().int().nonnegative(),
    status: WorkflowStepStatus,
    target: ActionTarget,
    execution_semantics: z.enum(['read_only', 'idempotent', 'side_effect']),
    retry_limit: z.number().int().min(0).max(2),
    action_invocation_id: z.string().min(1).nullable(),
    request_idempotency_key: z.string().min(1),
    effect_idempotency_key: z.string().min(1).nullable(),
    output: WorkflowJsonValue.nullable(),
    created_at: IsoDate,
    started_at: NullableIsoDate,
    completed_at: NullableIsoDate,
    error: WorkflowRunError,
  })
  .strict();
export type WorkflowStepAttemptDTO = z.infer<typeof WorkflowStepAttemptDTO>;

export const WorkflowRunDetail = WorkflowRunSummary.extend({
  input: WorkflowJsonValue,
  output: WorkflowJsonValue.nullable(),
  plan: WorkflowExecutionPlan,
  attempts: z.array(WorkflowStepAttemptDTO),
}).strict();
export type WorkflowRunDetail = z.infer<typeof WorkflowRunDetail>;

export const WorkflowRunDetailResponse = z.object({ run: WorkflowRunDetail }).strict();
export type WorkflowRunDetailResponse = z.infer<typeof WorkflowRunDetailResponse>;

export const WorkflowRunListRequest = z
  .object({
    cursor: z.string().min(1).max(256).optional(),
    limit: z.number().int().min(1).max(100).default(20),
    status: WorkflowRunStatus.optional(),
  })
  .strict();
export type WorkflowRunListRequest = z.infer<typeof WorkflowRunListRequest>;

export const WorkflowRunListResponse = z
  .object({
    runs: z.array(WorkflowRunSummary),
    next_cursor: z.string().min(1).nullable(),
  })
  .strict();
export type WorkflowRunListResponse = z.infer<typeof WorkflowRunListResponse>;

export const WorkflowRunCancelResponse = WorkflowRunDetailResponse;
export type WorkflowRunCancelResponse = z.infer<typeof WorkflowRunCancelResponse>;

export const WorkflowUpgradeSuggestion = z
  .object({
    node_id: WorkflowNodeId,
    declared_version_range: z.string().trim().min(1).max(128),
    current_version: z.string().trim().min(1).max(128),
    current_target: ActionTarget,
    suggested_version: z.string().trim().min(1).max(128),
    suggested_target: ActionTarget,
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
export type WorkflowUpgradeSuggestion = z.infer<typeof WorkflowUpgradeSuggestion>;

export const WorkflowUpgradeSuggestionResponse = z
  .object({
    workflow_release_id: z.string().min(1),
    workflow_release_sha256: Digest,
    suggestions: z.array(WorkflowUpgradeSuggestion).max(WORKFLOW_MAX_EXPANDED_NODES),
  })
  .strict();
export type WorkflowUpgradeSuggestionResponse = z.infer<typeof WorkflowUpgradeSuggestionResponse>;

export const DesktopExecutorInventoryEntry = z
  .object({
    installation_id: z.string().min(1),
    package_id: z.string().min(1),
    release_id: z.string().min(1),
    sha256: Digest,
    dependency_status: z.enum(['pending', 'preparing', 'ready', 'failed']),
  })
  .strict();
export const DesktopExecutorSession = z
  .object({
    id: z.string().min(1),
    device_id: z.string().min(1),
    inventory_sha256: Digest,
    status: z.enum(['ACTIVE', 'EXPIRED', 'REVOKED']),
    expires_at: IsoDate,
    last_heartbeat_at: IsoDate,
  })
  .strict();
export const CreateDesktopExecutorSessionRequest = z
  .object({
    device_id: z.string().min(1).max(256),
    inventory: z.array(DesktopExecutorInventoryEntry).max(512),
  })
  .strict();
export const CreateDesktopExecutorSessionResponse = z
  .object({ session: DesktopExecutorSession, token: z.string().min(32) })
  .strict();
export const HeartbeatDesktopExecutorSessionRequest = z
  .object({ inventory: z.array(DesktopExecutorInventoryEntry).max(512) })
  .strict();
export const HeartbeatDesktopExecutorSessionResponse = z
  .object({ session: DesktopExecutorSession })
  .strict();
export const WORKFLOW_EXECUTOR_TOKEN_HEADER = 'x-workflow-executor-token' as const;
export const WORKFLOW_ATTEMPT_LEASE_TOKEN_HEADER = 'x-workflow-attempt-lease-token' as const;
export const WorkflowExecutorClaimRequest = z.object({ run_id: z.string().min(1) }).strict();
export type WorkflowExecutorClaimRequest = z.infer<typeof WorkflowExecutorClaimRequest>;
export const WorkflowExecutorClaimResponse = z
  .object({
    attempt: z
      .object({
        id: z.string().min(1),
        run_id: z.string().min(1),
        node_id: WorkflowNodeId,
        input: WorkflowJsonValue,
        target: ActionTarget,
        deadline_at: IsoDate,
        lease_expires_at: IsoDate,
        lease_token: z.string().min(32),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type WorkflowExecutorClaimResponse = z.infer<typeof WorkflowExecutorClaimResponse>;
export const WorkflowExecutorHeartbeatRequest = z.object({}).strict();
export const WorkflowExecutorHeartbeatResponse = z
  .object({ ok: z.literal(true), lease_expires_at: z.string().datetime() })
  .strict();
