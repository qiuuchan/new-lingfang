//! e2e-cap-closure-verify.mjs — LF-19 能力面观察项闭环（双插件导入 + clipboard/net.fetch/relay 正向）。
//!
//! 覆盖（WORK_ORDERS LF-19 第 1-4 条，CDP 证据）：
//!   1. clip-digest + web-clip + relay-probe 三个 `.lfplugin` 本地导入（install_plugin_artifact
//!      origin=local）→ F3 来源徽标「本地导入」+「未签名」警示在插件中心展示；
//!   2. clipboard 正向往返：web-clip（已声明 clipboard）iframe 内 writeText → readText；
//!   3. net.fetch 公网正向：web-clip iframe 内请求 https://example.com 断言 200
//!      （环回 SSRF 拦截已有单测，本条补公网正向证据；网络不可达时如实标注失败）；
//!   4. relay 四 kind 正向：relay-probe 插件（声明 llm.chat/image.generate/video.generate/
//!      audio.generate）在 relay-adapter（RELAY_ADAPTER_MOCK=1）驱动下全绿；
//!      audio 若因 SDK 接线缺口失败则如实记录（data-probe-audio.generate 值原样断言）。
//!
//! 前置：release 桌面壳（target/release/lingfang-desktop.exe，LF-18 tauri build 产物）、
//! 三个示例插件已 build（脚本自动补 build）。relay 凭据经 env 注入（LF-04a seam）：
//! LINGFANG_RELAY_API_BASE=http://127.0.0.1:<port> + LINGFANG_RELAY_TOKEN=mock-token。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const requireFromDesktop = createRequire(path.resolve('apps/desktop/package.json'));
const { chromium } = requireFromDesktop('@playwright/test');

const REPO_ROOT = process.cwd();
const MAIN_EXE = 'lingfang-desktop.exe';
const PLUGINS = [
  { id: 'com.lingfang.clip-digest', name: '剪藏摘要', dir: 'clip-digest' },
  { id: 'com.lingfang.web-clip', name: '网页剪藏', dir: 'web-clip' },
  { id: 'com.lingfang.relay-probe', name: 'Relay 探针', dir: 'relay-probe' },
];

let failed = 0;
const log = (msg) => console.log(`[e2e-cap] ${msg}`);
const ok = (msg) => console.log(`  ✅ ${msg}`);
const fail = (msg) => {
  console.error(`  ❌ ${msg}`);
  failed += 1;
};
const assert = (cond, msg) => (cond ? ok(msg) : fail(msg));

// ── 基础工具（与 e2e-desktop-smoke / e2e-update-verify 同款）──────────────

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

async function spawnElevated(exe, env) {
  const taskName = `LingFangE2E_${process.pid}_${Date.now()}`;
  const launcherPath = path.join(os.tmpdir(), `${taskName}.bat`);
  const bat = [
    '@echo off',
    `set "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=${env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS ?? ''}"`,
    `set "WEBVIEW2_USER_DATA_FOLDER=${env.WEBVIEW2_USER_DATA_FOLDER ?? ''}"`,
    `cd /d "${path.dirname(exe)}"`,
    `start "" "${exe}"`,
    '',
  ].join('\r\n');
  fs.writeFileSync(launcherPath, bat, 'latin1');
  const psCreate = [
    '$ErrorActionPreference="Stop"',
    `$tn="${taskName}"`,
    `$lp="${launcherPath}"`,
    `$act=New-ScheduledTaskAction -Execute "cmd.exe" -Argument ('/c "' + $lp + '"')`,
    `$prin=New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType Interactive -RunLevel Limited`,
    `Register-ScheduledTask -TaskName $tn -Action $act -Principal $prin -Force | Out-Null`,
    `Start-ScheduledTask -TaskName $tn`,
    `$i=Get-ScheduledTaskInfo -TaskName $tn`,
    `"LastTaskResult=0x{0:X}" -f $i.LastTaskResult`,
  ].join('; ');
  const cr = spawnSync('powershell', ['-NoProfile', '-Command', psCreate], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (cr.status !== 0) throw new Error(`Task Scheduler 注册失败：exit=${cr.status} err=${cr.stderr}`);
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
      if (pid > 0) return { pid, env };
    } catch {
      /* 继续轮询 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Task Scheduler 降权启动后未找到 ${path.basename(exe)} 进程`);
}

function spawnShell(exe, port, webviewDataDir, extraEnv = {}) {
  const appEnv = {
    ...process.env,
    ...extraEnv,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: webviewDataDir,
  };
  if (isElevated()) return spawnElevated(exe, appEnv);
  const child = spawn(exe, [], {
    cwd: path.dirname(exe),
    env: appEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  // 持续排空 stdout/stderr 管道（防缓冲填满阻塞主进程）并留存供失败诊断。
  globalThis.__e2eAppOut = [];
  child.stdout?.on('data', (d) => globalThis.__e2eAppOut.push(`[app] ${d}`));
  child.stderr?.on('data', (d) => globalThis.__e2eAppOut.push(`[app-err] ${d}`));
  return { pid: child.pid, env: appEnv };
}

async function waitForCdp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      /* 未就绪 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`等待 CDP(${port}) 超时`);
}

async function connectPage(port) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  await new Promise((r) => setTimeout(r, 2500)); // WebView2 首启导航稳定
  const page = context.pages().find((p) => /tauri/i.test(p.url())) ?? context.pages()[0];
  assert(page, `CDP 连接成功并找到桌面壳页面 (${port})`);
  return { browser, page, context };
}

const invoke = (page, cmd, args = {}) =>
  page.evaluate(([c, a]) => window.__TAURI__.core.invoke(c, a), [cmd, args]);

// 带超时的 evaluate 封装：避免命令悬死时脚本整体挂起（LF-19 e2e 曾整轮卡死）。
const evaluateWithTimeout = (page, fn, arg, timeoutMs = 20_000, label = 'evaluate') =>
  Promise.race([
    page.evaluate(fn, arg),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 超时 ${timeoutMs}ms`)), timeoutMs)),
  ]);

function freePort() {
  const srv = http.createServer();
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: true, stdio: 'ignore' });
}

// ── 插件制品 ─────────────────────────────────────────────────────────────

function ensurePluginArtifacts() {
  const artifacts = [];
  for (const p of PLUGINS) {
    const built = path.join(REPO_ROOT, 'packages/plugin-sdk', `com.lingfang.${p.dir}-0.1.0.lfplugin`);
    if (!fs.existsSync(built)) {
      log(`构建 ${p.dir} 插件制品…`);
      const r = spawnSync('pnpm', ['-C', 'packages/plugin-sdk', 'cli:dev', 'build', `packages/plugin-sdk/examples/${p.dir}`], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        shell: true,
      });
      if (r.status !== 0) throw new Error(`build ${p.dir} 失败（exit=${r.status}）`);
    }
    if (!fs.existsSync(built)) throw new Error(`插件制品缺失：${built}`);
    artifacts.push(built);
  }
  return artifacts;
}

// ── 主流程 ───────────────────────────────────────────────────────────────

async function run() {
  const tmpRoot = path.join(os.tmpdir(), `lingfang-cap-e2e-${Date.now()}`);
  fs.mkdirSync(tmpRoot, { recursive: true });
  const webviewData = path.join(tmpRoot, 'webview-data');
  let appHandle = null;
  let adapter = null;
  const port = await freePort();

  log(`tmpRoot=${tmpRoot}，CDP port=${port}`);

  try {
    // 0. relay-adapter（MOCK 模式，四 kind 确定性伪响应）
    const adapterPort = await freePort();
    adapter = spawn(
      process.execPath,
      [path.join(REPO_ROOT, 'scripts/relay-adapter.mjs')],
      {
        env: { ...process.env, RELAY_ADAPTER_PORT: String(adapterPort), RELAY_ADAPTER_MOCK: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      },
    );
    await new Promise((r) => setTimeout(r, 1500)); // 等监听就绪
    log(`relay-adapter(MOCK) http://127.0.0.1:${adapterPort}`);

    // 1. 桌面壳（release 产物 + relay 凭据 env 注入）
    const exe = path.join(REPO_ROOT, 'target/release', MAIN_EXE);
    if (!fs.existsSync(exe)) throw new Error(`未找到 release 桌面壳：${exe}（先 tauri build --no-bundle）`);
    appHandle = spawnShell(exe, port, webviewData, {
      LINGFANG_RELAY_API_BASE: `http://127.0.0.1:${adapterPort}`,
      LINGFANG_RELAY_TOKEN: 'mock-token',
    });
    await waitForCdp(port, 90_000);
    const { browser, page } = await connectPage(port);
    page.on('console', (msg) => log(`  [页面console] ${msg.type()}: ${msg.text().slice(0, 200)}`));
    page.on('pageerror', (err) => log(`  [页面错误] ${String(err).slice(0, 300)}`));

    // 2. 双插件 + 探针导入（先清场再 install_plugin_artifact，origin=local）
    const artifacts = ensurePluginArtifacts();
    log('清场既有安装并本地导入三个 .lfplugin…');
    for (let i = 0; i < PLUGINS.length; i++) {
      log(`[${i + 1}/3] 处理 ${PLUGINS[i].id}…`);
      // 先卸载既有安装（同名不同版本会停在 pendingRelease，runner 仍加载旧活动版本）。
      // 注意：只回传映射子集——完整 LocalInstallation 跨 CDP 序列化曾致 evaluate 永不
      // resolve（LF-19 实测，list 返回原始数组即挂起，子集 13ms 即回）。
      const listStart = Date.now();
      const existing = await evaluateWithTimeout(
        page,
        // ⚠️ 参数直接传命令名字符串——包进数组会让 invoke 收到数组型命令名，
        // IPC 反序列化报「invalid type: sequence, expected a string」且 promise 永不落定
        // （LF-19 真机排障实录，探针内联字符串正常、此处传数组即挂）。
        (cmd) =>
          window.__TAURI__.core.invoke(cmd).then(
            (v) => (v ?? []).map((i) => ({ installationId: i.installationId, packageId: i.packageId, origin: i.origin })),
            (e) => `ERR:${String(e)}`,
          ),
        'list_plugin_installations',
        20_000,
        'list_plugin_installations',
      );
      log(`  list_plugin_installations 返回（${Date.now() - listStart}ms）`);
      const match = (existing ?? []).find((inst) =>
        String(inst.packageId ?? '').includes(PLUGINS[i].id),
      );
      if (match?.installationId) {
        await evaluateWithTimeout(
          page,
          ([cmd, id]) =>
            window.__TAURI__.core.invoke(cmd, { installationId: id }).catch(() => null),
          ['uninstall_plugin_installation', match.installationId],
          20_000,
          'uninstall_plugin_installation',
        );
      }
      const result = await evaluateWithTimeout(
        page,
        ([cmd, artifactPath]) =>
          window.__TAURI__.core.invoke(cmd, {
            input: {
              artifactPath,
              expectedSha256: null,
              packageId: null,
              releaseId: null,
              origin: 'local',
              protected: false,
            },
          }).then(
            (v) => ({ ok: true, value: v }),
            (err) => ({ ok: false, message: String(err) }),
          ),
        ['install_plugin_artifact', artifacts[i]],
        20_000,
        'install_plugin_artifact',
      );
      assert(
        result.ok && result.value?.origin === 'local',
        `导入 ${PLUGINS[i].id}（${result.ok ? `origin=${result.value?.origin}` : result.message}）`,
      );
    }

    // 3. F3 来源徽标：行内「本地导入」+ 详情对话框「未签名」警示
    log('断言 F3 来源徽标（origin=local → 本地导入 + 未签名）…');
    await page.reload();
    await page.waitForSelector('text=插件', { timeout: 30_000 });
    for (const p of PLUGINS) {
      await page.waitForSelector(`text=${p.name}`, { timeout: 30_000 });
      const row = page.locator('div.divide-y > div', { hasText: p.name }).first();
      const rowText = await row.textContent().catch(() => '');
      assert(
        rowText.includes('本地导入'),
        `${p.name} 行展示「本地导入」徽标`,
      );
      // 签名警示在「插件详情」对话框内（⚠ + 未验签文案，如「插件未附带签名（manifest.sig 缺失）」）。
      await row.getByTitle('插件详情').click();
      await page.waitForSelector('text=签名状态', { timeout: 15_000 }).catch(() => {});
      const dialogText = await page.textContent('body');
      const sigLabel = (dialogText.match(/未附带签名|未签名|无法验签|未配置|签名无效|无法获取/) ?? ['?'])[0];
      assert(
        /未附带签名|未签名|无法验签|未配置|签名无效|无法获取/.test(dialogText ?? ''),
        `${p.name} 详情展示签名警示（状态=${sigLabel}）`,
      );
      // 关闭详情对话框（Escape），并确认关闭成功再继续（base-ui Dialog 默认 Esc 关闭）。
      await page.keyboard.press('Escape');
      await page
        .waitForSelector('text=签名状态', { state: 'hidden', timeout: 5000 })
        .catch(async () => {
          // 兜底：点击对话框外区域关闭。
          await page.mouse.click(20, 20).catch(() => {});
          await page.waitForTimeout(500);
        });
    }

    // 4. clipboard 正向往返 + net.fetch 公网正向（web-clip iframe）
    log('打开 web-clip（网页剪藏）…');
    const wcRow = page.locator('div.divide-y > div', { hasText: '网页剪藏' }).first();
    await wcRow.getByRole('button', { name: '运行', exact: true }).click();
    await page.locator('iframe[sandbox="allow-scripts"]', { hasTitle: '网页剪藏' }).waitFor({ state: 'visible', timeout: 30_000 });
    const wcFrame = page.frameLocator('iframe[title="网页剪藏"]');

    const clipProbe = `lf19-clip-${Date.now()}`;
    const clipResult = await wcFrame.locator('body').evaluate(async (_, text) => {
      const sdk = window.sdk;
      await sdk.clipboard.writeText(text);
      const read = await sdk.clipboard.readText();
      return { text, read };
    }, clipProbe);
    assert(
      clipResult?.read === clipProbe,
      `clipboard 正向往返：writeText → readText（read=${clipResult?.read}）`,
    );

    const netResult = await wcFrame.locator('body').evaluate(async () => {
      const sdk = window.sdk;
      try {
        const resp = await sdk.net.fetch('https://example.com/', { method: 'GET' });
        return { status: resp && resp.status, ok: resp && resp.ok };
      } catch (e) {
        return { error: String(e) };
      }
    });
    assert(
      netResult?.status === 200,
      `net.fetch 公网正向：https://example.com → HTTP ${netResult?.status ?? netResult?.error}`,
    );

    // 5. relay 四 kind 正向（relay-probe iframe，数据属性断言）
    //    先返回插件中心（← 返回），再打开 Relay 探针。
    log('打开 Relay 探针，等待四 kind 探针完成…');
    await page.getByRole('button', { name: '← 返回' }).click();
    await page.waitForSelector('text=Relay 探针', { timeout: 30_000 });
    const rpRow = page.locator('div.divide-y > div', { hasText: 'Relay 探针' }).first();
    await rpRow.getByRole('button', { name: '运行', exact: true }).click();
    await page.locator('iframe[sandbox="allow-scripts"]', { hasTitle: 'Relay 探针' }).waitFor({ state: 'visible', timeout: 30_000 });
    const rpFrame = page.frameLocator('iframe[title="Relay 探针"]');

    await rpFrame.locator('#status[data-probe-status="done"]').waitFor({ timeout: 60_000 });
    const probeStatus = {
      llm: await rpFrame.locator('#status').getAttribute('data-probe-llm.chat'),
      image: await rpFrame.locator('#status').getAttribute('data-probe-image.generate'),
      video: await rpFrame.locator('#status').getAttribute('data-probe-video.generate'),
      audio: await rpFrame.locator('#status').getAttribute('data-probe-audio.generate'),
    };

    for (const [k, label] of [
      ['llm', 'llm.chat'],
      ['image', 'image.generate'],
      ['video', 'video.generate'],
      ['audio', 'audio.generate'],
    ]) {
      const v = probeStatus?.[k];
      assert(v?.startsWith('ok:'), `relay 正向 ${label}：${v ?? '(无结果)'}`);
    }

    await browser.close().catch(() => {});
    adapter?.kill();

    if (failed > 0) {
      console.error(`\n[e2e-cap] 共 ${failed} 项断言失败`);
      process.exit(1);
    }
    console.log('\n[e2e-cap] ✅ 能力面观察项闭环全部通过（导入徽标 / clipboard 往返 / net.fetch 公网 / relay 四 kind 正向）');
    process.exit(0);
  } catch (err) {
    console.error(`\n[e2e-cap] ❌ 流程异常：${err.stack ?? err}`);
    const appOut = (globalThis.__e2eAppOut ?? []).join('').slice(-3000);
    if (appOut) console.error(`--- 桌面壳输出（尾部） ---\n${appOut}`);
    if (appHandle?.pid) killTree(appHandle.pid);
    adapter?.kill();
    console.error(`现场保留：${tmpRoot}`);
    process.exit(1);
  }
}

run();
