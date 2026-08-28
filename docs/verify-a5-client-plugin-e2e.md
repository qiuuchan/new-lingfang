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

> **⚠️ 当前预期（2026-08-23 `56a5c39` caps 落地后，覆盖下文旧断言；上方执行记录保持存档）**：
> `storage.kv` / `fs.pick` / `system.notify` / `ui.view` 已产品化（`client_host_caps.rs` 三命令 + `uiViewHost` 纯前端落点）。
> 对内置 notes（声明 `storage.kv` + `llm.chat`）：
> - `storage.kv` set/get 现应**真实成功**（持久化到插件 data 目录 `kv.json`），不再 `capability_not_supported`；
> - `llm.chat` 未配置 relay 凭据时为 `relay_not_configured`（配置真实凭据后应真实返回，见 `IMPROVEMENT_PLAN.md` G1）；
> - 未声明 kind（notes 调 `system.info` 等）仍为 `capability_not_declared`；
> - 仅 `plugin.upload` / `plugin.submitMarketplace` 保持 `capability_not_supported`（平台市场审核流，桌面壳不越权伪造）。
>
> 错误码全集见 `apps/desktop/src/lib/plugins-runtime.ts` 的 `normalizeCapabilityError`（8 个 code：
> `capability_not_declared` / `capability_not_supported` / `capability_out_of_scope` / `capability_invalid_path` /
> `net_fetch_ssrf_blocked` / `relay_not_configured` / `relay_error` / `capability_error`）。
> E2E 冒烟自动化（断言即本段）见 `IMPROVEMENT_PLAN.md` 阶段 E2。

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
- **C2 · client 桥凭据**：已拍板 C-on-A（2026-08-22）并落地——凭据由用户在应用设置录入（`SettingsPanel` → `set_relay_settings`），client 调用一律经宿主 `client_*` 代理命令，iframe 永不持凭据。未配置时 `llm.chat` 等即 `relay_not_configured`，属正确行为；真实凭据实操待 G1。
- ~~`storage.kv` / `system.notify` / `ui.view` / `fs.pick` 属「已声明但未实现」~~ **2026-08-23 起已实现**（`56a5c39`）；当前仅 `plugin.upload` / `plugin.submitMarketplace` 预期 `capability_not_supported`，非缺陷。

---

## LF-04a · 自动化 harness（凭据环境变量注入）

> 工单 `docs/WORK_ORDERS.md` LF-04（G1 notes AI 摘要真实凭据实操）被标记为「需用户介入，暂缓派发」。
> 其中 **LF-04a（Agent 可做）** 已交付：**以环境变量注入真实 relay 凭据、驱动桌面壳走 notes AI 摘要闭环、凭据缺失时明确跳过而非假阳性**。
> **LF-04b（真实闭环 + 执行记录节 + 截图）仍阻塞于真实凭据（`api_base` + token），由你提供后单独派发。**

### 凭据注入 seam（Rust）
`apps/desktop/src-tauri/src/client_ai_proxy.rs` 的 `require_relay` 现在按以下优先级解析凭据：
1. 用户设置（磁盘 `config.json`，经 `SettingsPanel` 录入）；
2. 环境变量 `LINGFANG_RELAY_API_BASE` / `LINGFANG_RELAY_TOKEN`（仅当设置未配置时回退）。

两条来源解析出的 `api_base` 都必须是 **https**（F5 防御在 Rust 侧兜底，环境变量路径不再绕过前端校验）。
凭据**仅存在于进程环境**，不进仓库、不进设置 UI、不落盘 `config.json`、不进日志——满足 LF-04 验收「凭据不落地」。

### 自动化 harness
`scripts/e2e-relay-verify.mjs`（复用 `e2e-desktop-smoke.mjs` 的 CDP 驱动手法）：
- **凭据缺失** → 打印明确提示并以 **exit 2 退出**（预期行为，非失败；假阳性防护）；
- **凭据存在** → 透传进桌面进程 env，打开内置 notes，在 iframe 内 `window.sdk.llm.chat({ model:'fast', messages:[...] })`，
  断言返回**真实非空 content**（非 `relay_not_configured`、非 `relay_error`）；
- 退出码：0=真实闭环通过，2=凭据缺失跳过，1=真实闭环失败。

运行（cwd = 仓库根），需先有 `target/debug` 产物（或 `E2E_SKIP_BUILD=1` 复用）：
```bash
LINGFANG_RELAY_API_BASE=https://<relay>/v1 LINGFANG_RELAY_TOKEN=<token> \
  node scripts/e2e-relay-verify.mjs
# 经由 apps/desktop 脚本：
LINGFANG_RELAY_API_BASE=... LINGFANG_RELAY_TOKEN=... pnpm -C apps/desktop test:relay
```

### 待 LF-04b（你提供凭据后）
提供 `LINGFANG_RELAY_API_BASE` + `LINGFANG_RELAY_TOKEN`（或确认可用测试凭据），即可跑通真实闭环，
并在本文件新增「执行记录」节，附真实输出片段与截图；如有失败项如实标注。

---

## LF-04b · 真实凭据闭环（✅ 2026-08-24 已跑通，经官方模型商直连）

> 阻塞解除方式（用户拍板）：不用灵坊平台 relay，改用**官方模型商**（DeepSeek）+ 本机**本地 relay 适配器**。
> 链路：桌面壳 `client_llm_chat` → 本地适配器（模拟平台 relay 协议）→ DeepSeek API 直连 → 回传 notes。

### 本地 relay 适配器（`scripts/relay-adapter.mjs`，零依赖）
- 只监听 `127.0.0.1`（环回）；对外实现 `POST /api/relay/v1/chat/completions`（含 `fast/premium` 档位映射、
  OpenAI 形状响应透传、`{code,message,requestId,details.upstreamDetail}` 错误体——与 `plugin_llm_bridge.rs`
  的 `relay_response_json`/`extract_chat_content` 解析契约对齐）与 `GET /api/relay/v1/models`。
- 上游任意 OpenAI 兼容端点（默认 `https://api.deepseek.com`，可用 `RELAY_ADAPTER_UPSTREAM_BASE` 覆盖）；
  `fast → deepseek-chat`、`premium → deepseek-reasoner`（可用 `RELAY_ADAPTER_MODEL_FAST/PREMIUM` 覆盖）。
- 上游 key 仅经 `RELAY_ADAPTER_UPSTREAM_KEY` 环境变量注入；日志不含任何凭据/头/body。
- 支持 `HTTPS_PROXY` 环境变量走 CONNECT 隧道（手写实现，无 npm 依赖）；`RELAY_ADAPTER_MOCK=1` 时返回带
  标识的假响应（无 key/无网时验证链路用）。

### Rust 侧安全例外（LF-04b 配套，F5 收紧的受控放宽）
`client_ai_proxy.rs::is_allowed_api_base`：https 恒允许；**明文 http 仅限环回地址**
（`127.0.0.1` / `localhost`）——凭据只发往本机适配器进程、不跨网络，无泄露风险；其余 http 一律拒绝。
配套单测 3 个（`cargo test -p lingfang-desktop client_ai_proxy` 全绿）。

### 执行记录（2026-08-24 实测，harness `scripts/e2e-relay-verify.mjs` exit 0）
```
RELAY_ADAPTER_UPSTREAM_KEY=<DeepSeek key 环境变量> \
  node scripts/relay-adapter.mjs                      # 监听 http://127.0.0.1:8787
LINGFANG_RELAY_API_BASE=http://127.0.0.1:8787 \
LINGFANG_RELAY_TOKEN=<任意非空> \
  E2E_SKIP_BUILD=1 node scripts/e2e-relay-verify.mjs
```
断言全部通过：CDP 连接 → 插件中心渲染 → notes iframe 打开 → `window.sdk` 注入 →
`llm.chat({model:'fast', messages:[{system:'用一句话回答：1+1 等于几？只回答数字。'},{role:'user',content:'请回答。'}]})`
→ **真实返回 `"2"`（长度 1，DeepSeek 真实模型输出，非 mock 非 relay_not_configured 非 relay_error）**。

附：adapter 直连复测（同 system+user 摘要 prompt）返回真实长文本摘要；`ping` 返回 `Pong! 🏓`。
凭据全程仅存于进程环境（`RELAY_ADAPTER_UPSTREAM_KEY`），未入仓库/设置 UI/磁盘/日志。

### 注意事项
- 本机直连 `api.deepseek.com` 实际可用（此前 `HEAD` 探测超时属误判，`POST` 正常）；若上游不可达，
  可给 adapter 设 `HTTPS_PROXY` 走代理。
- 桌面壳要求 `api_base` 为 https 或环回 http——本地适配器走环回例外；若后续要远程 relay，必须是 https。
- 首次运行 harness 若残留 `lingfang-desktop.exe` 进程（WebView2 目录锁），先 `taskkill /T /F` 清理再跑。

---

## I1 · action 桥真机闭环（LF-06，2026-08-25 实测 `scripts/e2e-actions-verify.mjs` exit 0）

> 对应 LF-06 阶段 I1：把「进程插件经桥调 `/actions/call` → 前端执行 client-action handler → 回传真实结果」
> 这条此前从未真机跑通过的链路，固化为可重复闭环断言。

**链路**：打开内置 client 插件 `action-demo`（声明 `demo.hello`，注册其 client handler 进
`clientActionBridge` registry）→ 以 action invocation 会话启动内置进程插件 `action-caller`
（`start_builtin_plugin actionInvocation=true`，会话武装 `action_invocation_id`+`action_context`）
→ caller 裸 fetch 直连桥 `/actions/call`（带 `X-LingFang-Plugin-Token`）→ Rust `route_action_call` emit
`plugin-action-bridge-call` → 前端 `clientActionBridge` 取 handler → `plugin-action-client-adapter`
在 sandbox iframe 内执行 handler → `respond_plugin_action_bridge` 回传 → caller 写 `result.json`。

**运行**：
```bash
cd apps/desktop && E2E_SKIP_BUILD=1 node ../../scripts/e2e-actions-verify.mjs
```
断言全部通过：CDP 连接 → 插件中心渲染（含「Action Demo」）→ 打开 demo（注册 `demo.hello`）
→ 启动 caller（一次性脚本秒退被 spawn 监视误报，已吞掉）→ 轮询 `result.json`：
```
{"ok":true,"result":{"greeting":"hello lingfang"}}
```
即真机拿到了 client handler 的**真实执行结果**（greeting 含输入名 `lingfang`），而非
`action_dependency_unresolved` / `action_execution_failed` 占位。

### client-action 沙箱执行的关键约束（曾三次踩坑）
sandbox iframe（`sandbox="allow-scripts"`，opaque origin `'null'`）下：
1. **动态 `import()` blob:/data: 模块**被 Chromium 拦截（`Failed to fetch dynamically imported module`）。
2. **`new AsyncFunction` / eval** 被 CSP（`script-src 'self' 'unsafe-inline'`，无 `unsafe-eval`）拦截
   （`Evaluating a string as JavaScript violates CSP`）。
3. **反引号**模板串若以反引号外层模板字面量插值插进生成的 iframe 文档 → 提前终止 → `Invalid or unexpected token`。
→ 最终方案：宿主侧 `transformClientActionModule` 预转换 handler 源码（剥离 `export`、默认/命名导出收集到
`__exports`），以**真实内联 `<script type="module">` 代码**写入 iframe（被 `'unsafe-inline'` 允许，免 eval），
再 `await handler(input)` 取结果 postMessage 回宿主。

### 反向稳定对照
`clientActionBridge.spec.ts` 已断言「handler 未注册 → `action_dependency_unresolved`」，锁定「无 armed
session / 无 handler 即失败」的稳态；`plugin_llm_bridge.rs` 新增 `route_action_call_denied_without_action_invocation`
（403 `action_dependency_denied`）与 `route_action_call_denied_without_action_context`
（503 `action_runtime_unavailable`）两单测，锁定网关守卫。

### 注意事项
- `action-caller` 是「发请求→写 result.json→exit(0)」一次性脚本，瞬时退出被 spawn 监视误判为「秒退崩溃」
  （`start_builtin_plugin` 可能回 `plugin_crashed`），但其 `result.json` 已落盘，harness 吞掉启动返回错误、
  转而轮询 `result.json` 判定真机结果。
- 内置安装须在 `install()` 标记 `dependency_status=Ready` 且 builtin 直接激活（否则 `action_caller_descriptor`
  拦下 → `action_dependency_denied`）。


## U2 · 能力面观察项闭环（LF-19，2026-08-28 实测 `scripts/e2e-cap-closure-verify.mjs` 全绿 exit 0）

### 断言清单（全部 ✅）
1. **双插件 + 探针导入**：clip-digest / web-clip / relay-probe 三个 `.lfplugin` 经
   `install_plugin_artifact`（origin=local）导入；F3 来源徽标「本地导入」+ 插件详情
   「⚠ 插件未附带签名（manifest.sig 缺失）」警示 ×3 全部展示。
2. **clipboard 正向往返**：web-clip iframe 内 `sdk.clipboard.writeText → readText`
   等值往返（首次正向实证；环回此前仅网关负向）。
3. **net.fetch 公网正向**：`https://example.com/` → HTTP 200（环回 SSRF 拦截已有单测）。
4. **relay 四 kind 正向**：relay-probe 插件（声明 llm.chat / image.generate /
   video.generate / audio.generate）在 relay-adapter（MOCK）驱动下四链路全 ok——
   audio 经宿主 `client_audio_generate` 全链路可用（非缺口）；video 为异步任务提交
   （`{ task_id }` 即成功语义）。

### 过程中修复的真实契约缺陷（clipboard 包络解包）
宿主 `clipboard_op` 返回 `{ content }`（与 storage.kv `{ value }` 同构），但 npm SDK 与
iframe bootstrap 的 `readText` 均未解包、TS 类型谎称 string——真机 readText 拿到对象。
修复：`packages/plugin-sdk/src/index.ts` 与 `apps/desktop/src/lib/clientSdkBootstrap.ts`
双双解包 `.content`（对齐 LF-07「双门面须同步」纪律）；spec mock 形状改为 `{ content }`。
回归：plugin-sdk 163 / desktop 69 全绿。

### 排障实录（e2e 脚本侧）
- **CDP invoke 传数组当命令名**：`page.evaluate(fn, ['list_plugin_installations'])` 让
  `cmd` 变成数组 → IPC 反序列化报 `invalid type: sequence, expected a string` 且 promise
  永不落定（页面 console 可见）——**参数须直接传字符串**。耗时近 1 小时定位（trivial
  evaluate / get_app_version 均正常、前端自身调用正常，唯该调用挂起）。
- 先卸载再导入保证确定性（同名新版本会停在 pendingRelease，runner 仍加载旧活动版本）。
- base-ui Dialog 无 `role="dialog"`；签名警示文案是 reason（「未附带签名」）而非「未签名」。
