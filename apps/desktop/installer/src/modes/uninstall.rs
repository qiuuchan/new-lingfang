//! 交互卸载模式（egui 深色无边框）。
//!
//! 界面：居中 logo/标题 + 卸载原因（单选）+ 意见反馈（可选）+「残忍卸载」按钮。
//! 原因/反馈写入卸载日志（本地，不上报）。流程：确认 → 关主进程 → 删快捷方式 →
//! 删注册表 → 删安装目录 → 自删除。

use anyhow::Result;

use std::time::{Duration, Instant};

use crate::paths;
use crate::platform;
use crate::theme;

const WIN_SIZE: [f32; 2] = [480.0, 600.0];

#[derive(PartialEq, Clone, Copy)]
enum Reason {
    NotNeeded,
    InstallFailed,
    Other,
}

impl Reason {
    fn label(self) -> &'static str {
        match self {
            Reason::NotNeeded => "不需要了",
            Reason::InstallFailed => "安装失败",
            Reason::Other => "其他",
        }
    }
}

enum Phase {
    Confirm,
    Done,
    Failed(String),
}

struct UninstallApp {
    phase: Phase,
    reason: Reason,
    feedback: String,
    logo: Option<egui::TextureHandle>,
    /// 启动时刻：winit 显示窗口后会重置窗口区域，需启动后短时间内反复重设圆角。
    started: Instant,
}

/// 启动交互卸载窗口。
pub fn run_interactive() -> Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size(WIN_SIZE)
            .with_min_inner_size(WIN_SIZE)
            .with_resizable(false)
            .with_decorations(false)
            .with_maximize_button(false)
            .with_icon(theme::window_icon().unwrap_or_default()),
        ..Default::default()
    };
    eframe::run_native(
        &format!("卸载 {}", paths::DISPLAY_NAME),
        options,
        Box::new(|cc| {
            theme::install_fonts(&cc.egui_ctx);
            theme::apply_style(&cc.egui_ctx);
            Ok(Box::new(UninstallApp {
                phase: Phase::Confirm,
                reason: Reason::NotNeeded,
                feedback: String::new(),
                logo: theme::load_logo(&cc.egui_ctx),
                started: Instant::now(),
            }))
        }),
    )
    .map_err(|e| anyhow::anyhow!("启动卸载界面失败：{e}"))?;
    Ok(())
}

impl eframe::App for UninstallApp {
    fn clear_color(&self, _visuals: &egui::Visuals) -> [f32; 4] {
        [0.0, 0.0, 0.0, 0.0]
    }

    fn update(&mut self, ctx: &egui::Context, frame: &mut eframe::Frame) {
        // Win11 圆角：winit 显示窗口后会重置窗口区域，故启动后 1.2s 内每帧重设。
        if self.started.elapsed() < Duration::from_millis(1200) {
            use raw_window_handle::HasWindowHandle;
            if let Ok(rwh) = frame.window_handle() {
                if let raw_window_handle::RawWindowHandle::Win32(w) = rwh.as_ref() {
                    platform::set_window_rounding(w.hwnd.get() as isize);
                }
            }
            ctx.request_repaint_after(Duration::from_millis(50));
        }

        egui::CentralPanel::default()
            .frame(egui::Frame::none().fill(theme::BG))
            .show(ctx, |ui| {
                if theme::title_bar(ui, "卸载程序", false) {
                    ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                }
                match &self.phase {
                    Phase::Confirm => self.view_confirm(ui, ctx),
                    Phase::Done => self.view_done(ui, ctx),
                    Phase::Failed(e) => {
                        let e = e.clone();
                        self.view_failed(ui, ctx, &e);
                    }
                }
            });
    }
}

impl UninstallApp {
    fn view_confirm(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.add_space(28.0);
        theme::logo(ui, &self.logo, 96.0);
        ui.add_space(10.0);
        ui.vertical_centered(|ui| {
            ui.label(
                egui::RichText::new(paths::DISPLAY_NAME)
                    .size(22.0)
                    .color(theme::TEXT),
            );
        });

        ui.add_space(28.0);
        // 卸载原因（单选）。
        ui.horizontal(|ui| {
            ui.add_space(24.0);
            ui.label(
                egui::RichText::new("卸载原因：")
                    .size(14.0)
                    .color(theme::TEXT_MUTED),
            );
        });
        ui.add_space(4.0);
        ui.horizontal(|ui| {
            ui.add_space(24.0);
            for r in [Reason::NotNeeded, Reason::InstallFailed, Reason::Other] {
                ui.radio_value(&mut self.reason, r, r.label());
                ui.add_space(16.0);
            }
        });

        ui.add_space(18.0);
        ui.horizontal(|ui| {
            ui.add_space(24.0);
            ui.label(
                egui::RichText::new("意见反馈（可选）：")
                    .size(14.0)
                    .color(theme::TEXT_MUTED),
            );
        });
        ui.add_space(4.0);
        ui.horizontal(|ui| {
            ui.add_space(24.0);
            ui.add(
                egui::TextEdit::multiline(&mut self.feedback)
                    .desired_width(ui.available_width() - 24.0)
                    .desired_rows(4)
                    .hint_text("说说你的想法…"),
            );
        });

        ui.add_space(28.0);
        ui.vertical_centered(|ui| {
            if theme::primary_button(ui, "残忍卸载", 300.0, true) {
                self.log_feedback();
                self.phase = match do_uninstall() {
                    Ok(()) => Phase::Done,
                    Err(e) => Phase::Failed(format!("{e:#}")),
                };
            }
            ui.add_space(8.0);
            if theme::link(ui, "取消") {
                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            }
        });
    }

    fn view_done(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.add_space(60.0);
        theme::logo(ui, &self.logo, 100.0);
        ui.add_space(20.0);
        theme::status_title(ui, true, "已卸载完成", 22.0);
        ui.vertical_centered(|ui| {
            ui.add_space(8.0);
            ui.label(
                egui::RichText::new("感谢使用，期待再次相见。")
                    .size(13.0)
                    .color(theme::TEXT_MUTED),
            );
        });
        ui.add_space(40.0);
        ui.vertical_centered(|ui| {
            if theme::primary_button(ui, "完成", 240.0, true) {
                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            }
        });
    }

    fn view_failed(&mut self, ui: &mut egui::Ui, ctx: &egui::Context, err: &str) {
        ui.add_space(56.0);
        theme::logo(ui, &self.logo, 96.0);
        ui.add_space(18.0);
        theme::status_title(ui, false, "卸载出错", 20.0);
        ui.add_space(14.0);
        ui.horizontal(|ui| {
            ui.add_space(32.0);
            ui.allocate_ui_with_layout(
                egui::vec2(ui.available_width() - 32.0, 0.0),
                egui::Layout::top_down(egui::Align::Center),
                |ui| {
                    ui.label(egui::RichText::new(err).size(13.0).color(theme::TEXT_MUTED));
                },
            );
        });
        ui.add_space(28.0);
        ui.vertical_centered(|ui| {
            if theme::primary_button(ui, "关闭", 200.0, true) {
                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            }
        });
    }

    /// 把卸载原因/反馈写入日志（本地留痕，不上报）。
    fn log_feedback(&self) {
        let fb = self.feedback.trim();
        crate::log_line(&format!(
            "卸载原因：{}；反馈：{}",
            self.reason.label(),
            if fb.is_empty() { "（无）" } else { fb }
        ));
    }
}

/// 卸载步骤。
fn do_uninstall() -> Result<()> {
    let install_dir = paths::default_install_dir()?;

    // 1) 关闭运行中的进程：主程序 + runtimes 子进程（按路径匹配，不漏 python.exe 等孤儿）。
    let killed = platform::kill_app_processes(&install_dir);
    crate::log_line(&format!("卸载：终止 {killed} 个占用安装目录的进程"));

    // 2) 删快捷方式。
    if let Some(appdata) = dirs::data_dir() {
        let start_menu = appdata
            .join("Microsoft\\Windows\\Start Menu\\Programs")
            .join(format!("{}.lnk", paths::DISPLAY_NAME));
        let _ = std::fs::remove_file(&start_menu);
    }
    if let Some(desktop) = dirs::desktop_dir() {
        let lnk = desktop.join(format!("{}.lnk", paths::DISPLAY_NAME));
        let _ = std::fs::remove_file(&lnk);
    }

    // 3) 删注册表 Uninstall key。
    platform::delete_uninstall_key()?;

    // 4) 删安装目录文件（updater.exe 本进程无法删自身，先删其余）。
    let self_exe = std::env::current_exe().ok();
    remove_dir_except(&install_dir, self_exe.as_deref());

    // 5) 计划自删除。
    if let Some(exe) = self_exe {
        platform::schedule_self_delete(&exe);
    }

    Ok(())
}

/// 删除目录下所有文件/子目录，except 指定文件（正在运行的 updater.exe）。
fn remove_dir_except(dir: &std::path::Path, except: Option<&std::path::Path>) {
    let except_canon = except.and_then(|p| p.canonicalize().ok());
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let _ = std::fs::remove_dir_all(&path);
        } else {
            let is_except = except_canon
                .as_ref()
                .and_then(|e| path.canonicalize().ok().map(|p| &p == e))
                .unwrap_or(false);
            if !is_except {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}
