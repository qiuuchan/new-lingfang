# 千匣台 — 后续任务清单

> 基于 `IMPLEMENTATION_PLAN.md` 三轮修订（A1–A4、B2、C1+C3、D1–D3 已交付）的执行结果梳理。
> 前序交付状态见 `IMPLEMENTATION_PLAN.md` 的「执行状况」节。
> **2026-08-23 起，后续工作以 `IMPROVEMENT_PLAN.md`（第二轮改进计划，阶段 E–H）为准**；
> 本清单剩余「可选」项已被其吸收（未实现 kind 产品化 → 已由 `56a5c39` 交付并回填；行号校准 → G5）。

---

## 一、决策阻塞（已拍板，见 `docs/DECISION-REQUEST.md`）

> 两项决策已于 2026-08-22 由产品拍板：B3 选 **B→C**、C2 选 **C-on-A**。代码落地进度见下。

- [x] **B3 · runtime 物料来源**（决策：B→C）✅ 决策已拍板 / 代码部分可落地
  - 拍板要点：离线安装为硬要求 → C（安装器附带）为终态；v1 优先用 B（CI 制品）解除构建阻塞；
    ffmpeg 改公开可下载产物（不绑内网）；单包可 >1.5GB；运行时随 App 版本发；sha256 硬门槛 +
    CI 制品 minisign 签名（复用 `plugin_security.rs`）；`chrome.dll` 分片立即提交并启用 Git LFS。
  - **外部物料补齐（✅ 2026-08-22 本机实测）**：
    - `chrome.dll`：自 Playwright CFT 149.0.7827.55 `chrome-win64.zip` 提取，size/sha256 与锁逐字节一致；
      等分切为 5 片落位 `runtime-parts/chromium/ms-playwright/chromium-1228/chrome-win64/`，拼合回验 sha256 通过。
    - ffmpeg：归档（166,721,853B，sha256 `0fff1889…`）经 gyan.dev `/builds/packages/`（GitHub 镜像字节一致）取得，
      包内 ffmpeg.exe / ffprobe.exe 与 keyFiles 完全一致；lock 已回填 `sourceSha256`/`sourceSize`，
      `source` URL 修正为 `/builds/packages/`（原 `/builds/` 根路径已 404）。
    - `ci.yml` `publish-runtimes` checkout 已启用 `lfs: true`。
  - **B 链路已闭环（✅ 2026-08-22 端到端跑绿）**：Org secret `QIANXIA_RUNTIME_PUBKEY`/`QIANXIA_RUNTIME_SIGKEY`
    已注册（旧 `.runtime-signing/` 草案密钥作废，唯一信任根 = Org secret）；`publish-runtimes` 六步全部 hard——
    LFS 检出 → curl 断点预取 → materialize → populate(node/python/pnpm/ffmpeg/chromium) → verify(全量 sha256+漂移) →
    打包(~1.7GB) → minisign 签名+自验 → Release 上传，tag `v0.0.1-test` 全绿，
    产物见 `https://github.com/qiuuchan/new-lingfang/releases/tag/v0.0.1-test`。
    过程中实测修正：python.exe 历史哈希不可复现已按 stripped 构建回填、`@playwright/test@1.61.1` 补入依赖、
    ffmpeg/python 归档走断点预取。~~仅剩 P2：installer crate 注入 `runtimes/`（方案 C）~~
  - **P2 已完成（✅ 2026-08-23 方案 C 终态落地，B3→C 迁移闭环）**：
    - installer crate 接入 Cargo workspace（根 `Cargo.toml` members 增 `apps/desktop/installer`）。
    - `sfx.rs` 改流式解压：新增 `SegmentReader`（把 exe 内 payload 段映射为有界 Read+Seek 视图），
      >1.5GB 的 runtimes payload 不再整段读进内存；trailer 格式不变（u32 上限 ≈4GiB，打包脚本守卫）。
    - `build-installer.mjs` 打包硬门槛：注入前强制跑 `verify-bundled-runtimes.mjs`
      （keyFiles sha256 + requiredFiles + materializedFiles + Playwright 漂移全量校验，不过即拒绝打包）；
      排除 `runtimes/.download` 预取归档（省数百 MB）；payload 内置纯净 `updater.exe`
      （避免兜底复制带包自身导致安装目录翻倍）；installer 裸 exe / u32 容量双重防御。
    - **顺带修复存量 bug**：`cli.rs` 把「第一个非 `--` 词元」当子命令——updater 以
      `--silent --target <路径>` 形态拉起新安装包时路径被误判为未知子命令，静默安装/热更必败；
      现改为先消费 flag 及其值再识别子命令（含回归测试）。
    - CI：`publish-runtimes` job 扩为「B3→C」双产物——在已校验的 runtimes/ 上构建桌面壳 +
      SFX 安装器，minisign 签名后随 Release 上传 `QianXia-Setup-*.exe`（+ `.minisig`）。
    - 本机端到端验证：runtime-lock 校验通过 → 打包（payload 629.6MB / Setup 633.2MB）→
      `--silent --target` 静默解压 exit=0 → 解压产物 python.exe/chrome.dll 与锁逐字节一致、
      updater.exe 为无尾部裸 exe。`cargo test -p qianxia-installer` 30/30 全绿。
  - **可立即准备（代码侧，本会话已完成 ✅ 2026-08-22）**：
    - `.gitattributes`：Git LFS 跟踪 `apps/desktop/runtime-parts/**` 与 `*.part-*`（chrome.dll 分片不拖垮克隆；
      团队初始化/提交流程见 `docs/lfs-setup.md`）。
    - `runtime-lock.json`：`ffmpeg.source` 由内部 `repository-history:` 改为公开可下载产物
      （gyan.dev `ffmpeg-8.1.2-full_build.7z`），新增 `sourceSha256`/`sourceSize` 占位（现已实测回填，
      见上「外部物料补齐」；sha256 为硬门槛）；并约定 `source` 为 `https://` URL 时的 schema 契约。
    - `scripts/materialize-bundled-runtimes.mjs`：在分片拼合循环之后新增「公共 URL 来源」循环——
      `source` 为 `https://` 且 `sourceSha256`/`sourceSize` 就绪时，下载→size+sha256 硬校验→保留归档待
      Windows 构建主机 7z 解压；未就绪则打印 NOTICE 跳过（不硬失败，使脚本当下可跑）。原 chrome.dll 分片路径不变。
    - `plugin_security.rs`：抽出通用 `verify_minisign(pubkey_b64, sig_text, message)`，`verify_plugin_signature`
      改委托之——CI 运行时产物可复用同一 minisign 原语。
    - `.github/workflows/ci.yml`：新增 `publish-runtimes` job（windows-latest，仅 `v*` tag 触发，依赖 `quality`），
      调用 `runtime:prepare`/`runtime:verify` 脚本、minisign 签名（密钥取自 Org secret，缺失则跳过）、上传 release 附件；
      物料/密钥未就绪时 `continue-on-error` 不阻断 CI。

- [x] **C2 · client iframe 的 llm/image/video/audio 桥**（决策：C-on-A）✅ 代码已落地（2026-08-22）
  - 拍板要点：client AI 是 notes 等插件核心卖点，D 出局；不引入平台账号体系（B 出局）；
    凭据由用户在应用设置显式配置（A），client 调用一律经宿主代理命令、iframe 永不持凭据（C）；
    计费按配置 token 归属既有灵石模型。
  - **已交付**：
    - Rust 侧 `client_ai_proxy.rs`：`client_llm_chat` / `client_image_generate` / `client_image_edit`
      / `client_video_generate` / `client_audio_generate` 五个 `#[tauri::command]`，从 `PluginStore`
      读设置凭据、经 `registry.find` 校验声明能力、构造瞬态 `BridgeSession` 复用 `relay_*` 辅助转发；
      凭据缺失返回 `relay_not_configured:`、未声明返回 `capability_not_declared:`、relay 错误返回
      `relay_error:`（含配额超限可读提示）。`PluginStore` 扩展 `relay_api_base`/`relay_auth_token`
      + `get_relay_settings`/`set_relay_settings` 命令（原子写复用 `write_config`）。
    - 前端 `plugins-runtime.ts`：`invokeRuntime` 将五个 AI kind 改路由到 `client_*` 命令（net.fetch /
      其余 capability 不变）；错误归一化新增 `relay_not_configured` / `relay_error` 码。
    - 新增 `SettingsPanel.tsx` + `Sidebar`「设置」入口 + `PanelDialog` 挂载，录入 relay 凭据并优雅降级提示。
    - 单测 `plugins-runtime.spec.ts`（13）覆盖五类 AI kind → `client_*` 路由、net.fetch / fs.read 不变。
  - 验证：`tsc --noEmit` 干净；desktop vitest 8/8 文件 45 测试全绿；Rust 侧已于 2026-08-23
    `cargo check/test --workspace` 补验通过（此前因无工具链仅人工核查）。
  - 待实操（需 WebView2 + cargo build）：内置 notes 的 AI 摘要经设置凭据真正跑通。

## 二、验证（✅ 2026-08-23 已完成，经 WebView2 远程调试自动化实测）

- [x] **A5a · 内置 notes 插件端到端验证** ✅
  - 方式：`tauri build --no-bundle --debug` 构建产物 + `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port`
    启动桌面壳，Playwright `connectOverCDP` 驱动真实 UI 打开 notes 并在插件 iframe 内断言。
  - 结果：iframe 渲染 notes 界面（sandbox allow-scripts、opaque origin）；`window.sdk`/`__qianxiaInvoke`
    注入成功；ui-tokens CSS 注入生效；`read_plugin_file` 解析内置插件目录成功；
    `storage.kv` 明确 reject `capability_not_supported`（非静默无应）；
    未声明的 `system.info` 拒绝 `capability_not_declared`；
    `llm.chat` 返回 `relay_not_configured`——C2 落地后 AI 桥已接管该 kind，
    原 runbook「预期 NotSupported」已被取代（凭据未配置时的正确表现）。
  - 实测暴露并修复 **3 个真缺陷**（单测无法覆盖的集成问题）：
    1. `read_plugin_file` 只认内置 manifest id，前端传 installationId 必失败
       （main.rs 增安装账本回退解析；同时使安装插件的 entry HTML 可读）。
    2. Tauri 构建期 CSP 改写把 `script-src` 的 `'unsafe-inline'` 替换为 nonce/hash，
       srcdoc iframe 内所有内联脚本被阻断 → 插件 UI 全部无 JS。
       已设 `dangerousDisableAssetCspModification: true` 并保留显式 `'unsafe-inline'`。
    3. `api.ts` 依赖的 `window.__TAURI__` 全局实际不存在（IPC 真入口为 `__TAURI_INTERNALS__`）→
       经 api 层的所有命令调用直接抛错；且 PluginRunner 宿主监听 effect 在 iframe 渲染前
       注册时 ref 为 null 直接 return、永不重试 → 插件能力调用全部静默挂起。
       修复：api.ts 回退 `__TAURI_INTERNALS__`（listen 按 v2 event 插件协议直连）+
       PluginRunner 监听器无条件注册、事件到达时再解析 ref。

- [x] **A5b · 安装插件注册路径验证** ✅
  - 方式：CLI 非交互生成 client 模板（声明 system.info+clipboard）→ validate/build 出 .qplugin →
    经页面内 IPC 调 `install_plugin_artifact` 安装（origin=local）→ UI 打开运行。
  - 结果：已声明的 `system.info`/`clipboard.writeText` 真实执行返回数据（不再 not_declared），
    未声明的 `storage.kv` 正确拒绝——A4 价值得到端到端证明。
  - 实测暴露并修复第 4 个缺陷：**client 运行时的安装插件从不注册能力**
    （原 A4 只覆盖进程型 start_plugin 路径）。已在 `load_installed_plugin` 命令层
    打开时注册 manifest 声明能力（幂等），并抽出 `plugins::capabilities_from_manifest` 共用解析。

## 三、功能补全（需要写代码）

- [x] **A3 · client-action 注册表生产者** ✅ 已交付（2026-08-22）
  - 现状（交付前）：`clientActionBridge` 已监听 `plugin-action-bridge-call` 并回传，但**没有生产者**把
    `caller → action 源码/导出名` 填进 registry。且监听器取 `actionId` 的方式与 Rust 实际发出的
    `caller` 载荷不匹配——`caller`（`plugin_package_manager.rs` 的调用方载荷）只含调用方 `installation_id`、
   不含 `actionId`，而真实被调的 action id 在 `args.dependency_id`（SDK `sdk.actions.call` 发出）。
    故原取法会拿到「调用方 installation_id」，与生产者按 `action_id` 注册的 key 永不匹配。
  - 修复 + 补全：
    - `clientActionBridge.ts`：`runClientAction` 改为优先从 `args.dependency_id` 取 actionId（回退
      `caller.actionId/caller.id`），新增 `pluginId → action_id[]` 副索引支持 `unregisterClientActionsForPlugin`。
    - 新建 `clientActionRegistry.ts`：生产者 `registerClientActionsForPlugin(plugin)`，读取
      `manifest.actions`，过滤含 client handler.entry（`.ts/.js/.mjs/.cjs`）的 action，经
      `read_plugin_file` 取源码并 `registerClientActionHandler(action_id, {pluginId, source, exportName})`；
      单 action 失败仅 `console.warn` 容忍。
    - 接入：`App.tsx`（`hydrateInstallationPreferences` 加载后注册）+ `PluginRunner.tsx`（打开插件时注册）。
    - 单测：`clientActionRegistry.spec.ts`（6）+ `clientActionBridge.spec.ts`（2，含 dependency_id 命中/未命中）。
  - 验证：`tsc --noEmit` 干净；desktop vitest 23 → 31 全绿。
  - 桌面端实操（需 WebView2 + cargo build，本环境未跑）：装声明 client-action 的插件 →
    nodejs 插件 `sdk.actions.call(action_id)` 应真正执行并返回，而非 `action_dependency_unresolved`。

- [x] **未实现 kind 的产品化** ✅ 部分落地（2026-08-23），其余保持 NotSupported 并记录理由
  - **已落地 4 个**（经桌面壳 CDP 端到端实测）：
    - `storage.kv` → `client_storage_kv`（Rust）：声明自校验 + 按插件隔离持久化
      `<data>/kv.json`（原子写 tmp+rename；单值 256KB / 条目数 1024 / 文件 8MB 上限）。
      实测 set/get 往返 ✅。
    - `fs.pick` → `client_fs_pick`（Rust）：tauri-plugin-dialog 原生选择器，accept 扩展名过滤，
      取消返回空数组。声明守卫实测（未声明插件立即 `capability_not_declared`、不弹框）✅；
      原生对话框交互路径为插件官方组件行为，留人工确认。
    - `system.notify` → `client_system_notify`（Rust）：tauri-plugin-notification 系统通知。
      实测真实发出通知 ✅。顺带修正 iframe 引导脚本 `notify(input)` 与 SDK 门面
      `notify(title, body)` 的签名漂移。
    - `ui.view` → **纯前端落点**（不经 Rust）：新增 `uiViewHost.ts` 队列 + `UiViewHost.tsx`
      （挂 App 根部）；string 走 Markdown 渲染、其余安全序列化为 JSON 文本，
      绝不 innerHTML——插件无法向宿主页注入脚本。实测宿主弹层渲染 + 关闭回包 ✅。
  - **保持 NotSupported 2 个**：`plugin.upload` / `plugin.submitMarketplace` —— 属平台市场
    审核流交互（需平台凭据与流程），零服务器桌面壳不越权伪造；网关语义与文案不变。
  - 新增 Rust 单测 8 个（kv 边界/持久化/损坏容忍）、前端路由单测 5 个；
    desktop vitest 45 → 50 全绿。

## 四、工程化与清理（低优先）

- [x] **desktop 前端测试 + CI** ✅ 已交付（2026-08-22）
  - 新增 vitest：
    - `clientActionRegistry.spec.ts`（6）+ `clientActionBridge.spec.ts`（2，含 dependency_id 命中/未命中）—— A3 生产者与桥派发。
    - `plugin-registry.spec.ts`（4）：`loadInstalledPlugin` 映射 / `listInstallations` 形状。
    - `pluginRunnerHost.spec.ts`（5）+ 抽出纯函数 `pluginRunnerHost.ts`：A2 宿主消息处理
      （`event.source`/`event.origin === 'null'` 守卫、`__lf_host_call` 包络、成功/失败回传）。
  - 新增 `.github/workflows/ci.yml`：push/PR 跑 `pnpm install` → `pnpm typecheck` → `pnpm test`
    （不含 Rust/桌面构建，避免无工具链导致 CI 失败）。
  - 验证：desktop vitest **23 → 40** 全绿；`tsc --noEmit` 干净。

- [x] **B3 / C2 决策文档 + A5 验证手册** ✅ 已交付（2026-08-22）
  - `docs/decisions/B3-runtime-material-source.md`：runtime 物料来源三选一（A 外部下载脚本 /
    B CI 制品 / C 安装器 crate 注入），建议长期 C、落地 B、并立即把 `chrome.dll` 分片提交到 `runtime-parts/`。
  - `docs/decisions/C2-relay-credential-source.md`：client 的 llm/image/video/audio 桥凭据来源
    A 应用设置 / B 平台登录态 / C 宿主代理命令 / D 保持 NotSupported；建议 C 基于 A（凭据不进 iframe）。
  - `docs/verify-a5-client-plugin-e2e.md`：A5a（内置 notes 端到端）/ A5b（安装插件注册路径）
    手动验证清单，含前置环境与 `pnpm build:desktop` 命令；标注 B3/C2 限制。
  - 三者均为文档，不改源码；B3/C2 仍待产品/人拍板后方可落码。

- [x] **文档行号→符号引用** ✅ 已完成（QX-03 / G5）
  - `IMPLEMENTATION_PLAN.md` 与 `TODO.md` 前瞻性（非存档）节的 `file:行号` 引用已批量替换为符号名（`parse_manifest`、`registry.register`、`plugin_net_fetch`、`route_llm_chat`、`respond_plugin_action_bridge` 等）；存档节（「0. 核实结论」快照表、「核实关键证据」附录）保持原样不动。

---

## 建议执行顺序

> 2026-08-23：计划内全部任务与两个「可选」项（未实现 kind 产品化、文档行号校准）均已完成。
> TODO 清单至此全部闭环；后续为新需求驱动。

1. **#3、#4**（A5a/A5b 验证）：成本低、价值高，先证明已交付代码真通路。
2. **#1、#2**（B3/C2 决策）：需产品/人拍板。
3. **#5**（A3 最后一公里）：补全 client-action 真正执行。
4. **#6、#7**：CI 防回归 + 文档校准。

## 当前验证基线（已通过）

- **2026-08-23 更新（第二次，功能补全后）**：`cargo test --workspace` desktop bin **226 passed** /
  installer 30 passed 全绿；desktop vitest **50/50**（新增 5 个：storage.kv / fs.pick / system.notify
  路由 + ui.view 纯前端队列 ×2）；`tsc --noEmit` 干净。
  四个新能力经桌面壳 CDP 端到端实测通过（见「未实现 kind 的产品化」节）。
- **2026-08-23 更新**：本机已装 Rust 工具链（cargo 1.97.1），Rust 侧验证缺口已补齐：
  - `cargo check --workspace`：通过（31+6 个历史 warning，无新增错误）。
  - `cargo test --workspace`：desktop bin 218 passed / installer 30 passed 全绿。
  - 首次编译暴露并修复 3 处存量测试代码问题（均非生产代码缺陷）：
    `BridgeResponse` 缺 `#[derive(Debug)]`、`plugin_store/tests.rs` 两处
    `PluginStoreConfig` 字面量缺 C2 新增字段（补 `..Default::default()`）、
    `plugin_runner/tests.rs` 对 `ProcessTable::take` 三元组返回值的旧二元组解构；
    另修复 `route_video_generate_relay_forward_error_passthrough` 与
    `relay_with_retry`（502 重试 3 次）的 mock 单次应答不匹配——mock 改为可应答
    4 轮并断言恰 4 次转发，透传语义不被重试改写。
- `tsc --noEmit`（apps/desktop）：干净（含新增 `SettingsPanel` / `App` / `Sidebar` / `plugins-runtime` 改动）。
- `vitest run`（apps/desktop）：8/8 文件 45 测试全绿（含 C2 `plugins-runtime.spec.ts` 13；并修掉
  `clientActionBridge.spec.ts` 的 `vi.resetModules()` 跨文件泄漏导致 5 个 spec 的 `@` 别名解析失败）。
- `vitest run`（packages/plugin-sdk）：113/113 全绿（未改动）。
