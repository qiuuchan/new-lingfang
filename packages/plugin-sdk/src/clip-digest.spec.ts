// 剪藏摘要插件（examples/clip-digest）的单元测试。
// 该插件是 client iframe（ui/index.html），其运行期逻辑无法作为模块导入；
// 这里改为对插件实际发起的同一组 SDK 调用做单测，并复刻插件的优雅降级判定函数，
// 使降级分支被测试覆盖。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginAiError, PluginAiErrorCode, sdk } from './index';

type TestGlobal = typeof globalThis & {
  __lingfangInvoke?: (capability: string, args: unknown) => Promise<unknown>;
};

afterEach(() => {
  delete (globalThis as TestGlobal).__lingfangInvoke;
  vi.restoreAllMocks();
});

// 复刻 examples/clip-digest/ui/index.html 中的降级判定逻辑（LF-05 / g2-sdk-friction #1：
// code-first，message 前缀兜底旧形态）。
function isRelayNotConfigured(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null | undefined;
  return (
    e?.code === PluginAiErrorCode.RelayNotConfigured ||
    !!e?.message?.includes('relay_not_configured')
  );
}

describe('clip-digest: clipboard + storage SDK calls', () => {
  it('sdk.clipboard.readText() routes to the clipboard bridge with op=read', async () => {
    const bridge = vi.fn().mockResolvedValue('hello clipboard');
    (globalThis as TestGlobal).__lingfangInvoke = bridge;

    await expect(sdk.clipboard.readText()).resolves.toBe('hello clipboard');
    expect(bridge).toHaveBeenCalledWith('clipboard', { op: 'read' });
  });

  it('sdk.storage.set(key, value) routes to storage.kv with op=set', async () => {
    const bridge = vi.fn().mockResolvedValue(undefined);
    (globalThis as TestGlobal).__lingfangInvoke = bridge;
    const value = { text: 'x', summary: null, createdAt: new Date().toISOString() };

    await expect(sdk.storage.set('clip-digest:abc', value)).resolves.toBeUndefined();
    expect(bridge).toHaveBeenCalledWith('storage.kv', { op: 'set', key: 'clip-digest:abc', value });
  });

  it('sdk.storage.get(key) routes to storage.kv with op=get', async () => {
    const stored = { text: 'x', summary: 's', createdAt: 't' };
    const bridge = vi.fn().mockResolvedValue(stored);
    (globalThis as TestGlobal).__lingfangInvoke = bridge;

    await expect(sdk.storage.get('clip-digest:abc')).resolves.toEqual(stored);
    expect(bridge).toHaveBeenCalledWith('storage.kv', { op: 'get', key: 'clip-digest:abc' });
  });
});

describe('clip-digest: llm + ui SDK calls', () => {
  it('sdk.llm.chat({messages}) routes to llm.chat with default model=fast', async () => {
    const bridge = vi.fn().mockResolvedValue('摘要内容');
    (globalThis as TestGlobal).__lingfangInvoke = bridge;
    const messages = [
      { role: 'system' as const, content: '你是剪藏摘要助手' },
      { role: 'user' as const, content: '长文本' },
    ];

    await expect(sdk.llm.chat({ messages })).resolves.toBe('摘要内容');
    expect(bridge).toHaveBeenCalledWith('llm.chat', { messages, model: 'fast' });
  });

  it('sdk.ui.render(content) routes to ui.view with content', async () => {
    const bridge = vi.fn().mockResolvedValue(undefined);
    (globalThis as TestGlobal).__lingfangInvoke = bridge;
    const content = { type: 'markdown', body: '摘要' };

    await expect(sdk.ui.render(content)).resolves.toBeUndefined();
    expect(bridge).toHaveBeenCalledWith('ui.view', { content });
  });
});

describe('clip-digest: graceful degradation (relay_not_configured)', () => {
  it('isRelayNotConfigured returns true when code equals relay_not_configured', () => {
    const e = Object.assign(new Error('请先在设置中配置 relay 凭据'), {
      code: 'relay_not_configured',
    });
    expect(isRelayNotConfigured(e)).toBe(true);
    expect(isRelayNotConfigured({ code: 'relay_not_configured', message: 'x' })).toBe(true);
  });

  it('isRelayNotConfigured returns false for other errors', () => {
    expect(isRelayNotConfigured(new Error('普通错误'))).toBe(false);
    expect(isRelayNotConfigured({ code: 'relay_error', message: '上游 500' })).toBe(false);
    expect(isRelayNotConfigured(null)).toBe(false);
    expect(isRelayNotConfigured({})).toBe(false);
  });

  it('sdk.llm.chat 的 relay_not_configured 拒绝现在带稳定 code（不再只有 message 前缀）', async () => {
    // 宿主 Rust 侧以裸前缀字符串 reject（client_ai_proxy.rs ERR_RELAY_NOT_CONFIGURED）。
    const bridge = vi.fn().mockRejectedValue('relay_not_configured: 请先在设置中配置 relay 凭据');
    (globalThis as TestGlobal).__lingfangInvoke = bridge;

    const error = await sdk.llm
      .chat({ messages: [{ role: 'user', content: 'hi' }] })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(PluginAiError);
    expect(error).toMatchObject({
      name: 'PluginAiError',
      code: 'relay_not_configured',
      status: 503,
    });
    expect(isRelayNotConfigured(error)).toBe(true);
  });

  it('sdk.llm.chat 的 relay_error 拒绝归一为 relay_error（非 plugin_ai_error）', async () => {
    const bridge = vi.fn().mockRejectedValue('relay_error: 上游 500');
    (globalThis as TestGlobal).__lingfangInvoke = bridge;

    const error = await sdk.llm
      .chat({ messages: [{ role: 'user', content: 'hi' }] })
      .catch((caught) => caught);

    expect(error).toMatchObject({ code: 'relay_error', status: 502 });
    expect(error).toBeInstanceOf(PluginAiError);
  });

  it('a relay_not_configured flow degrades gracefully without throwing', async () => {
    const bridge = vi.fn().mockRejectedValue(new Error('relay_not_configured'));
    (globalThis as TestGlobal).__lingfangInvoke = bridge;

    let degraded = false;
    const text = '剪贴板原文';
    const record: { text: string; summary: string | null; createdAt: string } = {
      text,
      summary: null,
      createdAt: new Date().toISOString(),
    };

    // 复刻插件 handleClip 的 LLM 分支
    await expect(
      (async () => {
        try {
          await sdk.llm.chat({
            model: 'fast',
            messages: [
              { role: 'system', content: '你是剪藏摘要助手' },
              { role: 'user', content: text },
            ],
          });
        } catch (e) {
          if (isRelayNotConfigured(e)) {
            degraded = true; // 原文已保存，不抛出
          } else {
            throw e;
          }
        }
      })()
    ).resolves.toBeUndefined();

    expect(degraded).toBe(true);
    expect(bridge).toHaveBeenCalledWith(
      'llm.chat',
      expect.objectContaining({ model: 'fast' })
    );
  });

  it('a normal summary resolution does not set degraded', async () => {
    const summary = '要点一\n要点二';
    const bridge = vi.fn()
      .mockResolvedValueOnce(summary) // llm.chat
      .mockResolvedValueOnce(undefined); // storage.set (持久化摘要)
    (globalThis as TestGlobal).__lingfangInvoke = bridge;

    let degraded = false;
    const text = '剪贴板原文';
    const record: { text: string; summary: string | null; createdAt: string } = {
      text,
      summary: null,
      createdAt: new Date().toISOString(),
    };

    const result = await (async () => {
      try {
        const summaryBody = await sdk.llm.chat({
          model: 'fast',
          messages: [
            { role: 'system', content: '你是剪藏摘要助手' },
            { role: 'user', content: text },
          ],
        });
        record.summary = typeof summaryBody === 'string' ? summaryBody : '';
        await sdk.storage.set('clip-digest:ok', record);
        return summaryBody;
      } catch (e) {
        if (isRelayNotConfigured(e)) degraded = true;
        else throw e;
      }
    })();

    expect(result).toBe(summary);
    expect(degraded).toBe(false);
    expect(bridge).toHaveBeenCalledWith(
      'storage.kv',
      expect.objectContaining({ key: 'clip-digest:ok', op: 'set' })
    );
  });
});

describe('clip-digest: llm.chat timeout is wrapped as PluginAiError', () => {
  it('wraps a capability 调用超时: llm.chat rejection as PluginAiError code=request_timeout', async () => {
    const bridge = vi.fn().mockRejectedValue(new Error('capability 调用超时: llm.chat'));
    (globalThis as TestGlobal).__lingfangInvoke = bridge;

    const error = await sdk.llm
      .chat({ messages: [{ role: 'user', content: 'hi' }] })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(PluginAiError);
    expect(error).toMatchObject({ name: 'PluginAiError', code: 'request_timeout', status: 408 });
  });
});
