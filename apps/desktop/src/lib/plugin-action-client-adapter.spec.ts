import { describe, expect, it, vi } from 'vitest';
import {
  clientActionMessageFromFrame,
  executeClientActionAdapter,
} from './plugin-action-client-adapter';

describe('client Action opaque iframe adapter', () => {
  it('accepts messages only from the exact opaque frame and invocation nonce', () => {
    const contentWindow = {} as Window;
    const frame = { contentWindow } as HTMLIFrameElement;
    const expected = { sessionId: 'session-1', invocationId: 'invocation-1', nonce: 'nonce-1' };
    const data = {
      __lf_client_action_result: true,
      session_id: 'session-1',
      invocation_id: 'invocation-1',
      nonce: 'nonce-1',
      result: { ok: true },
    };
    expect(
      clientActionMessageFromFrame(
        { origin: 'null', source: contentWindow, data } as MessageEvent,
        frame,
        expected
      )
    ).toMatchObject({ result: { ok: true } });
    expect(
      clientActionMessageFromFrame(
        { origin: 'https://attacker.example', source: contentWindow, data } as MessageEvent,
        frame,
        expected
      )
    ).toBeNull();
    expect(
      clientActionMessageFromFrame(
        { origin: 'null', source: {} as Window, data } as MessageEvent,
        frame,
        expected
      )
    ).toBeNull();
    expect(
      clientActionMessageFromFrame(
        {
          origin: 'null',
          source: contentWindow,
          data: { ...data, nonce: 'wrong' },
        } as MessageEvent,
        frame,
        expected
      )
    ).toBeNull();
  });

  it('creates a script-only sandbox and tears it down after a valid result', async () => {
    let messageHandler: ((event: MessageEvent) => void) | undefined;
    const contentWindow = { postMessage: vi.fn() } as unknown as Window;
    const attributes = new Map<string, string>();
    const frame = {
      contentWindow,
      style: {} as CSSStyleDeclaration,
      srcdoc: '',
      setAttribute: vi.fn((name: string, value: string) => attributes.set(name, value)),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      remove: vi.fn(),
    } as unknown as HTMLIFrameElement;
    const fakeWindow = {
      addEventListener: vi.fn((kind: string, listener: EventListener) => {
        if (kind === 'message') messageHandler = listener as (event: MessageEvent) => void;
      }),
      removeEventListener: vi.fn(),
    } as unknown as Window;
    const fakeDocument = {
      createElement: vi.fn().mockReturnValue(frame),
      body: { appendChild: vi.fn() },
      documentElement: { appendChild: vi.fn() },
    } as unknown as Document;
    const promise = executeClientActionAdapter(
      {
        invocationId: 'invocation-1',
        source: 'export const run = async () => ({ ok: true })',
        exportName: 'run',
        input: {},
        timeoutMs: 1_000,
        onCapability: vi.fn(),
      },
      {
        document: fakeDocument,
        window: fakeWindow,
        uuid: vi.fn().mockReturnValueOnce('session-1').mockReturnValueOnce('nonce-1'),
      }
    );

    expect(attributes.get('sandbox')).toBe('allow-scripts');
    expect(attributes.get('sandbox')).not.toContain('allow-same-origin');
    messageHandler?.({
      origin: 'null',
      source: contentWindow,
      data: {
        __lf_client_action_result: true,
        session_id: 'session-1',
        invocation_id: 'invocation-1',
        nonce: 'nonce-1',
        result: { ok: true },
      },
    } as MessageEvent);

    await expect(promise).resolves.toEqual({ ok: true });
    expect(frame.remove).toHaveBeenCalledOnce();
    expect(fakeWindow.removeEventListener).toHaveBeenCalledWith('message', expect.any(Function));
  });
});
