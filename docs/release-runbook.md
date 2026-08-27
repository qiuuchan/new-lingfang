# Runbook · 发版（打 tag → CI → 产物核对 → latest.json 抽检）

> LF-16 交付物。发版链路：CI 的 `publish-runtimes` job 由 `v*` tag 触发
> （依赖 `quality` 绿），产出 **runtimes bundle + SFX 安装器 + minisign 签名 + 更新 feed**。
> 更新 feed 契约见 ADR [`update-feed-source.md`](./decisions/update-feed-source.md)，
> 解析层权威是 `apps/desktop/src-tauri/src/update.rs` 的 `Feed` 结构。

## 前置检查（打 tag 前）

1. 版本三处同源且一致（脚本会硬门槛校验，不一致直接红）：
   - tag：`v0.1.12` 形态；
   - 安装包文件名：`LingFang-Setup-{version}.exe`（版本来自 `apps/desktop/package.json`）；
   - `apps/desktop/package.json` 与 `src-tauri/tauri.conf.json` 的 `version` 字段。
2. 三基线全绿：`cargo test --workspace`、`pnpm typecheck`、`pnpm test`。
3. Org secrets 就绪（本仓库 Settings → Secrets）：`LINGFANG_RUNTIME_PUBKEY` /
   `LINGFANG_RUNTIME_SIGKEY`——bundle 与安装包共用同一 minisign 信任根。
4. 若改动过 feed 契约：同步 `scripts/generate-latest-json.mjs`、
   `scripts/fixtures/latest.json`（重新 `--emit-fixture` 生成）与
   `update.rs` 单测，quality job 的 fixture 漂移防护会强制三者一致。

## 发版步骤

```bash
# 1. 确认在要发布的提交上，然后打 tag 并推送（触发 publish-runtimes）
git tag v0.1.12 && git push origin v0.1.12

# 2. 观察 CI：publish-runtimes job（windows-latest，约 30–60 分钟）
#    https://github.com/qiuuchan/new-lingfang/actions
```

job 内部顺序：runtime 预取/拼合/灌装/全量 sha256 校验 → bundle 打包+签名+上传 →
桌面壳 release 构建 → SFX 安装器打包 → **minisign 签名 + 自验** →
**生成 latest.json（LF-16，`--check-app-version` 三方一致性硬门槛）** → 上传全部资产。

## 产物核对（Release 页面应有五类资产）

| 资产 | 说明 |
| --- | --- |
| `runtimes-bundle.zip` (+ `.minisig`) | 内置 runtime 全量包，供新克隆开发者灌装 |
| `LingFang-Setup-{version}.exe` (+ `.minisig`) | 携带 runtimes 的安装器 |
| `latest.json` | 应用内更新 feed |

**latest.json 抽检**（任一浏览器打开，应为 JSON 且字段正确）：

```
https://github.com/qiuuchan/new-lingfang/releases/download/v0.1.12/latest.json
```

核对要点：`version` 无 `v` 前缀；`setup.url` / `setup.minisig_url` 指向本 Release 锚点；
`setup.sha256` 为 64 位 hex（可与 Release 附件的 Setup exe 本地哈希对拍）；`size` = exe 字节数。

## 发版后验证（更新链路真正"活"的证据）

1. 抽检稳定锚点 `releases/latest/download/latest.json`（应用 `DEFAULT_FEED_URL` 实际拉取的地址）。
2. 旧版客户端冒烟：任意旧版桌面壳 → 设置页「检查更新」→ 应提示发现新版
   （`check_update` → semver 比较 → 返回 UpdateInfo）；本次不实际执行覆盖升级。
3. 首个真机升级闭环属 **LF-17** 工单范围（环回 update-feed 双向断言），此处不重复。

## 已知限制 / 注意

- `notes` 目前为空串（流水线未接 Release notes 输入）；如需下发说明文案，
  在 Generate latest.json 步骤追加 `--notes "…"` 即可，客户端原样展示。
- `pub_date` 为 job 执行时刻 UTC ISO。GitHub 的 `releases/latest` 锚点解析按
  **语义化发布时间**而非资产内容，重复发布同一 tag 时需删除重建 Release 并确认 latest 锚点指向。
- 签名为 detached minisign（`.minisig` 与 exe 分离），签名步骤不改 exe 字节，
  因此 `latest.json` 里的 sha256 天然对齐用户最终下载的字节。
