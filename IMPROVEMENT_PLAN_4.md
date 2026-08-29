# 千匣台 改进计划（第四轮 · 阶段 L–O · 2026-08-25）

> 本文档是 `IMPROVEMENT_PLAN_3.md`（第三轮，阶段 I–K，QX-06~QX-09 全部验收通过）之后的**第四轮改进计划**。
> 撰写前对关键事实做了代码级核实（见「0. 核实结论」），并于本会话复跑全部基线。
> 方针不变：**停止追加基础设施，把已交付链路变成"每次提交都被真机检验的产品"，再用真实插件逼出生态。**
>
> 当前基线（2026-08-25 本会话复跑）：`cargo test --workspace` desktop bin **247 passed**（1 ignored）/ installer **30 passed** 全绿；
> vitest contract **37** / platform-contract **34** / plugin-sdk **150** / desktop **65** 全绿；
> `pnpm typecheck` 四包干净；`main` 与 `origin/main` 同步，无未推送提交。
>
> 工单池：QX-10 ~ QX-14 已登记 `docs/WORK_ORDERS.md`（第四轮工单节），**派发由产品本人执行**。
> 更新 feed 来源已拍板：**GitHub Releases**（2026-08-25），见阶段 L1。

---

## 0. 核实结论（撰写本计划的事实依据，全部经本轮读取/复跑确认）

| # | 事实 | 证据 |
|---|---|---|
| 1 | **更新链路只有「最后一段」**：installer 的 `Mode::Update` / `run_update`（等主进程退出 → 静默覆盖 → 重启 → 自删）存在且有参数解析单测；但应用侧 `check_update` / `download_update` **从未实现**——仅是 `src-tauri/Cargo.toml` 里一段 initial import 带入的注释；全仓 grep 无任何代码拉起 `updater.exe`，`generate_handler!` 无更新命令。即每个 Release 都是「死版」，用户永远拿不到更新 | installer `cli.rs` `Mode::Update`、`modes/mod.rs` `run_update`；`apps/desktop/src-tauri/Cargo.toml` 注释段；grep `check_update`/`download_update`/`updater.exe` 零实现命中 |
| 2 | Tauri 官方 updater 插件未接入（注释明确表示要摆脱它） | `src-tauri/Cargo.toml` 无 `tauri-plugin-updater`；`main.rs` 无对应 plugin 注册 |
| 3 | 安装器仅在**开发机**验证过「`--silent --target` 静默解压字节一致」；「干净机器安装 → 启动 → 内置插件可用」**无端到端记录**；A5 系列 CDP 验证全部使用 `tauri build` 直接产物，非安装器安装实例 | `TODO.md` B3 节；`docs/decisions/B3-runtime-material-source.md`；`docs/verify-a5-client-plugin-e2e.md` |
| 4 | 新克隆开发者的 runtimes 本地灌装**无文档化脚本**：populate 逻辑只存在于 `ci.yml` `publish-runtimes` 的 pwsh 步骤；`build-installer.mjs` 的错误提示指向「下载 Release bundle」或「读 ci.yml 复刻」；`docs/lfs-setup.md` 仅覆盖 LFS | `ci.yml` populate 步骤；`build-installer.mjs` 错误文案；`docs/lfs-setup.md` |
| 5 | `rust-tests` / nightly `desktop-e2e` 从未在真实 PR / 夜跑中被观察（K3 仍开着）；唯一真实 CI 运行是 tag `v0.0.1-test` 的 `publish-runtimes`（其 `needs` 只含 `quality`） | `ci.yml` 各 job `if`/`needs`；`IMPROVEMENT_PLAN_3.md` 核实 #12 与 K3 节 |
| 6 | 能力面 17 kind 中**真机实证仅 6.5 个**：`ui.view` / `storage.kv`(get/set) / `system.info` / `system.notify` / `llm.chat` / `clipboard.write` / `fs.pick`(仅声明守卫、对话框交互未测)。**`clipboard.read` 从未真机验证**（friction §9.5 明示未验证，QX-01 验收 CDP 清单不含；friction §8 的「✅」只是静态代码核对） | `plugins-runtime.ts` `invokeRuntime` 路由表；`capability.rs`；`docs/WORK_ORDERS.md` 各验收记录；`docs/g2-sdk-friction.md` §9 |
| 7 | `image.generate` / `image.edit` / `video.generate` / `audio.generate` 四 AI kind **零真机证据**；桥侧仅 `image.edit`/`video.generate` 有 mock 单测，`image.generate` 只有拒绝路径单测，`audio.generate` 无专属单测；`relay-adapter.mjs` 仅模拟 `llm.chat` | `plugin_llm_bridge.rs` tests；`client_ai_proxy.rs`；`scripts/relay-adapter.mjs` |
| 8 | `net.fetch` 的 SSRF 守卫 `extract_host`/`is_blocked_host` **零单测**、零真机 HTTP 请求证据 | `main.rs` `plugin_net_fetch`（所在文件无 `#[cfg(test)]` 模块） |
| 9 | `system.screenshot` 零单测零真机；且 `capability.rs` 注释声称前端转发前会先调 `requestSystemPermission`——**该符号全仓不存在**，实际无运行时权限门（注释失真）；同文件另一注释提到的「内置 file-explorer」在 `builtin-plugins/` 下也不存在 | `capability.rs` `system_screenshot` 及注释；grep `requestSystemPermission` 唯一命中即该注释 |
| 10 | `storage.kv` 的 `list`/`delete`/`count`（QX-07）**仅单测**，无真机往返证据；`delete` 落盘修正同样只有单测 | `docs/WORK_ORDERS.md` QX-07 验收记录（无 CDP 项） |
| 11 | clip-digest 的 kv `set` 失败会**静默兜底 localStorage**，掩盖配额耗尽——friction #5.3 给自家插件的修复建议一直未落实 | `packages/plugin-sdk/examples/clip-digest/ui/index.html` `storeValue` catch 分支 |
| 12 | 文档债集中：CODEBUDDY.md 5 处过时（runtime-lock 路径写错、「runtimes/ 为空且锁文件不存在」已不成立、「installer 未入 workspace」已不成立、内置插件清单漏 action-demo/action-caller、contract 模块数与名单停留在 QX-09 之前）；README 包表缺 `platform-contract`、「计划与状态」止于第二轮；**C2 ADR 仍标「待决 OPEN」、文末决策表全空**，但其方案（C-on-A）早已落地并被 QX-04b 真机验证 | 本轮文档抽查；`docs/decisions/C2-relay-credential-source.md` 文末 |
| 13 | 代码债极轻：1 个刻意推迟并留痕的硬隔离 TODO（`plugin_script.rs` 模块文档）；1 处过时注释（同文件称「group B venv/pnpm 持久化未落地」，实际已复用 `ensure_python_venv`/`ensure_node_dependencies`）；若干 `unused import` 编译警告 | `plugin_script.rs`；本会话 `cargo test` 警告清单 |
| 14 | 无未推送提交；`qx-03-doc-debt`（本地 + 远端）已全量并入 `main`，属可清理分支债；工作区唯一脏文件 `src-tauri/Cargo.toml` 为 LF/CRLF 行尾幻影（`git diff` 无内容差异） | `git log origin/main..HEAD` 空；`merge-base --is-ancestor` 确认 |

**由 #1–#3 引起的口径修正**：第三轮把「分发」做到「Release 有签名产物」为止；本轮核实发现**产物到用户之间仍缺两环**——应用内更新触发（#1/#2）与安装器干净机器实证（#3）。这两环不补，B3→C 的安装器投资不产生任何用户价值，故列为本轮最高优先。

---

## 阶段 L：分发与更新闭环（最高优先）→ 工单 QX-10 / QX-11

**目标**：让「Release 产物」变成「用户能装、能更新」的真实闭环。预期像前几轮真机验证一样暴露 1–2 个集成缺陷，暴露即修。

### L1 · 应用侧更新触发链路（核心，含一个小决策）→ QX-10

**背景**：核实 #1/#2。更新执行段（installer `run_update`）已存在，缺的是「检测 → 下载 → 验签 → 拉起」整条应用侧链路。

**范围（文件级）**：
1. **ADR**：新建 `docs/decisions/update-feed-source.md`——更新 feed 直接用 **GitHub Releases**（✅ 产品已拍板 2026-08-25；现有分发渠道，零服务器叙事不破；`.minisig` 签名复用 Org secret 信任根，与 runtime 制品同一原语 `verify_minisign`），备选「relay 托管 latest.json」记录解除条件。
2. **Rust 三命令**（`src-tauri`，新模块如 `update.rs`）：
   - `check_update`：查 feed latest 版本 → semver 比较 → 返回 `{version, setupUrl, sha256?, minisigUrl}`；
   - `download_update`：流式下载 Setup exe → sha256/minisign 硬校验（失败即删临时文件并拒绝）→ 落临时目录；
   - `apply_update`：拉起同目录 `updater.exe` 的 update 模式（`--target <安装目录> --setup <临时包> --wait-pid <自pid> --restart`），复用 QX-06 前已修的 `cli.rs` flag 解析路径。
3. **前端**：设置页（`SettingsPanel`）增「检查更新」入口与状态展示；v1 **手动触发**，不做后台静默下载。
4. **真机 e2e**：本地 update-feed 适配器（复用 `relay-adapter.mjs` 的环回零依赖模式）挂两个版本号 → 跑通「旧版检测 → 下载 → 验签 → 覆盖 → 重启 → 新版自报版本号」；负向对照：篡改包一字节 → 验签拒绝、不覆盖。
5. 单测：semver 比较、验签失败拒绝、apply 参数构造各 ≥1。

**验收标准**：ADR 存在；三命令 + UI 入口落地；真机 e2e 双向（成功闭环 + 篡改拒绝）记录进 verify 文档；三基线全绿；PR 含工单号 QX-10。

**依赖/风险**：无外部依赖。`updater.exe` 的 update 模式首次真实运行，预期暴露集成缺陷（如安装目录探测、进程等待边界）。

### L2 · 干净机器安装端到端实证 → QX-11

**范围**：harness（新 `scripts/e2e-install-verify.mjs` 或扩展现有）在**全新目标目录**（无 runtimes 缓存、隔离的用户数据目录）执行：Release/本机打包的 `QianXia-Setup-*.exe --silent --target` → 启动安装实例 → CDP 断言插件中心加载、内置 notes 打开、`storage.kv` 真落盘；并校验四个 runtime 的 keyFiles 在位（对齐 `verify-bundled-runtimes.mjs` 口径）。
**验收标准**：干净目标闭环记录进 `docs/verify-a5-client-plugin-e2e.md` 新增执行节；失败项如实标注；PR 含工单号。

### L3 · 新克隆开发者一键灌装 → QX-11（同工单）

**范围**：新 `scripts/populate-local-runtimes.mjs`——优先从最新 Release 下载 `runtimes-bundle.zip` + `.minisig` 验签后解压到 `apps/desktop/runtimes/`（失败回退打印 ci.yml populate 手工步骤指引）；`apps/desktop/package.json` 增 `runtime:populate`；`docs/lfs-setup.md` 补「新克隆 → 跑通桌面构建」完整顺序；README quickstart 同步校准。
**验收标准**：脚本 + 文档落地；本机模拟「runtimes 移走 → 重灌 → `runtime:verify` 通过」实证（操作前先备份现有 runtimes）。

---

## 阶段 M：能力面真机证据补齐 → 工单 QX-12

**目标**：把核实 #6–#10 里「(b) 仅单测 /（—）无证据」的 kind 补成真机实证或稳定单测；不新增任何能力 kind。

**范围**：
1. **e2e 断言扩展**（`e2e-desktop-smoke.mjs`）：`clipboard` writeText→readText 真机往返；`storage.kv` list/delete/count 真机往返 + **delete 后重启不复活**（QX-07 落盘修正的真机证明）；`net.fetch` 对环回 adapter 发真实 HTTP 请求断言 200 与响应体。
2. **守卫与缺口单测**：`extract_host`/`is_blocked_host` 补 SSRF 单测（环回/内网段/合法域名/畸形 URL）；`client_image_generate`/`client_audio_generate` 等无单测的 `client_*` 命令补 mock relay 单测。
3. **relay-adapter 扩展**：`scripts/relay-adapter.mjs` 增 image/video/audio 四路由的**协议级模拟**（确定性伪响应，非真实 provider）；`e2e-relay-verify.mjs` 增四 kind 断言（无凭据 exit 2 语义不变）。
4. **注释失真收口**：删 `capability.rs` 的 `requestSystemPermission` 虚假注释与 file-explorer 过时引用；`docs/plugin-development.md` 明示「声明即授权，桌面壳无运行时权限门」的全能力面统一语义。

**验收标准**：新增 e2e 断言真机全绿；新增单测计入基线；文档与代码注释一致；三基线全绿；PR 含工单号 QX-12。

**不做**：image/video/audio 的**真实 provider** 证明依赖平台 relay 实际就绪，列观察项不派发；`fs.pick` 原生对话框交互维持「留人工确认」。

---

## 阶段 N：生态第二狗粮波 → 工单 QX-13

**目标**：沿用 G2 打法，用第二个真实插件逼出未证明 kind 的手感问题；同时让 clip-digest 吃上自家新 API。

**范围**：
1. **第二个狗粮插件**（`packages/plugin-sdk/examples/` 新增，client 运行时）：候选题材二选一（实施第 1 步定）——
   - 「网页剪藏」：`clipboard.read` 读 URL → `net.fetch` 抓正文 → `llm.chat` 摘要 → `storage.kv` 存档 → `ui.view` 展示；
   - 「截图笔记」：`system.screenshot` 截图 → `storage.kv` 存元数据 → `ui.view` 回顾。
   走完整流程：create → validate → build → `dev` 热循环迭代 → 本地导入真机跑通；顺带覆盖 `clipboard.read` 这一从未真机验证的 kind（题材一）。
2. **第二轮摩擦记录**：续写 `docs/g2-sdk-friction.md`（新增条目 ≥3，重点：新 kind 的 SDK 手感、dev watch 防抖在真实迭代中的表现、net.fetch 的 SSRF 限制是否误伤合法场景）。
3. **clip-digest 自修**：kv `set` 失败不再静默兜底 localStorage——改用 QX-07 的 `list`/`delete`/`count` 实现 LRU 淘汰 + 配额错误提示用户；成为 storage 管理 API 的第一个真实消费者（含单测）。

**验收标准**：新插件真机跑通（CDP 证据）；摩擦记录新增 ≥3 条实证；clip-digest 修复有单测且真机复验；三基线全绿；PR 含工单号 QX-13。

**依赖**：无硬依赖；QX-12 的 e2e 断言模式可复用。

---

## 阶段 O：文档债与治理 → 工单 QX-14

**范围（纯文档/清理，小件打包）**：
1. **CODEBUDDY.md 五处过时修正**（核实 #12 逐条）；**README** 包表补 `platform-contract`、「计划与状态」接到第三轮并指向本文档。
2. **C2 ADR 回填**：`docs/decisions/C2-relay-credential-source.md` 决策记录表回填「已采纳 C-on-A（2026-08-22 拍板，QX-04b 真机验证）」，状态 OPEN → 已采纳。
3. **警告清零**：`cargo` 的 `unused import` 警告归零（不动 future-compat 类）；`plugin_script.rs` 的 group B 过时注释修正。
4. **分支清理（需用户确认后执行）**：删除本地与远端 `qx-03-doc-debt`（已全量并入 main，核实 #14）。

**验收标准**：grep 复核五处过时消除；C2 ADR 状态与事实一致；`cargo build` 无 unused-import 警告；纯文档/清理 diff，三基线不受影响；PR 含工单号 QX-14。

---

## 观察项与记录项（不派发）

- **K3 延续**：本轮 QX-10~QX-14 的 PR 将首次真实触发 `rust-tests` job——记录冷/热时长；nightly `desktop-e2e` 连续 3 晚绿视为稳定，漂移即修。
- **K4 重申**：QX-04b 的 DeepSeek API key 轮换（用户行动，第三轮已提醒，本轮再记一次）。
- **真实 provider 的 image/video/audio 证明**：依赖平台 relay 实际就绪；就绪前以 M3 的协议级模拟为证据上限。
- **维持触发条件不动**：K2/F4（CSP 收紧，下次实质改 `PluginRunner.tsx` 渲染路径时触发）、J5（静态插件免 tsx，记录不做）、`plugin_script.rs` 硬隔离 TODO（独立大任务，刻意推迟）。

## 工单注册（✅ 已登记 `docs/WORK_ORDERS.md` 第四轮工单节，派发由产品本人执行）

| 工单 | 内容 | 建议 Agent | 依赖 |
|---|---|---|---|
| QX-10 | L1 更新触发链路（ADR + 三命令 + UI + 真机 e2e 双向） | A | 无；最大件，含 feed 源小决策 |
| QX-11 | L2 干净机器安装 e2e + L3 一键灌装脚本/文档 | B | 无 |
| QX-12 | M 能力面真机证据 + SSRF/AI 单测 + relay-adapter 扩展 + 注释收口 | A 或 B | 无 |
| QX-13 | N 第二狗粮插件 + 二轮摩擦记录 + clip-digest 自修 | A | 无（QX-12 断言模式可复用） |
| QX-14 | O 文档校准包 + 警告清零 + 分支清理 | B | 无 |

## 建议执行顺序

1. **QX-14**（半小时级，先让文档说真话）与 **QX-11**（分发底线实证）先行，可并行；
2. **QX-10**（最大件，独占一个 Agent，ADR 待产品点头后动码）；
3. **QX-12 → QX-13**（证据补齐 → 新狗粮复用断言模式）；
4. K3/K4 随 PR 与用户行动自然推进。

## 附：关键证据索引（2026-08-25 核实）

- `apps/desktop/installer/src/cli.rs` `Mode::Update`、`modes/mod.rs` `run_update`：更新执行段已实现并单测；应用侧触发全缺（grep `check_update`/`updater.exe` 零实现命中，`src-tauri/Cargo.toml` 注释为唯一痕迹）。
- `apps/desktop/src-tauri/src/plugin_security.rs` `verify_minisign`：更新包验签可直接复用的原语。
- `apps/desktop/src-tauri/src/main.rs` `plugin_net_fetch`（`extract_host`/`is_blocked_host`）：SSRF 守卫零单测。
- `apps/desktop/src-tauri/src/capability.rs` `system_screenshot`：零测试 + `requestSystemPermission` 虚假注释。
- `apps/desktop/src-tauri/src/client_ai_proxy.rs`：五命令中 `image.generate`/`audio.generate` 无专属单测；`scripts/relay-adapter.mjs` 仅模拟 `llm.chat`。
- `scripts/e2e-desktop-smoke.mjs` / `e2e-relay-verify.mjs` / `e2e-actions-verify.mjs`：本轮 e2e 扩展的复用基座。
- `docs/g2-sdk-friction.md` §9：clipboard.read 未验证的原始记录；`ui/index.html` `storeValue`：静默兜底现场。
- `docs/decisions/C2-relay-credential-source.md` 文末：决策表全空（待回填）。
- 内置插件 5 个：`notes` / `calculator` / `game-2048` / `action-demo` / `action-caller`（`apps/desktop/builtin-plugins/`，`build.rs` 构建期自动打包）。
