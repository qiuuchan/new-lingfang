//! Read-only status for the application-bundled Windows x64 runtimes.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::runtime_resolver::RuntimeResolver;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub available: bool,
    pub source: Option<&'static str>,
    pub version: Option<String>,
    pub binary_path: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatusMap {
    pub python: RuntimeStatus,
    pub node: RuntimeStatus,
    pub ffmpeg: RuntimeStatus,
    pub chromium: RuntimeStatus,
}

#[derive(Clone, Copy)]
enum RuntimeKind {
    Python,
    Node,
    Ffmpeg,
    Chromium,
}

#[tauri::command]
pub fn get_runtime_status(app: tauri::AppHandle) -> Result<RuntimeStatusMap, String> {
    let resolver = RuntimeResolver::resolve(&app)?;
    Ok(RuntimeStatusMap {
        python: status_for(resolver.python(), RuntimeKind::Python),
        node: status_for(resolver.node(), RuntimeKind::Node),
        ffmpeg: status_for(resolver.ffmpeg(), RuntimeKind::Ffmpeg),
        chromium: status_for(resolver.chromium(), RuntimeKind::Chromium),
    })
}

fn status_for(binary: Option<PathBuf>, kind: RuntimeKind) -> RuntimeStatus {
    let Some(binary) = binary else {
        return RuntimeStatus {
            available: false,
            source: None,
            version: None,
            binary_path: None,
            error: Some(format!("未找到内置 {}，安装包可能不完整", label(kind))),
        };
    };
    match probe_version(&binary, kind) {
        Ok(version) => RuntimeStatus {
            available: true,
            source: Some("bundled"),
            version: Some(version),
            binary_path: Some(binary.to_string_lossy().to_string()),
            error: None,
        },
        Err(error) => RuntimeStatus {
            available: true,
            source: Some("bundled"),
            version: None,
            binary_path: Some(binary.to_string_lossy().to_string()),
            error: Some(error),
        },
    }
}

fn label(kind: RuntimeKind) -> &'static str {
    match kind {
        RuntimeKind::Python => "Python",
        RuntimeKind::Node => "Node.js",
        RuntimeKind::Ffmpeg => "FFmpeg",
        RuntimeKind::Chromium => "Chromium",
    }
}

fn probe_version(exe: &Path, kind: RuntimeKind) -> Result<String, String> {
    if matches!(kind, RuntimeKind::Chromium) {
        return Ok(crate::runtime_resolver::PLAYWRIGHT_CHROMIUM_VERSION.to_string());
    }
    let args = match kind {
        RuntimeKind::Ffmpeg => vec!["-version".to_string()],
        _ => vec!["--version".to_string()],
    };
    let captured = crate::process_util::run_capture_with_env(
        &exe.to_path_buf(),
        args,
        None,
        5_000,
        crate::plugin_runner::minimal_env(),
    )
    .map_err(|error| format!("{} 版本探测失败：{error}", label(kind)))?;
    if captured.exit_code != Some(0) {
        return Err(format!(
            "{} 版本探测失败（exit={:?}）",
            label(kind),
            captured.exit_code
        ));
    }
    let raw = format!("{}\n{}", captured.stdout.trim(), captured.stderr.trim());
    raw.lines()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string())
        .ok_or_else(|| format!("{} 版本输出为空", label(kind)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_runtime_is_read_only_packaging_error() {
        let status = status_for(None, RuntimeKind::Chromium);
        assert!(!status.available);
        assert_eq!(status.source, None);
        assert!(status.error.unwrap().contains("安装包可能不完整"));
    }

    #[test]
    fn labels_cover_all_bundled_runtimes() {
        assert_eq!(label(RuntimeKind::Python), "Python");
        assert_eq!(label(RuntimeKind::Node), "Node.js");
        assert_eq!(label(RuntimeKind::Ffmpeg), "FFmpeg");
        assert_eq!(label(RuntimeKind::Chromium), "Chromium");
    }
}
