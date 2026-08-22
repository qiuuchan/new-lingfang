// 中文终端着色输出 — 自写 ANSI 转义，无需 chalk/kolorist。
// 非 TTY 环境自动抑制颜色（管道/重定向友好）。

const tty = process.stdout.isTTY === true;

function withColor(msg: string, code: number): string {
  if (!tty) return msg;
  return `\x1b[${code}m${msg}\x1b[0m`;
}

function icon(label: string): string {
  return tty ? `${label} ` : '';
}

export const log = {
  info(msg: string): void {
    process.stdout.write(withColor(`${icon('ℹ')}${msg}\n`, 36)); // cyan
  },

  success(msg: string): void {
    process.stdout.write(withColor(`${icon('✓')}${msg}\n`, 32)); // green
  },

  warn(msg: string): void {
    process.stdout.write(withColor(`${icon('⚠')}${msg}\n`, 33)); // yellow
  },

  error(msg: string): void {
    process.stderr.write(withColor(`${icon('✗')}${msg}\n`, 31)); // red
  },

  raw(msg: string): void {
    process.stdout.write(`${msg}\n`);
  },
};
