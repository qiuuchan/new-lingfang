import { z } from 'zod';
import { ArtifactRefV1 } from './plugin-action.ts';
import { RestrictedJsonSchema } from './plugin-action.ts';
import { WorkflowJsonValue } from './plugin-workflow.ts';

export const SHARED_KEY_MAX_LENGTH = 128;
export const SHARED_VALUE_MAX_BYTES = 64 * 1024;
export const SHARED_NAMESPACE_DEFAULT_QUOTA_BYTES = 10 * 1024 * 1024;
export const SHARED_CHANGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const SHARED_PRESENCE_HEARTBEAT_MS = 30 * 1000;
export const SHARED_PRESENCE_TTL_MS = 90 * 1000;

const Identifier = z.string().trim().min(1).max(256);
const DecimalCursor = z.string().regex(/^[0-9]+$/);
const IsoDateTime = z.string().datetime();

export const SharedNamespaceOwnerKind = z.enum(['PACKAGE', 'WORKFLOW']);
export type SharedNamespaceOwnerKind = z.infer<typeof SharedNamespaceOwnerKind>;

export const SharedNamespaceDeclaration = z
  .object({
    name: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9._-]{0,63}$/),
    active_schema_version: z.number().int().positive(),
    read_purpose: z.string().trim().min(1).max(500),
    write_purpose: z.string().trim().min(1).max(500),
    schemas: z
      .array(
        z
          .object({
            schema_version: z.number().int().positive(),
            schema: RestrictedJsonSchema,
          })
          .strict()
      )
      .min(1)
      .max(16),
  })
  .strict()
  .superRefine((value, ctx) => {
    const versions = new Set<number>();
    value.schemas.forEach((entry, index) => {
      if (versions.has(entry.schema_version))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['schemas', index, 'schema_version'],
          message: 'schema_version must be unique',
        });
      versions.add(entry.schema_version);
    });
    if (!versions.has(value.active_schema_version))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['active_schema_version'],
        message: 'active_schema_version must have a matching schema',
      });
  });
export type SharedNamespaceDeclaration = z.infer<typeof SharedNamespaceDeclaration>;

export const SharedNamespace = z
  .object({
    id: Identifier,
    team_id: Identifier,
    owner_kind: SharedNamespaceOwnerKind,
    owner_id: Identifier,
    name: z.string().trim().min(1).max(128),
    generation: z.number().int().positive(),
    deleted_at: IsoDateTime.nullable(),
    active_schema_version: z.number().int().positive(),
    next_value_revision: DecimalCursor,
    next_change_cursor: DecimalCursor,
    used_bytes: z.number().int().nonnegative(),
    quota_bytes: z.number().int().positive(),
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
  })
  .strict();
export type SharedNamespace = z.infer<typeof SharedNamespace>;

export const SharedArtifactEdge = z
  .object({
    namespace_id: Identifier,
    namespace_generation: z.number().int().positive(),
    key: z.string().trim().min(1).max(SHARED_KEY_MAX_LENGTH),
    value_revision: DecimalCursor,
    artifact_id: Identifier,
    json_pointer: z.string().regex(/^(?:|(?:\/(?:[^~]|~0|~1)*)+)$/),
    execution_kind: z.literal('STANDARD'),
  })
  .strict();
export type SharedArtifactEdge = z.infer<typeof SharedArtifactEdge>;

export const SharedValue = z
  .object({
    namespace_id: Identifier,
    namespace_generation: z.number().int().positive(),
    key: z.string().trim().min(1).max(SHARED_KEY_MAX_LENGTH),
    value: WorkflowJsonValue,
    schema_version: z.number().int().positive(),
    value_bytes: z.number().int().nonnegative().max(SHARED_VALUE_MAX_BYTES),
    revision: DecimalCursor,
    created_by_user_id: Identifier.nullable(),
    created_by_package_id: Identifier.nullable(),
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
    artifacts: z.array(SharedArtifactEdge),
  })
  .strict();
export type SharedValue = z.infer<typeof SharedValue>;

export const SharedWrite = z
  .object({
    value: WorkflowJsonValue,
    schema_version: z.number().int().positive(),
    expected_revision: DecimalCursor.optional(),
  })
  .strict();
export type SharedWrite = z.infer<typeof SharedWrite>;

export const SharedSchemaMigration = z
  .object({
    value: WorkflowJsonValue,
    source_schema_version: z.number().int().positive(),
    target_schema_version: z.number().int().positive(),
    expected_revision: DecimalCursor,
  })
  .strict()
  .refine((value) => value.source_schema_version !== value.target_schema_version, {
    message: 'source_schema_version and target_schema_version must differ',
    path: ['target_schema_version'],
  });
export type SharedSchemaMigration = z.infer<typeof SharedSchemaMigration>;

export const SharedNamespaceReactivate = z
  .object({
    active_schema_version: z.number().int().positive(),
  })
  .strict();
export type SharedNamespaceReactivate = z.infer<typeof SharedNamespaceReactivate>;

export const SharedNamespaceLifecycleResult = z
  .object({
    namespace_id: Identifier,
    namespace_generation: z.number().int().positive(),
    active_schema_version: z.number().int().positive(),
    next_value_revision: DecimalCursor,
    next_change_cursor: DecimalCursor,
    used_bytes: z.number().int().nonnegative(),
    deleted_at: IsoDateTime.nullable(),
  })
  .strict();
export type SharedNamespaceLifecycleResult = z.infer<typeof SharedNamespaceLifecycleResult>;

export const SharedNamespaceExportLine = z
  .object({
    namespace_id: Identifier,
    namespace_generation: z.number().int().positive(),
    key: z.string().trim().min(1).max(SHARED_KEY_MAX_LENGTH),
    value: WorkflowJsonValue,
    schema_version: z.number().int().positive(),
    revision: DecimalCursor,
    updated_at: IsoDateTime,
  })
  .strict();
export type SharedNamespaceExportLine = z.infer<typeof SharedNamespaceExportLine>;

export const SharedPage = z
  .object({
    values: z.array(SharedValue),
    next_page_cursor: z.string().trim().min(1).nullable(),
    snapshot_cursor: DecimalCursor,
    relist_token: z.string().trim().min(1),
  })
  .strict();
export type SharedPage = z.infer<typeof SharedPage>;

export const SharedConflict = z
  .object({
    code: z.literal('shared_revision_conflict'),
    current: SharedValue.nullable(),
    current_revision: DecimalCursor.nullable(),
    retryable: z.literal(true),
  })
  .strict();
export type SharedConflict = z.infer<typeof SharedConflict>;

export const SharedChangeEventKind = z.enum(['UPSERT', 'DELETE']);
export const SharedChangeEvent = z
  .object({
    namespace_id: Identifier,
    namespace_generation: z.number().int().positive(),
    cursor: DecimalCursor,
    key: z.string().trim().min(1).max(SHARED_KEY_MAX_LENGTH),
    revision: DecimalCursor,
    schema_version: z.number().int().positive().nullable(),
    event_kind: SharedChangeEventKind,
    created_at: IsoDateTime,
  })
  .strict();
export type SharedChangeEvent = z.infer<typeof SharedChangeEvent>;

export const SharedChangesPage = z
  .object({
    changes: z.array(SharedChangeEvent),
    next_cursor: DecimalCursor,
  })
  .strict();
export type SharedChangesPage = z.infer<typeof SharedChangesPage>;

/** Realtime transports only publish invalidations; values stay behind REST authorization. */
export const SharedRealtimeInvalidation = z
  .object({
    cursor: DecimalCursor,
    key: z.string().trim().min(1).max(SHARED_KEY_MAX_LENGTH),
    revision: DecimalCursor,
  })
  .strict();
export type SharedRealtimeInvalidation = z.infer<typeof SharedRealtimeInvalidation>;

export const SharedPresenceContext = z
  .object({
    package_id: Identifier.nullable(),
    workflow_release_id: Identifier.nullable(),
  })
  .strict();
export type SharedPresenceContext = z.infer<typeof SharedPresenceContext>;

export const SharedPresenceMember = z
  .object({
    user_id: Identifier,
    display_name: z.string().trim().min(1).max(200),
    context: SharedPresenceContext,
    last_seen: IsoDateTime,
  })
  .strict();
export type SharedPresenceMember = z.infer<typeof SharedPresenceMember>;

export const SharedPresenceSnapshot = z
  .object({
    namespace_id: Identifier,
    namespace_generation: z.number().int().positive(),
    members: z.array(SharedPresenceMember),
  })
  .strict();
export type SharedPresenceSnapshot = z.infer<typeof SharedPresenceSnapshot>;

export const SharedArtifactRef = ArtifactRefV1;
export type SharedArtifactRef = z.infer<typeof SharedArtifactRef>;

export function normalizeSharedKey(value: string): string {
  const key = value.normalize('NFC');
  if (!key || key.length > SHARED_KEY_MAX_LENGTH || /[\u0000-\u001f\u007f]/u.test(key)) {
    throw new Error('shared_key_invalid');
  }
  if (key.includes('/') || key.startsWith('.') || key.startsWith('__')) {
    throw new Error('shared_key_invalid');
  }
  return key;
}

export function serializeSharedJson(value: unknown): { json: string; bytes: number } {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('shared_value_not_json');
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > SHARED_VALUE_MAX_BYTES) throw new Error('shared_value_too_large');
  return { json, bytes };
}
