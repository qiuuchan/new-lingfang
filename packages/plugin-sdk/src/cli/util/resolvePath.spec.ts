// resolvePluginPath 单测（QX-05 / g2-sdk-friction #2 回归）。
// 关键场景：cwd 固定为 packages/plugin-sdk 时，仓库根相对路径不得被二次拼接。
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { findWorkspaceRoot, resolvePluginPath } from './resolvePath.ts';

const pkgCwd = path.resolve(findWorkspaceRoot(process.cwd()) ?? process.cwd(), 'packages/plugin-sdk');
const repoRoot = path.resolve(pkgCwd, '..', '..');

describe('resolvePluginPath — 路径归一化防二次拼接', () => {
  it('绝对路径原样返回（仅 normalize）', () => {
    const input = path.join(repoRoot, 'packages', 'plugin-sdk', 'examples', 'clip-digest');
    expect(resolvePluginPath(input, pkgCwd)).toBe(path.normalize(input));
  });

  it('包内相对路径按 cwd 解析（examples/clip-digest）', () => {
    expect(resolvePluginPath('examples/clip-digest', pkgCwd)).toBe(
      path.join(pkgCwd, 'examples', 'clip-digest')
    );
  });

  it('仓库根相对路径不再二次拼接（packages/plugin-sdk/examples/...）', () => {
    expect(resolvePluginPath('packages/plugin-sdk/examples/clip-digest', pkgCwd)).toBe(
      path.join(repoRoot, 'packages', 'plugin-sdk', 'examples', 'clip-digest')
    );
  });

  it('cwd 为仓库根时仓库根相对路径直接命中（不改既有用法）', () => {
    expect(resolvePluginPath('packages/plugin-sdk/examples/clip-digest', repoRoot)).toBe(
      path.join(repoRoot, 'packages', 'plugin-sdk', 'examples', 'clip-digest')
    );
  });

  it('不存在的路径回落到 cwd 解析结果（交由命令层报错）', () => {
    const input = 'packages/plugin-sdk/examples/no-such-plugin';
    expect(resolvePluginPath(input, pkgCwd)).toBe(path.resolve(pkgCwd, input));
  });
});

describe('findWorkspaceRoot — 向上定位 pnpm-workspace.yaml', () => {
  it('从 packages/plugin-sdk 向上找到仓库根', () => {
    expect(findWorkspaceRoot(pkgCwd)).toBe(repoRoot);
  });

  it('仓库根自身命中', () => {
    expect(findWorkspaceRoot(repoRoot)).toBe(repoRoot);
  });
});
