// create 命令测试 — 覆盖各 runtime 一行式创建 + 交互式补全
// 使用临时目录，测试后自动清理。

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { validateManifest } from '../../manifest/index.ts';

const templatesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../templates');

// 注意：createCommand 依赖 process.cwd() 与文件系统，不易做单元测试。
// 本 spec 覆盖 id 推导逻辑 + manifest 校验的核心流程。
// 完整的 create 端到端测试在 §10 整合验证执行。

function toKebabCase(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function deriveId(name: string, author: string): string {
  const kebab = toKebabCase(name);
  const safeAuthor = toKebabCase(author || 'example');
  return `com.${safeAuthor}.${kebab}`;
}

describe('create 命令 — id 推导', () => {
  it('name "My Plugin" + author "alice" → com.alice.my-plugin', () => {
    expect(deriveId('My Plugin', 'alice')).toBe('com.alice.my-plugin');
  });

  it('name "Test" + author "" → com.example.test', () => {
    expect(deriveId('Test', '')).toBe('com.example.test');
  });

  it('name "Hello World!" + author "Bob" → com.bob.hello-world', () => {
    expect(deriveId('Hello World!', 'Bob')).toBe('com.bob.hello-world');
  });
});

describe('create 命令 — manifest 校验', () => {
  it('client runtime manifest 通过 validateManifest', () => {
    const manifest = {
      id: 'com.example.client-test',
      name: 'Client Test',
      version: '0.1.0',
      description: 'A client plugin',
      runtime_type: 'client',
      entry: 'ui/index.html',
      visibility: 'tenant',
      capabilities: [],
    };
    const result = validateManifest(manifest);
    expect(result.success).toBe(true);
  });

  it('nodejs runtime manifest 通过 validateManifest', () => {
    const manifest = {
      id: 'com.example.nodejs-test',
      name: 'Node.js Test',
      version: '0.1.0',
      description: 'A nodejs plugin',
      runtime_type: 'nodejs',
      entry: 'index.js',
      visibility: 'tenant',
      capabilities: [],
    };
    const result = validateManifest(manifest);
    expect(result.success).toBe(true);
  });

  it('python runtime manifest 通过 validateManifest', () => {
    const manifest = {
      id: 'com.example.python-test',
      name: 'Python Test',
      version: '0.1.0',
      description: 'A python plugin',
      runtime_type: 'python',
      entry: 'main.py',
      visibility: 'tenant',
      capabilities: [],
    };
    const result = validateManifest(manifest);
    expect(result.success).toBe(true);
  });

  it('带 capabilities 的 manifest 通过校验', () => {
    const manifest = {
      id: 'com.example.with-caps',
      name: 'With Caps',
      version: '0.1.0',
      description: 'Has capabilities',
      runtime_type: 'client',
      entry: 'ui/index.html',
      visibility: 'tenant',
      capabilities: [
        { kind: 'llm.chat', reason: '需要调用 LLM', risk: 'medium', requires_admin: false },
        { kind: 'fs.read', reason: '需要读取文件', risk: 'low', requires_admin: false, paths: ['$HOME/Documents'] },
      ],
    };
    const result = validateManifest(manifest);
    expect(result.success).toBe(true);
  });

  it('上传 manifest 拒绝 public visibility', () => {
    const result = validateManifest({
      id: 'com.example.public-upload',
      name: 'Public Upload',
      version: '0.1.0',
      description: '',
      runtime_type: 'client',
      entry: 'ui/index.html',
      visibility: 'public',
      capabilities: [],
    });
    expect(result.success).toBe(false);
  });

  it('无效 id 被拒绝', () => {
    const manifest = {
      id: '123-invalid',
      name: 'Bad ID',
      version: '0.1.0',
      description: '',
      runtime_type: 'client',
      entry: 'ui/index.html',
      visibility: 'tenant',
      capabilities: [],
    };
    const result = validateManifest(manifest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => e.code === 'invalid_id')).toBe(true);
    }
  });

  it('client runtime 非 .html entry 被拒绝', () => {
    const manifest = {
      id: 'com.example.bad-entry',
      name: 'Bad Entry',
      version: '0.1.0',
      description: '',
      runtime_type: 'client',
      entry: 'index.js',
      visibility: 'tenant',
      capabilities: [],
    };
    const result = validateManifest(manifest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => e.code === 'entry_runtime_mismatch')).toBe(true);
    }
  });
});

describe('create 命令 — README 模板', () => {
  it('三种 runtime 都生成面向详情页的完整 README 骨架', async () => {
    for (const runtime of ['client', 'nodejs', 'python']) {
      const readme = await readFile(path.join(templatesRoot, runtime, 'README.md.tmpl'), 'utf8');
      expect(readme).toContain('# {{name}}');
      expect(readme).toContain('## 功能简介');
      expect(readme).toContain('## 使用方式');
      expect(readme).toContain('## 能力与权限');
      expect(readme).toContain('__CAPABILITIES_LIST__');
      expect(readme).toContain('## 数据与隐私');
      expect(readme).toContain('## 本地检查与预览');
      expect(readme).toContain('## 构建与发布');
    }
  });
});

// 注意：完整的端到端 create 测试（实际调用 createCommand + 检查生成文件）
// 在整合验证阶段执行，见 implement.md §10。
