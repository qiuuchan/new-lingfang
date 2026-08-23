# B3: runtime 物料来源（bundled runtime binaries 来自哪里）

> 状态：✅ 已拍板（2026-08-22：**组合 B→C**）。代码侧脚手架已全部落地；仅剩外部物料/密钥入库即可闭环（见文末「脚手架进度与剩余外部阻塞」）。逐项答复见 `docs/DECISION-REQUEST.md`「决策一：B3」。
> 范围：灵坊工作台（my-treasure）Tauri v2 桌面端 `apps/desktop/runtimes/` 下的 node / python / ffmpeg / chromium 二进制物料
> 关联决策：B2（lock 文件落地位置已修复为 `apps/desktop/runtime-lock.json`，见 `scripts/materialize-bundled-runtimes.mjs:20-22`、`scripts/verify-bundled-runtimes.mjs:11-13`）

---

## 背景与阻塞点

灵坊工作台是**零服务器**模型：所有插件执行、能力下发、文件/网络访问都走 Tauri 命令 + 本地文件系统 + **应用自带的语言运行时**（node / python / ffmpeg / chromium）。运行时**不查系统 PATH**，只从 `runtimes/` 解析（`runtime_resolver.rs:8`、`runtime_resolver.rs:344-354` 的 `resolve_bundled` 只 `join(subdir)` 后判定 exe 是否存在，`RuntimeSource` 永远为 `Bundled`）。

`materialize-bundled-runtimes.mjs` 与 `verify-bundled-runtimes.mjs` 已经写好，但它们的**输入端没有物料来源**：

- `materialize` 要求 `entry.parts` 逐个存在，否则 `fail("missing runtime part")`（`materialize-bundled-runtimes.mjs:36-41`）。
- `verify` 要求 `requiredFiles` / `keyFiles` 全部存在并对齐 `size` + `sha256`（`verify-bundled-runtimes.mjs:20-34`），否则 `fail`。

也就是说：锁文件把"目标长什么样"定义得很完整，但**没有任何机制把这些字节放进仓库或装进安装包**。`runtimes/` 本身被 gitignore（`repo-root .gitignore:11-13`），所以这些字节**不能随源码提交**，必须在构建 / 安装 / CI 阶段注入。

阻塞点具体在：

- `runtime-lock.json` 中 node / python / ffmpeg 的 `keyFiles`（如 `nodejs/node.exe`、`python/python.exe`、`ffmpeg/ffmpeg.exe`）和 `requiredFiles`（如 `nodejs/npm.cmd`、`python/Scripts/pip.cmd`）**只有 sha256 与 size，没有任何 `parts` 分片、没有任何 `source` 拉取步骤**。
- 也就是说：谁、在什么时候、从哪、用什么信任根，把这些二进制落到 `runtimes/`——**完全未定义**。
- 在来源策略敲定前，`pnpm -C apps/desktop runtime:prepare` 与 `runtime:verify` 必然失败（缺 `parts` 或缺 `keyFiles`），`tauri build` 也无法产出可用的桌面包。

---

## 当前事实（已核实）

> 注：以下为拍板前快照。其中「ffmpeg `source` 为内部提交哈希」此后已按决策改为 gyan.dev 公开 URL（含 `sourceSha256`/`sourceSize` 占位），见文末「脚手架进度与剩余外部阻塞」。

锁文件 / 脚本 / gitignore / resolver 的真实情况：

- **`apps/desktop/runtime-lock.json` 实际包含：**
  - `runtimes`：node 22.21.1、python 3.12.13+20260623、ffmpeg 8.1.2（source 为 `repository-history:...` 提交哈希）、chromium Playwright 1.61.1 / revision 1228 / browserVersion 149.0.7827.55。
  - `keyFiles`（6 个）：node.exe、python.exe、ffmpeg.exe、ffprobe.exe、chrome.exe、chrome-headless-shell.exe——**仅有 path/size/sha256，无 parts、无拉取描述**。
  - `materializedFiles`（1 个）：仅 `chromium/.../chrome.dll`，size 285203968，sha256 `22e96348…`，`partsRoot: "../runtime-parts"`，分片 5 个（`chrome.dll.part-000`~`part-004`）。**这是锁文件里唯一带分片的东西。**
  - `requiredFiles`（11 个）：npm.cmd / pnpm.cmd / npm-cli.js / pnpm.cjs 等 node 侧，pip.cmd / pip wheel 等 python 侧，以及 chromium 两个 `INSTALLATION_COMPLETE` 标记——**无任何获取描述**。
  - 结论：`chrome.dll` 已具备「提交分片 + 拼合校验」的完整闭环；**node / python / ffmpeg 完全没有任何 in-repo 获取机制**（ffmpeg 连 `source` 都是内部仓库提交哈希，外部无法复现）。

- **`runtime-lock.json` 的 `partsRoot` 指向 `../runtime-parts`** —— 即 `apps/desktop/runtime-parts/`，分片拟提交到仓库。

- **`.gitignore`（根）lines 11-13**：`apps/desktop/runtimes/` 与 `apps/desktop/src-tauri/runtimes/` 被忽略（随包分发，不入仓）。`runtime-parts/` **未被忽略**——分片目录的设计意图是提交进仓库。

- **`apps/desktop/.gitignore`**：只忽略 `.local-runtimes/`（dev 模式按需下载落点），与 bundled runtime 物料来源无直接关系。

- **`runtime_resolver.rs`**：`bundled_runtimes_root`（`runtime_resolver.rs:356-380`）解析顺序为 `LINGFANG_EMBEDDED_RUNTIME_DIR` 环境变量 → exe 同级 `runtimes/` → `resource_dir/runtimes/` → `CARGO_MANIFEST_DIR/../runtimes/`。**全程只查 `runtimes/`，绝不查系统 PATH**（不变式 1，`runtime_resolver.rs:8`）。`env()` 还会清空宿主 PATH 并只注入命中来源 PATH（`runtime_resolver.rs:247-291`）。结论：resolver 对"物料从哪来"无感知，它只消费已就位的 `runtimes/`。

---

## 候选方案

### 方案 A：外部下载脚本（build/dev 期从镜像拉取并生成分片/锁）

- **做法**：新增脚本（如 `scripts/fetch-runtimes.mjs`），在 `runtime:prepare` 前运行。按 `runtime-lock.json` 的 `runtimes[].source`（nodejs.org、python-build-standalone GitHub、chromium CDN、ffmpeg 内部仓库）下载并解包到 `runtimes/`；对大文件（如 chrome.dll、ffmpeg.exe）切成 `runtime-parts/` 分片并回填 `materializedFiles.parts`；对 `source` 为内部提交哈希的 ffmpeg，需额外解决可访问性。
- **优点**：仓库体积小，不提交二进制；版本随 `runtime-lock.json` 声明自由升降；与现有 `materialize`/`verify` 脚本天然衔接。
- **缺点**：构建/dev 必须联网；引入**供应链信任**问题（下载源需校验签名或至少对齐 sha256，目前脚本只校验不拉取）；镜像（nodejs.org / GitHub / CDN / 清华 / npmmirror）必须长期可用；CI 与开发者本机网络环境不一致时行为漂移。
- **对零服务器定位的影响**：中性。运行时依旧随包落地、本地执行，不引入任何在线后端；只是"灌装"阶段联网，运行期仍零服务器。

### 方案 B：构建期制品（CI 产出 + 发布附件）

- **做法**：CI 在受控环境下载/构建运行时，按 `runtime-lock.json` 校验后，将完整 `runtimes/` 或分片打包为**发布附件**（release asset）。`runtime:prepare` 改为从对应 release（按 lock 的 version 固定）拉取制品并 materialize。ffmpeg 可在 CI 内从内部仓库取得后一并打包，规避外部不可达。
- **优点**：可复现、版本 pin 死；物料经 CI 统一校验，信任根集中；开发者本机无需联网；能覆盖 ffmpeg 内部源这类外部不可达情形。
- **缺点**：需要**发布流水线**支撑（产物存储、版本寻址、清理策略）；大制品（node+python+ffmpeg+chromium 合计 >1GB）占用 release 存储；首次搭建成本高。
- **对零服务器定位的影响**：中性偏正。物料在离线安装包内闭环，运行期零服务器；CI 仅负责"灌装"，不属于产品运行时依赖。

### 方案 C：安装包附带（安装器 crate 注入）

- **做法**：独立的 `apps/desktop/installer/` crate 在打包阶段把 `runtimes/` 直接打进安装器（MSI/NSIS）；安装时落地到 `exe 同级/runtimes/`，恰好命中 `bundled_runtimes_root` 的 exe 同级分支（`runtime_resolver.rs:362-368`）。`runtime:prepare` 退化为"校验安装包内自带运行时完整性"。
- **优点**：**离线安装**，单一事实来源（安装包即真相）；与 resolver 解析路径最贴合；部署环境无需任何网络；最契合"随包分发"的 gitignore 意图（`.gitignore:11-13`）。
- **缺点**：安装包体积大（>1GB，需考虑分卷/增量/下载器）；运行时**更新节奏绑定 App 发版**，热修运行时需发新安装包；installer crate 需新增大文件打包逻辑（且目前 `installer/` 不在 Cargo workspace 内）。
- **对零服务器定位的影响**：最契合。运行时随安装包一次性落地，运行期完全离线、零服务器。

---

## 建议

**默认推荐：方案 C（安装包附带）作为长期目标，方案 B（CI 制品）作为落地路径，方案 A 仅作开发者本地 fallback。**

理由：

1. resolver 的解析语义（`runtime_resolver.rs:356-380`）和 gitignore 意图（`.gitignore:11-13`）都指向"运行时随安装包走、不入仓、运行期离线"，方案 C 与该语义零摩擦，是最稳的终态。
2. 但 C 的 installer 改造工作量最大，且 `installer/` 当前不在 Cargo workspace。建议**先用方案 B 把 CI 制品链路跑通**（CI 产出并固定 `runtimes/`，release 附件 + `runtime:prepare` 从 release 拉取），它同样满足离线运行、并顺带解决 ffmpeg 内部源不可达的问题；待 installer 改造就绪，再将"拉取"换成"安装器注入"，平滑迁移到 C。
3. 方案 A 保留为开发者本地 / fork 场景的便利手段，但**不作为官方构建主路径**（供应链信任与镜像可用性风险）。

**chrome.dll 分片现在就提交（A-partial / 立即动作）：**

- `chrome.dll` 是锁文件里唯一已带完整 `parts` 闭环的物料（`runtime-lock.json:56-69`），`materialize`/`verify` 已能处理它。
- 应立即将 5 个分片（`chrome.dll.part-000`~`part-004`，共 285MB）提交到 `apps/desktop/runtime-parts/`（该目录未被 gitignore），并让 `runtime:prepare` 先跑通 chromium 这一条路径。这能**立即关闭 chromium 物料缺口**，把阻塞面从 4 个运行时缩减到 3 个。

---

## 待决问题（需产品 / Owner 回答）

1. **ffmpeg 来源**：`runtime-lock.json:15` 的 `source` 是内部仓库提交哈希 `repository-history:74a14603…`，外部网络无法复现。该仓库是否对 CI 可访问？是否改为可公开下载的构建产物？还是必须走方案 B/C 在内部 CI 打包？
2. **离线安装是硬要求吗**？若客户环境强制 air-gapped，则方案 C 几乎是必选，方案 A 直接出局。
3. **安装包体积预算**？node+python+ffmpeg+chromium 合计 >1GB，是否接受单包 >1.5GB，还是需分卷/在线下载器（这会让 C 退化出部分 A 特征）？
4. **运行时更新节奏**：是否接受"运行时跟随 App 版本发"？还是需要运行时独立热更（这会影响 B/C 的版本寻址设计）？
5. **供应链信任基线和 CI 责任边界**：下载/构建物料时，以 sha256 对齐为准，还是要求额外签名校验（minisign，现有 `plugin_security.rs` 已有 minisign 能力，能否复用）？
6. **chrome.dll 分片是否现在提交**？建议是（见上），需 Owner 确认 285MB 分片入仓的存储策略与 LFS 是否需要。

> ✅ 全部六问已于 2026-08-22 由产品拍板，逐项答复与理由见 `docs/DECISION-REQUEST.md`「决策一：B3」。

---

## 脚手架进度与剩余外部阻塞（2026-08-22 更新）

代码侧脚手架已全部落地：

- `.gitattributes`：`apps/desktop/runtime-parts/**` 与 `*.part-*` 走 Git LFS（团队操作指引：`docs/lfs-setup.md`）。
- `runtime-lock.json`：ffmpeg `source` 改为 gyan.dev 公开 URL，预留 `sourceSha256`/`sourceSize` 占位。
- `materialize-bundled-runtimes.mjs`：新增「公共 URL 来源」下载 + sha256 硬校验分支（物料未就绪时 NOTICE 跳过，不阻断）；chrome.dll 分片拼合路径不变。
- `plugin_security.rs`：抽出通用 `verify_minisign(pubkey_b64, sig_text, message)`，插件包与 CI 运行时产物复用同一 minisign 原语。
- `ci.yml`：新增 `publish-runtimes` job（tag 触发：materialize → verify → 打包 → minisign 签名占位 → release 上传；后三步暂为占位/`continue-on-error`）。

外部输入清单（2026-08-22 更新）：

| # | 外部输入 | 状态 | 落实情况 / 待办 |
|---|---|---|---|
| 1 | `chrome.dll` 5 分片（合计 285MB） | ✅ 完成（2026-08-22） | 自 Playwright CFT 149.0.7827.55 `chrome-win64.zip` 提取（size/sha256 与锁一致），等分切分落位 `apps/desktop/runtime-parts/chromium/ms-playwright/chromium-1228/chrome-win64/`，拼合回验 sha256 通过。提交走 LFS（流程见 `docs/lfs-setup.md`）；本工作副本尚无 `.git`，建仓后首提即入库 |
| 2 | ffmpeg 实际 `sourceSha256` / `sourceSize` | ✅ 完成（2026-08-22） | 归档 166,721,853B / sha256 `0fff1889…` 已回填 lock；`source` 修正为 gyan.dev `/builds/packages/`（原 `/builds/` 路径已 404，GitHub 镜像字节一致）；包内 ffmpeg.exe / ffprobe.exe 与 keyFiles 逐字节一致 |
| 3 | CI minisign 密钥 | ✅ 完成（2026-08-22） | `LINGFANG_RUNTIME_PUBKEY` / `LINGFANG_RUNTIME_SIGKEY` 已注册；`publish-runtimes` 六步全部 hard 并端到端跑绿：tag `v0.0.1-test` → Release `runtimes-bundle.zip`（约 1.7GB）+ `.minisig`，签名与自验通过。B 链路闭环 |

后续（P2）：installer crate 接入 workspace 并注入 `runtimes/`，迁移至方案 C。
> ✅ **P2 已完成（2026-08-23，B3→C 迁移闭环）**：installer 入 workspace；`sfx.rs` 以
> `SegmentReader` 流式解压（payload >1.5GB 不再整段进内存）；`build-installer.mjs` 打包前强制
> runtime-lock 全量校验（sha256 硬门槛）、排除 `.download`、内置纯净 `updater.exe`、u32 容量守卫；
> CI `publish-runtimes` 扩为双产物（runtimes-bundle.zip + 内嵌 runtimes 的 LingFang-Setup-*.exe，
> 均经 minisign 签名）。顺带修复 `cli.rs` 子命令误判路径值的存量 bug（`--silent --target <路径>`
> 形态此前必败）。本机端到端验证通过（打包 633MB → 静默解压 → 产物与锁逐字节一致）。

---

## CI 签名链路闭环记录（2026-08-22）

> ⚠️ 本节取代早前的「minisign 密钥交接」草案：该草案描述的 `.runtime-signing/` 密钥对**从未注册**，
> 已作废（可删除），避免双钥匙混淆。**唯一信任根 = 已注册的 Org secret。**

实际注册并生效的密钥：

| Org secret | 值 |
|---|---|
| `LINGFANG_RUNTIME_PUBKEY` | minisign 公钥文件全文（KeyId `3AAE104344CB8CA3`，base64 `RWSjjMtEQxCuOiyJ5vRBrdquGSU15tGQDHW3zVMkO4sMJIAvC32jpQwt`） |
| `LINGFANG_RUNTIME_SIGKEY` | 对应私钥文件全文（无密码版，仅存于 GitHub secret 与 Owner 本地备份） |

闭环验证（tag `v0.0.1-test`，run `ab75bbe`）：checkout(LFS) → 预取(sha 门槛) → materialize → populate → verify → package(~1.7GB) → **minisign 签名 + 自验 ✓** → Release 上传 ✓。
产物：`https://github.com/qiuuchan/new-lingfang/releases/tag/v0.0.1-test`。

验签命令（消费方）：

```powershell
minisign -Vm runtimes-bundle.zip -P <LINGFANG_RUNTIME_PUBKEY 文件或内联 base64>
```

---

## 决策记录

- **选项**：[ ] A 外部下载脚本  [ ] B CI 制品  [ ] C 安装包附带  [x] **组合（B→C）**
- **决策人**：产品负责人
- **日期**：2026-08-22
- **理由**：离线安装为硬要求 → C（安装器注入）为终态；v1 交付优先 → 先以 B（CI 制品）解除构建阻塞；ffmpeg 改公开可下载产物，CI 不依赖内网；供应链基线 = sha256 硬门槛 + CI 制品叠加 minisign 签名（复用 `plugin_security.rs` 现有能力，不新增基础设施）。
- **即时动作**：chrome.dll 分片是否立即提交 `runtime-parts/`？[x] 是（启用 Git LFS 管理）
- **后续任务**：见上文「脚手架进度与剩余外部阻塞」；P2 迁移 C。
