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

// runas /trustlevel:0x20000 启动 app（Basic User 令牌）。runas 不传 PID，
// 需按可执行文件名反查实际进程。
async function spawnElevated(exe, env) {
  log('检测到 elevated 上下文，降权（Basic User 令牌）启动桌面壳…');
  const quoted = `"${exe}"`;
  spawnSync('runas', ['/env', '/trustlevel:0x20000', quoted], {
    env,
    stdio: 'ignore',
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const out = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='${path.basename(exe)}'" | ` +
            'Where-Object { $_.CommandLine -like "*lingfang*" } | ' +
            'Sort-Object CreationDate -Descending | Select-Object -First 1 -ExpandProperty ProcessId',
        ],
        { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' },
      );
      const pid = parseInt(out.stdout.trim(), 10);
      if (pid > 0) {
        log(`桌面壳已启动（PID=${pid}，降权模式）`);
        return { pid, env, child: null };
      }
    } catch {
      /* 继续轮询 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('runas 降权启动后未找到 lingfang-desktop 进程');
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
  log(`启动桌面壳，CDP 端口 ${port} …`);
  const webviewDataDir = path.join(
    repoRoot,
    `.e2e-webview2-data-${process.pid}-${Date.now()}`,
  );
  const appEnv = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: webviewDataDir,
  };

  let child;
  if (isElevated()) {
    child = await spawnElevated(exe, appEnv);
  } else {
    child = spawn(exe, [], {
      cwd: path.dirname(exe),
      env: appEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // 独立进程组，避免被本脚本信号牵连；退出时 taskkill /T 清树
    });
  }

  const childOutput = [];
  if (child.child) {
    child.child.stdout?.on('data', (d) => childOutput.push(d.toString()));
    child.child.stderr?.on('data', (d) => childOutput.push(d.toString()));
  }

  const cleanup = () => {
    killTree(child.pid);
    spawnSync('rmdir', ['/s', '/q', webviewDataDir], { shell: true, stdio: 'ignore' });
  };

  const timer = setTimeout(() => {
    cleanup();
    console.error(`[e2e-smoke] 总超时（${OVERALL_TIMEOUT_MS / 1000}s），已强制退出`);
    process.exit(1);
  }, OVERALL_TIMEOUT_MS);

  try {
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
            'tasklist',
            ['/FI', 'IMAGENAME eq msedgewebview2.exe', '/FO', 'CSV'],
            { stdio: ['ignore', 'pipe', 'ignore'] },
          ).stdout.toString();
          const n = (out.match(/msedgewebview2\.exe/gi) ?? []).length;
          return `msedgewebview2.exe 进程数=${n}`;
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
      const diag = [
        `等待 CDP(${port}) 超时；app 进程存活=${exeAlive}；${webviewProcs}；${webviewCmdline}`,
        `--- app stdout/stderr（tail 80）---`,
        ...childOutput.slice(-80),
        `--- ${portState} ---`,
      ].join('\n');
      throw new Error(`${e.message}\n${diag}`);
    }
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    const page = context.pages().find((p) => /tauri/i.test(p.url())) ?? context.pages()[0];
    assert(page, 'CDP 连接成功并找到桌面壳页面');
    log(`页面 URL: ${page.url()}`);

    // 1. 插件中心加载：已安装列表出现内置 notes
    await page.waitForSelector(`text=${NOTES_NAME}`, { timeout: 30_000 });
    assert(true, `插件中心渲染，已安装列表含「${NOTES_NAME}」`);

    // 2. 打开 notes → PluginRunner 渲染 sandbox iframe
    const row = page.locator('div.divide-y > div', { hasText: NOTES_NAME }).first();
    await row.getByRole('button', { name: '运行', exact: true }).click();
    const iframeLocator = page.locator('iframe[sandbox="allow-scripts"]', {
      hasTitle: NOTES_NAME,
    });
    await iframeLocator.waitFor({ state: 'visible', timeout: 30_000 });
    assert(true, 'PluginRunner 渲染 iframe（sandbox="allow-scripts"）');

    // sandbox+srcdoc 的 frame 是 opaque origin，取 frame 对象直接求值
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
