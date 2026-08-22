//! 安装目录定位（design §4）。
//!
//! 默认安装目录 `%LOCALAPPDATA%\LingFang`（保留旧路径，兼容旧版用户原地覆盖升级）。
//! 应用标识与显示名集中在此，供注册表/快捷方式/卸载器复用。

use std::path::PathBuf;

use anyhow::{anyhow, Result};

/// 安装目录叶子名（保留旧 NSIS 路径 LingFang，非显示名「灵坊」）。
pub const INSTALL_DIR_NAME: &str = "LingFang";

/// 应用显示名（开始菜单/快捷方式/控制面板展示）。
pub const DISPLAY_NAME: &str = "灵坊工作台";

/// 版本号（编译期由 build.rs 从桌面端 tauri.conf.json 注入）。
/// 用于安装器标题/界面显示版本。
pub const VERSION: &str = env!("LINGFANG_APP_VERSION");

/// 主程序可执行文件名。
pub const MAIN_EXE: &str = "lingfang-desktop.exe";

/// 安装目录内的更新器/卸载器文件名（= installer.exe 的副本）。
pub const UPDATER_EXE: &str = "updater.exe";

/// 注册表 Uninstall 子键名（用应用标识，与旧 identifier 对齐）。
pub const UNINSTALL_KEY_NAME: &str = "com.lingfang.desktop";

/// 默认安装目录：`%LOCALAPPDATA%\LingFang`。
pub fn default_install_dir() -> Result<PathBuf> {
    let base = dirs::data_local_dir().ok_or_else(|| anyhow!("无法定位 LOCALAPPDATA 目录"))?;
    Ok(base.join(INSTALL_DIR_NAME))
}

/// 解析最终安装目录：显式传入则用传入值，否则默认目录。
pub fn resolve_install_dir(arg: Option<&str>) -> Result<PathBuf> {
    match arg {
        Some(p) if !p.trim().is_empty() => Ok(PathBuf::from(p.trim())),
        _ => default_install_dir(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_uses_explicit_arg() {
        let dir = resolve_install_dir(Some("C:\\Custom\\Path")).unwrap();
        assert_eq!(dir, PathBuf::from("C:\\Custom\\Path"));
    }

    #[test]
    fn resolve_trims_and_falls_back_on_blank() {
        // 空白参数退回默认目录（不应等于空路径）。
        let dir = resolve_install_dir(Some("   ")).unwrap();
        assert!(dir.ends_with(INSTALL_DIR_NAME));
    }

    #[test]
    fn resolve_none_uses_default() {
        let dir = resolve_install_dir(None).unwrap();
        assert!(dir.ends_with(INSTALL_DIR_NAME));
    }
}
