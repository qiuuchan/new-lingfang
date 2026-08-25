import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginActionError, PluginAiError, sdk } from './index';

type TestGlobal = typeof globalThis & {
  __lingfangInvoke?: (capability: string, args: unknown) => Promise<unknown>;
  process: { env: Record<string, string | undefined> };
};

const env = () => (globalThis as TestGlobal).process.env;

afterEach(() => {
  delete (globalThis as TestGlobal).__lingfangInvoke;
  delete env().LINGFANG_PLUGIN_BRIDGE_URL;
  delete env().LINGFANG_PLUGIN_BRIDGE_TOKEN;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('plugin AI SDK', () => {
  it('defaults chat to fast and keeps bridge credentials out of arguments', async () => {
    const bridge = vi.fn().mockResolvedValue('ok');
    (globalThis as TestGlobal).__lingfangInvoke = bridge;

    await expect(sdk.llm.chat({ messages: [{ role: 'user', content: 'hello' }] })).resolves.toBe(
      'ok'
    );
    expect(bridge).toHaveBeenCalledWith('llm.chat', {
      messages: [{ role: 'user', content: 'hello' }],
      model: 'fast',
    });
  });

  it('rejects upstream model names before invoking the host', async () => {
    const bridge = vi.fn();
    (globalThis as TestGlobal).__lingfangInvoke = bridge;

    await expect(
      sdk.llm.chat({
        messages: [{ role: 'user', content: 'hello' }],
        model: 'gpt-4o' as 'fast',
      })
    ).rejects.toMatchObject({ name: 'PluginAiError', code: 'unsupported_model', status: 400 });
    expect(bridge).not.toHaveBeenCalled();
  });

  it('does not leak timeoutMs into the host bridge arguments', async () => {
    const bridge = vi.fn().mockResolvedValue('ok');
    (globalThis as TestGlobal).__lingfangInvoke = bridge;

    await sdk.llm.chat({
      messages: [{ role: 'user', content: 'hello' }],
      timeoutMs: 5000,
    });
    expect(bridge).toHaveBeenCalledWith('llm.chat', {
      messages: [{ role: 'user', content: 'hello' }],
      model: 'fast',
    });
  });

  it('clamps a too-large timeoutMs down to 180s', async () => {
    const bridge = vi.fn().mockResolvedValue('ok');
    (globalThis as TestGlobal).__lingfangInvoke = bridge;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    await sdk.image.generate({ prompt: 'demo', timeoutMs: 999_999 });

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 180_000);
  });

  it('clamps a too-small timeoutMs up to 1s', async () => {
    const bridge = vi.fn().mockResolvedValue('ok');
    (globalThis as TestGlobal).__lingfangInvoke = bridge;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    await sdk.image.generate({ prompt: 'demo', timeoutMs: 10 });

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1_000);
  });

  it('passes a valid timeoutMs through to the race timer', async () => {
    const bridge = vi.fn().mockResolvedValue('ok');
    (globalThis as TestGlobal).__lingfangInvoke = bridge;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    await sdk.image.generate({ prompt: 'demo', timeoutMs: 45_000 });

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 45_000);
  });

  it('defaults to the 180s AI timeout when no timeoutMs is given', async () => {
    const bridge = vi.fn().mockResolvedValue('ok');
    (globalThis as TestGlobal).__lingfangInvoke = bridge;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    await sdk.image.generate({ prompt: 'demo' });

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 180_000);
  });

  it('preserves structured host errors', async () => {
    (globalThis as TestGlobal).__lingfangInvoke = vi.fn().mockRejectedValue({
      message: '团队额度不足',
      code: 'insufficient_balance',
      status: 402,
      requestId: 'req-1',
    });

    const error = await sdk.image.generate({ prompt: 'demo' }).catch((caught) => caught);
    expect(error).toBeInstanceOf(PluginAiError);
    expect(error).toMatchObject({
      message: '团队额度不足',
      code: 'insufficient_balance',
      status: 402,
      requestId: 'req-1',
    });
  });

  it('preserves nested OpenAI-compatible errors from the localhost fallback', async () => {
    env().LINGFANG_PLUGIN_BRIDGE_URL = 'http://127.0.0.1:12345';
    env().LINGFANG_PLUGIN_BRIDGE_TOKEN = 'session-token';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: '当前团队没有可用渠道',
            code: 'no_channel_available',
            requestId: 'req-local',
          },
        }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const error = await sdk.llm
      .chat({ messages: [{ role: 'user', content: 'hello' }] })
      .catch((caught) => caught);

    expect(error).toMatchObject({
      name: 'PluginAiError',
      message: '当前团队没有可用渠道',
      code: 'no_channel_available',
      status: 503,
      requestId: 'req-local',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:12345/llm/chat',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-LingFang-Plugin-Token': 'session-token' }),
      })
    );
  });

  it('uses a structured error when no host bridge is available', async () => {
    await expect(sdk.image.generate({ prompt: 'demo' })).rejects.toMatchObject({
      name: 'PluginAiError',
      code: 'bridge_unavailable',
      status: 503,
    });
  });

  it('rejects a non-local bridge URL from the environment', async () => {
    env().LINGFANG_PLUGIN_BRIDGE_URL = 'https://provider.example/v1';
    env().LINGFANG_PLUGIN_BRIDGE_TOKEN = 'session-token';

    await expect(
      sdk.llm.chat({ messages: [{ role: 'user', content: 'hello' }] })
    ).rejects.toMatchObject({
      name: 'PluginAiError',
      code: 'bridge_invalid',
      status: 503,
    });
  });

  it('defaults video.generate to fast and forwards the relay billing ticket', async () => {
    // 防绕过：插件只发 image/video base64 + seconds，桥侧扣费+注入 RBFLow 凭证转发；
    // SDK 仅透传桥返回的 { task_id, call_log_id, charged, credits }，不持任何 RBFLow 凭证。
    const bridge = vi.fn().mockResolvedValue({
      task_id: 'rbflow-task-1',
      call_log_id: 'vlog-1',
      charged: true,
      credits: 5,
    });
    (globalThis as TestGlobal).__lingfangInvoke = bridge;

    await expect(
      sdk.video.generate({
        image: 'aGVsbG8=',
        video: 'd29ybGQ=',
        seconds: 10,
      })
    ).resolves.toEqual({
      task_id: 'rbflow-task-1',
      call_log_id: 'vlog-1',
      charged: true,
      credits: 5,
    });
    expect(bridge).toHaveBeenCalledWith('video.generate', {
      image: 'aGVsbG8=',
      video: 'd29ybGQ=',
      seconds: 10,
      model: 'fast',
    });
  });

  it('routes video.generate through the localhost script bridge with tier injection', async () => {
    // 脚本回退路径（无 __lingfangInvoke）：经 localhost /video/generate，body 注入 model=platformModel。
    env().LINGFANG_PLUGIN_BRIDGE_URL = 'http://127.0.0.1:12345';
    env().LINGFANG_PLUGIN_BRIDGE_TOKEN = 'session-token';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          task_id: 'rbflow-task-2',
          call_log_id: 'vlog-2',
          charged: true,
          credits: 3,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      sdk.video.generate({
        image: 'aQ==',
        video: 'Yg==',
        seconds: 6,
        model: 'premium',
      })
    ).resolves.toEqual({
      task_id: 'rbflow-task-2',
      call_log_id: 'vlog-2',
      charged: true,
      credits: 3,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:12345/video/generate',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-LingFang-Plugin-Token': 'session-token' }),
        body: JSON.stringify({ image: 'aQ==', video: 'Yg==', seconds: 6, model: 'premium' }),
      })
    );
  });
});

describe('plugin shared SDK', () => {
  it('uses a separate typed bridge without touching legacy local storage', async () => {
    const bridge = vi
      .fn()
      .mockResolvedValue({ key: 'asset', value: { id: 1 }, schema_version: 1, revision: '2' });
    (globalThis as TestGlobal).__lingfangInvoke = bridge;
    await expect(
      sdk.shared.compareAndSet({
        namespace: 'project.assets',
        key: 'asset',
        value: { id: 1 },
        schema_version: 1,
        expected_revision: '1',
      })
    ).resolves.toMatchObject({ revision: '2' });
    expect(bridge).toHaveBeenCalledWith('shared.compare_and_set', {
      namespace: 'project.assets',
      key: 'asset',
      value: { id: 1 },
      schema_version: 1,
      expected_revision: '1',
    });
  });

  it('rejects non-serializable shared values before invoking the host', async () => {
    const bridge = vi.fn();
    (globalThis as TestGlobal).__lingfangInvoke = bridge;
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() =>
      sdk.shared.set({ namespace: 'project.assets', key: 'asset', value, schema_version: 1 })
    ).toThrow('不可序列化');
    expect(bridge).not.toHaveBeenCalled();
  });
});

describe('plugin action SDK', () => {
  it('sends only the dependency alias, input and opaque effect hint to the trusted host', async () => {
    const bridge = vi.fn().mockResolvedValue({ artifact: 'video-1' });
    (globalThis as TestGlobal).__lingfangInvoke = bridge;

    await expect(
      sdk.actions.call(
        'video_generator',
        { image: 'artifact-1' },
        {
          idempotencyKey: 'scene-7',
        }
      )
    ).resolves.toEqual({ artifact: 'video-1' });

    expect(bridge).toHaveBeenCalledWith('actions.call', {
      dependency_id: 'video_generator',
      input: { image: 'artifact-1' },
      idempotency_key: 'scene-7',
    });
    expect(bridge.mock.calls[0]?.[1]).not.toHaveProperty('request_idempotency_key');
    expect(bridge.mock.calls[0]?.[1]).not.toHaveProperty('signal');
  });

  it('preserves stable host action errors', async () => {
    (globalThis as TestGlobal).__lingfangInvoke = vi.fn().mockRejectedValue({
      message: '目标 runtime 暂不可用',
      code: 'action_runtime_unavailable',
      status: 503,
      requestId: 'req-action-1',
    });

    const error = await sdk.actions.call('video_generator', {}).catch((caught) => caught);
    expect(error).toBeInstanceOf(PluginActionError);
    expect(error).toMatchObject({
      code: 'action_runtime_unavailable',
      status: 503,
      requestId: 'req-action-1',
    });
  });

  it('maps a missing bridge and an already-aborted signal to stable action errors', async () => {
    await expect(sdk.actions.call('video_generator', {})).rejects.toMatchObject({
      code: 'action_runtime_unavailable',
    });

    const bridge = vi.fn();
    const controller = new AbortController();
    controller.abort();
    (globalThis as TestGlobal).__lingfangInvoke = bridge;
    await expect(
      sdk.actions.call('video_generator', {}, { signal: controller.signal })
    ).rejects.toMatchObject({
      code: 'action_cancelled',
    });
    expect(bridge).not.toHaveBeenCalled();
  });
});

describe('plugin artifact SDK', () => {
  const ref = {
    type: 'artifact_ref' as const,
    artifact_id: 'artifact-1',
    media_type: 'image/png',
    size_bytes: 4,
    sha256: 'a'.repeat(64),
    authorization: { scope: 'TEAM' as const, team_id: 'team-1', handle: 'signed-handle' },
  };

  it('sends typed bytes without exposing storage or authorization internals', async () => {
    const bridge = vi.fn().mockResolvedValue(ref);
    (globalThis as TestGlobal).__lingfangInvoke = bridge;
    await expect(
      sdk.artifacts.create({ dataBase64: 'UE5H', mediaType: 'image/png' })
    ).resolves.toEqual(ref);
    expect(bridge).toHaveBeenCalledWith('artifacts.create', {
      data_base64: 'UE5H',
      media_type: 'image/png',
    });
    expect(bridge.mock.calls[0]?.[1]).not.toHaveProperty('objectKey');
    expect(bridge.mock.calls[0]?.[1]).not.toHaveProperty('token');
    expect(bridge.mock.calls[0]?.[1]).not.toHaveProperty('request_idempotency_key');
  });

  it('validates signed refs before materialize/import reaches the host', async () => {
    const bridge = vi.fn().mockResolvedValue({
      dataBase64: 'UE5H',
      mediaType: 'image/png',
      sizeBytes: 4,
      sha256: 'a'.repeat(64),
    });
    (globalThis as TestGlobal).__lingfangInvoke = bridge;
    await sdk.artifacts.materialize(ref);
    expect(bridge).toHaveBeenCalledWith('artifacts.materialize', { artifact_ref: ref });
    expect(() => sdk.artifacts.import({ ...ref, sha256: 'bad' } as never)).toThrow(
      expect.objectContaining({ code: 'action_artifact_invalid' })
    );
  });

  it('uses localhost artifact routes without leaking the bridge token into JSON', async () => {
    env().LINGFANG_PLUGIN_BRIDGE_URL = 'http://127.0.0.1:12345';
    env().LINGFANG_PLUGIN_BRIDGE_TOKEN = 'session-token';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(ref), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      sdk.artifacts.create({ dataBase64: 'UE5H', mediaType: 'image/png' })
    ).resolves.toEqual(ref);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:12345/artifacts/create',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-LingFang-Plugin-Token': 'session-token' }),
        body: JSON.stringify({ data_base64: 'UE5H', media_type: 'image/png' }),
      })
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('token');
  });
});

describe('plugin storage SDK', () => {
  it('routes list to storage.kv op with prefix and returns keys', async () => {
    const bridge = vi.fn().mockResolvedValue({ keys: ['user:alice', 'user:bob'] });
    (globalThis as TestGlobal).__lingfangInvoke = bridge;

    const keys = await sdk.storage.list('user:');
    expect(keys).toEqual(['user:alice', 'user:bob']);
    expect(bridge).toHaveBeenCalledWith('storage.kv', { op: 'list', prefix: 'user:' });
  });

  it('omits prefix arg when not provided', async () => {
    const bridge = vi.fn().mockResolvedValue({ keys: [] });
    (globalThis as TestGlobal).__lingfangInvoke = bridge;

    await sdk.storage.list();
    expect(bridge).toHaveBeenCalledWith('storage.kv', { op: 'list' });
  });

  it('routes delete and returns deleted flag', async () => {
    const bridge = vi.fn().mockResolvedValue({ deleted: true });
    (globalThis as TestGlobal).__lingfangInvoke = bridge;

    const res = await sdk.storage.delete('user:alice');
    expect(res).toEqual({ deleted: true });
    expect(bridge).toHaveBeenCalledWith('storage.kv', { op: 'delete', key: 'user:alice' });
  });

  it('routes count and returns the number', async () => {
    const bridge = vi.fn().mockResolvedValue({ count: 3 });
    (globalThis as TestGlobal).__lingfangInvoke = bridge;

    const count = await sdk.storage.count();
    expect(count).toBe(3);
    expect(bridge).toHaveBeenCalledWith('storage.kv', { op: 'count' });
  });
});
