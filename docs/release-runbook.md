# 发版 Runbook（LF-16）

> 面向维护者的一次发版操作手册。更新链路（`update.rs` 三命令 + installer `run_update`）
> 的 feed 来源 ADR 见 `docs/decisions/update-feed-source.md`。

## 一、发版前置检查

1. main 与 origin 同步，三基线全绿：
   ```bash
   cargo test --workspace        # desktop bin + installer
   pnpm typecheck && pnpm test   # 四包 vitest
   ```
2. 版本号就绪：`apps/desktop/src-tauri/tauri.conf.json` 的 `version` 字段 = 本次发布版本
   （build.rs 注入 `LINGFANG_APP_VERSION`，`check_update` 的 semver 比较以此为基准）。
   **tag 必须与该字段一致**（tag 加 `v` 前缀，如版本 `0.1.12` → tag `v0.1.12`）。
   CI 的 latest.json 生成步骤内置三方硬门槛：tag（去 `v`）≠ `tauri.conf.json` version 时直接失败——tag 打错或忘升版本号会在发版 job 暴露，而非产出一个死 feed。
3. Org secret 就绪（一次性，缺失时 CI 签名步骤会硬失败）：
   - `LINGFANG_RUNTIME_PUBKEY` / `LINGFANG_RUNTIME_SIGKEY`（minisign 信任根，
     runtime bundle 与安装包共用）。

## 二、发版步骤

1. 打 tag 并推送：
   ```bash
   git tag v0.1.12 && git push origin v0.1.12
   ```
2. CI `publish-runtimes` job 自动执行（`needs: quality`）：
   - runtime 物料灌装 + 全量 sha256 校验 → `runtimes-bundle.zip` + `.minisig`；
   - 构建桌面壳 + SFX 安装器（`build-installer.mjs` 自带 runtime-lock 硬门槛）→
     `LingFang-Setup-*.exe` + `.minisig`；
   - **LF-16 新增**：生成 `latest.json` 并随 Release 上传。

## 三、latest.json 字段口径（与 `update.rs` Feed 结构双向锁死）

| 字段 | 生成规则 | 消费方约束 |
|---|---|---|
| `version` | tag 去掉 `v` 前缀（`${GITHUB_REF_NAME#v}`） | 必须 semver 可解析，否则 `check_update` 报「feed 版本号非法」 |
| `pub_date` | 生成时刻 ISO | 展示用 |
| `setup.url` | `https://github.com/<repo>/releases/download/<tag>/<安装包文件名>` | `is_allowed_scheme` 仅拦非 http/https |
| `setup.sha256` | 安装包 exe 的 sha256（十六进制） | 非空即硬校验（常量时间比较），不符即拒绝并删临时包 |
| `setup.minisig_url` | 同 `url` + `.minisig` | 可选层：前端传 pubkey 时叠加验签 |
| `setup.size` | 安装包字节数 | 展示/校验用 |

⚠️ 单测 `update.rs::feed_fixture_parses_ci_latest_json` 锁死上述口径——
改 CI 生成逻辑或 Feed 结构而不同步对方，该测试即红。

## 四、发版后抽检

1. Release assets 应包含：`runtimes-bundle.zip`、`runtimes-bundle.zip.minisig`、
   `LingFang-Setup-*.exe`、`LingFang-Setup-*.exe.minisig`、`latest.json`。
2. `latest.json` 内容抽检：
   ```bash
   gh release download v0.1.12 -p latest.json -O - | cat
   ```
   核对 `version` 无 `v` 前缀、`sha256` 与安装包一致（`sha256sum LingFang-Setup-*.exe`）。
3. 更新链路冒烟（可选，最真实）：旧版安装实例 → 设置页「检查更新」→ 应提示新版 →
   下载 → 验签 → 重启为新版。完整 e2e 见 LF-17。

## 五、常见问题

- **CI 签名步骤失败**：Org secret 缺失或密钥格式非 LF 结尾（步骤内已做规范化，多半是 secret 本身无效）。
- **latest.json 生成步骤报「tag 版本与 tauri.conf.json version 不一致」**：tag 打错或忘升版本号——
  先修 `tauri.conf.json` version（发版前改）或删掉错误 tag 重打，不要手工绕过门槛。
- **`check_update` 报「feed 版本号非法 v…」**：latest.json 的 version 带了 `v` 前缀——
  检查 CI 生成步骤的 `${GITHUB_REF_NAME#v}` 是否被误改。
- **下载后 sha 校验失败**：Release assets 被替换但 latest.json 未重传——重新走一遍发版流程，
  不要手工改 latest.json。
