import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// 每个用例需要独立的桥模块状态（listening 守卫是模块级），故用 doMock + resetModules 重建。
async function setup() {
  vi.resetModules();
  const api = await vi.importActual<typeof import('./api')>('./api').catch(() => ({}));
  vi.doMock('./api', () => ({
    tauriInvoke: vi.fn(),
    tauriListen: vi.fn(),
  }));
  vi.doMock('./plugin-action-client-adapter', () => ({
    executeClientActionAdapter: vi.fn(),
  }));
  vi.doMock('./plugins-runtime', () => ({
    invokeRuntime: vi.fn(),
  }));

  const { tauriInvoke, tauriListen } = await import('./api');
  const { executeClientActionAdapter } = await import('./plugin-action-client-adapter');
  const bridge = await import('./clientActionBridge');
  void api;

  return { tauriInvoke, tauriListen, executeClientActionAdapter, bridge };
}

describe('clientActionBridge — plugin-action-bridge-call dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 还原 worker 模块缓存，避免 vi.resetModules()/vi.doMock 泄漏到后续 spec，
  // 否则同 worker 内后续用例的 `@` 别名解析会失效（Cannot find package '@/...'）。
  afterEach(() => {
    vi.resetModules();
  });

  it('按 args.dependency_id 命中已注册 handler 并回传 result', async () => {
    const { tauriInvoke, tauriListen, executeClientActionAdapter, bridge } = await setup();
    const mockInvoke = tauriInvoke as unknown as ReturnType<typeof vi.fn>;
    const mockListen = tauriListen as unknown as ReturnType<typeof vi.fn>;
    const mockAdapter = executeClientActionAdapter as unknown as ReturnType<typeof vi.fn>;

    let handler: ((e: { payload: unknown }) => void) | undefined;
    mockListen.mockImplementation(async (_event: string, h: (e: { payload: unknown }) => void) => {
      handler = h;
      return () => {};
    });
    mockAdapter.mockResolvedValue({ ok: true });
    bridge.initClientActionBridge();
    expect(handler).toBeDefined();

    bridge.registerClientActionHandler('video_generator', {
      pluginId: 'plugin.x',
      source: 'export const run = async () => ({})',
      exportName: 'run',
    });

    handler!({
      payload: {
        request_id: 'req-1',
        caller: { id: 'caller-inst', package_id: 'plugin.caller' },
        args: { dependency_id: 'video_generator', input: { prompt: 'hi' } },
      },
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(mockAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ invocationId: 'req-1', exportName: 'run', input: { prompt: 'hi' } })
    );
    expect(mockInvoke).toHaveBeenCalledWith('respond_plugin_action_bridge', {
      requestId: 'req-1',
      result: { ok: true },
    });
  });

  it('未命中依赖时回传 action_dependency_unresolved（不再静默挂起）', async () => {
    const { tauriInvoke, tauriListen, bridge } = await setup();
    const mockInvoke = tauriInvoke as unknown as ReturnType<typeof vi.fn>;
    const mockListen = tauriListen as unknown as ReturnType<typeof vi.fn>;

    let handler: ((e: { payload: unknown }) => void) | undefined;
    mockListen.mockImplementation(async (_event: string, h: (e: { payload: unknown }) => void) => {
      handler = h;
      return () => {};
    });
    bridge.initClientActionBridge();
    expect(handler).toBeDefined();

    handler!({
      payload: {
        request_id: 'req-2',
        caller: { id: 'caller-inst' },
        args: { dependency_id: 'unknown_action', input: {} },
      },
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(mockInvoke).toHaveBeenCalledWith('respond_plugin_action_bridge', {
      requestId: 'req-2',
      error: expect.objectContaining({ code: 'action_dependency_unresolved' }),
    });
  });
});
