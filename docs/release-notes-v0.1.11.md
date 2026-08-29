# 千匣台 v0.1.11（首个公开 Release）

> **把散落在本机的 `.md` / `.txt` 文档收进一个本地知识库**——自动切片、关键词全文检索、
> 带着检索片段向大模型提问。你的资料不出本机。

千匣台（QianXia Workbench）是一个 Tauri v2 桌面插件平台：插件在本地桌面壳里运行，
安装、能力鉴权、文件与 AI 调用全部由桌面壳托管。**零服务器**：仓库内没有后端，没有云端同步，
没有账号体系。

![知识库工作站演示：导入 → 检索 → LLM 问答](https://raw.githubusercontent.com/qiuuchan/new-qianxia/main/docs/assets/kb-demo.gif)

## 装一个试试

下载本 Release 的 `QianXia-Setup-0.1.11.exe`（SFX 安装器，内含 node / python / ffmpeg /
chromium 全套运行时），双击安装即可。或源码运行：

```bash
git clone https://github.com/qiuuchan/new-lingfang
pnpm install
pnpm -C apps/desktop runtime:populate   # 灌装内置运行时（首次约 1.7GB）
pnpm dev:desktop
```

装好后你能看到：

- **插件中心**：内置计算器、2048、Markdown 笔记、动作演示、动作调用器 5 个插件，一键运行；
- **知识库工作站**（演示主角）：把本机文档导入成可检索的本地知识库，提问时自动携带检索片段；
- **安装与更新闭环**：`.qplugin` 制品导入、版本回滚、应用内检查更新。

## 已知限制（v1 如实说）

- **仅支持 Windows 10/11**（macOS / Linux 为明确推迟项）；
- **无插件市场**：插件通过本地导入 `.qplugin` 制品（v1 仅接受 client 运行时插件；
  nodejs / python 保留给内置与一方签名插件）；
- **无自动更新后台下载**：更新需在应用内手动「检查更新」触发（下载、验签、重启为最新版）。

## 反馈

GitHub Issues 是唯一正式反馈通道（有模板引导），每周复盘：[new-qianxia/issues](https://github.com/qiuuchan/new-lingfang/issues)
