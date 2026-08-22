//! Windows 平台操作（design §4）：注册表 Uninstall key、快捷方式、进程等待/终止、自删除。
//!
//! 快捷方式用 PowerShell 的 WScript.Shell 创建（避免引入重型 `windows` crate 的 COM vtable 绑定，
//! 保持二进制小巧）。注册表/进程用 windows-sys 原始 API。

use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::Path;

use anyhow::{anyhow, Result};
use windows_sys::Win32::Foundation::{
    CloseHandle, HANDLE, HWND, RECT, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Graphics::Gdi::{CreateRoundRectRgn, SetWindowRgn};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
    HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WRITE, REG_DWORD,
    REG_OPTION_NON_VOLATILE, REG_SZ,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};
use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect;

use crate::paths;

/// 不弹出控制台窗口的进程创建标志（CREATE_NO_WINDOW）。
/// 用于 PowerShell 创建快捷方式、cmd 自删除，避免一闪而过的黑窗。
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 注册表 Uninstall 根路径（HKCU，currentUser 安装免提权）。
pub const UNINSTALL_ROOT: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";

/// OsStr → 以 NUL 结尾的 UTF-16（Win32 宽字符 API 入参）。
fn wide(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// 写注册表「添加删除程序」项（design §4）。
///
/// 在 `HKCU\...\Uninstall\<UNINSTALL_KEY_NAME>` 下写 DisplayName / DisplayVersion /
/// UninstallString 等值，使控制面板可见并能调起卸载。
pub fn write_uninstall_key(
    install_dir: &Path,
    version: &str,
    estimated_size_kb: u32,
) -> Result<()> {
    let subkey = format!("{}\\{}", UNINSTALL_ROOT, paths::UNINSTALL_KEY_NAME);
    let main_exe = install_dir.join(paths::MAIN_EXE);
    let updater_exe = install_dir.join(paths::UPDATER_EXE);
    let install_loc = install_dir.to_string_lossy().to_string();
    let uninstall_cmd = format!("\"{}\" uninstall", updater_exe.to_string_lossy());

    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        let subkey_w = wide(&subkey);
        let rc = RegCreateKeyExW(
            HKEY_CURRENT_USER,
            subkey_w.as_ptr(),
            0,
            std::ptr::null_mut(),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            std::ptr::null(),
            &mut hkey,
            std::ptr::null_mut(),
        );
        if rc != 0 {
            return Err(anyhow!("RegCreateKeyExW 失败，code={rc}"));
        }

        let res = (|| -> Result<()> {
            set_sz(hkey, "DisplayName", paths::DISPLAY_NAME)?;
            set_sz(hkey, "DisplayVersion", version)?;
            set_sz(hkey, "Publisher", paths::DISPLAY_NAME)?;
            set_sz(hkey, "DisplayIcon", &main_exe.to_string_lossy())?;
            set_sz(hkey, "InstallLocation", &install_loc)?;
            set_sz(hkey, "UninstallString", &uninstall_cmd)?;
            set_dword(hkey, "EstimatedSize", estimated_size_kb)?;
            set_dword(hkey, "NoModify", 1)?;
            set_dword(hkey, "NoRepair", 1)?;
            Ok(())
        })();

        RegCloseKey(hkey);
        res
    }
}

/// 删除注册表 Uninstall 项（卸载时）。
pub fn delete_uninstall_key() -> Result<()> {
    let subkey = format!("{}\\{}", UNINSTALL_ROOT, paths::UNINSTALL_KEY_NAME);
    unsafe {
        let subkey_w = wide(&subkey);
        let rc = RegDeleteTreeW(HKEY_CURRENT_USER, subkey_w.as_ptr());
        // 2 = ERROR_FILE_NOT_FOUND（键已不存在），视为成功。
        if rc != 0 && rc != 2 {
            return Err(anyhow!("RegDeleteTreeW 失败，code={rc}"));
        }
    }
    Ok(())
}

unsafe fn set_sz(hkey: HKEY, name: &str, value: &str) -> Result<()> {
    let name_w = wide(name);
    let val_w = wide(value);
    let bytes = (val_w.len() * 2) as u32; // 含结尾 NUL
    let rc = RegSetValueExW(
        hkey,
        name_w.as_ptr(),
        0,
        REG_SZ,
        val_w.as_ptr() as *const u8,
        bytes,
    );
    if rc != 0 {
        return Err(anyhow!("RegSetValueExW({name}) 失败，code={rc}"));
    }
    Ok(())
}

unsafe fn set_dword(hkey: HKEY, name: &str, value: u32) -> Result<()> {
    let name_w = wide(name);
    let rc = RegSetValueExW(
        hkey,
        name_w.as_ptr(),
        0,
        REG_DWORD,
        &value as *const u32 as *const u8,
        4,
    );
    if rc != 0 {
        return Err(anyhow!("RegSetValueExW({name}) 失败，code={rc}"));
    }
    Ok(())
}

/// 创建快捷方式（.lnk）——用 PowerShell WScript.Shell（避免 COM vtable 绑定）。
///
/// `lnk_path` 为目标 .lnk 路径，`target` 为指向的 exe，`icon` 为图标路径（通常即 target）。
pub fn create_shortcut(
    lnk_path: &Path,
    target: &Path,
    working_dir: &Path,
    icon: &Path,
) -> Result<()> {
    // PowerShell 脚本：用单引号包裹路径，内部单引号转义为两个单引号。
    let esc = |p: &Path| p.to_string_lossy().replace('\'', "''");
    let script = format!(
        "$ws = New-Object -ComObject WScript.Shell; \
         $s = $ws.CreateShortcut('{lnk}'); \
         $s.TargetPath = '{target}'; \
         $s.WorkingDirectory = '{wd}'; \
         $s.IconLocation = '{icon}'; \
         $s.Save()",
        lnk = esc(lnk_path),
        target = esc(target),
        wd = esc(working_dir),
        icon = esc(icon),
    );
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW) // 不弹 PowerShell 黑窗
        .status()
        .map_err(|e| anyhow!("调用 PowerShell 创建快捷方式失败：{e}"))?;
    if !status.success() {
        return Err(anyhow!("PowerShell 创建快捷方式返回非零：{status}"));
    }
    Ok(())
}

/// 等待指定 PID 进程退出（毫秒超时）。返回 true 表示已退出，false 表示超时。
///
/// 进程不存在（已退出）时 OpenProcess 返回空句柄 → 视为已退出返回 true。
pub fn wait_for_pid(pid: u32, timeout_ms: u32) -> bool {
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return true; // 进程已不存在
        }
        let rc = WaitForSingleObject(handle, timeout_ms);
        CloseHandle(handle);
        rc == WAIT_OBJECT_0
    }
}

/// 取某 PID 的完整 exe 路径（用 QueryFullProcessImageNameW，Win32 风格，带盘符）。
/// 失败（无权限/进程已退出）返回 None。
unsafe fn query_process_image_path(pid: u32) -> Option<String> {
    let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if h.is_null() {
        return None;
    }
    let mut buf = [0u16; 1024];
    let mut len = (buf.len() - 1) as u32; // 留位置给结尾 NUL
    let rc = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len);
    CloseHandle(h);
    if rc == 0 {
        return None;
    }
    // len 不含 NUL，直接按长度截断。
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

/// 判断路径 `child` 是否位于目录 `parent` 之下（任意深度，大小写不敏感）。
/// 二者先 canonicalize（解析符号链接/相对段/盘符大小写），失败时退回原字符串比较。
fn path_is_under(child: &Path, parent: &Path) -> bool {
    let canon = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let child = canon(child);
    let parent = canon(parent);
    // child 必须以 parent 为前缀（组件级别），且更长（不是 parent 自己）。
    child.starts_with(&parent) && child.as_os_str().len() > parent.as_os_str().len()
}

/// 终止所有「exe 路径位于 install_dir 之下」的进程，并等待它们真正退出以释放文件锁。
///
/// 覆盖主程序 + runtimes/* 下被拉起的子进程（python / node / ffmpeg …），避免只杀主程序
/// 导致 runtimes/python/python.exe 仍被占用、自解压覆盖失败（os error 32）。
///
/// 仅按路径前缀匹配，不会误杀系统同名进程（如系统 python.exe）。返回终止的进程数。
pub fn kill_app_processes(install_dir: &Path) -> u32 {
    let mut handles: Vec<HANDLE> = Vec::new();
    let mut killed = 0u32;
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot.is_null() {
            return 0;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                let pid = entry.th32ProcessID;
                // 取该进程完整 exe 路径，判断是否落在 install_dir 之下。
                let under = query_process_image_path(pid)
                    .map(|p| path_is_under(Path::new(&p), install_dir))
                    .unwrap_or(false);
                if under {
                    let h = OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, pid);
                    if !h.is_null() {
                        if TerminateProcess(h, 0) != 0 {
                            killed += 1;
                            handles.push(h);
                        } else {
                            // TerminateProcess 失败也关句柄，避免泄漏。
                            CloseHandle(h);
                        }
                    }
                }
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);

        // 等所有被终止的进程真正退出（最多 5s），确保 OS 释放 exe/dll 文件锁。
        // WaitForSingleObject 在进程退出时变 signaled。超时不阻塞流程（best-effort）。
        for h in &handles {
            if WaitForSingleObject(*h, 5_000) == WAIT_TIMEOUT {
                // 仍在跑：不再等，留给 OS 后续回收。
            }
            CloseHandle(*h);
        }
    }
    killed
}

/// 检测是否有「exe 路径位于 install_dir 之下」的进程在运行（不终止）。
/// 用于安装前判断是否需要弹「程序运行中」确认框——主程序或其子进程都算。
pub fn is_app_running(install_dir: &Path) -> bool {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot.is_null() {
            return false;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = false;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                let pid = entry.th32ProcessID;
                if query_process_image_path(pid)
                    .map(|p| path_is_under(Path::new(&p), install_dir))
                    .unwrap_or(false)
                {
                    found = true;
                    break;
                }
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
        found
    }
}

/// 计划自删除：用 cmd 延迟删除本 exe（自己运行时不能删自己，延迟到进程退出后）。
///
/// `ping` 制造约 2 秒延迟，等本进程退出再 del。失败静默（自删除是 best-effort）。
pub fn schedule_self_delete(exe_path: &Path) {
    let path = exe_path.to_string_lossy().to_string();
    let cmd = format!("ping 127.0.0.1 -n 3 > nul & del /f /q \"{path}\"");
    let _ = std::process::Command::new("cmd")
        .args(["/c", &cmd])
        .creation_flags(CREATE_NO_WINDOW) // 不弹 cmd 黑窗
        .spawn();
}

/// 固定长度 UTF-16 缓冲（NUL 结尾）转 String。
fn wide_buf_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// 读注册表 `CurrentBuild` 判断是否 Windows 11（build ≥ 22000）。
///
/// Win11 与 Win10 的 dwMajorVersion 都是 10，唯一可靠区分是 build 号。
/// 从 `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\CurrentBuild`(REG_SZ) 读取。
/// 读不到时保守返回 false（按 Win10 处理 → 不圆角）。
fn is_windows_11() -> bool {
    unsafe {
        let subkey = wide("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion");
        let mut hkey: HKEY = std::ptr::null_mut();
        if RegOpenKeyExW(HKEY_LOCAL_MACHINE, subkey.as_ptr(), 0, KEY_READ, &mut hkey) != 0 {
            return false;
        }
        let name = wide("CurrentBuild");
        let mut buf = [0u16; 32];
        let mut len = (buf.len() * 2) as u32;
        let rc = RegQueryValueExW(
            hkey,
            name.as_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            buf.as_mut_ptr() as *mut u8,
            &mut len,
        );
        RegCloseKey(hkey);
        if rc != 0 {
            return false;
        }
        let s = wide_buf_to_string(&buf);
        s.trim().parse::<u32>().map(|b| b >= 22000).unwrap_or(false)
    }
}

/// 给指定窗口应用圆角形状（仅 Windows 11）。
///
/// winit 的无边框窗口（decorations=false）通过 WM_NCCALCSIZE 吃掉了非客户区，
/// 导致 DWM 的 DWMWA_WINDOW_CORNER_PREFERENCE 无处作用（实测设置成功但窗口仍直角）。
/// 这里改用 GDI 区域裁剪：CreateRoundRectRgn 造一个圆角矩形区域，SetWindowRgn 把窗口
/// 裁成该形状——不依赖 DWM 边框，可靠生效。
///
/// Win10 不调用（区域裁剪在 Win10 上也会生效，但需求是「Win10 保持直角」），故先判版本。
///
/// `hwnd` 由 eframe 的 `Frame::window_handle()` 提供（真实主窗口句柄）。
pub fn set_window_rounding(hwnd: isize) {
    if hwnd == 0 || !is_windows_11() {
        return; // Win10 / 无效句柄：保持直角
    }
    unsafe {
        let h = hwnd as HWND;
        let mut rect: RECT = std::mem::zeroed();
        if GetWindowRect(h, &mut rect) == 0 {
            return;
        }
        let w = rect.right - rect.left;
        let h_px = rect.bottom - rect.top;
        if w <= 0 || h_px <= 0 {
            return;
        }
        // Win11 标准窗口圆角半径约 8px → 直径 16；SetWindowRgn 用窗口本地坐标（0,0 起）。
        const RADIUS: i32 = 16;
        let rgn = CreateRoundRectRgn(0, 0, w + 1, h_px + 1, RADIUS, RADIUS);
        if !rgn.is_null() {
            // 第三参 true：立即重绘。系统接管该区域所有权，无需手动 DeleteObject。
            SetWindowRgn(h, rgn, 1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uninstall_root_path_format() {
        assert!(UNINSTALL_ROOT.contains("CurrentVersion\\Uninstall"));
    }

    #[test]
    fn wide_has_nul_terminator() {
        let w = wide("ab");
        assert_eq!(w, vec![0x61, 0x62, 0x00]);
    }

    #[test]
    fn wide_buf_reads_until_nul() {
        let buf = [0x41u16, 0x42, 0x00, 0x43, 0x44];
        assert_eq!(wide_buf_to_string(&buf), "AB");
    }

    #[test]
    fn wide_buf_no_nul_reads_all() {
        let buf = [0x41u16, 0x42];
        assert_eq!(wide_buf_to_string(&buf), "AB");
    }
}
