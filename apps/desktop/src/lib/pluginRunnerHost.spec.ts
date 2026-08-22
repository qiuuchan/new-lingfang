import { describe, expect, it, vi } from 'vitest';
import { invokeRuntime } from './plugins-runtime';
import { handleClientHostMessage } from './pluginRunnerHost';

vi.mock('./plugins-runtime', () => ({
  invokeRuntime: vi.fn(),
}));

describe('handleClientHostMessage (client iframe opaque-origin guard, A2)', () => {
  const contentWindow = {};
  const frame = { contentWindow };
  const pluginId = 'com.example.test';

  function makeOpts(overrides: Partial<Parameters<typeof handleClientHostMessage>[1]> = {}) {
    return {
      frame,
      pluginId,
      invokeRuntime: invokeRuntime as unknown as (
        pluginId: string,
        kind: string,
        args: unknown
      ) => Promise<unknown>,
      postReply: vi.fn(),
      ...overrides,
    };
  }

  it('returns early when event.source !== frame.contentWindow', () => {
    const postReply = vi.fn();
    handleClientHostMessage(
      {
        source: {},
        origin: 'null',
        data: { __lf_host_call: true, requestId: 'r1', kind: 'fs.read', args: {} },
      },
      makeOpts({ postReply })
    );
    expect(invokeRuntime).not.toHaveBeenCalled();
    expect(postReply).not.toHaveBeenCalled();
  });

  it('returns early when event.origin !== "null"', () => {
    const postReply = vi.fn();
    handleClientHostMessage(
      {
        source: contentWindow,
        origin: 'https://attacker.example',
        data: { __lf_host_call: true, requestId: 'r1', kind: 'fs.read', args: {} },
      },
      makeOpts({ postReply })
    );
    expect(invokeRuntime).not.toHaveBeenCalled();
    expect(postReply).not.toHaveBeenCalled();
  });

  it('returns early when data is not a valid host call', () => {
    const postReply = vi.fn();
    const bad = [
      { source: contentWindow, origin: 'null', data: { __lf_host_call: false } },
      { source: contentWindow, origin: 'null', data: { __lf_host_call: true } },
      {
        source: contentWindow,
        origin: 'null',
        data: { __lf_host_call: true, requestId: 123, kind: 'fs.read' },
      },
      {
        source: contentWindow,
        origin: 'null',
        data: { __lf_host_call: true, requestId: 'r1', kind: 5 },
      },
    ];
    for (const event of bad) {
      handleClientHostMessage(event, makeOpts({ postReply }));
    }
    expect(invokeRuntime).not.toHaveBeenCalled();
    expect(postReply).not.toHaveBeenCalled();
  });

  it('dispatches and replies with result on success', async () => {
    const postReply = vi.fn();
    (invokeRuntime as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce('ok');
    handleClientHostMessage(
      {
        source: contentWindow,
        origin: 'null',
        data: { __lf_host_call: true, requestId: 'r1', kind: 'fs.read', args: { path: '/x' } },
      },
      makeOpts({ postReply })
    );
    expect(invokeRuntime).toHaveBeenCalledWith(pluginId, 'fs.read', { path: '/x' });
    await new Promise((r) => setTimeout(r, 0));
    expect(postReply).toHaveBeenCalledWith({
      __lf_host_reply: true,
      requestId: 'r1',
      result: 'ok',
    });
  });

  it('replies with error (code passed through) when invokeRuntime rejects', async () => {
    const postReply = vi.fn();
    const err = Object.assign(new Error('boom'), { code: 'E_FS' });
    (invokeRuntime as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(err);
    handleClientHostMessage(
      {
        source: contentWindow,
        origin: 'null',
        data: { __lf_host_call: true, requestId: 'r2', kind: 'fs.read', args: {} },
      },
      makeOpts({ postReply })
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(postReply).toHaveBeenCalledWith({
      __lf_host_reply: true,
      requestId: 'r2',
      error: { code: 'E_FS', message: 'boom' },
    });
  });
});
