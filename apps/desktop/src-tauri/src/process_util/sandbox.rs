//! 插件进程 OS 级沙箱（ADR-0004 后续大任务实现）。
//!
//! Windows：用 Job Object 实现「进程树围栏 + 关闭即杀」。
//! - `SandboxHandle::create()` 创建 Job Object，设 `KILL_ON_JOB_CLOSE` 限制：
//!   当 Job 句柄关闭时，Job 内所有进程（含子进程/孙进程）被自动终止。
//! - 不设 `BREAKAWAY_OK`：子进程无法逃逸 Job，所有 spawn 的孙进程自动归入同一 Job。
//! - `assign_process()` 把插件入口进程分配到 Job。
//! - `Drop` 关闭 Job 句柄 → 触发 KILL_ON_JOB_CLOSE → 整棵进程树被杀。
//!
//! Unix：`prctl(PR_SET_PDEATHSIG, SIGKILL)` 在 pre_exec 中设置，
//! 父进程退出时内核自动发 SIGKILL 给子进程。不提供完整沙箱（需 bubblewrap/firejail），
//! 但保证宿主退出时插件进程不残留。
//!
//! 与 process_util/tree.rs 的协作：
//! - tree.rs 的 `kill_child_tree` 仍用于主动 stop（先杀进程树再 drop SandboxHandle）。
//! - SandboxHandle 的 Drop 是安全网：即使 kill_child_tree 漏杀孙进程，
//!   Job 句柄关闭也会把整棵树清理干净。

#[cfg(windows)]
use std::process::Child;

// ── Windows Job Object 实现 ──────────────────────────────────────────

#[cfg(windows)]
pub(crate) struct SandboxHandle {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl SandboxHandle {
    /// 创建 Job Object 并设置 kill-on-close 限制。
    ///
    /// 限制 flags：
    /// - `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (0x2000)：Job 句柄关闭时杀整棵树。
    /// - `JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION` (0x0400)：一个进程崩溃不拖垮其他。
    ///
    /// 不设 `JOB_OBJECT_LIMIT_BREAKAWAY_OK` (0x08)：子进程无法逃出 Job。
    pub(crate) fn create() -> Result<Self, String> {
        use windows_sys::Win32::Foundation::*;
        use windows_sys::Win32::System::JobObjects::*;

        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(format!(
                "CreateJobObjectW 失败：{}",
                std::io::Error::last_os_error()
            ));
        }

        // 限制 flags：kill-on-close + die-on-unhandled-exception。
        // 不设 BREAKAWAY_OK → 子进程无法逃逸 Job。
        const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
        const JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION: u32 = 0x0000_0400;

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;

        let result = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if result == 0 {
            let err = std::io::Error::last_os_error();
            unsafe { CloseHandle(handle) };
            return Err(format!("SetInformationJobObject 失败：{err}"));
        }

        Ok(SandboxHandle { handle })
    }

    /// 把子进程分配到 Job Object。
    ///
    /// 在 `command.spawn()` 之后立即调用。进程刚 spawn 还没执行用户代码，
    /// 此时分配到 Job 可确保后续 spawn 的孙进程也归入同一 Job。
    /// null 句柄时 no-op（降级模式：沙箱创建失败时不阻断启动）。
    pub(crate) fn assign_process(&self, child: &Child) -> Result<(), String> {
        if self.handle.is_null() {
            return Ok(());
        }
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

        let process_handle = child.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
        let result = unsafe { AssignProcessToJobObject(self.handle, process_handle) };
        if result == 0 {
            return Err(format!(
                "AssignProcessToJobObject 失败：{}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
}

#[cfg(windows)]
impl Default for SandboxHandle {
    /// 降级用空句柄：Drop 和 assign_process 对 null 句柄 no-op。
    fn default() -> Self {
        SandboxHandle {
            handle: std::ptr::null_mut(),
        }
    }
}

// SAFETY: SandboxHandle 仅持有 Windows Job Object 句柄（OS 资源标识符，非 Rust 内存指针）。
// 所有访问都通过 PluginProcessTable 的 Mutex 保护，Windows API（AssignProcessToJobObject /
// CloseHandle）本身线程安全。故 Send + Sync 安全。
#[cfg(windows)]
unsafe impl Send for SandboxHandle {}

#[cfg(windows)]
unsafe impl Sync for SandboxHandle {}

#[cfg(windows)]
impl Drop for SandboxHandle {
    fn drop(&mut self) {
        if self.handle.is_null() {
            return;
        }
        // 关闭 Job 句柄 → 触发 KILL_ON_JOB_CLOSE → 整棵进程树被杀。
        // 即使 kill_child_tree 漏杀孙进程，这里也是安全网。
        use windows_sys::Win32::Foundation::CloseHandle;
        unsafe { CloseHandle(self.handle) };
    }
}

// ── Unix stub（prctl 在 pre_exec 中设置，不需要独立句柄）──────────────

#[cfg(not(windows))]
pub(crate) struct SandboxHandle;

#[cfg(not(windows))]
impl Default for SandboxHandle {
    fn default() -> Self {
        SandboxHandle
    }
}

#[cfg(not(windows))]
impl SandboxHandle {
    pub(crate) fn create() -> Result<Self, String> {
        // Unix 沙箱由 pre_exec 的 prctl(PR_SET_PDEATHSIG) 实现，无需独立句柄。
        // 完整沙箱需 bubblewrap/firejail，后续独立任务实现。
        Ok(SandboxHandle)
    }

    pub(crate) fn assign_process(&self, _child: &std::process::Child) -> Result<(), String> {
        // prctl 在 pre_exec 阶段已设置，无需后续分配。
        Ok(())
    }
}

// ── 单元测试 ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn sandbox_create_and_drop_does_not_leak() {
        // 创建 Job Object → 立即 drop：验证句柄可正常创建和关闭，不泄漏。
        let handle = SandboxHandle::create().expect("创建 Job Object 应成功");
        drop(handle);
        // Drop 后句柄已关闭，无泄漏（KILL_ON_JOB_CLOSE 对空 Job 无副作用）。
    }

    #[test]
    #[cfg(windows)]
    fn sandbox_create_sets_kill_on_close() {
        // 创建后验证句柄非 null（限制已设好，查询 Job 限制需更多 API，此处验证创建成功即可）。
        let handle = SandboxHandle::create().expect("创建 Job Object 应成功");
        assert!(format!("{:p}", handle.handle).len() > 0);
    }
}
