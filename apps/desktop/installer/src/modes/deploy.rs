//! 部署逻辑（install/silent/update 共用）：自解压 payload → 确保 updater.exe 副本。

use std::path::Path;

use anyhow::{Context, Result};

use crate::{paths, sfx};

/// 把本 exe 尾部 payload 解压到安装目录，并确保安装目录有 updater.exe（= 本 installer 副本）。
///
/// 返回解压的文件数。
pub fn deploy_to(install_dir: &Path) -> Result<usize> {
    let self_exe = std::env::current_exe().context("无法定位自身可执行文件")?;

    // 0) 防御性终止：覆盖前关闭「exe 路径落在 install_dir 之下」的所有进程
    //    （主程序 + runtimes/python.exe / node.exe / ffmpeg.exe 等子进程）。
    //    只杀主程序会留下占着 python.exe 的孤儿进程，导致自解压覆盖时 os error 32。
    //    交互安装此前已杀过一遍，此处为幂等兜底（无运行进程则空操作）。
    #[cfg(target_os = "windows")]
    {
        let killed = crate::platform::kill_app_processes(install_dir);
        if killed > 0 {
            crate::log_line(&format!("部署前终止 {killed} 个占用安装目录的进程"));
        }
    }

    // 1) 自解压 app 文件到安装目录。
    let count = sfx::extract_payload(&self_exe, install_dir).context("自解压 app 文件失败")?;

    // 2) 确保安装目录有 updater.exe。payload 内通常已含 updater.exe（= installer 副本）；
    //    若 payload 未含（防御），则复制本 exe 过去。但本 exe 含 payload 尾部，复制后体积偏大——
    //    优先信任 payload 内的纯净 updater.exe，仅在缺失时兜底复制自身。
    let updater = install_dir.join(paths::UPDATER_EXE);
    if !updater.exists() {
        std::fs::copy(&self_exe, &updater)
            .with_context(|| format!("复制 updater.exe 到 {updater:?} 失败"))?;
    }

    Ok(count)
}

/// 估算安装目录大小（KB，注册表 EstimatedSize 用）。失败返回 0。
pub fn dir_size_kb(dir: &Path) -> u32 {
    fn walk(dir: &Path) -> u64 {
        let mut total = 0u64;
        let Ok(entries) = std::fs::read_dir(dir) else {
            return 0;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                total += walk(&path);
            } else if let Ok(meta) = entry.metadata() {
                total += meta.len();
            }
        }
        total
    }
    (walk(dir) / 1024).min(u32::MAX as u64) as u32
}
