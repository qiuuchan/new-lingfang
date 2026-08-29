//! 自制 Windows 安装/更新/卸载器入口（PRD R3/R4/R8）。
//!
//! 模式分派见 cli.rs。核心自解压/校验/路径逻辑见 sfx.rs / integrity.rs / paths.rs。
//! Windows 平台操作（注册表/快捷方式/进程）见 platform/。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli;
mod integrity;
mod paths;
mod sfx;

#[cfg(windows)]
mod platform;

#[cfg(windows)]
mod theme;

mod modes;

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = match cli::parse_args(&args) {
        Ok(m) => m,
        Err(e) => {
            log_line(&format!("参数解析失败：{e}"));
            return ExitCode::from(2);
        }
    };

    let result = modes::run(mode);
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            log_line(&format!("执行失败：{e:#}"));
            ExitCode::FAILURE
        }
    }
}

/// 写一行日志到 `%LOCALAPPDATA%\QianXia\logs\updater.log`（无 UI 模式排障用，design §6）。
/// 失败静默（日志本身不应阻断主流程）。
pub fn log_line(msg: &str) {
    use std::io::Write;
    let Ok(dir) = paths::default_install_dir() else {
        return;
    };
    let logs = dir.join("logs");
    if std::fs::create_dir_all(&logs).is_err() {
        return;
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs.join("updater.log"))
    {
        let _ = writeln!(f, "{msg}");
    }
}
