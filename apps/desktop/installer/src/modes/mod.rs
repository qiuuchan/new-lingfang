//! 模式执行分发（design §1/§5）。
//!
//! install/uninstall 走 egui 交互；silent/update 无 UI。

mod deploy;

#[cfg(windows)]
mod install;
#[cfg(windows)]
mod uninstall;

use anyhow::Result;

use crate::cli::Mode;

/// 执行解析出的模式。
pub fn run(mode: Mode) -> Result<()> {
    match mode {
        Mode::Silent { target } => run_silent(target.as_deref()),
        Mode::Update {
            target,
            setup,
            wait_pid,
            restart,
        } => run_update(target.as_deref(), &setup, wait_pid, restart),
        #[cfg(windows)]
        Mode::Install { target } => install::run_interactive(target.as_deref()),
        #[cfg(windows)]
        Mode::Uninstall => uninstall::run_interactive(),
        #[cfg(not(windows))]
        Mode::Install { .. } | Mode::Uninstall => {
            anyhow::bail!("交互安装/卸载本期仅支持 Windows")
        }
    }
}

/// 静默安装/覆盖到 target（无 UI，更新或无人值守调用）。
fn run_silent(target: Option<&str>) -> Result<()> {
    let dir = crate::paths::resolve_install_dir(target)?;
    // 进程终止由 deploy_to 内部统一处理（覆盖主程序 + runtimes 子进程），
    // 避免只杀主程序导致 runtimes/python.exe 仍被占用、覆盖失败（os error 32）。
    deploy::deploy_to(&dir)?;
    crate::log_line(&format!("静默安装完成：{dir:?}"));
    Ok(())
}

/// 更新模式：等主进程退出 → 静默覆盖 → 可选重启（design §5）。
fn run_update(
    target: Option<&str>,
    setup: &str,
    wait_pid: Option<u32>,
    restart: bool,
) -> Result<()> {
    let dir = crate::paths::resolve_install_dir(target)?;

    // 1) 等主进程退出（最多 30s，超时仍继续——主进程可能已被用户强杀）。
    #[cfg(windows)]
    if let Some(pid) = wait_pid {
        let exited = crate::platform::wait_for_pid(pid, 30_000);
        crate::log_line(&format!("等待主进程 pid={pid} 退出：{exited}"));
    }
    #[cfg(not(windows))]
    let _ = wait_pid;

    // 2) 运行新版 setup 静默覆盖（setup 自带 payload，--silent 解压到 target）。
    let status = std::process::Command::new(setup)
        .args(["--silent", "--target", &dir.to_string_lossy()])
        .status()
        .map_err(|e| anyhow::anyhow!("运行新版安装包失败：{e}"))?;
    if !status.success() {
        anyhow::bail!("新版安装包返回非零退出码：{status}");
    }
    crate::log_line(&format!("更新覆盖完成：{dir:?}"));

    // 3) 删除临时 setup 文件（best-effort）。
    let _ = std::fs::remove_file(setup);

    // 4) 可选重启主程序。
    if restart {
        let main = dir.join(crate::paths::MAIN_EXE);
        let _ = std::process::Command::new(&main).spawn();
        crate::log_line(&format!("已重启主程序：{main:?}"));
    }

    // 5) 计划自删除（本进程是从临时目录运行的 updater 副本）。
    #[cfg(windows)]
    if let Ok(self_exe) = std::env::current_exe() {
        crate::platform::schedule_self_delete(&self_exe);
    }

    Ok(())
}
