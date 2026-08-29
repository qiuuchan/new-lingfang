# 决策记录索引（ADR Index）

> 千匣台的架构与产品关键决策。格式：`编号/标题 · 状态 · 拍板日期`。
> 决策请求的原始汇总见 [`../DECISION-REQUEST.md`](../DECISION-REQUEST.md)。

| 编号     | 决策                                                                                                                                                        | 状态      | 拍板日期   | 相关工单 |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- | -------- |
| B3       | [runtime 物料来源](./B3-runtime-material-source.md)——bundled runtime 二进制从哪来（组合 B→C：立即提交 + LFS 分片）                                          | ✅ 已拍板 | 2026-08-22 | —        |
| C2       | [client iframe 的 llm/image/video/audio 桥凭据来源](./C2-relay-credential-source.md)——凭据取自应用设置，client AI 走宿主代理命令，iframe 不持凭据（C-on-A） | ✅ 已采纳 | 2026-08-22 | QX-04b   |
| H2       | [平台范围——v1 仅支持 Windows](./platform-windows-only.md)                                                                                                   | ✅ 已拍板 | 2026-08-24 | —        |
| ADR-LF06 | [v1 下 action 调用方仅限进程插件](./action-caller-path.md)——client 插件经能力网关 `actions.call` 保持 NotSupported                                          | ✅ 已采纳 | 2026-08-25 | QX-06    |
| ADR-LF10 | [更新 feed 来源](./update-feed-source.md)——应用侧更新链路第一步，feed 放哪                                                                                  | ✅ 已采纳 | 2026-08-25 | QX-10    |

## 约定

- 新决策先写 `DECISION-REQUEST.md`（问题 + 候选方案），拍板后归档为本目录一个文件，并在此登记。
- 被替代或推翻的决策，在原文件头部标注「已废弃」并链接替代项，不在本索引删除。
