# C2: client iframe 的 llm/image/video/audio 桥凭据来源

| 项 | 内容 |
| --- | --- |
| 决策编号 | C2 |
| 状态 | 待决（OPEN，阻塞产品决策） |
| 作者 | 架构评审 |
| 相关代码 | `plugin_llm_bridge.rs`、`plugins-runtime.ts`、`PluginRunner.tsx`、`plugin-sdk/src/index.ts` |

---

## 1. 背景与阻塞点

client HTML 插件（在 `iframe` 内渲染）通过 `window.sdk.llm.chat` 等调用 AI 能力。
当前它们**拿不到 relay 凭据**，调用链路最终落到 capability 网关的 `NotSupported`。

证据：

- `apps/desktop/src/pages/plugins/PluginRunner.tsx:48` — client 引导脚本把 `llm.chat`
  路由到 `cap('llm.chat', input)`，即 `parent.postMessage` → 宿主 `invokeRuntime`。
- `apps/desktop/src/lib/plugins-runtime.ts:50-64` — `invokeRuntime` 把非 `net.fetch`
  的 kind 全部交给 Tauri 命令 `invoke_capability`。
- `apps/desktop/src-tauri/src/capability.rs:107-118` — `invoke_capability` 仅分派
  `fs.read` / `fs.write` / `system.info` / `clipboard` / `system.screenshot`；
  其余（含 `llm.chat` / `image.*` / `video.*` / `audio.*`）落到 `other => NotSupported`。
  错误文案：`插件已声明但桌面壳暂未实现`（capability.rs:79）。

这是一个**真实阻塞**：内置 `notes` 插件（client HTML，见 CODEBUDDY.md「built-in plugins」）
若声明 `llm.chat`（如 AI 摘要），今天会直接失败。

阻塞的产品前置条件：**relay 凭据（api_base + auth_token）从哪来？**
当前桥的凭据来源只在 nodejs/python 路径上闭合，client 路径从未接入。

## 2. 当前事实

### BridgeSession 持有什么（`plugin_llm_bridge.rs:39-53`）

```rust
struct BridgeSession {
    plugin_id: String,
    api_base: String,          // relay 地址
    auth_token: String,        // relay 鉴权 token
    allow_llm_chat: bool,
    allow_image_generate: bool,
    allow_image_edit: bool,
    allow_video_generate: bool,
    allow_audio_generate: bool,
    action_invocation_id: Option<String>,
    action_context: Option<Arc<ActionRuntimeContext>>,
    client_source: PluginBridgeClientSource,
    expires_at: Instant,
}
```

所有 AI 路由（`route_llm_chat` :675、`route_image_generate` :707、`route_video_generate`
:1094、`route_audio_generate` :1191 等）都 `ensure_platform_session` 校验
`api_base` / `auth_token` 非空（:1714-1723），再转发到 relay `/api/relay/v1/*`。

### 谁会拿到一个 session（即拿到凭据）
- nodejs/python 插件：`plugin_script.rs:577` 与 `plugin_runner.rs:1629` 调用
  `register_session`，把 `LINGFANG_PLUGIN_BRIDGE_URL` / `LINGFANG_PLUGIN_BRIDGE_TOKEN`
  注入进程环境（plugin_script.rs:605-609 / plugin_runner.rs:1656-1660）。
- action 调用：`register_action_session`（:207）。

### client 插件今天拿到什么
- **没有 BridgeSession**，没有 `LINGFANG_PLUGIN_BRIDGE_*`，iframe 内只有 `window.sdk`。
- `llm.chat` / `image.*` / `video.*` / `audio.*` 全部走 `invoke_capability` → `NotSupported`。
- SDK 侧 `sdk.llm.chat` 形状（`plugin-sdk/src/index.ts:578-580`）只是把调用交给
  `invokeAi` → `__lingfangInvoke` 或 localhost 桥回退；client 路径下回退也因无
  `LINGFANG_PLUGIN_BRIDGE_*` 而失败（index.ts:308-314）。

结论：client 与 nodejs/python 的 AI 能力供给不对称，根因是**凭据从未注入 iframe 路径**。

## 3. 候选方案

### (A) 应用设置中配置 relay 凭据
- **做法**：用户/安装者在应用「设置」填写 relay `api_base` + `auth_token`，宿主在
  client 插件加载时注入一个 BridgeSession（复用 `register_session`）。
- **优点**：显式、用户可控；复用现有 `BridgeSession` 机制，改动小。
- **缺点**：用户须自行获取 token，非「零配置」；体验门槛高。
- **与零服务器张力**：中等。桌面壳仍直连 relay（外部服务），但凭据由用户显式提供，
  不涉及「平台账号」概念，张力最小。

### (B) 平台登录态
- **做法**：引入平台账号登录，token 由登录态提供，宿主存于 credential store，
  按插件注入 session（刷新流程另加）。
- **优点**：单点登录体验好；可挂钩计费/配额。
- **缺点**：引入「账号」概念，直接**冲突零服务器定位**；需登录/刷新/登出全链路。
- **与零服务器张力**：高。正式承认「壳依赖平台账户服务」，动摇「无后端」叙事。

### (C) 不允许 client 直连 relay，client 的 AI 走宿主代理命令
- **做法**：新增 Tauri 命令（如 `client_llm_chat`），内部用**宿主持有的 relay session**
  （来自 A 或 B 的凭据源）调用，并复用 capability 网关做声明校验。iframe 永不持有凭据。
- **优点**：client 沙箱化、凭据不进 iframe、capability 网关仍生效；与现有 localhost 桥安全模型一致。
- **缺点**：需新增 host 命令（client 路径专用桥接）；仍依赖某个凭据源（折回 A 或 B）。
- **与零服务器张力**：同 A/B——本质仍是壳直连 relay；但**不把凭据暴露给 client**这点强化了沙箱。

### (D) 保持 NotSupported，client 不提供 AI 能力
- **做法**：接受 client HTML 插件无法调用 relay AI；要求「需要 AI 的插件」必须是
  nodejs/python（已有 session）。
- **优点**：零额外工作量；**完全保持零服务器纯度**；client 路径不接触任何外部服务。
- **缺点**：限制 client 插件能力；`notes` 的 AI 摘要等功能不可用。
- **与零服务器张力**：无。D 是唯一不破坏「无后端」定位的方案。

## 4. 推荐（默认）

默认推荐 **C 建立在 A 之上**（即：凭据取自应用设置，client AI 经宿主代理命令，
iframe 不持凭据）。理由：

- 保留现有 `BridgeSession` / 网关 / 计费模型，改动收敛在「新增一个 host 命令 + 为
  client 注册 session」两处。
- 不引入账号体系（避开 B 的零服务器冲突），凭据由用户显式配置（A）。
- 沙箱最干净：凭据不进 iframe，与 nodejs/python 经 localhost 桥隔离的安全哲学一致。

若产品明确选择「保持零服务器纯度优先于 client AI 能力」，则退回 **D**。
B 仅在已规划平台账号体系时纳入。

## 5. 待决问题（需产品决策）

1. **token 来源**：用户手动配置（A）还是平台账号下发（B）？这决定是否引入账号概念。
2. **是否允许 client 直连 relay**：若禁止（C），需排期新增 host 代理命令；
   若允许凭据进 iframe，则偏离沙箱模型。
3. **是否容忍 client 无 AI 能力**：即是否接受 D，放弃 `notes` 等 client 插件的 AI 功能。
4. **计费/配额归属**：relay 调用按团队灵石计费（见 bridge 注释），client 调用如何归属账户？

## 6. 决策记录占位

| 字段 | 值 |
| --- | --- |
| 选项 | ____（A / B / C / C-on-A / D） |
| 决策者 | ____ |
| 日期 | YYYY-MM-DD |
| 依据 | ____（产品结论 + 上述张力权衡） |
