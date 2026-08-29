// manifest 校验器测试（见 design.md §9）。
// 覆盖：8 个现有插件全量通过 + 每条业务规则 ≥1 个非法用例 + validateManifest 结果形状。
import { describe, it, expect } from 'vitest';
import { validateManifest, type ManifestError, type ManifestResult } from './index.ts';
import {
  RULES,
  ruleId,
  ruleVersion,
  ruleEntryRuntimeMatch,
  ruleRuntimeLocallySupported,
  ruleKnownCapability,
  ruleMissingReason,
  ruleDuplicateCapability,
  ruleUnsafeEntryPath,
} from './rules.ts';
import type { PluginManifest } from '@qianxia/contract';

// 现有插件（内置出厂 3 个）的 manifest.json（静态 import，vitest 直接支持）
import game2048Manifest from '../../../../apps/desktop/builtin-plugins/game-2048/manifest.json';
import calculatorManifest from '../../../../apps/desktop/builtin-plugins/calculator/manifest.json';
import notesManifest from '../../../../apps/desktop/builtin-plugins/notes/manifest.json';

// ── helpers ──────────────────────────────────────────────────────────

/** 构造一个可通过 Zod + 全部业务规则的最小合法 manifest */
function validManifest(overrides?: Partial<PluginManifest>): PluginManifest {
  return {
    id: 'com.test.plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    description: 'for testing',
    runtime_type: 'client',
    entry: 'ui/index.html',
    visibility: 'tenant',
    capabilities: [],
    actions: [],
    action_dependencies: [],
    shared_namespaces: [],
    ...overrides,
  } satisfies PluginManifest;
}

function expectSuccess(
  result: ManifestResult
): asserts result is { success: true; manifest: PluginManifest; warnings: ManifestError[] } {
  expect(result.success).toBe(true);
}

function expectFailure(
  result: ManifestResult
): asserts result is Extract<ManifestResult, { success: false }> {
  expect(result.success).toBe(false);
}

// ── 现有插件全量通过 ──────────────────────────────────────────────

describe('validateManifest — 现有插件必须全部通过', () => {
  const existingPlugins: Array<{ name: string; manifest: unknown }> = [
    { name: 'game-2048', manifest: game2048Manifest },
    { name: 'calculator', manifest: calculatorManifest },
    { name: 'notes', manifest: notesManifest },
  ];

  for (const { name, manifest } of existingPlugins) {
    it(`${name} should pass validation`, () => {
      const result = validateManifest(manifest);
      if (!result.success) {
        // 失败时打印详细错误便于调试
        console.error(JSON.stringify(result.errors, null, 2));
      }
      expect(result.success).toBe(true);
    });
  }
});

// ── 结果形状 ─────────────────────────────────────────────────────────

describe('validateManifest — 结果形状', () => {
  it('合法 manifest 返回 success=true 且含 manifest 对象', () => {
    const result = validateManifest(validManifest());
    expectSuccess(result);
    expect(result.manifest.id).toBe('com.test.plugin');
  });

  it('非法 manifest 返回 success=false 且 errors 数组含 code/path/message', () => {
    const result = validateManifest({ id: '1bad' });
    expectFailure(result);
    expect(result.errors.length).toBeGreaterThan(0);
    const first = result.errors[0];
    expect(first).toHaveProperty('code');
    expect(first).toHaveProperty('path');
    expect(first).toHaveProperty('message');
    expect(typeof first.code).toBe('string');
    expect(typeof first.path).toBe('string');
    expect(typeof first.message).toBe('string');
  });
});

// ── M1：id 命名规则 ──────────────────────────────────────────────────

describe('M1 — invalid_id', () => {
  it('数字开头 → 拒绝', () => {
    const m = validManifest({ id: '123bad' });
    const errors = ruleId(m);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('invalid_id');
  });

  it('纯符号 → 拒绝', () => {
    const m = validManifest({ id: '$$$' });
    const errors = ruleId(m);
    expect(errors).toHaveLength(1);
  });

  it('空字符串 → 拒绝（Zod 层也拦截）', () => {
    const result = validateManifest(validManifest({ id: '' }));
    expectFailure(result);
  });

  it('com.foo.bar → 通过', () => {
    const m = validManifest({ id: 'com.foo.bar' });
    expect(ruleId(m)).toHaveLength(0);
  });

  it('builtin.x → 通过', () => {
    const m = validManifest({ id: 'builtin.x' });
    expect(ruleId(m)).toHaveLength(0);
  });

  it('videodl → 通过', () => {
    const m = validManifest({ id: 'videodl' });
    expect(ruleId(m)).toHaveLength(0);
  });
});

// ── M2：version 禁止 0.0.0 ────────────────────────────────────────────

describe('M2 — invalid_version', () => {
  it('0.0.0 → 拒绝', () => {
    const errors = ruleVersion(validManifest({ version: '0.0.0' }));
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('invalid_version');
  });

  it('0.0.0-alpha → 拒绝', () => {
    const errors = ruleVersion(validManifest({ version: '0.0.0-alpha' }));
    expect(errors).toHaveLength(1);
  });

  it('0.0.0-beta.1 → 拒绝', () => {
    const errors = ruleVersion(validManifest({ version: '0.0.0-beta.1' }));
    expect(errors).toHaveLength(1);
  });

  it('0.2.0 → 通过（videodl 实际版本）', () => {
    expect(ruleVersion(validManifest({ version: '0.2.0' }))).toHaveLength(0);
  });

  it('1.0.0 → 通过', () => {
    expect(ruleVersion(validManifest({ version: '1.0.0' }))).toHaveLength(0);
  });
});

// ── M3-M6：entry 与 runtime 匹配 ─────────────────────────────────────

describe('M3/M4/M5/M6 — entry_runtime_mismatch', () => {
  it('client runtime + .js 入口 → 拒绝', () => {
    const m = validManifest({ runtime_type: 'client', entry: 'index.js' });
    const errors = ruleEntryRuntimeMatch(m);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('entry_runtime_mismatch');
  });

  it('client runtime + .py 入口 → 拒绝', () => {
    const m = validManifest({ runtime_type: 'client', entry: 'main.py' });
    expect(ruleEntryRuntimeMatch(m)).toHaveLength(1);
  });

  it('nodejs runtime + .html 入口 → 拒绝', () => {
    const m = validManifest({ runtime_type: 'nodejs', entry: 'index.html' });
    const errors = ruleEntryRuntimeMatch(m);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('entry_runtime_mismatch');
  });

  it('nodejs runtime + .py 入口 → 拒绝', () => {
    const m = validManifest({ runtime_type: 'nodejs', entry: 'main.py' });
    expect(ruleEntryRuntimeMatch(m)).toHaveLength(1);
  });

  it('nodejs runtime + .mjs 入口 → 通过', () => {
    const m = validManifest({ runtime_type: 'nodejs', entry: 'server.mjs' });
    expect(ruleEntryRuntimeMatch(m)).toHaveLength(0);
  });

  it('nodejs runtime + .cjs 入口 → 通过', () => {
    const m = validManifest({ runtime_type: 'nodejs', entry: 'server.cjs' });
    expect(ruleEntryRuntimeMatch(m)).toHaveLength(0);
  });

  it('python runtime + .js 入口 → 拒绝', () => {
    const m = validManifest({ runtime_type: 'python', entry: 'index.js' });
    const errors = ruleEntryRuntimeMatch(m);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('entry_runtime_mismatch');
  });

  it('python runtime + .html 入口 → 拒绝', () => {
    const m = validManifest({ runtime_type: 'python', entry: 'index.html' });
    expect(ruleEntryRuntimeMatch(m)).toHaveLength(1);
  });

  it('cloud runtime + 非法入口 → 拒绝', () => {
    const m = validManifest({ runtime_type: 'cloud', entry: 'handler.js' });
    const errors = ruleEntryRuntimeMatch(m);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('entry_runtime_mismatch');
  });

  it('cloud runtime + https URL → 通过', () => {
    const m = validManifest({ runtime_type: 'cloud', entry: 'https://example.com/handler' });
    expect(ruleEntryRuntimeMatch(m)).toHaveLength(0);
  });

  it('cloud runtime + http URL → 通过', () => {
    const m = validManifest({ runtime_type: 'cloud', entry: 'http://example.com/handler' });
    expect(ruleEntryRuntimeMatch(m)).toHaveLength(0);
  });
});

// ── M7：unknown_capability ────────────────────────────────────────────

describe('M7 — unknown_capability', () => {
  it('未知能力 → 拒绝（直接调用规则函数，绕过 Zod 提前拦截）', () => {
    // 注意：通过 validateManifest 时，未知 kind 会被 Zod schema 提前拦截
    // （错误码 schema_invalid），M7 业务规则作为 defensive check 不会触发。
    // 因此这里直接调用规则函数验证其正确性。
    const m = validManifest({
      capabilities: [
        { kind: 'unknown.kind' as never, reason: '', risk: 'low', requires_admin: false, paths: [] },
      ],
    });
    const errors = ruleKnownCapability(m);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('unknown_capability');
  });

  it('Zod 阶段已拒绝未知 kind（defensive M7 不触发，由 schema_invalid 兜底）', () => {
    const m = {
      ...validManifest({}),
      capabilities: [{ kind: 'unknown.kind', reason: '', risk: 'low', requires_admin: false, paths: [] }],
    };
    const result = validateManifest(m);
    expect(result.success).toBe(false);
    if (!result.success) {
      // 由 Zod 拦截，错误码是 schema_invalid
      expect(result.errors.some((e) => e.code === 'schema_invalid')).toBe(true);
    }
  });

  it('合法能力全部通过', () => {
    const m = validManifest({
      capabilities: [
        { kind: 'ui.view', reason: '', risk: 'low', requires_admin: false, paths: [] },
        { kind: 'llm.chat', reason: 'need chat', risk: 'medium', requires_admin: false, paths: [] },
      ],
    });
    expect(ruleKnownCapability(m)).toHaveLength(0);
  });
});

// ── M8：missing_reason ────────────────────────────────────────────────

describe('M8 — missing_reason', () => {
  it('medium 风险 + 空 reason → 拒绝', () => {
    const m = validManifest({
      capabilities: [{ kind: 'llm.chat', reason: '', risk: 'medium', requires_admin: false, paths: [] }],
    });
    const errors = ruleMissingReason(m);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('missing_reason');
  });

  it('high 风险 + 空 reason → 拒绝', () => {
    const m = validManifest({
      capabilities: [{ kind: 'llm.chat', reason: '  ', risk: 'high', requires_admin: false, paths: [] }],
    });
    const errors = ruleMissingReason(m);
    expect(errors).toHaveLength(1);
  });

  it('medium 风险 + 有 reason → 通过', () => {
    const m = validManifest({
      capabilities: [
        { kind: 'llm.chat', reason: '调用大模型', risk: 'medium', requires_admin: false, paths: [] },
      ],
    });
    expect(ruleMissingReason(m)).toHaveLength(0);
  });

  it('none 风险 + 空 reason → 通过', () => {
    const m = validManifest({
      capabilities: [{ kind: 'ui.view', reason: '', risk: 'none', requires_admin: false, paths: [] }],
    });
    expect(ruleMissingReason(m)).toHaveLength(0);
  });
});

// ── M9：duplicate_capability ──────────────────────────────────────────

describe('M9 — duplicate_capability', () => {
  it('重复 capability → 拒绝', () => {
    const m = validManifest({
      capabilities: [
        { kind: 'llm.chat', reason: 'reason 1', risk: 'medium', requires_admin: false, paths: [] },
        { kind: 'llm.chat', reason: 'reason 2', risk: 'medium', requires_admin: false, paths: [] },
      ],
    });
    const errors = ruleDuplicateCapability(m);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('duplicate_capability');
  });

  it('不重复 → 通过', () => {
    const m = validManifest({
      capabilities: [
        { kind: 'ui.view', reason: '', risk: 'none', requires_admin: false, paths: [] },
        { kind: 'llm.chat', reason: 'chat', risk: 'medium', requires_admin: false, paths: [] },
      ],
    });
    expect(ruleDuplicateCapability(m)).toHaveLength(0);
  });

  it('无 capabilities → 通过', () => {
    expect(ruleDuplicateCapability(validManifest({ capabilities: [] }))).toHaveLength(0);
  });
});

// ── M10：unsafe_entry_path ────────────────────────────────────────────

describe('M10 — unsafe_entry_path', () => {
  it('entry 含 .. → 拒绝', () => {
    const m = validManifest({ entry: '../../../etc/passwd' });
    const errors = ruleUnsafeEntryPath(m);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('unsafe_entry_path');
  });

  it('entry 绝对路径 Unix → 拒绝', () => {
    const m = validManifest({ entry: '/etc/hosts' });
    const errors = ruleUnsafeEntryPath(m);
    expect(errors).toHaveLength(1);
  });

  it('entry 绝对路径 Windows → 拒绝', () => {
    const m = validManifest({ entry: 'C:\\foo\\bar.html' } as unknown as PluginManifest);
    const errors = ruleUnsafeEntryPath(m);
    expect(errors).toHaveLength(1);
  });

  it('entry 含反斜杠 → 拒绝', () => {
    const m = validManifest({ entry: 'ui\\index.html' } as unknown as PluginManifest);
    const errors = ruleUnsafeEntryPath(m);
    expect(errors).toHaveLength(1);
  });

  it('合法相对路径 → 通过', () => {
    expect(ruleUnsafeEntryPath(validManifest({ entry: 'ui/index.html' }))).toHaveLength(0);
  });

  it('合法单文件名 → 通过', () => {
    expect(ruleUnsafeEntryPath(validManifest({ entry: 'index.js' }))).toHaveLength(0);
  });
});

// ── schema 层面非法输入 ──────────────────────────────────────────────

describe('validateManifest — Zod schema 级错误', () => {
  it('输入是数字 → schema_invalid', () => {
    const result = validateManifest(42);
    expectFailure(result);
    expect(result.errors.some((e) => e.code === 'schema_invalid')).toBe(true);
  });

  it('输入是 null → schema_invalid', () => {
    const result = validateManifest(null);
    expectFailure(result);
    expect(result.errors.some((e) => e.code === 'schema_invalid')).toBe(true);
  });

  it('空对象 → schema_invalid（缺少 id）', () => {
    const result = validateManifest({});
    expectFailure(result);
    const idErr = result.errors.find((e) => e.path === 'id');
    expect(idErr).toBeDefined();
  });
});

// ── M11：runtime_locally_unsupported（仅警告）──

describe('M11 — runtime_locally_unsupported', () => {
  it('cloud runtime → 仅警告，不阻塞', () => {
    const m = validManifest({ runtime_type: 'cloud', entry: 'https://example.com/handler' });
    const errors = ruleRuntimeLocallySupported(m);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('runtime_locally_unsupported');
    expect(errors[0].severity).toBe('warning');
  });

  it('workflow runtime → 仅警告，不阻塞', () => {
    const m = validManifest({ runtime_type: 'workflow', entry: 'flow.yaml' });
    const errors = ruleRuntimeLocallySupported(m);
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe('warning');
  });

  it('client/nodejs/python → 无警告', () => {
    expect(ruleRuntimeLocallySupported(validManifest({ runtime_type: 'client' }))).toHaveLength(0);
    expect(ruleRuntimeLocallySupported(validManifest({ runtime_type: 'nodejs' }))).toHaveLength(0);
    expect(ruleRuntimeLocallySupported(validManifest({ runtime_type: 'python' }))).toHaveLength(0);
  });

  it('cloud manifest 校验仍 success=true 但带 warning', () => {
    const result = validateManifest(
      validManifest({ runtime_type: 'cloud', entry: 'https://example.com/handler' })
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.warnings.some((w) => w.code === 'runtime_locally_unsupported')).toBe(true);
    }
  });
});

// ── RULES 导出完整性 ──────────────────────────────────────────────────

describe('RULES 数组', () => {
  it('包含全部 9 条规则函数', () => {
    expect(RULES).toHaveLength(9);
  });

  it('每条规则都是函数且返回数组', () => {
    const m = validManifest();
    for (const rule of RULES) {
      const result = rule(m);
      expect(Array.isArray(result)).toBe(true);
    }
  });
});
