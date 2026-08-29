// resolvePluginPath — CLI 位置参数路径归一化（QX-05 / g2-sdk-friction #2）。
//
// 背景：`pnpm -C packages/plugin-sdk cli:dev -- <cmd> <路径>` 会把进程 cwd 固定为
// `packages/plugin-sdk`；若用户按仓库根习惯传 `packages/plugin-sdk/examples/...`，
// 直接 `path.resolve(cwd, input)` 会二次拼接成 `packages/plugin-sdk/packages/plugin-sdk/...`。
//
// 策略：
// 1. 绝对路径原样返回；
// 2. 相对路径先按 cwd 解析，结果存在则采用（`examples/clip-digest` 这类包内相对路径）；
// 3. 不存在则向上找工作区根（pnpm-workspace.yaml），再按工作区根解析一次，
//    存在即采用（覆盖「仓库根相对路径」用法）；
// 4. 均不存在时回落到 cwd 解析结果（错误信息展示自然路径，交由命令层报错）。
import { existsSync } from 'node:fs';
import path from 'node:path';

export function resolvePluginPath(input: string, cwd: string = process.cwd()): string {
  if (path.isAbsolute(input)) return path.normalize(input);
  const fromCwd = path.resolve(cwd, input);
  if (existsSync(fromCwd)) return path.normalize(fromCwd);
  const workspaceRoot = findWorkspaceRoot(cwd);
  if (workspaceRoot) {
    const fromRoot = path.resolve(workspaceRoot, input);
    if (existsSync(fromRoot)) return path.normalize(fromRoot);
  }
  return path.normalize(fromCwd);
}

export function findWorkspaceRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}
