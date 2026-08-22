import { z } from 'zod';
import { StrictSemVer } from './semver.ts';

/**
 * Cross-runtime limits for action contracts.  These values are intentionally
 * kept in the contract package so every adapter can enforce the same bounds.
 */
export const ACTION_MAX_COUNT = 32;
export const ACTION_DEPENDENCY_MAX_COUNT = 64;
export const ACTION_SCHEMA_MAX_BYTES = 64 * 1024;
export const ACTION_SCHEMA_MAX_DEPTH = 12;
export const ACTION_SCHEMA_MAX_NODES = 512;
export const ACTION_SCHEMA_MAX_PROPERTIES = 128;
export const ACTION_INLINE_PAYLOAD_MAX_BYTES = 256 * 1024;
export const ACTION_CALL_MAX_DEPTH = 8;
export const ACTION_CALL_MAX_CONCURRENCY = 16;

const ACTION_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const ActionId = z
  .string()
  .trim()
  .regex(ACTION_ID_PATTERN, 'action_id must match ^[a-z][a-z0-9._-]{0,63}$');
export type ActionId = z.infer<typeof ActionId>;

export const ActionInvocationKind = z.enum(['STANDARD', 'PREVIEW']);
export type ActionInvocationKind = z.infer<typeof ActionInvocationKind>;
export const ActionInvocationStatus = z.enum([
  'AUTHORIZED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
  'TIMED_OUT',
]);
export type ActionInvocationStatus = z.infer<typeof ActionInvocationStatus>;

export const ActionExecutionSemantics = z.enum(['read_only', 'idempotent', 'side_effect']);
export type ActionExecutionSemantics = z.infer<typeof ActionExecutionSemantics>;

/** Stable errors shared by action discovery, invocation and adapters. */
export const ActionErrorCode = z.enum([
  'action_not_found',
  'action_contract_mismatch',
  'action_input_invalid',
  'action_output_invalid',
  'action_dependency_denied',
  'action_policy_denied',
  'action_artifact_invalid',
  'action_cycle_detected',
  'action_depth_exceeded',
  'action_concurrency_exceeded',
  'action_timeout',
  'action_cancelled',
  'action_runtime_unavailable',
  'action_execution_failed',
  'action_idempotency_conflict',
]);
export type ActionErrorCode = z.infer<typeof ActionErrorCode>;
/** Alias retained for callers that name these errors as plugin errors. */
export const PluginActionErrorCode = ActionErrorCode;
export type PluginActionErrorCode = ActionErrorCode;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type SchemaTypeName = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';
type NullableSchemaType =
  | SchemaTypeName
  | [Exclude<SchemaTypeName, 'null'>, 'null']
  | ['null', Exclude<SchemaTypeName, 'null'>];

export type PortableJsonSchemaNode = {
  type?: NullableSchemaType;
  properties?: Record<string, PortableJsonSchemaNode>;
  required?: string[];
  additionalProperties?: false;
  items?: PortableJsonSchemaNode;
  enum?: JsonValue[];
  const?: JsonValue;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minItems?: number;
  maxItems?: number;
  format?: 'date-time' | 'uuid';
  $ref?: 'lingfang://schemas/artifact-ref/v1';
};

export type PortableJsonSchema = PortableJsonSchemaNode;

const ALLOWED_SCHEMA_KEYS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'format',
  '$ref',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addIssue(ctx: z.RefinementCtx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > ACTION_SCHEMA_MAX_DEPTH) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return isRecord(value) && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function validateBound(
  value: unknown,
  path: (string | number)[],
  ctx: z.RefinementCtx,
  name: string,
  integer: boolean
): value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (integer && !Number.isInteger(value)) ||
    value < 0
  ) {
    addIssue(ctx, path, `${name} must be a finite ${integer ? 'non-negative integer' : 'number'}`);
    return false;
  }
  return true;
}

function validatePortableSchemaNode(
  value: unknown,
  ctx: z.RefinementCtx,
  path: (string | number)[],
  state: { nodes: number },
  depth: number
): void {
  state.nodes += 1;
  if (state.nodes > ACTION_SCHEMA_MAX_NODES) {
    addIssue(ctx, path, `schema exceeds ${ACTION_SCHEMA_MAX_NODES} nodes`);
    return;
  }
  if (depth > ACTION_SCHEMA_MAX_DEPTH) {
    addIssue(ctx, path, `schema exceeds depth ${ACTION_SCHEMA_MAX_DEPTH}`);
    return;
  }
  if (!isRecord(value)) {
    addIssue(ctx, path, 'schema node must be an object');
    return;
  }

  const keys = Object.keys(value);
  for (const key of keys) {
    if (!ALLOWED_SCHEMA_KEYS.has(key))
      addIssue(ctx, [...path, key], `unsupported schema keyword: ${key}`);
  }

  if ('$ref' in value) {
    if (value.$ref !== 'lingfang://schemas/artifact-ref/v1' || keys.length !== 1) {
      addIssue(
        ctx,
        [...path, '$ref'],
        'only lingfang://schemas/artifact-ref/v1 is supported as $ref'
      );
    }
    return;
  }

  const type = value.type;
  let typeNames: SchemaTypeName[] = [];
  if (typeof type === 'string') {
    if (!['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'].includes(type)) {
      addIssue(ctx, [...path, 'type'], 'unsupported schema type');
    } else typeNames = [type as SchemaTypeName];
  } else if (Array.isArray(type)) {
    if (
      type.length !== 2 ||
      !type.includes('null') ||
      type[0] === type[1] ||
      type.some((item) => typeof item !== 'string')
    ) {
      addIssue(
        ctx,
        [...path, 'type'],
        'nullable type must contain exactly one non-null type and null'
      );
    } else {
      typeNames = type as SchemaTypeName[];
    }
  } else {
    addIssue(ctx, [...path, 'type'], 'schema type is required');
  }

  const has = (name: string): boolean => name in value;
  const hasType = (name: SchemaTypeName): boolean => typeNames.includes(name);
  const rejectUnless = (name: string, valid: boolean): void => {
    if (has(name) && !valid)
      addIssue(ctx, [...path, name], `${name} is not valid for this schema type`);
  };

  if (hasType('object')) {
    if (value.additionalProperties !== false)
      addIssue(
        ctx,
        [...path, 'additionalProperties'],
        'objects must set additionalProperties to false'
      );
    if (has('properties')) {
      if (!isRecord(value.properties))
        addIssue(ctx, [...path, 'properties'], 'properties must be an object');
      else {
        const properties = value.properties;
        const propertyNames = Object.keys(properties);
        if (propertyNames.length > ACTION_SCHEMA_MAX_PROPERTIES)
          addIssue(
            ctx,
            [...path, 'properties'],
            `objects may contain at most ${ACTION_SCHEMA_MAX_PROPERTIES} properties`
          );
        propertyNames.forEach((name) =>
          validatePortableSchemaNode(
            properties[name],
            ctx,
            [...path, 'properties', name],
            state,
            depth + 1
          )
        );
      }
    }
    if (has('required')) {
      if (
        !Array.isArray(value.required) ||
        value.required.some((item) => typeof item !== 'string' || item.length === 0)
      ) {
        addIssue(ctx, [...path, 'required'], 'required must be a list of non-empty property names');
      } else {
        const properties = isRecord(value.properties) ? Object.keys(value.properties) : [];
        const seen = new Set<string>();
        value.required.forEach((name, index) => {
          if (seen.has(name))
            addIssue(ctx, [...path, 'required', index], 'required must not contain duplicates');
          if (!properties.includes(name))
            addIssue(ctx, [...path, 'required', index], 'required property must be declared');
          seen.add(name);
        });
      }
    }
  } else {
    rejectUnless('properties', false);
    rejectUnless('required', false);
    rejectUnless('additionalProperties', false);
  }

  if (has('items')) {
    if (!hasType('array')) addIssue(ctx, [...path, 'items'], 'items is only valid for arrays');
    else validatePortableSchemaNode(value.items, ctx, [...path, 'items'], state, depth + 1);
  } else if (hasType('array')) {
    addIssue(ctx, [...path, 'items'], 'array schemas must declare items');
  }

  const stringBound = (name: string): void => {
    if (has(name)) validateBound(value[name], [...path, name], ctx, name, true);
  };
  if (has('minLength')) {
    stringBound('minLength');
    if (!hasType('string')) rejectUnless('minLength', false);
  }
  if (has('maxLength')) {
    stringBound('maxLength');
    if (!hasType('string')) rejectUnless('maxLength', false);
  }
  if (has('minItems')) {
    stringBound('minItems');
    if (!hasType('array')) rejectUnless('minItems', false);
  }
  if (has('maxItems')) {
    stringBound('maxItems');
    if (!hasType('array')) rejectUnless('maxItems', false);
  }
  if (
    hasType('string') &&
    typeof value.minLength === 'number' &&
    typeof value.maxLength === 'number' &&
    value.minLength > value.maxLength
  )
    addIssue(ctx, path, 'minLength must not exceed maxLength');
  if (
    hasType('array') &&
    typeof value.minItems === 'number' &&
    typeof value.maxItems === 'number' &&
    value.minItems > value.maxItems
  )
    addIssue(ctx, path, 'minItems must not exceed maxItems');

  for (const name of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
    if (has(name)) {
      validateBound(value[name], [...path, name], ctx, name, false);
      if (!hasType('number') && !hasType('integer')) rejectUnless(name, false);
    }
  }
  if (has('multipleOf')) {
    if (
      !validateBound(value.multipleOf, [...path, 'multipleOf'], ctx, 'multipleOf', false) ||
      value.multipleOf <= 0
    )
      addIssue(ctx, [...path, 'multipleOf'], 'multipleOf must be greater than zero');
    if (!hasType('number') && !hasType('integer')) rejectUnless('multipleOf', false);
  }

  if (has('format')) {
    if (!hasType('string') || (value.format !== 'date-time' && value.format !== 'uuid'))
      addIssue(
        ctx,
        [...path, 'format'],
        'only date-time and uuid formats are supported for strings'
      );
  }
  for (const name of ['enum', 'const']) {
    if (has(name) && !isJsonValue(value[name]))
      addIssue(ctx, [...path, name], `${name} must contain portable JSON values`);
  }
  if (Array.isArray(value.enum)) {
    if (value.enum.length === 0 || value.enum.length > 128)
      addIssue(ctx, [...path, 'enum'], 'enum must contain between 1 and 128 values');
    const seen = new Set(value.enum.map((item) => canonicalJsonValue(item as JsonValue)));
    if (seen.size !== value.enum.length)
      addIssue(ctx, [...path, 'enum'], 'enum must not contain duplicate values');
  }
}

function canonicalJsonValue(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonValue).join(',')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJsonValue(value[key] as JsonValue)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function canonicalizeSchema(value: PortableJsonSchemaNode): PortableJsonSchemaNode {
  // Validation normally guarantees a record here. Keeping this guard makes
  // diagnostic aggregation safe even when a caller supplies a malformed
  // nested schema and multiple refinements are still running.
  if (!isRecord(value)) return {};
  if (value.$ref) return { $ref: value.$ref };
  const type = Array.isArray(value.type)
    ? ([...value.type].sort() as NullableSchemaType)
    : value.type;
  const result: PortableJsonSchemaNode = {};
  if (type !== undefined) result.type = type;
  if (type === 'object' || (Array.isArray(type) && type.includes('object'))) {
    const properties = isRecord(value.properties) ? value.properties : {};
    result.properties = Object.fromEntries(
      Object.keys(properties)
        .sort()
        .map((key) => [key, canonicalizeSchema(properties[key])])
    );
    result.required = [...(value.required ?? [])].sort();
    result.additionalProperties = false;
  } else if (value.properties) {
    result.properties = Object.fromEntries(
      Object.keys(value.properties)
        .sort()
        .map((key) => [key, canonicalizeSchema(value.properties![key])])
    );
  }
  if (value.items) result.items = canonicalizeSchema(value.items);
  if (value.enum)
    result.enum = [...value.enum].sort((a, b) =>
      canonicalJsonValue(a).localeCompare(canonicalJsonValue(b))
    );
  if (value.const !== undefined) result.const = value.const;
  for (const name of [
    'minLength',
    'maxLength',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'minItems',
    'maxItems',
    'format',
  ] as const) {
    if (value[name] !== undefined) result[name] = value[name] as never;
  }
  return result;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

// 零调用方：可移植 schema 的递归校验入口写完了却没被任何地方使用。删掉等于放弃这套
// 校验，接上则会改变契约包的校验强度 —— 都不是清理该做的决定，先保留。
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function parsePortableSchema(value: unknown, root: boolean): PortableJsonSchemaNode {
  const result = PortableJsonSchemaBase.safeParse(value);
  if (!result.success)
    throw new Error(result.error.issues.map((issue) => issue.message).join('; '));
  const parsed = result.data;
  if (
    root &&
    !(parsed.type === 'object' || (Array.isArray(parsed.type) && parsed.type.includes('object')))
  )
    throw new Error('action input/output schema root must be an object');
  return parsed;
}

const PortableJsonSchemaBase = z
  .unknown()
  .superRefine((value, ctx) => {
    validatePortableSchemaNode(value, ctx, [], { nodes: 0 }, 0);
  })
  .superRefine((value, ctx) => {
    // Keep size failures inside Zod's safeParse contract rather than throwing
    // from a transform. This matters to upload validators that aggregate all
    // manifest diagnostics before rejecting the release.
    if (isRecord(value)) {
      const canonical = canonicalizeSchema(value as PortableJsonSchemaNode);
      if (utf8ByteLength(JSON.stringify(canonical)) > ACTION_SCHEMA_MAX_BYTES) {
        addIssue(ctx, [], `schema exceeds ${ACTION_SCHEMA_MAX_BYTES} bytes`);
      }
    }
  })
  .transform((value) => {
    return canonicalizeSchema(value as PortableJsonSchemaNode);
  });

/** Restricted, portable JSON Schema subset. Root object-ness is enforced by ActionPortSchema. */
export const PortableJsonSchema =
  PortableJsonSchemaBase as unknown as z.ZodType<PortableJsonSchemaNode>;

const ActionPortSchema = PortableJsonSchemaBase.superRefine((value, ctx) => {
  if (
    !(value as PortableJsonSchemaNode).type ||
    ((value as PortableJsonSchemaNode).type !== 'object' &&
      !Array.isArray((value as PortableJsonSchemaNode).type))
  ) {
    addIssue(ctx, ['type'], 'action input/output schema root must be an object');
  }
  const type = (value as PortableJsonSchemaNode).type;
  if (Array.isArray(type) ? !type.includes('object') : type !== 'object')
    addIssue(ctx, ['type'], 'action input/output schema root must be an object');
});

const SafeEntry = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => {
    if (
      /^[\\/]/.test(value) ||
      /^[A-Za-z]:/.test(value) ||
      value.includes('\\') ||
      /(^|\/)\.\.?(\/|$)/.test(value) ||
      /[\u0000-\u001f\u007f]/.test(value)
    )
      return false;
    return true;
  }, 'handler entry must be a safe artifact-relative path');
const SafeExport = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/);

export const PluginActionHandler = z.union([
  z.object({ entry: SafeEntry, export: SafeExport }).strict(),
  z.object({ entry: SafeEntry, callable: SafeExport }).strict(),
]);
export type PluginActionHandler = z.infer<typeof PluginActionHandler>;

export const PluginAction = z
  .object({
    action_id: ActionId,
    name: z.string().trim().min(1).max(128),
    description: z.string().max(4096).default(''),
    action_contract_version: StrictSemVer,
    input_schema: ActionPortSchema,
    output_schema: ActionPortSchema,
    execution_semantics: ActionExecutionSemantics,
    timeout_seconds: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60)
      .default(900),
    cloud_capable: z.boolean().default(false),
    previewable: z.boolean().default(false),
    handler: PluginActionHandler.optional(),
  })
  .strict()
  .superRefine((action, ctx) => {
    if (action.previewable && !action.cloud_capable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['previewable'],
        message: 'previewable actions must be cloud_capable',
      });
    }
    if (action.previewable && action.execution_semantics === 'side_effect') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['previewable'],
        message: 'side_effect actions cannot be previewable',
      });
    }
  });
export type PluginAction = z.infer<typeof PluginAction>;

export const VersionRange = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((value) => {
    if (/[\u0000-\u001f\u007f]/.test(value)) return false;
    const semver =
      '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?';
    const token = new RegExp(`^(?:[~^<>=]*v?${semver}|\\*|x|X)$`);
    return value.split(/\s+/).every((part) => token.test(part));
  }, 'release version range must use a bounded SemVer range');
export type VersionRange = z.infer<typeof VersionRange>;

type ParsedActionSemVer = {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<number | string>;
};

function parseActionSemVer(value: string): ParsedActionSemVer | null {
  const match =
    /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value
    );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease:
      match[4]?.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part)) ?? [],
  };
}

function compareActionSemVer(left: ParsedActionSemVer, right: ParsedActionSemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0
        ? 1
        : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined)
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    if (typeof leftPart === 'number' && typeof rightPart === 'string') return -1;
    if (typeof leftPart === 'string' && typeof rightPart === 'number') return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function actionRangeUpperBound(
  version: ParsedActionSemVer,
  operator: '^' | '~'
): ParsedActionSemVer {
  if (operator === '~')
    return { major: version.major, minor: version.minor + 1, patch: 0, prerelease: [] };
  if (version.major > 0) return { major: version.major + 1, minor: 0, patch: 0, prerelease: [] };
  if (version.minor > 0) return { major: 0, minor: version.minor + 1, patch: 0, prerelease: [] };
  return { major: 0, minor: 0, patch: version.patch + 1, prerelease: [] };
}

/** Matches the bounded, whitespace-AND range subset accepted by VersionRange. */
export function satisfiesActionVersionRange(versionText: string, range: string): boolean {
  if (!VersionRange.safeParse(range).success) return false;
  const version = parseActionSemVer(versionText);
  if (!version) return false;
  const expectedVersions: ParsedActionSemVer[] = [];
  const matches = range
    .trim()
    .split(/\s+/)
    .every((token) => {
      if (token === '*' || token === 'x' || token === 'X') return true;
      const match = /^(\^|~|<=|>=|<|>|=)?(v?.+)$/.exec(token);
      if (!match) return false;
      const expected = parseActionSemVer(match[2]);
      if (!expected) return false;
      expectedVersions.push(expected);
      const comparison = compareActionSemVer(version, expected);
      switch (match[1] ?? '=') {
        case '^':
          return (
            comparison >= 0 &&
            compareActionSemVer(version, actionRangeUpperBound(expected, '^')) < 0
          );
        case '~':
          return (
            comparison >= 0 &&
            compareActionSemVer(version, actionRangeUpperBound(expected, '~')) < 0
          );
        case '<':
          return comparison < 0;
        case '<=':
          return comparison <= 0;
        case '>':
          return comparison > 0;
        case '>=':
          return comparison >= 0;
        default:
          return comparison === 0;
      }
    });
  if (
    matches &&
    version.prerelease.length > 0 &&
    !expectedVersions.some((expected) => expected.prerelease.length > 0)
  )
    return false;
  return matches;
}

export const PluginActionDependency = z
  .object({
    dependency_id: ActionId,
    package_id: z.string().trim().min(1).max(128),
    release_version_range: VersionRange,
    action_id: ActionId,
    action_contract_version_range: VersionRange,
  })
  .strict();
export type PluginActionDependency = z.infer<typeof PluginActionDependency>;
export const ActionDependency = PluginActionDependency;
export type ActionDependency = PluginActionDependency;

export const ActionTarget = z
  .object({
    package_id: z.string().trim().min(1).max(128),
    release_id: z.string().trim().min(1).max(128),
    sha256: z.string().regex(SHA256_PATTERN, 'sha256 must be lowercase hexadecimal'),
    action_id: ActionId,
    action_contract_version: StrictSemVer,
    action_surface_sha256: z
      .string()
      .regex(SHA256_PATTERN, 'action_surface_sha256 must be lowercase hexadecimal'),
  })
  .strict();
export type ActionTarget = z.infer<typeof ActionTarget>;

export const ActionCallChainEntry = z
  .object({
    invocation_id: z.string().trim().min(1).max(128),
    target: ActionTarget,
  })
  .strict();
export type ActionCallChainEntry = z.infer<typeof ActionCallChainEntry>;

export const ActionCallerKind = z.enum(['DESKTOP', 'WEB', 'WORKFLOW', 'CLOUD', 'ACTION']);
export type ActionCallerKind = z.infer<typeof ActionCallerKind>;

export const CreateActionInvocationRequest = z
  .object({
    target: ActionTarget,
    preview: z.boolean().default(false),
    input: z.record(z.unknown()),
    request_idempotency_key: z.string().trim().min(1).max(256),
    effect_idempotency_key: z.string().trim().min(1).max(256).optional(),
    deadline_at: z.string().datetime(),
    caller: z.object({ kind: ActionCallerKind, id: z.string().trim().min(1).max(256) }).strict(),
    parent_invocation_id: z.string().trim().min(1).max(128).optional(),
  })
  .strict();
export type CreateActionInvocationRequest = z.infer<typeof CreateActionInvocationRequest>;

export const ActionInvocationSummary = z
  .object({
    id: z.string().min(1),
    team_id: z.string().min(1),
    kind: ActionInvocationKind,
    status: ActionInvocationStatus,
    target: ActionTarget,
    policy_revision: z.number().int().nonnegative(),
    required_operations: z.array(z.string()),
    root_invocation_id: z.string().min(1),
    parent_invocation_id: z.string().min(1).nullable(),
    call_chain: z.array(ActionCallChainEntry),
    input: z.record(z.unknown()),
    output: z.record(z.unknown()).nullable(),
    deadline_at: z.string().datetime(),
    created_at: z.string().datetime(),
    started_at: z.string().datetime().nullable(),
    completed_at: z.string().datetime().nullable(),
    error_code: z.string(),
    error_message: z.string(),
  })
  .strict();
export type ActionInvocationSummary = z.infer<typeof ActionInvocationSummary>;

export const ArtifactRefV1 = z
  .object({
    type: z.literal('artifact_ref'),
    artifact_id: z.string().trim().min(1).max(128),
    media_type: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .refine(
        (value) => !/[\u0000-\u001f\u007f]/.test(value),
        'media_type must not contain control characters'
      ),
    size_bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sha256: z.string().regex(SHA256_PATTERN, 'sha256 must be lowercase hexadecimal'),
    authorization: z
      .object({
        scope: z.literal('TEAM'),
        team_id: z.string().trim().min(1).max(128),
        handle: z.string().trim().min(1).max(1024),
      })
      .strict(),
  })
  .strict();
export type ArtifactRefV1 = z.infer<typeof ArtifactRefV1>;

// 这里原本包了一个 z.enum，但它从来没有被当成 schema 用过（没人 parse），只被
// z.infer 取了类型。留着一个纯运行时对象只为拿类型是浪费，直接写成联合类型。
// 值集合与 plugin.ts 的 RuntimeType 一致；不 import 过去是因为 plugin.ts 已经
// 依赖本文件，反向引用会成环。
export type ActionRuntimeType = 'client' | 'nodejs' | 'python' | 'cloud' | 'workflow';

export const PluginActionSurfaceV1 = z
  .object({
    schema_version: z.literal(1),
    action_id: ActionId,
    action_contract_version: StrictSemVer,
    input_schema: ActionPortSchema,
    output_schema: ActionPortSchema,
    execution_semantics: ActionExecutionSemantics,
    timeout_seconds: z.number().int().positive(),
    cloud_capable: z.boolean(),
    previewable: z.boolean().default(false),
    execution: z.discriminatedUnion('runtime_type', [
      z
        .object({
          runtime_type: z.enum(['client', 'nodejs']),
          entry: SafeEntry,
          export: SafeExport,
        })
        .strict(),
      z
        .object({ runtime_type: z.literal('python'), entry: SafeEntry, callable: SafeExport })
        .strict(),
      z.object({ runtime_type: z.literal('cloud'), adapter: z.literal('cloud') }).strict(),
      z
        .object({
          runtime_type: z.literal('workflow'),
          entry: SafeEntry,
          definition_sha256: z.string().regex(SHA256_PATTERN),
        })
        .strict(),
    ]),
  })
  .strict();
export type PluginActionSurfaceV1 = z.infer<typeof PluginActionSurfaceV1>;
export const ActionSurfaceV1 = PluginActionSurfaceV1;
export type ActionSurfaceV1 = PluginActionSurfaceV1;

export function projectPluginActionSurfaceV1(
  runtimeType: ActionRuntimeType,
  action: PluginAction,
  workflowIdentity?: { entry: string; definition_sha256: string }
): PluginActionSurfaceV1 {
  let execution: PluginActionSurfaceV1['execution'];
  if (runtimeType === 'workflow') {
    if (action.handler || !workflowIdentity)
      throw new Error('workflow actions require a frozen workflow identity and no package handler');
    execution = {
      runtime_type: 'workflow',
      entry: workflowIdentity.entry,
      definition_sha256: workflowIdentity.definition_sha256,
    };
  } else if (runtimeType === 'cloud') {
    if (action.handler) throw new Error('cloud actions must not declare a package handler');
    execution = { runtime_type: 'cloud', adapter: 'cloud' };
  } else if (runtimeType === 'python') {
    if (!action.handler || !('callable' in action.handler))
      throw new Error('python actions require a callable handler');
    execution = {
      runtime_type: 'python',
      entry: action.handler.entry,
      callable: action.handler.callable,
    };
  } else {
    if (!action.handler || !('export' in action.handler))
      throw new Error(`${runtimeType} actions require an export handler`);
    execution = {
      runtime_type: runtimeType,
      entry: action.handler.entry,
      export: action.handler.export,
    };
  }
  return PluginActionSurfaceV1.parse({
    schema_version: 1,
    action_id: action.action_id,
    action_contract_version: action.action_contract_version,
    input_schema: action.input_schema,
    output_schema: action.output_schema,
    execution_semantics: action.execution_semantics,
    timeout_seconds: action.timeout_seconds,
    cloud_capable: action.cloud_capable,
    previewable: action.previewable,
    execution,
  });
}

export const canonicalizePluginActionSurfaceV1 = (
  runtimeType: ActionRuntimeType,
  action: PluginAction,
  workflowIdentity?: { entry: string; definition_sha256: string }
): PluginActionSurfaceV1 => projectPluginActionSurfaceV1(runtimeType, action, workflowIdentity);

export function canonicalPluginActionSurfaceJson(
  runtimeType: ActionRuntimeType,
  action: PluginAction,
  workflowIdentity?: { entry: string; definition_sha256: string }
): string {
  return canonicalJsonValue(
    projectPluginActionSurfaceV1(runtimeType, action, workflowIdentity) as unknown as JsonValue
  );
}

export const canonicalActionSurfaceJson = canonicalPluginActionSurfaceJson;
export const projectActionSurfaceV1 = projectPluginActionSurfaceV1;
export const canonicalizeActionSurfaceV1 = canonicalizePluginActionSurfaceV1;

export const ActionSchema = ActionPortSchema;
export const RestrictedJsonSchema = PortableJsonSchema;
export const ArtifactRef = ArtifactRefV1;
export type ArtifactRef = ArtifactRefV1;
export const ActionStableErrorCode = ActionErrorCode;
export type ActionStableErrorCode = ActionErrorCode;

export function canonicalInlineActionPayloadJson(value: JsonValue): string {
  const json = canonicalJsonValue(value);
  if (utf8ByteLength(json) > ACTION_INLINE_PAYLOAD_MAX_BYTES)
    throw new Error(`inline action payload exceeds ${ACTION_INLINE_PAYLOAD_MAX_BYTES} bytes`);
  return json;
}
