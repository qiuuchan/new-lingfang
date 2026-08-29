//! 统一运行时解析器（runtime_resolver）。
//!
//! 所有 Python / Node / FFmpeg / Chromium 进程调用的**唯一入口**：plugin_runner（持久化执行）、
//! plugin_script（预览执行 + probe）、Agent 工具链（经 Tauri 命令间接）全部经此解析。
//!
//! ## 「应用一定用自己管理的运行时」三条不变式
//!
//! 1. `resolve_runtime_command()` 永不查系统 PATH，只查应用内置 `runtimes/`。
//! 2. `env()` 清空宿主 PATH（`retain` 掉 key==PATH），只注入命中来源的 PATH ——
//!    子进程内部 `subprocess.run("python")` / `child_process.exec("node")` 也只能命中应用管理的解释器。
//! 3. `require_runtime_command()` 找不到返回结构化错误，前端引导用户检查安装包完整性。
//!
//! ## 解析优先级
//!
//! `resolve()` 只解析应用内置目录；缺失时返回 None 并提示安装包损坏。
//!
//! ## 目录布局约定
//!
//! 本项目正式发布目标仅 Windows x64，Python / Node / FFmpeg 主 exe 直接位于各自目录根。

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use tauri::Manager;

use crate::mirror_presets::{extract_host, resolve_npm_url, resolve_pip_url, MirrorConfig};

pub(crate) const PLAYWRIGHT_CHROMIUM_REVISION: &str = "1228";
pub(crate) const PLAYWRIGHT_CHROMIUM_VERSION: &str = "149.0.7827.55";

/// 运行时来源（供 UI 状态展示 + 日志）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RuntimeSource {
    Bundled,
}

/// 单个运行时的解析结果（dir + 来源）。
#[derive(Clone, Debug)]
struct ResolvedRuntime {
    /// 直接含主 exe 的目录。
    dir: PathBuf,
    /// 来源标签（Step 5 设置页 UI 展示用）。
    #[allow(dead_code)]
    source: RuntimeSource,
}

/// 统一运行时解析器：所有 Python / Node 调用的唯一入口。
pub(crate) struct RuntimeResolver {
    root: Option<PathBuf>,
    python: Option<ResolvedRuntime>,
    node: Option<ResolvedRuntime>,
    ffmpeg: Option<ResolvedRuntime>,
    chromium: Option<ResolvedRuntime>,
    mirrors: MirrorConfig,
}

impl RuntimeResolver {
    /// 从应用内置目录解析当前生效的运行时。
    pub(crate) fn resolve<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Self, String> {
        let root = bundled_runtimes_root(app);
        let python = resolve_bundled(&root, "python", python_exe);
        let node = resolve_bundled(&root, "nodejs", node_exe);
        let ffmpeg = resolve_bundled(&root, "ffmpeg", ffmpeg_exe);
        let chromium = root.as_ref().and_then(|root| {
            let dir = root.join("chromium");
            chromium_runtime_complete(&dir).then_some(ResolvedRuntime {
                dir,
                source: RuntimeSource::Bundled,
            })
        });
        Ok(Self {
            root,
            python,
            node,
            ffmpeg,
            chromium,
            mirrors: MirrorConfig::default(),
        })
    }

    /// 测试构造：直接指定 python_dir / node_dir（标 Bundled 来源）。
    /// 用 None 表示该运行时未配置，供 env()/require_* 的缺失路径测试。
    #[cfg(test)]
    pub(crate) fn from_dirs(python_dir: Option<PathBuf>, node_dir: Option<PathBuf>) -> Self {
        let python = python_dir.map(|dir| ResolvedRuntime {
            dir,
            source: RuntimeSource::Bundled,
        });
        let node = node_dir.map(|dir| ResolvedRuntime {
            dir,
            source: RuntimeSource::Bundled,
        });
        Self {
            root: None,
            python,
            node,
            ffmpeg: None,
            chromium: None,
            mirrors: MirrorConfig::default(),
        }
    }

    /// 测试构造：指定 ffmpeg_dir（标 Bundled 来源）。python/node 默认 None，
    /// 专用于 ffmpeg 进 PATH 的测试。
    #[cfg(test)]
    pub(crate) fn from_dirs_with_ffmpeg(ffmpeg_dir: Option<PathBuf>) -> Self {
        let ffmpeg = ffmpeg_dir.map(|dir| ResolvedRuntime {
            dir,
            source: RuntimeSource::Bundled,
        });
        Self {
            root: None,
            python: None,
            node: None,
            ffmpeg,
            chromium: None,
            mirrors: MirrorConfig::default(),
        }
    }

    #[cfg(test)]
    pub(crate) fn from_root(root: PathBuf) -> Self {
        let chromium_dir = root.join("chromium");
        let chromium = chromium_runtime_complete(&chromium_dir).then_some(ResolvedRuntime {
            dir: chromium_dir,
            source: RuntimeSource::Bundled,
        });
        Self {
            root: Some(root),
            python: None,
            node: None,
            ffmpeg: None,
            chromium,
            mirrors: MirrorConfig::default(),
        }
    }

    pub(crate) fn python(&self) -> Option<PathBuf> {
        self.python.as_ref().map(|r| python_exe(&r.dir))
    }

    pub(crate) fn node(&self) -> Option<PathBuf> {
        self.node.as_ref().map(|r| node_exe(&r.dir))
    }

    pub(crate) fn pip(&self) -> Option<PathBuf> {
        self.python.as_ref().and_then(|r| pip_exe(&r.dir))
    }

    pub(crate) fn uv(&self) -> Option<PathBuf> {
        self.python.as_ref().and_then(|r| uv_exe(&r.dir))
    }

    pub(crate) fn npm(&self) -> Option<PathBuf> {
        self.node.as_ref().and_then(|r| npm_exe(&r.dir))
    }

    pub(crate) fn pnpm(&self) -> Option<PathBuf> {
        self.node.as_ref().and_then(|r| pnpm_exe(&r.dir))
    }

    /// FFmpeg 主 exe 绝对路径（runtimes/ffmpeg/ffmpeg.exe）。
    pub(crate) fn ffmpeg(&self) -> Option<PathBuf> {
        self.ffmpeg.as_ref().map(|r| ffmpeg_exe(&r.dir))
    }

    pub(crate) fn chromium(&self) -> Option<PathBuf> {
        self.chromium.as_ref().map(|r| chromium_exe(&r.dir))
    }

    pub(crate) fn playwright_browsers_dir(&self) -> Option<PathBuf> {
        self.root
            .as_ref()
            .map(|root| root.join("chromium").join("ms-playwright"))
            .filter(|dir| dir.is_dir())
    }

    /// Python 主 exe 所在目录（供 bundled_pip_wheel_dir 推导 ensurepip/_bundled 路径）。
    pub(crate) fn python_dir(&self) -> Option<&Path> {
        self.python.as_ref().map(|r| r.dir.as_path())
    }

    /// Node 主 exe 所在目录（供 UI 状态展示）。
    #[allow(dead_code)]
    pub(crate) fn node_dir(&self) -> Option<&Path> {
        self.node.as_ref().map(|r| r.dir.as_path())
    }

    /// FFmpeg 主 exe 所在目录（runtimes/ffmpeg/）。
    #[allow(dead_code)]
    pub(crate) fn ffmpeg_dir(&self) -> Option<&Path> {
        self.ffmpeg.as_ref().map(|r| r.dir.as_path())
    }

    pub(crate) fn chromium_dir(&self) -> Option<&Path> {
        self.chromium.as_ref().map(|r| r.dir.as_path())
    }

    pub(crate) fn python_source(&self) -> Option<&RuntimeSource> {
        self.python.as_ref().map(|r| &r.source)
    }

    #[allow(dead_code)]
    pub(crate) fn node_source(&self) -> Option<&RuntimeSource> {
        self.node.as_ref().map(|r| &r.source)
    }

    #[allow(dead_code)]
    pub(crate) fn ffmpeg_source(&self) -> Option<&RuntimeSource> {
        self.ffmpeg.as_ref().map(|r| &r.source)
    }

    pub(crate) fn chromium_source(&self) -> Option<&RuntimeSource> {
        self.chromium.as_ref().map(|r| &r.source)
    }

    #[allow(dead_code)]
    pub(crate) fn mirrors(&self) -> &MirrorConfig {
        &self.mirrors
    }

    /// 按命令名解析运行时绝对路径（永不查系统 PATH）。
    pub(crate) fn resolve_runtime_command(&self, command: &str) -> Option<PathBuf> {
        match normalize_command_name(command).as_deref() {
            Some("python" | "python3" | "py") => self.python(),
            Some("pip" | "pip3") => self.pip(),
            Some("uv") => self.uv(),
            Some("node" | "nodejs") => self.node(),
            Some("npm") => self.npm(),
            Some("pnpm") => self.pnpm(),
            // FFmpeg 内置运行时：给需要绝对路径直接 spawn ffmpeg 的插件。
            // 多数插件走 shutil.which("ffmpeg")——靠 path_value() 把 runtimes/ffmpeg/ 加进 PATH 命中。
            Some("ffmpeg") => self.ffmpeg(),
            Some("chromium" | "chrome") => self.chromium(),
            _ => None,
        }
    }

    /// 按命令名解析运行时绝对路径，缺失时提示安装包损坏。
    pub(crate) fn require_runtime_command(&self, command: &str) -> Result<PathBuf, String> {
        self.resolve_runtime_command(command).ok_or_else(|| {
            format!("未找到内置运行时命令 {command}。安装包可能不完整，请重新安装千匣台。")
        })
    }

    /// 构造子进程环境变量：清宿主 PATH + 注入命中来源 PATH + 镜像源。
    pub(crate) fn env(&self, base: Vec<(OsString, OsString)>) -> Vec<(OsString, OsString)> {
        let mut env = base;
        env.retain(|(key, _)| !key.eq_ignore_ascii_case(OsStr::new("PATH")));
        env.push((OsString::from("PATH"), self.path_value()));

        let pip_url = resolve_pip_url(&self.mirrors);
        let npm_url = resolve_npm_url(&self.mirrors);
        env.push((OsString::from("PIP_INDEX_URL"), OsString::from(&pip_url)));
        if let Some(host) = extract_host(&pip_url) {
            env.push((OsString::from("PIP_TRUSTED_HOST"), OsString::from(host)));
        }
        // uv 故意不读 PIP_INDEX_URL（astral-sh/uv#6925），必须用 UV_* 变量，否则 uv pip install /
        // uv sync 会回退官方 PyPI（国内慢/超时）。同时注入 UV_DEFAULT_INDEX（新版首选）和
        // UV_INDEX_URL（pip 兼容别名，老版 uv 用），让任一版本的 uv 都命中清华源。
        env.push((OsString::from("UV_DEFAULT_INDEX"), OsString::from(&pip_url)));
        env.push((OsString::from("UV_INDEX_URL"), OsString::from(&pip_url)));
        env.push((
            OsString::from("PIP_DISABLE_PIP_VERSION_CHECK"),
            OsString::from("1"),
        ));
        env.push((OsString::from("PIP_NO_INPUT"), OsString::from("1")));
        env.push((
            OsString::from("NPM_CONFIG_REGISTRY"),
            OsString::from(&npm_url),
        ));
        env.push((
            OsString::from("npm_config_registry"),
            OsString::from(&npm_url),
        ));
        env.push((
            OsString::from("COREPACK_ENABLE_DOWNLOAD_PROMPT"),
            OsString::from("0"),
        ));
        env.push((
            OsString::from("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"),
            OsString::from("1"),
        ));
        if let Some(dir) = self.playwright_browsers_dir() {
            env.push((
                OsString::from("PLAYWRIGHT_BROWSERS_PATH"),
                dir.into_os_string(),
            ));
        }
        env
    }

    /// 拼接命中来源的 PATH 值（node + node/bin + python + python/Scripts + python/bin
    /// + ffmpeg + Windows 系统目录 System32 / Wbem / PowerShell）。
    ///
    /// **必须追加系统目录**：进程清空宿主 PATH 后，若 PATH 不含 System32，python.exe / node.exe
    /// 启动时加载依赖 DLL（VCRUNTIME、api-ms-win-* 等）会因搜索路径缺失而立即崩溃（输出任何 stderr
    /// 之前退出）；且 PS launcher 的 `cmd /c pause`、插件内 `shutil.which("ffmpeg")` 等
    /// 也需 System32。这是 Windows 沙盒的通行做法：PATH 可受限，但 System32 必须保留。
    ///
    /// **ffmpeg 内置运行时进 PATH**：把 runtimes/ffmpeg/ 加到 PATH，插件的
    /// `shutil.which("ffmpeg")` 直接命中内置版本，无需宿主机安装 ffmpeg。
    pub(crate) fn path_value(&self) -> OsString {
        let mut paths = Vec::new();
        if let Some(node) = &self.node {
            push_if_dir(&mut paths, node.dir.clone());
            push_if_dir(&mut paths, node.dir.join("bin"));
        }
        if let Some(python) = &self.python {
            push_if_dir(&mut paths, python.dir.clone());
            push_if_dir(&mut paths, python.dir.join("Scripts"));
            push_if_dir(&mut paths, python.dir.join("bin"));
        }
        if let Some(ffmpeg) = &self.ffmpeg {
            push_if_dir(&mut paths, ffmpeg.dir.clone());
        }
        if let Some(chromium) = self.chromium() {
            if let Some(dir) = chromium.parent() {
                push_if_dir(&mut paths, dir.to_path_buf());
            }
        }
        // 追加 Windows 系统目录（System32 + Wbem + PowerShell），保证 OS 基础工具/DLL 可达。
        #[cfg(windows)]
        {
            let sysroot =
                std::env::var_os("SystemRoot").unwrap_or_else(|| OsString::from("C:\\Windows"));
            let sysroot = PathBuf::from(sysroot);
            push_if_dir(&mut paths, sysroot.join("System32"));
            push_if_dir(&mut paths, sysroot.join("System32").join("Wbem"));
            push_if_dir(
                &mut paths,
                sysroot
                    .join("System32")
                    .join("WindowsPowerShell")
                    .join("v1.0"),
            );
        }
        std::env::join_paths(paths).unwrap_or_default()
    }
}

// === 解析逻辑 ===

fn resolve_bundled(
    root: &Option<PathBuf>,
    subdir: &str,
    executable: fn(&Path) -> PathBuf,
) -> Option<ResolvedRuntime> {
    let dir = root.as_ref()?.join(subdir);
    executable(&dir).is_file().then_some(ResolvedRuntime {
        dir,
        source: RuntimeSource::Bundled,
    })
}

fn bundled_runtimes_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    if let Some(root) = std::env::var_os("QIANXIA_EMBEDDED_RUNTIME_DIR").map(PathBuf::from) {
        if root.is_dir() {
            return Some(root);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let root = parent.join("runtimes");
            if root.is_dir() {
                return Some(root);
            }
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let root = resource_dir.join("runtimes");
        if root.is_dir() {
            return Some(root);
        }
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .join("runtimes");
    root.is_dir().then_some(root)
}

// === exe 路径辅助（跨平台） ===

#[cfg(windows)]
fn python_exe(dir: &Path) -> PathBuf {
    dir.join("python.exe")
}
#[cfg(not(windows))]
fn python_exe(dir: &Path) -> PathBuf {
    dir.join("bin").join("python")
}

#[cfg(windows)]
fn node_exe(dir: &Path) -> PathBuf {
    dir.join("node.exe")
}
#[cfg(not(windows))]
fn node_exe(dir: &Path) -> PathBuf {
    dir.join("bin").join("node")
}

#[cfg(windows)]
fn ffmpeg_exe(dir: &Path) -> PathBuf {
    dir.join("ffmpeg.exe")
}
#[cfg(not(windows))]
fn ffmpeg_exe(dir: &Path) -> PathBuf {
    dir.join("bin").join("ffmpeg")
}

fn chromium_exe(dir: &Path) -> PathBuf {
    dir.join("ms-playwright")
        .join(format!("chromium-{PLAYWRIGHT_CHROMIUM_REVISION}"))
        .join("chrome-win64")
        .join("chrome.exe")
}

fn chromium_headless_exe(dir: &Path) -> PathBuf {
    dir.join("ms-playwright")
        .join(format!(
            "chromium_headless_shell-{PLAYWRIGHT_CHROMIUM_REVISION}"
        ))
        .join("chrome-headless-shell-win64")
        .join("chrome-headless-shell.exe")
}

fn chromium_runtime_complete(dir: &Path) -> bool {
    chromium_exe(dir).is_file() && chromium_headless_exe(dir).is_file()
}

fn pip_exe(dir: &Path) -> Option<PathBuf> {
    first_existing(windows_unix_many(
        vec![
            dir.join("Scripts").join("pip.exe"),
            dir.join("Scripts").join("pip.cmd"),
            dir.join("Scripts").join("pip.bat"),
        ],
        vec![dir.join("bin").join("pip")],
    ))
}

fn uv_exe(dir: &Path) -> Option<PathBuf> {
    first_existing(windows_unix_many(
        vec![
            dir.join("uv.exe"),
            dir.join("Scripts").join("uv.exe"),
            dir.join("uv"),
        ],
        vec![dir.join("bin").join("uv"), dir.join("uv")],
    ))
}

fn npm_exe(dir: &Path) -> Option<PathBuf> {
    first_existing(windows_unix_many(
        vec![dir.join("npm.cmd"), dir.join("npm.exe"), dir.join("npm")],
        vec![dir.join("bin").join("npm"), dir.join("npm")],
    ))
}

fn pnpm_exe(dir: &Path) -> Option<PathBuf> {
    first_existing(windows_unix_many(
        vec![dir.join("pnpm.cmd"), dir.join("pnpm.exe"), dir.join("pnpm")],
        vec![dir.join("bin").join("pnpm"), dir.join("pnpm")],
    ))
}

fn normalize_command_name(command: &str) -> Option<String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return None;
    }
    let file_name = Path::new(trimmed).file_name()?.to_string_lossy();
    let lower = file_name.to_ascii_lowercase();
    Some(
        lower
            .strip_suffix(".exe")
            .or_else(|| lower.strip_suffix(".cmd"))
            .or_else(|| lower.strip_suffix(".bat"))
            .unwrap_or(&lower)
            .to_string(),
    )
}

fn first_existing(paths: Vec<PathBuf>) -> Option<PathBuf> {
    paths.into_iter().find(|path| path.is_file())
}

fn push_if_dir(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if path.is_dir() {
        paths.push(path);
    }
}

#[cfg(windows)]
fn windows_unix_many(windows: Vec<PathBuf>, _unix: Vec<PathBuf>) -> Vec<PathBuf> {
    windows
}
#[cfg(not(windows))]
fn windows_unix_many(_windows: Vec<PathBuf>, unix: Vec<PathBuf>) -> Vec<PathBuf> {
    unix
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_commands_are_detected_by_name() {
        let r = RuntimeResolver::from_dirs(None, None);
        assert!(r.resolve_runtime_command("node").is_none()); // 未配置 → None
        assert!(r.resolve_runtime_command("git").is_none()); // 非运行时命令
                                                             // 名字归一化（带后缀也能识别），但因未配置 exe 仍 None。
        assert!(r.resolve_runtime_command("python.exe").is_none());
    }

    #[test]
    fn env_replaces_path_and_adds_default_mirrors() {
        // 无运行时 + default config（清华 / npmmirror）。
        let r = RuntimeResolver::from_dirs(None, None);
        let env = r.env(vec![
            (OsString::from("PATH"), OsString::from("host-path")),
            (OsString::from("SystemRoot"), OsString::from("C:\\Windows")),
        ]);
        let contains = |key: &str, value: &str| {
            env.iter()
                .any(|(k, v)| k.to_string_lossy() == key && v.to_string_lossy() == value)
        };
        // 宿主其它变量保留。
        assert!(contains("SystemRoot", "C:\\Windows"));
        // 默认镜像注入。
        assert!(contains(
            "PIP_INDEX_URL",
            "https://pypi.tuna.tsinghua.edu.cn/simple"
        ));
        assert!(contains(
            "NPM_CONFIG_REGISTRY",
            "https://registry.npmmirror.com"
        ));
        // trusted host 从 pip url 提取。
        assert!(contains("PIP_TRUSTED_HOST", "pypi.tuna.tsinghua.edu.cn"));
        // uv 不读 PIP_INDEX_URL（astral-sh/uv#6925），必须额外注入 UV_* 变量，
        // 否则 uv pip install / uv sync 回退官方 PyPI。两个别名都应等于清华源。
        assert!(contains(
            "UV_DEFAULT_INDEX",
            "https://pypi.tuna.tsinghua.edu.cn/simple"
        ));
        assert!(contains(
            "UV_INDEX_URL",
            "https://pypi.tuna.tsinghua.edu.cn/simple"
        ));
        // 宿主 PATH 被清空（替换为命中来源的 PATH，无运行时则为空）。
        assert!(!contains("PATH", "host-path"));
    }

    #[cfg(windows)]
    #[test]
    fn path_value_includes_windows_system32() {
        // System32 必须在 PATH 里：python/node 启动加载依赖 DLL、PS launcher 的 cmd /c pause、
        // 插件内 shutil.which("ffmpeg") 等都依赖 System32。清空宿主 PATH 后必须补回。
        let r = RuntimeResolver::from_dirs(None, None);
        let path = r.path_value().to_string_lossy().to_string();
        assert!(
            path.to_ascii_lowercase().contains("system32"),
            "PATH 应含 System32，实际：{path}"
        );
    }

    #[test]
    fn require_runtime_command_errors_when_missing() {
        let r = RuntimeResolver::from_dirs(None, None);
        let err = r.require_runtime_command("python").unwrap_err();
        assert!(err.contains("重新安装"), "错误应引导重新安装：{err}");
    }

    #[test]
    fn chromium_command_and_playwright_env_use_bundled_root() {
        let root =
            std::env::temp_dir().join(format!("qx-runtime-resolver-{}", uuid::Uuid::new_v4()));
        let chrome = root
            .join("chromium/ms-playwright")
            .join(format!("chromium-{PLAYWRIGHT_CHROMIUM_REVISION}"))
            .join("chrome-win64/chrome.exe");
        let headless = root
            .join("chromium/ms-playwright")
            .join(format!(
                "chromium_headless_shell-{PLAYWRIGHT_CHROMIUM_REVISION}"
            ))
            .join("chrome-headless-shell-win64/chrome-headless-shell.exe");
        std::fs::create_dir_all(chrome.parent().unwrap()).unwrap();
        std::fs::create_dir_all(headless.parent().unwrap()).unwrap();
        std::fs::write(&chrome, b"fake").unwrap();
        std::fs::write(&headless, b"fake").unwrap();
        let r = RuntimeResolver::from_root(root.clone());
        assert_eq!(r.resolve_runtime_command("chrome.exe"), Some(chrome));
        let env = r.env(vec![]);
        assert!(env.iter().any(|(key, value)| {
            key == "PLAYWRIGHT_BROWSERS_PATH"
                && value
                    == &root
                        .join("chromium")
                        .join("ms-playwright")
                        .into_os_string()
        }));
        assert!(env
            .iter()
            .any(|(key, value)| { key == "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD" && value == "1" }));
        let _ = std::fs::remove_dir_all(root);
    }

    // === ffmpeg 内置运行时（第三运行时）测试 ===

    #[test]
    fn ffmpeg_none_when_not_configured() {
        // 无 ffmpeg 配置 → ffmpeg() / ffmpeg_dir() / ffmpeg_source() 全 None。
        let r = RuntimeResolver::from_dirs(None, None);
        assert!(r.ffmpeg().is_none());
        assert!(r.ffmpeg_dir().is_none());
        assert!(r.ffmpeg_source().is_none());
        // resolve_runtime_command 也 None。
        assert!(r.resolve_runtime_command("ffmpeg").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn ffmpeg_dir_in_path_when_configured() {
        // 临时目录建 fake ffmpeg.exe → ffmpeg dir 应进 PATH（关键：插件 shutil.which 命中靠此）。
        let tmp = std::env::temp_dir().join(format!(
            "qx-ffmpeg-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("ffmpeg.exe"), b"fake").unwrap();
        let r = RuntimeResolver::from_dirs_with_ffmpeg(Some(tmp.clone()));
        let path = r.path_value().to_string_lossy().to_string();
        assert!(
            path.contains(&tmp.to_string_lossy().to_string()),
            "PATH 应含 ffmpeg 目录，实际：{path}"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_ffmpeg_by_name() {
        // 命名归一化：ffmpeg / ffmpeg.exe / FFMPEG 都解析到 ffmpeg 运行时。
        let tmp = std::env::temp_dir().join(format!(
            "qx-ffmpeg-name-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        // 跨平台：Windows 建 ffmpeg.exe，Unix 建 bin/ffmpeg。
        #[cfg(windows)]
        std::fs::write(tmp.join("ffmpeg.exe"), b"fake").unwrap();
        #[cfg(not(windows))]
        {
            std::fs::create_dir_all(tmp.join("bin")).unwrap();
            std::fs::write(tmp.join("bin").join("ffmpeg"), b"fake").unwrap();
        }
        let r = RuntimeResolver::from_dirs_with_ffmpeg(Some(tmp.clone()));
        assert!(r.resolve_runtime_command("ffmpeg").is_some());
        assert!(r.resolve_runtime_command("FFMPEG").is_some());
        #[cfg(windows)]
        assert!(r.resolve_runtime_command("ffmpeg.exe").is_some());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
