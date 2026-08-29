use std::fs;
use std::path::{Path, PathBuf};

use crate::plugin_runner;

pub(super) fn default_entry(runtime: &str) -> &'static [u8] {
    match runtime {
        "python" => {
            b"def main():\n    print('QianXia plugin')\n\nif __name__ == '__main__':\n    main()\n"
        }
        "nodejs" => b"console.log('QianXia plugin');\n",
        _ => b"<!doctype html><html><body><main id=\"app\"></main></body></html>\n",
    }
}

pub(super) fn validate_storage_segment(value: &str, label: &str) -> Result<(), String> {
    let windows_stem = value
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let windows_reserved = matches!(windows_stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || windows_stem
            .strip_prefix("COM")
            .or_else(|| windows_stem.strip_prefix("LPT"))
            .is_some_and(|suffix| suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9'));
    if value.is_empty()
        || value.len() > 200
        || value.starts_with('.')
        || value.ends_with('.')
        || windows_reserved
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(format!(
            "{label} 不是安全的存储标识（仅允许字母、数字、点、下划线和短横线）"
        ));
    }
    Ok(())
}

pub(super) fn copy_directory_contents(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| format!("创建数据目录失败：{error}"))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("读取旧 data 目录失败：{error}"))?
        .flatten()
    {
        let source_path = entry.path();
        let target_path = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path)
            .map_err(|error| format!("读取旧 data 文件失败：{error}"))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "旧 data 目录包含不支持的符号链接：{}",
                source_path.display()
            ));
        }
        if metadata.is_dir() {
            copy_directory_contents(&source_path, &target_path)?;
        } else if metadata.is_file() {
            fs::copy(&source_path, &target_path)
                .map_err(|error| format!("复制旧 data 文件失败：{error}"))?;
        }
    }
    Ok(())
}

pub(super) fn remove_release_directory(package_path: &str) {
    let package = PathBuf::from(package_path);
    if let Some(release_root) = package.parent() {
        let _ = fs::remove_dir_all(release_root);
    }
}

pub(super) fn remove_release_environment(package_path: &str) {
    let _ = try_remove_release_environment(package_path);
}

fn try_remove_release_environment(package_path: &str) -> Result<(), String> {
    let environment = plugin_runner::python_venv_dir(Path::new(package_path));
    remove_environment_directory(&environment)?;
    let package = Path::new(package_path);
    let Some(release_root) = package.parent() else {
        return Ok(());
    };
    let Some(release_id) = release_root.file_name().and_then(|value| value.to_str()) else {
        return Ok(());
    };
    let Some(installation_root) = release_root.parent().and_then(Path::parent) else {
        return Ok(());
    };
    try_remove_release_environment_path(installation_root, release_id)
}

pub(super) fn remove_release_environment_path(installation_root: &Path, release_id: &str) {
    let _ = try_remove_release_environment_path(installation_root, release_id);
}

fn try_remove_release_environment_path(
    installation_root: &Path,
    release_id: &str,
) -> Result<(), String> {
    let environment = installation_root.join("environments").join(release_id);
    remove_environment_directory(&environment)
}

pub(super) fn remove_external_python_environment(package_path: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        let environment = plugin_runner::python_venv_dir(Path::new(package_path));
        return remove_environment_directory(&environment);
    }
    #[cfg(not(windows))]
    {
        let _ = package_path;
        Ok(())
    }
}

pub(super) fn remove_environment_directory(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    fs::remove_dir_all(path)
        .map_err(|error| format!("删除插件运行环境 {} 失败：{error}", path.display()))
}

pub(super) fn create_directory_link(link: &Path, target: &Path, label: &str) -> Result<(), String> {
    if fs::symlink_metadata(link).is_ok() {
        return Err(format!("发行版制品不能自带 {label} 目录"));
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link)
            .map_err(|error| format!("链接{label}目录失败：{error}"))
    }
    #[cfg(windows)]
    {
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .status()
            .map_err(|error| format!("创建{label}目录联接失败：{error}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("创建{label}目录联接失败，退出码：{status}"))
        }
    }
}
