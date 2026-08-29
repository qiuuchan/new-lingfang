# 产品决策请求摘要（Decision Request）

> 给：产品负责人 / Owner
> 来自：架构评审（千匣台 my-treasure）
> 日期：2026-08-22
> 背景：千匣台是一个 Tauri v2 **零服务器**桌面插件平台。两个已交付代码块的收尾被同一类问题卡住——**需要产品拍板的外部依赖决策**。本文把两个待决项压缩成一页。
> **状态：✅ 两项均已于 2026-08-22 拍板（B3 选 B→C，C2 选 C-on-A），见文末决策记录。**
> 详细论证见：`docs/decisions/B3-runtime-material-source.md`、`docs/decisions/C2-relay-credential-source.md`。

---

## 决策一：B3 — 内置运行时（node/python/ffmpeg/chromium）的物料从哪里来？

**为什么卡**：代码已写好（锁文件 + 拼合/校验脚本 + 只从 `runtimes/` 解析的 resolver），但**没有任何机制把这些二进制字节放进仓库或装进安装包**。`runtimes/` 被 gitignore（随包分发，不入仓）。在来源敲定前，`tauri build` 无法产出可用桌面包。

**现状事实**：`runtime-lock.json` 把 4 个运行时定义得很完整，但只有 `chrome.dll` 带了可分片提交闭环；**node / python / ffmpeg 完全没有任何 in-repo 获取机制**（ffmpeg 的 `source` 还是内部仓库哈希，外部不可复现）。

**三个候选**（详细权衡见决策文档）：

| 方案 | 一句话 | 对零服务器 | 主要代价 |
|---|---|---|---|
| **A** 外部下载脚本 | build/dev 期从镜像拉取并切分片 | 中性（仅灌装联网） | 构建须联网、供应链信任、镜像可用性 |
| **B** CI 制品 | CI 构建后挂发布附件，`runtime:prepare` 从 release 拉取 | 中性偏正 | 需发布流水线、制品 >1GB 占存储 |
| **C** 安装器附带 | installer crate 把 `runtimes/` 打进安装包 | **最契合**（离线、随包） | 安装包 >1.5GB、运行时更新绑 App 发版、installer 改造量大 |

**架构建议**：长期目标 **C**，落地路径先用 **B**（顺带解决 ffmpeg 内部源不可达），**A** 仅留作开发者本地 fallback。

**🟢 产品拍板：采纳 B→C。** 离线安装为硬要求（见答复 2），C 是终态；但 v1 交付优先，先用 B 跑通 CI 制品链路解除构建阻塞，installer 改造就绪后平滑迁移到 C。ffmpeg 同步切换为公开可下载产物（答复 1），B 的 CI 灌装不再依赖内网。

**✅ 产品答复（B3）**
1. **ffmpeg 改为可公开下载的构建产物**（锁定版本 + sha256），不再依赖内部仓库提交哈希。内部源不作为 CI 依赖——外部可复现优先，避免构建链路绑定内网环境。
2. **离线安装是硬要求。** 零服务器定位承诺"装完即用、运行期无网络依赖"，air-gapped 环境必须可用。→ 长期必选 **C**，**A 不作为官方构建主路径**（仅保留为开发者本地 fallback）。
3. **接受单安装包 >1.5GB。** v1 不做分卷/在线下载器——在线下载器违背离线硬要求；体积优化（分卷/差量）列入 v1 之后体验优化项。
4. **运行时跟随 App 版本发**，不做独立热更。运行时升级属低频事件，随版本发布可接受；热更机制复杂度与收益不匹配。
5. **信任基线：sha256 对齐为硬门槛，CI 制品（方案 B）叠加 minisign 签名**（复用 `plugin_security.rs` 现有能力，不新增基础设施）。
6. **是，立即提交 `chrome.dll` 5 个分片到 `runtime-parts/`，并启用 Git LFS 管理该目录**（285MB 二进制直接入仓会拖垮克隆体验）。提交后 chromium 缺口关闭，阻塞面从 4 减到 3。

---

## 决策二：C2 — client 网页插件的 AI 能力（llm/image/video/audio）凭据从哪来？

**为什么卡**：client HTML 插件（如内置 `notes`）声明 `llm.chat` 后，调用落到网关 `NotSupported`——因为 relay 凭据（`api_base`+`auth_token`）当前**只注入给 nodejs/python 进程，从不进入 iframe**。这是真实功能阻塞（`notes` 的 AI 摘要今天直接失败）。

**现状事实**：`BridgeSession`（持 relay 凭据 + 逐能力 `allow_*` 标志）只在 `plugin_script.rs:577` / `plugin_runner.rs:1629` 注册；client 路径从无 session。

**四个候选**：

| 方案 | 一句话 | 对零服务器 | 主要代价 |
|---|---|---|---|
| **A** 应用设置配凭据 | 用户在设置填 relay token，宿主注入 session | 张力最小（凭据用户显式提供） | 非零配置、体验门槛 |
| **B** 平台登录态 | 账号登录下发 token | **高**（引入账号概念，动摇无后端叙事） | 登录/刷新全链路 |
| **C** 宿主代理命令 | 新增 `client_llm_chat` 等 host 命令，凭据**不进 iframe** | 同 A/B（仍壳直连 relay），但沙箱最干净 | 需新增 host 命令 |
| **D** 保持 NotSupported | client 不提供 AI，需 AI 的插件改 nodejs/python | **无**（唯一保纯度方案） | 限制 client 插件，`notes` AI 不可用 |

**架构建议**：默认 **C 建立在 A 之上**（凭据取自应用设置，client AI 经宿主代理命令、iframe 不持凭据）。若产品明确"零服务器纯度优先于 client AI"，则退回 **D**；**B** 仅在已规划平台账号体系时纳入。

**🟢 产品拍板：采纳 C-on-A。** client AI 是内置 `notes` 等插件的核心卖点，不接受 D；不引入平台账号体系（B 出局，守住零服务器叙事）；凭据由用户在应用设置显式配置（A），client 调用一律经宿主代理命令、iframe 永不持凭据（C）。

**✅ 产品答复（C2）**
1. **token 来源：用户手动配置（A）。** 不引入平台账号概念；设置页提供 relay `api_base` + `auth_token` 配置入口，未配置时 client AI 优雅降级为"请在设置中配置"。
2. **禁止 client 直连 relay，走 C。** 新增 host 代理命令（`client_llm_chat` 等）排入当前迭代，凭据不进 iframe，复用 capability 网关做声明校验。
3. **不接受 D。** client 无 AI 能力会砍掉 `notes` AI 摘要等已规划功能，产品价值损失大于沙箱纯度收益——且 C 方案下沙箱纯度并无实质损失。
4. **计费/配额归属：按设置中配置的 token 归属账户计费**，与 nodejs/python 路径同一套灵石计费模型，不为 client 路径单独建账。配额超限的错误需透传到 iframe 并给出可读提示。

---

## 决策记录（已拍板）

| 决策项 | 选项 | 决策者 | 日期 | 依据 |
|---|---|---|---|---|
| **B3** runtime 物料来源 | [ ] A [ ] B [ ] C [x] **B→C** | 产品负责人 | 2026-08-22 | 离线安装为硬要求 → C 为终态；v1 交付优先 → 先以 B（CI 制品）解除构建阻塞；ffmpeg 改公开产物，CI 不依赖内网；sha256 硬门槛 + CI 制品 minisign 签名 |
| B3 即时动作：提交 chrome.dll 分片 | [x] **是** [ ] 否 | 产品负责人 | 2026-08-22 | 立即关闭 chromium 缺口（阻塞面 4→3）；`runtime-parts/` 启用 Git LFS 管理 |
| **C2** client AI 凭据来源 | [ ] A [ ] B [ ] C [x] **C-on-A** [ ] D | 产品负责人 | 2026-08-22 | client AI 是 notes 等插件核心卖点，D 出局；不引入账号体系，B 出局；凭据用户设置显式配置（A）+ 宿主代理命令、iframe 不持凭据（C）；计费按配置 token 归属 |

---

### 备注
- 两项决策**互不影响**，可分别排期执行。
- 在决策落地前，相关代码块已以 `NotSupported` / 跳过方式优雅降级（不崩溃、不挂起），不影响已交付的 client 运行容器、能力注册表、client-action 桥等功能的单测与 CI。
- 另：A5a/A5b（内置 notes + 安装插件端到端）的桌面壳实操验证手册已就绪（`docs/verify-a5-client-plugin-e2e.md`），待 WebView2 + cargo 环境即可一键验证。

### 拍板后行动项（排期建议）

| # | 行动 | 归属决策 | 优先级 |
|---|---|---|---|
| 1 | `chrome.dll` 5 分片提交 `runtime-parts/`，配置 Git LFS | B3 | P0（立即） |
| 2 | ffmpeg `source` 改公开下载产物，回填 lock 的 sha256/size | B3 | P0 |
| 3 | 搭建 CI 制品链路：`runtime:prepare` 从 release 附件拉取 + minisign 签名 | B3 | P1 |
| 4 | installer crate 改造，迁移至 C（安装器注入 `runtimes/`） | B3 | P2（v1 后） |
| 5 | 应用设置页新增 relay 凭据配置入口 + 未配置降级文案 | C2 | P1 |
| 6 | 新增 `client_llm_chat` 等 host 代理命令，接入 capability 网关 | C2 | P1 |
