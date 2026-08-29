// create 命令：交互式 + 一行式新建插件工程。
// 按 design.md §2.1 实现。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../log.ts';
import { askText, askSelect, askMultiselect } from '../util/prompt.ts';
import { ensureDir, writeFile, pathExists } from '../util/fs.ts';
import { readFile, readdir } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VALID_RUNTIMES = ['client', 'nodejs', 'python'] as const;
type Runtime = (typeof VALID_RUNTIMES)[number];

const CAPABILITY_OPTIONS = [
  'ui.view',
  'fs.read',
  'fs.write',
  'fs.pick',
  'llm.chat',
  'image.generate',
  'clipboard',
  'storage.kv',
  'system.info',
  'system.notify',
  'net.fetch',
];

const ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9-_.]*$/;

/** 名字转 kebab-case */
function toKebabCase(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** 推导插件 id：com.<author>.<kebab-name> */
function deriveId(name: string, author: string): string {
  const kebab = toKebabCase(name);
  const safeAuthor = toKebabCase(author || 'example');
  return `com.${safeAuthor}.${kebab}`;
}

/** 获取默认作者名：git config user.name → 'example' */
async function getDefaultAuthor(): Promise<string> {
  try {
    const { execSync } = await import('node:child_process');
    const name = execSync('git config user.name', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (name) return name;
  } catch {
    // git 不可用或未配置，fallback
  }
  return 'example';
}

/** 替换模板变量 */
function renderTemplate(content: string, vars: Record<string, string>): string {
  let result = content;
  // 先替换所有 {{var}} 占位符
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  // 再替换双下划线占位符（__NAME__）。
  // 关键：必须按 key 长度降序替换，防止 __CAPABILITIES__ 子串匹配吃掉 __CAPABILITIES_LIST__。
  const underscoreKeys = Object.keys(vars)
    .filter((k) => k.startsWith('__') && k.endsWith('__'))
    .sort((a, b) => b.length - a.length);
  for (const key of underscoreKeys) {
    result = result.replaceAll(key, vars[key]);
  }
  return result;
}

/** 递归收集目录下所有文件路径（相对于 srcDir） */
async function collectFiles(srcDir: string, baseDir: string = srcDir): Promise<string[]> {
  const entries = await readdir(srcDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(srcDir, entry.name);
    if (entry.isDirectory()) {
      const subFiles = await collectFiles(fullPath, baseDir);
      files.push(...subFiles);
    } else {
      // 计算相对路径
      files.push(path.relative(baseDir, fullPath));
    }
  }

  return files;
}

export async function createCommand(
  positional: string[],
  flags: Record<string, string | boolean>
): Promise<number> {
  // —— 参数解析 ——
  let name = positional[0] ?? String(flags['name'] ?? '').trim();
  let runtime = String(flags['runtime'] ?? '').trim() as Runtime | '';
  let id = String(flags['id'] ?? '').trim();
  let author = String(flags['author'] ?? '').trim();
  let description = String(flags['description'] ?? '').trim();
  let visibility = String(flags['visibility'] ?? 'tenant').trim();
  const capabilitiesRaw = String(flags['capabilities'] ?? '').trim();
  const force = Boolean(flags['force']);

  // 上传 manifest 只允许 private / tenant；public 由市场审核后赋予。
  if (!['private', 'tenant'].includes(visibility)) {
    visibility = 'tenant';
  }

  // —— 交互式补全 ——
  const interactive = !name || !runtime;

  if (interactive) {
    log.info('交互式创建插件工程');

    if (!name) {
      name = await askText('插件显示名', 'my-plugin');
    }
    if (!runtime) {
      const idx = await askSelect('选择运行时类型', [
        'client — 前端 UI 插件（iframe + HTML）',
        'nodejs — Node.js 脚本插件',
        'python — Python 脚本插件',
      ]);
      runtime = VALID_RUNTIMES[idx];
    }
  }

  if (!name) {
    log.error('插件名不能为空');
    return 1;
  }

  // author
  if (!author) {
    author = await getDefaultAuthor();
    if (interactive) {
      const input = await askText('插件作者', author);
      if (input) author = input;
    }
  }

  // id
  if (!id) {
    id = deriveId(name, author);
    if (interactive) {
      const input = await askText('插件 ID', id);
      if (input) id = input;
    }
  }

  // description
  if (!description && interactive) {
    description = await askText('插件描述', '');
  }

  // visibility
  if (interactive) {
    const visIdx = await askSelect('可见度', ['私有 (private)', '租户 (tenant)'], 1);
    visibility = ['private', 'tenant'][visIdx];
  }

  // capabilities
  let capabilities: Array<{ kind: string; reason: string; risk: string }> = [];
  if (capabilitiesRaw) {
    // 从命令行解析
    const kinds = capabilitiesRaw
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    capabilities = kinds.map((kind) => ({
      kind,
      reason: `命令行声明`,
      risk: 'medium',
    }));
  } else if (interactive) {
    const selected = await askMultiselect('选择需要的能力（可跳过）', CAPABILITY_OPTIONS);
    for (const idx of selected) {
      const kind = CAPABILITY_OPTIONS[idx];
      const reason = await askText(`  ${kind} 的使用理由`, '插件核心功能');
      capabilities.push({ kind, reason: reason || '插件核心功能', risk: 'medium' });
    }
  }

  // —— 校验 ——
  if (!VALID_RUNTIMES.includes(runtime as Runtime)) {
    log.error(`不支持的运行时："${runtime}"。支持：${VALID_RUNTIMES.join(', ')}`);
    return 1;
  }

  if (!ID_PATTERN.test(id)) {
    log.error(
      `id "${id}" 不合法：必须以英文字母开头，只能包含字母、数字、连字符(-)、下划线(_)、点号(.)`
    );
    return 1;
  }

  // —— 目标目录 ——
  const destDir = path.resolve(process.cwd(), name);

  if (!force && (await pathExists(destDir))) {
    const entries = await readdir(destDir);
    if (entries.length > 0) {
      log.error(`目录 "${name}" 已存在且非空。使用 --force 强制覆盖。`);
      return 1;
    }
  }

  await ensureDir(destDir);

  // —— 模板目录 ——
  const templateDir = path.resolve(__dirname, '../../templates', runtime);

  if (!(await pathExists(templateDir))) {
    log.error(`模板目录不存在：${templateDir}`);
    return 1;
  }

  // —— 构建变量 ——
  const version = '0.1.0';

  // 构建 capabilities JSON 字符串
  let capabilitiesJson = '';
  if (capabilities.length > 0) {
    const entries = capabilities.map(
      (c, i) =>
        `${i > 0 ? ',\n    ' : ''}{ "kind": "${c.kind}", "reason": "${c.reason}", "risk": "${c.risk}", "requires_admin": false }`
    );
    capabilitiesJson = entries.join('');
  }

  // 构建 README 中人类可读的能力列表（Markdown 项目符号）
  // 占位符 __CAPABILITIES_LIST__ 与 manifest JSON 占位 __CAPABILITIES__ 必须分开替换，
  // 否则子串匹配会让 __CAPABILITIES_LIST__ 被替换成 "<json>_LIST__"。
  const capabilitiesList =
    capabilities.length > 0
      ? capabilities
          .map((c) => `- \`${c.kind}\` — ${c.reason || '插件核心功能'}（风险：${c.risk}）`)
          .join('\n')
      : '- （暂未声明能力）';

  const vars: Record<string, string> = {
    id,
    name,
    version,
    description: description || `${name} 插件`,
    visibility,
    author,
    __CAPABILITIES__: capabilitiesJson,
    __CAPABILITIES_LIST__: capabilitiesList,
  };

  // —— 拷贝并渲染模板 ——
  const files = await collectFiles(templateDir);

  for (const relativePath of files) {
    const srcPath = path.join(templateDir, relativePath);

    // 目标文件名：去掉 .tmpl 后缀
    let destRelative = relativePath;
    if (destRelative.endsWith('.tmpl')) {
      destRelative = destRelative.slice(0, -'.tmpl'.length);
    }
    const destPath = path.join(destDir, destRelative);

    const content = await readFile(srcPath, 'utf-8');
    // 所有模板文件统一走 renderTemplate（manifest 走 __CAPABILITIES__ JSON 占位，
    // README 走 __CAPABILITIES_LIST__ Markdown 占位，普通文件走 {{var}}）。
    const rendered = renderTemplate(content, vars);

    await writeFile(destPath, rendered);
  }

  // —— 输出总结 ——
  log.success(`已创建插件：./${name}`);
  log.raw('');
  log.raw('  下一步：');
  log.raw(`    cd ${name}`);
  log.raw('    qianxia-plugin validate');
  log.raw('    qianxia-plugin build');

  return 0;
}
