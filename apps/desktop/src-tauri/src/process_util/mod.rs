// process_util —— 通用子进程工具（从已移除的 code_assistant 模块抽出的共享基础设施）。
//
// 这些工具与 AI 无关：跨平台二进制查找、带超时的子进程捕获、进程树 kill、ISO 时间戳、
// workspace 目录解析。被 plugin_runner（运行 Python/Node 插件）与 plugin_script（脚本预览）复用。
//
// code_assistant 的 AI CLI 逻辑（ClaudeCode/Codex 子进程生成插件）已整体删除，
// AI 能力统一走平台 relay（见 docs/billing-and-relay-design.md）。本模块仅保留通用子进程工具。
mod binary;
mod capture;
mod sandbox;
mod tree;

use std::path::{Path, PathBuf};

#[cfg(test)]
pub(crate) use binary::command_preview;
#[cfg(test)]
pub(crate) use binary::find_binary;
#[cfg(test)]
pub(crate) use binary::find_binaries_in_path;
#[cfg(all(windows, test))]
pub(crate) use binary::resolve_npm_shim;
pub(crate) use capture::{
    run_capture_with_env, run_capture_with_env_and_cancel, run_streamed_with_env, CapturedOutput,
};
pub(crate) use sandbox::SandboxHandle;
pub(crate) use tree::kill_child_tree;

/// 解析 workspace 目录：优先用传入值，缺失则用 default_root/claude-sandbox，再缺失用 cwd。
/// 不存在则创建。返回 canonicalize 后的绝对路径字符串。
pub(crate) fn resolve_workspace(
    workspace_dir: Option<String>,
    default_root: Option<&Path>,
    _plugin_id: Option<&str>,
) -> Result<String, String> {
    let path = workspace_dir
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| default_root.map(|root| root.join("claude-sandbox")))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    if !path.exists() {
        std::fs::create_dir_all(&path)
            .map_err(|error| format!("创建 sandbox 目录失败：{error}"))?;
    }
    if !path.is_dir() {
        return Err(format!("workspace 不是目录：{}", path.to_string_lossy()));
    }
    path.canonicalize()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|error| format!("workspace 路径解析失败：{error}"))
}

/// 当前 UTC 时间的 ISO 8601 字符串（`YYYY-MM-DDTHH:MM:SS.mmmZ`，字典序 == 时间序）。
pub(crate) fn now_string() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    epoch_to_iso8601(now.as_secs(), now.subsec_millis())
}

/// epoch 秒 + 毫秒 → RFC 3339 / ISO 8601 UTC 字符串（Howard Hinnant civil_from_days 算法）。
pub(crate) fn epoch_to_iso8601(secs: u64, millis: u32) -> String {
    let secs_of_day = secs % 86400;
    let hour = secs_of_day / 3600;
    let min = (secs_of_day % 3600) / 60;
    let sec = secs_of_day % 60;

    let days = (secs / 86400) as i64;
    let z = days + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, m, d, hour, min, sec, millis
    )
}

/// 进程树 kill 测试串行锁（避免并发测试 race）。
#[cfg(test)]
static PROCESS_TREE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
pub(crate) fn process_tree_test_lock() -> std::sync::MutexGuard<'static, ()> {
    PROCESS_TREE_TEST_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}
