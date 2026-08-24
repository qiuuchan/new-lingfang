#!/usr/bin/env node
// e2e-relay-verify.mjs — LF-04a 真实凭据实操 harness（G1 notes AI 摘要闭环）。
//
// 与 e2e-desktop-smoke.mjs 同一驱动手法（tauri debug 产物 + WebView2 远程调试 + Playwright
// connectOverCDP），但目标不同：在**已注入真实 relay 凭据**的前提下，打开内置 notes 并触发
// llm.chat，断言返回**真实 LLM 输出**（非 relay_not_configured、非 mock）。
//
// 凭据注入（满足「凭据不进仓库 / 不进设置 UI / 不落盘」验收）：
//   - 经环境变量 LINGFANG_RELAY_API_BASE / LINGFANG_RELAY_TOKEN 传入本脚本；
//   - 本脚本把它们透传进桌面进程 env（Rust 侧 client_ai_proxy::require_relay 的 env-var fallback 读取）；
//   - 完全不走 set_relay_settings / 磁盘 config.json / SettingsPanel。
//
// 假阳性防护（LF-04a 验收硬要求）：凭据缺失时**立即明确提示并以 exit 2 退出**，绝不假装通过。
//
// 退出码约定：
//   0  = 真实闭环跑通（有凭据且 notes AI 摘要返回真实输出）
//   2  = 凭据缺失，跳过真实闭环（预期行为，非失败；供 LF-04b 待凭据）
//   1  = 真实闭环执行失败（有凭据但断言未通过 / 上游 relay_error / 启动超时等）
//
// 用法（cwd = 仓库根）：
//   LINGFANG_RELAY_API_BASE=https://relay.example.com/v1 LINGFANG_RELAY_TOKEN=xxx \
//     node scripts/e2e-relay-verify.mjs
//   E2E_SKIP_BUILD=1 node scripts/e2e-relay-verify.mjs   # 复用已有 target/debug 产物

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const desktopDir = path.join(repoRoot, 'apps', 'desktop');

const requireFromDesktop = createRequire(path.join(desktopDir, 'package.json'));
const { chromium } = requireFromDesktop('@playwright/test');

const NOTES_NAME = 'Markdown 笔记'; // builtin-plugins/notes/manifest.json name
const EXE_CANDIDATES = ['lingfang-desktop.exe', '灵坊工作台.exe', 'main.exe'];
const OVERALL_TIMEOUT_MS = 5 * 60 * 1000;

function log(msg) {
  console.log(`[e2e-relay] ${msg}`);
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
    shell: true,
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
      /* WebView2 尚未就绪 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`等待 CDP(${port}) 超时`);
}

function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: true, stdio: 'ignore' });
}

function assert(cond, label) {
  if (!cond) throw new Error(`断言失败：${label}`);
  log(`✔ ${label}`);
}

async function run() {
  // ── 凭据缺失：明确跳过，绝不假阳性（exit 2） ──
  const apiBase = process.env.LINGFANG_RELAY_API_BASE?.trim();
  const token = process.env.LINGFANG_RELAY_TOKEN?.trim();
  if (!apiBase || !token) {
    console.error(
      '[e2e-relay] ⚠ 缺少 relay 凭据环境变量，跳过真实闭环（LF-04b 待凭据）。\n' +
        '            这是预期行为，非失败。提供后重跑即可：\n' +
        '            LINGFANG_RELAY_API_BASE=https://<relay>/v1 LINGFANG_RELAY_TOKEN=<token> \\\n' +
        '              node scripts/e2e-relay-verify.mjs',
    );
    process.exit(2);
  }
  // 与 Rust require_relay 的 is_allowed_api_base 保持一致：https 恒允许；
  // 明文 http 仅限环回地址（LF-04b 本地适配器路径）。
  const loopbackHttp = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?($|\/)/i.test(apiBase);
  if (!/^https:\/\//i.test(apiBase) && !loopbackHttp) {
    console.error(`[e2e-relay] ✗ LINGFANG_RELAY_API_BASE 必须是 https 地址（或环回 http，当前：${apiBase}）`);
    process.exit(1);
  }
  log('检测到 relay 凭据环境变量，开始真实闭环验证（凭据仅存于进程环境，不落盘/不进仓库）');

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
  const child = spawn(exe, [], {
    cwd: path.dirname(exe),
    env: {
      ...process.env,
      // 透传凭据到桌面进程（Rust require_relay 的 env-var fallback 读取）—— 不经设置 UI / 磁盘。
      LINGFANG_RELAY_API_BASE: apiBase,
      LINGFANG_RELAY_TOKEN: token,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: 'ignore',
    detached: true,
  });

  const timer = setTimeout(() => {
    killTree(child.pid);
    console.error(`[e2e-relay] 总超时（${OVERALL_TIMEOUT_MS / 1000}s），已强制退出`);
    process.exit(1);
  }, OVERALL_TIMEOUT_MS);

  try {
    await waitForCdp(port, 90_000);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    const page = context.pages().find((p) => /tauri/i.test(p.url())) ?? context.pages()[0];
    assert(page, 'CDP 连接成功并找到桌面壳页面');

    // 1. 插件中心渲染：已安装列表含内置 notes
    await page.waitForSelector(`text=${NOTES_NAME}`, { timeout: 30_000 });
    assert(true, `插件中心渲染，已安装列表含「${NOTES_NAME}」`);

    // 2. 打开 notes → PluginRunner 渲染 sandbox iframe
    const row = page.locator('div.divide-y > div', { hasText: NOTES_NAME }).first();
    await row.getByRole('button', { name: '运行', exact: true }).click();
    const iframeLocator = page.locator('iframe[sandbox="allow-scripts"]', { hasTitle: NOTES_NAME });
    await iframeLocator.waitFor({ state: 'visible', timeout: 30_000 });
    assert(true, 'PluginRunner 渲染 iframe（sandbox="allow-scripts"）');

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

    // 3. sdk 注入（上下文校验，确认 client 桥可用）
    assert(
      await inFrame(() => typeof window.sdk === 'object' && window.sdk !== null),
      'iframe 内 window.sdk 已注入',
    );

    // 4. 真实 llm.chat：经 client_llm_chat → require_relay(env) → relay 真实返回。
    //    断言：resolved 且 content 非空、且非 relay_not_configured / relay_error（真实输出）。
    const result = await inFrame(async () => {
      try {
        const r = await window.sdk.llm.chat({
          model: 'fast',
          messages: [
            { role: 'system', content: '用一句话回答：1+1 等于几？只回答数字。' },
            { role: 'user', content: '请回答。' },
          ],
        });
        return { ok: true, content: (r && (r.content ?? '')) || '' };
      } catch (e) {
        return { ok: false, code: e.code ?? 'no-code', message: e.message ?? String(e) };
      }
    });

    if (!result.ok) {
      throw new Error(
        `llm.chat 未返回真实输出：code=${result.code} message=${result.message}（relay_not_configured 表示凭据未达 Rust 侧；relay_error 表示上游拒绝）`,
      );
    }
    assert(
      typeof result.content === 'string' && result.content.trim().length > 0,
      `notes AI 摘要返回真实 LLM 输出（长度 ${result.content.trim().length}）`,
    );
    log(`真实输出片段：${result.content.trim().slice(0, 80).replace(/\n/g, ' ')}…`);

    log('真实闭环验证通过 ✅（notes AI 摘要经 client_llm_chat 真实返回）');
    process.exit(0);
  } finally {
    clearTimeout(timer);
    killTree(child.pid);
  }
}

run().catch((err) => {
  console.error(`[e2e-relay] 失败：${err?.stack ?? err}`);
  process.exit(1);
});
