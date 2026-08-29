# 网页剪藏（web-clip）

从系统剪贴板读取网页 URL（或手动粘贴），通过宿主 `net.fetch` 抓取页面正文，调用千匣平台 LLM（`llm.chat`）生成中文摘要，最终将 URL、正文长度与摘要持久化到 `storage.kv`，并通过 `ui.view` 以宿主弹层展示结果。`client` 运行时示例插件，运行于桌面壳内嵌的沙箱 iframe 中，只通过宿主注入的 `window.sdk` 调用宿主能力，本身不持有任何平台密钥或令牌。

本插件是 QX-13「生态第二狗粮波」的第二个真实插件，刻意覆盖此前从未真机验证的 `clipboard.read` 与 `net.fetch` 两个 kind，并复用 `llm.chat` / `storage.kv` / `ui.view`。

## 能力说明与隐私影响

### 1. `clipboard`（读取剪贴板中的 URL）
- **数据访问**：仅当用户点击「从剪贴板读取 URL」时，通过 `sdk.clipboard.readText()` 读取一次剪贴板，取首个形似 `http(s)://` 的 token 作为目标 URL。
- **隐私影响**：低。仅在主动触发时读取，且只取 URL 形态的子串；非 URL 文本会被忽略。

### 2. `net.fetch`（抓取网页正文）
- **数据访问**：仅对上一步得到的用户给定 URL 发起 `GET` 请求，响应体在插件内做轻量正则抽取可见正文（剥离 script/style 标签与 HTML 标签），**不执行**页面脚本。
- **SSRF 防护**：宿主侧 `plugin_net_fetch` 已内置 SSRF 守卫（禁止内网/保留地址）。若用户给出的 URL 指向内网，宿主返回 `net_fetch_ssrf_blocked`，插件如实提示「被 SSRF 防护拦截」，**不会**绕过。
- **隐私影响**：中。目标 URL 与响应内容会离开本机发往该 URL 指向的站点（由用户显式提供）。不附加任何平台凭据。

### 3. `storage.kv`（存档剪藏）
- **数据访问**：通过 `sdk.storage.set('web-clip:<时间戳>', { url, articleLength, summary, createdAt, source })` 保存每条剪藏。单值上限 256KB、单插件最多 1024 条。
- **LRU 淘汰**：当写入触发配额错误（`kv_quota_exceeded` / `kv_value_too_large`）时，插件用 `storage.list` 找出最旧的一条 `delete` 后重试，**不再静默降级到 `localStorage`**（避免跨隔离、掩盖配额语义）。单值本身超 256KB 时如实告知用户「原文未保存」。

### 4. `llm.chat`（千匣平台 LLM 摘要）
- **数据访问**：将抽取出的正文（截断至 12k 字符）作为 `user` 消息、附系统提示「你是网页剪藏助手…」发送至千匣平台 relay 的 `/llm/chat`，默认模型 `fast`。
- **密钥管理**：插件**不持有**任何 LLM API Key，由宿主 LLM 桥接携带注入令牌代为转发。
- **优雅降级**：平台未配置 LLM 凭据时，宿主返回 `relay_not_configured`，插件捕获后不白屏、仍保存抓取的原文元数据，并以友好提示说明。

### 5. `ui.view`（宿主弹层展示结果）
- **数据访问**：通过 `sdk.ui.render({ type: 'markdown', body })` 请求宿主弹层渲染摘要或降级说明。宿主仅渲染 Markdown，**不注入任意 HTML**。

## 运行

该插件为 `client` 类型，符合 v1 安装政策（本地导入第三方插件仅接受 `client` 运行时）。可通过 `qianxia-plugin build` 打包为 `.qplugin` 后在千匣台中加载，或作为桌面壳内嵌示例直接打开 `ui/index.html`（脱离宿主时 `window.sdk` 未注入，按钮将禁用并提示「当前运行环境未注入 SDK」）。
