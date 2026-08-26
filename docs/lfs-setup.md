# Git LFS 使用指引（runtime-parts 分片）

> 适用范围：灵坊工作台（my-treasure）B3 runtime 物料分片的入库、克隆与 CI 拉取。
> 背景：`chrome.dll` 等大二进制以分片形式提交 `apps/desktop/runtime-parts/`（B3 决策：立即提交 + 启用 LFS，
> 见 `docs/decisions/B3-runtime-material-source.md`）。`.gitattributes` 已声明两条规则，**不要**重复 track：
>
> ```
> apps/desktop/runtime-parts/** filter=lfs diff=lfs merge=lfs -text
> *.part-* filter=lfs diff=lfs merge=lfs -text
> ```

## ⚠️ 顺序红线

LFS 的 clean/smudge 钩子必须在分片**首次 `git add` 之前**装好。若先把原始字节 add 进了历史再补装 LFS，
只对后续提交生效——285MB 仍会留在旧提交里拖垮每次克隆，届时只能
`git lfs migrate import --everything` 重写历史（破坏性操作，需全团队协调）。所以：**先完成第一、二节，再动分片**。

## 一、每位开发者：一次性安装

```powershell
winget install GitHub.GitLFS     # 或 choco install git-lfs
git lfs install                  # 写入全局 filter 配置
```

验证（应列出上面两条 pattern）：

```powershell
git lfs track
```

## 二、维护者：仓库初始化

当前工作副本尚未 `git init`（无 `.git/`）。首次建仓时按此顺序：

```powershell
git init
git lfs install          # 在本仓库写入 pre-push 等 hooks
git add .gitattributes
git commit -m "chore: enable Git LFS tracking for runtime-parts (B3)"
```

先推这一笔并确认 CI 正常，然后才进入第三节加分片。

## 三、提交 chrome.dll 分片（物料到位后）

1. 将 5 个分片放到锁文件声明的精确路径：

   ```
   apps/desktop/runtime-parts/chromium/ms-playwright/chromium-1228/chrome-win64/
     chrome.dll.part-000 … chrome.dll.part-004
   ```

2. add 前后各确认一次：

   ```powershell
   git add apps/desktop/runtime-parts
   git lfs ls-files        # 必须能看到 5 个 *.part-* 条目（标记为 LFS），而非普通 blob
   ```

   若 `ls-files` 为空 → 钩子未生效：重跑 `git lfs install`，再 `git add --renormalize apps/desktop/runtime-parts`。

3. 提交并推送。push 时 LFS 对象走独立通道上传；托管方（GitHub/GitLab）对 LFS 有独立的存储/带宽配额，首批约 285MB。

## 四、克隆与拉取

```powershell
# 常规克隆：已装 LFS 则自动拉取对象
git clone <url>

# 只要源码、跳过大文件（可选）
$env:GIT_LFS_SKIP_SMUDGE = "1"; git clone <url>; Remove-Item Env:\GIT_LFS_SKIP_SMUDGE
git lfs pull --include="apps/desktop/runtime-parts/**"
```

## 五、CI

分片入库后，`ci.yml` 的 `publish-runtimes` job checkout 必须显式开启 LFS，否则 materialize 拿到的只是指针文本，
拼不出 `chrome.dll`（sha256 校验必失败）：

```yaml
- uses: actions/checkout@v4
  with:
    lfs: true
```

`quality` job 不消费分片，可不加。（checkout `lfs: true` 已于 2026-08-22 在 `ci.yml` 启用；「minisign 步骤改 hard」仍待密钥配置。）

## 六、排障速查

| 症状 | 处置 |
|---|---|
| 文件内容是指针文本 `version https://git-lfs.github.com/spec/v1` | 未 smudge：`git lfs pull` |
| push 时对象未上传 / pre-push hook 未触发 | 重跑 `git lfs install`，确认 `.git/hooks/pre-push` 存在 |
| 历史里已混入原始大字节 | `git lfs migrate import --everything`（重写历史，全团队协调后慎用） |
| clone 卡在 Downloading LFS objects | 先 SKIP_SMUDGE 克隆，再按第四节按需拉取 |

## 七、新克隆 → 跑通桌面构建（LF-11）

> 工单 `docs/WORK_ORDERS.md` LF-11（阶段 L2+L3）配套。目标：新克隆开发者**一条命令灌好 runtimes**，
> 并用一个脚本实证「干净环境 → 启动 → 插件可用」最后一公里。

```bash
pnpm install
pnpm -C apps/desktop runtime:populate   # 一键灌 runtimes（本地优先 / 远程回退，可重跑+备份式重灌）
pnpm -C apps/desktop runtime:verify     # 校验 keyFiles sha256 + Playwright 漂移
pnpm dev:desktop                        # 启动插件中心 → 运行内置「Markdown 笔记」
```

`runtime:populate` 的源选择顺序（详见 `scripts/populate-local-runtimes.mjs`）：
1. `LINGFANG_RUNTIME_BUNDLE` 指向本地 `runtimes-bundle.zip` → 用之；
2. 本地 `apps/desktop/runtimes/` 已通过 `runtime:verify` → 幂等跳过（加 `--force` 强制重灌）；
3. 远程回退：从 GitHub Release 下载 `runtimes-bundle.zip` + `.minisig`（需 `LINGFANG_RUNTIME_PUBKEY`
   验签信任根，与 `plugin_security.rs` 同一 Org secret）。本环境无 Release / 密钥时明确提示并打印
   `ci.yml` 的 populate 手工步骤，**不假阳性**。

### 干净机器安装实证

```bash
node scripts/e2e-install-verify.mjs            # 模拟全新目标目录 + CDP 闭环断言
E2E_SKIP_BUILD=1 node scripts/e2e-install-verify.mjs   # 复用 target/debug
E2E_INSTALLER_SKIP=1 node scripts/e2e-install-verify.mjs  # 跳过安装器自动探测，强制用调试壳断言（降级复核）
```

脚本行为：
- **有 SFX 安装器**（`LINGFANG_SETUP_EXE` 或 `target/release/LingFang-Setup-*.exe`）→ 跑
  `--silent --target <全新目录>`，启动安装实例，CDP 断言：插件中心加载 / 内置 notes 打开 /
  `storage.kv` 真落盘 / 四 runtime keyFiles 在位（对齐 `verify-bundled-runtimes.mjs` 口径）。
- **无安装器（本环境默认）** → 明确「跳过 --silent 安装」，降级用 `target/debug` 调试壳做启动闭环断言，
  安装器闭环标记为**「待本机（具备 Release 的机器）复核」**。其余 CDP 断言全跑。
