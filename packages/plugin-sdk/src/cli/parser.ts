// 极简 argv 解析器 — 无需 commander/yargs 依赖。
// 支持 --flag value / --flag=value / --flag（boolean true）/ positional args。
// -- 之后全部视为 positional。

export type ParsedArgs = {
  positional: string[];
  flags: Record<string, string | boolean>;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  let i = 0;
  let endOfFlags = false;

  while (i < argv.length) {
    const arg = argv[i];

    if (!endOfFlags && arg === '--') {
      endOfFlags = true;
      i++;
      // 剩余全部归 positional
      for (let j = i; j < argv.length; j++) {
        positional.push(argv[j]);
      }
      break;
    }

    if (!endOfFlags && arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        // --flag=value
        const name = arg.slice(2, eqIdx);
        const value = arg.slice(eqIdx + 1);
        flags[name] = value;
      } else {
        const name = arg.slice(2);
        // 看下一个 arg 是不是非 flag（不是以 -- 开头且不是 -- 本身）
        if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          // --flag value
          flags[name] = argv[i + 1];
          i += 2;
          continue;
        } else {
          // --flag（boolean）
          flags[name] = true;
        }
      }
    } else {
      positional.push(arg);
    }

    i++;
  }

  return { positional, flags };
}
