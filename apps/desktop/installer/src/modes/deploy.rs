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

    // 1.5) 落地硬门槛：主程序必须真实存在。QX-18 真机缺陷——畸形 payload（如
    //      GNU tar 静默产出的 ustar 被 zip 层误解析为 0 条目）会走完全部流程、
    //      仅留兜底复制的 updater.exe 且退出码 0。在源头上拒绝这种「假成功」。
    ensure_main_exe(install_dir)?;

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

/// 校验解压产物包含主程序（`paths::MAIN_EXE`）。缺失即返回显式错误。
fn ensure_main_exe(install_dir: &Path) -> Result<()> {
    let main = install_dir.join(paths::MAIN_EXE);
    if main.is_file() {
        return Ok(());
    }
    anyhow::bail!(
        "自解压产物缺少主程序 {}（解压条目异常：疑似 payload 归档损坏或格式不是 zip）；\
         已停止部署，请重新打开发版安装包",
        paths::MAIN_EXE
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_main_exe_rejects_empty_dir() {
        let dir = std::env::temp_dir().join("qianxia-deploy-empty-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let err = ensure_main_exe(&dir).unwrap_err();
        assert!(err.to_string().contains(paths::MAIN_EXE));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_main_exe_accepts_present_main() {
        let dir = std::env::temp_dir().join("qianxia-deploy-present-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(paths::MAIN_EXE), b"fake").unwrap();
        ensure_main_exe(&dir).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_main_exe_rejects_directory_named_main() {
        // 名字撞上但不是文件（目录）也必须拒绝。
        let dir = std::env::temp_dir().join("qianxia-deploy-dirnamed-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(paths::MAIN_EXE)).unwrap();
        assert!(ensure_main_exe(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
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
