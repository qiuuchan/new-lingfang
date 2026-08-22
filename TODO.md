# 灵坊工作台 — 后续任务清单

> 基于 `IMPLEMENTATION_PLAN.md` 三轮修订（A1–A4、B2、C1+C3、D1–D3 已交付）的执行结果梳理。
> 前序交付状态见 `IMPLEMENTATION_PLAN.md` 的「执行状况」节。

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
  - **CI minisign 密钥（🟡 本机已生成 2026-08-22 / ⏳ Org secret 待配）**：ed25519 密钥对已生成本机
    `.runtime-signing/`（gitignore，绝不入库），32-byte 公钥 base64 与交接步骤见 `docs/decisions/B3-runtime-material-source.md`
    「minisign 密钥交接」。团队注册 Org secret `LINGFANG_RUNTIME_PUBKEY`/`LINGFANG_RUNTIME_SIGKEY` 后，
    将 `publish-runtimes` 打包/签名/上传由 `continue-on-error` 改 hard 即闭 B 链路；随后启动 P2 安装器注入（C）。
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
  - 验证：`tsc --noEmit` 干净；desktop vitest 8/8 文件 45 测试全绿；Rust 侧因无工具链未 `cargo build`
    （逻辑已对齐命令名 / `AppState.registry` / `BridgeSession::new_transient`）。
  - 待实操（需 WebView2 + cargo build）：内置 notes 的 AI 摘要经设置凭据真正跑通。

## 二、验证（可立即做，需 `cargo build` + WebView2 起桌面壳）

- [ ] **A5a · 内置 notes 插件端到端验证**
  - 起桌面壳 → 打开内置 `notes`（client 运行时，声明 `storage.kv` + `llm.chat`）。
  - 确认：`sdk.storage.kv` / `sdk.llm.chat` 经网关返回 `NotSupported`（而非静默无应）；
    `read_plugin_file` 能解析内置插件目录；ui-tokens CSS 注入生效。

- [ ] **A5b · 安装插件注册路径验证**
  - `pnpm plugin:create` 生成 client 模板 → `pnpm plugin:build` → 安装运行。
  - 确认：A4 生效，安装插件调用能力不再 `NotDeclared`（A4 价值的直接证明）。

## 三、功能补全（需要写代码）

- [x] **A3 · client-action 注册表生产者** ✅ 已交付（2026-08-22）
  - 现状（交付前）：`clientActionBridge` 已监听 `plugin-action-bridge-call` 并回传，但**没有生产者**把
    `caller → action 源码/导出名` 填进 registry。且监听器取 `actionId` 的方式与 Rust 实际发出的
    `caller` 载荷不匹配——`caller`（`plugin_package_manager.rs:710`）只含调用方 `installation_id`、
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

- [ ] **未实现 kind 的产品化（超出本计划，可选）**
  - `ui.view` / `fs.pick` / `storage.kv` / `system.notify` / `plugin.upload` / `plugin.submitMarketplace`
    目前正确返回 `NotSupported`。若产品要落地，需各自后端实现，属新需求。

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

- [ ] **校准文档行号（可选，低价值）**
  - 「执行状况」节里 `plugin_runner.rs:126-139`、`:1532` 等为近似行号（随编辑浮动），内容准确；
    需要精确引用时可校准。

---

## 建议执行顺序

1. **#3、#4**（A5a/A5b 验证）：成本低、价值高，先证明已交付代码真通路。
2. **#1、#2**（B3/C2 决策）：需产品/人拍板。
3. **#5**（A3 最后一公里）：补全 client-action 真正执行。
4. **#6、#7**：CI 防回归 + 文档校准。

## 当前验证基线（已通过）

- `cargo check`（apps/desktop/src-tauri）：未在本环境跑（无 Rust 工具链）；C2 新增模块已人工核查跨模块引用一致。
- `tsc --noEmit`（apps/desktop）：干净（含新增 `SettingsPanel` / `App` / `Sidebar` / `plugins-runtime` 改动）。
- `vitest run`（apps/desktop）：8/8 文件 45 测试全绿（含 C2 `plugins-runtime.spec.ts` 13；并修掉
  `clientActionBridge.spec.ts` 的 `vi.resetModules()` 跨文件泄漏导致 5 个 spec 的 `@` 别名解析失败）。
- `vitest run`（packages/plugin-sdk）：113/113 全绿（未改动）。
