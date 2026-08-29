// clientSdkBootstrap.spec.ts — 注入 client iframe 的 window.sdk 引导脚本回归测试。
//
// 回归背景（QX-12 验收实证）：QX-07 给 Rust 网关（client_host_caps kv_apply）与 npm SDK
// （plugin-sdk/src/index.ts）加了 storage list/delete/count，但 CLIENT_SDK_BOOTSTRAP 漏同步，
// iframe 内 window.sdk.storage.list 不存在——单测全绿、真机 e2e 才暴露（plugin 内 TypeError）。
// 本测试把引导脚本在 mock window/parent 下真实执行，断言 storage 管理 API 的
// 包络形状与 unwrap 行为与 npm SDK 门面一致，防止再次漂移。
import { describe, expect, it } from 'vitest';
import { CLIENT_SDK_BOOTSTRAP } from './clientSdkBootstrap';

interface HostCall {
  requestId: string;
  kind: string;
  args: Record<string, unknown>;
}

function makeHarness() {
  const calls: HostCall[] = [];
  let messageHandler: ((event: { data: unknown }) => void) | null = null;
  const windowMock: Record<string, unknown> = {
    addEventListener: (type: string, fn: (event: { data: unknown }) => void) => {
      if (type === 'message') messageHandler = fn;
    },
  };
  const parentMock = {
    postMessage: (data: HostCall) => {
      calls.push({ requestId: data.requestId, kind: data.kind, args: data.args });
    },
  };
  // 引导脚本是给 iframe 沙箱的 ES5 字符串，这里以 new Function 注入 mock window/parent 执行。
  new Function('window', 'parent', CLIENT_SDK_BOOTSTRAP)(windowMock, parentMock);
  const reply = (requestId: string, result: unknown) => {
    if (!messageHandler) throw new Error('message handler 未注册');
    messageHandler({ data: { __lf_host_reply: true, requestId, result } });
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk = (windowMock as any).sdk;
  return { calls, reply, sdk };
}

describe('CLIENT_SDK_BOOTSTRAP storage 管理 API（QX-07 门面同步回归）', () => {
  it('list(prefix) 发 {op:list,prefix} 包络，解包 keys 为数组', async () => {
    const { calls, reply, sdk } = makeHarness();
    const p = sdk.storage.list('user:');
    expect(calls[0].kind).toBe('storage.kv');
    expect(calls[0].args).toEqual({ op: 'list', prefix: 'user:' });
    reply(calls[0].requestId, { keys: ['user:a', 'user:b'] });
    await expect(p).resolves.toEqual(['user:a', 'user:b']);
  });

  it('list() 无 prefix 时不带 prefix 字段（与 npm SDK 条件展开一致）', async () => {
    const { calls, reply, sdk } = makeHarness();
    const p = sdk.storage.list();
    expect(calls[0].args).toEqual({ op: 'list' });
    expect('prefix' in calls[0].args).toBe(false);
    reply(calls[0].requestId, { keys: [] });
    await expect(p).resolves.toEqual([]);
  });

  it('delete(key) 发 {op:delete,key} 包络，原样回传 {deleted}（不解包）', async () => {
    const { calls, reply, sdk } = makeHarness();
    const p = sdk.storage.delete('ghost');
    expect(calls[0].args).toEqual({ op: 'delete', key: 'ghost' });
    reply(calls[0].requestId, { deleted: false });
    await expect(p).resolves.toEqual({ deleted: false });
  });

  it('count() 发 {op:count} 包络，解包 count 为数字', async () => {
    const { calls, reply, sdk } = makeHarness();
    const p = sdk.storage.count();
    expect(calls[0].args).toEqual({ op: 'count' });
    reply(calls[0].requestId, { count: 7 });
    await expect(p).resolves.toBe(7);
  });
});
