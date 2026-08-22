//! 插件目录任意 shell 命令执行（Agent Bash 工具底层，task 07-03）。
//!
//! 与 plugin_script / plugin_runner 同源的【不受控执行通道】，但语义不同：
//! - plugin_script：一次性预览跑入口（python main.py / node index.js）。
//! - plugin_runner：持久化独立进程运行入口。
//! - plugin_shell（本模块）：在插件目录执行**任意 shell 命令**（cmd/powershell/pwsh/sh），
//!   等同 Claude Code 的 Bash 工具。Agent 可执行 `pip install` / `npm install` 等开发命令；
//!   Playwright 浏览器由软件内置，禁止通过 shell 再次安装。
//!
//! 安全边界（与 plugin_runner/plugin_script 同款留痕）：
//! - 本通道是【不受控执行通道】，等同 Claude Code bash——用户权限运行的命令可执行任意操作
//!   （fs/child_process/网络请求）。软隔离仅 cwd 锁定插件目录（防越权访问其它插件或系统目录），
//!   非 OS 级硬隔离。后续独立大任务再上 AppContainer/firejail + 新增 script.shell capability kind。
//! - cwd 安全不变式：相对子路径段级校验（拒绝对路径 / 含 `..` / 含盘符）+ join 后 canonicalize
//!   前缀断言（必须在 plugin_dir 内），复用 plugin_store::write_files 的同款校验思路。
//!
//! PATH 注入策略：
//! - 起点 `resolver.env(minimal_env())`：已注入软件内置 Python/Node/FFmpeg/Chromium PATH + 国内镜像源
//!   （PIP_INDEX_URL / NPM_CONFIG_REGISTRY）。
//! - **prepend 插件专属路径**到 PATH：python 插件 prepend venv（venv/Scripts 或 venv/bin），
//!   nodejs 插件 prepend node_modules/.bin。让 `pip` / `playwright` / `npx` 等命令命中插件内依赖。
//!
//! shell binary 用绝对路径：resolver.env 清空了宿主 PATH，cmd/powershell 不在注入的 PATH 里，
//! 必须用 `{SystemRoot}\System32\cmd.exe` 等绝对路径才能拉起 shell。非 Windows 走 /bin/sh。

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::plugin_runner::{minimal_env, python_venv_dir, venv_python};
use crate::plugin_store::PluginStore;
use crate::process_util::run_capture_with_env;
use crate::runtime_resolver::RuntimeResolver;

/// run_plugin_shell 命令入参（前端传 camelCase，封装层转 snake_case）。
#[derive(Clone, Debug, Deserialize)]
pub struct RunPluginShellInput {
    /// 插件 id。None / 空 = 无插件模式：cwd 落到系统临时目录，跳过插件专属 PATH 注入，
    /// runtime 强制 nodejs（仅靠应用运行时 PATH）。等同 Claude Code Bash。
    #[serde(default)]
    pub plugin_id: Option<String>,
    /// 要执行的 shell 命令（如 `pip install requests` / `npm install axios`）。
    pub command: String,
    /// shell 类型："cmd" | "powershell" | "pwsh"。缺省 "cmd"（非 Windows 走 /bin/sh，本字段忽略）。
    #[serde(default)]
    pub shell: Option<String>,
    /// 工作目录相对子路径（如 "src"），缺省/空 = 插件目录根。拒绝对路径 / .. / 盘符。
    #[serde(default)]
    pub cwd: Option<String>,
    /// 超时毫秒，缺省 120_000。
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// 运行时类型："python" | "nodejs"，决定 PATH 注入策略。None 自动探测（按文件存在性）。
    #[serde(default)]
    pub runtime: Option<String>,
}

/// run_plugin_shell 返回值（snake_case）。
#[derive(Clone, Debug, Serialize)]
pub struct ShellResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub elapsed_ms: u64,
}

/// 解析后的运行时类型（与 PluginStore::PluginRuntime 子集对齐：nodejs/python）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ShellRuntime {
    Python,
    Nodejs,
}

/// 命令：在插件目录执行任意 shell 命令（Agent Bash 工具底层）。
///
/// 两种模式：
/// - **插件模式**（plugin_id 非空）：cwd 锁定插件目录，PATH 注入 venv / node_modules/.bin。
///   插件开发的默认场景，安全不变式 = cwd 软隔离。
/// - **无插件模式**（plugin_id 为 None / 空）：cwd = 系统临时目录，不注入插件 PATH，
///   runtime 强制 nodejs。等同 Claude Code Bash——给 Agent 一个通用 shell 通道，
///   用于读 docx、跑临时脚本等非插件开发任务。**隔离消失**：以用户权限跑任意命令。
///
/// 插件模式流程：
/// 1. ensure_plugin_dir 拿 canonicalize 后的插件目录。
/// 2. resolve_cwd：子路径段级校验 + canonicalize 前缀断言（防越权）。
/// 3. RuntimeResolver::resolve 拿应用管理的运行时 + 镜像源 env。
/// 4. runtime 探测（None 时）：requirements.txt/main.py → python；package.json → nodejs；否则默认 nodejs。
/// 5. env 构造：resolver.env(minimal_env()) 起点 + prepend 插件专属 PATH（venv 或 node_modules/.bin）。
/// 6. shell binary 绝对路径（resolver 清空了宿主 PATH，cmd/powershell 必须用绝对路径）。
/// 7. run_capture_with_env 捕获 stdout/stderr/exit_code。
#[tauri::command]
pub fn run_plugin_shell(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    store: tauri::State<'_, PluginStore>,
    input: RunPluginShellInput,
) -> Result<ShellResult, String> {
    // M3：来源窗口校验——防止插件窗口以另一插件/无插件身份越权执行命令。
    enforce_shell_caller(&window, input.plugin_id.as_deref())?;

    if requests_playwright_browser_install(&input.command) {
        return Err("Chromium 已由软件内置，禁止下载或安装第二套 Playwright 浏览器".to_string());
    }

    // 模式判定：trim 后非空 = 插件模式；否则 = 无插件模式。
    let plugin_id = input
        .plugin_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    // 1+2. 解析 plugin_dir + cwd（两模式分支）。
    let (plugin_dir, cwd, has_plugin_dir) = match plugin_id {
        Some(id) => {
            let dir = store.ensure_plugin_dir(id)?;
            let cwd = resolve_cwd(&dir, input.cwd.as_deref())?;
            (dir, cwd, true)
        }
        None => {
            // 无插件模式：cwd = 系统临时目录。不创建子目录、不做段级校验
            // （临时目录里 Agent 可能 cd 任意位置——这是用户明确接受的「等同 Claude Code Bash」语义）。
            // 用户传的 cwd 在此模式下被忽略，避免与「无插件根」语义冲突。
            let dir = std::env::temp_dir();
            (dir.clone(), dir, false)
        }
    };

    // 3. 运行时解析（应用管理 + 镜像源 env）——两模式都需要，应用 PATH 永远注入。
    let resolver = RuntimeResolver::resolve(&app)?;

    // 4. runtime 探测 / 校验。
    let runtime = match input
        .runtime
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some("python") => ShellRuntime::Python,
        Some("nodejs") => ShellRuntime::Nodejs,
        Some(other) => {
            return Err(format!("runtime 仅支持 python/nodejs（收到 {other:?}）"));
        }
        None => {
            // 无插件模式：没有插件目录可探测，默认 nodejs（应用 PATH 永远有 node）。
            if has_plugin_dir {
                detect_runtime(&plugin_dir)
            } else {
                ShellRuntime::Nodejs
            }
        }
    };

    // 5. env 构造：resolver 注入应用 PATH + 镜像源；插件模式额外 prepend 插件专属路径。
    let base_env = resolver.env(minimal_env());
    let env = if has_plugin_dir {
        prepend_plugin_paths(base_env, &plugin_dir, runtime)
    } else {
        base_env
    };

    // 6. shell binary 绝对路径。
    let shell_kind = normalize_shell(input.shell.as_deref());
    let (binary, flag) = resolve_shell_binary(shell_kind)?;

    // 7. 拉起 shell 执行命令。
    let timeout_ms = input.timeout_ms.unwrap_or(120_000);
    let cwd_str = cwd.to_string_lossy().to_string();
    let started = std::time::Instant::now();
    let captured = run_capture_with_env(
        &binary,
        vec![flag, input.command],
        Some(&cwd_str),
        timeout_ms,
        env,
    )
    .map_err(|e| format!("执行 shell 命令失败：{e}"))?;

    Ok(ShellResult {
        stdout: captured.stdout,
        stderr: captured.stderr,
        exit_code: captured.exit_code,
        timed_out: captured.timed_out,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// 校验 run_plugin_shell 的调用来源窗口是否有权以给定 plugin_id 执行命令。
///
/// 设计意图（见模块头注释）：本通道是「不受控执行通道」，等同 Claude Code Bash，
/// 以**用户权限**运行任意命令。因此授权边界不在「能否执行命令」，而在「**哪个窗口
/// 能以哪个身份**发起」——防止一个插件窗口冒用另一插件或用户级 shell 身份越权。
///
/// - 无插件模式（plugin_id 为空）：仅允许 `main` 窗口调用。
///   拒绝任何 `plugin-*` 窗口，否则插件可借通用 bash 通道拿到用户级 shell。
/// - 插件模式（plugin_id = ID）：允许 `main` 或 `plugin-<ID>` 窗口；
///   拒绝 `plugin-<OTHER>`（跨插件越权）。
fn enforce_shell_caller(
    window: &tauri::WebviewWindow,
    plugin_id: Option<&str>,
) -> Result<(), String> {
    let label = window.label();
    let plugin_id = plugin_id.map(str::trim).filter(|s| !s.is_empty());
    match plugin_id {
        None => {
            if label == "main" {
                Ok(())
            } else {
                Err("run_plugin_shell 无插件模式仅允许主窗口调用（插件窗口禁止通用 shell）".to_string())
            }
        }
        Some(id) => {
            if label == "main" || label == format!("plugin-{id}") {
                Ok(())
            } else {
                Err(format!(
                    "run_plugin_shell 调用来源窗口 {label} 无权以插件 {id} 身份执行命令"
                ))
            }
        }
    }
}

fn requests_playwright_browser_install(command: &str) -> bool {
    let normalized = command
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    normalized.contains("playwright install")
}

/// 解析 cwd：None/空 → 插件目录；子路径段级校验 + canonicalize 前缀断言（防越权）。
///
/// 段级校验与 plugin_store::write_files 同款（拒绝对路径 / 含 `..` / 含盘符 / 含 `:`），
/// join 后 canonicalize 断言以 plugin_dir 为前缀（防符号链接绕过）。
pub(crate) fn resolve_cwd(plugin_dir: &Path, cwd: Option<&str>) -> Result<PathBuf, String> {
    let raw = cwd.unwrap_or("").trim();
    if raw.is_empty() {
        // 缺省 = 插件目录根（已 canonicalize，直接返回）。
        return Ok(plugin_dir.to_path_buf());
    }
    // 段级校验：拒绝对路径 / 含盘符 / 含 .. / 含 :（Windows 盘符）。
    let p = Path::new(raw);
    if p.is_absolute() || raw.starts_with('/') || raw.starts_with('\\') || raw.contains(':') {
        return Err(format!("非法 cwd（绝对路径）：{raw}"));
    }
    if p.components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!("非法 cwd（含 ..）：{raw}"));
    }
    let target = plugin_dir.join(p);
    // canonicalize 前缀断言（目标可能不存在，canonicalize 父目录）。
    // 若目标本身存在则直接 canonicalize；否则 canonicalize 父目录再 join 文件名。
    let canon = if target.exists() {
        target
            .canonicalize()
            .map_err(|e| format!("工作目录无法访问：{e}"))?
    } else {
        let parent = target.parent().unwrap_or(Path::new(""));
        let parent_canon = parent
            .canonicalize()
            .map_err(|e| format!("工作目录父路径无法访问：{e}"))?;
        if !parent_canon.starts_with(plugin_dir) {
            return Err(format!("非法 cwd（越出插件目录）：{raw}"));
        }
        parent_canon.join(target.file_name().unwrap_or_default())
    };
    if !canon.starts_with(plugin_dir) {
        return Err(format!("非法 cwd（越出插件目录）：{raw}"));
    }
    Ok(canon)
}

/// runtime 自动探测（None 时）：按文件存在性判定。
/// - requirements.txt 或 main.py 存在 → python
/// - package.json 存在 → nodejs
/// - 都没有 → 默认 nodejs（让 Agent 自己看着办，PATH 仍注入应用 node）
pub(crate) fn detect_runtime(plugin_dir: &Path) -> ShellRuntime {
    if plugin_dir.join("requirements.txt").is_file() || plugin_dir.join("main.py").is_file() {
        return ShellRuntime::Python;
    }
    if plugin_dir.join("package.json").is_file() {
        return ShellRuntime::Nodejs;
    }
    ShellRuntime::Nodejs
}

/// 在 resolver 注入的 PATH 基础上 prepend 插件专属路径。
///
/// - python：venv 存在则 prepend `venv/Scripts`（Windows）/ `venv/bin`（Unix）。
///   venv 路径 = python_venv_dir(plugin_dir)；存在判定 = venv_python(&venv).is_file()。
/// - nodejs：`plugin_dir/node_modules/.bin` 是目录则 prepend。
///
/// 不存在则跳过（只靠应用运行时的 PATH）。用 std::env::split_paths / join_paths 重组。
pub(crate) fn prepend_plugin_paths(
    mut env: Vec<(OsString, OsString)>,
    plugin_dir: &Path,
    runtime: ShellRuntime,
) -> Vec<(OsString, OsString)> {
    // 收集要 prepend 的路径（按优先级：插件内 > 应用运行时）。
    let mut prepend: Vec<PathBuf> = Vec::new();
    match runtime {
        ShellRuntime::Python => {
            let venv_dir = python_venv_dir(plugin_dir);
            if venv_python(&venv_dir).is_file() {
                #[cfg(windows)]
                prepend.push(venv_dir.join("Scripts"));
                #[cfg(not(windows))]
                prepend.push(venv_dir.join("bin"));
            }
        }
        ShellRuntime::Nodejs => {
            let nm_bin = plugin_dir.join("node_modules").join(".bin");
            if nm_bin.is_dir() {
                prepend.push(nm_bin);
            }
        }
    }
    if prepend.is_empty() {
        return env; // 无插件专属路径，直接返回 resolver 注入的 env。
    }
    // 找到 PATH 条目，prepend 后重写。
    for (key, value) in env.iter_mut() {
        if key.eq_ignore_ascii_case(OsStr::new("PATH")) {
            let mut paths: Vec<PathBuf> = std::env::split_paths(value).collect();
            // prepend 项放到最前（优先级最高）。
            paths.splice(0..0, prepend.iter().cloned());
            *value = std::env::join_paths(paths).unwrap_or_else(|_| value.clone());
            return env;
        }
    }
    // 没找到 PATH（极罕见）：追加一条仅含插件路径的 PATH。
    env.push((
        OsString::from("PATH"),
        std::env::join_paths(prepend).unwrap_or_default(),
    ));
    env
}

/// 规范化 shell 类型入参（缺省/非法 → cmd）。
pub(crate) fn normalize_shell(shell: Option<&str>) -> ShellKind {
    match shell.map(str::trim).filter(|s| !s.is_empty()) {
        Some("powershell") => ShellKind::PowerShell,
        Some("pwsh") => ShellKind::Pwsh,
        _ => ShellKind::Cmd,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ShellKind {
    Cmd,
    PowerShell,
    Pwsh,
}

/// 解析 shell binary 绝对路径 + flag。
///
/// 关键：resolver.env 清空了宿主 PATH，cmd/powershell 不在注入的 PATH 里，
/// 必须用绝对路径（SystemRoot / ProgramFiles 从 env 读，兜底 C:\Windows）。
pub(crate) fn resolve_shell_binary(kind: ShellKind) -> Result<(PathBuf, String), String> {
    // Windows：cmd / powershell / pwsh 三选一。
    #[cfg(windows)]
    {
        let system_root = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        match kind {
            ShellKind::Cmd => {
                let binary = system_root.join("System32").join("cmd.exe");
                Ok((binary, "/C".to_string()))
            }
            ShellKind::PowerShell => {
                let binary = system_root
                    .join("System32")
                    .join("WindowsPowerShell")
                    .join("v1.0")
                    .join("powershell.exe");
                Ok((binary, "-Command".to_string()))
            }
            ShellKind::Pwsh => {
                let program_files = std::env::var_os("ProgramFiles")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
                let binary = program_files.join("PowerShell").join("7").join("pwsh.exe");
                if !binary.is_file() {
                    return Err("pwsh 未安装（需 PowerShell 7+，前往 GitHub Releases 下载或 winget install Microsoft.PowerShell）".to_string());
                }
                Ok((binary, "-Command".to_string()))
            }
        }
    }
    // 非 Windows：统一走 /bin/sh。
    #[cfg(not(windows))]
    {
        let _ = kind; // 非 Windows 忽略 shell 选择，统一 sh。
        Ok((PathBuf::from("/bin/sh"), "-c".to_string()))
    }
}

// === 单元测试 ===
// 覆盖：resolve_cwd 防穿越、detect_runtime 文件探测、resolve_shell_binary cmd 路径含 System32。
#[cfg(test)]
mod tests {
    use super::*;

    /// 构造临时插件目录并 canonicalize（模拟生产环境 ensure_plugin_dir 返回的规范路径）。
    /// resolve_cwd 的 starts_with 断言依赖 plugin_dir 已 canonicalize（否则 \\?\ 前缀不一致）。
    fn temp_plugin_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lf-shell-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn resolve_cwd_none_returns_plugin_dir() {
        let dir = temp_plugin_dir();
        let resolved = resolve_cwd(&dir, None).unwrap();
        assert_eq!(resolved, dir.canonicalize().unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_cwd_empty_returns_plugin_dir() {
        let dir = temp_plugin_dir();
        let resolved = resolve_cwd(&dir, Some("   ")).unwrap();
        assert_eq!(resolved, dir.canonicalize().unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn resolve_cwd_rejects_absolute_path() {
        let dir = temp_plugin_dir();
        let err = resolve_cwd(&dir, Some(r"C:\Windows")).unwrap_err();
        assert!(err.contains("绝对路径"));
        let err = resolve_cwd(&dir, Some(r"\\?\C:\evil")).unwrap_err();
        assert!(err.contains("绝对路径"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(not(windows))]
    #[test]
    fn resolve_cwd_rejects_absolute_path() {
        let dir = temp_plugin_dir();
        let err = resolve_cwd(&dir, Some("/etc")).unwrap_err();
        assert!(err.contains("绝对路径"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_cwd_rejects_parent_dir() {
        let dir = temp_plugin_dir();
        let err = resolve_cwd(&dir, Some("..")).unwrap_err();
        assert!(err.contains(".."));
        let err = resolve_cwd(&dir, Some("src/../../evil")).unwrap_err();
        assert!(err.contains(".."));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn resolve_cwd_rejects_drive_prefix() {
        let dir = temp_plugin_dir();
        // 含冒号被拒（盘符）。
        let err = resolve_cwd(&dir, Some("D:evil")).unwrap_err();
        assert!(err.contains("绝对路径") || err.contains(":"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_cwd_accepts_subpath() {
        let dir = temp_plugin_dir();
        let subdir = dir.join("src").join("deep");
        std::fs::create_dir_all(&subdir).unwrap();
        let resolved = resolve_cwd(&dir, Some("src/deep")).unwrap();
        assert_eq!(resolved, subdir.canonicalize().unwrap());
        assert!(resolved.starts_with(dir.canonicalize().unwrap()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_cwd_handles_backslash_separator() {
        // Windows 风格反斜杠子路径（如 "src\\deep"）也应放行。
        let dir = temp_plugin_dir();
        let subdir = dir.join("src");
        std::fs::create_dir_all(&subdir).unwrap();
        let resolved = resolve_cwd(&dir, Some("src\\deep")).unwrap();
        // src\\deep 不存在但父目录 src 在 base 内 → 放行。
        assert!(resolved.starts_with(dir.canonicalize().unwrap()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn detect_runtime_python_when_requirements() {
        let dir = temp_plugin_dir();
        std::fs::write(dir.join("requirements.txt"), "requests\n").unwrap();
        assert_eq!(detect_runtime(&dir), ShellRuntime::Python);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn detect_runtime_python_when_main_py() {
        let dir = temp_plugin_dir();
        std::fs::write(dir.join("main.py"), "print('hi')\n").unwrap();
        assert_eq!(detect_runtime(&dir), ShellRuntime::Python);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn detect_runtime_nodejs_when_package_json() {
        let dir = temp_plugin_dir();
        std::fs::write(dir.join("package.json"), "{}\n").unwrap();
        assert_eq!(detect_runtime(&dir), ShellRuntime::Nodejs);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn detect_runtime_defaults_nodejs() {
        let dir = temp_plugin_dir();
        // 无任何标志文件 → 默认 nodejs。
        assert_eq!(detect_runtime(&dir), ShellRuntime::Nodejs);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn blocks_playwright_browser_install_commands() {
        assert!(requests_playwright_browser_install(
            "npx playwright install chromium"
        ));
        assert!(requests_playwright_browser_install(
            "python -m playwright   install chromium"
        ));
        assert!(!requests_playwright_browser_install(
            "npm install playwright"
        ));
    }

    #[test]
    fn detect_runtime_python_wins_over_nodejs() {
        // 同时有 requirements.txt + package.json → python 优先（开发者意图更明确）。
        let dir = temp_plugin_dir();
        std::fs::write(dir.join("requirements.txt"), "requests\n").unwrap();
        std::fs::write(dir.join("package.json"), "{}\n").unwrap();
        assert_eq!(detect_runtime(&dir), ShellRuntime::Python);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn resolve_shell_binary_cmd_contains_system32() {
        let (binary, flag) = resolve_shell_binary(ShellKind::Cmd).unwrap();
        let s = binary.to_string_lossy().to_lowercase();
        assert!(s.contains("system32"), "cmd 路径应含 System32：{s}");
        assert!(s.ends_with("cmd.exe"));
        assert_eq!(flag, "/C");
    }

    #[cfg(windows)]
    #[test]
    fn resolve_shell_binary_powershell_path() {
        let (binary, flag) = resolve_shell_binary(ShellKind::PowerShell).unwrap();
        let s = binary.to_string_lossy().to_lowercase();
        assert!(s.contains("powershell"));
        assert!(s.ends_with("powershell.exe"));
        assert_eq!(flag, "-Command");
    }

    #[cfg(windows)]
    #[test]
    fn resolve_shell_binary_pwsh_errors_when_missing() {
        // pwsh 通常未装，应报错；若恰好装了（ProgramFiles\PowerShell\7\pwsh.exe 存在）则跳过断言。
        let program_files = std::env::var_os("ProgramFiles")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
        let pwsh = program_files.join("PowerShell").join("7").join("pwsh.exe");
        if pwsh.is_file() {
            let (binary, flag) = resolve_shell_binary(ShellKind::Pwsh).unwrap();
            assert_eq!(binary, pwsh);
            assert_eq!(flag, "-Command");
        } else {
            let err = resolve_shell_binary(ShellKind::Pwsh).unwrap_err();
            assert!(err.contains("pwsh 未安装"));
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn resolve_shell_binary_uses_bin_sh() {
        for kind in [ShellKind::Cmd, ShellKind::PowerShell, ShellKind::Pwsh] {
            let (binary, flag) = resolve_shell_binary(kind).unwrap();
            assert_eq!(binary, PathBuf::from("/bin/sh"));
            assert_eq!(flag, "-c");
        }
    }

    #[test]
    fn normalize_shell_defaults_cmd() {
        assert_eq!(normalize_shell(None), ShellKind::Cmd);
        assert_eq!(normalize_shell(Some("")), ShellKind::Cmd);
        assert_eq!(normalize_shell(Some("   ")), ShellKind::Cmd);
        assert_eq!(normalize_shell(Some("garbage")), ShellKind::Cmd);
    }

    #[test]
    fn normalize_shell_recognizes_known() {
        assert_eq!(normalize_shell(Some("powershell")), ShellKind::PowerShell);
        assert_eq!(normalize_shell(Some("pwsh")), ShellKind::Pwsh);
        assert_eq!(normalize_shell(Some("cmd")), ShellKind::Cmd);
    }

    #[test]
    fn prepend_plugin_paths_skips_when_no_venv_or_node_modules() {
        let dir = temp_plugin_dir();
        let env = vec![
            (OsString::from("PATH"), OsString::from("/app/node")),
            (OsString::from("SystemRoot"), OsString::from("C:\\Windows")),
        ];
        // python 无 venv / nodejs 无 node_modules → PATH 不变。
        let out_py = prepend_plugin_paths(env.clone(), &dir, ShellRuntime::Python);
        let path_py = out_py
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(OsStr::new("PATH")))
            .map(|(_, v)| v.clone())
            .unwrap();
        assert_eq!(path_py, OsString::from("/app/node"));
        let out_node = prepend_plugin_paths(env, &dir, ShellRuntime::Nodejs);
        let path_node = out_node
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(OsStr::new("PATH")))
            .map(|(_, v)| v.clone())
            .unwrap();
        assert_eq!(path_node, OsString::from("/app/node"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 无插件模式：plugin_id 为 None / 空 / 纯空白 → 都视为无插件。
    /// 这条断言锁定本次修复的核心契约——trim+filter 后的语义判定。
    #[test]
    fn plugin_id_blank_treated_as_no_plugin() {
        fn is_no_plugin(raw: Option<&str>) -> bool {
            raw.map(str::trim).filter(|s| !s.is_empty()).is_none()
        }
        assert!(is_no_plugin(None));
        assert!(is_no_plugin(Some("")));
        assert!(is_no_plugin(Some("   ")));
        assert!(is_no_plugin(Some("\t\n")));
        assert!(!is_no_plugin(Some("abc")));
        assert!(!is_no_plugin(Some("  abc  "))); // trim 后非空
    }

    /// 无插件模式：RunPluginShellInput 反序列化时 plugin_id 缺失/为 null → None。
    /// 锁定 `#[serde(default)]` 让旧前端（仍传字符串）和新前端（传 null）都兼容。
    #[test]
    fn run_plugin_shell_input_plugin_id_optional_deserialize() {
        // 缺失字段
        let json = r#"{"command":"echo hi"}"#;
        let parsed: RunPluginShellInput = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.plugin_id, None);

        // 显式 null
        let json = r#"{"plugin_id":null,"command":"echo hi"}"#;
        let parsed: RunPluginShellInput = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.plugin_id, None);

        // 字符串（兼容旧前端）
        let json = r#"{"plugin_id":"my-plugin","command":"echo hi"}"#;
        let parsed: RunPluginShellInput = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.plugin_id.as_deref(), Some("my-plugin"));
    }
}
