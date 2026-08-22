//! 命令行解析与模式分派（design §1）。
//!
//! 四种模式（同一二进制）：
//! - `install`（默认，无参 / 双击）：egui 交互安装。
//! - `--silent --target <dir>`：无 UI 解压覆盖到 <dir>（更新/无人值守调用）。
//! - `update --target <dir> --setup <path> --wait-pid <pid> [--restart]`：等进程退出→运行 setup→重启。
//! - `uninstall`：egui 确认后卸载。
//!
//! 手写参数解析（不引 clap，保持二进制小巧）。

/// 解析后的运行模式。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mode {
    /// 交互安装（egui）。target 可选（用户也可在 UI 改）。
    Install { target: Option<String> },
    /// 静默安装/覆盖到 target（无 UI）。
    Silent { target: Option<String> },
    /// 更新：等 wait_pid 退出 → 运行 setup（静默覆盖 target）→ 可选重启。
    Update {
        target: Option<String>,
        setup: String,
        wait_pid: Option<u32>,
        restart: bool,
    },
    /// 交互卸载（egui 确认）。
    Uninstall,
}

/// 从 argv（不含程序名）解析模式。解析失败返回 Err(说明)。
pub fn parse_args(args: &[String]) -> Result<Mode, String> {
    // 第一个非 -- 前缀的 token 视为子命令；缺省为 install。
    let sub = args
        .iter()
        .find(|a| !a.starts_with("--"))
        .map(|s| s.as_str());

    let target = flag_value(args, "--target");
    let setup = flag_value(args, "--setup");
    let wait_pid = flag_value(args, "--wait-pid")
        .map(|v| {
            v.parse::<u32>()
                .map_err(|_| format!("--wait-pid 非法：{v}"))
        })
        .transpose()?;
    let restart = has_flag(args, "--restart");
    let silent = has_flag(args, "--silent");

    match sub {
        Some("uninstall") => Ok(Mode::Uninstall),
        Some("update") => {
            let setup = setup.ok_or_else(|| "update 模式缺少 --setup <path>".to_string())?;
            Ok(Mode::Update {
                target,
                setup,
                wait_pid,
                restart,
            })
        }
        Some("install") | None => {
            if silent {
                Ok(Mode::Silent { target })
            } else {
                Ok(Mode::Install { target })
            }
        }
        Some(other) => Err(format!("未知子命令：{other}")),
    }
}

/// 取 `--key value` 形式的值（也支持 `--key=value`）。
fn flag_value(args: &[String], key: &str) -> Option<String> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == key {
            return it.next().cloned();
        }
        if let Some(rest) = a.strip_prefix(&format!("{key}=")) {
            return Some(rest.to_string());
        }
    }
    None
}

/// 是否存在某个布尔 flag。
fn has_flag(args: &[String], key: &str) -> bool {
    args.iter().any(|a| a == key)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn no_args_is_install() {
        assert_eq!(parse_args(&[]).unwrap(), Mode::Install { target: None });
    }

    #[test]
    fn silent_with_target() {
        let args = v(&["install", "--silent", "--target", "C:\\X"]);
        assert_eq!(
            parse_args(&args).unwrap(),
            Mode::Silent {
                target: Some("C:\\X".into())
            }
        );
    }

    #[test]
    fn silent_flag_without_subcommand() {
        let args = v(&["--silent", "--target=C:\\Y"]);
        assert_eq!(
            parse_args(&args).unwrap(),
            Mode::Silent {
                target: Some("C:\\Y".into())
            }
        );
    }

    #[test]
    fn update_full() {
        let args = v(&[
            "update",
            "--target",
            "C:\\X",
            "--setup",
            "C:\\tmp\\s.exe",
            "--wait-pid",
            "1234",
            "--restart",
        ]);
        assert_eq!(
            parse_args(&args).unwrap(),
            Mode::Update {
                target: Some("C:\\X".into()),
                setup: "C:\\tmp\\s.exe".into(),
                wait_pid: Some(1234),
                restart: true,
            }
        );
    }

    #[test]
    fn update_requires_setup() {
        let args = v(&["update", "--target", "C:\\X"]);
        assert!(parse_args(&args).is_err());
    }

    #[test]
    fn update_rejects_bad_pid() {
        let args = v(&["update", "--setup", "s.exe", "--wait-pid", "abc"]);
        assert!(parse_args(&args).is_err());
    }

    #[test]
    fn uninstall_mode() {
        assert_eq!(parse_args(&v(&["uninstall"])).unwrap(), Mode::Uninstall);
    }

    #[test]
    fn unknown_subcommand_errors() {
        assert!(parse_args(&v(&["frobnicate"])).is_err());
    }
}
