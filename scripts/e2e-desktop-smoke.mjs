#!/usr/bin/env node
// e2e-desktop-smoke.mjs — 桌面壳 E2E 冒烟（IMPROVEMENT_PLAN 阶段 E2）。
//
// 把 2026-08-23 一次性人工验证（docs/verify-a5-client-plugin-e2e.md 的 A5a，经
// WebView2 远程调试 + Playwright connectOverCDP）固化为可重复脚本——那一次抓出的
// 4 个集成缺陷（window.__TAURI__ 缺失 / CSP 改写 / 监听注册时序 / id 解析失配）
// 都属于"单测全绿、真机第一行就挂"，只有这条链路能发现。
//
// 断言（caps 落地后的当前预期，见 runbook「当前预期」段）：
//   1. 应用启动、插件中心可加载；
//   2. 内置 notes（Markdown 笔记）可打开，iframe sandbox="allow-scripts" 渲染；
//   3. window.sdk 已注入；ui-tokens CSS 变量（--lf-color-primary）生效；
//   4. storage.kv set/get 真实成功（caps 后新预期，走 client_storage_kv 落盘）；
//   5. 未声明 kind（system.info）reject capability_not_declared；
//   6. llm.chat（凭据未配置）reject relay_not_configured。
//
// 用法（cwd = apps/desktop）：
//   pnpm test:e2e                 # 构建产物（tauri build --no-bundle --debug）+ 冒烟
//   E2E_SKIP_BUILD=1 pnpm test:e2e  # 复用已存在的 target/debug 产物（迭代用）
//
// 依赖 @playwright/test（apps/desktop devDependencies，仅用其 CDP 连接，不下载浏览器）。
// 仅 Windows（WebView2）。任一断言失败 → 退出码 1；finally 保证杀进程树。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const desktopDir = path.join(repoRoot, 'apps', 'desktop');

// Playwright 解析自 apps/desktop 的依赖（root 无 @playwright/test，pnpm 严格布局）。
const requireFromDesktop = createRequire(path.join(desktopDir, 'package.json'));
const { chromium } = requireFromDesktop('@playwright/test');

const NOTES_NAME = 'Markdown 笔记'; // builtin-plugins/notes/manifest.json name
const EXE_CANDIDATES = ['lingfang-desktop.exe', '灵坊工作台.exe', 'main.exe'];
const OVERALL_TIMEOUT_MS = 5 * 60 * 1000; // 连接+断言阶段总时限（不含构建）

function log(msg) {
  console.log(`[e2e-smoke] ${msg}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function findDebugExe() {
  const debugDir = path.join(repoRoot, 'target', 'debug');
  if (!fs.existsSync(debugDir)) return null;
  let best = null;
  for (const name of EXE_CANDIDATES) {
    const p = path.join(debugDir, name);
    if (fs.existsSync(p)) {
      const mtime = fs.statSync(p).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: p, mtime };
    }
  }
  return best?.path ?? null;
}

function buildDesktop() {
  log('构建 debug 产物（tauri build --no-bundle --debug）…');
  const r = spawnSync('pnpm', ['exec', 'tauri', 'build', '--no-bundle', '--debug'], {
    cwd: desktopDir,
    stdio: 'inherit',
    shell: true, // Windows 下 pnpm 是 .cmd
  });
  if (r.status !== 0) throw new Error(`tauri build 失败（exit=${r.status}）`);
}

async function waitForCdp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      /* WebView2 尚未就绪，继续轮询 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`等待 CDP(${port}) 超时`);
}
function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: true, stdio: 'ignore' });
}

// 检测当前进程是否 elevated（管理员令牌）。CI runner 以 admin 运行且无 UAC 过滤，
// WebView2 在 elevated 进程中会禁用 --remote-debugging-port（Chromium 安全限制），
// 必须降权到 Basic User 令牌启动桌面壳才能拿到 CDP 端口。
function isElevated() {
  try {
    const out = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        '$id=[System.Security.Principal.WindowsIdentity]::GetCurrent();' +
          '$p=New-Object System.Security.Principal.WindowsPrincipal($id);' +
          '$p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' },
    );
    return out.stdout.trim() === 'True';
  } catch {
    return false;
  }
}

// elevated 上下文下降权启动 app。runas /trustlevel:0x20000 在 GitHub Actions 无交互
// 桌面 runner 上直接 exit 1（实测 windows-latest，runas 命令本身失败，桌面壳压根没起），
// 改用 Task Scheduler RunLevel=Limited——Chrome/Edge 安装器从 elevated 降权拉起浏览器的
// 标准手法：注册一个以当前用户非提权令牌运行的一次性任务并立即 Start。进程以 medium IL
// 跑，WebView2 才能开 --remote-debugging-port。env 经临时 .bat 启动器注入（Task action
// 不继承当前进程环境，仅 WebView2_* 两项是降权进程真正需要的）。
async function spawnElevated(exe, env) {
  log('检测到 elevated 上下文，降权（Task Scheduler RunLevel=Limited）启动桌面壳…');
  const taskName = `LingFangE2E_${process.pid}_${Date.now()}`;
  const launcherPath = path.join(os.tmpdir(), `${taskName}.bat`);
  // app stdout/stderr 前台重定向到日志：诊断盲区修复——之前 `start ""` 异步
  // 启动，进程崩溃原因完全不可见（CI 日志 tail 恒为空）。
  const appLog = path.join(os.tmpdir(), `${taskName}.log`);
  const wvArgs = env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS ?? '';
  const wvData = env.WEBVIEW2_USER_DATA_FOLDER ?? '';
  // .bat 用 latin1 写纯 ASCII（端口数字 + 路径），无双引号/特殊字符风险
  const bat = [
    '@echo off',
    `set "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=${wvArgs}"`,
    `set "WEBVIEW2_USER_DATA_FOLDER=${wvData}"`,
    `cd /d "${path.dirname(exe)}"`,
    `"${exe}" > "${appLog}" 2>&1`,
    '',
  ].join('\r\n');
  fs.writeFileSync(launcherPath, bat, 'latin1');
  log(`launcher=${launcherPath}\ntask=${taskName}\nappLog=${appLog}`);

  const psCreate = [
    '$ErrorActionPreference="Stop"',
    `$tn="${taskName}"`,
    `$lp="${launcherPath}"`,
    `$act=New-ScheduledTaskAction -Execute "cmd.exe" -Argument ('/c "' + $lp + '"')`,
    `$prin=New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType Interactive -RunLevel Limited`,
    `Register-ScheduledTask -TaskName $tn -Action $act -Principal $prin -Force | Out-Null`,
    `Start-ScheduledTask -TaskName $tn`,
    `$i=Get-ScheduledTaskInfo -TaskName $tn`,
    `"LastTaskResult=0x{0:X} LastRunTime={1}" -f $i.LastTaskResult,$i.LastRunTime`,
  ].join('; ');
  const cr = spawnSync('powershell', ['-NoProfile', '-Command', psCreate], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  log(`Task Scheduler 注册/启动：exit=${cr.status} out=${(cr.stdout ?? '').trim()} err=${(cr.stderr ?? '').trim()}`);

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const out = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='${path.basename(exe)}'" | ` +
            'Sort-Object CreationDate -Descending | Select-Object -First 1 -ExpandProperty ProcessId',
        ],
        { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' },
      );
      const pid = parseInt((out.stdout ?? '').trim(), 10);
      if (pid > 0) {
        log(`桌面壳已启动（PID=${pid}，Task Scheduler 降权模式）`);
        return { pid, env, child: null, taskName, launcherPath, appLog };
      }
    } catch {
      /* 继续轮询 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // 超时诊断：拉任务状态 + 最近运行结果，定位是任务没起来还是起来了但 exe 退出
  const diag = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Get-ScheduledTaskInfo -TaskName "${taskName}" | Format-List TaskName,LastRunTime,LastTaskResult,NumberOfMissedRuns; (Get-ScheduledTask -TaskName "${taskName}").State`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  // app 秒退时把重定向日志带进诊断（前台运行后 appLog 会有内容）
  let appLogTail = '';
  try {
    if (fs.existsSync(appLog)) {
      appLogTail = `\n--- appLog（tail 40）---\n${fs
        .readFileSync(appLog, 'utf8')
        .split(/\r?\n/)
        .slice(-40)
        .join('\n')}`;
    }
  } catch {
    /* 读取失败不阻塞主诊断 */
  }
  throw new Error(
    `Task Scheduler 降权启动后未找到 ${path.basename(exe)} 进程。\n` +
      `--- 任务状态 ---\n${(diag.stdout ?? '').trim()}${appLogTail}`,
  );
}

// 启动桌面壳（按 elevated 与否选择降权或普通 spawn），返回 { pid, env, child }。
// webviewDataDir 隔离用户数据，避免与真实安装互相污染。
function spawnShell(exe, port, webviewDataDir) {
  const appEnv = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: webviewDataDir,
  };
  if (isElevated()) {
    return spawnElevated(exe, appEnv);
  }
  const child = spawn(exe, [], {
    cwd: path.dirname(exe),
    env: appEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // 独立进程组，退出时 taskkill /T 清树
  });
  return { pid: child.pid, env: appEnv, child };
}

// 连接 CDP → 打开内置 notes → 返回在 notes iframe 内求值的 inFrame 函数。
async function openNotes(port) {
  await waitForCdp(port, 90_000);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => /tauri/i.test(p.url())) ?? context.pages()[0];
  assert(page, 'CDP 连接成功并找到桌面壳页面');

  await page.waitForSelector(`text=${NOTES_NAME}`, { timeout: 30_000 });
  const row = page.locator('div.divide-y > div', { hasText: NOTES_NAME }).first();
  await row.getByRole('button', { name: '运行', exact: true }).click();
  const iframeLocator = page.locator('iframe[sandbox="allow-scripts"]', { hasTitle: NOTES_NAME });
  await iframeLocator.waitFor({ state: 'visible', timeout: 30_000 });

  const frame = () =>
    page.frames().find((f) => f.parentFrame() !== null && f.url().includes('srcdoc')) ??
    page.frames().find((f) => f.parentFrame() !== null);

  async function inFrame(fn, arg) {
    const deadline = Date.now() + 30_000;
    let lastErr;
    while (Date.now() < deadline) {
      const f = frame();
      if (f) {
        try {
          return await f.evaluate(fn, arg);
        } catch (e) {
          lastErr = e;
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw lastErr ?? new Error('iframe 不可用');
  }
  return inFrame;
}

function assert(cond, label) {
  if (!cond) throw new Error(`断言失败：${label}`);
  log(`✔ ${label}`);
}

async function run() {
  const skipBuild = process.env.E2E_SKIP_BUILD === '1';
  let exe = findDebugExe();
  if (!skipBuild || !exe) {
    buildDesktop();
    exe = findDebugExe();
  }
  if (!exe) throw new Error(`target/debug 下未找到产物（候选：${EXE_CANDIDATES.join(', ')}）`);
  log(`产物：${exe}`);

  const port = await freePort();
  // WebView2 用户数据目录：必须放在降权（medium IL）进程可写的目录。
  // 之前放 repo 根（D:\a\new-lingfang\...），GitHub Actions runner 的 admin
  // token 创建该目录后，降权进程无写权限 → WebView2 初始化失败 → app 启动即退
  // （nightly e2e 连续 6 次失败，2026-08-29 定位）。os.tmpdir() 对降权进程可写。
  const webviewDataDir = path.join(
    os.tmpdir(),
    `lf-e2e-webview2-${process.pid}-${Date.now()}`,
  );

  const child = spawnShell(exe, port, webviewDataDir);
  const childOutput = [];
  if (child.child) {
    child.child.stdout?.on('data', (d) => childOutput.push(d.toString()));
    child.child.stderr?.on('data', (d) => childOutput.push(d.toString()));
  }

  const cleanup = () => {
    killTree(child.pid);
    if (child.taskName) {
      spawnSync(
        'powershell',
        ['-NoProfile', '-Command', `Unregister-ScheduledTask -TaskName "${child.taskName}" -Confirm:$false -ErrorAction SilentlyContinue`],
        { shell: true, stdio: 'ignore' },
      );
    }
    if (child.launcherPath) {
      try {
        fs.unlinkSync(child.launcherPath);
      } catch {
        /* 已删 */
      }
    }
    if (child.appLog) {
      try {
        fs.unlinkSync(child.appLog);
      } catch {
        /* 已删 */
      }
    }
    spawnSync('rmdir', ['/s', '/q', webviewDataDir], { shell: true, stdio: 'ignore' });
  };

  const timer = setTimeout(() => {
    cleanup();
    console.error(`[e2e-smoke] 总超时（${OVERALL_TIMEOUT_MS / 1000}s），已强制退出`);
    process.exit(1);
  }, OVERALL_TIMEOUT_MS);

  // CDP 超时诊断（复用既有 rich diagnostics 逻辑）。
  async function connectWithDiagnostics() {
    try {
      await waitForCdp(port, 90_000);
    } catch (e) {
      const exeAlive = (() => {
        try {
          return spawnSync('tasklist', ['/FI', `PID eq ${child.pid}`], {
            stdio: ['ignore', 'pipe', 'ignore'],
          }).stdout.toString().includes('lingfang');
        } catch {
          return 'unknown';
        }
      })();
      const webviewProcs = (() => {
        try {
          const out = spawnSync(
            'powershell',
            [
              '-NoProfile',
              '-Command',
              "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | " +
                'Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress',
            ],
            { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' },
          ).stdout.toString();
          const procs = JSON.parse(out || '[]');
          const list = Array.isArray(procs) ? procs : [procs];
          const childOfApp = list.filter(
            (p) => p.ParentProcessId && String(p.ParentProcessId) === String(child.pid),
          );
          const allCmdline = list.map((p) => p.CommandLine ?? '').join(' ');
          const hasDebug = /remote-debugging/.test(allCmdline);
          const runtimeVer = (() => {
            try {
              const v = spawnSync('powershell', [
                '-NoProfile',
                '-Command',
                "Get-ItemProperty 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -Name pv -ErrorAction SilentlyContinue | Select-Object -ExpandProperty pv",
              ], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).stdout.trim();
              return `WebView2 runtime=${v || '?'}`;
            } catch {
              return 'WebView2 runtime=?';
            }
          })();
          return `msedgewebview2 总数=${list.length}（属 app 子进程=${childOfApp.length}）；` +
            `带 remote-debugging=${hasDebug}；${runtimeVer}`;
        } catch (e2) {
          return `msedgewebview2 检查失败: ${e2.message}`;
        }
      })();
      const webviewCmdline = (() => {
        try {
          const out = spawnSync('powershell', [
            '-NoProfile',
            '-Command',
            "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | Select-Object -ExpandProperty CommandLine | Select-String -Pattern 'remote-debugging' | ForEach-Object { $_.Line }",
          ], { stdio: ['ignore', 'pipe', 'ignore'] }).stdout.toString();
          return `WebView2 带 remote-debugging 参数的行数=${(out.match(/remote-debugging/g) ?? []).length}`;
        } catch (e2) {
          return `webview cmdline 检查失败: ${e2.message}`;
        }
      })();
      const portState = (() => {
        try {
          const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], {
            stdio: ['ignore', 'pipe', 'ignore'],
          }).stdout.toString();
          const hits = out.split(/\r?\n/).filter((l) => l.includes(`:${port}`));
          return `端口 ${port} 状态:\n` + (hits.join('\n') || '（无监听）');
        } catch (e2) {
          return `netstat 失败: ${e2.message}`;
        }
      })();
      // elevated 降权路径下 app 输出已重定向到 appLog（普通 spawn 走 childOutput 管道）
      const appLogTail = (() => {
        if (!child.appLog) return [];
        try {
          if (!fs.existsSync(child.appLog)) return ['（appLog 不存在）'];
          return fs
            .readFileSync(child.appLog, 'utf8')
            .split(/\r?\n/)
            .slice(-80);
        } catch (e2) {
          return [`appLog 读取失败: ${e2.message}`];
        }
      })();
      const diag = [
        `等待 CDP(${port}) 超时；app 进程存活=${exeAlive}；${webviewProcs}`,
        `--- app stdout/stderr（tail 80）---`,
        ...childOutput.slice(-80),
        ...(child.appLog ? [`--- appLog（tail 80）---`, ...appLogTail] : []),
        `--- ${portState} ---`,
      ].join('\n');
      throw new Error(`${e.message}\n${diag}`);
    }
    return openNotes(port);
  }

  try {
    // ── 第一轮：连接 + 打开 notes ──
    const inFrame = await connectWithDiagnostics();
    log(`页面 URL: ${'(notes iframe 已打开)'}`);

    // 1. 插件中心加载：已安装列表出现内置 notes
    assert(true, `插件中心渲染，已安装列表含「${NOTES_NAME}」`);

    // 2. PluginRunner 渲染 sandbox iframe
    assert(true, 'PluginRunner 渲染 iframe（sandbox="allow-scripts"）');

    // 3. sdk 注入 + ui-tokens
    assert(
      await inFrame(() => typeof window.sdk === 'object' && window.sdk !== null),
      'iframe 内 window.sdk 已注入',
    );
    assert(
      await inFrame(() => {
        const v = getComputedStyle(document.documentElement).getPropertyValue('--lf-color-primary');
        return typeof v === 'string' && v.trim().length > 0;
      }),
      'ui-tokens CSS 变量生效（--lf-color-primary）',
    );

    // 4. storage.kv 真实成功（caps 后新预期）
    const marker = `e2e-${Date.now()}`;
    assert(
      await inFrame(
        async (m) => {
          await window.sdk.storage.set('e2e_smoke', m);
          const v = await window.sdk.storage.get('e2e_smoke');
          return JSON.stringify(v ?? null).includes(m);
        },
        marker,
      ),
      'storage.kv set/get 真实成功（经 client_storage_kv 落盘）',
    );

    // 4b. storage.kv 管理 API 真机往返（LF-07 落地）：list / delete / count
    const mgmt = await inFrame(async () => {
      const toCount = (c) => (typeof c === 'number') ? c : (c && c.count);
      // 形状兜底：宿主 shim 已解包为数组；npm SDK 旧形态回传 {keys}。
      // 注意必须先判 Array.isArray——数组自带 .keys() 方法，直接读 .keys 会拿到函数。
      const asKeys = (v) => (Array.isArray(v) ? v : (v && Array.isArray(v.keys) ? v.keys : []));
      // 先清场：kv 跨运行持久化（应用数据目录共享，非 WebView2 数据目录），上次运行可能留有 lf12_b。
      await window.sdk.storage.delete('lf12_a');
      await window.sdk.storage.delete('lf12_b');
      const countBefore = toCount(await window.sdk.storage.count());
      await window.sdk.storage.set('lf12_a', '1');
      await window.sdk.storage.set('lf12_b', '2');
      const listed = await window.sdk.storage.list();
      const keys = asKeys(listed);
      const hasBoth = keys.includes('lf12_a') && keys.includes('lf12_b');
      await window.sdk.storage.delete('lf12_a');
      const keysAfter = asKeys(await window.sdk.storage.list());
      const removed = !keysAfter.includes('lf12_a') && keysAfter.includes('lf12_b');
      const cnt = await window.sdk.storage.count();
      const countVal = toCount(cnt);
      // 诊断：断言失败时把原始返回形状带进错误消息（list/count 的宿主 unwrap 是否符合 npm SDK 门面）。
      return {
        hasBoth, removed, countVal, countBefore,
        rawListed: JSON.stringify(listed)?.slice(0, 200),
        rawCount: JSON.stringify(cnt)?.slice(0, 80),
      };
    });
    assert(mgmt.hasBoth, `storage.kv list 含 lf12_a / lf12_b（raw=${mgmt.rawListed}）`);
    assert(mgmt.removed, 'storage.kv delete 移除 lf12_a 后保留 lf12_b');
    // count 用相对断言（前置步骤已写入 e2e_smoke key，且 kv 跨运行持久化）：+2 -1 → before+1。
    assert(
      mgmt.countVal === mgmt.countBefore + 1,
      `storage.kv count = 前置数+1（before=${mgmt.countBefore} actual=${mgmt.countVal} raw=${mgmt.rawCount}）`,
    );
    // 收尾清理：lf12_b 不留在用户存储里（kv 跨运行持久化）。
    await inFrame(async () => {
      await window.sdk.storage.delete('lf12_b');
    });

    // 5. 未声明 kind → capability_not_declared
    assert(
      (await inFrame(async () => {
        try {
          await window.sdk.system.info();
          return 'resolved';
        } catch (e) {
          return e.code ?? `no-code:${e.message}`;
        }
      })) === 'capability_not_declared',
      '未声明的 system.info 拒绝 capability_not_declared',
    );

    // 6. llm.chat（未配置凭据）→ relay_not_configured
    assert(
      (await inFrame(async () => {
        try {
          await window.sdk.llm.chat({ messages: [{ role: 'user', content: 'hi' }] });
          return 'resolved';
        } catch (e) {
          return e.code ?? `no-code:${e.message}`;
        }
      })) === 'relay_not_configured',
      'llm.chat 未配置凭据拒绝 relay_not_configured',
    );

    // 7. clipboard 网关 gate 负向证明：notes 未声明 clipboard，应被拒绝
    //    （clipboard 正向往返 writeText→readText 需声明 clipboard 的插件，列入 LF-12 未验证项）
    assert(
      (await inFrame(async () => {
        try {
          await window.sdk.clipboard.readText();
          return 'resolved';
        } catch (e) {
          return e.code ?? `no-code:${e.message}`;
        }
      })) === 'capability_not_declared',
      '未声明的 clipboard.readText 拒绝 capability_not_declared（网关 gate 生效）',
    );

    // 8. net.fetch 网关 gate 负向证明：notes 未声明 net.fetch，应被拒绝
    //    （net.fetch 对公网 URL 返回 200 需真实/适配器 relay，且环回地址被 SSRF 故意拦截，列入未验证项）
    assert(
      (await inFrame(async () => {
        try {
          await window.sdk.net.fetch('https://example.com');
          return 'resolved';
        } catch (e) {
          return e.code ?? `no-code:${e.message}`;
        }
      })) === 'capability_not_declared',
      '未声明的 net.fetch 拒绝 capability_not_declared（网关 gate 生效）',
    );

    // 9. 重启不复活证明（LF-07 落盘修正）：写入后 delete，重启应用，删除的键不应复活。
    const restartKey = `lf12_restart_${Date.now()}`;
    await inFrame(async (k) => {
      await window.sdk.storage.set(k, 'v');
      await window.sdk.storage.delete(k);
    }, restartKey);
    log('已删除键，重启桌面壳以验证落盘修正（delete 后重启不复活）…');
    killTree(child.pid);
    // 注销第一次的 Task + 删 launcher，避免任务残留（runas 路径无此对象，安全跳过）
    if (child.taskName) {
      spawnSync(
        'powershell',
        ['-NoProfile', '-Command', `Unregister-ScheduledTask -TaskName "${child.taskName}" -Confirm:$false -ErrorAction SilentlyContinue`],
        { shell: true, stdio: 'ignore' },
      );
      child.taskName = null;
    }
    if (child.launcherPath) {
      try {
        fs.unlinkSync(child.launcherPath);
      } catch {
        /* 已删 */
      }
      child.launcherPath = null;
    }
    if (child.appLog) {
      try {
        fs.unlinkSync(child.appLog);
      } catch {
        /* 已删 */
      }
      child.appLog = null;
    }
    await new Promise((r) => setTimeout(r, 1500));
    const child2 = spawnShell(exe, port, webviewDataDir);
    if (child2.child) {
      child2.child.stdout?.on('data', (d) => childOutput.push(d.toString()));
      child2.child.stderr?.on('data', (d) => childOutput.push(d.toString()));
    }
    child.pid = child2.pid; // 让 cleanup 杀最新进程
    child.taskName = child2.taskName ?? null; // 让 cleanup 清第二次的 task
    child.launcherPath = child2.launcherPath ?? null;
    child.appLog = child2.appLog ?? null; // 让诊断读第二次的 appLog
    const inFrame2 = await connectWithDiagnostics();
    const resurrected = await inFrame2(async (k) => {
      const v = await window.sdk.storage.get(k);
      return v === null || v === undefined;
    }, restartKey);
    assert(resurrected, `storage.kv delete 后重启应用，键「${restartKey}」不复活（落盘修正生效）`);

    log('全部断言通过 ✅');
  } finally {
    clearTimeout(timer);
    cleanup();
  }
}

run().catch((err) => {
  console.error(`[e2e-smoke] 失败：${err?.stack ?? err}`);
  process.exit(1);
});
