//! 插件持久化运行引擎（task 06-16-plugin-system-rebuild 组B）。
//!
//! 与 plugin_script.rs 的区别：
//! - plugin_script.rs：一次性预览执行（run_plugin_script），捕获 stdout 进 UI，15s 超时 kill，
//!   落盘到临时 plugin-sandbox（运行后 LRU 清理）。
//! - plugin_runner.rs（本模块）：持久化独立进程运行（start_plugin），**detached 不捕获 stdout 进 UI**
//!   （Python GUI 自己弹窗口，Node 输出在它自己的控制台），进程表记录 pid 供软件显示「运行中」+ 强制关闭。
//!
//! 运行流程（PRD 需求 3/5/7/9）：
//! - Python：检测 venv → 不存在则用软件内置 Python 创建 venv → 有 requirements.txt 则装依赖
//!   （优先 `uv pip install --python`，应用未随 uv 时回退 `venv/.../python -m pip install`，清华 PyPI 镜像）
//!   → detached `venv/.../python main.py`。
//!   Windows 下 venv 放在短路径缓存，避免 PySide6 等深层 wheel 触发 260 字符路径限制。
//! - Node：有 package.json + dependencies 则用软件内置 pnpm/npm install（npmmirror）→ detached pnpm/npm start。
//!
//! 进程表集成（与组A plugin_store.rs 协作）：
//! - start_plugin：spawn detached → 内存进程表（PluginProcessTable）记录 Child 句柄（不落 DB，
//!   PRD 需求 2「状态不存 DB」，重启后所有插件从文件系统重判 ready）。
//! - stop_plugin：内存表 take Child → kill_child_tree → wait 回收句柄。
//! - get_plugin_status：查内存表（try_wait 判定），不读文件（实时性高于 scan）。
//! - scan_plugin_status（组A）：扫文件系统判 ready/incomplete/error，调本表 is_running 叠加 running。
//!
//! 安全边界（与 plugin_script.rs 同源留痕）：
//! - 本通道是【不受控执行通道】，绕过 capability 网关（design §6.1）。
//! - 软隔离：plugin_id 段级白名单（plugin_store::sanitize_plugin_id）、路径不穿越 plugins_root。
//! - OS 级硬隔离：Windows Job Object（KILL_ON_JOB_CLOSE）确保进程树围栏，关闭即杀整棵树（sandbox.rs）。
//! - 可逃逸：用户权限运行的脚本可执行 fs.writeFile / child_process / 网络请求（与本地直接 `node main.js` 等价）。
//! - 后续：script.node/script.python capability kind 让本通道也走声明式授权。

use std::collections::{hash_map::DefaultHasher, HashMap};
use std::ffi::OsString;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Manager;

// 复用 code_assistant.rs 的子进程基础设施：
// - run_capture_with_env：带超时的同步运行（用于 venv 创建 / pip install / pnpm install 等阻塞阶段）。
// - kill_child_tree：杀整个进程组/树（含孙进程），供 stop_plugin 复用。
// - minimal_env 不复用 plugin_script.rs 的 pub(crate)（保持组B 自洽，独立构造同款白名单）。
use crate::process_util::{
    kill_child_tree, run_capture_with_env, run_streamed_with_env, CapturedOutput, SandboxHandle,
};
use crate::runtime_resolver::RuntimeResolver;
// 复用组A plugin_store.rs 的 PluginStore（plugins_root 解析 + ensure_plugin_dir + sanitize_plugin_id）。
// 避免重复实现（DRY）：plugin_id 白名单 / canonicalize 前缀断言 / 目录定位全走组A。
use crate::plugin_llm_bridge::{PluginBridgeClientSource, PluginLlmBridge};
// A4：启动插件时把其 manifest 声明的能力注册进 CapabilityRegistry，否则 invoke_capability 对
// 非内置插件恒返回 NotDeclared（仅内置插件在启动期经 load_builtin_plugins_from_dirs 注册过）。
use crate::capability::{expand_path, DeclaredCapability};
use crate::AppState;
use crate::plugin_store::{sanitize_plugin_id, PluginStore};

/// 插件运行时类型（与 plugin_store::PluginRuntime 对齐，serde lowercase）。
/// 仅 nodejs/python 走本模块的独立进程运行通道；client（HTML）由前端 iframe 直接显示，不经此通道。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PluginRuntimeKind {
    Nodejs,
    Python,
}

/// manifest.json 解析后的运行时元信息（仅取本模块运行所需的字段）。
/// 字段宽松：缺 runtime_type 视为 client（前端不调 start_plugin，本结构仅在已判定为 nodejs/python 时构造）。
#[derive(Clone, Debug)]
struct PluginManifest {
    runtime: PluginRuntimeKind,
    entry: String,
    /// 声明的能力（含 fs.* 的 paths 白名单）。A4 起在 start 时注册进 CapabilityRegistry，
    /// 此前仅捕获 kind 字符串会丢失 paths，导致 fs.read/fs.write 即便已声明也因空 paths 落入 OutOfScope。
    capabilities: Vec<DeclaredCapability>,
}

/// 解析 manifest.json 的 runtime_type + entry。
/// - runtime_type 必须是 nodejs/python（client 由前端分流，不应进本通道）。
/// - entry 缺省：python → main.py，nodejs → index.js（与 builtin 示例插件对齐）。
/// - 解析失败（文件缺失/JSON 非法/runtime_type 非法）返回具体错误，供前端展示 error 状态。
/// - 文件不存在（创建期 AI 会话失败/中断残留的空 temp 目录）返回 `manifest_missing:` 前缀，
///   前端据此显示「未生成完成，继续对话补全」引导，而非裸 os error 2。
fn parse_manifest(plugin_dir: &std::path::Path) -> Result<PluginManifest, String> {
    let manifest_path = plugin_dir.join("manifest.json");
    let raw = std::fs::read_to_string(&manifest_path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            // 创建期 temp 目录空（AI 未产出 manifest）：结构化前缀，前端识别后引导重新生成。
            "manifest_missing:插件未生成完成（缺少 manifest.json），请继续对话让 AI 补全或重新创建"
                .to_string()
        } else {
            format!(
                "读取 manifest.json 失败（{}）：{e}",
                manifest_path.display()
            )
        }
    })?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("manifest.json 解析失败：{e}"))?;
    let runtime_str = v.get("runtime_type").and_then(|x| x.as_str()).unwrap_or("");
    let runtime = match runtime_str {
        "nodejs" => PluginRuntimeKind::Nodejs,
        "python" => PluginRuntimeKind::Python,
        other => {
            return Err(format!(
                "manifest runtime_type 不支持独立进程运行（{other:?}，仅 nodejs/python）"
            ))
        }
    };
    let entry = v
        .get("entry")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| match runtime {
            PluginRuntimeKind::Python => "main.py".to_string(),
            PluginRuntimeKind::Nodejs => "index.js".to_string(),
        });
    let capabilities = v
        .get("capabilities")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let kind = item.get("kind").and_then(|kind| kind.as_str())?;
                    let paths = item
                        .get("paths")
                        .and_then(|paths| paths.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|p| p.as_str())
                                .map(expand_path)
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    Some(DeclaredCapability {
                        kind: kind.to_string(),
                        paths,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(PluginManifest {
        runtime,
        entry,
        capabilities,
    })
}

/// 解析插件的持久化目录路径（plugins_root/<plugin_id>，canonicalize 防符号链接逃逸）。
/// 复用组A PluginStore.ensure_plugin_dir（段级白名单 + create_dir_all + canonicalize）。
fn resolve_plugin_dir(store: &PluginStore, plugin_id: &str) -> Result<PathBuf, String> {
    store.ensure_plugin_dir(plugin_id)
}

// === Python venv 管理 ===

/// Python venv directory for a plugin.
/// Windows keeps venvs in a short per-user cache because packages such as PySide6
/// contain very deep wheel paths that can exceed the legacy 260-character limit.
pub(crate) fn python_venv_dir(plugin_dir: &std::path::Path) -> PathBuf {
    #[cfg(windows)]
    {
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        base.join("LingFang")
            .join("python-venvs")
            .join(format!("venv-{:016x}", stable_path_hash(plugin_dir)))
    }
    #[cfg(not(windows))]
    {
        plugin_dir.join(".venv")
    }
}

/// 全局依赖缓存目录（P1-4：跨插件依赖缓存共享）。
///
/// Python pip 和 Node pnpm 共用此目录下的子目录：
/// - `pip-cache/`：pip 下载的 wheel 缓存（PIP_CACHE_DIR），多个插件装同一包时复用。
/// - `pnpm-store/`：pnpm 内容寻址 store（--config.store-dir），多插件共享同一物理包。
///
/// 路径选择与 `python_venv_dir` 对齐（Windows: LOCALAPPDATA/LingFang，Unix: ~/.cache/lingfang），
/// 确保卸载即清（删 LingFang 目录即回收全部缓存）。
pub(crate) fn global_cache_dir() -> PathBuf {
    #[cfg(windows)]
    {
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        base.join("LingFang").join("cache")
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join(".cache")
            .join("lingfang")
    }
}

fn stable_path_hash(path: &std::path::Path) -> u64 {
    let mut hasher = DefaultHasher::new();
    let normalized = path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    normalized.hash(&mut hasher);
    hasher.finish()
}

/// 探测 Python venv 内的解释器绝对路径（按 PRD 需求 3）。
/// - Windows：Scripts/python.exe
/// - Unix：bin/python
pub(crate) fn venv_python(venv_dir: &std::path::Path) -> PathBuf {
    #[cfg(windows)]
    {
        venv_dir.join("Scripts").join("python.exe")
    }
    #[cfg(not(windows))]
    {
        venv_dir.join("bin").join("python")
    }
}

/// 探测 Python 插件是否需要创建 venv（首次慢，已建则 ensure 秒过）。
/// 用于 start_plugin 发「安装依赖」阶段事件（前端据此决定是否展示安装动画）。
/// 判定：venv 内 python 不存在 / pip 缺失 / home 路径与当前运行时不一致 → 需要创建。
fn needs_python_venv(plugin_dir: &std::path::Path, runtime: &RuntimeResolver) -> bool {
    let venv_dir = python_venv_dir(plugin_dir);
    if !venv_python(&venv_dir).is_file()
        || !venv_has_pip(&venv_dir)
        || !venv_home_matches_host(&venv_dir, runtime)
    {
        return true;
    }
    ["uv.lock", "requirements.txt"].iter().any(|name| {
        std::fs::read_to_string(plugin_dir.join(name))
            .ok()
            .map(|content| !deps_verified_matches(&venv_dir, &content))
            .unwrap_or(false)
    })
}

/// 确保 Python 插件有可用 venv（PRD 需求 3 / AC3）。
/// 流程：
/// 1. 检查 venv 是否存在且 venv_python 可执行 → 已就绪直接返回。
/// 2. 不存在 → 使用软件内置 Python → `python -m venv <venv_dir>`（带超时，venv 创建可能慢）。
/// 3. 有 requirements.txt → `venv/.../pip install -r requirements.txt`（带超时，依赖多时较慢）。
/// 4. pip install 后跑 import 冒烟（检测落盘损坏，如 .py 混入 NUL 字节）；损坏则删 venv
///    重建 + 重装 + 再冒烟一次（自愈）。通过则写 `.lfdeps-verified` 标记，下次启动标记命中跳过冒烟。
///
/// 失败处理（PRD Constraints）：venv 创建/pip install 失败返回友好错误（不崩），前端据 error 展示。
pub(crate) fn ensure_python_venv(
    runtime: &RuntimeResolver,
    plugin_dir: &std::path::Path,
    stream: Option<&StreamCtx>,
) -> Result<PathBuf, String> {
    let venv_dir = python_venv_dir(plugin_dir);
    let py = venv_python(&venv_dir);
    let requirements = plugin_dir.join("requirements.txt");
    let requirements_content = std::fs::read_to_string(&requirements).ok();
    let uv_lock = plugin_dir.join("uv.lock");
    let uv_lock_content = std::fs::read_to_string(&uv_lock).ok();

    // 已有 venv 且解释器/pip 存在且 home 路径匹配 → 跳过创建。
    // 路径不匹配时（跨机器迁移 / 安装路径变更 / 原始路径含 junction）自动重建。
    if !py.is_file() || !venv_has_pip(&venv_dir) || !venv_home_matches_host(&venv_dir, runtime) {
        create_python_venv(runtime, plugin_dir, &venv_dir, stream)?;
    }

    if let Some(content) = uv_lock_content.as_deref() {
        if !deps_verified_matches(&venv_dir, content) {
            let uv = runtime.uv().ok_or_else(|| {
                "插件包含 uv.lock，但应用运行时缺少 uv，无法执行冻结安装".to_string()
            })?;
            let mut env = runtime.env(minimal_env());
            env.push((
                std::ffi::OsString::from("UV_PROJECT_ENVIRONMENT"),
                venv_dir.as_os_str().to_os_string(),
            ));
            // P1-4：uv 也共享全局 pip 缓存目录（uv 内部用 pip 兼容的缓存机制）。
            let pip_cache_dir = global_cache_dir().join("pip-cache");
            let _ = std::fs::create_dir_all(&pip_cache_dir);
            env.push((
                std::ffi::OsString::from("UV_CACHE_DIR"),
                pip_cache_dir.as_os_str().to_os_string(),
            ));
            let captured = run_with_optional_stream(
                &uv,
                vec![
                    "sync".to_string(),
                    "--frozen".to_string(),
                    "--project".to_string(),
                    plugin_dir.to_string_lossy().to_string(),
                ],
                Some(&plugin_dir.to_string_lossy()),
                600_000,
                env,
                stream,
            )
            .map_err(|error| format!("uv sync --frozen 失败：{error}"))?;
            if captured.exit_code != Some(0) {
                return Err(format!(
                    "uv sync --frozen 失败（exit={:?}）：{}",
                    captured.exit_code,
                    captured_detail(&captured)
                ));
            }
            write_deps_verified(&venv_dir, content);
        }
        return Ok(py);
    }

    // 有 requirements.txt → 先装依赖再冒烟。装依赖幂等（已装 pip 跳过）；冒烟自愈。
    if let Some(content) = requirements_content.as_deref() {
        // 冷启动快路径：标记命中（上次冒烟通过 + requirements 未变）→ 跳过 pip install + 冒烟。
        if deps_verified_matches(&venv_dir, content) {
            // 标记命中仍需确认 venv python 存在（极端：标记在但 python 被手动删了）。
            if py.is_file() {
                return Ok(py);
            }
        }
        // 装依赖 + 冒烟。冒烟失败 → 删 venv 重建 + 重装 + 再冒烟（自愈一次）。
        install_and_smoke(runtime, plugin_dir, &venv_dir, &py, content, stream).or_else(
            |first_err| {
                // 自愈：删 venv → 重建 → 重装 → 再冒烟。只重试一次（真正损坏/磁盘坏会再次失败）。
                let _ = remove_dir_all_with_retry(&venv_dir);
                create_python_venv(runtime, plugin_dir, &venv_dir, stream)?;
                install_and_smoke(runtime, plugin_dir, &venv_dir, &py, content, stream)
                    .map_err(|retry_err| format!("{first_err}\n重建后仍失败：{retry_err}"))
            },
        )?;
    }
    if !py.is_file() {
        return Err(format!("venv 创建后仍找不到解释器：{}", py.display()));
    }
    Ok(py)
}

/// 选 requirements.txt 的安装命令。
///
/// - 应用内置了 uv（`runtime.uv()` 命中）→ `uv pip install --python <venv-python> -r ...`
///   （快、解析器更宽容、缓存复用好）。
/// - 没有 uv（当前 Windows 制品未随 uv）→ 回退 `<venv-python> -m pip install --no-input -r ...`。
///   venv 由 `create_python_venv` 建好并带 pip（ensurepip 引导），所以一定可执行。
///
/// 这是 requirements.txt 的契约：必须能装，不能因 uv 缺失而直接报错（与 uv.lock 不同——
/// uv.lock 的冻结安装无等价回退，仍由 `ensure_python_venv` 的 uv.lock 分支单独要求 uv）。
///
/// 抽成纯函数便于单元测试：`install_and_smoke` 会真实 spawn 子进程，不便在 CI 里跑 pip。
fn resolve_requirements_install_command(
    runtime: &RuntimeResolver,
    py: &PathBuf,
    requirements_path: &std::path::Path,
) -> (PathBuf, Vec<String>) {
    let requirements_arg = requirements_path.to_string_lossy().to_string();
    if let Some(uv) = runtime.uv() {
        let args = vec![
            "pip".to_string(),
            "install".to_string(),
            "--python".to_string(),
            py.to_string_lossy().to_string(),
            "-r".to_string(),
            requirements_arg,
        ];
        (uv, args)
    } else {
        // 回退：venv python -m pip。--no-input 关闭交互提示（与历史 requirements 装依赖行为一致）。
        let args = vec![
            "-m".to_string(),
            "pip".to_string(),
            "install".to_string(),
            "--no-input".to_string(),
            "-r".to_string(),
            requirements_arg,
        ];
        (py.clone(), args)
    }
}

/// 装依赖 + 冒烟自愈的单次尝试（被 ensure_python_venv 调，失败时由上层删 venv 重试一次）。
/// 步骤：pip install（幂等）→ import 冒烟 → 通过则写标记。冒烟检测到损坏直接返回 Err。
fn install_and_smoke(
    runtime: &RuntimeResolver,
    plugin_dir: &std::path::Path,
    venv_dir: &std::path::Path,
    py: &PathBuf,
    requirements_content: &str,
    stream: Option<&StreamCtx>,
) -> Result<(), String> {
    // requirements.txt 装依赖：优先 uv pip install --python（快、可缓存），uv 未随包时回退到
    // venv 自带 `python -m pip install`（venv 由 create_python_venv 建好并带 pip，详见
    // plugin-runtime-persistence.md 的 Bundled-Only Windows Runtime Boundary 契约）。
    // requirements.txt 必须能装——不能像 uv.lock 那样在缺 uv 时直接报错。
    let requirements_path = plugin_dir.join("requirements.txt");
    let (install_program, install_args) =
        resolve_requirements_install_command(runtime, py, &requirements_path);
    // P1-4：全局 pip 缓存共享。设置 PIP_CACHE_DIR 指向全局缓存目录，
    // 多个插件装同一包时 pip 直接复用已缓存的 wheel，不重复下载。
    let mut env = runtime.env(minimal_env());
    let pip_cache_dir = global_cache_dir().join("pip-cache");
    let _ = std::fs::create_dir_all(&pip_cache_dir);
    env.push((
        std::ffi::OsString::from("PIP_CACHE_DIR"),
        pip_cache_dir.as_os_str().to_os_string(),
    ));
    let captured = run_with_optional_stream(
        &install_program,
        install_args,
        Some(&plugin_dir.to_string_lossy()),
        600_000,
        env,
        stream,
    )
    .map_err(|e| format!("pip install 失败：{e}"))?;
    if captured.exit_code != Some(0) {
        return Err(format!(
            "pip install 失败（exit={:?}）：{}",
            captured.exit_code,
            captured_detail(&captured),
        ));
    }
    // import 冒烟：检测落盘损坏（.py 混入 NUL 字节 / 坏 C 扩展等）。
    match smoke_test_venv(py, venv_dir, requirements_content, runtime, stream) {
        Ok(true) => {
            write_deps_verified(venv_dir, requirements_content);
            Ok(())
        }
        Ok(false) => {
            // 超时/启动失败等不确定情况：放过（不当坏包误删），写标记以便下次跳过。
            write_deps_verified(venv_dir, requirements_content);
            Ok(())
        }
        Err(e) => Err(e),
    }
}

fn venv_has_pip(venv_dir: &std::path::Path) -> bool {
    let windows_pip = venv_dir.join("Lib").join("site-packages").join("pip");
    if windows_pip.is_dir() {
        return true;
    }
    let lib_dir = venv_dir.join("lib");
    let Ok(entries) = std::fs::read_dir(lib_dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let name = entry.file_name().to_string_lossy().to_string();
        name.starts_with("python") && entry.path().join("site-packages").join("pip").is_dir()
    })
}

// === venv 完整性自愈：pip 装出的包可能被杀软/磁盘残缺写坏（典型：streamlit 的 .py 混入
// NUL 字节 → `python -m streamlit` 在 runpy 解析阶段抛 SyntaxError: source code string
// cannot contain null bytes，退出码 1，但平台 venv 逻辑只看 python.exe 是否存在 + pip install
// 是否幂等成功（exit 0），永远检测不到这种落盘后损坏，导致死锁：只能手动删 venv。
// 自愈：venv 就绪后做一次 import 冒烟（import requirements.txt 里的关键依赖），坏包能被
// importlib 捕获 → 删 venv 重建 + 重装 → 再冒烟一次。通过则写 `.lfdeps-verified` 标记
// （内容 = requirements 哈希 + salt），下次启动标记匹配就跳过冒烟（保持冷启动秒过）。

/// smoke test 标记的 salt：venv 内部 ABI 等不纳入判定，requirements 变了才重测。
const DEPS_VERIFIED_SALT: &str = "v1";

/// 已知「PyPI 包名 ≠ import 名」的映射。requirements.txt 里的名字是 PyPI distribution 名，
/// import 冒烟需要真正的 import 名。覆盖实际遇到的；未列出的用 normalization 兜底。
fn dist_to_import_name(dist: &str) -> Option<&'static str> {
    match dist.to_ascii_lowercase().as_str() {
        "pillow" => Some("PIL"),
        "opencv-python" | "opencv-python-headless" | "opencv-contrib-python" => Some("cv2"),
        "opencv-python-rolling" => Some("cv2"),
        "pyyaml" => Some("yaml"),
        "beautifulsoup4" => Some("bs4"),
        "python-magic" => Some("magic"),
        "python-dotenv" => Some("dotenv"),
        "pyjwt" => Some("jwt"),
        "scikit-learn" => Some("sklearn"),
        "scikit-image" => Some("skimage"),
        "google-api-python-client" => Some("googleapiclient"),
        "google-cloud-storage" => Some("google.cloud.storage"),
        "psycopg2-binary" | "psycopg2" => Some("psycopg2"),
        "pyobjc-core" | "pyobjc" => None, // 平台特定，跳过
        _ => None,
    }
}

/// 把 distribution 名标准化为候选 import 名（处理 `-`/`_` → 去版本/环境标记）。
/// 仅做 normalization：去掉 `>=`/`==` 等版本约束与 `;` extras，把 `-`/`.` 换 `_`。
fn normalize_import_name(raw: &str) -> String {
    // 去掉版本约束（pip requirement 语法）：`pkg>=1.0,<2` → `pkg`；`pkg[extra]` → `pkg`。
    let no_version = raw
        .split(['>', '<', '=', '!', '~', ';', '['])
        .next()
        .unwrap_or("")
        .trim();
    no_version.replace(['-', '.'], "_")
}

/// 解析 requirements.txt 提取顶层 distribution 名（忽略注释/空行/-r/-e/--option/URL 行）。
/// 返回原始 distribution 名（未标准化，供 dist_to_import_name 匹配）。
fn parse_requirements_dist_names(content: &str) -> Vec<String> {
    let mut names = Vec::new();
    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // 跳过 pip 指令行（-r / -e / --index-url / -c 等）。
        if line.starts_with('-') {
            continue;
        }
        // 跳过 editable / 直接路径 / git+URL（含 `://` 或 `@ git` 或以路径分隔符开头）。
        if line.contains("://") || line.starts_with('.') || line.contains("@ ") {
            continue;
        }
        // 去掉 environment marker（`;`）和 extras（`[`）后取 distribution 名部分。
        let name_part = line.split([';', '[']).next().unwrap_or("").trim();
        // 去掉版本约束。
        let name = name_part
            .split(['>', '<', '=', '!', '~'])
            .next()
            .unwrap_or("")
            .trim();
        if name.is_empty() {
            continue;
        }
        names.push(name.to_string());
    }
    names
}

/// 把 distribution 名映射为冒烟要 import 的模块名（优先用已知映射表，否则标准化兜底）。
fn smoke_import_names(dist_names: &[String]) -> Vec<String> {
    let mut result = Vec::with_capacity(dist_names.len());
    for dist in dist_names {
        if let Some(known) = dist_to_import_name(dist) {
            result.push(known.to_string());
        } else {
            let normalized = normalize_import_name(dist);
            if !normalized.is_empty() {
                result.push(normalized);
            }
        }
    }
    result.sort();
    result.dedup();
    result
}

/// 计算 requirements.txt 内容 + salt 的指纹，用于 `.lfdeps-verified` 标记比对。
/// requirements 变了 / salt 变了（逻辑升级）→ 标记失效 → 重跑冒烟。
fn deps_fingerprint(requirements_content: &str) -> String {
    let mut hasher = DefaultHasher::new();
    requirements_content.hash(&mut hasher);
    DEPS_VERIFIED_SALT.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// `.lfdeps-verified` 标记文件路径（与 venv 同目录，venv 重建时随之消失）。
fn deps_verified_marker(venv_dir: &std::path::Path) -> PathBuf {
    venv_dir.join(".lfdeps-verified")
}

/// 标记是否命中（venv 存在 + 标记内容 == 当前 requirements 指纹）。
fn deps_verified_matches(venv_dir: &std::path::Path, requirements_content: &str) -> bool {
    let expected = deps_fingerprint(requirements_content);
    std::fs::read_to_string(deps_verified_marker(venv_dir))
        .map(|actual| actual.trim() == expected)
        .unwrap_or(false)
}

/// 写 `.lfdeps-verified` 标记（冒烟通过后调用）。
fn write_deps_verified(venv_dir: &std::path::Path, requirements_content: &str) {
    let _ = std::fs::write(
        deps_verified_marker(venv_dir),
        deps_fingerprint(requirements_content),
    );
}

/// 生成冒烟测试 Python 脚本：逐个 `importlib.import_module`，捕获异常分类。
/// 只把「文件损坏类」异常（SyntaxError/ValueError "null bytes"/OSError/UnicodeDecodeError）
/// 当作 venv 损坏信号；ModuleNotFoundError（包名≠import名/可选依赖缺失）和其他运行期异常
/// 都放过（不当坏包误判）。脚本退出码：0 = 干净，2 = 检测到损坏（stderr 打印坏包名+原因）。
fn build_smoke_script(import_names: &[String]) -> String {
    // 把 import 名序列化进脚本（用 repr 安全转义）。脚本逻辑独立于 Rust 运行时，便于单测。
    let names_literal = format!(
        "[{}]",
        import_names
            .iter()
            .map(|n| format!("{n:?}"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    format!(
        r#"import importlib, sys, traceback
names = {names_literal}
corrupt = []
for name in names:
    try:
        importlib.import_module(name)
    except ModuleNotFoundError:
        # 包名与 import 名不一致 / 可选依赖缺失 → 不是损坏，跳过。
        pass
    except ImportError as e:
        # import 自身失败但不是「找不到模块」：可能是坏 C 扩展（ImportError 但有 DLL 加载失败）。
        # 仅当异常链指向 OSError / ValueError(null bytes) 时才算损坏。
        msg = str(e).lower()
        cause = "".join(traceback.format_exception(type(e), e, e.__traceback__)).lower()
        if "null byte" in cause or "null byte" in msg or "errno" in cause and "oserror" in cause:
            corrupt.append((name, repr(e)))
        # 其余 ImportError（如缺 DLL 但文件完好）不当坏包。
    except (SyntaxError, ValueError, OSError, UnicodeDecodeError) as e:
        # 文件内容损坏（NUL 字节 / 残缺 .py / 坏 C 扩展）→ 明确是 venv 损坏信号。
        corrupt.append((name, repr(e)))
    except BaseException:
        # 其它运行期异常（包 import 时执行了网络/IO）不当坏包。
        pass
if corrupt:
    for name, reason in corrupt:
        sys.stderr.write("CORRUPT:" + name + " " + reason + "\n")
    sys.exit(2)
sys.exit(0)
"#
    )
}

/// 对已就绪 venv 跑 import 冒烟。返回 Ok(true) 干净 / Ok(false) 超时（放过，不当坏）。
/// Err(String) = 检测到损坏（含坏包名+原因），调用方应删 venv 重建。
fn smoke_test_venv(
    py: &PathBuf,
    venv_dir: &std::path::Path,
    requirements_content: &str,
    runtime: &RuntimeResolver,
    stream: Option<&StreamCtx>,
) -> Result<bool, String> {
    let dist_names = parse_requirements_dist_names(requirements_content);
    let import_names = smoke_import_names(&dist_names);
    if import_names.is_empty() {
        return Ok(true); // 无依赖可测，视为干净。
    }
    let script = build_smoke_script(&import_names);
    // 写入 venv 内临时文件（venv 目录可写），运行后删除。
    let script_path = venv_dir.join(".lf-smoke.py");
    if let Err(_e) = std::fs::write(&script_path, &script) {
        // 写脚本失败（venv 只读？）不当坏包，放过。
        return Ok(true);
    }
    let captured = run_with_optional_stream(
        py,
        vec![script_path.to_string_lossy().to_string()],
        None,
        60_000,
        runtime.env(minimal_env()),
        stream,
    );
    let _ = std::fs::remove_file(&script_path);
    match captured {
        Ok(out) => {
            if out.exit_code == Some(0) {
                Ok(true)
            } else if out.timed_out {
                // 冒烟超时（某个包 import 时卡网络/重初始化）→ 不当坏，放过避免误删。
                Ok(false)
            } else if out.exit_code == Some(2) {
                // 检测到损坏。
                let detail = if out.stderr.trim().is_empty() {
                    "未知包".to_string()
                } else {
                    out.stderr.trim().to_string()
                };
                Err(format!("venv 依赖损坏：{detail}"))
            } else {
                // 其它退出码（罕见，如 import 名拼写导致非 2 退出）→ 放过。
                Ok(false)
            }
        }
        Err(_) => Ok(false), // 启动失败不当坏（极端情况放过）。
    }
}

/// 校验已有 venv 的 pyvenv.cfg 中 `home` 路径是否与当前内置 Python 所在目录匹配。
/// 不匹配时（例如应用安装路径变更、跨机器迁移、原始路径含 junction/symlink），
/// 该 venv 不可用，需重建。
fn venv_home_matches_host(venv_dir: &std::path::Path, runtime: &RuntimeResolver) -> bool {
    let host_py = match runtime.python() {
        Some(path) => path,
        None => return false,
    };
    let host_home = match host_py.parent() {
        Some(parent) => normalize_for_comparison(parent),
        None => return false,
    };
    let cfg_path = venv_dir.join("pyvenv.cfg");
    let content = match std::fs::read_to_string(&cfg_path) {
        Ok(c) => c,
        Err(_) => return false,
    };
    for line in content.lines() {
        if let Some(value) = line.strip_prefix("home = ") {
            let venv_home = normalize_for_comparison(std::path::Path::new(value.trim()));
            return venv_home == host_home;
        }
    }
    false
}

/// 路径归一化：strip `\\?\` 前缀，统一分隔符为反斜杠，去除末尾分隔符，大小写不敏感。
fn normalize_for_comparison(path: &std::path::Path) -> String {
    let s = path.to_string_lossy().to_string();
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
    s.replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

/// 把入口绝对路径转为可安全传给 node/python 子进程的字符串。
///
/// 关键：ensure_plugin_dir 返回 canonicalize 后的路径，Windows 上带 `\\?\` 扩展长度前缀。
/// 直接把这个字符串作为参数传给 node（如 `node "\\?\C:\...\index.js"`）会导致 node 在
/// internal/modules/run_main 阶段 lstat 失败（报 `lstat 'C:'`）而崩溃——node 无法正确解析
/// 该 verbatim 前缀路径。这里 strip 掉 `\\?\` 前缀，恢复普通 `C:\...` 形态。
/// （与上方 normalize_for_comparison 同款 strip，但保留原大小写与分隔符，仅去前缀。）
pub(crate) fn entry_arg(entry_abs: &std::path::Path) -> String {
    let s = entry_abs.to_string_lossy().to_string();
    s.strip_prefix(r"\\?\")
        .map(|rest| rest.to_string())
        .unwrap_or(s)
}

fn create_python_venv(
    runtime: &RuntimeResolver,
    plugin_dir: &std::path::Path,
    venv_dir: &std::path::Path,
    stream: Option<&StreamCtx>,
) -> Result<(), String> {
    let host_py = runtime.require_runtime_command("python")?;
    // 上一次失败可能留下半截 venv（尤其 ensurepip 失败后 Scripts/python.exe 已存在但 pip 不完整）。
    // 重新创建前清理目录，避免 Python venv 复用坏状态。
    if venv_dir.exists() {
        remove_dir_all_with_retry(venv_dir)?;
    }
    let venv_args = vec![
        "-m".to_string(),
        "venv".to_string(),
        "--clear".to_string(),
        venv_dir.to_string_lossy().to_string(),
    ];
    let captured = run_with_optional_stream(
        &host_py,
        venv_args,
        Some(&plugin_dir.to_string_lossy()),
        300_000,
        runtime.env(minimal_env()),
        stream,
    )
    .map_err(|e| format!("创建 venv 失败：{e}"))?;
    if captured.exit_code == Some(0) && venv_has_pip(venv_dir) {
        return Ok(());
    }

    let primary_error = if captured.exit_code == Some(0) {
        "标准 venv 创建完成但未检测到 pip".to_string()
    } else {
        format!(
            "标准 venv 创建失败（exit={:?}）：{}",
            captured.exit_code,
            captured_detail(&captured),
        )
    };
    let _ = remove_dir_all_with_retry(venv_dir);
    create_python_venv_without_pip(runtime, plugin_dir, venv_dir, stream)
        .map_err(|fallback_error| format!("{primary_error}\n备用创建也失败：{fallback_error}"))
}

fn create_python_venv_without_pip(
    runtime: &RuntimeResolver,
    plugin_dir: &std::path::Path,
    venv_dir: &std::path::Path,
    stream: Option<&StreamCtx>,
) -> Result<(), String> {
    let host_py = runtime.require_runtime_command("python")?;
    let venv_args = vec![
        "-m".to_string(),
        "venv".to_string(),
        "--without-pip".to_string(),
        "--clear".to_string(),
        venv_dir.to_string_lossy().to_string(),
    ];
    let captured = run_with_optional_stream(
        &host_py,
        venv_args,
        Some(&plugin_dir.to_string_lossy()),
        300_000,
        runtime.env(minimal_env()),
        stream,
    )
    .map_err(|e| format!("创建无 pip venv 失败：{e}"))?;
    if captured.exit_code != Some(0) {
        let _ = remove_dir_all_with_retry(venv_dir);
        return Err(format!(
            "创建无 pip venv 失败（exit={:?}）：{}",
            captured.exit_code,
            captured_detail(&captured),
        ));
    }

    let venv_py = venv_python(venv_dir);
    let Some(wheel_dir) = bundled_pip_wheel_dir(runtime) else {
        let _ = remove_dir_all_with_retry(venv_dir);
        return Err("未找到内置 pip wheel，无法为 Python venv 安装 pip".to_string());
    };
    let pip_args = vec![
        "-m".to_string(),
        "pip".to_string(),
        "--python".to_string(),
        venv_py.to_string_lossy().to_string(),
        "install".to_string(),
        "--no-index".to_string(),
        "--find-links".to_string(),
        wheel_dir.to_string_lossy().to_string(),
        "--upgrade".to_string(),
        "pip".to_string(),
    ];
    let captured = run_with_optional_stream(
        &host_py,
        pip_args,
        Some(&plugin_dir.to_string_lossy()),
        300_000,
        runtime.env(minimal_env()),
        stream,
    )
    .map_err(|e| format!("安装 venv pip 失败：{e}"))?;
    if captured.exit_code != Some(0) {
        let _ = remove_dir_all_with_retry(venv_dir);
        return Err(format!(
            "安装 venv pip 失败（exit={:?}）：{}",
            captured.exit_code,
            captured_detail(&captured),
        ));
    }
    if !venv_has_pip(venv_dir) {
        let _ = remove_dir_all_with_retry(venv_dir);
        return Err("安装 venv pip 后仍未检测到 pip".to_string());
    }
    Ok(())
}

fn bundled_pip_wheel_dir(runtime: &RuntimeResolver) -> Option<PathBuf> {
    let python_dir = runtime.python_dir()?;
    [
        python_dir.join("Lib").join("ensurepip").join("_bundled"),
        python_dir.to_path_buf(),
    ]
    .into_iter()
    .find(|dir| contains_pip_wheel(dir))
}

fn contains_pip_wheel(dir: &std::path::Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        name.starts_with("pip-") && name.ends_with(".whl") && entry.path().is_file()
    })
}

fn captured_detail(captured: &crate::process_util::CapturedOutput) -> String {
    let stderr = captured.stderr.trim();
    if !stderr.is_empty() {
        return stderr.to_string();
    }
    let stdout = captured.stdout.trim();
    if !stdout.is_empty() {
        return stdout.to_string();
    }
    "未返回详细错误".to_string()
}

/// 最小白名单环境变量（与 plugin_script.rs::minimal_env 同语义，避免泄漏宿主 token/密钥到插件进程）。
/// 本模块独立构造（不依赖 plugin_script.rs 的 pub(crate) 导出，保持模块自洽）。
pub(crate) fn minimal_env() -> Vec<(OsString, OsString)> {
    let keys = [
        "PATH",
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "SystemRoot",
        "TEMP",
        "TMP",
        "LANG",
        "LC_ALL",
    ];
    keys.iter()
        .filter_map(|key| std::env::var_os(key).map(|value| (OsString::from(key), value)))
        .collect()
}

// === Node pnpm 管理 ===

const NODE_DEPS_READY_MARKER: &str = ".lingfang-deps-ready";

/// 探测 Node 插件是否需要 pnpm install（首次慢，node_modules 已在则 ensure 秒过）。
/// 用于 start_plugin 发「安装依赖」阶段事件。与 ensure_node_dependencies 的「已装跳过」逻辑对齐：
/// 有 package.json + 非空依赖 且 node_modules 缺失 → 需要安装。
fn needs_node_install(plugin_dir: &std::path::Path) -> bool {
    let pkg_json = plugin_dir.join("package.json");
    if !pkg_json.is_file() {
        return false;
    }
    if plugin_dir
        .join("node_modules")
        .join(NODE_DEPS_READY_MARKER)
        .is_file()
    {
        return false;
    }
    // 仅当声明了非空依赖才真正需要 install（与 ensure_node_dependencies 的 has_deps 判定一致）。
    let Ok(raw) = std::fs::read_to_string(&pkg_json) else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    ["dependencies", "devDependencies"].iter().any(|k| {
        v.get(k)
            .and_then(|x| x.as_object())
            .map(|m| !m.is_empty())
            .unwrap_or(false)
    })
}

/// 确保 Node 插件依赖已安装（PRD 需求 7 / AC8）。
/// 流程：
/// 1. 有 package.json + 非空 dependencies/devDependencies → pnpm install（幂等）。
/// 2. 无 pnpm → 回退 npm install（pnpm 未装时不阻断，降级）。
/// 3. 无 package.json → 返回 Ok（Node 脚本可能裸 index.js 无依赖声明）。
///
/// 失败处理：pnpm/npm install 失败返回友好错误（不崩）。
pub(crate) fn ensure_node_dependencies(
    runtime: &RuntimeResolver,
    plugin_dir: &std::path::Path,
    stream: Option<&StreamCtx>,
) -> Result<(), String> {
    let pkg_json = plugin_dir.join("package.json");
    if !pkg_json.is_file() {
        // 无 package.json 视为裸脚本，跳过安装（pnpm start 无意义，但 start_node_process 会据此报错）。
        return Ok(());
    }
    // 解析是否有依赖声明（空 dependencies 不触发 install）。
    let raw =
        std::fs::read_to_string(&pkg_json).map_err(|e| format!("读取 package.json 失败：{e}"))?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("package.json 解析失败：{e}"))?;
    let has_deps = ["dependencies", "devDependencies"].iter().any(|k| {
        v.get(k)
            .and_then(|x| x.as_object())
            .map(|m| !m.is_empty())
            .unwrap_or(false)
    });
    if !has_deps {
        return Ok(());
    }
    // 只认成功安装标记；失败留下的半成品 node_modules 必须重试。
    if plugin_dir
        .join("node_modules")
        .join(NODE_DEPS_READY_MARKER)
        .is_file()
    {
        return Ok(());
    }
    // 安全网：旧版安装流程曾给 nodejs 插件预建 node_modules 联接到 environments/，
    // pnpm 9.x 在该联接上 mkdir 会 ENOTDIR。若 node_modules 解析到 plugin_dir 之外
    // （联接到 environments/，无论目标是否失效），先移除联接点让 pnpm 以真实目录重建。
    // 真实的 node_modules 目录（canonicalize 后仍在 plugin_dir 内）不受影响。
    let node_modules_path = plugin_dir.join("node_modules");
    let needs_clear_link = match node_modules_path.canonicalize() {
        Ok(resolved) => !resolved.starts_with(plugin_dir),
        Err(_) => true, // 联接目标失效（悬空）
    };
    if needs_clear_link {
        let _ = std::fs::remove_dir(&node_modules_path);
    }
    // 锁文件决定冻结安装器；存在锁文件时不允许退化为普通 install。
    //
    // pnpm 两个独立化 flag（实现「插件环境独立」契约）：
    // - `--ignore-workspace`：插件目录必须当独立项目装，不能被祖先 pnpm-workspace.yaml
    //   吸收成成员（开发态插件在 monorepo 内时，pnpm 会向上找到根 workspace 把整个
    //   monorepo 当项目，触发 "modules 目录将被清空重装" 的交互确认 → 非 TTY 子进程
    //   卡住/exit=1；生产态插件在 app_data 下通常无 workspace.yaml，flag 无副作用）。
    //   依赖照常全装到插件自己的 node_modules/。
    // - `--config.store-dir=<global>/pnpm-store`（P1-4 改为全局共享）：
    //   原为每插件独立 store（<plugin>/data/.pnpm-store），现改为全局 content-addressable
    //   store，多个插件装同一包时 pnpm 自动硬链接复用，不重复下载/存储。
    //   全局 store 路径与 pip 缓存共用 global_cache_dir()，卸载即清。
    let pnpm_store_dir = global_cache_dir().join("pnpm-store");
    let _ = std::fs::create_dir_all(&pnpm_store_dir);
    let pnpm_store_flag = format!(
        "--config.store-dir={}",
        pnpm_store_dir.to_string_lossy()
    );
    let (bin, install_args) = if plugin_dir.join("pnpm-lock.yaml").is_file() {
        let pnpm = runtime
            .pnpm()
            .ok_or_else(|| "插件包含 pnpm-lock.yaml，但应用运行时缺少 pnpm".to_string())?;
        (
            pnpm,
            vec![
                "install".to_string(),
                "--frozen-lockfile".to_string(),
                "--ignore-workspace".to_string(),
                pnpm_store_flag,
            ],
        )
    } else if plugin_dir.join("package-lock.json").is_file() {
        let npm = runtime
            .npm()
            .ok_or_else(|| "插件包含 package-lock.json，但应用运行时缺少 npm".to_string())?;
        (npm, vec!["ci".to_string()])
    } else if let Some(pnpm) = runtime.pnpm() {
        (
            pnpm,
            vec![
                "install".to_string(),
                "--ignore-workspace".to_string(),
                pnpm_store_flag,
            ],
        )
    } else if let Some(npm) = runtime.npm() {
        (npm, vec!["install".to_string()])
    } else {
        return Err("未找到软件内置 pnpm 或 npm，请确认 Node.js 运行时已随应用打包".to_string());
    };
    // install 可能下载大依赖，给 600s 超时。
    let captured = run_with_optional_stream(
        &bin,
        install_args,
        Some(&plugin_dir.to_string_lossy()),
        600_000,
        runtime.env(minimal_env()),
        stream,
    )
    .map_err(|e| format!("依赖安装失败：{e}"))?;
    if captured.exit_code != Some(0) {
        return Err(format!(
            "依赖安装失败（exit={:?}）：{}",
            captured.exit_code,
            captured.stderr.trim()
        ));
    }
    std::fs::write(
        plugin_dir.join("node_modules").join(NODE_DEPS_READY_MARKER),
        b"ready\n",
    )
    .map_err(|error| format!("写入 Node 依赖完成标记失败：{error}"))?;
    Ok(())
}

/// 插件是否声明了 Playwright 依赖（Node 的 package.json 或 Python 的 requirements.txt）。
///
/// 仅做名字匹配（`playwright` / `playwright-core` / `@playwright/test`），不解析版本。
/// 用于决定是否触发浏览器二进制下载——避免给无关插件跑 ~150MB 的 chromium 下载。
/// 与 `needs_node_install` 同款裸 JSON / 文本解析，不引新依赖。
fn declares_playwright(plugin_dir: &std::path::Path) -> bool {
    // Node：package.json 的 dependencies / devDependencies 里键名命中。
    let pkg_json = plugin_dir.join("package.json");
    if let Ok(raw) = std::fs::read_to_string(&pkg_json) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            for k in ["dependencies", "devDependencies"] {
                if let Some(obj) = v.get(k).and_then(|x| x.as_object()) {
                    for name in obj.keys() {
                        if name == "playwright"
                            || name == "playwright-core"
                            || name == "@playwright/test"
                        {
                            return true;
                        }
                    }
                }
            }
        }
    }
    // Python：requirements.txt 里任一行包名命中（容忍版本约束 / 注释）。
    let req = plugin_dir.join("requirements.txt");
    if let Ok(raw) = std::fs::read_to_string(&req) {
        for line in raw.lines() {
            // 取首个 token（剥离注释/空格），再去掉版本比较运算符后缀。
            let mut name = line.split(['=', '<', '>', ';', '#', ' ', '\t']).next();
            name = name.map(|s| s.trim().trim_start_matches('-'));
            if matches!(name, Some("playwright")) {
                return true;
            }
        }
    }
    false
}

/// Playwright 插件只允许使用应用内置 Chromium，不写用户缓存，也不联网下载浏览器。
pub(crate) fn ensure_playwright_browsers(
    runtime: &RuntimeResolver,
    plugin_dir: &std::path::Path,
    _stream: Option<&StreamCtx>,
) -> Result<(), String> {
    if !declares_playwright(plugin_dir) {
        return Ok(());
    }
    let root = runtime.playwright_browsers_dir().ok_or_else(|| {
        "未找到应用内置 Playwright 浏览器目录，安装包可能不完整，请重新安装".to_string()
    })?;
    let revision = crate::runtime_resolver::PLAYWRIGHT_CHROMIUM_REVISION;
    let chromium = root
        .join(format!("chromium-{revision}"))
        .join("chrome-win64")
        .join("chrome.exe");
    let headless = root
        .join(format!("chromium_headless_shell-{revision}"))
        .join("chrome-headless-shell-win64")
        .join("chrome-headless-shell.exe");
    if chromium.is_file() && headless.is_file() {
        return Ok(());
    }
    Err(format!(
        "应用内置 Chromium revision {revision} 不完整或与插件 Playwright 不兼容，请重新安装"
    ))
}

fn node_has_start_script(plugin_dir: &std::path::Path) -> Result<bool, String> {
    let pkg_json = plugin_dir.join("package.json");
    if !pkg_json.is_file() {
        return Ok(false);
    }
    let raw =
        std::fs::read_to_string(&pkg_json).map_err(|e| format!("读取 package.json 失败：{e}"))?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("package.json 解析失败：{e}"))?;
    Ok(v.get("scripts")
        .and_then(|scripts| scripts.get("start"))
        .and_then(|start| start.as_str())
        .map(|start| !start.trim().is_empty())
        .unwrap_or(false))
}

// === 进程表（内存态，供 kill 句柄回收） ===

/// 内存进程表条目：plugin_id → Child 句柄（Arc<Mutex<Option<Child>>> 支持多线程 take/kill）。
/// 复用 code_assistant.rs::processes 的同款结构（Arc<Mutex<HashMap<...>>>）。
///
/// 设计（PRD 需求 2「状态不存 DB」）：运行态仅存内存，不落盘。
/// - 持有 Child 句柄，stop_plugin 经此 kill（必须有句柄才能发信号）。
/// - scan_plugin_status（组A）调 is_running 叠加 running；重启后内存表清空 → 所有插件从文件系统重判 ready。
/// - get_plugin_status 命令直接查本表（try_wait 实时判定，比 scan 更准）。
///
/// Clone：内部仅一个 `Arc<Mutex<...>>`，clone 共享同一张表（仅 bump 引用计数）。
/// 供 `start_*` async 命令把 owned clone move 进 `spawn_blocking` 闭包（State 借用不满足 'static）。
#[derive(Clone, Default)]
pub struct PluginProcessTable {
    /// plugin_id → (Child 共享句柄, SandboxHandle, started_at ISO 字符串)。
    /// SandboxHandle 存活到 take/替换时 drop → Job 句柄关闭 → 整棵进程树被杀（安全网）。
    inner: Arc<Mutex<HashMap<String, (Arc<Mutex<Option<Child>>>, SandboxHandle, String)>>>,
}

impl PluginProcessTable {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 注册新启动的插件进程（若同 plugin_id 已有旧进程，先杀旧再覆盖，避免泄漏）。
    /// 返回 Child 共享句柄的 Arc（供退出监视线程轮询 try_wait，不 take）。
    /// sandbox 的生命周期与进程条目绑定：take/替换时 drop → Job 句柄关闭 → 杀整棵进程树。
    pub(crate) fn register_with_handle(
        &self,
        plugin_id: &str,
        child: Child,
        sandbox: SandboxHandle,
        started_at: String,
    ) -> (u32, Arc<Mutex<Option<Child>>>) {
        let arc = Arc::new(Mutex::new(Some(child)));
        let pid = {
            let guard = arc.lock().unwrap_or_else(|p| p.into_inner());
            guard.as_ref().map(|c| c.id()).unwrap_or(0)
        };
        let mut map = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((old, old_sandbox, _)) =
            map.insert(plugin_id.to_string(), (arc.clone(), sandbox, started_at))
        {
            // 旧进程残留：take + kill_child_tree 回收（防泄漏）。
            if let Some(mut old_child) = old.lock().unwrap_or_else(|p| p.into_inner()).take() {
                kill_child_tree(&old_child);
                let _ = old_child.wait();
            }
            // old_sandbox drop → Job 句柄关闭 → 漏杀的孙进程也被清理。
            drop(old_sandbox);
        }
        (pid, arc)
    }

    /// take 出插件进程（停止时用），返回 (Child, SandboxHandle, started_at) 或 None。
    /// SandboxHandle 由调用方持有，kill_child_tree 后 drop → 双保险杀整棵进程树。
    /// 用 remove 而非 get+cloned：SandboxHandle 非 Clone，remove 拿走所有权。
    fn take(&self, plugin_id: &str) -> Option<(Child, SandboxHandle, String)> {
        let mut map = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let (arc, sandbox, started_at) = map.remove(plugin_id)?;
        let mut guard = arc.lock().unwrap_or_else(|p| p.into_inner());
        guard.take().map(|c| (c, sandbox, started_at))
    }

    /// 查询插件进程是否仍在运行（不 take，仅 try_wait）。
    /// 进程已自然退出时自动清理表条目（保持表收缩，不堆积死亡记录）。
    ///
    /// pub 供组A scan_plugin_status 合并运行态（组A 扫文件系统判 ready/incomplete/error，
    /// 调本方法叠加 running；跨组集成，见 plugin_store.rs scan_plugin_status 命令）。
    pub fn is_running(&self, plugin_id: &str) -> Option<(u32, String)> {
        let arc_started = {
            let map = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            // 只 clone Arc（bump 引用计数）和 String，不 clone SandboxHandle（非 Clone）。
            map.get(plugin_id)
                .map(|(arc, _, started)| (arc.clone(), started.clone()))
        };
        let (arc, started_at) = arc_started?;
        let mut guard = arc.lock().unwrap_or_else(|p| p.into_inner());
        let running_pid = match guard.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(None) => Some(child.id()),
                Ok(Some(_)) | Err(_) => None,
            },
            None => None,
        };
        drop(guard);
        if let Some(pid) = running_pid {
            return Some((pid, started_at));
        }
        // 只删除仍指向本次 Arc 的条目，避免自然退出与同 id 替换并发时误删新进程。
        // Child 由退出监视线程持有的 Arc 回收，该线程仍可观察退出并撤销精确 bridge token。
        let mut map = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if map
            .get(plugin_id)
            .is_some_and(|(current, _, _)| Arc::ptr_eq(current, &arc))
        {
            map.remove(plugin_id);
        }
        None
    }
}

// === Tauri 命令 ===

/// start_plugin 返回值（前端 plugin-status.ts::startPlugin 契约）。
#[derive(Clone, Debug, Serialize)]
pub struct StartPluginResult {
    pub pid: u32,
    pub started_at: String,
}

/// 启动阶段进度事件 payload（emit 到 `plugin:start-progress`，前端渲染分阶段动画）。
/// stage 取值：checking / deps_installing / starting（最终结果由命令返回值交付，不在此事件）。
/// rename_all=camelCase：Tauri emit 事件 payload 不自动转驼峰（仅命令返回值转），
/// 前端过滤 `event.payload.pluginId === pluginId`，故需 serde 显式转驼峰，否则字段恒为 undefined 过滤全失效。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStartProgress {
    pub plugin_id: String,
    pub stage: String,
    pub message: String,
}

/// 插件进程输出事件 payload（emit 到 `plugin:output`，前端日志面板实时显示）。
/// stream: "stdout" | "stderr"；line 是一行文本（不含换行）。
/// 全阶段复用：venv 创建 / pip install / python 运行 的输出都经此事件流到前端。
/// rename_all=camelCase：同 PluginStartProgress，前端按 pluginId 过滤需驼峰。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginOutput {
    pub plugin_id: String,
    pub stream: String,
    pub line: String,
}

/// 插件进程退出事件 payload（emit 到 `plugin:exited`，前端切到 exited 态保留日志面板）。
/// rename_all=camelCase：同 PluginOutput，前端按 pluginId 过滤需驼峰。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginExited {
    pub plugin_id: String,
    pub exit_code: Option<i32>,
    pub stderr_tail: String,
}

/// get_plugin_status 返回值（扩展契约，供前端判定 running/stopped 刷新）。
#[derive(Clone, Debug, Serialize)]
pub struct PluginProcessStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub started_at: Option<String>,
}

/// 流式输出上下文：携带 app 句柄 + plugin_id，供 venv/pip/spawn 各阶段 emit `plugin:output`。
/// 持久化运行（start_plugin_from_dir）传入 Some；创建期预览（plugin_script.rs）传 None（不流式）。
pub(crate) struct StreamCtx {
    pub app: tauri::AppHandle,
    pub plugin_id: String,
}

impl StreamCtx {
    /// 构造 on_line 回调（供 run_streamed_with_env）：每行 emit plugin:output 事件。
    /// 回调 move 进 reader 线程，故返回 Box<dyn FnMut + Send>。
    fn make_line_callback(&self) -> Box<dyn FnMut(&str, bool) + Send + 'static> {
        use tauri::Emitter;
        let app = self.app.clone();
        let plugin_id = self.plugin_id.clone();
        Box::new(move |line: &str, is_stderr: bool| {
            let _ = app.emit(
                "plugin:output",
                PluginOutput {
                    plugin_id: plugin_id.clone(),
                    stream: if is_stderr {
                        "stderr".to_string()
                    } else {
                        "stdout".to_string()
                    },
                    line: line.to_string(),
                },
            );
        })
    }
}

/// 按是否提供 StreamCtx 选择流式/捕获运行。
/// Some(ctx) → run_streamed_with_env（逐行 emit plugin:output）；None → run_capture_with_env（静默）。
fn run_with_optional_stream(
    binary: &PathBuf,
    args: Vec<String>,
    workspace_dir: Option<&str>,
    timeout_ms: u64,
    env: Vec<(OsString, OsString)>,
    stream: Option<&StreamCtx>,
) -> Result<CapturedOutput, String> {
    match stream {
        Some(ctx) => run_streamed_with_env(
            binary,
            args,
            workspace_dir,
            timeout_ms,
            env,
            ctx.make_line_callback(),
        ),
        None => run_capture_with_env(binary, args, workspace_dir, timeout_ms, env),
    }
}

/// strip verbatim `\\?\` 前缀（Windows 扩展长度路径），恢复普通 C:\... 形态。
/// canonicalize 后的路径带此前缀；崩溃转储的复现命令路径需 strip 掉以便用户直接复制执行。
fn strip_verbatim_prefix(s: &str) -> String {
    s.strip_prefix(r"\\?\")
        .map(|rest| rest.to_string())
        .unwrap_or_else(|| s.to_string())
}

/// 崩溃转储文件路径：`<plugin_dir>/data/.crash.log`（覆盖，每次崩溃重写）。
/// 800ms 秒退时写入完整诊断（命令/cwd/env/退出码/stderr），
/// 供用户手动复现 + 排查（远程看不到进程输出时的兜底诊断）。
fn crash_log_path(plugin_dir: &std::path::Path) -> PathBuf {
    plugin_dir.join("data").join(".crash.log")
}

/// 写崩溃转储到 `.crash.log`（覆盖）。best-effort，失败静默。
/// 内容：时间戳、完整命令、cwd、env（脱敏）、退出码、stderr、launcher.log 全文。
fn write_crash_dump(
    plugin_dir: &std::path::Path,
    cmdline: &str,
    cwd: &str,
    env_dump: &[String],
    crash_err: &str,
    stderr_or_log: &str,
) {
    let path = crash_log_path(plugin_dir);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let mut content = String::new();
    content.push_str(&format!("# 灵坊插件崩溃转储（{now}）\n"));
    content.push_str("# 本文件在插件 800ms 内秒退时自动生成，含完整诊断信息。\n");
    content.push_str("# 如需手动复现，在 PowerShell/cmd 中执行下方「复现命令」。\n\n");
    content.push_str(&format!("## 插件目录\n{cwd}\n\n"));
    content.push_str(&format!("## 复现命令\n{cmdline}\n"));
    content.push_str(&format!("（cwd = {cwd}）\n\n"));
    content.push_str(&format!(
        "## 环境变量（{} 项，敏感值已脱敏）\n",
        env_dump.len()
    ));
    for line in env_dump {
        content.push_str(&format!("  {line}\n"));
    }
    content.push_str("\n## 平台诊断\n");
    content.push_str(crash_err);
    content.push_str("\n\n## 进程输出（stderr）\n");
    content.push_str(if stderr_or_log.trim().is_empty() {
        "(空 — 进程未输出任何 stderr，可能是解释器/入口损坏)"
    } else {
        stderr_or_log
    });
    content.push('\n');
    use std::io::Write;
    if let Ok(mut f) = std::fs::File::create(&path) {
        let _ = f.write_all(content.as_bytes());
    }
}

/// 启动流水线日志：`<plugin_dir>/data/.launch.log`（追加，每次启动一段）。
/// 记录 venv/pip/smoke/spawn 各阶段事件 + 错误，便于排查「启动失败但看不到任何信息」。
fn launch_log_path(plugin_dir: &std::path::Path) -> PathBuf {
    plugin_dir.join("data").join(".launch.log")
}

/// 追加一行到启动流水线日志（带时间戳）。失败静默（日志是 best-effort 诊断，不阻断启动）。
fn append_launch_log(plugin_dir: &std::path::Path, msg: &str) {
    let path = launch_log_path(plugin_dir);
    // 确保 data 目录存在（与 write_launcher_ps1 同款）。
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let line = format!("[{now}] {msg}\n");
    // append（create+append）；用 OpenOptions 避免 read+rewrite 的竞态。
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = f.write_all(line.as_bytes());
    }
}

/// 命令：启动插件作为独立进程（PRD 需求 5/7/9 / AC5）。
///
/// 入参 pluginId：插件目录名（plugins_root/<pluginId>/）。
/// runtime 由 manifest.runtime_type 决定（前端 plugin-status.ts 已据此分流，仅 nodejs/python 进本通道）。
///
/// 流程：
/// 1. resolve_plugin_dir（PluginStore.ensure_plugin_dir：白名单 + canonicalize 前缀断言）。
/// 2. parse_manifest（runtime_type 必须是 nodejs/python）。
/// 3. Python：ensure_python_venv（venv + pip install）；Node：ensure_node_dependencies（pnpm install）。
/// 4. spawn detached（Stdio::null，不捕获 stdout 进 UI；GUI 自己弹窗口）。
/// 5. 注册到内存进程表（供 scan_plugin_status / get_plugin_status 判定 running；不落 DB）。
/// 6. 返回 { pid, started_at }。
///
/// 启动阶段事件（前端据此渲染分阶段进度动画，PRD 体验完善需求）：
/// 每个阶段经 app.emit 发 `plugin:start-progress` 事件，payload = { pluginId, stage, message }：
/// - `checking`：正在检查依赖是否已就绪（venv/node_modules 是否存在）。
/// - `deps_installing`：依赖缺失，正在安装（pip install / pnpm install，可能几十秒）。
/// - `starting`：依赖就绪，正在拉起入口进程。
/// 最终结果仍由命令返回值（Ok=pid / Err=错误）交付，事件仅驱动 UI 进度。
#[tauri::command]
pub async fn start_plugin(
    app: tauri::AppHandle,
    store: tauri::State<'_, PluginStore>,
    process_table: tauri::State<'_, PluginProcessTable>,
    bridge: tauri::State<'_, PluginLlmBridge>,
    plugin_id: String,
    api_base: Option<String>,
    auth_token: Option<String>,
) -> Result<StartPluginResult, String> {
    let plugin_dir = resolve_plugin_dir(&store, &plugin_id)?;
    // venv/pip/pnpm 装依赖是长时间阻塞子进程等待，offload 到阻塞线程池避免卡主线程
    // （窗口"未响应" + emit 事件投递不出去）。与 start_installed_plugin 同理。
    let app_handle = app.clone();
    let process_table = process_table.inner().clone();
    let bridge = bridge.inner().clone();
    let plugin_id_for_runner = plugin_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        start_plugin_from_dir(
            &app_handle,
            &process_table,
            &bridge,
            &plugin_id_for_runner,
            plugin_dir,
            api_base,
            auth_token,
        )
    })
    .await
    .map_err(|join_error| format!("插件启动任务异常退出：{join_error}"))?
}

pub(crate) fn start_plugin_from_dir(
    app: &tauri::AppHandle,
    process_table: &PluginProcessTable,
    bridge: &PluginLlmBridge,
    plugin_id: &str,
    plugin_dir: PathBuf,
    api_base: Option<String>,
    auth_token: Option<String>,
) -> Result<StartPluginResult, String> {
    use tauri::Emitter;
    let plugin_id = plugin_id.to_string();
    // 阶段事件辅助：emit 失败不阻断启动（UI 无监听者或通道错误时静默降级为同步等待）。
    let emit_stage = |stage: &str, message: &str| {
        let _ = app.emit(
            "plugin:start-progress",
            PluginStartProgress {
                plugin_id: plugin_id.clone(),
                stage: stage.to_string(),
                message: message.to_string(),
            },
        );
    };

    // 启动流水线日志（追加到 data/.launch.log）：记录每次启动尝试的各阶段 + 错误。
    // 用闭包捕获 plugin_dir（值已 move 进函数），每个关键节点 append 一行。
    let log_launch = |msg: String| append_launch_log(&plugin_dir, &msg);
    log_launch(format!(
        "==== 启动插件 {plugin_id}（目录 {}）====",
        plugin_dir.display()
    ));

    emit_stage("checking", "正在检查插件运行环境…");
    let manifest = parse_manifest(&plugin_dir).map_err(|e| {
        log_launch(format!("manifest 解析失败：{e}"));
        e
    })?;
    // A4：把插件声明的能力注册进 CapabilityRegistry（含 fs.* 的 paths 白名单）。
    // 此前仅内置插件在启动期经 load_builtin_plugins_from_dirs 注册，市场安装/本地插件
    // 启动后 invoke_capability 对它们恒返回 NotDeclared，能力调用全灭。重复注册（内置插件）幂等。
    {
        let registry = app.state::<AppState>();
        registry.registry.register(&plugin_id, manifest.capabilities.clone());
    }
    log_launch(format!(
        "manifest: runtime={:?} entry={}",
        manifest.runtime, manifest.entry
    ));
    let runtime = RuntimeResolver::resolve(app).map_err(|e| {
        log_launch(format!("运行时解析失败：{e}"));
        e
    })?;

    // 流式输出上下文：venv/pip/spawn 各阶段经此 emit plugin:output 事件到前端日志面板。
    let stream_ctx = StreamCtx {
        app: app.clone(),
        plugin_id: plugin_id.clone(),
    };

    let (binary, args) = match manifest.runtime {
        PluginRuntimeKind::Python => {
            // Python：先探测是否需创建 venv / 装依赖（首次慢，已装则秒过），发对应阶段事件。
            if needs_python_venv(&plugin_dir, &runtime) {
                emit_stage(
                    "deps_installing",
                    "正在创建 Python 虚拟环境并安装依赖（首次较慢）…",
                );
            }
            // ensure_python_venv：venv 不存在则用内置 Python 创建 + 有 requirements.txt 则 pip install（幂等）。
            let py = ensure_python_venv(&runtime, &plugin_dir, Some(&stream_ctx)).map_err(|e| {
                log_launch(format!("venv/依赖准备失败：{e}"));
                e
            })?;
            log_launch(format!("venv 就绪：{}", py.display()));
            // 声明了 playwright 则校验安装包内置 Chromium revision。
            ensure_playwright_browsers(&runtime, &plugin_dir, Some(&stream_ctx))?;
            let entry_abs = plugin_dir.join(&manifest.entry);
            if !entry_abs.is_file() {
                let e = format!("Python 入口文件不存在：{}", entry_abs.display());
                log_launch(e.clone());
                return Err(e);
            }
            (py, vec!["-u".to_string(), entry_arg(&entry_abs)])
        }
        PluginRuntimeKind::Nodejs => {
            // Node：先探测是否需 pnpm install（首次慢，node_modules 已在则秒过），发对应阶段事件。
            if needs_node_install(&plugin_dir) {
                emit_stage(
                    "deps_installing",
                    "正在安装 Node 依赖（pnpm install，首次较慢）…",
                );
            }
            // ensure_node_dependencies：有 package.json + 非空依赖且 node_modules 缺失 → 内置 pnpm/npm install（幂等）。
            ensure_node_dependencies(&runtime, &plugin_dir, Some(&stream_ctx)).map_err(|e| {
                log_launch(format!("Node 依赖准备失败：{e}"));
                e
            })?;
            log_launch("Node 依赖就绪".to_string());
            // 声明了 playwright 则校验安装包内置 Chromium revision。
            ensure_playwright_browsers(&runtime, &plugin_dir, Some(&stream_ctx))?;
            let entry_abs = plugin_dir.join(&manifest.entry);
            if !entry_abs.is_file() {
                let e = format!("Node 入口文件不存在：{}", entry_abs.display());
                log_launch(e.clone());
                return Err(e);
            }
            // 仅当 package.json 声明 scripts.start 时才走 pnpm/npm start；否则裸 node entry。
            if node_has_start_script(&plugin_dir)? {
                if let Some(runner) = runtime.pnpm().or_else(|| runtime.npm()) {
                    (runner, vec!["start".to_string()])
                } else {
                    // 无 pnpm/npm：回退内置 node entry。
                    let node = runtime.require_runtime_command("node")?;
                    (node, vec![entry_arg(&entry_abs)])
                }
            } else {
                let node = runtime.require_runtime_command("node")?;
                (node, vec![entry_arg(&entry_abs)])
            }
        }
    };
    let launch_diagnostics = format!(
        "启动诊断：\n- 运行时：{:?}\n- 插件目录：{}\n- 入口：{}\n- 命令：{}\n- 参数：{}",
        manifest.runtime,
        plugin_dir.display(),
        manifest.entry,
        binary.display(),
        if args.is_empty() {
            "(无)".to_string()
        } else {
            args.join(" ")
        }
    );

    // 依赖就绪，即将 spawn 入口进程 → 发 starting 阶段（前端切换到「启动中」动画）。
    emit_stage("starting", "正在启动插件进程…");
    // env_clear + 白名单：避免泄漏宿主 token/密钥到插件进程（与 plugin_script.rs 同语义）。
    // 计费/中转：插件进程只拿 localhost 桥地址 + 进程会话 token，不直接接触 JWT/API Key。
    let mut env = runtime.env(minimal_env());
    let bridge_env = bridge.register_session(
        &plugin_id,
        api_base,
        auth_token,
        manifest.capabilities.iter().any(|c| c.kind == "llm.chat"),
        manifest
            .capabilities
            .iter()
            .any(|c| c.kind == "image.generate"),
        manifest
            .capabilities
            .iter()
            .any(|c| c.kind == "image.edit"),
        manifest
            .capabilities
            .iter()
            .any(|c| c.kind == "video.generate"),
        manifest
            .capabilities
            .iter()
            .any(|c| c.kind == "audio.generate"),
        PluginBridgeClientSource::PluginRuntime,
        Duration::from_secs(12 * 60 * 60),
    )?;
    let bridge_token = bridge_env.as_ref().map(|env| env.token.clone());
    if let Some(bridge_env) = bridge_env {
        env.push((
            OsString::from("LINGFANG_PLUGIN_BRIDGE_URL"),
            OsString::from(bridge_env.url),
        ));
        env.push((
            OsString::from("LINGFANG_PLUGIN_BRIDGE_TOKEN"),
            OsString::from(bridge_env.token),
        ));
    }
    // Python: 强制 UTF-8 输出（Windows 中文系统默认 GBK，不设逐行读会乱码）。
    env.push((OsString::from("PYTHONIOENCODING"), OsString::from("utf-8")));

    // crash_context：在 env move 前捕获完整命令/cwd/env 快照，供崩溃转储 .crash.log 用。
    let cwd_str = strip_verbatim_prefix(&plugin_dir.to_string_lossy());
    let cmdline_str = format!(
        "{} {}",
        strip_verbatim_prefix(&binary.to_string_lossy()),
        if args.is_empty() {
            String::new()
        } else {
            args.iter()
                .map(|a| {
                    if a.contains(' ') || a.is_empty() {
                        format!("\"{a}\"")
                    } else {
                        a.clone()
                    }
                })
                .collect::<Vec<_>>()
                .join(" ")
        }
    );
    // env 快照（脱敏：隐藏桥 token 值，只保留 key=存在标记）。
    let env_dump: Vec<String> = env
        .iter()
        .map(|(k, v)| {
            let key = k.to_string_lossy();
            if key.contains("TOKEN") || key.contains("SECRET") || key.contains("KEY") {
                format!("{key}=<hidden>")
            } else {
                format!("{key}={}", v.to_string_lossy())
            }
        })
        .collect();
    log_launch(format!("spawn：{cmdline_str}"));

    // 直接 spawn 入口进程（跨平台）：stdout+stderr 都 piped，逐行 emit plugin:output 到前端日志面板。
    let mut command = std::process::Command::new(&binary);
    command
        .current_dir(&plugin_dir)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear()
        .envs(env);
    // Unix：setsid 做进程组分离（stop kill 用）。Windows：CREATE_NEW_PROCESS_GROUP 同理。
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                libc_setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NEW_PROCESS_GROUP（0x0200）：进程组隔离，便于 stop_plugin kill 整组。
        command.creation_flags(0x0000_0200);
    }
    let mut child = command.spawn().map_err(|e| {
        log_launch(format!("spawn 失败：{e}"));
        if let Some(token) = bridge_token.as_deref() {
            bridge.revoke_token(token);
        }
        format!("启动插件进程失败：{e}")
    })?;

    // OS 级沙箱（Windows Job Object）：进程树围栏 + 关闭即杀。
    // 沙箱是安全网：即使 kill_child_tree 漏杀孙进程，Job 句柄关闭也会清理整棵进程树。
    // 创建/分配失败不阻断启动（降级到仅 kill_child_tree + CREATE_NEW_PROCESS_GROUP 隔离）。
    let sandbox = SandboxHandle::create().unwrap_or_else(|e| {
        log_launch(format!("沙箱创建失败（降级为无沙箱）：{e}"));
        SandboxHandle::default()
    });
    if let Err(e) = sandbox.assign_process(&child) {
        log_launch(format!("沙箱分配进程失败（降级为无沙箱）：{e}"));
    }
    log_launch("OS 级沙箱已就绪".to_string());

    // 取出 stdout/stderr pipe，开两个 reader 线程逐行 emit plugin:output（实时流到前端日志面板）。
    // 同时累积 stderr 到共享缓冲，供 800ms 秒退时的崩溃诊断读全文。
    let on_line = stream_ctx.make_line_callback();
    let on_line = std::sync::Arc::new(std::sync::Mutex::new(on_line));
    let stderr_buf = std::sync::Arc::new(std::sync::Mutex::new(String::new()));

    if let Some(stdout) = child.stdout.take() {
        let on_line = std::sync::Arc::clone(&on_line);
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stdout).lines() {
                match line {
                    Ok(text) => {
                        if let Ok(mut cb) = on_line.lock() {
                            cb(&text, false);
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let on_line = std::sync::Arc::clone(&on_line);
        let buf = std::sync::Arc::clone(&stderr_buf);
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stderr).lines() {
                match line {
                    Ok(text) => {
                        if let Ok(mut cb) = on_line.lock() {
                            cb(&text, true);
                        }
                        if let Ok(mut b) = buf.lock() {
                            b.push_str(&text);
                            b.push('\n');
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // 800ms 秒退判定：只 try_wait 判进程是否退出（不 take stderr，reader 线程持续读到 EOF）。
    // 秒退时从 stderr_buf 读已累积的全文做崩溃诊断（reader 线程在进程退出后会读完剩余 pipe）。
    let deadline = std::time::Instant::now() + Duration::from_millis(800);
    let mut crashed_status: Option<std::process::ExitStatus> = None;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                crashed_status = Some(status);
                break;
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    break; // 存活 800ms = 正常运行
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => break, // try_wait 异常，保守当正常运行
        }
    }
    if let Some(status) = crashed_status {
        // 进程秒退 = 崩溃。等 reader 线程读完 pipe 尾部（进程已退出，pipe 即将 EOF）。
        std::thread::sleep(Duration::from_millis(150));
        let stderr_text = stderr_buf.lock().map(|b| b.clone()).unwrap_or_default();
        let truncated = truncate_stderr(&stderr_text, 2000);
        let detail = if truncated.trim().is_empty() {
            format!("(进程未输出 stderr)\n\n{launch_diagnostics}")
        } else {
            format!("{truncated}\n\n{launch_diagnostics}")
        };
        let crash_err = format!("plugin_crashed:插件启动后立即退出（{status}）\n{detail}");
        // 写崩溃转储 .crash.log（完整命令/cwd/env/stderr），供用户手动复现排查。
        let crash_path = crash_log_path(&plugin_dir);
        write_crash_dump(
            &plugin_dir,
            &cmdline_str,
            &cwd_str,
            &env_dump,
            &crash_err,
            &stderr_text,
        );
        log_launch(format!("进程秒退（800ms 内退出）：{crash_err}"));
        log_launch(format!("崩溃转储已写入：{}", crash_path.display()));
        if let Some(token) = bridge_token.as_deref() {
            bridge.revoke_token(token);
        }
        // 增强错误信息：附手动复现命令 + .crash.log 路径，引导用户直接复现。
        let crash_path_str = strip_verbatim_prefix(&crash_path.to_string_lossy());
        return Err(format!(
            "{crash_err}\n\n\
             ── 手动复现 ──\n\
             在终端中执行（cwd 设为插件目录）：\n\
             {cmdline_str}\n\
             （cwd = {cwd_str}）\n\n\
             完整崩溃转储（含环境变量、输出）已写入：\n\
             {crash_path_str}"
        ));
    }
    // 存活：reader 线程持续逐行 emit plugin:output（进程活着期间一直流），无需额外排空。
    let started_at = now_iso();
    // 替换同 id 进程时仅保留本次会话；旧 watcher 使用精确 token 撤销，不会误伤新会话。
    bridge.revoke_plugin_except(&plugin_id, bridge_token.as_deref());
    let (pid, child_arc) =
        process_table.register_with_handle(&plugin_id, child, sandbox, started_at.clone());
    log_launch(format!("启动成功：pid={pid}"));
    // 运行态仅存内存进程表（组A scan_plugin_status 经 process_table.is_running 合并判定 running，
    // 不落 DB——PRD 需求 2「状态不存 DB」，重启后所有插件从文件系统重判 ready）。
    // 退出监视线程：进程退出时 emit `plugin:exited` 事件（payload: pluginId, exitCode, stderrTail），
    // 前端据此即时切到 exited 态（保留日志面板 + 进程信息），不依赖 2.5s 轮询兜底。
    spawn_exit_watcher(
        app.clone(),
        &plugin_id,
        child_arc,
        std::sync::Arc::clone(&stderr_buf),
        bridge.clone(),
        bridge_token,
    );
    Ok(StartPluginResult { pid, started_at })
}

/// 退出监视线程：tokio async 任务轮询 try_wait 判定进程退出，退出时 emit `plugin:exited` 事件。
///
/// 改为 tokio async（P1-3 优化）：原 std::thread + sleep(500ms) 持有专用线程最长 24h，
/// 现用 tauri::async_runtime::spawn + tokio::time::sleep，不占用阻塞线程，timer 由 tokio reactor 驱动。
///
/// 不 take Child（避免与 stop_plugin 的 take 竞争——stop 仍能拿到 Child 调 kill）。
/// 每 500ms try_wait 一次：返回 Some(status) = 退出；返回 None = 继续轮询；Arc 内 None = 已被
/// stop_plugin take 走（前端已主动解绑监听，不会收到事件，无副作用）。
///
/// stderr_buf 是 reader 线程累积的全文，取尾部 ≤4000 字符作为 stderrTail 供前端展示。
fn spawn_exit_watcher(
    app: tauri::AppHandle,
    plugin_id: &str,
    child_arc: Arc<Mutex<Option<Child>>>,
    stderr_buf: Arc<Mutex<String>>,
    bridge: PluginLlmBridge,
    bridge_token: Option<String>,
) {
    use tauri::Emitter;
    let pid_str = plugin_id.to_string();
    // tokio async 任务：不占用阻塞线程池，sleep 由 tokio timer 驱动（epoll/io_uring/kqueue）。
    tauri::async_runtime::spawn(async move {
        let max_iters = 24 * 3600 * 2; // 500ms × 2 × 3600 × 24 = 24h 上限防泄漏
        let mut exit_code: Option<i32> = None;
        let mut exited = false;
        for _ in 0..max_iters {
            // tokio::time::sleep 不阻塞当前线程（yield 回 reactor），对比 std::thread::sleep 全程占用线程。
            tokio::time::sleep(Duration::from_millis(500)).await;
            let mut guard = child_arc.lock().unwrap_or_else(|p| p.into_inner());
            match guard.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        exit_code = status.code();
                        exited = true;
                        break;
                    }
                    Ok(None) => { /* 仍在运行，继续轮询 */ }
                    Err(_) => {
                        exited = true;
                        break;
                    }
                },
                None => {
                    // Arc 内 None = 已被 stop_plugin take 走（用户主动停止）。
                    return;
                }
            }
        }
        if !exited {
            return;
        }
        if let Some(token) = bridge_token {
            bridge.revoke_token(&token);
        }
        let stderr_tail = stderr_buf
            .lock()
            .map(|b| {
                let s = b.as_str();
                if s.chars().count() <= 4000 {
                    s.to_string()
                } else {
                    s.chars()
                        .rev()
                        .take(4000)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect()
                }
            })
            .unwrap_or_default();
        let _ = app.emit(
            "plugin:exited",
            PluginExited {
                plugin_id: pid_str,
                exit_code,
                stderr_tail,
            },
        );
    });
}

/// spawn 后短等待判定进程是否秒退（崩溃）。
/// - 退出 = 崩溃：读 stderr 全部内容，返回 `plugin_crashed:<status>\n<stderr 摘要>` 前缀错误。
/// - 存活（超时未退）= 正常运行：返回 None（调用方继续注册进程表）。
///
/// 抽成纯函数便于单测（不依赖 tauri::State）。try_wait 轮询（非 wait 阻塞）避免阻塞 start_plugin 命令。
#[cfg(test)]
pub(crate) fn wait_for_crash(child: &mut std::process::Child, timeout: Duration) -> Option<String> {
    let mut capture = String::new();
    wait_for_crash_with_diagnostics_capturing(child, timeout, "", &mut capture)
}

/// 秒退判定 + 把读到的 stderr 回传到 out_capture（供崩溃转储 .crash.log）。
///
/// 直接读 piped stderr（确定性捕获，跨平台）。stderr piped 由调用方的 spawn 设置；
/// 进程秒退（依赖缺失/语法错/解释器损坏）→ 读 stderr 全文 → 返回 plugin_crashed 错误。
fn wait_for_crash_with_diagnostics_capturing(
    child: &mut std::process::Child,
    timeout: Duration,
    diagnostics: &str,
    out_capture: &mut String,
) -> Option<String> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stderr_text = child
                    .stderr
                    .take()
                    .and_then(|mut s| {
                        use std::io::Read;
                        let mut buf = String::new();
                        s.read_to_string(&mut buf).ok().map(|_| buf)
                    })
                    .unwrap_or_default();
                *out_capture = stderr_text.clone();
                let truncated = truncate_stderr(&stderr_text, 2000);
                let detail = if diagnostics.trim().is_empty() {
                    truncated
                } else if truncated.trim().is_empty() {
                    format!("(进程未输出 stderr)\n\n{diagnostics}")
                } else {
                    format!("{truncated}\n\n{diagnostics}")
                };
                return Some(format!(
                    "plugin_crashed:插件启动后立即退出（{status}）\n{detail}"
                ));
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    return None; // 存活超时 = 正常运行
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None, // try_wait 异常，保守当正常运行（不误报崩溃）
        }
    }
}

/// 截断 stderr 到 max_chars 字符（超长加尾标），避免错误信息过长。
fn truncate_stderr(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let truncated: String = s.chars().take(max_chars).collect();
    format!(
        "{truncated}\n…(stderr 已截断，共 {} 字符)",
        s.chars().count()
    )
}

/// 命令：停止插件独立进程（PRD AC5：可强制关闭）。
/// 从内存进程表 take Child → kill_child_tree（进程组/树 kill）→ wait 回收句柄。
/// 进程表内存态：take 后条目即清，scan_plugin_status 不再判 running。
/// 进程不存在（已退出/未启动）幂等返回，不报错（与 code_assistant::stop_session 同语义）。
#[tauri::command]
pub fn stop_plugin(
    process_table: tauri::State<'_, PluginProcessTable>,
    bridge: tauri::State<'_, PluginLlmBridge>,
    plugin_id: String,
) -> Result<(), String> {
    stop_plugin_by_id(&process_table, &bridge, &plugin_id)
}

pub(crate) fn stop_plugin_by_id(
    process_table: &PluginProcessTable,
    bridge: &PluginLlmBridge,
    plugin_id: &str,
) -> Result<(), String> {
    if let Some((mut child, _sandbox, _started_at)) = process_table.take(plugin_id) {
        // kill_child_tree 发进程组/树 kill 信号（不 wait），这里补 wait 回收 Child 句柄。
        // _sandbox 在块结束时 drop → Job 句柄关闭 → 漏杀的孙进程也被清理（安全网）。
        kill_child_tree(&child);
        let _ = child.kill();
        let _ = child.wait();
    }
    bridge.revoke_plugin(plugin_id);
    // 幂等：进程不存在直接 Ok（用户「停止一个已结束的插件」应成功）。
    Ok(())
}

/// 命令：删除本地持久化插件目录（temp 草稿 / 正式本地插件）。
///
/// 流程：sanitize_plugin_id 防穿越 → 若进程表在运行先 stop（take + kill_child_tree + wait，
/// 防文件占用删不掉）→ remove_dir_all(plugin_dir)。
///
/// 仅删 `plugins_root/<plugin_id>/`。builtin 内置插件在 builtin-plugins/（resources 打包），
/// 不在 plugins_root，sanitize + plugin_dir 不会定位到——天然不删。
/// 不删云端记录（后端独立 DELETE 端点）；目录不存在幂等 Ok（与 stop_plugin 同语义）。
#[tauri::command]
pub fn delete_plugin(
    store: tauri::State<'_, PluginStore>,
    process_table: tauri::State<'_, PluginProcessTable>,
    bridge: tauri::State<'_, PluginLlmBridge>,
    plugin_id: String,
) -> Result<(), String> {
    bridge.revoke_plugin(&plugin_id);
    delete_plugin_dir(&store, &process_table, &plugin_id)
}

/// delete_plugin 的纯逻辑（无 tauri::State，便于单测）。
/// sanitize → take+kill 进程 → remove_dir_all 目录。
pub(crate) fn delete_plugin_dir(
    store: &PluginStore,
    process_table: &PluginProcessTable,
    plugin_id: &str,
) -> Result<(), String> {
    let id = sanitize_plugin_id(plugin_id)?;
    // 先停进程（防 venv / node_modules 文件占用删不掉）。
    if let Some((mut child, _sandbox, _)) = process_table.take(&id) {
        kill_child_tree(&child);
        let _ = child.kill();
        let _ = child.wait();
    }
    let dir = store.plugin_dir(&id)?;
    remove_external_python_venv(&dir);
    if !dir.exists() {
        return Ok(()); // 目录不存在幂等成功（云端已删 / 手动清过）。
    }
    // 删目录：venv / node_modules 含大量 exe/pyd/dll，Windows 上 remove_dir_all 常因
    // 杀软实时扫描锁 / 文件句柄短暂残留 / 只读属性失败（os error 5 拒绝访问）。
    // 重试 3 次（间隔 300ms 等句柄释放 / AV 扫完），仍失败则 Windows 降级 rmdir /s /q（强制删）。
    remove_dir_all_with_retry(&dir)
}

fn remove_external_python_venv(plugin_dir: &std::path::Path) {
    let venv_dir = python_venv_dir(plugin_dir);
    if venv_dir.exists() && !venv_dir.starts_with(plugin_dir) {
        let _ = remove_dir_all_with_retry(&venv_dir);
    }
}

/// 带重试 + Windows rmdir 降级的目录删除（venv/node_modules 在 Windows 删除不可靠）。
fn remove_dir_all_with_retry(dir: &std::path::Path) -> Result<(), String> {
    // 先尝试 std::fs::remove_dir_all，重试 3 次（间隔 300ms）。
    let mut last_err = None;
    for attempt in 0..3 {
        match std::fs::remove_dir_all(dir) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = Some(e);
                if attempt < 2 {
                    std::thread::sleep(Duration::from_millis(300));
                }
            }
        }
    }
    // Windows 降级：cmd /c rmdir /s /q（强制删，对 AV 锁/只读更鲁棒）。
    #[cfg(windows)]
    {
        let status = std::process::Command::new("cmd")
            .args(["/c", "rmdir", "/s", "/q"])
            .arg(dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if let Ok(s) = status {
            if s.success() {
                return Ok(());
            }
        }
    }
    Err(format!(
        "删除插件目录失败：{}（可能是杀软锁定或文件占用，请关闭杀软实时保护或手动删除：{}）",
        last_err.map(|e| e.to_string()).unwrap_or_default(),
        dir.display()
    ))
}

/// 命令：查询插件进程运行状态（PRD 需求 2 / AC2：running/stopped 动态判定）。
/// 查内存进程表（try_wait 实时判定，比 scan 读磁盘表更准），进程已退出时自动清表。
#[tauri::command]
pub fn get_plugin_status(
    process_table: tauri::State<'_, PluginProcessTable>,
    plugin_id: String,
) -> Result<PluginProcessStatus, String> {
    match process_table.is_running(&plugin_id) {
        Some((pid, started_at)) => Ok(PluginProcessStatus {
            running: true,
            pid: Some(pid),
            started_at: Some(started_at),
        }),
        None => Ok(PluginProcessStatus {
            running: false,
            pid: None,
            started_at: None,
        }),
    }
}

// === 辅助 ===

/// Unix setsid（建独立进程组，detached）。
/// 与 code_assistant.rs::libc_setsid 同语义，独立实现保持模块自洽。
#[cfg(unix)]
fn libc_setsid() {
    extern "C" {
        fn setsid() -> i32;
    }
    unsafe {
        let _ = setsid();
    }
}

/// ISO 时间戳（复用 code_assistant::store::now_string 的 RFC 3339 格式）。
/// 供进程表 started_at 记录 + 前端展示，scan_plugin_status 合并 running 态时透传。
///
/// 历史 bug（Task 4a「Invalid Date」）：旧实现产出 `epoch.毫秒Z`，浏览器 new Date 无法
/// 解析。统一走 epoch_to_iso8601，保证前端 new Date(started_at) 可解析。
fn now_iso() -> String {
    crate::process_util::now_string()
}

// === 单元测试 ===
// 覆盖：venv/pip 路径平台正确性、manifest 解析、minimal_env 安全、进程表 register/take/is_running。
// 不测实际 venv/pnpm 执行（依赖宿主环境，CI 不可控；start_plugin 集成测试手动验证）。
// 不测 resolve_plugin_dir（走 PluginStore，组A 已覆盖 ensure_plugin_dir 单测）。
#[cfg(test)]
mod tests;
