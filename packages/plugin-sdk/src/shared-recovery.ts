import type {
  SharedChangeEvent,
  SharedChangesPage,
  SharedPage,
  SharedValue,
} from '@lingfang/contract';

export type SharedReplica = {
  namespace_id: string;
  namespace_generation: number;
  cursor: string;
  values: Record<string, SharedValue>;
};

export type SharedCursorDisposition = 'DUPLICATE' | 'NEXT' | 'GAP';

export class SharedRecoveryError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SharedRecoveryError';
  }
}

export function compareSharedDecimal(left: string, right: string): -1 | 0 | 1 {
  const a = normalizeDecimal(left);
  const b = normalizeDecimal(right);
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function inspectSharedCursor(
  currentCursor: string,
  incomingCursor: string
): SharedCursorDisposition {
  const order = compareSharedDecimal(incomingCursor, currentCursor);
  if (order <= 0) return 'DUPLICATE';
  return BigInt(incomingCursor) === BigInt(currentCursor) + 1n ? 'NEXT' : 'GAP';
}

export function mergeSharedValue(replica: SharedReplica, incoming: SharedValue): SharedReplica {
  assertValueScope(replica, incoming);
  const current = replica.values[incoming.key];
  if (current && compareSharedDecimal(incoming.revision, current.revision) <= 0) return replica;
  return { ...replica, values: { ...replica.values, [incoming.key]: incoming } };
}

export function applySharedChange(
  replica: SharedReplica,
  event: SharedChangeEvent,
  fetchedValue: SharedValue | null = null
): SharedReplica {
  assertChangeScope(replica, event);
  const disposition = inspectSharedCursor(replica.cursor, event.cursor);
  if (disposition === 'DUPLICATE') return replica;
  if (disposition === 'GAP') {
    throw new SharedRecoveryError(
      'shared_change_cursor_gap',
      `共享变更 cursor 存在缺口：${replica.cursor} -> ${event.cursor}`
    );
  }
  let values = replica.values;
  if (event.event_kind === 'UPSERT') {
    if (!fetchedValue || fetchedValue.key !== event.key) {
      throw new SharedRecoveryError(
        'shared_change_value_missing',
        'UPSERT 变更必须重新读取对应共享值'
      );
    }
    if (compareSharedDecimal(fetchedValue.revision, event.revision) < 0) {
      throw new SharedRecoveryError(
        'shared_change_value_stale',
        '重新读取的共享值早于变更 revision'
      );
    }
    values = mergeSharedValue({ ...replica, values }, fetchedValue).values;
  } else {
    const current = values[event.key];
    if (!current || compareSharedDecimal(current.revision, event.revision) <= 0) {
      const { [event.key]: _removed, ...remaining } = values;
      values = remaining;
    }
  }
  return { ...replica, cursor: event.cursor, values };
}

export function isSharedCursorExpired(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const source = error as { code?: unknown; status?: unknown };
  return source.code === 'shared_change_cursor_expired' || source.status === 410;
}

export async function recoverSharedReplicaAfterCursorExpiry(input: {
  namespace_id: string;
  namespace_generation: number;
  list: (request: { page_cursor?: string; relist_token?: string }) => Promise<SharedPage>;
  changes: (after: string) => Promise<SharedChangesPage>;
  get: (key: string) => Promise<SharedValue | null>;
  max_pages?: number;
}): Promise<SharedReplica> {
  const maxPages = input.max_pages ?? 1_000;
  if (!Number.isInteger(maxPages) || maxPages < 1)
    throw new SharedRecoveryError('shared_relist_limit_invalid', 'max_pages 必须是正整数');

  // The first request intentionally carries no cursor/token: the server must capture
  // snapshot_cursor before it executes the first value query.
  let page = await input.list({});
  const snapshotCursor = page.snapshot_cursor;
  const relistToken = page.relist_token;
  let replica: SharedReplica = {
    namespace_id: input.namespace_id,
    namespace_generation: input.namespace_generation,
    cursor: snapshotCursor,
    values: {},
  };
  replica = mergeRelistPage(replica, page, snapshotCursor, relistToken);

  let pages = 1;
  while (page.next_page_cursor !== null) {
    if (pages >= maxPages)
      throw new SharedRecoveryError('shared_relist_page_limit', '共享数据全量恢复页数超过限制');
    page = await input.list({ page_cursor: page.next_page_cursor, relist_token: relistToken });
    replica = mergeRelistPage(replica, page, snapshotCursor, relistToken);
    pages += 1;
  }

  let after = snapshotCursor;
  for (let changePages = 0; changePages < maxPages; changePages += 1) {
    const pageOfChanges = await input.changes(after);
    for (const event of pageOfChanges.changes) {
      const fetched = event.event_kind === 'UPSERT' ? await input.get(event.key) : null;
      replica = applySharedChange(replica, event, fetched);
    }
    if (compareSharedDecimal(pageOfChanges.next_cursor, after) < 0) {
      throw new SharedRecoveryError(
        'shared_change_cursor_regressed',
        'changes API 返回了倒退的 cursor'
      );
    }
    if (pageOfChanges.changes.length === 0 || pageOfChanges.next_cursor === after) return replica;
    after = pageOfChanges.next_cursor;
  }
  throw new SharedRecoveryError('shared_change_page_limit', '共享数据增量恢复页数超过限制');
}

function mergeRelistPage(
  replica: SharedReplica,
  page: SharedPage,
  snapshotCursor: string,
  relistToken: string
): SharedReplica {
  if (page.snapshot_cursor !== snapshotCursor || page.relist_token !== relistToken) {
    throw new SharedRecoveryError(
      'shared_relist_token_mismatch',
      '共享数据分页未保持同一 snapshot/relist token'
    );
  }
  return page.values.reduce(mergeSharedValue, replica);
}

function assertValueScope(replica: SharedReplica, value: SharedValue): void {
  if (
    value.namespace_id !== replica.namespace_id ||
    value.namespace_generation !== replica.namespace_generation
  ) {
    throw new SharedRecoveryError(
      'shared_namespace_scope_mismatch',
      '共享值不属于当前 namespace generation'
    );
  }
}

function assertChangeScope(replica: SharedReplica, event: SharedChangeEvent): void {
  if (
    event.namespace_id !== replica.namespace_id ||
    event.namespace_generation !== replica.namespace_generation
  ) {
    throw new SharedRecoveryError(
      'shared_namespace_scope_mismatch',
      '共享变更不属于当前 namespace generation'
    );
  }
}

function normalizeDecimal(value: string): string {
  if (!/^[0-9]+$/.test(value))
    throw new SharedRecoveryError(
      'shared_decimal_invalid',
      '共享 revision/cursor 必须是十进制字符串'
    );
  return value.replace(/^0+(?=\d)/, '');
}
