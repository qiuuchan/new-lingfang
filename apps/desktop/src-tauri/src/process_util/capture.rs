use std::ffi::OsString;
use std::io::BufRead;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use super::binary::build_spawn_command;
use super::tree::{kill_child_tree, prepare_process_group};

#[derive(Debug, Clone)]
pub(crate) struct CapturedOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub cancelled: bool,
}

pub(crate) fn run_captured_inner(
    binary: &PathBuf,
    args: Vec<String>,
    workspace_dir: Option<&str>,
    timeout_ms: u64,
    env: Option<&[(OsString, OsString)]>,
) -> Result<CapturedOutput, String> {
    let mut command = build_spawn_command(binary, &args);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(workspace_dir) = workspace_dir {
        command.current_dir(workspace_dir);
    }
    if let Some(env) = env {
        command
            .env_clear()
            .envs(env.iter().map(|(key, value)| (key.clone(), value.clone())));
    }
    prepare_process_group(&mut command);
    wait_for_capture(
        command.spawn().map_err(|error| error.to_string())?,
        timeout_ms,
        None,
    )
}

pub(crate) fn run_capture_with_env(
    binary: &PathBuf,
    args: Vec<String>,
    workspace_dir: Option<&str>,
    timeout_ms: u64,
    env: Vec<(OsString, OsString)>,
) -> Result<CapturedOutput, String> {
    run_captured_inner(binary, args, workspace_dir, timeout_ms, Some(&env))
}

pub(crate) fn run_capture_with_env_and_cancel(
    binary: &PathBuf,
    args: Vec<String>,
    workspace_dir: Option<&str>,
    timeout_ms: u64,
    env: Vec<(OsString, OsString)>,
    cancel: &AtomicBool,
) -> Result<CapturedOutput, String> {
    let mut command = build_spawn_command(binary, &args);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(workspace_dir) = workspace_dir {
        command.current_dir(workspace_dir);
    }
    command
        .env_clear()
        .envs(env.iter().map(|(key, value)| (key.clone(), value.clone())));
    prepare_process_group(&mut command);
    wait_for_capture(
        command.spawn().map_err(|error| error.to_string())?,
        timeout_ms,
        Some(cancel),
    )
}

/// 流式运行子进程：stdout/stderr 逐行回调 + 主线程轮询等退出 + 超时 kill。
///
/// 与 `run_capture_with_env` 的区别：spawn 后开两个后台线程逐行读 stdout/stderr，每行调
/// `on_line(line, is_stderr)`（调用方据此 emit 给前端实时显示）；同时累积全文到 CapturedOutput
/// 供错误诊断用。主线程仍 try_wait 轮询 + 超时 kill_child_tree。
///
/// `on_line` 在 reader 线程被调用（非主线程），调用方需自行保证线程安全（如经 AppHandle emit）。
pub(crate) fn run_streamed_with_env<F>(
    binary: &PathBuf,
    args: Vec<String>,
    workspace_dir: Option<&str>,
    timeout_ms: u64,
    env: Vec<(OsString, OsString)>,
    on_line: F,
) -> Result<CapturedOutput, String>
where
    F: FnMut(&str, bool) + Send + 'static,
{
    let mut command = build_spawn_command(binary, &args);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(workspace_dir) = workspace_dir {
        command.current_dir(workspace_dir);
    }
    command
        .env_clear()
        .envs(env.iter().map(|(key, value)| (key.clone(), value.clone())));
    prepare_process_group(&mut command);

    let mut child = command.spawn().map_err(|error| error.to_string())?;

    // 逐行读 stdout/stderr 的回调经 Arc<Mutex> 共享给两个 reader 线程（on_line 可能非 Sync）。
    let on_line = Arc::new(Mutex::new(on_line));
    // 累积全文供 CapturedOutput 返回（错误诊断用）。
    let stdout_buf = Arc::new(Mutex::new(String::new()));
    let stderr_buf = Arc::new(Mutex::new(String::new()));

    // stdout reader 线程。
    if let Some(stdout) = child.stdout.take() {
        let on_line = Arc::clone(&on_line);
        let buf = Arc::clone(&stdout_buf);
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(text) => {
                        if let Ok(mut cb) = on_line.lock() {
                            cb(&text, false);
                        }
                        if let Ok(mut b) = buf.lock() {
                            b.push_str(&text);
                            b.push('\n');
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }
    // stderr reader 线程。
    if let Some(stderr) = child.stderr.take() {
        let on_line = Arc::clone(&on_line);
        let buf = Arc::clone(&stderr_buf);
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(text) => {
                        if let Ok(mut cb) = on_line.lock() {
                            cb(&text, true);
                        }
                        if let Ok(mut b) = buf.lock() {
                            b.push_str(&text);
                            b.push('\n');
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // 主线程轮询等退出 + 超时 kill。
    let started = Instant::now();
    let timed_out = loop {
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            break false;
        }
        if started.elapsed().as_millis() > timeout_ms as u128 {
            kill_child_tree(&child);
            break true;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };

    // 等 reader 线程读完 pipe（进程退出后 pipe EOF，reader 自然结束）。
    // 给 500ms 宽限，避免丢最后几行。
    std::thread::sleep(std::time::Duration::from_millis(100));

    let exit_code = child.wait().ok().and_then(|s| s.code());
    let stdout = stdout_buf.lock().map(|b| b.clone()).unwrap_or_default();
    let stderr = stderr_buf.lock().map(|b| b.clone()).unwrap_or_default();

    Ok(CapturedOutput {
        stdout,
        stderr,
        exit_code,
        timed_out,
        cancelled: false,
    })
}

fn wait_for_capture(
    mut child: std::process::Child,
    timeout_ms: u64,
    cancel: Option<&AtomicBool>,
) -> Result<CapturedOutput, String> {
    let started = Instant::now();
    loop {
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            return child_output(child, false, false);
        }
        if cancel.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            kill_child_tree(&child);
            return child_output(child, false, true);
        }
        if started.elapsed().as_millis() > timeout_ms as u128 {
            kill_child_tree(&child);
            return child_output(child, true, false);
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

fn child_output(
    child: std::process::Child,
    timed_out: bool,
    cancelled: bool,
) -> Result<CapturedOutput, String> {
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    Ok(CapturedOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
        timed_out,
        cancelled,
    })
}
