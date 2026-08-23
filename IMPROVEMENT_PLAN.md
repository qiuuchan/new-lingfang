# 灵坊工作台 改进计划(第二轮 · 基于代码核实 · 2026-08-23)

> 本文档是 `IMPLEMENTATION_PLAN.md`(第一轮,A–D 阶段)全部完成后的**第二轮改进计划**,
> 来源于 2026-08-23 的项目评审与改进方向讨论,撰写前对涉及的关键事实做了代码级核实(见「0. 核实结论」)。
> 方针一句话:**停止追加基础设施,把已交付链路变成"每次提交都被真机检验的产品",再用真实插件逼出生态。**
>
> 当前基线(2026-08-23):`cargo test --workspace` 218+30 全绿、desktop vitest 8 文件全绿、
> plugin-sdk vitest 113 全绿、`tsc --noEmit` 干净;本地领先 `origin/main` **7 个提交未推送**
> (含 `56a5c39` caps 产品化、`ba6861c` 文档回填)。

---

## 0. 核实结论(撰写本计划的事实依据,全部经本轮读取确认)

| # | 事实 | 证据 |
|---|---|---|
| 1 | caps 四 kind(`storage.kv`/`fs.pick`/`system.notify`/`ui.view`)**已提交**,非"在途" | `56a5c39`(14 文件 +1011 行):`client_host_caps.rs` 299 行、`uiViewHost.ts` 60 行、`UiViewHost.tsx` 51 行、`plugins-runtime.ts` 路由扩展;`ba6861c` 已回填 IMPLEMENTATION_PLAN/TODO |
| 2 | A5 runbook 的前瞻断言已过时:`client_storage_kv` 落地后,notes(声明了 `storage.kv`)的 kv set/get 会**真实成功**,不再是 `capability_not_supported` | `docs/verify-a5-client-plugin-e2e.md` 执行记录仍写"storage.kv 仍为 capability_not_supported"(存档准确、前瞻过时);`client_host_caps.rs` `client_storage_kv` 已注册(main.rs invoke_handler) |
| 3 | E2E 自动化的地基全部就位 | `@playwright/test@1.61.1` 已在 `apps/desktop/package.json` devDependencies;runbook 步骤完整(A5a 五断言);CI windows runner + `dtolnay/rust-toolchain@stable` 已被 `ci.yml` `publish-runtimes` job 验证可行 |
| 4 | Rust 测试(218+30)不在任何 PR 级防线内 | `ci.yml` `quality` job 仅 ubuntu-latest 跑 `pnpm typecheck`+`pnpm test`;Rust 仅在 tag 触发的 `publish-runtimes` 里 `cargo build`(无 test) |
| 5 | 签名/来源状态 UI **断链**(前端零消费方) | `apps/desktop/src/lib/plugin-provenance.ts`(67 行,6 种 sourceKind 中文标签)全仓无 import;`types.ts` `_meta.sourceKind/sourceLabel` 无 .tsx 读取;`verify_plugin_signature_command` 已注册(main.rs:493,`plugin_security.rs:6` 注明"signed=false 不阻断,仅状态展示")但前端无调用 |
| 6 | 插件 CLI 无 dev/watch 热循环 | `packages/plugin-sdk/src/cli/commands/` 仅 create/validate/build/publish 四命令 |
| 7 | 契约 **17** 个 re-export 模块中 7 个为平台云专属,桌面开发被拖着走(CODEBUDDY.md "~21 模块"的说法已过时) | `packages/contract/src/index.ts` 实数 17 个 `export *`;含 marketplace-discovery/marketplace-commerce/plugin-governance/web-plugin-center/admin-governance/rbac/billing |
| 8 | CSP 处于"为 iframe 打洞"的放松态 | `tauri.conf.json:58` `script-src 'self' 'unsafe-inline'` + `:59` `dangerousDisableAssetCspModification: true`(commit `18a9595` 为修 srcdoc iframe 内联脚本而设);`connect-src https://*:*` 宽松 |
| 9 | relay 凭据表单无格式校验 | `SettingsPanel.tsx`(120 行):仅 trim+空串转 null,`configured`=两字段非空,无 URL/token 格式校验 |
| 10 | 进程沙箱是**生命周期围栏,不是安全边界** | `process_util/sandbox.rs`(180 行)仅 Job Object:`KILL_ON_JOB_CLOSE`+`DIE_ON_UNHANDLED_EXCEPTION`+不设 `BREAKAWAY_OK`;无受限令牌/完整性级别/AppContainer;nodejs/python 插件进程持用户完整权限,SDK 层能力声明不约束进程直用 node 的 fs/net |

**由 #1 引起的计划口径修正**:原"第 0 步=落地在途改动"变更为"**推送已提交工作 + 复跑基线 + 核对 runbook 前瞻断言**"(见 E1)。

---

## 阶段 E:验证制度化(最高优先,先于一切功能)

**目标**:把 2026-08-23 那次一次性的人工 E2E 壮举(`window.__TAURI__` 缺失等 4 个集成缺陷只有它抓得到)变成制度;Rust 测试进入 PR 防线。

### E1. 推送领先提交 + 基线复跑 + runbook 断言核对(0.5 天)
- 推送前全量基线:`pnpm typecheck`、`pnpm test`(desktop vitest 数量较 TODO 记录的 45 可能已因 caps spec +65 行而增长,以实际为准)、`cargo test --workspace`。
- 推送 7 个本地提交至 `origin/main`。
- 核对 `docs/verify-a5-client-plugin-e2e.md`:执行记录保持存档不动;顶部追加一段"caps 落地后的当前预期"(storage.kv 真实成功、`fs.pick`/`system.notify`/`ui.view` 可用、错误码表对齐 `plugins-runtime.ts` 的 8 个 code)。
- 验证:CI `quality` job 绿;`git status` 干净;runbook 顶部含当前预期段。

### E2. E2E 冒烟自动化脚本(1–2 天,文件级)
- 新建 `scripts/e2e-desktop-smoke.mjs`(Node,复用 `@playwright/test` 的 chromium 连接能力),流程照搬 runbook A5a:
  1. 构建:`pnpm -C apps/desktop exec tauri build --no-bundle --debug`(支持环境变量跳过构建复用产物,便于迭代);
  2. 启动:spawn 产物 exe,env `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>`;
  3. 连接:Playwright `connectOverCDP` → 等待插件中心加载 → 打开内置 notes;
  4. 断言(与 A5a 对齐、按 caps 后现状更新):
     - iframe 渲染(`sandbox="allow-scripts"`、opaque origin),无脚本错误;
     - `window.sdk` 已定义;ui-tokens CSS 已注入(查 `--lf-color-primary`);
     - **`storage.kv` set/get 真实成功**(caps 后新预期,顺带验证 kv 落盘);
     - 未声明 kind(如 `system.info`)reject `capability_not_declared`;
     - `llm.chat` reject `relay_not_configured`(凭据未配置时的正确表现);
  5. 任一断言失败→非零退出码;finally 阶段杀进程树(复用 Job Object 语义之外的兜底 kill)。
- `apps/desktop/package.json` 增 `"test:e2e": "node ../../scripts/e2e-desktop-smoke.mjs"`(**不**加入 `pnpm test` 递归——需构建产物与 WebView2,仅本机/手动触发)。
- A5b(安装插件注册路径)作为脚本可选第二档(`--with-install` 参数),v1 可先不做。
- 验证:本机一晚全绿;故意破坏(临时改坏 `api.ts` 的 internals 回退)能红;脚本自带超时防挂起。

### E3. cargo 测试进 PR 级 CI(0.5 天)
- `.github/workflows/ci.yml` 新增 job `rust-tests`(与 `quality` 并行):
  - `runs-on: windows-latest`(Tauri 壳绑 Windows 依赖,ubuntu 跑不了);
  - `dtolnay/rust-toolchain@stable` + `Swatinem/rust-cache@v2`;
  - 前置 `pnpm -C apps/desktop vite:build`(generate_context! 需 `../dist` 存在,publish-runtimes 已验证此顺序);
  - `cargo test --workspace`(debug,不 --release)。
- 触发:push/PR 全分支,与现有 `on:` 块一致,无需改触发条件。
- 验证:PR 上绿;临时改坏一个 Rust 断言能红;job 时长记录在案(预期 10–20 分钟,含缓存冷热两档)。

### E4. E2E 进 CI 的触发策略(0.5 天)
- `ci.yml` 增 `on: workflow_dispatch` + `schedule`(nightly,cron 表达式按维护者时区);E2 脚本包装为独立 job `desktop-e2e`(windows-latest,依赖 rust-tests 结果可选用 `needs`)。
- **不**进 PR 防线:debug 构建约 10 分钟级,对每次 PR 太重;nightly+手动已足够防"测试绿但真机挂"的漂移。
- 验证:手动 dispatch 一次全绿;nightly 首周观察稳定性(WebView2 runner 环境差异)。

---

## 阶段 F:安全对齐(可与阶段 E 并行)

**目标**:安全叙事与安全现实一致;已拍板政策落地;补上"写好但没人用"的签名/来源 UI。

### F1. CODEBUDDY.md 安全章节如实重写(0.5 天)
- 按**三档边界**重写 Security model 节:
  1. client iframe = **真边界**(opaque origin + 无 `allow-same-origin`,插件 JS 关在沙箱框架内);
  2. Job Object = **进程树围栏/清理机制**(KILL_ON_JOB_CLOSE;防泄漏不防越权);
  3. nodejs/python 插件 = **安装时信任 + SDK 层约束**:能力网关只约束"经 SDK/桥的调用",恶意进程可绕过 SDK 直用运行时自身能力,真实防线是 minisign 验签与来源信任。
- 删除/改写 Overview 中"capability enforcement... happen through Tauri commands"的过度声明(对进程插件不成立)。
- 验证:逐条与 `sandbox.rs`/`capability.rs`/`plugin_security.rs` 现状对照,不引入新的未核实断言。

### F2. 政策落地:v1 第三方插件仅限 client 运行时(已拍板采纳 ✅)
- **依据**:client 边界真实存在(#10);进程沙箱非安全边界(#10);插件签名信任根未建(当前仅 runtime 制品有 Org secret minisign 信任根,`.lfplugin` 生态侧无)。
- **落点**:
  - 安装路径:`plugin_package_manager` 对 `origin=local` 导入且 `runtime_type ∈ {nodejs, python}` 的插件,安装时明确拒绝(错误信息指向政策文档);内置插件与一方签名插件不受限。补单测(拒绝+放行两侧)。
  - 文档:CODEBUDDY.md Security 节 + `packages/plugin-sdk/README.md` + `docs/plugin-development.md` 标注该政策与解除条件(市场签名信任根建立)。
  - 契约层不动:`RuntimeType` 枚举保留 nodejs/python,政策是桌面壳安装期的约束,不是契约删除。
- 验证:local 导入 nodejs 插件被拒的单测;client 插件导入不受影响的既有测试保持绿。

### F3. 来源/签名状态 UI(1–2 天,补消费方而非新建)
- 已有零件:`plugin-provenance.ts`(`normalizePluginProvenance` + 6 种 sourceKind 中文标签,零消费者)、`_meta.sourceKind/sourceLabel`(types.ts,未被读取)、`verify_plugin_signature_command`(已注册,语义"仅状态展示")。
- 落点:
  - `PluginCenterBody.tsx` 已安装列表项:读取 `_meta` 并经 `normalizePluginProvenance` 渲染来源徽标("本地导入"/"未知来源"等;绝对路径已被 sanitize 清空,不泄露磁盘信息);
  - 插件详情或首次运行前(`PluginRunner` 加载路径):调 `verify_plugin_signature_command` 取验签状态,未签名/验签失败显示琥珀色"未签名插件"提示(**不阻断**,与 `plugin_security.rs:6` 注释语义一致);
  - origin=local 且未签名 → 提示升级为显式警示样式。
- 验证:vitest(徽标渲染、未签名提示、sanitize 后的空 label 回退)+ 真机抽查一个 local 导入插件。

### F4. CSP 收紧路径(技术债记录,本轮不执行)
- 方向:插件 HTML 从 `srcdoc` 迁移到自定义协议(Tauri asset protocol / 自定义 scheme)加载,使宿主页 `script-src` 可移除 `'unsafe-inline'` 并恢复 assetCspModification;同时评估 `connect-src https://*:*` 收窄到 relay 域 + 用户配置域。
- 触发条件:下次实质性改动 `PluginRunner.tsx` 渲染路径时一并做;届时先在 `docs/decisions/` 落一页方案。
- 本轮仅本条记录,不写代码。

### F5. SettingsPanel 凭据校验(0.5 天,小项)
- `api_base`:非空时必须为合法 `https://` URL(非法则禁用保存并红字提示;空=清除配置,维持现状语义);
- `auth_token`:仅做非空回显与前缀提示(不猜格式、不阻断)。
- 验证:vitest(合法/非法/空三态)。

---

## 阶段 G:产品证明与生态破零(任务级)

### G1. C2 待实操闭环:notes AI 摘要经真实凭据跑通
- 设置页录入真实 relay 凭据(`SettingsPanel` → `set_relay_settings`)→ 打开 notes → AI 摘要经 `client_llm_chat` → relay 真实返回。
- 产出:`docs/verify-a5-client-plugin-e2e.md` 新增执行记录节(或独立 verify 文档)+ 关键截图。
- 意义:全项目第一个"产品级证明"——目前所有验证都止步于 `relay_not_configured`。

### G2. 吃狗粮插件:「剪藏摘要」
- 一个真实可用的 client 插件,能力面刻意覆盖 `clipboard` + `storage.kv` + `llm.chat` + `ui.view`(新落地 kind 中的三个 + AI 桥)。
- 放 `packages/plugin-sdk/examples/`(或独立目录);发布流程走 `plugin:create` → `plugin:build` → 本地导入,顺带验证 F3 的来源徽标与未签名警示。
- 伴随产出:一份「SDK 使用摩擦记录」(错误码可读性、30s/180s 超时是否合理、kv 单值 256KB 限额是否够用等),作为后续 API 调整的唯一输入源。

### G3. `lingfang-plugin dev` 热循环(分两步)
- **v1 目录直读安装**:CLI 新 `dev` 命令把插件目录注册为 dev 安装(`origin='dev'`),`plugin_package_manager` 支持从目录直读(免打包 `.lfplugin`),宿主内手动重开插件即刷新;
- **v2 watch + 自动重载**:文件 watch → 触发宿主刷新 iframe(client 插件)或重启进程(nodejs/python)。
- 这是吸引第一批插件作者的最大杠杆:当前迭代循环是 build→安装→重开,摩擦过大。

### G4. README.md(仓库门面,当前缺失)
- 一屏内容:项目定位(**零服务器=本仓库无后端**;AI 能力经用户配置的平台 relay,桌面壳是客户端而非"无云")、quickstart(`pnpm install` → `dev:desktop`)、架构地图(指向 CODEBUDDY.md)、仓库名 `my-treasure` 与产品名"灵坊工作台"的关系一句话。

### G5. 文档行号 → 符号引用
- 将 IMPLEMENTATION_PLAN.md / TODO.md 中前瞻性(非存档)的 `file.rs:123` 引用批量替换为符号名(`parse_manifest`、`registry.register` 等),并删除 TODO「校准文档行号」条目;存档节保持原样。

---

## 阶段 H:还债 backlog(不排期,触发才做)

- **H1. 契约瘦身**:平台云专属模块(marketplace-discovery/marketplace-commerce/plugin-governance/web-plugin-center/admin-governance/rbac/billing)标注归属注释或拆出 `@lingfang/platform-contract` 包,让桌面开发的"单一权威来源"不再拖拽用不到的形状。
- **H2. Windows-only ADR**:`docs/decisions/platform-windows-only.md`——一段话决策(v1 就是 Windows)+ 移植最硬骨头清单(Job Object 沙箱、SFX 安装器、WebView2、rc.exe)。
- **H3. 重申不做**(维持现状即可):`plugin.upload`/`plugin.submitMarketplace` 保持网关 NotSupported;不建市场/计费/审核流基础设施;不扩能力面直到真实插件提出需求;不仓促上 mac/Linux(先有 H2 的 ADR)。

---

## 执行状况(回填位)

| 阶段 | 内容 | 状态 |
|---|---|---|
| E1 | 推送 7 提交 + 基线复跑 + runbook 当前预期段 | ⬜ |
| E2 | `scripts/e2e-desktop-smoke.mjs` + `test:e2e` | ⬜ |
| E3 | ci.yml `rust-tests` job | ⬜ |
| E4 | E2E 进 CI(workflow_dispatch + nightly) | ⬜ |
| F1 | CODEBUDDY.md 安全章节三档边界重写 | ⬜ |
| F2 | v1 第三方仅 client 政策落地(安装拒绝 + 文档) | ⬜ |
| F3 | 来源徽标 + 验签状态 UI | ⬜ |
| F4 | CSP 收紧路径(记录,不执行) | 已记录于本文 ⬜ 触发待定 |
| F5 | SettingsPanel 凭据校验 | ⬜ |
| G1 | notes AI 摘要真实凭据实操 | ⬜ |
| G2 | 剪藏摘要狗粮插件 + 摩擦记录 | ⬜ |
| G3 | `lingfang-plugin dev`(v1 直读 → v2 watch) | ⬜ |
| G4 | README.md | ⬜ |
| G5 | 行号→符号引用 | ⬜ |

## 建议执行顺序

1. **E1 → E3 → E2 → E4**(先把防回归立起来:推送半小时、cargo CI 半天、E2E 脚本一两天);
2. **F1 + F2 并行**(纯文档+政策+一处安装拒绝,约 1 天);
3. **G1 → G4 → G3-v1 → G2**(产品证明优先:AI 实操半天、README 半天、dev 直读、狗粮插件收尾);
4. F3/F5 择机穿插;F4、H 不排期,按触发条件启动。

## 附:本计划的关键证据索引(2026-08-23 核实)

- 提交:`56a5c39`(caps 产品化,14 文件 +1011 行)、`ba6861c`(IMPLEMENTATION_PLAN/TODO 回填);`origin/main..HEAD` 共 7 提交。
- `apps/desktop/src-tauri/src/client_host_caps.rs`:`require_capability` 查 `registry.find`(L23-32)、kv 限额(单值 256KB/1024 条/key 256B/整文件 8MB,L37-43)、原子写 tmp+rename(L78-86)、三命令 `client_storage_kv`/`client_fs_pick`(tauri_plugin_dialog,spawn_blocking)/`client_system_notify`(tauri_plugin_notification),文件含 8 单测。
- `apps/desktop/src/lib/plugins-runtime.ts`(105 行):`invokeRuntime` 路由表(L62-104)——net.fetch→`plugin_net_fetch`、5 AI kind→`client_*`、storage.kv/fs.pick/system.notify→`client_host_caps` 三命令、ui.view→`enqueueUiView`(零命令)、其余→同步网关;错误归一化 8 个 code(L27-35,按中文文案 substring 匹配)。
- `apps/desktop/src/lib/plugin-provenance.ts`(67 行):全仓零消费者;`_meta.sourceKind/sourceLabel`(types.ts L58-64)无 UI 读取。
- `apps/desktop/src-tauri/src/plugin_security.rs`:minisign 验签(L50)+召回检查;`verify_plugin_signature_command` 已注册(main.rs:493);注释 L6"signed=false 不阻断,仅状态展示"。
- `apps/desktop/src-tauri/src/process_util/sandbox.rs`(180 行):仅 `KILL_ON_JOB_CLOSE`+`DIE_ON_UNHANDLED_EXCEPTION`+不设 `BREAKAWAY_OK`,无令牌/完整性级别——进程树围栏。
- `apps/desktop/src-tauri/tauri.conf.json:58-59`:`script-src 'unsafe-inline'` + `dangerousDisableAssetCspModification: true`;`connect-src https://*:*`。
- `.github/workflows/ci.yml`:`quality`(ubuntu,typecheck+test)/`publish-runtimes`(windows,tag v*,含 `cargo build --release` + SFX + minisign + Release 上传,已验证 windows rust 工具链可用)。
- `docs/verify-a5-client-plugin-e2e.md`(77 行):A5a/A5b runbook + 2026-08-23 执行记录(4 个集成缺陷清单);执行记录中 storage.kv 预期已过时(见核实结论 #2)。
- `packages/plugin-sdk/src/cli/commands/`:create/validate/build/publish 四命令,无 dev。
- `packages/contract/src/index.ts`:17 个 re-export 模块(实测 grep 计数),含 7 个平台云专属。
- `apps/desktop/package.json:48`:`@playwright/test 1.61.1`(devDependencies,E2E 无新依赖)。
