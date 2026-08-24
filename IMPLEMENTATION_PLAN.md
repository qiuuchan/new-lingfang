# 灵坊工作台 实施计划(基于代码核实 · 二次修订;三次修订为执行回填)

> 本文档经两轮代码核实。第二轮结论:**证伪一处断言**(`../../scripts/` 路径 bug 不存在,
> 实测可正常加载脚本)、**反转一处建议**(锁文件不应移入 gitignored 的 `runtimes/`)、
> **补充两处架构级缺口**(能力注册表仅覆盖内置插件;action 桥事件链无前端监听),
> 并修正 C 阶段落点分类(`plugin_net_fetch` 命令位置、`audio.generate` 有桥实现、
> `system.requestPermission` 不在契约枚举内)。
> 第三轮(2026-08-21 执行回填):阶段 A(A1-A4)、B2、C1+C3、D1-D3 **已交付并复验通过**;
> B3、C2 已于 2026-08-22 由产品拍板(B3 选 B→C、C2 选 C-on-A);C2 代码已落地,B3 代码待外部物料入库。
> 执行中修正两处计划/代码偏差(`onBack` prop、`parse_manifest` 丢失 paths),详见「执行状况」节。
> 关联背景:my-treasure 是 Tauri v2 零服务器桌面插件平台。

---

## 0. 核实结论(修正与新增)

| 项 | 先前理解 | 核实后的真实状态 |
|---|---|---|
| runtime 物料 | 锁文件存在但路径错位 | **属实**。锁在 `apps/desktop/runtime-lock.json`(83 行,已入库);两脚本(`materialize-bundled-runtimes.mjs:20`、`verify-bundled-runtimes.mjs:11`)按 `runtimes/runtime-lock.json` 找。实测 `cd apps/desktop && node ../../scripts/materialize-bundled-runtimes.mjs` → `missing lock file: ...\apps\desktop\runtimes\runtime-lock.json`。`runtime-parts/` 缺失属实。 |
| ~~脚本路径 bug~~ | `../../scripts/` 会解析到 `apps/scripts/` | **证伪,撤销**。从 `apps/desktop` 出发 `../../` 即仓库根,`../../scripts/` 存在;上面那条实测命令证明 node 成功加载并运行了脚本,失败点是锁路径而非模块解析。`apps/desktop/package.json:11-12` 无 bug。 |
| client 桥接收端 | adapter 完整但无调用方 | **属实**。`executeClientActionAdapter`(`:142`)、`onMessage`(`:189`)、`__lingfangInvoke` 注入(`:118`)、`__lf_client_action_call` 监听齐全;但全仓仅 `plugin-action-client-adapter.spec.ts` 引用,生产代码零调用方。`PluginRunner.tsx` 纯占位(38 行,无 iframe、无 adapter 调用)。且模板 `index.html.tmpl:27` 期望宿主注入完整 `window.sdk` 外观对象。 |
| action 桥事件链 | 未提及 | **新增缺口**。Rust 侧 `/actions/call` 路由会 `emit("plugin-action-bridge-call")`(`plugin_llm_bridge.rs:609`),前端处理后由 `respond_plugin_action_bridge` 命令(`:352`)回传结果——这才是 `executeClientActionAdapter` 的设计调用方。前端对该事件的监听 **grep 为空**,链路断在最后一环。 |
| 能力注册表覆盖面 | 未提及 | **新增缺口**。`registry.register` 全仓仅 `plugins.rs:99` 一处,只被 `main.rs:371` 以**内置插件** release 目录调用。市场安装/本地插件从不注册 → `invoke_capability` 对它们恒返回 `NotDeclared`。即 A 阶段打通后,内置插件可用,安装插件的能力调用仍全灭。 |
| 网关 5/17 | 其余 NotSupported,TS 无落点 | **属实**。`capability.rs:107-118` 仅分派 fs.read / fs.write / system.info / clipboard / system.screenshot。指向不存在的 `plugins-runtime.ts` 的注释共 **三处**:`capability.rs:113-116`、`capability.rs:251-252`(原清单漏)、`plugin-sdk/src/index.ts:140,353`。 |
| Rust 单测 | "未见落地" | 已有:`capability.rs:318+` 完整 `#[cfg(test)]`(fs 越权 / 大小上限 / 路径脱敏 / NotSupported 语义,含 `:477` 的 `unimplemented_capability_returns_not_supported`)。缺的是 desktop 前端测试与 CI。 |

### 关键架构补充:client 侧两套桥 + 一条断链

client HTML 模板 `index.html.tmpl:27` 声明 `const sdk = window.sdk;` —— client 插件期望宿主注入**完整的 `sdk` 外观对象**,而非仅 `window.__lingfangInvoke`。目前 `PluginRunner` 两者都没做。

存在**两套独立的 client 桥机制**:
1. **纯 client HTML 插件**(`entry` 为 `.html`):需宿主在 iframe 内注入 `window.sdk`(底层可走 `__lingfangInvoke` 原语),其方法最终转发到能力网关。
2. **client-action 导出**(`.ts/.js` 模块的 handler):由 `executeClientActionAdapter` 处理——它自行创建 iframe、注入 `__lingfangInvoke`(adapter:118)、监听 `__lf_client_action_call`(adapter:108-122)并回传。该 adapter 完整,但**无调用方**。

外加**一条断链**:nodejs/python 进程经 localhost 桥调 `/actions/call` 时,Rust emit `plugin-action-bridge-call` 事件期望前端执行 action 并经 `respond_plugin_action_bridge` 回传;前端无监听 → 进程端 hang 到超时。

---

## 执行状况(三次修订回填 · 2026-08-21)

| 阶段 | 内容 | 状态 |
|---|---|---|
| A1 | `plugins-runtime.ts`:宿主能力落点,错误归一化为 `{code,message}` | ✅ 已交付 |
| A2 | `PluginRunner.tsx`:client 插件 sandbox iframe 注入 `window.sdk` + ui-tokens,经 `invokeRuntime` 接网关 | ✅ 已交付 |
| A3 | `clientActionBridge.ts`:补齐 `plugin-action-bridge-call` 监听 → 回传;client-action 白名单扩至 `ui.view`/`storage.kv` | ✅ 已交付（监听/白名单，2026-08-21） |
| A4 | 安装插件启动时注册能力(含 fs.* 的 paths),消除 `NotDeclared` | ✅ 已交付 |
| A3' | client-action 注册表**生产者** + 监听 key 修正(`args.dependency_id`)：新建 `clientActionRegistry.ts`，`registerClientActionsForPlugin` 在 App/PluginRunner 加载路径注册；`clientActionBridge` 改从 `args.dependency_id` 取 actionId，补 `unregisterClientActionsForPlugin` | ✅ 已交付(2026-08-22) |
| B2 | 脚本锁路径指向已提交的 `apps/desktop/runtime-lock.json` | ✅ 已交付 |
| C1+C3 | `net.fetch` 直连 `plugin_net_fetch` + 8 个 vitest | ✅ 已交付 |
| D1-D3 | cloud/workflow 占位 + 非阻塞告警规则 + 文档 + 清理过期注释 | ✅ 已交付 |
| B3 | node/python/ffmpeg/chrome.dll 物料无仓内来源机制 | ✅ 决策已拍板（B→C，2026-08-22）；B 链路（CI 制品 + minisign）已端到端跑绿；**P2 方案 C 终态已于 2026-08-23 落地**（installer 入 workspace、sfx 流式解压、打包 runtime-lock 硬门槛、CI 双产物，含 `--silent` 子命令误判存量 bug 修复） |
| C2 | llm/image/video/audio 依赖平台 relay 凭据,与零服务器定位有张力 | ✅ 决策已拍板（C-on-A，2026-08-22）；**代码已落地**（`client_ai_proxy.rs` 五命令 + `PluginStore` 设置 + 前端路由/设置页，`tsc` 干净、desktop vitest 45 测试全绿） |

### 本轮复验(逐条核对代码 + 重跑工具链)

- `cargo check`(apps/desktop/src-tauri):通过(31 个历史 warning,无新增错误)。
- `tsc --noEmit`(desktop + plugin-sdk):干净。
- `vitest run`:desktop 23/23、plugin-sdk 113/113 全绿。
- 关键落点核对:
  - `apps/desktop/src/lib/plugins-runtime.ts`:`net.fetch` 直连 `plugin_net_fetch`,其余 kind 走 `invoke_capability`;错误按文案归一化为 5 类 code。
  - `apps/desktop/src/lib/clientActionBridge.ts`:监听 `plugin-action-bridge-call` → `executeClientActionAdapter` → `respond_plugin_action_bridge` 回传;未注册 action 显式回 `action_dependency_unresolved`(进程端不再静默挂起)。
  - `apps/desktop/src/pages/plugins/PluginRunner.tsx`(38 行占位 → 214 行实现):`srcdoc` + `sandbox="allow-scripts"`(未开 `allow-same-origin`),origin `'null'` 校验,注入 `window.sdk` / `__lingfangInvoke` 与 ui-tokens CSS,cloud/workflow 显式占位。
  - `plugin-action-client-adapter.ts`(client-action 放行白名单):白名单 4 → 6 kind(新增 `ui.view`、`storage.kv`)。
  - `plugin_runner.rs` 的 `parse_manifest` 保留 fs.* 的 `paths`;插件 start 时 `registry.register`。
  - `scripts/materialize-bundled-runtimes.mjs` 的 `lockPath` 指向 `apps/desktop/runtime-lock.json`。
  - `packages/plugin-sdk/src/manifest/index.ts`:`ManifestResult` 增加非阻塞 `warnings`(cloud/workflow 报 `runtime_locally_unsupported`)。
- A5 的桌面端实操验证(打开内置 notes 插件、安装自建插件走注册路径)未在本轮执行,本轮仅完成代码级与单测级验证。

### 执行中发现并修正的偏差

1. **PluginRunner prop 实为 `onBack`**(本文附录原误写 `onRun`,已更正)。
2. **`plugin_runner::parse_manifest` 原丢弃 fs.* 的 `paths`**(仓内既有 bug,非计划误判):只捕获 kind 字符串,fs.read/fs.write 即便声明也因空 paths 落入 `OutOfScope`。已在 A4 一并修复(`plugin_runner.rs` 的 `parse_manifest`)。
3. **`invoke_capability` 命令在 `main.rs`**(不在 capability.rs;本计划附录记载无误,执行初期曾按 capability.rs 寻找,记录以免重蹈)。
4. plugin-sdk `ManifestResult` 加 `warnings` 后,spec 的类型谓词需同步(`manifest/index.spec.ts` 的 `ManifestResult` spec),已补。

---

## 1. 范围与阶段划分

按"先打通可运行链路、再补齐能力面、最后清理边界与文档"的顺序,分四个阶段。每阶段可独立交付、独立验证。

---

## 阶段 A:client 插件运行容器打通(核心阻塞) —— ✅ A1-A4 已交付

**目标**:让 `PluginRunner` 能真正运行 client 插件,并把 iframe 内的 `sdk.*` 调用接到 Rust 能力网关。本阶段不依赖任何 runtime 物料(client 在 iframe 内运行,node/python 才需 runtime),可立即开工。

### A1. 新建 `apps/desktop/src/lib/plugins-runtime.ts`(宿主能力落点) ✅
- 导出 `invokeRuntime(pluginId: string, kind: string, args: unknown): Promise<unknown>`。
- 内部调用 `tauriInvoke('invoke_capability', { pluginId, kind, args })`,复用 `apps/desktop/src/lib/api.ts` 的 `tauriInvoke`(该文件当前**未包裹** `invoke_capability`,在此统一收敛;net.fetch 的路由见 C1)。
- 错误归一化注意:`api.ts` 的 `errorMessage` 只归一化为**字符串**;Tauri 命令错误是 `Result<_, String>` 裸字符串,不含结构化 code。要产出 `{ code, message }` 需自行按文案映射,或改 Rust 侧返回结构化错误(工作量另计)。(另 `api.ts` 已回退 `__TAURI_INTERNALS__`,见 TODO 验证节)
- **注释对齐**:`capability.rs`(两处)、`plugin-sdk/src/index.ts`(两处)注释引用了 `plugins-runtime.ts`。本文件创建后注释即成真,只需核对措辞(如 `RUNTIME_BRIDGE_TIMEOUT_MS` 是否真实存在并对齐),不必删除。

### A2. 宿主向 client iframe 注入 `window.sdk`(`PluginRunner.tsx`) ✅
对 `runtime_type === 'client'`(`entry` 为 `.html`):
- 渲染 `<iframe sandbox="allow-scripts">` + **`srcdoc`**(entry 内容经 `read_plugin_file`(`main.rs`)读取,已带插件目录防穿越;该命令当前前端零调用方)。**不建议** `allow-same-origin`:与 `plugin-action-client-adapter.ts` 的 `clientActionMessageFromFrame`(校验 `event.origin === 'null'`)安全姿态保持一致。若 entry 有相对资源引用,需注入 `<base>` 或改自定义协议,另行评估。
- 注入分两层:先注入原语 `window.__lingfangInvoke(kind, args)`(SDK 的 typed `sdk` 对象也走它,见 `plugin-sdk/src/index.ts` 的 `__lingfangInvoke` 注入),再在其上构建模板期望的 `window.sdk` 外观(`fs.read/write`、`net.fetch`、`clipboard`、`llm.chat`、`image.*`、`storage.kv`、`system.*`、`ui.view`、`plugin.*`),每个方法最终调 A1 的 `invokeRuntime`。
- 注入/调用协议:宿主页监听 `window` 的 `message` 事件(校验 `event.source === iframe.contentWindow` 且 `event.origin === 'null'`);iframe 内通过 `parent.postMessage({ __lf_host_call })` 请求能力,宿主回 `postMessage({ __lf_host_reply })`。**协议命名与 client-action 的 `__lf_client_action_*` 区分开**,避免两套消息互相干扰。
- 顺带:按 CODEBUDDY.md 的架构描述,宿主应向每个插件 iframe 注入 `@lingfang/ui-tokens` 的 CSS 变量(模板 `:root` 使用 `var(--lf-bg)` 等);目前无任何代码做这件事,一并补上。

### A3. client-action 导出路径接入(补全 adapter 调用方) ✅
- `executeClientActionAdapter` 已完整但无人调用。**设计调用方**是 `plugin-action-bridge-call` 事件的监听器:用 `tauriListen` 监听该事件(`plugin_llm_bridge.rs` 的 `emit("plugin-action-bridge-call")` 处),按 caller 信息执行对应 action——client 导出走 `executeClientActionAdapter`,注入 `onCapability` = A1 的 `invokeRuntime`;结果经 `tauriInvoke('respond_plugin_action_bridge', { requestId, result | error })`(`plugin_llm_bridge.rs` 的 `respond_plugin_action_bridge`)回传。
- **扩展放行白名单**:`plugin-action-client-adapter.ts`(client-action 放行白名单)当前仅放行 `actions.call / artifacts.create / artifacts.materialize / artifacts.import` 四个 kind。按契约 `CapabilityKind` 中 client 可合法声明的子集补齐(至少 `ui.view`、`storage.kv`),避免合法 kind 被 `action_dependency_denied` 卡死。
- 至此两条 client 路径(client HTML 的 `window.sdk` ↔ client-action 的 `__lingfangInvoke`)都接到同一网关。

### A4. 能力注册表补齐(非内置插件) ✅
- 现状:`registry.register` 仅 `plugins.rs` 一处,只服务内置插件(`main.rs` 的内置注册调用)。
- 在 `plugin_package_manager` / `plugin_store` 的安装与加载路径上,解析 manifest 的 `capabilities[]` 并注册进 `CapabilityRegistry`(含 fs.* 的 `paths` 模板展开,复用 `plugins.rs` 的 manifest 解析逻辑)。否则市场安装/本地插件的所有 `invoke_capability` 调用恒 `NotDeclared`,A 阶段成果对它们不可见。
- 执行回填:实际落点在 `plugin_runner.rs`——插件 start 时注册,并连带修复了 `parse_manifest` 丢失 `paths` 的既有 bug。

### A5. 验证 ✅（代码级 + 桌面端实操，2026-08-23 完成）
- 实操已经 WebView2 远程调试自动化完成（A5a 内置 notes / A5b 安装插件注册路径均通过），
  过程暴露并修复 4 个集成缺陷（read_plugin_file id 失配 / CSP 改写阻断 iframe 内联脚本 /
  api.ts 全局缺失 + PluginRunner 监听注册时序 / client 运行时安装插件能力未注册），
  详见 TODO.md「二、验证」节。
- 用**内置 `notes` 插件**即可验证(`builtin-plugins/notes/manifest.json`:client 运行时,声明 `storage.kv` + `llm.chat`):桌面壳运行 → 打开 notes → 确认 `sdk.storage.kv` / `sdk.llm.chat` 经网关返回 `NotSupported`(而非静默无应)。
- 再走 `pnpm plugin:create` 生成 client 模板 → `pnpm plugin:build` → 安装运行,验证 A4 注册路径(安装插件不再 `NotDeclared`)。

---

## 阶段 B:runtime 物料落地 —— B2 ✅ / B3 ⏸

**前提**:`runtime-parts/` 的分片与 node/python/ffmpeg 物料是外部资源,代码层只能修一致性。

### B1. ~~修脚本路径 bug~~(已撤销)
二次核实证伪:`apps/desktop/package.json:11-12` 的 `../../scripts/` 从 `apps/desktop` 解析即仓库根 `scripts/`,实测脚本可正常加载运行。无 bug,无需改动。

### B2. 修脚本锁路径(注意:方向与初版建议相反) ✅
- 改 `materialize-bundled-runtimes.mjs` 与 `verify-bundled-runtimes.mjs` 的 `lockPath`:默认指向 `apps/desktop/runtime-lock.json`(锁所在的真实位置),`runtimeRoot` 仍作输出目录。
- **不要**把锁移进 `apps/desktop/runtimes/`:根 `.gitignore:11-13` 明确忽略 `runtimes/`("随包分发,不入仓"),移入即让锁文件脱出版本控制。锁是描述物料的来源数据,留在已入库的 `apps/desktop/runtime-lock.json` 是正确位置。

### B3. 补 runtime 物料(决策: B→C) ✅ 决策已拍板 / 脚手架已落地,待外部物料入库
- 锁内 `materializedFiles` 仅 **1 条**:`chrome.dll`(5 个分片,`partsRoot: "../runtime-parts"` 即 `apps/desktop/runtime-parts/`,sha256 已定)。`runtime-parts/` 未在任何 `.gitignore` 中 → 设计意图是**分片入库**;已配 `.gitattributes` 走 Git LFS。
- 其余 `keyFiles` / `requiredFiles`(nodejs / python / ffmpeg / chromium 完整目录)在仓内**没有任何获取机制**(`runtimes/` 不入仓)。B3 决策:ffmpeg 改公开可下载产物(`runtime-lock.json` 已把 `source` 由内部 `repository-history:` 改为 gyan.dev 公开 URL + `sourceSha256`/`sourceSize` 占位),`materialize-bundled-runtimes.mjs` 已新增「公共 URL 来源」下载+sha256 硬校验分支(未就绪时 NOTICE 跳过,不阻断),`plugin_security.rs` 抽出通用 `verify_minisign` 供 CI 产物复用,`ci.yml` 新增 `publish-runtimes` job(物料/密钥就绪后启用 minisign 签名 + release 附件)。
- **仍需外部物料方可闭环**:`chrome.dll` 5 分片(285MB)、ffmpeg 实际 `sourceSha256`/`sourceSize`(拉取真实二进制回填)、CI minisign 密钥(Org secret)。这些入库/配置前,B 的 CI 灌装与 C 的安装器注入仍待落码。

### B4. 验证(随 B3 闭环)
- `pnpm -C apps/desktop runtime:prepare` 成功 materialize;`runtime:verify` 通过 sha256 + Playwright revision 校验(当前第一步即报 `missing lock file`,B2 后应推进到物料缺失项的明确报错)。

---

## 阶段 C:网关能力面补齐 —— C1+C3 ✅ / C2 ✅(代码已落地)

**策略**:17 种 `CapabilityKind`(`contract/src/plugin.ts` 的枚举)按落点分四类:
- **网关已落(5)**:fs.read / fs.write / system.info / clipboard / system.screenshot(`capability.rs` 的 `invoke()` / `require_capability` 分派)。
- **有独立命令(1)**:`net.fetch` → `plugin_net_fetch` 命令在 **`main.rs`**(不在 `plugin_net_fetch.rs`,该文件不存在;CODEBUDDY.md 的描述同样过时)。命令自带 manifest 声明校验 + SSRF 守卫 + 30s / 10 MiB 限制。
- **有桥路由但 session/relay 耦合(5)**:llm.chat(`plugin_llm_bridge.rs` 的 `route_llm_chat`)/ image.generate / image.edit / video.generate / **audio.generate(`plugin_llm_bridge.rs` 的 `route_audio_generate`,初版误判为"无落点")**。这些是 localhost 桥的路由函数,按 `BridgeSession` 键控(逐能力 `allow_*` 标志 + `api_base` / `auth_token`),最终转发**平台 relay** `/api/relay/v1/*`。
- **无后台落点(6)**:ui.view / fs.pick / storage.kv / system.notify / plugin.upload / plugin.submitMarketplace。保持 `NotSupported`(已具备),并在 `plugins-runtime.ts` / SDK 文档标注"契约已定义、桌面壳未实现"。
- 注意:**`system.requestPermission` 不在 `CapabilityKind` 枚举内**(初版误列为第 8 种无落点 kind),它只是设想的 TS 侧辅助函数名,非网关 kind。

### C1. `net.fetch` 接入(在 plugins-runtime.ts 路由,勿改 capability.rs) ✅
- `invokeRuntime` 对 `net.fetch` 直接调 `tauriInvoke('plugin_net_fetch', { pluginId, args })`,其余 kind 走 `invoke_capability`。
- **不要**在 `capability.rs` 的 `invoke()` match 加 `net.fetch` 分支:`invoke()` 是**同步**函数,而 `plugin_net_fetch` 是 async reqwest;且该命令已自校验声明与 SSRF,重复走网关只会错配。`capability.rs` 注释本来就假设这个设计。

### C2. llm / image / video / audio(决策: C-on-A,代码已落地) ✅
- 决策(2026-08-22):client AI 是 notes 等插件核心卖点,**不接受 D**;**不引入平台账号体系(B 出局)**,守住零服务器叙事;凭据由用户在应用设置显式配置(A),client 调用一律经宿主代理命令、iframe 永不持凭据(C);计费按配置 token 归属既有灵石模型。
- 已交付(`client_ai_proxy.rs`):`client_llm_chat` / `client_image_generate` / `client_image_edit` / `client_video_generate` / `client_audio_generate` 五个 `#[tauri::command]`,从 `PluginStore` 读设置凭据 → `registry.find` 校验声明能力 → 瞬态 `BridgeSession` 复用 `relay_*` 辅助转发;`relay_not_configured:` / `capability_not_declared:` / `relay_error:` 错误前缀供前端友好提示。
- `PluginStore` 扩展 `relay_api_base` / `relay_auth_token` + `get_relay_settings` / `set_relay_settings`(原子写复用 `write_config`)。
- 前端 `plugins-runtime.ts` 将五个 AI kind 路由到 `client_*` 命令;`SettingsPanel.tsx` + `Sidebar`「设置」入口录入凭据并优雅降级。
- 验证:`tsc --noEmit` 干净;desktop vitest 8/8 文件 45 测试全绿(含 `plugins-runtime.spec.ts` 13)。Rust 侧于 2026-08-23 补验:`cargo check/test --workspace` 通过(首次工具链编译,顺带修复 4 处存量测试代码问题,见 TODO「当前验证基线」)。

### C3. 验证 ✅
- `capability.rs` 已有 NotSupported 用例(`:478`),可扩展覆盖新接通的 kind。
- 为 `plugins-runtime.ts` 补 vitest 单测:`net.fetch` 路由到 `plugin_net_fetch`、其余 kind 走 `invoke_capability`、错误字符串 → `{ code, message }` 映射。

---

## 阶段 D:边界清理与文档 —— ✅ 已交付

### D1. cloud/workflow 幽灵类型 ✅
- `apps/desktop/src/lib/types.ts` 的 `runtime_type` 联合类型含 `'cloud'|'workflow'`:`PluginRunner` 显式渲染"当前桌面壳不支持 cloud/workflow 运行时"占位(当前它对**所有** runtime_type 渲染同一占位,完全不区分)。
- `packages/plugin-sdk` 的 validate(`manifest/rules.ts`):加一条规则——`runtime_type` 为 cloud/workflow 时提示"本地桌面壳不支持,需平台云"(不阻断,仅告警)。注意 `ruleEntryRuntimeMatch:87` 已对 cloud 做 entry 必须是 URL 的校验,新规则只补 workflow 与告警语义。

### D2. 修文档死链 ✅
- `packages/plugin-sdk/README.md:3` 指向 `../../docs/plugin-development.md`,仓内无 `docs/`(glob 为空)。二选一:创建 `docs/plugin-development.md`,或改指 contract 内对应说明 / 在线文档。

### D3. 清理残留注释 ✅
- 全仓 grep 已删除的 "Rust 后端 / relay / billing" 引用,统一加 CONTRACT 风格说明或删除(如 `main.rs` 中指向不存在文档的注释)。

---

## 2. 依赖与风险

- **B3 是 B 阶段的真正阻塞**:chrome.dll 分片可入库,但 node/python/ffmpeg 物料无仓内来源机制。**不影响阶段 A**(A 不依赖 runtime 物料),A 先行,B2 可并行(一行级修改)。
- **A4(注册表缺口)决定 A 阶段成果的覆盖面**:只打通 A1-A3,内置插件可用、安装插件仍 `NotDeclared`。
- **C2 有产品决策前置**:llm/image/video/audio 依赖平台 relay 凭据,与零服务器定位有张力,动工前先定凭据来源。
- **A2 的 iframe 注入协议**:与 `__lf_client_action_*` 区分命名;sandbox 姿态与 adapter 对齐(`allow-scripts` + srcdoc + origin 'null' 校验),勿为图方便开 `allow-same-origin`。

## 3. 建议执行顺序

1. **A1 + A2 + A3**(打通 client 运行,纯前端代码,不卡 runtime 物料)——立刻消除"插件石沉大海"。
2. **A4**(注册表补齐)紧随其后,否则安装插件无受益。
3. 并行 **B2**(脚本锁路径,低风险)。
4. **C1 + C3**(net.fetch 路由 + 验证);未实现 kind 保持 NotSupported 并标注。
5. **D1 – D3** 清理。
6. **C2**(需 relay 凭据决策)、**B3**(需物料来源)最后闭环。

---

## 附:核实关键证据(二次修订,全部经本轮读取/实测确认)

> 注:本附录记录二次修订时(执行前)的状态。其中"adapter 无调用方 / PluginRunner 占位 / 白名单 4 kind / `registry.register` 唯一"等缺口已在执行中消除,现状以「执行状况」节为准。

- `apps/desktop/runtime-lock.json` 存在(83 行,未 gitignore);`apps/desktop/runtimes/` 为空且被根 `.gitignore:12` 忽略;`apps/desktop/runtime-parts/` 不存在(未被忽略,设计意图为分片入库)。
- 实测 `cd apps/desktop && node ../../scripts/materialize-bundled-runtimes.mjs` → `[runtimes] missing lock file: D:\work\w1-lf\my-treasure\apps\desktop\runtimes\runtime-lock.json`(同时证明 `../../scripts/` 路径无 bug)。
- `scripts/materialize-bundled-runtimes.mjs:20`、`scripts/verify-bundled-runtimes.mjs:11`:锁路径写死 `runtimeRoot/runtime-lock.json`。
- `apps/desktop/src/lib/plugin-action-client-adapter.ts`:`executeClientActionAdapter`(`:142`)、`onMessage`(`:189`)、`__lingfangInvoke` 注入(`:118`)、白名单 4 kind(`:213-218`);生产代码零调用方(仅 spec 引用)。
- `plugin_llm_bridge.rs:609` emit `plugin-action-bridge-call`、`:352` `respond_plugin_action_bridge` 命令;前端无对应监听(grep 为空)。
- `apps/desktop/src/pages/plugins/PluginRunner.tsx`:纯占位(38 行);`App.tsx:336` 渲染,`onBack` 仅设前端状态,不触达任何 Tauri 命令(三次修订更正:prop 名原误写 `onRun`)。
- `apps/desktop/src-tauri/src/capability.rs:107-118`:`invoke()` 仅分派 5 种;`:113-116` 与 `:251-252` 注释指向 `plugins-runtime.ts`;`:318+` 完整测试模块。
- `plugins.rs:99` 是唯一 `registry.register` 调用点,仅服务内置插件(`main.rs:371`)。
- `main.rs:157` `plugin_net_fetch` 命令(async,自校验声明 + SSRF 守卫);`main.rs:274` `invoke_capability`;`main.rs:250` `read_plugin_file`(前端零调用方);**不存在** `plugin_net_fetch.rs`。
- `plugin_llm_bridge.rs:675` `route_llm_chat`、`:1191` `route_audio_generate`(audio 有桥实现);`:157` `register_session` 按 `BridgeSession` 键控并注入 relay 凭据。
- `packages/contract/src/plugin.ts:21-39`:`CapabilityKind` 17 种枚举(不含 `system.requestPermission`)。
- `packages/plugin-sdk/src/templates/client/ui/index.html.tmpl:27`:`const sdk = window.sdk;`;`builtin-plugins/notes/manifest.json`:client 运行时,声明 `storage.kv` + `llm.chat`。
- `packages/plugin-sdk/src/index.ts:140,353`:注释引用 `plugins-runtime.ts`;`:360-362` SDK 桥原语为 `__lingfangInvoke`。
- `apps/desktop/src/lib/types.ts:41`:`runtime_type` 联合类型含 `'cloud'|'workflow'`;`manifest/rules.ts:87` 已对 cloud entry 做 URL 校验。
- `packages/plugin-sdk/README.md:3` 死链 `../../docs/plugin-development.md`(仓内无 `docs/`)。
