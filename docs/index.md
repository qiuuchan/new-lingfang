# 千匣台 · 文档索引

> 本页是全部文档的入口（QX-22 文档门面）。先按身份选路，3 跳内必达：**装机 → 用插件 → 开发插件**。
> 产品定位与演示见仓库根 [`README.md`](../README.md)（本地优先的 AI 知识库工作站，零服务器）。

## 按身份选路

| 你是谁                                                                      | 从这里开始                                                          |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **想装机试用**（第一次接触，5 分钟内跑起来）                                | [`getting-started.md`](./getting-started.md)                        |
| **想开发插件**（client / nodejs / python，create → validate → build → dev） | [`plugin-development.md`](./plugin-development.md)                  |
| **想理解架构与安全模型**                                                    | 仓库根 [`CODEBUDDY.md`](../CODEBUDDY.md)（架构地图 + 三档安全边界） |
| **想维护与发版**（安装闭环 / 自动更新 / runtime 物料）                      | 见下方「维护者」分组                                                |

## 装机与使用

- [`getting-started.md`](./getting-started.md) — **用户向** 5 分钟装机 + 试插件（知识库工作站导入→检索→问答）
- [`lfs-setup.md`](./lfs-setup.md) — Git LFS 指引（`runtime-parts/` 大二进制分片的克隆与拉取，仓库贡献者用）

## 插件开发

- [`plugin-development.md`](./plugin-development.md) — 插件开发全流程：脚手架、manifest、能力声明、
  fs.read/write 路径白名单、`list(prefix)` 前缀语义、构建与发布
- [`../packages/plugin-sdk/README.md`](../packages/plugin-sdk/README.md) — SDK 包内文档（CLI 命令、templates）
- `packages/plugin-sdk/examples/` — 可运行的示例插件（`kb-station` 知识库工作站、`clip-digest` 剪藏摘要等）

## 维护者

- [`release-runbook.md`](./release-runbook.md) — 发版 Runbook（QX-16）：前置检查、构建、更新 feed、验签
- [`verify-a5-client-plugin-e2e.md`](./verify-a5-client-plugin-e2e.md) — client 插件端到端验证 Runbook
- [`DECISION-REQUEST.md`](./DECISION-REQUEST.md) — 产品决策请求摘要（架构评审 → 产品拍板）

## 决策与过程

- [`decisions/index.md`](./decisions/index.md) — **ADR 索引**：全部关键决策记录（B3 / C2 / H2 / QX-06 / 更新 feed）
- [`WORK_ORDERS.md`](./WORK_ORDERS.md) — 工单池（每张工单含验收标准）
- [`g2-sdk-friction.md`](./g2-sdk-friction.md) — SDK 使用摩擦记录（真用插件实证反哺）
- 各轮计划：根目录 `IMPLEMENTATION_PLAN.md` → `IMPROVEMENT_PLAN.md` → `IMPROVEMENT_PLAN_3/4/5.md`
