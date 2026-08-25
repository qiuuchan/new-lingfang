// validate 命令测试（见 implement.md §5）。
// 覆盖：现有合法插件全量通过 + 每种错误码至少一个用例。
import { describe, it, expect, afterEach } from 'vitest';
import { validateCommand, type ValidateResult } from './validate.ts';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── helpers ──────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
const notesPath = path.join(repoRoot, 'apps', 'desktop', 'builtin-plugins', 'notes');

const CLEANUP_DIRS: string[] = [];

afterEach(async () => {
  for (const dir of CLEANUP_DIRS.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'plugin-sdk-validate-'));
  CLEANUP_DIRS.push(dir);
  return dir;
}

async function runValidate(dir: string): Promise<ValidateResult> {
  // 捕获 stdout 以解析 JSON 输出
  const originalStdout = process.stdout.write;
  let captured = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;

  try {
    await validateCommand([], { path: dir, json: true });
  } finally {
    process.stdout.write = originalStdout;
  }

  return JSON.parse(captured) as ValidateResult;
}

// ── 合法插件全量通过 ────────────────────────────────────────────────

describe('validateCommand — 合法插件通过', () => {
  it('notes 内置插件应该通过', async () => {
    const result = await runValidate(notesPath);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ── 非法 JSON ───────────────────────────────────────────────────────

describe('validateCommand — manifest_invalid_json', () => {
  it('manifest.json 包含非法 JSON → 拒绝', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'manifest.json'), '{ bad json }');

    const result = await runValidate(dir);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('manifest_invalid_json');
  });
});

// ── 缺失 manifest ───────────────────────────────────────────────────

describe('validateCommand — manifest_not_found', () => {
  it('空目录无 manifest.json → 拒绝', async () => {
    const dir = await tempDir();

    const result = await runValidate(dir);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('manifest_not_found');
  });
});

// ── Schema 错误 ─────────────────────────────────────────────────────

describe('validateCommand — schema_invalid', () => {
  it('version 不是严格 semver ("0.1") → schema 拒绝', async () => {
    const dir = await tempDir();
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'com.test.plugin',
        name: 'Test',
        version: '0.1',
        description: '',
        runtime_type: 'client',
        entry: 'index.html',
        visibility: 'tenant',
        capabilities: [],
      })
    );

    const result = await runValidate(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.code === 'schema_invalid')).toBe(true);
  });
});

// ── 业务规则错误 ───────────────────────────────────────────────────

describe('validateCommand — entry_runtime_mismatch', () => {
  it('client 运行时 + .js 入口 → 业务规则拒绝', async () => {
    const dir = await tempDir();
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'com.test.plugin',
        name: 'Test',
        version: '1.0.0',
        description: '',
        runtime_type: 'client',
        entry: 'index.js',
        visibility: 'tenant',
        capabilities: [],
      })
    );

    const result = await runValidate(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'entry_runtime_mismatch')).toBe(true);
  });
});

// ── 入口文件不存在 ─────────────────────────────────────────────────

describe('validateCommand — entry_not_found', () => {
  it('manifest 合法但入口文件缺失 → 拒绝', async () => {
    const dir = await tempDir();
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'com.test.plugin',
        name: 'Test',
        version: '1.0.0',
        description: '',
        runtime_type: 'client',
        entry: 'ui/missing.html',
        visibility: 'tenant',
        capabilities: [],
      })
    );

    const result = await runValidate(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'entry_not_found')).toBe(true);
  });
});

// ── 入口非文件 ─────────────────────────────────────────────────────

describe('validateCommand — entry_not_file', () => {
  it('entry 指向目录而非文件 → 拒绝', async () => {
    const dir = await tempDir();
    // 用合法的 entry 名（index.html，匹配 client runtime 的 .html 要求），
    // 但实际在磁盘上创建为目录而非文件 → 触发 entry_not_file。
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'com.test.plugin',
        name: 'Test',
        version: '1.0.0',
        description: '',
        runtime_type: 'client',
        entry: 'index.html',
        visibility: 'tenant',
        capabilities: [],
      })
    );
    await mkdir(path.join(dir, 'index.html'));

    const result = await runValidate(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'entry_not_file')).toBe(true);
  });
});

// ── package.json 非法（nodejs 运行时）───────────────────────────────

describe('validateCommand — package_json_invalid (nodejs)', () => {
  it('nodejs 运行时 + package.json 非法 JSON → 拒绝', async () => {
    const dir = await tempDir();
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'com.test.plugin',
        name: 'Test',
        version: '1.0.0',
        description: '',
        runtime_type: 'nodejs',
        entry: 'index.js',
        visibility: 'tenant',
        capabilities: [],
      })
    );
    // 创建入口文件以满足 entry 检查
    await writeFile(path.join(dir, 'index.js'), 'console.log("hi");');
    // 写入非法 package.json
    await writeFile(path.join(dir, 'package.json'), '{ bad json }');

    const result = await runValidate(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'package_json_invalid')).toBe(true);
  });
});

// ── requirements.txt 非法（python 运行时）───────────────────────────

describe('validateCommand — requirements_invalid_format (python)', () => {
  it('python 运行时 + requirements.txt 格式非法 → 拒绝', async () => {
    const dir = await tempDir();
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'com.test.plugin',
        name: 'Test',
        version: '1.0.0',
        description: '',
        runtime_type: 'python',
        entry: 'main.py',
        visibility: 'tenant',
        capabilities: [],
      })
    );
    await writeFile(path.join(dir, 'main.py'), 'print("hello")');
    // 包含非法行（-r 标志或 >= 带空格的变体）
    await writeFile(
      path.join(dir, 'requirements.txt'),
      'requests\n-r requirements-dev.txt\ninvalid line here\n'
    );

    const result = await runValidate(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'requirements_invalid_format')).toBe(true);
  });
});

describe('validateCommand — README.md contract', () => {
  it('rejects an oversized or non-UTF-8 root README', async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, 'ui'), { recursive: true });
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'com.test.readme',
        name: 'README',
        version: '1.0.0',
        description: '',
        runtime_type: 'client',
        entry: 'ui/index.html',
        visibility: 'tenant',
        capabilities: [],
      })
    );
    await writeFile(path.join(dir, 'ui/index.html'), '<main></main>');
    await writeFile(path.join(dir, 'README.md'), Buffer.alloc(256 * 1024 + 1, 0x61));
    expect((await runValidate(dir)).errors.some((error) => error.code === 'readme_too_large')).toBe(
      true
    );
    await writeFile(path.join(dir, 'README.md'), Buffer.from([0xc3, 0x28]));
    expect(
      (await runValidate(dir)).errors.some((error) => error.code === 'readme_invalid_utf8')
    ).toBe(true);
  });
});

// ── JSON 输出模式 ──────────────────────────────────────────────────

describe('validateCommand — JSON 输出', () => {
  it('合法插件 JSON 输出格式正确', async () => {
    const result = await runValidate(notesPath);
    expect(result.valid).toBe(true);
    expect(typeof result.manifestPath).toBe('string');
    expect(result.manifestPath).toContain('manifest.json');
    expect(Array.isArray(result.errors)).toBe(true);
  });
});

// ── LF-08 / J3：--quiet 输出形状 ───────────────────────────────────

async function runValidateRaw(dir: string, quiet: boolean): Promise<string> {
  const originalStdout = process.stdout.write;
  let captured = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;

  try {
    await validateCommand([], { path: dir, quiet });
  } finally {
    process.stdout.write = originalStdout;
  }
  return captured;
}

describe('validateCommand — --quiet 模式 (LF-08)', () => {
  it('合法插件在 --quiet 下不输出任何内容', async () => {
    const out = await runValidateRaw(notesPath, true);
    expect(out).toBe('');
  });

  it('非法插件在 --quiet 下逐行输出错误 code（脚本可解析）', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'manifest.json'), '{ bad json }');

    const out = await runValidateRaw(dir, true);
    const lines = out.split('\n').filter((l) => l.length > 0);
    expect(lines).toEqual(['manifest_invalid_json']);
  });

  it('--quiet 与 --json 互斥：--json 优先生效', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'manifest.json'), '{ bad json }');

    const originalStdout = process.stdout.write;
    let captured = '';
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await validateCommand([], { path: dir, json: true, quiet: true });
    } finally {
      process.stdout.write = originalStdout;
    }
    const parsed = JSON.parse(captured) as ValidateResult;
    expect(parsed.valid).toBe(false);
    expect(parsed.errors[0].code).toBe('manifest_invalid_json');
  });
});

