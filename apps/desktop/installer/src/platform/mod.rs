//! 平台特定操作分发（design §10 跨平台预留）。
//!
//! 本期仅实现 Windows。注册表 / 快捷方式 / 进程等待等放 windows.rs。
//! 后续加 macos.rs / linux.rs 时在此 re-export 同名函数。

#[cfg(windows)]
pub mod windows;

#[cfg(windows)]
pub use windows::*;
