# H2: 平台范围——v1 仅支持 Windows

> 状态：✅ 已拍板（2026-08-24）。代码与文档现状均与「v1 = Windows-only」一致；跨平台为明确推迟项。
> 范围：千匣台（my-treasure）Tauri v2 桌面端 `apps/desktop` 及其安装器 `apps/desktop/installer`
> 关联决策：B3（bundled runtime 物料来源）、IMPLEMENTATION_PLAN / IMPROVEMENT_PLAN 中 H2 条目

---

## 决策（Decision）

v1 明确**只支持 Windows**，暂不提供 macOS / Linux 构建与分发。理由：本产品是一个本地优先的桌面壳，其架构深度绑定 Windows 专属能力栈——Tauri v2 在 Windows 上以 **WebView2（Edge 内核）** 渲染前端，进程插件用 **Windows Job Object** 做进程树围栏，安装器是自解压的 **Windows PE/exe**（嵌入 VERSIONINFO 资源、依赖 `rc.exe` 工具链），并自带基于 `windows-sys` 的注册表 / 快捷方式 / 圆角窗口等 Windows 专属逻辑。上述每一项在 macOS / Linux 上都需要不同的底层机制（WebKit、cgroup/posix fences、`.dmg`/`.AppImage` + `pkgbuild`、macOS `Security`/`NSWorkspace`）。在 v1 阶段投入跨平台适配会稀释「本地插件平台」这一核心交付，因此**跨平台显式推迟**，待 Windows 闭环与生态信任根（签名）就绪后再评估。

---

## 移植最硬骨头清单（Hardest-porting checklist）

> 下面四项是从 WORK_ORDER 点名的「硬骨头」，均经实际代码核对。每一项均给出：是什么、代码位置（文件 + 符号）、移植难点一句话。

| # | 硬骨头 | 是什么 | 代码位置（已核对） | 移植难点 |
|---|--------|--------|--------------------|----------|
| 1 | **Job Object 沙箱** | 进程插件的 OS 级围栏：创建 Job Object，设 `KILL_ON_JOB_CLOSE`（句柄关闭即杀整棵进程树）、`DIE_ON_UNHANDLED_EXCEPTION`（单进程崩溃不拖垮其他）、**不设** `BREAKAWAY_OK`（子进程无法逃逸 Job）；`Drop` 关句柄即触发清理。Unix 仅有 `prctl(PR_SET_PDEATHSIG)` 退化实现，不提供真实沙箱。 | `apps/desktop/src-tauri/src/process_util/sandbox.rs`<br>• `struct SandboxHandle`（L24，`#[cfg(windows)]`）<br>• `SandboxHandle::create()`（L38，`CreateJobObjectW` + `SetInformationJobObject`，L52-57 定义 flags）<br>• `assign_process()`（L81，`AssignProcessToJobObject`）<br>• `impl Drop`（L120，关句柄触发 KILL_ON_JOB_CLOSE）<br>• Unix stub（L134-156，注释承认「完整沙箱需 bubblewrap/firejail，后续独立任务」） | Job Object 是 **Windows 独有**内核对象。macOS/Linux 无对应物，需用 cgroup v2 / `posix_spawn` + `prctl` / bubblewrap 等重写整段沙箱语义，且 Tier-2 边界（生命周期围栏，非安全边界）的保证在不同平台上强度不一致。 |
| 2 | **SFX 自解压安装器** | 三合一安装/更新/卸载器。把 app 文件追加到 `installer.exe` 尾部，运行时读自身 exe → 解析 12 字节 trailer（`MAGIC + payload_len`）→ 用 `SegmentReader` 把 `[offset, offset+payload_len)` 映射为流式 `Read+Seek` 视图 → `zip` crate 解压（支持 >1.5GB payload，避免 OOM）。拼接由 Node 脚本完成。 | `apps/desktop/installer/src/sfx.rs`<br>• `MAGIC = b"LFSFX\0\0\0"`（L24）、`TRAILER_LEN=12`（L27）<br>• `struct SegmentReader`（L101，`Read`/`Seek` 实现 L117/L131）<br>• `locate_payload()`（L85）、`extract_payload()`（L159）<br>• `apps/desktop/build-installer.mjs`（拼接逻辑：L154-176 写 trailer；L132 用 Windows `tar` 打包 payload.zip）<br>• 调用点 `apps/desktop/installer/src/modes/deploy.rs:28` | 该格式假定 PE/exe 尾部可任意追加字节并被原样读回（PE 不校验整体长度），且 `build-installer.mjs` 直接依赖 **Windows 内置 `tar`** 与 `.exe` 产物名。macOS/Linux 需改为 `.dmg`/`.AppImage`/`pkgbuild`，流式尾部格式与拼接脚本要整体替换；自删除、注册表式卸载逻辑无对应。 |
| 3 | **WebView2** | Tauri v2 在 Windows 上前端的渲染引擎是 **WebView2（Edge / Chromium 内核）**，并非跨平台 webview；NSIS 安装包内置 WebView2 引导安装段（含中文提示）。E2E 冒烟脚本通过 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 注入 `--remote-debugging-port` 驱动 Playwright CDP。 | • `apps/desktop/src-tauri/tauri.conf.json`：`bundle.targets=["nsis"]`（L14）、`bundle.windows.nsis`（L31-38）、`windowEffects.effects=["mica"]`（L52，mica 为 Windows 11 专属合成效果）<br>• `IMPROVEMENT_PLAN.md:45`：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=...`<br>• 依赖链：`Cargo.lock` 中 `webview2-com` / `webview2-com-sys`（wry 0.55.1 的 `src/webview2/*`）；NSIS 产物 `target/release/nsis/x64/installer.nsi:538` `Section WebView2`（下载/嵌入 bootstrapper、检测 `WEBVIEW2APPGUID`） | WebView2 是 **Windows 专属**。macOS 上 Tauri 改用系统 **WebKit (WKWebView)**，Linux 上改用 **WebKitGTK**；三者 API/行为/调试协议均有差异。`mica` 窗口效果、NSIS 安装包、以及 CDP 调试端口注入方式都要按平台重写；渲染一致性与插件 iframe 行为需重新验证。 |
| 4 | **rc.exe（Windows 资源编译器）** | 安装器在 Windows 构建时通过 `winres` crate 嵌入 `VERSIONINFO` 资源（公司名/产品名/版本/描述），以降低杀软把「匿名自解压 dropper」误判为恶意的概率。`winres` 底层调用 **Windows `rc.exe`** 编译 `.rc`；缺工具链时降级为无资源 exe（不阻断构建）。 | • `apps/desktop/installer/Cargo.toml:50`：`winres = "0.1"`（在 `[target.'cfg(windows)'.build-dependencies]`）<br>• `apps/desktop/installer/build.rs:18` `winres::WindowsResource::new()`；L20-25 `set(...)` 各项；L28 `res.compile()`；L29-30 注释「如缺 rc.exe 工具链——降级为无资源 exe」并 `cargo:warning` | `rc.exe` 是 **Windows SDK 专属**资源编译器，macOS/Linux 无对应物。若移植，安装器需改用各平台原生版本元数据机制（`info.plist` / `.desktop` + `Icon=`），且 `winres` 的 `cfg(windows)` 分支需替换为平台分支或移除。主桌面壳 `src-tauri/build.rs` 未使用 `rc.exe`/`winres`（仅 `tauri_build::build()`），故该项集中在 installer 子 crate。 |

---

## 未能核实 / 需复核项（供主 agent 二次确认）

- **任务描述称 SFX 安装器含「minisign 签名」**：实际核对后，`minisign` 验签**不在 installer 子 crate**，而在主桌面壳 `apps/desktop/src-tauri/src/plugin_security.rs`（`verify_minisign()`，L36；依赖 `minisign-verify = "0.2"`，`Cargo.toml:47`），用于校验 `.qplugin` 包签名。`apps/desktop/installer/` 下无任何 minisign / 签名相关代码——安装器只做 SHA-256 完整性校验（`integrity.rs`）与尾部格式拼接，签名验证发生在宿主侧。本文档已按真实代码描述，未写入「安装器做 minisign 签名」。
- **`rc.exe` 未在仓库源代码中以字面量出现**：仓库内没有任何文件直接写 `rc.exe` 字符串，它是 `winres` 依赖在 Windows 构建时隐式调用的工具链。唯一文字提及 Windows 资源编译的是 `installer/build.rs:29` 的降级注释。其余 `rc.exe` 引用仅见于 `CODEBUDDY.md`（环境说明）与 `README.md`（前置要求），均为文档而非代码。已如实标注，未发明路径。
- **`tauri.conf.json` 未直接出现 `WebView2` 字样**：WebView2 由 Tauri v2 在 Windows 平台隐式选用，配置侧只暴露 `nsis` target 与 `mica` 效果。WebView2 的显式证据已通过 `Cargo.lock`（`webview2-com*`）、NSIS 安装脚本（`installer.nsi` 的 `Section WebView2`）与 `IMPROVEMENT_PLAN.md:45` 的环境变量用法核实。

---

## 结论

v1 锁 Windows 是 deliberate 的范围收敛，不是技术债。四项硬骨头（Job Object、SFX/PE、WebView2、rc.exe/VERSIONINFO）均属「Windows 专属机制」，移植时各自对应一套不同的平台原语，工作量集中在原生 API 重写与分发格式替换，而非业务逻辑。跨平台评估应在 Windows 闭环 + 插件签名信任根就绪后再启动。
