//! 插件脚本本地预览执行（R3）。
//!
//! 职责：在桌面壳侧为 nodejs/python 运行时插件提供「无参数一次性预览执行」。
//! 复用 code_assistant.rs 的子进程骨架（run_capture_with_env / resolve_workspace），
//! 在 app_data_dir/plugin-sandbox/<plugin_id> 下落盘用户脚本后带超时运行。
//! Node.js / Python 解释器由 runtime_resolver 统一定位到软件内置资源，永不回退系统 PATH。
//!
//! 安全边界（design §6.1 明确留痕）：
//! - 本通道是【不受控执行通道】，绕过 capability 网关（capability.rs 的声明式白名单
//!   语义面向「插件运行态受控能力调用」，与「开发者主动运行自己刚生成的脚本」语义不同）。
//! - 本轮 sandbox 仅【软隔离】：路径穿越防（sanitize_rel_path + canonicalize 前缀断言）、
//!   env 最小白名单、超时 kill、stdin=null。
//! - 可逃逸：用户权限运行的脚本可执行 fs.writeFile / child_process / 网络请求，影响用户文件系统
//!   （与本地直接 `node main.js` 等价风险）。
//! - 后续独立大任务（TODO）：OS 级硬隔离（Windows AppContainer / Linux bubblewrap|firejail /
//!   macOS sandbox-exec）+ 新增 script.node / script.python capability kind，让本通道也走声明式授权。
//!   届时 run_plugin_script 改为先查 CapabilityRegistry。

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::plugin_llm_bridge::{PluginBridgeClientSource, PluginLlmBridge};
use crate::process_util::{resolve_workspace, run_capture_with_env, CapturedOutput};
use crate::runtime_resolver::RuntimeResolver;
// 复用 plugin_runner 的依赖安装（ensure_python_venv/ensure_node_dependencies）和环境变量白名单，
// 让试跑与持久化运行用同一套依赖管理逻辑（venv 创建/pip install/pnpm install），避免行为漂移。
use crate::plugin_runner::{
    ensure_node_dependencies, ensure_playwright_browsers, ensure_python_venv, entry_arg,
    minimal_env as runner_minimal_env,
};

/// 运行时语言枚举（仅脚本型，不含 client/cloud）。
/// serde rename_all = lowercase：nodejs / python，与契约 RuntimeType 对齐。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ScriptRuntime {
    Nodejs,
    Python,
}

/// 单个脚本文件（相对路径 + 内容），由前端 PluginDraft.files 传入。
#[derive(Clone, Debug, Deserialize)]
pub struct ScriptFile {
    pub path: String,
    pub content: String,
}

/// run_plugin_script 命令入参。
#[derive(Clone, Debug, Deserialize)]
pub struct RunPluginScriptInput {
    pub plugin_id: String,
    pub runtime: ScriptRuntime,
    /// 运行入口相对路径（如 src/index.js / main.py），须存在于 files 中。
    pub entry: String,
    pub files: Vec<ScriptFile>,
    /// 当前 manifest 声明的能力 kind。用于本地 LLM 桥按声明放行。
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// 后端地址与登录态仅传给宿主桥，不直接注入脚本进程。
    pub api_base: Option<String>,
    pub auth_token: Option<String>,
    /// 超时毫秒，缺省 15000（design 决策③：无参数一次性运行，防死循环挂起 UI）。
    pub timeout_ms: Option<u64>,
    /// 传给脚本的命令行参数（sys.argv / process.argv）。
    /// 用于 GUI 插件的「无 GUI 测试模式」（如 --test 走核心逻辑验证，不启动窗口）。
    /// 参数在入口文件路径之后追加，不经过 shell 解析（直接作为 argv 元素，无注入风险）。
    #[serde(default)]
    pub args: Vec<String>,
}

/// 解释器探测结果。
#[derive(Clone, Debug, Serialize)]
pub struct ProbeResult {
    pub available: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    /// 缺失时的安装指引文案（前端 ScriptPreviewPanel 直接展示）。
    pub hint: Option<String>,
}

/// 一次预览执行的输出（与 R5 creator-error.RunScriptResult 对齐需经前端封装层转换）。
#[derive(Clone, Debug, Serialize)]
pub struct RunResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub elapsed_ms: u64,
    /// 依赖安装日志摘要（试跑前自动装依赖时记录，供 AI 判断装了什么/是否成功）。
    /// None 表示无需装依赖（无 requirements.txt/package.json 或已装缓存命中）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_log: Option<String>,
}

/// 安装指引文案（缺失解释器时 Rust 侧也返回便于直接展示）。
fn install_hint(runtime: ScriptRuntime) -> String {
    match runtime {
        ScriptRuntime::Nodejs => {
            "未检测到软件内置 Node.js。安装包可能不完整，请重新安装灵坊工作台。".to_string()
        }
        ScriptRuntime::Python => {
            "未检测到软件内置 Python。安装包可能不完整，请重新安装灵坊工作台。".to_string()
        }
    }
}

/// 探测解释器是否存在 + 版本号。
/// 仅探测软件内置运行时，不回退系统 PATH。
#[tauri::command]
pub fn probe_script_runtime(
    app: tauri::AppHandle,
    runtime: ScriptRuntime,
) -> Result<ProbeResult, String> {
    let resolver = RuntimeResolver::resolve(&app)?;
    probe_script_runtime_inner(&resolver, runtime)
}

fn probe_script_runtime_inner(
    resolver: &RuntimeResolver,
    runtime: ScriptRuntime,
) -> Result<ProbeResult, String> {
    let hint = install_hint(runtime);
    let binary = match runtime {
        ScriptRuntime::Nodejs => resolver.node(),
        ScriptRuntime::Python => resolver.python(),
    };
    let Some(binary) = binary else {
        return Ok(ProbeResult {
            available: false,
            binary_path: None,
            version: None,
            hint: Some(hint),
        });
    };
    match run_capture_with_env(
        &binary,
        vec!["--version".to_string()],
        None,
        5_000,
        resolver.env(minimal_env()),
    ) {
        Ok(captured) if !captured.timed_out && captured.exit_code == Some(0) => {
            let raw_version = format!("{}\n{}", captured.stdout.trim(), captured.stderr.trim());
            let version = raw_version
                .lines()
                .find(|line| !line.trim().is_empty())
                .map(|line| line.trim().to_string());
            return Ok(ProbeResult {
                available: true,
                binary_path: Some(binary.to_string_lossy().to_string()),
                version,
                hint: None,
            });
        }
        _ => {}
    }
    Ok(ProbeResult {
        available: false,
        binary_path: None,
        version: None,
        hint: Some(hint),
    })
}

/// 最小白名单环境变量：仅保留解释器/依赖查找与系统调用必需项，裁掉宿主 token/密钥。
///
/// 复用 plugin_runner::minimal_env（单一来源，避免两处 keys 数组漂移）。
/// 保留本包装供 plugin_script/tests.rs 复用（测试直接调 minimal_env()）。
pub(crate) fn minimal_env() -> Vec<(OsString, OsString)> {
    runner_minimal_env()
}

/// 在 minimal_env 基础上按运行时追加专属环境变量。
///
/// Python（H2 修复）：
/// - `PYTHONIOENCODING=utf-8`：强制 stdout/stderr UTF-8 编码，避免 Windows 中文系统默认 GBK
///   导致 `print("你好")` 触发 UnicodeEncodeError 崩溃或 String::from_utf8_lossy 解码乱码。
/// - `PYTHONUTF8=1`：PEP 540 UTF-8 模式，文件读取/默认编码统一 UTF-8。
///
/// Python 多文件（H4 修复）：
/// - `PYTHONPATH=<sandbox根>`：让 entry 在子目录时（如 src/main.py）能 import sandbox 根的模块
///   （Python 默认 sys.path[0] 是脚本所在目录，非 sandbox 根）。
fn runtime_env(
    runtime: ScriptRuntime,
    workspace: &str,
    base: Vec<(OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    let mut env = base;
    if runtime == ScriptRuntime::Python {
        env.push((OsString::from("PYTHONIOENCODING"), OsString::from("utf-8")));
        env.push((OsString::from("PYTHONUTF8"), OsString::from("1")));
        if !workspace.is_empty() {
            env.push((OsString::from("PYTHONPATH"), OsString::from(workspace)));
        }
    }
    env
}

/// 规范化相对路径：禁绝对路径（/ ~ C:）/空段/./../隐藏系统段。
/// 与后端 plugin-package.ts cleanPath 等价逻辑，是路径穿越防御的第一道（软隔离）防线。
fn sanitize_rel_path(path: &str) -> Result<PathBuf, String> {
    let normalized = path.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err("路径不能为空".to_string());
    }
    if normalized.starts_with('/')
        || normalized.starts_with('~')
        || is_windows_drive_prefix(&normalized)
    {
        return Err(format!("路径不能是绝对路径：{normalized}"));
    }
    let segments: Vec<&str> = normalized.split('/').collect();
    if segments
        .iter()
        .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        return Err(format!("路径不能包含空段或 ..：{normalized}"));
    }
    if segments.iter().any(|segment| segment.starts_with('.')) {
        return Err(format!("路径不能包含隐藏系统段：{normalized}"));
    }
    Ok(PathBuf::from(normalized))
}

/// 判断是否 Windows 盘符绝对路径（如 C:/ D:\），等价于后端正则 /^[a-zA-Z]:\//。
/// 手动实现避免引入 regex 依赖。
fn is_windows_drive_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
}

/// 预检 Node 插件是否需要专属运行时（预览执行用裸 node 跑不了）。
///
/// 判定：files 含 package.json 且其 scripts.start 不是简单的 `node <file>` 形态
/// （即依赖了 electron / 框架 CLI 等特殊可执行运行时）。
/// 命中时返回友好错误提示（引导用持久化运行），未命中返回 None。
///
/// 背景：预览执行用 `node <entry>` 一次性跑，但 electron 等是特殊可执行包，
/// `require('electron')` 在纯 node 下会抛 EISDIR / 模块解析错（node 把 electron 的
/// 路径当目录 realpath）。此类插件必须经 `pnpm start`（即 `electron .`）启动，
/// 属于持久化运行（Plugins 页「运行」按钮）的范畴，预览执行本就不适用。
fn needs_runtime_start(files: &[ScriptFile]) -> Option<String> {
    // 读取 package.json 内容（与 materialize_sandbox 一致：files 里的 path 形如 "package.json"）。
    let pkg = files.iter().find(|f| f.path == "package.json")?;
    let value: serde_json::Value = serde_json::from_str(&pkg.content).ok()?;
    let start = value
        .get("scripts")
        .and_then(|s| s.get("start"))?
        .as_str()?
        .trim();
    // 简单 `node <file>` 形态可裸 node 预览（如 "node index.js"）；其余（electron . / 框架 CLI）需专属运行时。
    // 容错：去引号后若以 "node " 开头且只有一个参数，视为简单形态放行；否则视为专属运行时。
    let is_plain_node = start.starts_with("node ") && start.split_whitespace().count() == 2;
    if is_plain_node {
        return None;
    }
    // 依赖里若含 electron/pkg 等打包/运行时框架，给出更具体的提示。
    let deps = value
        .get("dependencies")
        .and_then(|d| d.as_object())
        .map(|m| m.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let runtime_hint = if deps.iter().any(|d| d == "electron") {
        "（检测到 electron 依赖，需用 pnpm start 启动主进程）"
    } else {
        ""
    };
    Some(format!(
        "该插件声明了 scripts.start（{}），需要专属运行时而非直接 node 运行，预览执行无法启动{}。请在「插件」页用「运行」按钮以独立进程启动（pnpm start）。",
        start, runtime_hint
    ))
}

#[cfg(test)]
mod needs_runtime_start_tests {
    use super::*;

    fn file(path: &str, content: &str) -> ScriptFile {
        ScriptFile {
            path: path.to_string(),
            content: content.to_string(),
        }
    }

    #[test]
    fn plain_node_start_is_allowed() {
        // scripts.start = "node index.js" 形态简单，裸 node 可预览，不拦截。
        let files = vec![file(
            "package.json",
            r#"{"scripts":{"start":"node index.js"}}"#,
        )];
        assert!(needs_runtime_start(&files).is_none());
    }

    #[test]
    fn electron_start_is_blocked() {
        // scripts.start = "electron ." 需要 electron 运行时，预览拦截并提示。
        let files = vec![file(
            "package.json",
            r#"{"scripts":{"start":"electron ."},"dependencies":{"electron":"^31"}}"#,
        )];
        let reason = needs_runtime_start(&files).expect("应拦截 electron");
        assert!(reason.contains("electron ."));
        assert!(reason.contains("electron 依赖"));
        assert!(reason.contains("独立进程"));
    }

    #[test]
    fn no_package_json_is_allowed() {
        // 无 package.json（纯脚本插件）不拦截。
        let files = vec![file("index.js", "console.log('hi')")];
        assert!(needs_runtime_start(&files).is_none());
    }

    #[test]
    fn malformed_package_json_is_allowed() {
        // package.json 非法 JSON 时不拦截（降级为裸 node 尝试，由真实 node 错误兜底）。
        let files = vec![file("package.json", "{not json")];
        assert!(needs_runtime_start(&files).is_none());
    }
}

/// sandbox 落盘：清空旧目录后重建，逐文件写入子目录。
/// 返回 canonicalize 后的 sandbox 根与 entry 绝对路径，供 run_capture_with_env 使用。
fn materialize_sandbox(
    base: &Path,
    plugin_id: &str,
    files: &[ScriptFile],
    entry: &str,
) -> Result<(PathBuf, PathBuf), String> {
    // 修复 SCRIPT-01（critical 路径穿越删除）：
    // 此前 plugin_id 直接 join 进路径，含 '../'、'\\'、盘符或空串时会越出 plugin-sandbox，
    // 随后的 remove_dir_all 在未规范化路径上递归删，造成任意目录删除（不可恢复）。
    // canonicalize 前缀断言也被绕过（sandbox_canon 本身已被推到 plugin-sandbox 之外）。
    // 用段级白名单严格校验 plugin_id，仅允许 [A-Za-z0-9_-]，杜绝任何路径分量注入。
    let safe_id = sanitize_plugin_id(plugin_id)?;
    let sandbox_root = base.join("plugin-sandbox");
    let sandbox = sandbox_root.join(&safe_id);
    // 修复 SCRIPT-04（low 资源泄漏）：此前仅清当前 plugin_id 自身目录，从不回收其它 plugin_id
    // 的历史 sandbox，app_data/plugin-sandbox/ 持续堆积孤立目录。新增 LRU 清理：落盘前扫描
    // plugin-sandbox 目录，按 mtime 排序保留最近 SANDBOX_KEEP_DIRS 个，删除其余（含本次 plugin_id，
    // 因随后立即重建）。仅对名字通过 sanitize_plugin_id 的目录操作，杜绝误删非 sandbox 目录。
    cleanup_sandbox_lru(&sandbox_root, &safe_id);
    // 清空旧内容后重建，避免脏数据（上一轮残留文件影响本轮运行）。
    let _ = std::fs::remove_dir_all(&sandbox);
    std::fs::create_dir_all(&sandbox).map_err(|error| error.to_string())?;

    for file in files {
        let rel = sanitize_rel_path(&file.path)?;
        let abs = sandbox.join(&rel);
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(&abs, &file.content).map_err(|error| error.to_string())?;
    }

    let entry_rel = sanitize_rel_path(entry)?;
    let entry_abs = sandbox.join(&entry_rel);

    // canonicalize 后断言仍以 sandbox 为前缀（防符号链接逃逸，软隔离第二道防线）。
    let sandbox_canon = sandbox.canonicalize().map_err(|error| error.to_string())?;
    let entry_canon = entry_abs
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !entry_canon.starts_with(&sandbox_canon) {
        return Err(format!("entry 路径逃逸 sandbox：{entry}"));
    }
    Ok((sandbox_canon, entry_canon))
}

/// 修复 SCRIPT-01：plugin_id 段级白名单校验。
/// 仅允许字母、数字、下划线、短横线，禁空串、路径分隔符、点号（防 .. / 隐藏段 / 盘符）。
fn sanitize_plugin_id(plugin_id: &str) -> Result<String, String> {
    let trimmed = plugin_id.trim();
    if trimmed.is_empty() {
        return Err("plugin_id 不能为空".to_string());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!(
            "plugin_id 含非法字符（仅允许字母数字下划线短横线）：{trimmed}"
        ));
    }
    Ok(trimmed.to_string())
}

/// 修复 SCRIPT-04（low 资源泄漏）：sandbox LRU 清理。
/// 落盘前扫描 plugin-sandbox 目录，按 mtime 排序保留最近 SANDBOX_KEEP_DIRS 个，
/// 删除其余（含本次 plugin_id，因随后立即重建）。
///
/// 安全保证：
/// - 仅处理名字通过 sanitize_plugin_id 的子目录（[A-Za-z0-9_-]），杜绝误删非 sandbox 目录。
/// - 目录不存在不报错（首次运行）。
/// - 单个目录删除失败不影响其它（继续尝试，最大化清理）。
fn cleanup_sandbox_lru(sandbox_root: &Path, _current_plugin_id: &str) {
    /// 保留的最近 sandbox 目录数量（LRU 上限）。8 个足以覆盖对话式迭代场景，
    /// 超出按 mtime 从最旧开始删除。
    const SANDBOX_KEEP_DIRS: usize = 8;

    let entries = match std::fs::read_dir(sandbox_root) {
        Ok(e) => e,
        Err(_) => return, // 目录不存在（首次运行）或不可读，静默跳过。
    };
    // 收集 (path, mtime) 对，仅保留通过 sanitize_plugin_id 的目录名（安全过滤）。
    let mut candidates: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        // 仅清理合法 plugin_id 目录，跳过任何非法名（防误删用户其它文件）。
        if sanitize_plugin_id(&name_str).is_err() {
            continue;
        }
        let path = entry.path();
        let metadata = match std::fs::metadata(&path) {
            Ok(m) if m.is_dir() => m,
            _ => continue, // 非目录或读元数据失败，跳过。
        };
        let mtime = metadata
            .modified()
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        candidates.push((path, mtime));
    }
    // mtime 降序（最新在前），超出 KEEP 的从尾部（最旧）开始删。
    candidates.sort_by(|a, b| b.1.cmp(&a.1));
    for (path, _mtime) in candidates.into_iter().skip(SANDBOX_KEEP_DIRS) {
        let _ = std::fs::remove_dir_all(&path);
    }
}

/// 命令：运行插件脚本（无参数一次性运行 + 带超时）。
#[tauri::command]
pub fn run_plugin_script(
    app: tauri::AppHandle,
    bridge: tauri::State<'_, PluginLlmBridge>,
    input: RunPluginScriptInput,
) -> Result<RunResult, String> {
    // 解释器探测前置：缺失直接返回友好错误（前端据 ProbeResult.hint 展示安装指引）。
    let resolver = RuntimeResolver::resolve(&app)?;
    let probe = probe_script_runtime_inner(&resolver, input.runtime)?;
    if !probe.available {
        return Err(format!(
            "interpreter_missing:{}",
            probe.hint.unwrap_or_else(|| install_hint(input.runtime))
        ));
    }
    let binary = PathBuf::from(
        probe
            .binary_path
            .ok_or_else(|| "解释器探测命中但路径缺失".to_string())?,
    );

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let (sandbox_canon, entry_canon) =
        materialize_sandbox(&data_dir, &input.plugin_id, &input.files, &input.entry)?;

    // 预检（Node 插件专属运行时）：若插件声明了 package.json + scripts.start（如 electron . / 框架 CLI），
    // 说明它需要专属运行时而非裸 node 直跑入口。预览执行用 `node <entry>` 无法加载此类运行时
    // （electron 是特殊可执行包，node require('electron') 会抛 EISDIR/模块解析错）。
    // 提前返回友好提示，引导用户用持久化运行（插件页「运行」→ pnpm start 独立进程），而非暴露 node 内部堆栈。
    if input.runtime == ScriptRuntime::Nodejs {
        if let Some(reason) = needs_runtime_start(&input.files) {
            return Err(reason);
        }
    }

    // 组D task 06-16：plugin_script 预览执行仍用临时 sandbox（group B 的 venv/pnpm 持久化运行尚未落地），
    // 故 plugin_id 传 None 走 workspace_dir 显式路径分支（不落 plugins_root，保持预览隔离）。
    let workspace = resolve_workspace(
        Some(sandbox_canon.to_string_lossy().to_string()),
        None,
        None,
    )?;

    // 依赖安装：复用 plugin_runner 的 ensure_python_venv / ensure_node_dependencies。
    // 此前试跑用裸解释器，缺 PySide6/requests 等依赖的插件必失败（ModuleNotFoundError），
    // AI 无法真正验证插件可运行。现改为试跑前按 runtime 装依赖：
    //  - Python：ensure_python_venv 创建 venv + pip install requirements.txt，返回 venv python 路径。
    //    venv 建在 LOCALAPPDATA（Windows）按 sandbox 路径哈希，同 plugin_id 试跑复用（首次慢，后续秒过）。
    //  - Node：ensure_node_dependencies 在 sandbox 装 node_modules，仍用裸 node 跑（node 自动解析 node_modules）。
    // 装依赖失败不致命：记录到 install_log 返回给 AI（AI 据此修包名/版本），但若 Python venv 失败则无法运行，
    // 直接返回错误（没有可用解释器）。
    let mut run_binary = binary.clone();
    let mut install_log: Option<String> = None;
    match input.runtime {
        ScriptRuntime::Python => {
            match ensure_python_venv(&resolver, &sandbox_canon, None) {
                Ok(venv_py) => {
                    // venv 创建/pip install 可能发生了实际安装（首次）或全跳过（缓存命中）。
                    // 简单判定：venv 是否本次新建（py 文件 mtime 近）——但更务实：只在 requirements.txt 存在时记一条。
                    if sandbox_canon.join("requirements.txt").is_file() {
                        install_log =
                            Some(format!("Python 依赖已就绪（venv: {}）", venv_py.display()));
                    }
                    run_binary = venv_py;
                    // 声明了 playwright 则校验内置浏览器（与正式运行路径一致）。
                    // 失败不致命：记进 install_log 让 AI 知晓（缺浏览器会直接导致试跑崩溃，stderr 会被捕获）。
                    if let Err(e) = ensure_playwright_browsers(&resolver, &sandbox_canon, None) {
                        let prev = install_log
                            .take()
                            .map(|s| format!("{s}\n"))
                            .unwrap_or_default();
                        install_log = Some(format!("{prev}Playwright 浏览器：{e}"));
                    }
                }
                Err(e) => {
                    // venv/pip 失败：返回带原因的错误，AI 据此修复（如 requirements.txt 里包名错/版本冲突）。
                    return Ok(RunResult {
                        stdout: String::new(),
                        stderr: String::new(),
                        exit_code: None,
                        timed_out: false,
                        elapsed_ms: 0,
                        install_log: Some(format!("依赖安装失败：{e}")),
                    });
                }
            }
        }
        ScriptRuntime::Nodejs => {
            match ensure_node_dependencies(&resolver, &sandbox_canon, None) {
                Ok(()) => {
                    if sandbox_canon.join("package.json").is_file() {
                        install_log = Some("Node 依赖已就绪（node_modules 就绪）".to_string());
                    }
                    // 同 Python 分支：声明了 playwright 则校验内置浏览器，失败记 install_log。
                    if let Err(e) = ensure_playwright_browsers(&resolver, &sandbox_canon, None) {
                        let prev = install_log
                            .take()
                            .map(|s| format!("{s}\n"))
                            .unwrap_or_default();
                        install_log = Some(format!("{prev}Playwright 浏览器：{e}"));
                    }
                }
                Err(e) => {
                    return Ok(RunResult {
                        stdout: String::new(),
                        stderr: String::new(),
                        exit_code: None,
                        timed_out: false,
                        elapsed_ms: 0,
                        install_log: Some(format!("依赖安装失败：{e}")),
                    });
                }
            }
        }
    }

    let mut args: Vec<String> = Vec::new();
    // 解释器由 runtime_resolver 统一定位到软件内置资源。
    // H1 修复：Python 追加 -u（无缓冲），避免管道块缓冲导致短输出在超时 kill 时丢失。
    // H4 修复（多文件相对 import）：追加 PYTHONPATH=<sandbox根> env（见下方 runtime_env）。
    if input.runtime == ScriptRuntime::Python {
        args.push("-u".to_string());
    }
    args.push(entry_arg(&entry_canon));
    // 追加调用方传入的 CLI 参数（如 --test），让脚本能通过 sys.argv / process.argv 读取。
    // 参数直接作为 argv 元素传给子进程，不经 shell 解析，无命令注入风险。
    args.extend(input.args.iter().cloned());

    let timeout = input.timeout_ms.unwrap_or(15_000);
    let started = Instant::now();
    // H2 修复：Python 追加 PYTHONIOENCODING=utf-8 + PYTHONUTF8=1，避免 Windows 中文系统
    // 默认 GBK 编码导致 print 中文输出 UnicodeEncodeError 崩溃或乱码。
    // H4 修复：PYTHONPATH=<sandbox根> 让多文件插件的 import 能找到 sandbox 根目录的模块。
    let mut env = runtime_env(input.runtime, &workspace, resolver.env(minimal_env()));
    let bridge_env = bridge.register_session(
        &input.plugin_id,
        input.api_base.clone(),
        input.auth_token.clone(),
        input.capabilities.iter().any(|kind| kind == "llm.chat"),
        input
            .capabilities
            .iter()
            .any(|kind| kind == "image.generate"),
        input
            .capabilities
            .iter()
            .any(|kind| kind == "image.edit"),
        input
            .capabilities
            .iter()
            .any(|kind| kind == "video.generate"),
        input
            .capabilities
            .iter()
            .any(|kind| kind == "audio.generate"),
        PluginBridgeClientSource::PluginTest,
        Duration::from_secs(30 * 60),
    )?;
    let bridge_token = bridge_env.as_ref().map(|env| env.token.clone());
    let _bridge_guard = bridge.revoke_on_drop(bridge_token);
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
    let captured: CapturedOutput =
        run_capture_with_env(&run_binary, args, Some(&workspace), timeout, env)?;
    Ok(RunResult {
        stdout: captured.stdout,
        stderr: captured.stderr,
        exit_code: captured.exit_code,
        timed_out: captured.timed_out,
        elapsed_ms: started.elapsed().as_millis() as u64,
        install_log,
    })
}

// === 单元测试 ===
// 覆盖：sanitize_rel_path 防穿越、materialize_sandbox 落盘与逃逸检测。
// 解释器运行测试依赖宿主有 node/py，用 #[cfg] 守卫；无解释器时跳过（环境层不可控）。
#[cfg(test)]
mod tests;
