import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./api', () => ({
  tauriInvoke: vi.fn(),
}));

// 直接 mock 桥模块，断言生产者把正确 key/source/exportName 注册进 registry。
vi.mock('./clientActionBridge', () => ({
  registerClientActionHandler: vi.fn(),
  unregisterClientActionsForPlugin: vi.fn(),
}));

import { tauriInvoke } from './api';
import { registerClientActionHandler, unregisterClientActionsForPlugin } from './clientActionBridge';
import {
  registerClientActionsForPlugin,
  deregisterClientActionsForPlugin,
} from './clientActionRegistry';
import type { LoadedPlugin } from '@/lib/types';

const mockInvoke = tauriInvoke as unknown as ReturnType<typeof vi.fn>;
const mockRegister = registerClientActionHandler as unknown as ReturnType<typeof vi.fn>;
const mockUnregister = unregisterClientActionsForPlugin as unknown as ReturnType<typeof vi.fn>;

function pluginWith(manifest: unknown): LoadedPlugin {
  return {
    id: 'plugin.x',
    installationId: 'inst-x',
    name: 'X',
    version: '0.1.0',
    entry: 'index.html',
    runtime_type: 'client',
    manifest,
  } as LoadedPlugin;
}

describe('clientActionRegistry — producer', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockRegister.mockReset();
    mockUnregister.mockReset();
  });

  it('从 manifest.actions 注册含 client handler.entry 的 action，key = action_id', async () => {
    mockInvoke.mockResolvedValue('export const run = async () => ({})');
    const manifest = {
      actions: [
        {
          action_id: 'video_generator',
          handler: { entry: 'actions/video.ts', export: 'run' },
        },
      ],
    };
    await registerClientActionsForPlugin(pluginWith(manifest));

    expect(mockInvoke).toHaveBeenCalledWith('read_plugin_file', {
      pluginId: 'plugin.x',
      file: 'actions/video.ts',
    });
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(mockRegister).toHaveBeenCalledWith('video_generator', {
      pluginId: 'plugin.x',
      source: 'export const run = async () => ({})',
      exportName: 'run',
    });
  });

  it('支持 handler.callable 作为导出名', async () => {
    mockInvoke.mockResolvedValue('export const main = () => ({})');
    const manifest = {
      actions: [
        { action_id: 'summarize', handler: { entry: 'sum.ts', callable: 'main' } },
      ],
    };
    await registerClientActionsForPlugin(pluginWith(manifest));
    expect(mockRegister).toHaveBeenCalledWith('summarize', {
      pluginId: 'plugin.x',
      source: 'export const main = () => ({})',
      exportName: 'main',
    });
  });

  it('跳过非客户端模块（如 .py）与缺 handler 的 action', async () => {
    const manifest = {
      actions: [
        { action_id: 'py_action', handler: { entry: 'do.py', export: 'run' } }, // 非 client 模块
        { action_id: 'no_handler' }, // 无 handler
        { action_id: 'missing_export', handler: { entry: 'x.ts' } }, // 无 export/callable
      ],
    };
    await registerClientActionsForPlugin(pluginWith(manifest));
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('单个 action 读取失败时跳过该 action，不阻断其余', async () => {
    mockInvoke
      .mockRejectedValueOnce(new Error('read failed')) // 第一个 action 失败
      .mockResolvedValueOnce('export const ok = () => ({})'); // 第二个成功
    const manifest = {
      actions: [
        { action_id: 'broken', handler: { entry: 'broken.ts', export: 'run' } },
        { action_id: 'good', handler: { entry: 'good.ts', export: 'ok' } },
      ],
    };
    await registerClientActionsForPlugin(pluginWith(manifest));
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(mockRegister).toHaveBeenCalledWith('good', expect.any(Object));
  });

  it('manifest 无 actions 时为空操作', async () => {
    await registerClientActionsForPlugin(pluginWith({}));
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('deregister 透传到桥', () => {
    deregisterClientActionsForPlugin('plugin.x');
    expect(mockUnregister).toHaveBeenCalledWith('plugin.x');
  });
});
