import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./api', () => ({
  tauriInvoke: vi.fn(),
}));

import { tauriInvoke } from './api';
import { invokeRuntime, normalizeCapabilityError } from './plugins-runtime';

const mockInvoke = tauriInvoke as unknown as ReturnType<typeof vi.fn>;

describe('plugins-runtime invokeRuntime routing', () => {
  beforeEach(() => mockInvoke.mockReset());

  it('routes llm.chat to the client_llm_chat proxy command (not invoke_capability)', async () => {
    mockInvoke.mockResolvedValue({ ok: true });
    const result = await invokeRuntime('p1', 'llm.chat', { prompt: 'hi' });
    expect(mockInvoke).toHaveBeenCalledWith('client_llm_chat', {
      pluginId: 'p1',
      args: { prompt: 'hi' },
    });
    expect(mockInvoke).not.toHaveBeenCalledWith('invoke_capability', expect.anything());
    expect(result).toEqual({ ok: true });
  });

  it('routes image.generate to client_image_generate', async () => {
    mockInvoke.mockResolvedValue({});
    await invokeRuntime('p1', 'image.generate', { prompt: 'a cat' });
    expect(mockInvoke).toHaveBeenCalledWith('client_image_generate', {
      pluginId: 'p1',
      args: { prompt: 'a cat' },
    });
  });

  it('routes image.edit to client_image_edit', async () => {
    mockInvoke.mockResolvedValue({});
    await invokeRuntime('p1', 'image.edit', { image: 'base64' });
    expect(mockInvoke).toHaveBeenCalledWith('client_image_edit', {
      pluginId: 'p1',
      args: { image: 'base64' },
    });
  });

  it('routes video.generate to client_video_generate', async () => {
    mockInvoke.mockResolvedValue({});
    await invokeRuntime('p1', 'video.generate', { prompt: 'a clip' });
    expect(mockInvoke).toHaveBeenCalledWith('client_video_generate', {
      pluginId: 'p1',
      args: { prompt: 'a clip' },
    });
  });

  it('routes audio.generate to client_audio_generate', async () => {
    mockInvoke.mockResolvedValue({});
    await invokeRuntime('p1', 'audio.generate', { text: 'hello' });
    expect(mockInvoke).toHaveBeenCalledWith('client_audio_generate', {
      pluginId: 'p1',
      args: { text: 'hello' },
    });
  });

  it('routes net.fetch to the plugin_net_fetch command', async () => {
    mockInvoke.mockResolvedValue({ ok: true });
    const result = await invokeRuntime('p1', 'net.fetch', { url: 'https://example.com' });
    expect(mockInvoke).toHaveBeenCalledWith('plugin_net_fetch', {
      pluginId: 'p1',
      args: { url: 'https://example.com' },
    });
    expect(result).toEqual({ ok: true });
  });

  it('routes non-AI kinds (fs.read) to invoke_capability', async () => {
    mockInvoke.mockResolvedValue({ data: 'x' });
    await invokeRuntime('p1', 'fs.read', { path: '/a/b' });
    expect(mockInvoke).toHaveBeenCalledWith('invoke_capability', {
      pluginId: 'p1',
      kind: 'fs.read',
      args: { path: '/a/b' },
    });
    expect(mockInvoke).not.toHaveBeenCalledWith('client_fs_read', expect.anything());
  });
});

describe('normalizeCapabilityError — error string → { code, message }', () => {
  it('maps "未声明能力" to capability_not_declared', () => {
    const e = normalizeCapabilityError(new Error('插件未声明能力: storage.kv'));
    expect(e.code).toBe('capability_not_declared');
  });

  it('maps "暂未实现" to capability_not_supported', () => {
    const e = normalizeCapabilityError('插件已声明但桌面壳暂未实现: ui.view');
    expect(e.code).toBe('capability_not_supported');
  });

  it('maps SSRF guard message to net_fetch_ssrf_blocked', () => {
    const e = normalizeCapabilityError('net.fetch 禁止访问内网/保留地址（SSRF 防护）');
    expect(e.code).toBe('net_fetch_ssrf_blocked');
  });

  it('maps relay_not_configured to relay_not_configured', () => {
    const e = normalizeCapabilityError('relay_not_configured: 请先在设置中配置 relay 凭据');
    expect(e.code).toBe('relay_not_configured');
  });

  it('maps relay_error to relay_error', () => {
    const e = normalizeCapabilityError('relay_error: 上游 500');
    expect(e.code).toBe('relay_error');
  });

  it('falls back to capability_error for unknown messages', () => {
    const e = normalizeCapabilityError('boom');
    expect(e.code).toBe('capability_error');
  });
});
