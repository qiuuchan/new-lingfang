# ADR · 更新 feed 来源（update feed source）

- **状态**：已采纳（Adopted）
- **拍板日期**：2026-08-25（产品本人决策）
- **关联工单**：LF-10（阶段 L1 应用侧更新触发链路）

## 背景

灵坊桌面壳已有安装器 `run_update`（等主进程退出 → 静默覆盖 → 重启 → 自删），但应用侧
**从未拉起过它**——每个 Release 都是「死版」，用户永远拿不到更新（核实 #1/#2）。LF-10 要补的
是「检测 → 下载 → 验签 → 拉起 `updater.exe`」整条应用侧链路。

这条链路的第一步是「去哪查最新版本」——即更新 feed 的来源。本 ADR 拍板该来源。

## 决策

**更新 feed 直接使用 GitHub Releases。**

具体形态：每次发版，在 Release 资产（assets）中附带一个 `latest.json`（由发布流水线随
`LingFang-Setup-*.exe` 一起上传），应用侧 `check_update` 拉取该 `latest.json` 解析最新版本
与安装包下载地址。字段约定：

```json
{
  "version": "0.1.12",
  "notes": "修复…",
  "pub_date": "2026-08-25T00:00:00Z",
  "setup": {
    "url": "https://github.com/<org>/<repo>/releases/download/v0.1.12/LingFang-Setup-0.1.12.exe",
    "sha256": "<hex>",
    "minisig_url": "https://github.com/<org>/<repo>/releases/download/v0.1.12/LingFang-Setup-0.1.12.exe.minisig",
    "size": 12345678
  }
}
```

### 信任根

安装包完整性验签**复用 `plugin_security.rs::verify_minisign`**——与 runtime 制品（B3 决策）
**同一 Org secret 信任根**（同一把 minisign 私钥签发）。即「更新包」与「内置 runtime」走同一
套非对称验签原语，不引入第二把密钥、不引入第二套信任模型。`download_update` 先 sha256 硬校验，
若提供 `minisig_url` + 配置了公钥（`LINGFANG_UPDATE_PUBKEY` 或宿主设置）再叠加 minisign 验签，
任一失败即删除临时文件并拒绝。

### 为什么是 GitHub Releases（而非自建服务）

- 本仓库是**零服务器**架构（CODEBUDDY.md 明示：无后端 / relay / billing，禁止重新引入）。
  GitHub Releases 是「已有分发渠道」，不破坏零服务器叙事。
- 签名密钥由 Org secret 托管，发布流水线签名后随包上传 `.minisig`，无需自运维验签服务。
- 客户端只做「拉 `latest.json` + 拉安装包 + 本地验签」，没有任何服务端状态。

## 备选方案（记录解除条件）

**备选：relay 托管 `latest.json`**（平台云侧放一个 `latest.json` 端点）。
保留此备选的原因：若未来 (a) 需要在 `latest.json` 里下发**灰度/渠道/召回**字段（按用户/租户
返回不同最新版），或 (b) GitHub Releases 被网络环境屏蔽导致国内拉取不稳定，则切换到 relay 托管。
解除条件满足其一即重开本 ADR 评估。

## 影响

- 新增 `update.rs` 三命令：`check_update` / `download_update` / `apply_update`（+ `get_app_version`）。
- feed URL 可配：命令参数优先，其次 env `LINGFANG_UPDATE_FEED_URL`，再次默认常量（指向本仓库
  Release 的 `latest.json`，见 `update.rs` `DEFAULT_FEED_URL`）。
- 安装流水线（ci.yml `publish-runtimes` / 发版 job）需新增「上传 `latest.json` + 对安装包签
  `.minisig`」步骤——本工单范围外，列为发版 runbook 观察项。
