# A5 手动验证 Runbook · client 插件端到端

> **✅ 执行记录（2026-08-23，已完成）**：本 runbook 已按自动化方式执行通过——
> `tauri build --no-bundle --debug` + WebView2 远程调试端口 + Playwright `connectOverCDP`。
> 两处预期更新：
> 1. A5a 中 `llm.chat` 现预期 `relay_not_configured`（C2 已接管 AI kind），不再是 NotSupported；
>    `storage.kv` 仍为 `capability_not_supported`。未声明的 kind（如 notes 调 system.info）为 `capability_not_declared`。
> 2. 实测修复 4 个集成缺陷后才全绿（read_plugin_file installationId 失配 / Tauri CSP 改写阻断
>    iframe 内联脚本 / api.ts 全局缺失与 PluginRunner 监听注册时序 / client 安装插件能力未注册），
>    详见 TODO.md「二、验证」。A5b 的安装步骤实测可经页面 IPC `install_plugin_artifact` 完成，
>    无需人工文件对话框。

> 对应 `TODO.md` 中 **A5a / A5b** 两项验证。本文件为文档，不改动源码。
> 目的：在当前已交付且单测通过的 client-plugin 代码上，一次性完成桌面壳（需 `cargo build` + WebView2）的端到端确认。

## 前置环境

- Node **>= 20**、pnpm **9**（`packageManager` 已锁定）。
- Rust MSVC 工具链（`rustup` 默认 `stable-x86_64-pc-windows-msvc`）。
- Windows WebView2 运行时（系统自带或独立安装）。
- `cargo`、`tauri` CLI 可用（`apps/desktop/src-tauri` 为 Tauri v2 壳）。

构建 / 启动（二选一）：

```bash
pnpm install                # 先装依赖
pnpm build:desktop          # = pnpm -C apps/desktop build = tauri build（产出安装包）
pnpm dev:desktop            # = pnpm -C apps/desktop dev   = tauri dev（开发热更，推荐验证用）
```

代码依据（已在研究阶段确认）：

- `apps/desktop/builtin-plugins/notes/manifest.json:6` 为 `client` 运行时，声明 `storage.kv`(`:10`) + `llm.chat`(`:16`)。
- `apps/desktop/src/lib/plugins-runtime.ts:60` 除 `net.fetch` 外统一走 `invoke_capability`；网关当前仅分派 fs.read/fs.write/system.info/clipboard/system.screenshot，`storage.kv` / `llm.chat` 等返回 `NotSupported`（前端归一化为 `capability_not_supported`，见 `:40`）。
- `apps/desktop/src/pages/plugins/PluginRunner.tsx:174` iframe 用 `sandbox="allow-scripts"`，`:176` 经 `srcDoc` 注入 ui-tokens CSS + `window.sdk` 引导脚本（opaque origin `'null'`）。
- client-action 桥：`clientActionBridge.ts:54` 监听 `plugin-action-bridge-call`；生产者 `clientActionRegistry.ts:38` 在 `PluginRunner.tsx:109` 与 `App.tsx:97` 接入，取 actionId 优先用 `args.dependency_id`（`clientActionBridge.ts:103`，修正原 caller.key 不匹配）。

---

## A5a · 内置 notes 插件端到端

1. 起桌面壳（`pnpm dev:desktop`），于「插件」列表打开内置 **Markdown 笔记（notes）**。
   - 断言：iframe 渲染 notes 界面（`sandbox="allow-scripts"`、opaque origin），无脚本注入报错。
2. 在 notes 内触发 `storage.kv` 与 `llm.chat` 调用（或通过控制台调用 `window.sdk.storage.set('k','v')` / `window.sdk.llm.chat({...})`）。
   - 断言：调用**明确 reject**，错误 `code === 'capability_not_supported'`（文案含「暂未实现」），**而非静默无响应或挂起**——验证网关错误归一化（`plugins-runtime.ts:29` `normalizeCapabilityError`）生效。
3. 断言 `read_plugin_file` 成功解析内置插件目录（`PluginRunner.tsx:118` 读取 `entry` HTML 成功，无 `loadError`）；且 iframe 内 ui-tokens CSS 已注入（可查 DOM `<style>` 含 `--lf-color-primary` 等变量），`window.sdk` 已定义。

---

## A5b · 安装插件注册路径

1. 生成并打包一个 client 插件：
   ```bash
   pnpm plugin:create      # = lingfang-plugin create，选 client 模板
   pnpm plugin:build       # = lingfang-plugin build，产出 .lfplugin v4
   ```
   在桌面壳中安装该 `.lfplugin` 并运行。
2. 在安装的插件内触发一个**已声明**能力（如 `system.info` / `clipboard`）。
   - 断言：调用正常返回（或按网关实现返回对应结果），**不再报 `capability_not_declared`**——证明 A4 注册路径已接通（安装插件经 `plugin-registry.ts` 登记能力）。
3. （进阶）若该插件 `manifest.actions` 声明了含 client `handler.entry`（`.ts/.js/.mjs/.cjs`）的 action，并由某 nodejs/python 插件 `sdk.actions.call(action_id)` 调用：
   - 断言：桥经 `clientActionBridge.runClientAction` 用 `args.dependency_id` 命中 registry 并真正执行返回，**而非回 `action_dependency_unresolved`**——验证 A3 生产者 + key 修正生效。

---

## 如何观察结果

- 浏览器/插件控制台：`window.sdk.*` 调用返回 / reject 的 `code`；`client-action 注册跳过（...）`（`clientActionRegistry.ts:67`）仅为容忍性 `console.warn`，可忽略。
- Tauri 开发者工具：查看 `plugin:output` / `plugin:exited` 事件、postMessage `__lf_host_call` 包络。
- 桌面壳日志：能力调用返回值、`invoke_capability` 错误文案（「未声明能力」→ `capability_not_declared`；「暂未实现」→ `capability_not_supported`）。

---

## 已知限制 / 待 B3·C2

- **B3 · runtime 物料**：node/python 运行时需 `runtime-lock.json` 物料（`runtimes/` 在仓内为空），当前本地无法实际起进程；A5b 进阶项在 nodejs/python 宿主端需该物料后方能跑通。
- **C2 · client 桥凭据**：client 的 `llm.chat` / `image.*` / `video.*` / `audio.*` 走 `BridgeSession`（需 relay `api_base`/`auth_token`），client HTML 无此通道且凭据来源待决策；故 **A5a 中 `llm.chat` 当前预期即为 `NotSupported`**，属正确行为。
- `storage.kv` / `system.notify` / `ui.view` / `fs.pick` / `plugin.upload` / `plugin.submitMarketplace` 同样属「已声明但未实现」，预期 `capability_not_supported`，非缺陷。
