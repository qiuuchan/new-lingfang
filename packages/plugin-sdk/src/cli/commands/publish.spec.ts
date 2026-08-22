// publish 命令测试 — 所有 fetch 调用均 mock，不打真实网络。
// 测试覆盖：成功发布(201)、认证失败(401)、权限不足(403)、
//           网络错误、Content-Type 验证、body 格式验证（raw Buffer，非 FormData）。
//
// 真源：.trellis/tasks/07-13-plugin-dev-sdk/research/publish-endpoint.md

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { publishCommand } from './publish.ts';

/** 快速创建临时目录并写入假的 .lfplugin 文件，返回文件路径 */
async function setupLfplugin(content?: string | Buffer): Promise<{
  tmpDir: string;
  lfpluginPath: string;
}> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'publish-test-'));
  const lfpluginPath = path.join(tmpDir, 'test-plugin.lfplugin');
  const data = content ?? 'fake-lfplugin-content';
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  await writeFile(lfpluginPath, buf);
  return { tmpDir, lfpluginPath };
}

/**
 * 创建一个最小合法的工作区目录（manifest.json + entry），用于测试
 * publish 从工作区自动 build 再上传的流程。
 */
async function setupWorkspace(): Promise<{ tmpDir: string }> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'publish-workspace-'));
  await writeFile(
    path.join(tmpDir, 'manifest.json'),
    JSON.stringify({
      id: 'com.test.publish-workspace',
      name: 'Publish Workspace Test',
      version: '0.1.0',
      description: 'workspace build test',
      runtime_type: 'nodejs',
      entry: 'index.js',
      visibility: 'tenant',
      capabilities: [],
    })
  );
  await writeFile(path.join(tmpDir, 'index.js'), "console.log('hi');\n");
  return { tmpDir };
}

async function cleanup(tmpDir: string): Promise<void> {
  try {
    await rm(tmpDir, { recursive: true, force: true });
  } catch {
    // Windows 偶尔因文件句柄未释放而清理失败，忽略
  }
}

describe('publishCommand', () => {
  beforeEach(() => {
    // 确保每个测试从干净的 env 开始（不影响其他测试）
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── 成功场景 ────────────────────────────────────────────────────────

  it('should publish successfully (201) with correct headers and raw body', async () => {
    const { tmpDir, lfpluginPath } = await setupLfplugin('fake-lfplugin-content');

    const mockJson = vi.fn().mockResolvedValue({
      package: { id: 'pkg-ulid-001', name: 'test-plugin' },
      release: { id: 'rel-ulid-002', version: '1.0.0' },
    });
    const mockResponse = { status: 201, ok: true, json: mockJson };
    const mockFetch = vi.fn().mockResolvedValue(mockResponse);
    vi.stubGlobal('fetch', mockFetch);

    const code = await publishCommand([lfpluginPath], {
      base: 'http://localhost:3000',
      token: 'test-jwt-token',
    });

    expect(code).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/api/plugin-registry/releases');
    expect(init.method).toBe('POST');
    // 关键断言：Content-Type 必须是 application/octet-stream（非 multipart/form-data）
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer test-jwt-token',
      'Content-Type': 'application/octet-stream',
    });
    // 关键断言：body 必须是 raw Buffer（非 FormData）
    expect(Buffer.isBuffer(init.body)).toBe(true);
    expect((init.body as Buffer).toString()).toBe('fake-lfplugin-content');

    await cleanup(tmpDir);
  });

  it('should include all optional headers when provided', async () => {
    const { tmpDir, lfpluginPath } = await setupLfplugin();

    const mockJson = vi.fn().mockResolvedValue({
      package: { id: 'pkg-001' },
      release: { id: 'rel-001', version: '0.1.0' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 201, ok: true, json: mockJson }));

    await publishCommand([lfpluginPath], {
      base: 'http://localhost:3000',
      token: 'jwt',
      packageId: 'existing-pkg-id',
      sourceKind: 'LINGFANG_CREATOR',
      sourceLabel: '我的桌面客户端 v2',
      clientKind: 'desktop',
    });

    const [_url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-plugin-package-id']).toBe('existing-pkg-id');
    expect(headers['x-plugin-source-kind']).toBe('LINGFANG_CREATOR');
    // sourceLabel 应被 base64url 编码
    expect(headers['x-plugin-source-label-b64']).toBeTypeOf('string');
    expect(headers['x-plugin-source-label-b64']).not.toBe('');
    // base64url 不应含 padding（'='）
    expect(headers['x-plugin-source-label-b64']).not.toContain('=');
    expect(headers['x-client']).toBe('desktop');

    await cleanup(tmpDir);
  });

  it('should handle base URL with trailing slash gracefully', async () => {
    const { tmpDir, lfpluginPath } = await setupLfplugin();

    const mockJson = vi.fn().mockResolvedValue({
      package: { id: 'pkg-001' },
      release: { id: 'rel-001', version: '0.1.0' },
    });
    const mockFetch = vi.fn().mockResolvedValue({ status: 201, ok: true, json: mockJson });
    vi.stubGlobal('fetch', mockFetch);

    // base 带尾斜杠
    await publishCommand([lfpluginPath], {
      base: 'http://localhost:3000/',
      token: 'jwt',
    });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    // 不应出现双斜杠
    expect(url).toBe('http://localhost:3000/api/plugin-registry/releases');

    await cleanup(tmpDir);
  });

  // ── 失败场景 ────────────────────────────────────────────────────────

  it('should exit with 1 on authentication failure (401)', async () => {
    const { tmpDir, lfpluginPath } = await setupLfplugin();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 401,
        ok: false,
        json: vi.fn().mockResolvedValue({ message: '未认证或 token 已过期' }),
      })
    );

    const code = await publishCommand([lfpluginPath], {
      base: 'http://localhost:3000',
      token: 'expired-jwt',
    });

    expect(code).toBe(1);
    await cleanup(tmpDir);
  });

  it('should exit with 1 on permission denied (403)', async () => {
    const { tmpDir, lfpluginPath } = await setupLfplugin();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 403,
        ok: false,
        json: vi.fn().mockResolvedValue({ message: '没有上传权限' }),
      })
    );

    const code = await publishCommand([lfpluginPath], {
      base: 'http://localhost:3000',
      token: 'no-permission-jwt',
    });

    expect(code).toBe(1);
    await cleanup(tmpDir);
  });

  it('should exit with 1 on network error (connection refused)', async () => {
    const { tmpDir, lfpluginPath } = await setupLfplugin();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('fetch failed — connect ECONNREFUSED 127.0.0.1:9999'))
    );

    const code = await publishCommand([lfpluginPath], {
      base: 'http://localhost:9999',
      token: 'jwt',
    });

    expect(code).toBe(1);
    await cleanup(tmpDir);
  });

  // ── 前置条件失败 ──────────────────────────────────────────────────────

  it('should build from workspace then publish (regression: runBuild used to always return null)', async () => {
    // 回归测试：runBuild 曾硬编码 return null，导致从工作区发布时永远失败。
    // 此用例确保：workspace 目录 → 自动 build → 拿到 .lfplugin → POST 上传。
    const { tmpDir } = await setupWorkspace();

    const mockJson = vi.fn().mockResolvedValue({
      package: { id: 'pkg-ws-001' },
      release: { id: 'rel-ws-001', version: '0.1.0' },
    });
    const mockFetch = vi.fn().mockResolvedValue({ status: 201, ok: true, json: mockJson });
    vi.stubGlobal('fetch', mockFetch);

    const code = await publishCommand([tmpDir], {
      base: 'http://localhost:3000',
      token: 'jwt',
    });

    expect(code).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [_url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    // 关键断言：body 是真实 build 出来的 ZIP 字节（不是空、不是 FormData）
    expect(Buffer.isBuffer(init.body)).toBe(true);
    expect((init.body as Buffer).length).toBeGreaterThan(0);
    // body 前 4 字节应为 ZIP 本地文件头签名 PK\x03\x04
    expect((init.body as Buffer).readUInt32LE(0)).toBe(0x04034b50);

    await cleanup(tmpDir);
  });

  it('should exit with 1 when workspace build fails (invalid manifest)', async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), 'publish-bad-ws-'));
    // 写一个非法 manifest（version 不是 semver）触发 build 失败
    await writeFile(
      path.join(tmpDir, 'manifest.json'),
      JSON.stringify({
        id: 'com.test.bad',
        name: 'Bad',
        version: 'not-semver',
        description: '',
        runtime_type: 'nodejs',
        entry: 'index.js',
        visibility: 'tenant',
        capabilities: [],
      })
    );

    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const code = await publishCommand([tmpDir], {
      base: 'http://localhost:3000',
      token: 'jwt',
    });

    expect(code).toBe(1);
    // build 失败时绝不应发起网络请求
    expect(mockFetch).not.toHaveBeenCalled();

    await cleanup(tmpDir);
  });

  it('should exit with 1 when path does not exist', async () => {
    // 用 spy 验证路径无效时不会发网络请求
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const code = await publishCommand([path.join(tmpdir(), 'does-not-exist.lfplugin')], {
      base: 'http://localhost:3000',
      token: 'jwt',
    });

    expect(code).toBe(1);
    // fetch 不应该被调用（路径无效，不会发请求）
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should exit with 1 when token is missing (no env, no opts)', async () => {
    const { tmpDir, lfpluginPath } = await setupLfplugin();

    const savedToken = process.env['LINGFANG_TOKEN'];
    delete process.env['LINGFANG_TOKEN'];

    try {
      const code = await publishCommand([lfpluginPath], {
        base: 'http://localhost:3000',
        // token 未传
      });

      expect(code).toBe(1);
    } finally {
      // 恢复环境变量
      if (savedToken !== undefined) {
        process.env['LINGFANG_TOKEN'] = savedToken;
      }
    }

    await cleanup(tmpDir);
  });

  it('should exit with 1 when base URL is missing (no env, no opts)', async () => {
    const { tmpDir, lfpluginPath } = await setupLfplugin();

    const savedBase = process.env['LINGFANG_API_BASE'];
    delete process.env['LINGFANG_API_BASE'];

    try {
      const code = await publishCommand([lfpluginPath], {
        token: 'jwt',
        // base 未传
      });

      expect(code).toBe(1);
    } finally {
      if (savedBase !== undefined) {
        process.env['LINGFANG_API_BASE'] = savedBase;
      }
    }

    await cleanup(tmpDir);
  });
});
