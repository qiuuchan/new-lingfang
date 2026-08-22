use std::path::{Path, PathBuf};
use std::process::Command;

/// 跨平台 PATH 探测候选二进制，Windows 优先补 .cmd/.bat（npm shim）再 .exe。
pub(crate) fn find_binary(candidate: &str) -> Option<PathBuf> {
    find_binaries(candidate).into_iter().next()
}

pub(crate) fn find_binaries(candidate: &str) -> Vec<PathBuf> {
    let Some(path) = std::env::var_os("PATH") else {
        return Vec::new();
    };
    find_binaries_in_path(candidate, &path)
}

pub(crate) fn find_binaries_in_path(candidate: &str, path: &std::ffi::OsStr) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for dir in std::env::split_paths(path) {
        #[cfg(windows)]
        {
            for ext in [".cmd", ".bat", ".exe"] {
                push_existing_unique(&mut found, dir.join(format!("{candidate}{ext}")));
            }
        }
        push_existing_unique(&mut found, dir.join(candidate));
        #[cfg(windows)]
        {
            push_existing_unique(&mut found, dir.join(format!("{candidate}.exe")));
        }
    }
    found
}

fn push_existing_unique(found: &mut Vec<PathBuf>, path: PathBuf) {
    if path.is_file() && !found.contains(&path) {
        found.push(path);
    }
}

/// 构造子进程 Command。Windows 上 npm 全局 CLI 的 .cmd/.bat shim 会解析为真实入口。
pub(crate) fn build_spawn_command(binary: &Path, args: &[String]) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let is_batch = binary
            .extension()
            .map(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
            .unwrap_or(false);
        if is_batch {
            if let Some(resolved) = resolve_npm_shim(binary) {
                let mut cmd = Command::new(&resolved.binary);
                cmd.creation_flags(CREATE_NO_WINDOW)
                    .args(&resolved.prefix_args)
                    .args(args);
                return cmd;
            }
            let mut cmd = Command::new("cmd");
            cmd.creation_flags(CREATE_NO_WINDOW)
                .arg("/C")
                .arg(binary)
                .args(args);
            return cmd;
        }
        let mut cmd = Command::new(binary);
        cmd.creation_flags(CREATE_NO_WINDOW).args(args);
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new(binary);
        cmd.args(args);
        cmd
    }
}

#[cfg(windows)]
pub(crate) struct ResolvedShim {
    pub(crate) binary: PathBuf,
    pub(crate) prefix_args: Vec<String>,
}

#[cfg(windows)]
pub(crate) fn resolve_npm_shim(cmd_path: &Path) -> Option<ResolvedShim> {
    let content = std::fs::read_to_string(cmd_path).ok()?;
    let dp0 = cmd_path.parent()?;
    let raw = regex_lite_quotes(&content)
        .into_iter()
        .filter(|cap| {
            cap.contains("node_modules")
                && (cap.ends_with(".exe")
                    || cap.ends_with(".js")
                    || cap.ends_with(".mjs")
                    || cap.ends_with(".cjs"))
        })
        .next_back()?;
    let path = expand_npm_shim_path(&raw, dp0);
    if !path.is_file() {
        return None;
    }
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("exe") => Some(ResolvedShim {
            binary: path,
            prefix_args: vec![],
        }),
        Some("js" | "mjs" | "cjs") => Some(ResolvedShim {
            binary: find_binary("node")?,
            prefix_args: vec![path.to_string_lossy().to_string()],
        }),
        _ => None,
    }
}

#[cfg(windows)]
fn expand_npm_shim_path(raw: &str, dp0: &Path) -> PathBuf {
    for token in ["%~dp0", "%dp0%", "%basedir%", "%basedir:\\=/%"] {
        if let Some(rest) = strip_var_prefix(raw, token) {
            return dp0.join(rest.trim_start_matches(['\\', '/']));
        }
    }
    PathBuf::from(raw)
}

#[cfg(windows)]
fn strip_var_prefix<'a>(raw: &'a str, token: &str) -> Option<&'a str> {
    let prefix = raw.get(..token.len())?;
    prefix
        .eq_ignore_ascii_case(token)
        .then_some(&raw[token.len()..])
}

#[cfg(windows)]
fn regex_lite_quotes(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = content.chars().peekable();
    while let Some(char) = chars.next() {
        if char != '"' {
            continue;
        }
        let mut quoted = String::new();
        for inner in chars.by_ref() {
            if inner == '"' {
                break;
            }
            quoted.push(inner);
        }
        if !quoted.is_empty() {
            out.push(quoted);
        }
    }
    out
}

#[cfg(test)]
pub(crate) fn command_preview(binary: &Path, args: &[String]) -> Vec<String> {
    let mut preview = vec![binary.to_string_lossy().to_string()];
    preview.extend(args.iter().map(|arg| redact_arg(arg)));
    preview
}

#[cfg(test)]
fn redact_arg(arg: &str) -> String {
    let lower = arg.to_ascii_lowercase();
    if lower.contains("token") || lower.contains("key") || lower.contains("secret") {
        "[redacted]".to_string()
    } else {
        arg.to_string()
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    #[test]
    fn expand_npm_shim_path_supports_common_batch_prefixes() {
        let dp0 = Path::new(r"C:\Users\me\AppData\Roaming\npm");

        assert_eq!(
            expand_npm_shim_path(r"%~dp0\node_modules\pnpm\bin\pnpm.cjs", dp0),
            dp0.join(r"node_modules\pnpm\bin\pnpm.cjs"),
        );
        assert_eq!(
            expand_npm_shim_path(r"%dp0%\node_modules\npm\bin\npm-cli.js", dp0),
            dp0.join(r"node_modules\npm\bin\npm-cli.js"),
        );
        assert_eq!(
            expand_npm_shim_path(r"%basedir%\node_modules\npm\bin\npm-cli.js", dp0),
            dp0.join(r"node_modules\npm\bin\npm-cli.js"),
        );
    }
}
