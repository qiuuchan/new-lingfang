# my-treasure · 灵坊工作台（LingFang Workbench）

Tauri v2 桌面**插件平台**：在本地桌面壳中运行第三方插件。仓库名 `my-treasure` 是个人仓库
占位名，产品名以"灵坊工作台"为准（exe 产物名即 `灵坊工作台`）。

**零服务器的准确含义**：本仓库内没有后端（relay / billing / RBAC 服务端已刻意移除，不要重新
引入）。桌面壳是一个客户端——插件的执行、能力鉴权、文件/网络访问全部经由 Tauri 命令与本地
文件系统完成；AI 能力（llm/image/video/audio）由用户在应用设置中录入**平台 relay 凭据**后，
经宿主代理命令转发，插件 iframe 永不持有凭据。

## 快速开始

前置：Node ≥ 20、pnpm 9（`packageManager` 已锁定）、Windows + WebView2（Rust 改动另需 MSVC 工具链）。

```bash
pnpm install
pnpm -C apps/desktop runtime:populate   # 新克隆一键灌装 runtimes（首次必跑；本地优先 / 远程回退）
pnpm dev:desktop        # tauri dev，打开插件中心 → 运行内置「Markdown 笔记」
pnpm typecheck && pnpm test        # JS 侧全量验证（vitest：contract / plugin-sdk / desktop）
cargo test --workspace             # Rust 侧验证（desktop 壳 + installer）
```

> 干净机器安装实证（「Release 产物 → 安装 → 启动 → 插件可用」最后一公里）：
> `node scripts/e2e-install-verify.mjs`（详见 [`docs/lfs-setup.md` 第七节](./docs/lfs-setup.md)）。

插件开发（client / nodejs / python 模板 → `.lfplugin` v4 制品）：

```bash
pnpm plugin:create && pnpm plugin:validate && pnpm plugin:build
```

> 🔒 **v1 安装政策**：本地导入的第三方插件仅接受 `client` 运行时；`nodejs` / `python`
> 进程插件保留给内置/一方签名插件（详见 `IMPROVEMENT_PLAN.md` F2）。

## 架构地图

混合 monorepo（pnpm workspace + Cargo workspace），详细指南见 [`CODEBUDDY.md`](./CODEBUDDY.md)：

| 位置 | 内容 |
| --- | --- |
| `apps/desktop` | Tauri 壳：React 18 前端（iframe 插件容器 + 能力网关调用）+ Rust 引擎（安装账本、能力网关、进程运行器、runtime 解析器、minisign 验签） |
| `apps/desktop/installer` | SFX 安装器 crate（流式解压注入 ~1.7GB 内置 runtime） |
| `packages/contract` | host↔插件类型的唯一权威来源（Zod schema；契约漂移视为缺陷） |
| `packages/platform-contract` | 平台侧契约（治理 / 计费 / 市场等 Zod schema，与服务端对齐） |
| `packages/plugin-sdk` | 插件作者 SDK + `lingfang-plugin` CLI（create/validate/build/publish） |
| `packages/ui-tokens` | 设计 token（CSS 变量），宿主注入每个插件 iframe |

计划与状态：第一轮 `IMPLEMENTATION_PLAN.md`（A–D 阶段，已全部完成）→ 第二轮
`IMPROVEMENT_PLAN.md`（E–H 阶段）→ 第三轮 `IMPROVEMENT_PLAN_3.md`（I–K 阶段，LF-06~LF-09 验收通过）
→ 第四轮 `IMPROVEMENT_PLAN_4.md`（L–O 阶段，LF-10~LF-14 工单派发中）。

安全模型（三档边界，如实版）：client iframe 是真边界；nodejs/python 进程沙箱
（Windows Job Object）是生命周期围栏而非安全边界，其真实防线是安装时信任（minisign 验签）
与 v1 client-only 政策——完整表述见 `CODEBUDDY.md` 的 Security model 节。
