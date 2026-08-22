import { test, expect } from 'vitest';
import {
  SharedNamespaceDeclaration,
  SharedNamespaceLifecycleResult,
  SharedNamespaceReactivate,
  SharedSchemaMigration,
  SharedWrite,
  SharedChangeEvent,
  SharedPresenceMember,
  SharedRealtimeInvalidation,
  normalizeSharedKey,
  serializeSharedJson,
  SHARED_VALUE_MAX_BYTES,
} from './plugin-shared-state.ts';

test('shared namespace declarations bind active and readable schema versions', () => {
  const declaration = {
    name: 'project.assets',
    active_schema_version: 2,
    read_purpose: '读取团队资产索引',
    write_purpose: '更新团队资产索引',
    schemas: [
      {
        schema_version: 1,
        schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      },
      {
        schema_version: 2,
        schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      },
    ],
  };
  expect(SharedNamespaceDeclaration.parse(declaration).active_schema_version).toBe(2);
  expect(() =>
    SharedNamespaceDeclaration.parse({ ...declaration, active_schema_version: 3 })
  ).toThrow();
  expect(() =>
    SharedNamespaceDeclaration.parse({
      ...declaration,
      schemas: [declaration.schemas[0], declaration.schemas[0]],
    })
  ).toThrow();
});

test('shared writes require schema version and support decimal CAS revisions', () => {
  expect(SharedWrite.safeParse({ value: { ok: true }, schema_version: 2 }).success).toBe(true);
  expect(
    SharedWrite.safeParse({ value: null, schema_version: 1, expected_revision: '0007' }).success
  ).toBe(true);
  expect(SharedWrite.safeParse({ value: null, schema_version: 0 }).success).toBe(false);
  expect(
    SharedWrite.safeParse({ value: null, schema_version: 1, expected_revision: 'r7' }).success
  ).toBe(false);
});

test('namespace lifecycle and explicit migrations have generation-safe contracts', () => {
  expect(SharedNamespaceReactivate.parse({ active_schema_version: 3 }).active_schema_version).toBe(
    3
  );
  expect(
    SharedSchemaMigration.safeParse({
      value: { version: 2 },
      source_schema_version: 1,
      target_schema_version: 2,
      expected_revision: '19',
    }).success
  ).toBe(true);
  expect(
    SharedSchemaMigration.safeParse({
      value: {},
      source_schema_version: 2,
      target_schema_version: 2,
      expected_revision: '19',
    }).success
  ).toBe(false);
  const lifecycle = SharedNamespaceLifecycleResult.parse({
    namespace_id: 'namespace-1',
    namespace_generation: 4,
    active_schema_version: 3,
    next_value_revision: '20',
    next_change_cursor: '21',
    used_bytes: 0,
    deleted_at: null,
  });
  expect(lifecycle.namespace_generation).toBe(4);
});

test('keys are normalized and reject path/control/reserved semantics', () => {
  expect(normalizeSharedKey('e\u0301')).toBe('é');
  expect(() => normalizeSharedKey('a/b')).toThrow(/shared_key_invalid/);
  expect(() => normalizeSharedKey('__token')).toThrow(/shared_key_invalid/);
  expect(() => normalizeSharedKey('bad\u0000')).toThrow(/shared_key_invalid/);
});

test('JSON quota is measured as UTF-8 bytes', () => {
  const encoded = serializeSharedJson({ value: '🙂' });
  expect(encoded.bytes).toBe(new TextEncoder().encode(encoded.json).byteLength);
  expect(() => serializeSharedJson('x'.repeat(SHARED_VALUE_MAX_BYTES))).toThrow(
    /shared_value_too_large/
  );
});

test('change event uses namespace cursor independent from value revision', () => {
  const change = SharedChangeEvent.parse({
    namespace_id: 'n',
    namespace_generation: 2,
    cursor: '10',
    key: 'x',
    revision: '99',
    schema_version: 1,
    event_kind: 'DELETE',
    created_at: new Date().toISOString(),
  });
  expect(change.cursor).toBe('10');
  expect(change.revision).toBe('99');
});

test('realtime invalidation contains no value or writer metadata', () => {
  const event = SharedRealtimeInvalidation.parse({
    cursor: '42',
    key: 'scene',
    revision: '99',
  });
  expect(Object.keys(event).sort()).toEqual(['cursor', 'key', 'revision']);
  expect(() => SharedRealtimeInvalidation.parse({ ...event, value: { secret: true } })).toThrow();
});

test('presence projection exposes context but no connection or token', () => {
  const member = SharedPresenceMember.parse({
    user_id: 'user-1',
    display_name: 'Lin',
    context: { package_id: 'package-1', workflow_release_id: null },
    last_seen: new Date().toISOString(),
  });
  expect(member.context.package_id).toBe('package-1');
  expect(() => SharedPresenceMember.parse({ ...member, connection_id: 'socket-1' })).toThrow();
});
