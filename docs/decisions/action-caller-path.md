# 决策：v1 下 action 调用方仅限进程插件（ADR-LF06）

- 状态：已采纳（2026-08-25，工单 QX-06）
- 范围：千匣台桌面壳 `apps/desktop`（Tauri v2，零服务器架构）
- 相关：核实结论 `IMPROVEMENT_PLAN_3.md#0` 之 #1–#3、#11；`WORK_ORDERS.md` QX-06

## 决策

**v1 下，action 桥（`/actions/call` 本地桥路由）的真实调用方仅限进程插件（nodejs / python），
且由其运行时性质限定为内置插件 / 一方签名插件。client 插件经 capability 网关
`invoke_capability('actions.call')` 保持 `NotSupported`。**

client 插件若要触发另一个插件的 action，v1 不提供该路径；其唯一可用的「调 action」入口是
client handler 内部经 `executeClientActionAdapter` 的 allow-list 再次调用 `actions.call`
（见「与适配器 allow-list 的关系」），该路径调的是进程→桥→前端执行链路，并非 client→网关。

## 依据

1. **capability 网关是同步网关，无 AppHandle / 事件发射能力。**
   `capability.rs::invoke`（行 ~95）是纯函数式分派，只做「声明校验 + 执行 OS 操作」，
   没有 `AppHandle`、不持有 Tauri 事件通道。把 `actions.call` 接入它需要网关感知
   `plugin-action-bridge-call` 事件环（`plugin_llm_bridge.rs:643` emit →
   前端 `clientActionBridge.ts` 执行 → `respond_plugin_action_bridge` 回传），
   这是一次异步事件往返，必须在网关里注入 AppHandle + 等待回传——对现有同步网关是侵入式改造。

2. **进程插件已有一条完整闭环，client 没有。**
   nodejs / python 插件进程经 `QIANXIA_PLUGIN_BRIDGE_URL` 桥直连 `/actions/call`
   （`plugin_llm_bridge.rs:560` `route_action_call`）→ emit `plugin-action-bridge-call`
   → 前端在 sandbox iframe 内执行目标 client 插件的 action handler
   （`clientActionBridge.ts` + `plugin-action-client-adapter.ts`）→
   `respond_plugin_action_bridge` 回传结果给进程。整条链路代码已交付，
   QX-06 的任务是把它跑成**真机闭环**（内置 `action-caller` → 内置 `action-demo`）。

3. **v1 政策把本地导入的第三方插件封死在 client 运行时**（QX-02 / F2：
   `dev` 仅 client，本地导入 nodejs/python 仅内置/一方签名）。因此「真机可主动发起
   action 调用」的主体天然只剩内置/一方签名进程插件——决策只是把既成事实写清楚。

4. **需求未出现前不投资。** 截至 QX-06，没有任何真实「client 插件调另一个 client 插件
   action」的需求；为它改造同步网关 + 异步桥回路属于过早投资，违反「停止追加基础设施」
   的本轮方针。

## 与适配器 allow-list 的关系（避免误读）

`plugin-action-client-adapter.ts:213` 的 allow-list **包含** `'actions.call'`。这是另一层：
允许一个 **client action handler 在其执行体内** 经宿主桥再次调用某个 action（例如
action A 的内部逻辑触发 action B）。它走的是「前端 sandbox iframe → `__qianxiaInvoke`
→ 宿主 → 桥 `/actions/call`」链路，与「client 插件经 capability 网关
`invoke_capability('actions.call')`」不是同一条路。

本决策**只约束 capability 网关的 `actions.call` 分派**（即 `capability.rs` 的 match 分支），
**不改动**适配器 allow-list。两者不冲突，文档特此显式说明，防止后续维护者误以为
「网关 NotSupported 但适配器允许」是矛盾。

## 解除条件

满足以下**全部**条件时，可重新评估放开 client→网关 `actions.call`：

- 出现真实的 client 插件调用另一个 client 插件 action 的产品需求（而非内部 fixture）；且
- capability 网关完成异步化改造（持有 `AppHandle`、能发起并等待 `plugin-action-bridge-call`
  事件环），且为 client→client 调用补充明确的权限/来源校验（防止跨插件越权触发 action）；
- 配套单测 + 真机闭环证明该路径安全可用。

在解除条件满足前，client 插件若调用 `invoke_capability('actions.call')` 一律返回
`NotSupported`，文案见 `capability.rs::CapError::NotSupported`（「插件已声明但桌面壳暂未实现」）。

## 反方向已保证（反向对照）

未注册 / 不存在的 action 调用方经桥调 `actions.call` 时，`clientActionBridge.runClientAction`
对缺失 handler 显式回传稳定码 `action_dependency_unresolved`（`clientActionBridge.ts:115`），
使进程端不再静默挂到 24h 超时。该稳定码是 QX-06 验收的「反向对照」断言对象。
