# 快速开始（Getting Started）

> 面向**第一次接触的用户**：5 分钟从克隆到跑起知识库工作站。想开发插件请看
> [`plugin-development.md`](./plugin-development.md)；只想看产品长什么样，先看仓库根
> [`README.md`](../README.md) 的演示 GIF 与截图。

## 0. 前置条件

- **Windows 10/11** + WebView2 运行时（Win11 自带；Win10 首次启动桌面壳时按提示安装）
- **Node.js ≥ 20**、**pnpm 9**（`corepack enable` 后可用 `pnpm`，或 `npm i -g pnpm@9`）
- 不需要 Rust 工具链（那是改桌面壳本身才需要的）

## 1. 装机（约 3 分钟）

```bash
git clone <仓库地址> && cd my-treasure
pnpm install                       # 安装 JS 依赖（含 playwright-core，供验证脚本用）
pnpm -C apps/desktop runtime:populate   # 新克隆首次必跑：灌装内置 node/python/ffmpeg 运行时
pnpm dev:desktop                   # 启动桌面壳（Tauri 开发模式）
```

> `runtime:populate` 会从 `apps/desktop/runtime-parts/`（Git LFS 分片）本地拼装运行时，
> 首次约 1.7GB。开发模式下直接编译启动；想装正式安装包（SFX 安装器 + 自动更新）见
> [`release-runbook.md`](./release-runbook.md)。

## 2. 试插件：知识库工作站（约 2 分钟）

桌面壳打开后是**插件中心**，内置 5 个插件（计算器 / 2048 / Markdown 笔记 / 动作演示 / 动作调用器），
另有一个导入的示例插件「知识库工作站」。用它走完「导入 → 检索 → 问答」三步：

1. **导入**：在知识库工作站里粘贴一段文本（或填一个 `$HOME/Documents` 下的 `.md` / `.txt` 路径
   点「从文件读取并导入」）。文档自动按段落切片，存入插件私有 `storage.kv`。
2. **检索**：输入关键词（如「能力网关」）点搜索，命中的 Top 3 切片高亮显示，点切片即看原文。
3. **问答**：输入问题点「提问」，宿主把检索片段作为 context 转发给 LLM，回答以 Markdown 弹层
   展示并附依据片段。

> **LLM 问答需要配置 relay 凭据**（应用「设置」里录入 `api_base` + `auth_token`）。不配置时，
> 导入与检索完全可用（纯本地），仅问答显示「无法连接平台模型服务」。

## 3. 故障排查

| 现象                        | 处理                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `runtime:populate` 报缺分片 | 确认已 `git lfs pull`（见 [`lfs-setup.md`](./lfs-setup.md)）                             |
| 桌面壳白屏 / WebView2 提示  | 安装 WebView2 运行时后重试                                                               |
| 问答失败 `relay_error`      | 检查「设置」里 relay 地址与 token 是否正确                                               |
| 想开发自己的插件            | 见 [`plugin-development.md`](./plugin-development.md)（create → validate → build → dev） |

## 下一步

- 理解架构与安全模型：[`CODEBUDDY.md`](../CODEBUDDY.md)
- 全部文档索引：[`index.md`](./index.md)
