import { describe, expect, it, vi } from 'vitest';
import type { SharedChangeEvent, SharedPage, SharedValue } from '@qianxia/contract';
import {
  SharedRecoveryError,
  applySharedChange,
  inspectSharedCursor,
  isSharedCursorExpired,
  mergeSharedValue,
  recoverSharedReplicaAfterCursorExpiry,
  type SharedReplica,
} from './shared-recovery';

const namespaceId = 'namespace-1';
const now = '2026-07-16T00:00:00.000Z';

function value(key: string, revision: string, content: unknown): SharedValue {
  return {
    namespace_id: namespaceId,
    namespace_generation: 2,
    key,
    value: content as SharedValue['value'],
    schema_version: 1,
    value_bytes: 10,
    revision,
    created_by_user_id: null,
    created_by_package_id: null,
    created_at: now,
    updated_at: now,
    artifacts: [],
  };
}

function change(
  cursor: string,
  key: string,
  revision: string,
  event_kind: 'UPSERT' | 'DELETE'
): SharedChangeEvent {
  return {
    namespace_id: namespaceId,
    namespace_generation: 2,
    cursor,
    key,
    revision,
    schema_version: event_kind === 'UPSERT' ? 1 : null,
    event_kind,
    created_at: now,
  };
}

function replica(cursor = '10', values: Record<string, SharedValue> = {}): SharedReplica {
  return { namespace_id: namespaceId, namespace_generation: 2, cursor, values };
}

function page(input: Partial<SharedPage> = {}): SharedPage {
  return {
    values: [],
    next_page_cursor: null,
    snapshot_cursor: '10',
    relist_token: 'token-1',
    ...input,
  };
}

describe('shared recovery reducer', () => {
  it('deduplicates old cursors and reports a real gap', () => {
    expect(inspectSharedCursor('10', '010')).toBe('DUPLICATE');
    expect(inspectSharedCursor('10', '11')).toBe('NEXT');
    expect(inspectSharedCursor('10', '12')).toBe('GAP');
    expect(applySharedChange(replica('10'), change('10', 'a', '1', 'DELETE'))).toEqual(
      replica('10')
    );
    expect(() => applySharedChange(replica('10'), change('12', 'a', '1', 'DELETE'))).toThrowError(
      SharedRecoveryError
    );
  });

  it('never lets an older value revision roll back a newer replica', () => {
    const current = replica('10', { a: value('a', '8', { version: 8 }) });
    expect(mergeSharedValue(current, value('a', '7', { version: 7 }))).toBe(current);
    const afterOldDelete = applySharedChange(current, change('11', 'a', '7', 'DELETE'));
    expect(afterOldDelete.values.a.revision).toBe('8');
    expect(afterOldDelete.cursor).toBe('11');
  });

  it('recognizes both the stable error code and HTTP 410 as relist signals', () => {
    expect(isSharedCursorExpired({ code: 'shared_change_cursor_expired', status: 409 })).toBe(true);
    expect(isSharedCursorExpired({ status: 410 })).toBe(true);
    expect(isSharedCursorExpired({ status: 409 })).toBe(false);
  });

  it('captures the first-page snapshot before listing and catches up from that cursor', async () => {
    const calls: string[] = [];
    const list = vi.fn(async (request: { page_cursor?: string; relist_token?: string }) => {
      calls.push(`list:${request.page_cursor ?? 'first'}`);
      if (!request.page_cursor)
        return page({ values: [value('a', '5', { version: 5 })], next_page_cursor: 'page-2' });
      expect(request.relist_token).toBe('token-1');
      return page({ values: [value('a', '4', { version: 4 }), value('b', '7', { version: 7 })] });
    });
    const changes = vi.fn(async (after: string) => {
      calls.push(`changes:${after}`);
      if (after === '10') return { changes: [change('11', 'a', '6', 'UPSERT')], next_cursor: '11' };
      return { changes: [], next_cursor: '11' };
    });
    const get = vi.fn(async (key: string) => {
      calls.push(`get:${key}`);
      return value(key, '8', { version: 8 });
    });

    const restored = await recoverSharedReplicaAfterCursorExpiry({
      namespace_id: namespaceId,
      namespace_generation: 2,
      list,
      changes,
      get,
    });

    expect(calls).toEqual(['list:first', 'list:page-2', 'changes:10', 'get:a', 'changes:11']);
    expect(restored.cursor).toBe('11');
    expect(restored.values.a.revision).toBe('8');
    expect(restored.values.b.revision).toBe('7');
  });

  it('rejects a relist page that changes snapshot cursor or token', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(page({ next_page_cursor: 'page-2' }))
      .mockResolvedValueOnce(page({ snapshot_cursor: '11', relist_token: 'token-2' }));
    await expect(
      recoverSharedReplicaAfterCursorExpiry({
        namespace_id: namespaceId,
        namespace_generation: 2,
        list,
        changes: vi.fn(),
        get: vi.fn(),
      })
    ).rejects.toMatchObject({ code: 'shared_relist_token_mismatch' });
  });
});
