# 知识库工作站（kb-station）

R1 真用插件（D1=A：本地知识库 / RAG）。小潘每天用的本地优先 AI 知识库：

- **导入**：读 `$HOME/Documents` 白名单内的 `.md/.txt`（`fs.read`），或直接粘贴文本；
- **切片**：按空行分段 + 超长截断（客户端 JS，无需服务端）；
- **存储**：切片与元数据经 `storage.kv` 按插件隔离持久化（`doc:<id>:meta` / `doc:<id>:chunk:<i>`）；
- **检索**：关键词全文检索（token 化 + 词频加权，客户端 JS 打分，v1 不引入向量）；
- **问答**：检索 top-3 片段拼进 context → `llm.chat` → `ui.view` 弹层展示答案与依据。

**v1 红线（不做）**：向量检索（v2）、跨插件共享知识层、PDF/Office 解析。

## 能力声明

| kind | 用途 |
|---|---|
| `fs.read` | 导入文档（paths 白名单 `$HOME/Documents`） |
| `storage.kv` | 文档切片与元数据持久化 |
| `llm.chat` | 基于检索片段的问答（无凭据优雅降级） |
| `ui.view` | 问答结果弹层（Markdown 渲染） |

## 本地跑通

```bash
qianxia-plugin build packages/plugin-sdk/examples/kb-station
```

插件中心本地导入 → 运行。配好 relay 凭据（设置页或 env）后问答可用；
无凭据时显示 `relay_not_configured` 降级文案，不白屏不抛错。

## e2e

`scripts/e2e-kb-station-verify.mjs`（QX-23）：CDP 驱动 iframe 内 `window.__kb` 钩子
（与按钮同路径）走 导入 → 列表 → 检索 → 问答 全链，断言切片/命中/答案。
