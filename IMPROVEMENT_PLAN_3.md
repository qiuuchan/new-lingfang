# 灵坊工作台 改进计划（第三轮 · 阶段 I–K · 2026-08-25）

> 本文档是 `IMPROVEMENT_PLAN.md`（第二轮，阶段 E–H）全部交付后的**第三轮改进计划**，
> 覆盖**所有剩余任务**：friction 记录未做项、两轮计划遗留的技术债与观察项、流程纪律。
> 撰写前对涉及的关键事实做了代码级核实（见「0. 核实结论」）。
> 方针不变：**停止追加基础设施，把已交付链路变成"每次提交都被真机检验的产品"，再用真实插件逼出生态。**
>
> 当前基线（2026-08-25）：`cargo test --workspace` 240+30 全绿、desktop vitest 65、
> plugin-sdk vitest 135、contract vitest 71、`tsc --noEmit` 全干净；`main` 与 `origin/main` 同步。
>
> 工单池：LF-06 ~ LF-09 已登记 `docs/WORK_ORDERS.md`（本轮新增），按「独立分支 + 验收后合 main」派发。

---

## 0. 核实结论（撰写本计划的事实依据，全部经本轮读取确认）

| # | 事实 | 证据 |
|---|---|---|
| 1 | client 插件经 `invoke_capability` 调 `actions.call` → 网关 **NotSupported**（match 无该分支） | `capability.rs:107-119`：仅 fs.read/fs.write/system.info/clipboard/system.screenshot，其余落 `NotSupported` |
| 2 | action 桥唯一已接通通路 = 进程插件经 localhost 桥 `/actions/call` → Rust `emit("plugin-action-bridge-call")` → 前端 `clientActionBridge` 执行 → `respond_plugin_action_bridge` 回传 | `index.ts:294-303` `SCRIPT_BRIDGE_PATH` 含 actions.call；`clientActionBridge.ts:57-70` 监听；`plugin_llm_bridge.rs` emit |
| 3 | v1 政策封死本地导入 nodejs/python、dev 仅 client → **真机调用方只剩内置插件** | `WORK_ORDERS.md` LF-02 验收记录；`dev.ts:84-94` client-only |
| 4 | 内置插件由 **build.rs 构建时**从 `builtin-plugins/` 源码目录自动打包 + 生成 sha 索引——加 fixture **无需手维护索引** | `build.rs:25-130`（`package_workspace` + 自动写 `index.json` + 生成 Rust 模块） |
| 5 | 内置 nodejs/python 插件有官方启动命令 + 桥凭据 env | `main.rs:108-149` `start_builtin_plugin`；`plugin_script.rs:605-609` 注入 `LINGFANG_PLUGIN_BRIDGE_URL/TOKEN` |
| 6 | storage.kv 现仅 `get`/`set` 两 op；**`set` 才落盘**（delete 需新增持久化路径） | `client_host_caps.rs:104-121`、`:146-148` |
| 7 | `ChatInput` 无 `timeoutMs`；`invokeAi` 硬编码 `AI_BRIDGE_TIMEOUT_MS` | `index.ts:24`、`:390` |
| 8 | CLI 四命令均已支持 `--json`——#3 剩余仅「`--quiet` 形态」与错误字段对齐 | `validate.ts:190-199` / `build.ts:129-146` / `publish.ts` / `dev.ts` |
| 9 | dev watch client 分支 emit 无防抖（nodejs 分支已有 300ms sleep） | `plugin_runner.rs:1304-1313` vs `:1322` |
| 10 | contract 17 模块中 7 个平台云专属；**桌面/plugin-sdk 生产代码对其 import 为零**（命中均注释），合计 ~63KB | `packages/contract/src/index.ts:11-17`；grep 核实 |
| 11 | LF-04b harness 绕过 SettingsPanel（凭据走 Rust env seam）→ **设置页用户旅程未真机补测** | `WORK_ORDERS.md` LF-04a 偏差记录 |
| 12 | CI `rust-tests` job 未真实 PR 验证；nightly E2E 未观察首周稳定性 | `IMPROVEMENT_PLAN.md` E3/E4 状态 |
| 13 | LF-04b 的 DeepSeek API key 曾在对话中出现 → 建议轮换 | `WORK_ORDERS.md` LF-04b 验收记录 ⚠️ |
| 14 | 流程纪律自 LF-05 恢复（独立分支 + 验收后合 main）→ 本轮延续 | `WORK_ORDERS.md` LF-05 记录 |

**由 #1–#3 引起的范围修正**：A3「最后一公里」（TODO 残留"桌面端实操未跑"）的**完整真机闭环**必须走内置插件
fixture——成本因 #4 已降为「加两个 `builtin-plugins/` 目录」；且必须把「client→client 的 actions.call 保持
NotSupported」写成决策记录（#1）。

---

## 阶段 I：产品闭环验证（最高优先）→ 工单 LF-06

**目标**：把最后一条「代码已交付但真机未证」的链路（action 桥）跑成真机闭环；顺带补测 LF-04b 遗漏的
SettingsPanel 用户旅程。本阶段预期像前几轮一样暴露 1–2 个集成缺陷，暴露即修。

### I1 · action 桥真机闭环（核心）

**范围（文件级）**：
1. **决策记录**：新建 `docs/decisions/action-caller-path.md`——v1 下 action 调用方仅限进程插件
   （内置/一方签名）；client 插件经网关调 `actions.call` 保持 `NotSupported` 并记录理由
   （capability.rs 是同步网关，无 AppHandle，转发桥事件需侵入改造；client→client action 需求未出现前不投资）。
2. **内置 fixture 对**（build.rs 自动打包，见核实 #4）：
   - `builtin-plugins/action-demo/`（client，entry `ui/index.html` + `handler.js`）：
     manifest 声明一个 action（`action_id: demo.hello`，`handler.entry: "handler.js"`，`callable: "default"`），
     打开后经 `clientActionRegistry` 注册（`PluginRunner.tsx:109` / `App.tsx:97` 加载路径已接入）。
   - `builtin-plugins/action-caller/`（nodejs，entry `main.js`）：启动后**裸 fetch 直连桥**
     （`process.env.LINGFANG_PLUGIN_BRIDGE_URL + '/actions/call'` + `X-LingFang-Plugin-Token`，
     body 形状对齐 `index.ts:436-443` 的 `{ dependency_id, input }`——**不 import SDK**，规避内置插件
     的 SDK 分发问题）；调用 `demo.hello`；结果与错误码写入插件目录下 `result.json` 供 harness 轮询断言。
     调用方依赖声明按 `plugin-action.ts` 契约（`dependency_id` 解析在 `plugin_package_manager.rs:609`
     `resolve_action_binding`，实现期核对 caller manifest 需声明什么）。
3. **harness 扩展**：`scripts/e2e-desktop-smoke.mjs` 新增第二档 `--with-actions`（或独立
   `scripts/e2e-actions-verify.mjs`，复用 CDP 连接与杀进程树惯例）：
   构建 → 启动 → 打开 action-demo（断言 registry 注册）→ 启动 action-caller → 轮询
   `result.json`（30s 超时）→ 断言：
   - 返回**真实 action 执行结果**（非 `action_dependency_unresolved`）；
   - `respond_plugin_action_bridge` 回写成功（调用方拿到 resolve 而非 reject）；
   - 反向对照：`sdk.actions.call('nonexistent')` reject 稳定码 `action_dependency_unresolved`。
4. **补 Rust 集成测试**（若缺失）：`/actions/call` 路由 → emit `plugin-action-bridge-call` 载荷形状断言。

**验收标准**：
- [ ] `docs/decisions/action-caller-path.md` 存在，含决策 + 依据 + 解除条件
- [ ] 真机（WebView2 + runtimes 物料 + cargo build）跑通：caller 的 `result.json` 含真实执行结果
     且 exit 干净；反向对照 reject 稳定码
- [ ] `cargo test --workspace`、`pnpm typecheck`、`pnpm test` 全绿（新增测试计入）
- [ ] 暴露的集成缺陷全部修复并回写 runbook/单测
- [ ] PR 含工单号 LF-06

**依赖/风险**：本机已有 runtimes 物料（LF-01/02 验证时 CDP 跑通）；nodejs 内置插件启动经
`start_builtin_plugin`（核实 #5）。风险：action manifest 依赖声明的确切形状需实现期对
`plugin-action.ts` 核对——列为实施第 1 步。

### I2 · SettingsPanel 用户旅程补测（LF-04b 遗留）

**范围**：harness（或复用 `e2e-relay-verify.mjs` 思路）经 CDP **驱动真实设置页**：录入
`api_base` + token（环境变量注入）→ 保存 → 打开 notes → `llm.chat` 经 `client_llm_chat` 真实返回；
断言：`config.json` 落盘字段存在但**日志无 token**、凭据不进仓库。产出 `docs/verify-a5-client-plugin-e2e.md`
新增执行记录节。

**验收标准**：设置页路径真机跑通（真实或本地适配器 relay）；凭据零日志泄漏；runbook 记录更新。

**依赖**：I1 的 harness 基建；本地适配器 `scripts/relay-adapter.mjs` 可复用。

---

## 阶段 J：生态面补全（friction 剩余项）→ 工单 LF-07 / LF-08

**目标**：按 `docs/g2-sdk-friction.md` 剩余条目逐个收口；不做「为做而做」的项显式记录理由（J5）。

### J1 · storage 管理 API（friction #5 后半）→ LF-07

**范围（文件级）**：
- `client_host_caps.rs` `kv_apply` 新增三 op：
  - `list`（`{ prefix?: string }`）→ `{ keys: string[] }`（仅键名；值可达 256KB 不回传；上限 1024 自然满足）；
  - `delete`（`{ key }`）→ `{ deleted: boolean }`（不存在返回 false，不报错）；
  - `count`（`{}`）→ `{ count: number }`。
  - **持久化修正**：`client_storage_kv` 现仅 `op == "set"` 落盘（`client_host_caps.rs:146-148`），
    `delete` 必须纳入保存条件。
- `index.ts` `sdk.storage` 增 `list(prefix?)` / `delete(key)` / `count()` 三个类型化方法。
- 单测：Rust 每 op ≥1（list prefix 过滤、delete 落盘往返、count 正确）；plugin-sdk 路由断言 ≥3。
- 文档：`docs/plugin-development.md` storage.kv 节补管理 API 与淘汰范式（LRU 示例）。

**验收标准**：三 op 全栈可用（单测覆盖）；`delete` 后重启应用不复活（持久化断言）；文档更新；
`cargo test --workspace` / `pnpm typecheck` / `pnpm test` 全绿。

**依赖**：无。风险低（纯增量 op）。

### J2 · AI 调用级 timeoutMs（friction #4）→ LF-08

**范围**：`ChatInput`/`ImageGenerateInput`/`ImageEditInput`/`VideoGenerateInput` 增 `timeoutMs?: number`；
`invokeAi` 增加超时参数，clamp 到 `[1000, 180_000]`（超出 clamp 而非报错）；文档标「AI 默认 180s，
调用级覆盖上限 180s，SDK 与宿主取先到者」；单测：clamp 上下界、透传。

### J3 · CLI `--quiet` 形态（friction #3）→ LF-08

**范围**：validate/build/publish/dev 增 `--quiet`（每行一条 `code`，脚本可解析；`--json` 保持不变）；
错误对象字段对齐（validate 已 `code/path/message`；build 补 `path` 字段置空或省略，两命令 shape 统一）。
单测：`--quiet` 输出形状 ≥1 用例。

### J4 · dev 自动重载防抖（LF-02-R 可选加固）→ LF-08

**范围**：`plugin_runner.rs` watch handler client 分支（`:1304-1313`）加**节流**：`Arc<Mutex<Option<Instant>>>`
记录上次 emit，300ms 窗口内只发一次（对齐 nodejs 分支 `:1322` 的 300ms 语义；notify 高频事件不再连发）。
单测：防抖语义（连续事件 → 单次 emit）≥1。

### J5 · 静态插件免 tsx（friction #7）→ **记录不做**

**理由**：CLI 本体是 TS（`cli:dev` = tsx），为纯 HTML 插件单独预编译 CLI 属过早优化；tsx 冷启动 1–2s
对当前开发循环可接受；真实摩擦重现（多插件高频迭代）时再评估。写入 friction 记录状态即可。

---

## 阶段 K：债务与治理 → 工单 LF-09 + 观察项

### K1 · 契约瘦身（H1，本轮执行）→ LF-09

**范围**：新建 `packages/platform-contract/`，移入 7 个平台云专属模块（marketplace-discovery /
marketplace-commerce / plugin-governance / web-plugin-center / admin-governance / rbac / billing，
共 ~63KB，核实 #10）；`@lingfang/contract` 移除对应 re-export；`pnpm-workspace.yaml` 已含
`packages/*`（无需改）；plugin-sdk / desktop 生产代码 import 为零（核实 #10）→ 改包低风险。
验证：三包 typecheck + vitest 全绿；grep 确认零残留 import。

**验收标准**：7 模块迁出；`@lingfang/contract` 只留桌面闭环需要的形状；全绿；PR 含工单号。

### K2 · F4 CSP 收紧（触发条件记录）

维持 `IMPROVEMENT_PLAN.md` F4 节：下次实质改 `PluginRunner.tsx` 渲染路径时，先落
`docs/decisions/` 方案页再动手；本轮不写代码。

### K3 · CI 观察（E3/E4 遗留）

**范围**：下一真实 PR 触发 `rust-tests` job 时记录时长（预期 10–20 分钟冷/热两档）；nightly E2E
首周稳定性观察（连续 3 晚绿视为稳定）；发现漂移即修并回填 `ci.yml`。验收：连续 3 晚 nightly 绿 +
rust-tests 时长记录在案。**无代码改动预期**，异常才产生工单。

### K4 · API key 轮换（用户行动）

LF-04b 使用的 DeepSeek API key 曾在对话中出现（`WORK_ORDERS.md` LF-04b ⚠️ 记录）。**建议轮换**，
非代码任务；轮换后无需任何仓库改动（key 仅存在于环境变量/设置页）。

### K5 · 流程纪律（延续）

独立分支 + 验收后合 main（LF-05 已恢复）；本轮每工单按此执行。

---

## 工单注册（已同步 `docs/WORK_ORDERS.md`）

| 工单 | 内容 | 建议 Agent | 依赖 |
|---|---|---|---|
| LF-06 | 阶段 I：I1 action 桥真机闭环 + 决策记录 + I2 SettingsPanel 旅程补测 | A | 本机 runtimes 物料 + WebView2 |
| LF-07 | J1 storage 管理 API（list/delete/count + 持久化修正） | A | 无 |
| LF-08 | J2 timeoutMs + J3 CLI --quiet + J4 dev 防抖（小件打包） | B | 无 |
| LF-09 | K1 契约瘦身（7 平台云模块迁出） | B | 无 |

观察项（不派发）：K3（随 PR/nightly 自然观察）、K4（用户行动）、K5（纪律）。
记录项：J5（不做）、K2（触发才做）。

## 建议执行顺序

1. **LF-06**（先立真机闭环：action 决策 + 桥闭环 + SettingsPanel 旅程；预计暴露缺陷最多，先做）；
2. **LF-07** 与 **LF-08** 并行（均为低风险增量；LF-08 依赖无）；
3. **LF-09**（纯搬包 + 验证，随时可插）；
4. K3 观察随 CI 自然推进；K4 请用户尽快轮换 key。

## 附：关键证据索引（2026-08-25 核实）

- `capability.rs:107-119`：网关 match 无 actions.call → NotSupported（核实 #1）。
- `index.ts:294-303`：`SCRIPT_BRIDGE_PATH` 含 actions.call；`index.ts:436-443` actions.call 载荷形状。
- `clientActionBridge.ts:57-127`：事件监听 → registry 命中 → `respond_plugin_action_bridge` 回写；
  未命中回 `action_dependency_unresolved`。
- `plugin_package_manager.rs:609` `resolve_action_binding`、`:741` `register_builtins`（sha 索引校验）。
- `build.rs:25-130`：内置插件自动打包 + 索引生成（fixture 零索引维护成本）。
- `main.rs:108-149`：`start_builtin_plugin` 命令；`plugin_script.rs:605-609` 桥凭据 env 注入。
- `client_host_caps.rs:104-121`（kv_apply get/set）、`:146-148`（仅 set 落盘）。
- `plugin_runner.rs:1304-1322`：client 分支无防抖 / nodejs 分支 300ms sleep。
- `packages/contract/src/index.ts:5-21`：17 re-export；7 平台云模块桌面 import 为零。
- `docs/g2-sdk-friction.md`：剩余项状态（#3/#4/#5 后半未做，#7 记录不做）。
