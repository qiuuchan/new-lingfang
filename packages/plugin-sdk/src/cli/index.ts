#!/usr/bin/env node
// lingfang-plugin CLI — 插件开发工具链入口。
// 子命令：create / validate / build / publish / --help / --version

import { parseArgs } from './parser.ts';
import { log } from './log.ts';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function getVersion(): Promise<string> {
  try {
    const pkgPath = path.resolve(__dirname, '../../package.json');
    const raw = await readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw);
    return (pkg as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function printHelp(): void {
  log.raw(`
lingfang-plugin — 灵方插件开发工具

用法:
  lingfang-plugin <命令> [参数]

命令:
  create <name>       创建新插件工程
    --runtime <R>     运行时类型（client | nodejs | python）
    --id <ID>         插件唯一标识
    --author <作者>   插件作者
    --description <描述>
    --visibility <V>  可见度（private | tenant，默认 tenant；public 由审核赋予）
    --capabilities <C> 逗号分隔的能力列表
    --force           覆盖已有目录

  validate [path]    校验插件合法性（默认当前目录）
     --json            输出 JSON 格式（用于程序消费）
  build [path]       打包 .lfplugin 制品
     --out <file>     自定义输出文件名
     --json           输出 JSON 格式
  publish [path]     发布到插件注册中心
     --base <url>     API 地址（或 env LINGFANG_API_BASE）
     --token <jwt>    认证 token（或 env LINGFANG_TOKEN）
     --package-id <id>     发布到现有 package
     --source-kind <kind>  来源类型
     --source-label <text> 来源标签（自动 base64url）
     --client <kind>       客户端类型
     --no-build            跳过自动 build

  dev [path]         注册插件目录为 dev 安装（免打包直读，v1 仅 client）

  --help             显示此帮助
  --version          显示版本号
`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // --help / --version 优先
  if (args.flags['help']) {
    printHelp();
    return 0;
  }
  if (args.flags['version']) {
    const ver = await getVersion();
    log.raw(`lingfang-plugin v${ver}`);
    return 0;
  }

  const cmd = args.positional[0] ?? '';
  const restArgs = args.positional.slice(1);

  // 未识别命令也打印帮助
  const help = () => {
    printHelp();
    return cmd === '' ? 0 : 1;
  };

  switch (cmd) {
    case 'create': {
      // lazy import create 命令（避免冷启动拉全量）
      const { createCommand } = await import('./commands/create.ts');
      return createCommand(restArgs, args.flags);
    }
    case 'validate': {
      const { validateCommand } = await import('./commands/validate.ts');
      // 支持 positional path 或 --path，并接受 --json
      const opts = {
        path:
          typeof restArgs[0] === 'string' && restArgs[0].length > 0
            ? restArgs[0]
            : typeof args.flags['path'] === 'string'
              ? args.flags['path']
              : undefined,
        json: args.flags['json'] === true,
      };
      return validateCommand(restArgs, opts);
    }
    case 'build': {
      const { buildCommand } = await import('./commands/build.ts');
      const opts = {
        path:
          typeof restArgs[0] === 'string' && restArgs[0].length > 0
            ? restArgs[0]
            : typeof args.flags['path'] === 'string'
              ? args.flags['path']
              : undefined,
        out: typeof args.flags['out'] === 'string' ? args.flags['out'] : undefined,
        json: args.flags['json'] === true,
      };
      return buildCommand(restArgs, opts);
    }
    case 'publish': {
      const { publishCommand } = await import('./commands/publish.ts');
      const opts = {
        path:
          typeof restArgs[0] === 'string' && restArgs[0].length > 0
            ? restArgs[0]
            : typeof args.flags['path'] === 'string'
              ? args.flags['path']
              : undefined,
        base: typeof args.flags['base'] === 'string' ? args.flags['base'] : undefined,
        token: typeof args.flags['token'] === 'string' ? args.flags['token'] : undefined,
        packageId:
          typeof args.flags['package-id'] === 'string' ? args.flags['package-id'] : undefined,
        sourceKind:
          typeof args.flags['source-kind'] === 'string' ? args.flags['source-kind'] : undefined,
        sourceLabel:
          typeof args.flags['source-label'] === 'string' ? args.flags['source-label'] : undefined,
        clientKind: typeof args.flags['client'] === 'string' ? args.flags['client'] : undefined,
        build: args.flags['no-build'] === true ? false : undefined,
      };
      return publishCommand(restArgs, opts);
    }
    case 'dev': {
      const { devCommand } = await import('./commands/dev.ts');
      const opts = {
        path:
          typeof restArgs[0] === 'string' && restArgs[0].length > 0
            ? restArgs[0]
            : typeof args.flags['path'] === 'string'
              ? args.flags['path']
              : undefined,
        json: args.flags['json'] === true,
      };
      return devCommand(restArgs, opts);
    }
    case '':
      return help();
    default:
      log.error(`未知命令：${cmd}`);
      return help();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    log.error(String(err));
    process.exitCode = 1;
  });
