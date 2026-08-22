import { z } from 'zod';
import { CapabilityKind, RuntimeType } from './plugin.ts';
import { PluginReleaseSourceKind, Sha256Hex } from './plugin-registry.ts';

export const PluginPolicyOperation = z.enum([
  'install',
  'update',
  'run_local',
  'invoke_action',
  'run_workflow',
  'execute_cloud',
  'manage_schedule',
  'trigger_schedule',
  'shared_data_read',
  'shared_data_write',
  'web_preview',
]);
export type PluginPolicyOperation = z.infer<typeof PluginPolicyOperation>;

export const HIGH_RISK_PLUGIN_POLICY_OPERATIONS = new Set<PluginPolicyOperation>([
  'invoke_action',
  'run_workflow',
  'execute_cloud',
  'manage_schedule',
  'trigger_schedule',
  'shared_data_read',
  'shared_data_write',
]);

const NonEmptyOperations = z
  .array(PluginPolicyOperation)
  .min(1)
  .transform((items) => [...new Set(items)].sort());
const Digest = Sha256Hex;

export const PackagePolicySurfaceV1 = z
  .object({
    schema_version: z.literal(1),
    runtime_type: z.union([RuntimeType, z.literal('workflow')]),
    declared_capabilities: z.array(CapabilityKind).max(64),
    actions: z
      .array(
        z
          .object({
            action_id: z.string().trim().min(1).max(128),
            action_contract_version: z.string().trim().min(1).max(64),
            action_surface_sha256: Digest,
            cloud_capable: z.boolean(),
            previewable: z.boolean(),
          })
          .strict()
      )
      .max(128),
    workflow: z
      .object({
        workflow_release_id: z.string().min(1),
        workflow_plan_sha256: Digest,
        cloud_eligible: z.boolean(),
      })
      .strict()
      .optional(),
    shared_namespaces: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(128),
            active_schema_version: z.string().trim().min(1).max(64),
            read: z.boolean(),
            write: z.boolean(),
          })
          .strict()
      )
      .max(128),
    schedule_eligible: z.boolean(),
  })
  .strict()
  .superRefine((surface, ctx) => {
    for (const [field, values, key] of [
      [
        'actions',
        surface.actions,
        (item: (typeof surface.actions)[number]) =>
          `${item.action_id}\0${item.action_contract_version}`,
      ],
      [
        'shared_namespaces',
        surface.shared_namespaces,
        (item: (typeof surface.shared_namespaces)[number]) =>
          `${item.name}\0${item.active_schema_version}`,
      ],
    ] as const) {
      const seen = new Map<string, string>();
      values.forEach((item, index) => {
        const identity = key(item as never);
        const encoded = JSON.stringify(item);
        const previous = seen.get(identity);
        if (previous && previous !== encoded)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `conflicting duplicate ${field} identity`,
            path: [field, index],
          });
        seen.set(identity, encoded);
      });
    }
  });
export type PackagePolicySurfaceV1 = z.infer<typeof PackagePolicySurfaceV1>;

export function canonicalizePackagePolicySurfaceV1(input: unknown): PackagePolicySurfaceV1 {
  const value = PackagePolicySurfaceV1.parse(input);
  const unique = <T>(items: T[], key: (item: T) => string) => [
    ...new Map(items.map((item) => [key(item), item])).values(),
  ];
  return {
    ...value,
    declared_capabilities: [...new Set(value.declared_capabilities)].sort(),
    actions: unique(
      value.actions,
      (item) => `${item.action_id}\0${item.action_contract_version}`
    ).sort((a, b) =>
      `${a.action_id}\0${a.action_contract_version}`.localeCompare(
        `${b.action_id}\0${b.action_contract_version}`
      )
    ),
    shared_namespaces: unique(
      value.shared_namespaces,
      (item) => `${item.name}\0${item.active_schema_version}`
    ).sort((a, b) =>
      `${a.name}\0${a.active_schema_version}`.localeCompare(`${b.name}\0${b.active_schema_version}`)
    ),
  };
}

export function canonicalPackagePolicySurfaceJson(input: unknown): string {
  return JSON.stringify(canonicalizePackagePolicySurfaceV1(input));
}

const TeamTarget = z.object({ kind: z.literal('TEAM') }).strict();
const PackageTarget = z
  .object({
    kind: z.literal('PACKAGE'),
    package_id: z.string().min(1),
    approved_surface_sha256: Digest.optional(),
  })
  .strict();
const ActionTarget = z
  .object({
    kind: z.literal('ACTION'),
    package_id: z.string().min(1),
    action_id: z.string().min(1),
    action_contract_version: z.string().min(1),
    action_surface_sha256: Digest,
  })
  .strict();
const WorkflowTarget = z
  .object({
    kind: z.literal('WORKFLOW'),
    workflow_release_id: z.string().min(1),
    workflow_plan_sha256: Digest,
  })
  .strict();
export const PluginPolicyTarget = z.discriminatedUnion('kind', [
  TeamTarget,
  PackageTarget,
  ActionTarget,
  WorkflowTarget,
]);

export const TeamPluginPolicyRuleV1 = z
  .object({
    rule_id: z.string().trim().min(1).max(128),
    effect: z.enum(['ALLOW', 'DENY']),
    operations: NonEmptyOperations,
    target: PluginPolicyTarget,
    version_range: z.string().trim().min(1).max(128).optional(),
    release_ids: z.array(z.string().min(1)).max(100).optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    const highRiskAllow =
      rule.effect === 'ALLOW' &&
      rule.operations.some((operation) => HIGH_RISK_PLUGIN_POLICY_OPERATIONS.has(operation));
    if (highRiskAllow && rule.target.kind === 'TEAM')
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'high-risk operations cannot be allowed team-wide',
        path: ['target'],
      });
    if (highRiskAllow && rule.target.kind === 'PACKAGE' && !rule.target.approved_surface_sha256)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'package high-risk allow requires approved_surface_sha256',
        path: ['target', 'approved_surface_sha256'],
      });
  });

export const TeamPluginPolicyDocumentV1 = z
  .object({
    schema_version: z.literal(1),
    enforcement_mode: z.enum(['AUDIT', 'ENFORCE']),
    allowed_source_kinds: z
      .array(PluginReleaseSourceKind)
      .max(32)
      .transform((items) => [...new Set(items)].sort()),
    denied_capability_kinds: z
      .array(CapabilityKind)
      .max(64)
      .transform((items) => [...new Set(items)].sort()),
    rules: z.array(TeamPluginPolicyRuleV1).max(500),
  })
  .strict()
  .superRefine((document, ctx) => {
    const ids = new Set<string>();
    document.rules.forEach((rule, index) => {
      if (ids.has(rule.rule_id))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'rule_id must be unique',
          path: ['rules', index, 'rule_id'],
        });
      ids.add(rule.rule_id);
    });
  });
export type TeamPluginPolicyDocumentV1 = z.infer<typeof TeamPluginPolicyDocumentV1>;

export const PluginPolicyResource = z
  .object({
    team_id: z.string().min(1),
    package_id: z.string().min(1),
    release_id: z.string().min(1),
    sha256: Digest,
    source_kind: PluginReleaseSourceKind,
    runtime_type: z.union([RuntimeType, z.literal('workflow')]),
    package_policy_surface_sha256: Digest,
    declared_capabilities: z.array(CapabilityKind).max(64),
    action: ActionTarget.omit({ kind: true, package_id: true }).optional(),
    workflow: WorkflowTarget.omit({ kind: true }).optional(),
  })
  .strict();

export const PluginPolicyReasonCode = z.enum([
  'platform_gate_denied',
  'team_source_denied',
  'team_capability_denied',
  'team_rule_denied',
  'high_risk_not_enabled',
  'package_surface_changed',
  'action_surface_changed',
  'workflow_plan_changed',
  'user_grant_denied',
  'role_grant_denied',
  'request_scope_exceeded',
  'allowed',
]);

export const PluginPolicyDecision = z
  .object({
    allowed: z.boolean(),
    required_operations: NonEmptyOperations,
    team_id: z.string().min(1),
    policy_revision: z.number().int().nonnegative(),
    enforcement_mode: z.enum(['AUDIT', 'ENFORCE']),
    reason_code: PluginPolicyReasonCode,
    reason: z.string().max(500),
    operation_results: z
      .array(
        z
          .object({
            operation: PluginPolicyOperation,
            allowed: z.boolean(),
            reason_code: PluginPolicyReasonCode,
            matched: z.array(
              z
                .object({
                  layer: z.enum(['PLATFORM', 'TEAM', 'USER_GRANT', 'ROLE_GRANT', 'REQUEST']),
                  effect: z.enum(['ALLOW', 'DENY']),
                  rule_id: z.string().optional(),
                })
                .strict()
            ),
          })
          .strict()
      )
      .min(1),
  })
  .strict()
  .superRefine((decision, ctx) => {
    const resultOperations = decision.operation_results.map((result) => result.operation).sort();
    if (
      new Set(resultOperations).size !== resultOperations.length ||
      JSON.stringify(resultOperations) !== JSON.stringify(decision.required_operations)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'operation_results must cover required_operations exactly once',
        path: ['operation_results'],
      });
    }
    if (decision.allowed !== decision.operation_results.every((result) => result.allowed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'allowed must equal the conjunction of operation_results',
        path: ['allowed'],
      });
    }
  });

export const PublishTeamPluginPolicyRequest = z
  .object({
    expected_revision: z.number().int().nonnegative(),
    document: TeamPluginPolicyDocumentV1,
    change_reason: z.string().max(500).default(''),
  })
  .strict();
export const RollbackTeamPluginPolicyRequest = z
  .object({
    expected_revision: z.number().int().nonnegative(),
    source_revision: z.number().int().positive(),
    change_reason: z.string().max(500).default(''),
  })
  .strict();
export const EvaluatePluginPolicyRequest = z
  .object({ required_operations: NonEmptyOperations, resource: PluginPolicyResource })
  .strict();
export const PreviewTeamPluginPolicyRequest = z
  .object({
    document: TeamPluginPolicyDocumentV1,
    evaluations: z.array(EvaluatePluginPolicyRequest).max(500),
  })
  .strict();
export const ExplainPluginPolicyRequest = EvaluatePluginPolicyRequest;

export type PluginPolicyDecision = z.infer<typeof PluginPolicyDecision>;
export type PluginPolicyResource = z.infer<typeof PluginPolicyResource>;
