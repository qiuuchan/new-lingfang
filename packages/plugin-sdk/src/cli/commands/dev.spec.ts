// dev 命令测试。
// 覆盖：nodejs 插件在 v1 被拒绝、client 插件注册成功（无 Tauri 亦可）、目录缺 manifest 报错。
import { describe, it, expect, afterEach } from 'vitest';
import { devCommand, type DevResult } from './dev.ts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ── helpers ──────────────────────────────────────────────────────────

const CLEANUP_DIRS: string[] = [];

afterEach(async () => {
  for (const dir of CLEANUP_DIRS.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'lf-dev-'));
  CLEANUP_DIRS.push(dir);
  return dir;
}

async function runDev(dir: string, opts?: { json?: boolean }): Promise<{
  exitCode: number;
  result?: DevResult;
  stdout: string;
}> {
  const originalStdout = process.stdout.write;
  let captured = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;

  let exitCode: number;
  try {
    exitCode = await devCommand([dir], { json: true, ...opts });
  } finally {
    process.stdout.write = originalStdout;
  }

  try {
    const result = JSON.parse(captured) as DevResult;
    return { exitCode, result, stdout: captured };
  } catch {
    return { exitCode, stdout: captured };
  }
}

// ── nodejs 插件在 v1 被拒绝 ───────────────────────────────────────────

describe('devCommand — v1 client-only', () => {
  it('rejects a nodejs plugin dir in v1', async () => {
    const dir = await tempDir();
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'com.dev.nodejs',
        name: 'Nodejs Dev',
        version: '0.1.0',
        description: '',
        runtime_type: 'nodejs',
        entry: 'index.js',
        visibility: 'tenant',
        capabilities: [],
      })
    );
    await writeFile(path.join(dir, 'index.js'), 'console.log(1);');

    const { exitCode, result } = await runDev(dir, { json: true });

    expect(exitCode).toBe(1);
    expect(result!.ok).toBe(false);
    expect(result!.errors.length).toBeGreaterThan(0);
    expect(result!.errors[0]).toContain('client');
  });
});

// ── client 插件注册成功（无 Tauri 运行时） ─────────────────────────────

describe('devCommand — client plugin', () => {
  it('accepts a client plugin dir', async () => {
    const dir = await tempDir();
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'com.dev.x',
        name: 'Client Dev',
        version: '0.1.0',
        description: '',
        runtime_type: 'client',
        entry: 'index.html',
        visibility: 'tenant',
        capabilities: [],
      })
    );
    await writeFile(path.join(dir, 'index.html'), '<main>hi</main>');

    const { exitCode, result } = await runDev(dir, { json: true });

    expect(exitCode).toBe(0);
    expect(result!.ok).toBe(true);
    expect(result!.origin).toBe('dev');
    expect(result!.dir).toBe(path.resolve(dir));
    expect(result!.errors).toHaveLength(0);
  });
});

// ── 缺 manifest ───────────────────────────────────────────────────────

describe('devCommand — missing manifest', () => {
  it('rejects empty dir with no manifest', async () => {
    const dir = await tempDir();

    const { exitCode, result } = await runDev(dir, { json: true });

    expect(exitCode).toBe(1);
    expect(result!.ok).toBe(false);
    expect(result!.errors[0]).toContain('manifest_not_found');
  });
});
