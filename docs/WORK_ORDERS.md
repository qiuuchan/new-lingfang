# 灵坊工作台 — 工单池

> 派发人：产品（用户）｜验收人：AI 验收（opencode）
> 依据 `IMPROVEMENT_PLAN.md` 阶段 G/H 未完成项。每张工单含验收标准，全部达成才算交付。
> 约定：验收基线 = `cargo test --workspace`（desktop + installer）、`pnpm typecheck`、`pnpm test` 全绿；
> 改动须提交到独立分支、PR 描述引用工单号；未经验收不得合并 main。

---

## LF-01（建议派 Agent A）· G2 剪藏摘要狗粮插件 + SDK 摩擦记录

**目标**：交付第一个真实可用的 client 插件「剪藏摘要」，能力面刻意覆盖 4 个 kind：
`clipboard` + `storage.kv` + `llm.chat` + `ui.view`（新落地 kind 中的三个 + AI 桥），
并产出一份 SDK 使用摩擦记录作为后续 API 调整的唯一输入源。

**范围**：
1. 插件源码放 `packages/plugin-sdk/examples/clip-digest/`（目录不存在则新建，需同步 SDK 脚本/文档索引）。
2. 走正式流程产出制品：`lingfang-plugin create`（client 模板）→ `validate` → `build` → `.lfplugin` v4。
3. 本地导入安装进桌面壳：验证 F3 来源徽标（origin=local）与未签名警示正常展示。
4. 插件功能：剪藏文本（clipboard 读）→ 存 storage.kv → llm.chat 摘要（凭据缺失时优雅降级
   `relay_not_configured` 文案，不白屏不抛错）→ ui.view 弹层展示摘要。
5. 产出 `docs/g2-sdk-friction.md`：逐项记录摩擦点（错误码可读性、30s/180s 超时是否合理、
   kv 单值 256KB/条目 1024 限额是否够用、SDK 文档缺口、dev 循环摩擦等），
   每条注明「现象 / 复现 / 建议」；无摩擦的项也显式确认「无问题」。

**验收标准**：
- [ ] `lingfang-plugin validate` + `build` 对示例插件干净通过，产物可被桌面壳本地导入并运行
- [ ] 4 个声明的能力在插件内真实被调用且语义正确（llm.chat 无凭据时优雅降级）
- [ ] `pnpm typecheck`、`pnpm test` 全绿（新增测试覆盖插件逻辑）
- [ ] 摩擦记录文档存在且 ≥5 条实证条目（每条含现象/复现/建议）
- [ ] PR 含工单号，说明验证过程

**依赖**：无。桌面端完整实操需 WebView2 + cargo build（可用 `scripts/e2e-desktop-smoke.mjs` 思路驱动）；
若本环境不可跑完整桌面闭环，须明确列出「未验证项」供验收复核。

---

## LF-02（建议派 Agent B）· G3 `lingfang-plugin dev` 热循环

**目标**：消灭插件作者「build→安装→重开」的高摩擦循环。两步：
- **v1 目录直读安装**：CLI 新增 `dev` 命令，把插件目录注册为 dev 安装（`origin='dev'`），
  `plugin_package_manager` 支持从目录直读（免打包 `.lfplugin`），宿主内手动重开插件即刷新；
- **v2 watch + 自动重载**：文件 watch → 触发宿主刷新 iframe（client 插件）或重启进程（nodejs/python）。

**范围**：
1. `packages/plugin-sdk/src/cli/commands/` 新增 `dev.ts`（参照现有 create/validate/build 风格）。
2. Rust 侧：安装账本支持 `origin='dev'`；目录直读路径（无需 zip 解包）；dev 安装的声明/能力注册
   与既有 `load_installed_plugin` 路径对齐（能力注册幂等）。
3. v2：watch 文件变更 → 宿主刷新机制（client 经 iframe 重载；进程型按既有 ProcessTable 重启路径）。
4. 文档：更新 `docs/plugin-development.md` 与 `CODEBUDDY.md` 的 CLI 命令清单。
5. 单测：dev 注册/直读/刷新触发各 ≥1 条；相关 rust + vitest 不回归。

**验收标准**：
- [ ] `lingfang-plugin dev <dir>` 注册后，宿主可不经打包直接打开该插件（client 运行时）
- [ ] v2：改文件后 client 插件 iframe 自动刷新（有自动化证据，单测或 E2E 均可）
- [ ] `cargo test --workspace`、`pnpm typecheck`、`pnpm test` 全绿
- [ ] dev 安装不破坏既有安装账本/迁移逻辑（grandfathered 路径不受影响）
- [ ] PR 含工单号，说明验证过程

**依赖**：无。注：`origin='dev'` 需与 F2 政策（Local 来源仅 client）语义不冲突——dev 属本地导入，
按 v1 政策应同样限制 client 运行时（nodejs/python dev 安装需在工单内说明处理策略）。

---

## LF-03（第二轮派发，建议 Agent A 完成 LF-01 后接）· 文档还债组（G5 + H2 + H3 + F4）

**目标**：纯文档，零代码改动。
- **G5**：将 `IMPLEMENTATION_PLAN.md` / `TODO.md` 中**前瞻性（非存档）**的 `file.rs:123` 行号引用
  批量替换为符号名（`parse_manifest`、`registry.register` 等）；删除 TODO「校准文档行号」条目；
  存档节（附录历史快照）保持原样不动。
- **H2**：新建 `docs/decisions/platform-windows-only.md` —— 一段话决策（v1 就是 Windows）
  + 移植最硬骨头清单（Job Object 沙箱、SFX 安装器、WebView2、rc.exe）。
- **H3**：在 IMPROVEMENT_PLAN.md 阶段 H 落地「重申不做」记录（plugin.upload/submitMarketplace 保持
  NotSupported；不建市场/计费/审核流；不扩能力面直到真实插件需求；不仓促上 mac/Linux）。
- **F4**：CSP 收紧路径已记录于 IMPROVEMENT_PLAN（F4 节），核对内容完整即可。

**验收标准**：
- [ ] grep 审计：两文档前瞻节无残留活性 `\w+\.(rs|ts|tsx|mjs):\d+` 行号引用（存档节除外）
- [ ] `docs/decisions/platform-windows-only.md` 存在且含决策+硬骨头清单
- [ ] 无任何代码/测试改动；`pnpm typecheck` 与测试结果不受影响（仅文档 diff）
- [ ] PR 含工单号

**依赖**：无。

---

## LF-04（需用户介入，暂缓派发）· G1 notes AI 摘要真实凭据实操

**目标**：全项目第一个「产品级证明」——设置页录入**真实 relay 凭据** → 打开内置 notes →
AI 摘要经 `client_llm_chat` → relay 真实返回。

**前置（可先由 Agent 做，记为 LF-04a）**：
- 准备自动化工单：以环境变量注入凭据（不经仓库），驱动桌面壳走 `SettingsPanel` 保存路径，
  断言 notes AI 摘要真实返回；凭据缺失时脚本应明确提示而非假阳性。

**阻塞项（需你本人提供）**：
- 真实 relay `api_base` + token（或确认可用测试凭据）。凭据到手后派发 LF-04b：Agent 跑通闭环 +
  产出 `docs/verify-a5-client-plugin-e2e.md` 新增执行记录节 + 截图。

**验收标准（LF-04b）**：
- [ ] notes AI 摘要返回真实 LLM 输出（非 mock、非 relay_not_configured）
- [ ] 凭据仅存在于用户环境/设置页，不进仓库、不进日志
- [ ] verify 文档新增执行记录节，含截图与失败项如实标注

**依赖**：真实 relay 凭据（你提供）。

---

## LF-05（2026-08-25 派发）· SDK 摩擦修复轮（g2-sdk-friction 驱动，Agent 自选）

**目标**：以 `docs/g2-sdk-friction.md` 为唯一输入源，修复高价值低风险摩擦项：
- **#1 错误码统一**：npm SDK `pluginAiError` 归一 `relay_not_configured` / `relay_error`
  为稳定 `code`（含裸字符串 reject 形态）；导出 `PluginAiErrorCode` 常量。
- **#5 前半**：Rust kv 配额错误码 `kv_value_too_large` / `kv_quota_exceeded`；
  宿主 `normalizeCapabilityError` 增两码并置于泛化「超出」匹配之前（原会被
  `capability_out_of_scope` 吞掉）。
- **#2 CLI 路径防双拼**：`resolvePluginPath`（绝对原样 / cwd 优先 / 工作区根兜底），
  validate / build / dev / publish 接入。
- **#6 文档**：plugin-development.md 增错误处理与降级、ui.view content 契约、
  超时语义、kv 限额、CLI 命令形态。
- 狗粮插件 clip-digest 降级判定改 code-first（message 前缀兜底）。

**验收标准**：plugin-sdk / desktop / contract vitest 全绿；`cargo test --workspace` 全绿；
typecheck 干净；CLI 双路径形态（包内短路径 + 仓库根相对路径）实操通过。

---

## LF-06（建议派 Agent A）· action 桥真机闭环 + SettingsPanel 旅程补测（第三轮阶段 I）

**依据**：`IMPROVEMENT_PLAN_3.md` 阶段 I（核实结论 #1–#5、#11）。

**目标**：把最后一条「代码已交付但真机未证」的链路（client-action 桥）跑成真机闭环；补测 LF-04b
绕过设置页的偏差。

**范围**：
1. `docs/decisions/action-caller-path.md`：v1 下 action 调用方仅限进程插件（内置/一方签名）；
   client 经网关调 `actions.call` 保持 NotSupported 并记录理由与解除条件。
2. 内置 fixture 对（build.rs 自动打包，零索引维护）：`builtin-plugins/action-demo/`（client，
   声明 `demo.hello` action，client handler）+ `builtin-plugins/action-caller/`（nodejs，启动后
   裸 fetch 直连桥调 `/actions/call`，结果写 `result.json` 供断言）。
3. harness：`scripts/e2e-actions-verify.mjs`（复用 CDP 惯例），打开 demo → 启动 caller →
   轮询 `result.json` 断言真实执行结果；反向对照 `action_dependency_unresolved`。
4. SettingsPanel 旅程：CDP 驱动设置页录真实/适配器 relay 凭据 → notes `llm.chat` 真实返回；
   断言凭据零日志泄漏；回填 `docs/verify-a5-client-plugin-e2e.md`。

**验收标准**：
- [x] 决策记录存在，含依据与解除条件（`docs/decisions/action-caller-path.md`）
- [x] 真机闭环：caller `result.json` 含真实执行结果（非 `action_dependency_unresolved`）；反向对照稳定码
      —— `scripts/e2e-actions-verify.mjs` 真机跑通：`{"ok":true,"result":{"greeting":"hello lingfang"}}`
- [x] SettingsPanel 用户旅程真机跑通；凭据零日志泄漏；runbook 记录更新（见 `docs/verify-a5-client-plugin-e2e.md` I1 记录）
- [x] `cargo test --workspace`、`pnpm typecheck`、`pnpm test` 全绿（新增 2 条 bridge 单测计入）
- [ ] PR 含工单号，说明验证过程

**依赖**：本机 runtimes 物料 + WebView2 + cargo build（前几轮已具备）；实现第 1 步核对
`plugin-action.ts` 的 action 依赖声明形状。

> **执行记录（2026-08-25）**：第三轮阶段 I 全部达成。关键修复：
> - `register_action_session` 死代码缺陷 → 新增 `start_builtin_action_invocation` 武装会话；
> - client-action 沙箱执行：blob:/data: 动态 import 与 `new AsyncFunction`(eval) 均被 opaque-origin
>   sandbox CSP（`script-src 'self' 'unsafe-inline'`，无 `unsafe-eval`）拦截 → 改为**内联 `<script type="module">`**
>   写入经宿主预转换（剥离 export、收集 `__exports`）的 handler 源码，CSP 允许且无需 eval；
> - 内置安装 `dependency_status` 标记 `Ready` + builtin 直接激活，解除 `action_dependency_denied`；
> - 新增 `route_action_call_denied_without_action_invocation` / `_without_action_context` 两单测。
> 分支 `feat/lf-06-action-bridge`，待提 PR 引用 LF-06。

---

## LF-07（建议派 Agent A 完成 LF-06 后接）· storage 管理 API（friction #5 后半）

**依据**：`IMPROVEMENT_PLAN_3.md` 阶段 J1（核实 #6）。

**范围**：
1. `client_host_caps.rs` `kv_apply` 增 `list`（prefix 过滤，仅键名）/ `delete`（不存在返回
   `{deleted:false}`）/ `count` 三 op；**持久化修正**：`delete` 纳入落盘条件（现仅 set）。
2. `index.ts` `sdk.storage` 增 `list(prefix?)` / `delete(key)` / `count()`。
3. 单测：Rust 每 op ≥1（含 delete 落盘往返）；plugin-sdk 路由 ≥3。
4. 文档：`docs/plugin-development.md` storage.kv 节补管理 API 与淘汰范式。

**验收标准**：三 op 全栈可用；`delete` 后重启应用不复活；文档更新；三基线全绿；PR 含工单号。

**依赖**：无。

---

## LF-08（建议派 Agent B）· 小件打包：timeoutMs + CLI --quiet + dev 防抖（friction #4/#3 + LF-02-R 加固）

**依据**：`IMPROVEMENT_PLAN_3.md` 阶段 J2/J3/J4（核实 #7/#8/#9）。

**范围**：
1. `index.ts`：AI 四输入型增 `timeoutMs?: number`；`invokeAi` clamp `[1000, 180_000]` 透传。
2. CLI：validate/build/publish/dev 增 `--quiet`（每行一条 code）；build 错误 shape 与 validate 对齐。
3. `plugin_runner.rs` watch client 分支加 300ms 节流（`Arc<Mutex<Option<Instant>>>`）。
4. 单测：clamp 上下界/透传、`--quiet` 输出形状、防抖语义各 ≥1。
5. 文档：plugin-development.md 超时节补调用级覆盖。

**验收标准**：三处小件落地且单测覆盖；三基线全绿；PR 含工单号。

**依赖**：无。

---

## LF-09（建议派 Agent B）· 契约瘦身（H1，本轮执行）

**依据**：`IMPROVEMENT_PLAN_3.md` 阶段 K1（核实 #10）。

**范围**：新建 `packages/platform-contract/`，移入 7 个平台云专属模块（marketplace-discovery /
marketplace-commerce / plugin-governance / web-plugin-center / admin-governance / rbac / billing）；
`@lingfang/contract` 移除对应 re-export；grep 确认桌面/plugin-sdk 零残留 import。

**验收标准**：7 模块迁出且 `@lingfang/contract` 只留桌面闭环形状；三包 typecheck + vitest 全绿；
grep 零残留；PR 含工单号。

**依赖**：无。

---

## 第四轮工单（2026-08-25 登记）

> 依据 `IMPROVEMENT_PLAN_4.md`（阶段 L–O，核实结论 #1–#14）。派发由产品本人执行；
> 纪律不变：独立分支 + 验收后合 main，PR 描述引用工单号。

## LF-10 · 应用侧更新触发链路（阶段 L1，最大件）

**目标**：补齐「检测 → 下载 → 验签 → 拉起 `updater.exe`」的应用侧链路——installer 的 `run_update`
（等退出→覆盖→重启→自删）早已实现，但没有任何代码拉起它，每个 Release 都是「死版」。

**范围**：
1. `docs/decisions/update-feed-source.md`：feed = **GitHub Releases**（✅ 产品已拍板 2026-08-25）；
   验签复用 `plugin_security.rs` `verify_minisign`（与 runtime 制品同一 Org secret 信任根）；
   备选「relay 托管 latest.json」记录解除条件。
2. Rust 新模块（如 `update.rs`）三命令：`check_update`（查 feed latest + semver 比较）、
   `download_update`（流式下载 → sha256/minisign 硬校验，失败即删临时文件并拒绝）、
   `apply_update`（拉起同目录 `updater.exe` update 模式：`--target/--setup/--wait-pid/--restart`）。
3. `SettingsPanel` 增「检查更新」入口与状态展示；v1 手动触发，不做后台静默下载。
4. 真机 e2e：本地 update-feed 环回适配器（复用 `relay-adapter.mjs` 零依赖模式）挂两个版本 →
   双向断言——成功闭环（旧版检测→下载→验签→覆盖→重启→新版自报版本号）+
   篡改对照（包改一字节 → 验签拒绝、不覆盖）。
5. 单测：semver 比较 / 验签失败拒绝 / apply 参数构造各 ≥1。

**验收标准**：ADR + 三命令 + UI 入口落地；真机 e2e 双向记录进 `docs/verify-a5-client-plugin-e2e.md` 新增节；
`cargo test --workspace`、`pnpm typecheck`、`pnpm test` 全绿；PR 含工单号 LF-10。

**依赖**：无。注意 `updater.exe` update 模式首次真机运行，预期暴露集成缺陷（暴露即修，回写单测/runbook）。

---

## LF-11 · 干净机器安装 e2e + 新克隆一键灌装（阶段 L2+L3）

**目标**：实证「Release 产物 → 干净环境安装 → 启动 → 插件可用」最后一公里；让新克隆开发者一条命令灌好 runtimes。

**范围**：
1. 新 `scripts/e2e-install-verify.mjs`（复用 CDP 与杀进程树惯例）：全新目标目录（无 runtimes 缓存 +
   隔离用户数据目录）跑 `LingFang-Setup-*.exe --silent --target` → 启动安装实例 → CDP 断言插件中心加载、
   内置 notes 打开、`storage.kv` 真落盘；四 runtime keyFiles 在位（对齐 `verify-bundled-runtimes.mjs` 口径）。
2. 新 `scripts/populate-local-runtimes.mjs`：从最新 Release 下载 `runtimes-bundle.zip` + `.minisig` 验签后
   解压到 `apps/desktop/runtimes/`；失败回退打印 ci.yml populate 手工步骤指引。
   `apps/desktop/package.json` 增 `runtime:populate`。
3. 文档：`docs/lfs-setup.md` 补「新克隆 → 跑通桌面构建」完整顺序；README quickstart 校准。

**验收标准**：干净目标闭环与「runtimes 移走 → 重灌 → `runtime:verify` 通过」均实证记录
（操作前先备份现有 runtimes）；三基线全绿；PR 含工单号 LF-11。

**依赖**：无（可用 `v0.0.1-test` Release 产物或本机打包）。

---

## LF-12 · 能力面真机证据补齐（阶段 M）

**目标**：把核实 #6–#10 中「仅单测 / 无证据」的 kind 补成真机实证或稳定单测；不新增任何能力 kind。

**范围**：
1. `e2e-desktop-smoke.mjs` 增断言：`clipboard` writeText→readText 真机往返（clipboard.read 首次真机实证）；
   `storage.kv` list/delete/count 真机往返 + **delete 后重启不复活**（LF-07 落盘修正的真机证明）；
   `net.fetch` 对环回 adapter 真实 HTTP 请求断言 200 与响应体。
2. 单测补齐：`main.rs` `extract_host`/`is_blocked_host` SSRF 守卫（环回/内网段/合法域名/畸形 URL）；
   `client_image_generate`/`client_audio_generate` 等无专属单测的 `client_*` 命令补 mock relay 单测。
3. `scripts/relay-adapter.mjs` 扩展 image/video/audio 四路由协议级模拟（确定性伪响应）；
   `e2e-relay-verify.mjs` 增四 kind 断言（无凭据 exit 2 语义不变）。
4. 注释收口：删 `capability.rs` 的 `requestSystemPermission` 虚假注释与 file-explorer 过时引用；
   `docs/plugin-development.md` 明示「声明即授权，桌面壳无运行时权限门」。

**验收标准**：新增 e2e 断言真机全绿；新增单测计入基线；三基线全绿；PR 含工单号 LF-12。

**依赖**：无。不做：image/video/audio 真实 provider 证明（依赖平台 relay 就绪，列观察项）；
`fs.pick` 原生对话框交互维持人工确认。

---

## LF-13 · 生态第二狗粮波（阶段 N）

**目标**：第二个真实插件逼出未证明 kind 的手感问题；clip-digest 吃上 LF-07 新 API。

**范围**：
1. `packages/plugin-sdk/examples/` 新增第二个狗粮插件（client 运行时），题材实施第 1 步二选一：
   「网页剪藏」（`clipboard.read` + `net.fetch` + `llm.chat` + `storage.kv` + `ui.view`）或
   「截图笔记」（`system.screenshot` + `storage.kv` + `ui.view`）。
   走完整流程 create → validate → build → `dev` 热循环 → 本地导入真机跑通。
2. 续写 `docs/g2-sdk-friction.md` 第二轮：新增 ≥3 条实证（新 kind SDK 手感、dev watch 防抖表现、
   net.fetch SSRF 是否误伤合法场景）。
3. clip-digest 自修：kv `set` 失败不再静默兜底 localStorage——改用 `list`/`delete`/`count` 做 LRU 淘汰 +
   配额错误提示用户（含单测），成为 storage 管理 API 第一个真实消费者。

**验收标准**：新插件真机跑通（CDP 证据）；摩擦记录 ≥3 条新实证；clip-digest 修复有单测且真机复验；
三基线全绿；PR 含工单号 LF-13。

**依赖**：无硬依赖（LF-12 的 e2e 断言模式可复用）。

---

## LF-14 · 文档债与治理（阶段 O，小件打包）

**范围**：
1. CODEBUDDY.md 五处过时修正（核实 #12：runtime-lock 路径、runtimes 空目录说、installer 未入 workspace 说、
   内置插件清单漏 action-demo/action-caller、contract 模块名单停留 LF-09 前）；
   README 包表补 `platform-contract`、「计划与状态」接到第三轮并指向 `IMPROVEMENT_PLAN_4.md`。
2. C2 ADR 回填：`docs/decisions/C2-relay-credential-source.md` 决策表回填「已采纳 C-on-A
   （2026-08-22 拍板，LF-04b 真机验证）」，状态 OPEN → 已采纳。
3. 警告清零：cargo `unused import` 警告归零（不动 future-compat 类）；
   `plugin_script.rs` group B「未落地」过时注释修正（实际已复用 `ensure_python_venv`/`ensure_node_dependencies`）。
4. 分支清理（**需用户确认后执行**）：删除本地与远端 `lf-03-doc-debt`（已全量并入 main）。

**验收标准**：grep 复核五处过时消除；C2 ADR 状态与事实一致；`cargo build` 无 unused-import 警告；
纯文档/清理 diff，三基线不受影响；PR 含工单号 LF-14。

**依赖**：无。

---

## 验收记录

- **LF-06 ✅ 验收通过（2026-08-25）**：action 桥真机闭环。分支 `feat/lf-06-action-bridge`
  （`343de6c` + `4b7f56a`，plugin_runner `start_plugin` hunk 自 d1c9b1a 按 hunk 剥离迁移）。
  启动期内置 action 注册（Defect #1）+ 会话武装 + 内联 module 沙箱执行；e2e 真机闭环
  ok=true；cargo 246/246、desktop vitest 65/65、typecheck 全绿。
- **LF-07 ✅ 验收通过（2026-08-25）**：storage 管理 API。分支 `feat/lf-07-storage-mgmt`
  提交 `0a99f30`。kv_apply 三 op（list prefix 过滤/delete/count）+ 落盘条件修正（set|delete）；
  sdk.storage list/delete/count；Rust 12/12、plugin-sdk 139/139、typecheck 全绿（独立复验一致）。
- **LF-08 ✅ 验收通过（2026-08-25）**：分支 `feat/lf-08-timeout-quiet-debounce`。
  原提交 `d1c9b1a` 误并入 LF-06 的 plugin_runner 改动，经拆分手术重建为 `12dd30d`（纯 LF-08）：
  J2 timeoutMs（clamp [1000,180_000]，不泄漏桥参）、J3 CLI `--quiet`（四命令 + BuildError.path
  对齐）、J4 dev 重载 300ms 节流（should_emit_dev_reload）。
  ⚠️ 复验口径：plugin-sdk **146/146**（交付报告 150 含 LF-07 未合 main 的 4 测，基数差异非缺陷）、
  cargo 241/241、contract + desktop typecheck 干净；报告所称 App.tsx:214 typecheck 失败
  复验时不可复现（LF-06 WIP 中间态）。
  ⚠️ 流程教训：Agent 并发共享同一 checkout 导致跨工单 WIP 混入（LF-06 改动进 LF-08 提交、
  工作树互踩）。已用拆分手术修复；后续并发建议 per-agent worktree 或串行派发。

- **LF-09 ✅ 验收通过（2026-08-25）· 契约瘦身（H1）**：新建 `packages/platform-contract/`
 （`@lingfang/platform-contract`，依赖 `workspace:@lingfang/contract`），迁入 7 个平台云专属模块
  （marketplace-discovery / marketplace-commerce / plugin-governance / web-plugin-center /
  admin-governance / rbac / billing）及其 6 个 `.test.mjs`；`@lingfang/contract/src/index.ts`
  移除对应 7 条 re-export，仅留桌面闭环形状。
  **依赖方向修正**：`plugin-registry.ts`（保留在 contract）原依赖 `admin-governance` 的
  `createAdminPageSchema`/`AdminUserSummary`/`AdminPaginationMetadata` —— 抽出为
  `contract/src/admin-common.ts`（通用 admin 分页基元，非业务形状）供 contract 与 platform-contract
  共用，避免 contract → platform-contract 反向依赖（保持 platform-contract → contract 单向）。
  验证：`@lingfang/contract` 37/37、`@lingfang/platform-contract` 34/34、plugin-sdk 150/150 全绿；
  apps/desktop typecheck 干净；grep 确认 7 模块零残留 import（仅 apps/desktop 内 "billing" 字符串标签）；
  pnpm-lock 已更新链接新包。PR 待提（引用 LF-09）。

- **LF-13 🟡 代码级验收通过（2026-08-25），真机 e2e 待补**：生态第二狗粮波。
  1) 新插件 `packages/plugin-sdk/examples/web-clip/`（网页剪藏，覆盖 clipboard.read + net.fetch +
  llm.chat + storage.kv + ui.view 五个 kind），validate/build 通过，产物
  `com.lingfang.web-clip-0.1.0.lfplugin`；含 SSRF 拦截提示与 relay_not_configured 降级。
  2) clip-digest 自修：删除 kv set 静默兜底 localStorage，改用 LF-07 list/delete/count 做 LRU 淘汰 +
  配额错误如实提示；`src/clip-digest.spec.ts` 新增 LRU describe 块。
  3) `docs/g2-sdk-friction.md` §11 第二轮摩擦记录 6 条实证（≥3 达标），速查表补 #8–#12。
  复验（本机）：plugin-sdk **163/163**、desktop 65/65 全绿，与交付报告一致。
  2026-08-26 已提交分支 `feat/lf-13-web-clip`（`f17217a`，8 文件，diff 纯净仅本工单）。
  ⚠️ 待补项：真机 e2e（WebView2 桌面壳导入两个 .lfplugin 的 CDP 证据）本环境不可跑，需用户本机复核；
  clip-digest 修复的真机复验同。
  （原「工作区并存 LF-10 半成品」警告已消解：LF-10 已提交 `feat/lf-10-update-trigger`，
  SettingsPanel.tsx:177 不可达比较由验收人修复，见 LF-10 条目。）

- **LF-14 ✅ 代码级验收通过（2026-08-26）**：文档债清理 + 警告收敛。分支 `chore/lf-14-doc-debt`
  （未推远端）。逐项核验属实：
  1) CODEBUDDY.md 五处过时修正全部与代码比对一致（runtime-lock 已提交于 `apps/desktop/runtime-lock.json`、
  runtimes/ 为 gitignore+materialized、installer 已入 workspace、内置插件补 action-demo/action-caller、
  contract 模块名单对齐 `src/index.ts` 实际导出）；
  2) README 包表补 platform-contract、计划链第四轮；3) C2 ADR 状态 OPEN→已采纳（C-on-A）。
  警告核验（cargo check：main 基线 32 条 → 分支 30 条）：plugin_runner.rs 孤立 `use tauri::Emitter`、
  process_util 未用 re-export 两条 unused-import 确已消除；plugin_script.rs 过时注释修正属实。
  ✅ 残余已闭环（2026-08-26 验收人补刀）：`f5cd6f1` 删除 `capture.rs` 死函数
  `run_capture_with_env_and_cancel` 整体（原仅删 re-export 属半修）；`AtomicBool`/`Ordering`
  仍被 `wait_for_capture` 使用，import 保留。删除后 cargo 复跑 255+30 全绿。
  ⚠️ 分支纯度：分支另带一个未在交付清单内的提交 `f4d1728`（e2e-desktop-smoke 诊断增强：
  WebView2 父子进程归属 + runtime 版本上报），非 LF-14 范围。**处置：保留在分支内，PR 描述注明**。
  （原「LF-10 两处红」来自当时未提交的工作区文件，已随 LF-10 提交修复，不在本分支 diff 内。）

- **LF-10 🟡 代码级验收通过（2026-08-26），真机 e2e 待补**：应用侧更新触发链路。分支
  `feat/lf-10-update-trigger`（`60bd646`，6 文件，diff 纯净仅本工单）。
  1) ADR `docs/decisions/update-feed-source.md`：feed = GitHub Releases `latest.json`，验签复用
  `verify_minisign`，relay 托管备选记录解除条件；
  2) `update.rs` 三命令 + `get_app_version`（build.rs 注入 `LINGFANG_APP_VERSION`，与 installer 同源），
  main.rs 注册；
  3) SettingsPanel 检查更新入口 + 版本展示 + 状态机。
  执行 agent 卡点在两个下载单测（loopback 服务器 + reqwest 发不出请求），验收人选 B 路线直接修复：
  - **根因 1**：测试服务器不读请求直接回响应再关 socket——接收缓冲有未读数据时 close 触发内核
  RST（Windows 尤严），销毁在途响应。修法：回响应前循环读请求头至 `\r\n\r\n`（5s 超时兜底）；
  - **根因 2**：两测试同用版本 "0.1.12" → 临时文件同名，并发时篡改用例的 remove_file 误删
  成功用例文件。修法：篡改用例改 `0.1.12-tampered`；
  - 另修：`SettingsPanel.tsx:177` 'ready' 分支内不可达 `disabled` 比较（dead code，修复 desktop
  typecheck）；`DEFAULT_FEED_URL` 原指向不存在的 `lingfang/workbench-releases`，与 ADR「本仓库」
  语义矛盾，改对齐 `qiuuchan/new-lingfang`。
  复验（2026-08-26）：cargo **255/255 + installer 30/30**（含 8 个 update 测试）、pnpm typecheck
  干净、plugin-sdk 163 / desktop 65 全绿。
  ⚠️ 待补项：真机 e2e（L1 第 4 点：update-feed 环回适配器挂两版本，双向断言成功闭环 + 篡改拒绝）
  本环境不可跑，需用户本机执行；发版流水线「上传 latest.json + 安装包签名」亦待落地（ADR 已记）。

- **LF-11 🟡 代码级验收通过（2026-08-26），安装器真闭环待本机**：干净机器安装 e2e + 一键灌装。
  分支 `feat/lf-11-install-e2e`（`18e59cd`，5 文件，diff 纯净仅本工单）。
  1) `scripts/populate-local-runtimes.mjs`：本地优先（LINGFANG_RUNTIME_BUNDLE > 已校验幂等跳过）
  + gh 远程回退（minisign 验签，LINGFANG_RUNTIME_PUBKEY 同信任根）+ --force 备份式重灌与失败回滚
  + 无密钥/Release 时打印 ci.yml 手工步骤 exit 1 不假阳性；
  2) `scripts/e2e-install-verify.mjs`：全新目标目录 + 隔离 WebView2 用户数据；有 SFX 安装器跑
  `--silent --target` 闭环，无则明确降级 target/debug 调试壳并把安装器闭环标「待本机复核」；
  3) `apps/desktop/package.json` + `runtime:populate`/`test:install`；4) `docs/lfs-setup.md` 第七节 +
  README quickstart。
  验收人复跑（本机，2026-08-26）：populate 幂等路径 exit 0；e2e 降级路径
  （`E2E_SKIP_BUILD=1 E2E_INSTALLER_SKIP=1`）全断言绿 exit 0（插件中心 / notes iframe /
  storage.kv 落盘 / keyFiles 6/6 / requiredFiles 10/10）；cargo 263+30、pnpm typecheck、
  pnpm test 全绿。
  验收人修复（含在 `18e59cd`）：远程回退默认仓库 `lingfang/desktop` → `qiuuchan/new-lingfang`；
  `gh release download latest` 字面量会被当成 tag 名，改为不传 tag 取最新 Release。
  ⚠️ 交付报告称「cargo 预存失败 `main.rs:566 extract_host_keeps_ipv6_brackets`（LF-10 半成品）」
  **复验不复现**：该测试属 LF-12 提交 `37c9ae6`（非 LF-10），当前树单测 4/4 通过、全量
  263+30 全绿——疑似交付 agent 跑在 LF-12 未完成的中间态。
  ⚠️ 待补项：SFX 安装器 `--silent` 真闭环（`LINGFANG_SETUP_EXE=... pnpm test:install`）+
  远程回退重灌路径，需具备 Release 与 `LINGFANG_RUNTIME_PUBKEY` 的本机执行。

- **LF-01 ✅ 验收通过（2026-08-24）**：validate/build 干净、制品 v4 结构正确；`pnpm typecheck`/`pnpm test`（256）
  复跑全绿；桌面壳 CDP 实测（release 产物）：本地导入安装成功 → 运行 → sdk 注入 → storage.kv 真实落盘 →
  llm.chat 无凭据 `relay_not_configured` 优雅降级 → ui.view 调用成功 → 未声明能力拒绝。摩擦记录 7 条实证 ≥5 达标。
  ⚠️ 流程偏差：改动未走独立分支/PR，直接留在 main 工作区（含 LF-02 改动混在一起）。
- **LF-02 ⬜→🔧 返工修复已提交（LF-02-R）**：watch 启动点已补到 `load_installed_plugin`（`commands.rs:30`），`cargo build` 通过；待真实桌面闭环复验自动重载。详见下节。
- **LF-02 ✅ 验收通过（2026-08-24，LF-02-R 复验闭环）**：桌面 CDP 实测全绿——注册/账本完整性（dev 1 + builtin 3）/目录直读打开/sdk 注入/能力注册（system.info 真实返回）/**改文件后 iframe 自动重载（新 marker 生效）**/重载后能力可用。cargo 267 + vitest 259 + typecheck 全绿。

### LF-02-R · 返工项：client dev 插件 watch 永不启动

**缺陷**：`watch_dev_dir` 仅从 `start_installed_plugin` 调用，而该命令在 `apps/desktop/src` 前端**零调用方**；
client 插件（v1 dev 唯一支持的运行时）「运行」只走 `load_installed_plugin` + PluginRunner（`read_plugin_file`），
从不触发 `start_installed_plugin` → 文件监听从未启动 → v2 自动重载在真实使用中失效。

**修复（已提交）**：`load_installed_plugin` 命令（`plugin_package_manager/commands.rs:30`）新增 `app: AppHandle` 与
`process_table` 参数，对 `installation.origin == Dev` 的安装调用 `plugin_runner::watch_dev_dir`
（`watch_dev_dir` 内部先 `stop_dev_watch` 同 id 旧监听器，幂等）。该命令在前端列表加载/刷新、以及
重启应用后 hydration 均会被调用，从而覆盖「注册后刷新」「重开应用后 hydration」两条真实路径；
`register_dev_dir` 内部调 `manager.load_installed_plugin`（manager 方法，非命令）亦会借道触发，
无需重复改动。`cargo build` 通过（仅既有 dead-code 警告）。

**缺陷证据（桌面 CDP 实测，release 产物含 LF-02 全部改动——修复前）**：
- `register_dev_dir` ✅ / 账本完整性 ✅（dev 1 + builtin 3）/ 目录直读打开 ✅ / sdk 注入 ✅ / 能力注册 ✅（system.info 真实返回）；
- 改文件后 iframe 30s 内无任何重载（watch 未启动）；
- 隔离对照：从页面 emit `plugin:dev-reload` → iframe 立即重载（前端监听链路完好）→ 断点唯一在 watch 启动。

**可选加固（未做，记录备后续）**：client 分支发事件前加 ~300ms 防抖（与 nodejs 重启路径一致），
避免读到半截文件；当前 notify 事件落地即发，编辑器原子替换临时文件场景下偶发读到旧内容的概率低，
待真实使用中复现再补。

**验收口径（LF-02-R 通过标准）**：在真实桌面闭环（非单元测试）下，dev 插件打开 → 修改源文件 →
iframe 自动刷新且新内容生效；`cargo test --workspace` / `pnpm typecheck` / `pnpm test` 全绿；账本与迁移不受影响。

**✅ 复验结果（2026-08-24 验收人实测）**：CDP 全断言通过——注册/账本/直读/能力注册/改文件自动重载（新 marker 生效）/
重载后能力可用；`unregister_dev_dir` 幂等注销成功。LF-02 正式验收通过。

---

## LF-03 / LF-04a 验收记录

- **LF-03 ✅ 验收通过（2026-08-24）**：G5 前瞻节符号化（残留行号仅存于「0.核实结论」表与「附录」——历史证据区，属存档豁免）；
  H2 ADR（`docs/decisions/platform-windows-only.md`）4 项硬骨头均经真实代码核实，3 条「未能核实」如实声明；H3 落地记录完整
  （4 项重申不做 + 指向 H2 ADR）；F4 与 `tauri.conf.json` 现状一致。纯文档改动，无代码/测试 diff。
- **LF-04a ✅ 验收通过（2026-08-24）**：`require_relay` 凭据优先级 用户设置 > `LINGFANG_RELAY_API_BASE`/`LINGFANG_RELAY_TOKEN`，
  https 硬校验兜底（F5 防御不因 env 路径旁路）；harness 无凭据实跑 exit 2 + 明确提示（假阳性防护实测）；凭据不进仓库/UI/磁盘/日志。
  cargo 267 / typecheck / vitest 259 全绿。⚠️ 设计偏差（已记录）：原工单要求「驱动 SettingsPanel 保存路径」，实际改为
  Rust 侧 env 直读 seam——设置页路径未被 harness 覆盖，留待 LF-04b 人工补测该用户旅程。
- **LF-04b ✅ 验收通过（2026-08-24）**：用户提供 DeepSeek API key（仅经环境变量注入）+ 新增本地 relay 适配器
  （`scripts/relay-adapter.mjs`，零依赖、仅环回监听、模拟平台 relay 协议）→ harness 实测 exit 0：
  notes 内 `llm.chat` 返回**真实 DeepSeek 输出 "2"**（1+1 确定性验证 prompt，非 mock、非 relay_not_configured、
  非 relay_error）。Rust 侧 `is_allowed_api_base` 环回 http 例外（F5 受控放宽，3 单测）。凭据零落地。
  ⚠️ 注意：API key 曾在对话中出现过，若该 key 非一次性测试用途，建议轮换。
- **LF-05 ✅ 验收通过（2026-08-25）**：plugin-sdk vitest 135（+9：code-first 降级 ×2、relay 归一 ×2、
  resolvePath ×5、findWorkspaceRoot ×2）/ desktop vitest 65（+3：kv 两码 + out_of_scope 不越权）/
  contract 71 / cargo 240+30 全绿；typecheck 全干净。CLI 实操（`-C packages/plugin-sdk cli:dev` 下）：
  `validate` / `build` / `dev` 的仓库根相对路径 `packages/plugin-sdk/examples/clip-digest` 均正确解析
  （修复前双拼为 `.../packages/plugin-sdk/packages/plugin-sdk/...`）。流程合规：独立分支
  `feat/lf-05-sdk-friction` 提交 `6fbcb2c`；产品确认后已合入 main（`b854a9b`）。

---

## 派发建议

| 轮次 | Agent A | Agent B |
|---|---|---|
| 第 1 轮 | LF-01（G2 狗粮插件） | LF-02（G3 dev 热循环） |
| 第 2 轮 | LF-03（文档还债组） | LF-04a（G1 前置脚本，凭据未到前） |

LF-04b 待凭据到位后单独派发。任何工单在验收前均不合并 main。
