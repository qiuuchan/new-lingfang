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
