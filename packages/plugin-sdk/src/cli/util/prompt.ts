// 交相互式提示 — 基于 Node.js readline/promises。
// 非 TTY 环境（如管道、脚本调用）自动回退默认值，不阻塞。

import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const isTTY = stdin.isTTY === true;

function createInterface(): readline.Interface {
  return readline.createInterface({ input: stdin, output: stdout });
}

/** 纯文本输入 */
export async function askText(question: string, defaultValue?: string): Promise<string> {
  if (!isTTY) return defaultValue ?? '';

  const rl = createInterface();
  const prompt = defaultValue ? `${question} (${defaultValue}): ` : `${question}: `;
  const answer = await rl.question(prompt);
  rl.close();
  return answer.trim() || defaultValue || '';
}

/** 单选（打印编号列表，接受数字输入） */
export async function askSelect(
  question: string,
  options: string[],
  defaultIndex?: number
): Promise<number> {
  if (!isTTY) return defaultIndex ?? 0;
  if (options.length === 0) throw new Error('选项不能为空');

  const rl = createInterface();
  console.log(`${question}`);
  for (let i = 0; i < options.length; i++) {
    const mark = defaultIndex !== undefined && i === defaultIndex ? ' (默认)' : '';
    console.log(`  ${i + 1}) ${options[i]}${mark}`);
  }

  const defStr = defaultIndex !== undefined ? `${defaultIndex + 1}` : '';
  const prompt = `请输入编号 (1-${options.length}) [${defStr}]: `;
  const answer = await rl.question(prompt);
  rl.close();

  const num = parseInt(answer.trim(), 10);
  if (!isNaN(num) && num >= 1 && num <= options.length) return num - 1;
  if (defaultIndex !== undefined) return defaultIndex;
  return 0;
}

/** 确认 Y/n */
export async function askConfirm(question: string, defaultValue: boolean): Promise<boolean> {
  if (!isTTY) return defaultValue;

  const defStr = defaultValue ? 'Y/n' : 'y/N';
  const rl = createInterface();
  const answer = await rl.question(`${question} [${defStr}]: `);
  rl.close();

  const trimmed = answer.trim().toLowerCase();
  if (trimmed === '') return defaultValue;
  return trimmed === 'y' || trimmed === 'yes';
}

/** 多选（打印 [x]/[ ] 标记，接受 "1,3,5" 或 "all"） */
export async function askMultiselect(
  question: string,
  options: string[],
  defaults?: boolean[]
): Promise<number[]> {
  if (!isTTY) {
    const result: number[] = [];
    for (let i = 0; i < options.length; i++) {
      if (defaults?.[i]) result.push(i);
    }
    return result;
  }
  if (options.length === 0) return [];

  const rl = createInterface();
  console.log(`${question}`);
  for (let i = 0; i < options.length; i++) {
    const mark = defaults?.[i] ? 'x' : ' ';
    console.log(`  [${mark}] ${i + 1}) ${options[i]}`);
  }
  console.log('  输入编号（逗号分隔），或输入 "all" 全选');

  const answer = await rl.question('> ');
  rl.close();

  const trimmed = answer.trim().toLowerCase();
  if (trimmed === 'all') {
    return options.map((_, i) => i);
  }

  const indices = trimmed
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n >= 1 && n <= options.length);

  if (indices.length > 0) return indices.map((n) => n - 1);

  // fallback
  const result: number[] = [];
  for (let i = 0; i < options.length; i++) {
    if (defaults?.[i]) result.push(i);
  }
  return result;
}
