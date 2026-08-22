//! 交互安装模式（egui 深色无边框，参考现代安装器）。
//!
//! 两种界面：简洁模式（居中 logo + 立即安装）与自定义模式（红色横幅 + 路径选择）。
//! 右下角链接在两者间切换。流程：确认 → 解压 → 快捷方式 → 注册表 → 完成。

use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use anyhow::Result;

use crate::modes::deploy;
use crate::paths;
use crate::platform;
use crate::theme;

/// 简洁模式窗口高度。
const SIMPLE_SIZE: [f32; 2] = [480.0, 520.0];
/// 自定义模式窗口高度。
const CUSTOM_SIZE: [f32; 2] = [480.0, 640.0];

/// 后台安装线程发给 UI 的消息。
enum Progress {
    Step(String, f32),
    Done,
    Failed(String),
}

/// UI 当前阶段。
enum Phase {
    Confirm,
    /// 检测到主程序正在运行，询问用户是否关闭后继续。
    ProcessRunning,
    Installing {
        status: String,
        frac: f32,
    },
    Done,
    Failed(String),
}

struct InstallerApp {
    install_dir: String,
    version: String,
    phase: Phase,
    custom_mode: bool,
    create_desktop: bool,
    agreed: bool,
    logo: Option<egui::TextureHandle>,
    rx: Option<mpsc::Receiver<Progress>>,
    /// 已应用圆角时的窗口尺寸（用于切换简洁/自定义模式 resize 后重设区域）。
    rounded_size: Option<[f32; 2]>,
    /// 启动时刻：winit 在窗口显示后会重置窗口区域，需在启动后短时间内反复重设。
    started: Instant,
}

/// 启动交互安装窗口。
pub fn run_interactive(target: Option<&str>) -> Result<()> {
    let install_dir = paths::resolve_install_dir(target)?
        .to_string_lossy()
        .to_string();
    let app = InstallerApp {
        install_dir,
        version: paths::VERSION.to_string(),
        phase: Phase::Confirm,
        custom_mode: false,
        create_desktop: true,
        agreed: false,
        logo: None,
        rx: None,
        rounded_size: None,
        started: Instant::now(),
    };

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size(SIMPLE_SIZE)
            .with_min_inner_size(SIMPLE_SIZE)
            .with_resizable(false)
            .with_decorations(false) // 无边框，自绘标题栏
            .with_transparent(false)
            .with_maximize_button(false)
            .with_icon(theme::window_icon().unwrap_or_default()),
        ..Default::default()
    };
    eframe::run_native(
        &format!("{} v{} 安装程序", paths::DISPLAY_NAME, paths::VERSION),
        options,
        Box::new(|cc| {
            theme::install_fonts(&cc.egui_ctx);
            theme::apply_style(&cc.egui_ctx);
            let mut app = app;
            app.logo = theme::load_logo(&cc.egui_ctx);
            Ok(Box::new(app))
        }),
    )
    .map_err(|e| anyhow::anyhow!("启动安装界面失败：{e}"))?;
    Ok(())
}

impl eframe::App for InstallerApp {
    fn clear_color(&self, _visuals: &egui::Visuals) -> [f32; 4] {
        [0.0, 0.0, 0.0, 0.0]
    }

    fn update(&mut self, ctx: &egui::Context, frame: &mut eframe::Frame) {
        // Win11 圆角：winit 在窗口显示后会重置窗口区域，故启动后 1.2s 内每帧重设，
        // 之后仅在切换简洁/自定义模式（窗口 resize）时重设。
        let size = if self.custom_mode {
            CUSTOM_SIZE
        } else {
            SIMPLE_SIZE
        };
        let warming = self.started.elapsed() < Duration::from_millis(1200);
        if warming || self.rounded_size != Some(size) {
            use raw_window_handle::HasWindowHandle;
            if let Ok(rwh) = frame.window_handle() {
                if let raw_window_handle::RawWindowHandle::Win32(w) = rwh.as_ref() {
                    platform::set_window_rounding(w.hwnd.get() as isize);
                    self.rounded_size = Some(size);
                }
            }
            if warming {
                ctx.request_repaint_after(Duration::from_millis(50));
            }
        }

        // 接收后台安装进度。
        if let Some(rx) = &self.rx {
            while let Ok(msg) = rx.try_recv() {
                match msg {
                    Progress::Step(s, f) => self.phase = Phase::Installing { status: s, frac: f },
                    Progress::Done => {
                        self.phase = Phase::Done;
                        self.rx = None;
                        break;
                    }
                    Progress::Failed(e) => {
                        self.phase = Phase::Failed(e);
                        self.rx = None;
                        break;
                    }
                }
            }
            ctx.request_repaint();
        }

        egui::CentralPanel::default()
            .frame(egui::Frame::none().fill(theme::BG))
            .show(ctx, |ui| match &self.phase {
                Phase::Confirm => {
                    if self.custom_mode {
                        self.view_custom(ui, ctx);
                    } else {
                        self.view_simple(ui, ctx);
                    }
                }
                Phase::ProcessRunning => self.view_process_running(ui, ctx),
                Phase::Installing { status, frac } => {
                    let (s, f) = (status.clone(), *frac);
                    self.view_progress(ui, ctx, &s, f);
                }
                Phase::Done => self.view_done(ui, ctx),
                Phase::Failed(e) => {
                    let e = e.clone();
                    self.view_failed(ui, ctx, &e);
                }
            });
    }
}

impl InstallerApp {
    /// 简洁模式：标题栏 + 居中 logo/标题 + 立即安装 + 底部协议/自定义切换。
    fn view_simple(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        if theme::title_bar(ui, &format!("安装程序 v{}", paths::VERSION), false) {
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        }

        ui.add_space(40.0);
        theme::logo(ui, &self.logo, 110.0);
        ui.add_space(14.0);
        ui.vertical_centered(|ui| {
            ui.label(
                egui::RichText::new(paths::DISPLAY_NAME)
                    .size(24.0)
                    .color(theme::TEXT),
            );
        });

        ui.add_space(40.0);
        ui.vertical_centered(|ui| {
            if theme::primary_button(ui, "立即安装", 300.0, self.agreed) {
                self.begin_install();
            }
        });

        self.footer(ui, ctx, true);
    }

    /// 自定义模式：红色横幅 + 路径选择 + 立即安装 + 桌面快捷方式 + 底部协议/简洁切换。
    fn view_custom(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        // 顶部红色横幅（含标题栏 + logo + 标题）。
        let full_w = ui.available_width();
        let banner_h = 210.0;
        let (banner_rect, _) =
            ui.allocate_exact_size(egui::Vec2::new(full_w, banner_h), egui::Sense::hover());
        ui.painter()
            .rect_filled(banner_rect, egui::Rounding::ZERO, theme::BANNER_RED);

        // 在横幅区域内叠加标题栏与居中内容。
        let mut close = false;
        ui.allocate_ui_at_rect(banner_rect, |ui| {
            close = theme::title_bar(ui, &format!("安装程序 v{}", paths::VERSION), true);
            ui.add_space(18.0);
            theme::logo(ui, &self.logo, 96.0);
            ui.add_space(10.0);
            ui.vertical_centered(|ui| {
                ui.label(
                    egui::RichText::new(paths::DISPLAY_NAME)
                        .size(22.0)
                        .color(egui::Color32::WHITE),
                );
            });
        });
        if close {
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        }

        ui.add_space(34.0);
        // 安装路径行。
        ui.horizontal(|ui| {
            ui.add_space(24.0);
            ui.label(
                egui::RichText::new("安装路径：")
                    .size(14.0)
                    .color(theme::TEXT_MUTED),
            );
            // 为右侧文件夹按钮(38) + 间距(10) + 右边距(24) + TextEdit 自身边距/余量预留空间，
            // 否则按钮会被挤出窗口右缘。
            let reserved = 38.0 + 10.0 + 24.0 + 28.0;
            let w = (ui.available_width() - reserved).max(60.0);
            ui.add(
                egui::TextEdit::singleline(&mut self.install_dir)
                    .desired_width(w)
                    .vertical_align(egui::Align::Center)
                    .margin(egui::Margin::symmetric(10.0, 9.0)),
            );
            ui.add_space(4.0);
            if folder_button(ui) {
                if let Some(picked) = pick_folder(&self.install_dir) {
                    self.install_dir = picked;
                }
            }
        });

        ui.add_space(24.0);
        ui.vertical_centered(|ui| {
            if theme::primary_button(ui, "立即安装", 300.0, self.agreed) {
                self.begin_install();
            }
            ui.add_space(12.0);
            ui.checkbox(&mut self.create_desktop, "创建桌面快捷方式");
        });

        self.footer(ui, ctx, false);
    }

    /// 底部固定区：左下协议勾选，右下模式切换链接。
    /// `simple_now` 为 true 表示当前是简洁模式（链接显示「自定义安装」）。
    fn footer(&mut self, ui: &mut egui::Ui, ctx: &egui::Context, simple_now: bool) {
        let avail = ui.available_height();
        if avail > 44.0 {
            ui.add_space(avail - 44.0);
        }
        ui.horizontal(|ui| {
            ui.add_space(18.0);
            ui.checkbox(&mut self.agreed, "");
            ui.label(
                egui::RichText::new("我已阅读并同意")
                    .size(13.0)
                    .color(theme::TEXT),
            );
            let _ = theme::link(ui, "《用户协议》");
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.add_space(18.0);
                let label = if simple_now {
                    "自定义安装"
                } else {
                    "快速安装"
                };
                if theme::link(ui, label) {
                    self.custom_mode = !self.custom_mode;
                    let size = if self.custom_mode {
                        CUSTOM_SIZE
                    } else {
                        SIMPLE_SIZE
                    };
                    ctx.send_viewport_cmd(egui::ViewportCommand::InnerSize(size.into()));
                    ctx.send_viewport_cmd(egui::ViewportCommand::MinInnerSize(size.into()));
                }
            });
        });
        ui.add_space(14.0);
    }

    fn view_progress(&mut self, ui: &mut egui::Ui, ctx: &egui::Context, status: &str, frac: f32) {
        if theme::title_bar(ui, &format!("安装程序 v{}", paths::VERSION), false) {
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        }
        ui.add_space(48.0);
        theme::logo(ui, &self.logo, 96.0);
        ui.add_space(30.0);
        ui.vertical_centered(|ui| {
            ui.label(
                egui::RichText::new("正在安装")
                    .size(18.0)
                    .color(theme::TEXT)
                    .strong(),
            );
            ui.add_space(6.0);
            ui.label(
                egui::RichText::new(status)
                    .size(13.0)
                    .color(theme::TEXT_MUTED),
            );
        });
        ui.add_space(24.0);

        // Windows 11 风格进度条：带背景槽、更大圆角、流畅动画
        ui.horizontal(|ui| {
            ui.add_space(48.0);
            let available_width = ui.available_width() - 48.0;

            // 绘制进度条背景槽
            let (rect, _) = ui
                .allocate_exact_size(egui::Vec2::new(available_width, 12.0), egui::Sense::hover());

            // 背景槽（深色）
            ui.painter().rect_filled(
                rect,
                egui::Rounding::same(6.0),
                egui::Color32::from_rgb(60, 60, 60),
            );

            // 进度条填充（带渐变效果）
            if frac > 0.0 {
                let progress_width = rect.width() * frac;
                let progress_rect = egui::Rect::from_min_size(
                    rect.min,
                    egui::Vec2::new(progress_width, rect.height()),
                );

                // 纯色填充（单一红色，不叠高光，避免看起来像两段颜色）
                ui.painter()
                    .rect_filled(progress_rect, egui::Rounding::same(6.0), theme::RED);
            }
        });

        ui.add_space(8.0);
        ui.vertical_centered(|ui| {
            ui.label(
                egui::RichText::new(format!("{}%", (frac * 100.0) as u32))
                    .size(13.0)
                    .color(theme::TEXT)
                    .strong(),
            );
        });
    }

    fn view_done(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        if theme::title_bar(ui, &format!("安装程序 v{}", paths::VERSION), false) {
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        }
        ui.add_space(44.0);
        theme::logo(ui, &self.logo, 100.0);
        ui.add_space(18.0);
        theme::status_title(ui, true, "安装完成", 22.0);
        ui.vertical_centered(|ui| {
            ui.add_space(8.0);
            ui.label(
                egui::RichText::new("已添加快捷方式，可随时从控制面板卸载。")
                    .size(13.0)
                    .color(theme::TEXT_MUTED),
            );
        });
        ui.add_space(36.0);
        ui.vertical_centered(|ui| {
            if theme::primary_button(ui, "立即启动", 300.0, true) {
                let main = PathBuf::from(&self.install_dir).join(paths::MAIN_EXE);
                let _ = std::process::Command::new(main).spawn();
                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            }
            ui.add_space(10.0);
            if theme::link(ui, "完成并关闭") {
                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            }
        });
    }

    fn view_failed(&mut self, ui: &mut egui::Ui, ctx: &egui::Context, err: &str) {
        if theme::title_bar(ui, &format!("安装程序 v{}", paths::VERSION), false) {
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        }
        ui.add_space(36.0);
        theme::logo(ui, &self.logo, 96.0);
        ui.add_space(18.0);
        theme::status_title(ui, false, "安装失败", 20.0);
        ui.add_space(14.0);
        // 错误详情：左右留边距并自动换行，避免顶到窗口边缘。
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

    /// 开始安装的前置：检测主程序（或其 runtimes 子进程）是否正在运行。
    /// 若在运行 → 切 ProcessRunning 阶段（弹确认对话框，询问是否关闭后继续）。
    /// 未运行 → 直接开始安装。
    ///
    /// 按安装目录路径匹配，覆盖主程序 + runtimes/python.exe / node.exe 等被拉起的子进程——
    /// 仅杀主程序会留下占用 python.exe 的孤儿进程，导致自解压覆盖时 os error 32。
    fn begin_install(&mut self) {
        let dir = PathBuf::from(&self.install_dir);
        if platform::is_app_running(&dir) {
            self.phase = Phase::ProcessRunning;
        } else {
            self.start_install();
        }
    }

    /// 「检测到程序运行中」确认对话框：用户选关闭并继续 → kill 占用安装目录的进程后安装；取消 → 回 Confirm。
    fn view_process_running(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        if theme::title_bar(ui, &format!("安装程序 v{}", paths::VERSION), false) {
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        }
        ui.add_space(50.0);
        ui.vertical_centered(|ui| {
            ui.add_space(20.0);
            ui.label(
                egui::RichText::new("⚠")
                    .size(48.0)
                    .color(egui::Color32::from_rgb(245, 158, 11)),
            );
            ui.add_space(16.0);
            ui.label(
                egui::RichText::new(format!("检测到 {} 正在运行", paths::DISPLAY_NAME))
                    .size(16.0)
                    .color(theme::TEXT),
            );
            ui.add_space(8.0);
            ui.label(
                egui::RichText::new(
                    "安装前需要关闭正在运行的程序，否则文件可能被锁定导致安装失败。",
                )
                .size(13.0)
                .color(theme::TEXT_MUTED),
            );
            ui.label(
                egui::RichText::new("是否关闭程序并继续安装？")
                    .size(13.0)
                    .color(theme::TEXT_MUTED),
            );
            ui.add_space(28.0);
            ui.horizontal(|ui| {
                ui.add_space(60.0);
                if theme::primary_button(ui, "关闭并继续", 200.0, true) {
                    // 终止「exe 路径落在安装目录下」的所有进程（主程序 + runtimes 子进程），
                    // 并在 kill_app_processes 内部等待它们退出以释放文件锁。
                    let dir = PathBuf::from(&self.install_dir);
                    let _ = platform::kill_app_processes(&dir);
                    self.start_install();
                }
                ui.add_space(12.0);
                if theme::secondary_button(ui, "取消", 120.0) {
                    self.phase = Phase::Confirm;
                }
            });
        });
    }

    fn start_install(&mut self) {
        self.phase = Phase::Installing {
            status: "准备中…".into(),
            frac: 0.0,
        };
        let dir = PathBuf::from(&self.install_dir);
        let version = self.version.clone();
        let create_desktop = self.create_desktop;
        let (tx, rx) = mpsc::channel();
        self.rx = Some(rx);

        std::thread::spawn(move || {
            let result = do_install(&dir, &version, create_desktop, &tx);
            match result {
                Ok(()) => {
                    let _ = tx.send(Progress::Done);
                }
                Err(e) => {
                    let _ = tx.send(Progress::Failed(format!("{e:#}")));
                }
            }
        });
    }
}

/// 文件夹选择小按钮（图标）- Windows 11 风格圆角。返回是否点击。
fn folder_button(ui: &mut egui::Ui) -> bool {
    let (rect, resp) = ui.allocate_exact_size(egui::Vec2::splat(38.0), egui::Sense::click());
    let bg = if resp.hovered() {
        theme::BORDER
    } else {
        theme::INPUT_BG
    };
    ui.painter()
        .rect_filled(rect, egui::Rounding::same(8.0), bg); // Windows 11 风格圆角
    ui.painter().text(
        rect.center(),
        egui::Align2::CENTER_CENTER,
        "📁",
        egui::FontId::proportional(18.0),
        theme::TEXT,
    );
    resp.clicked()
}

/// 调系统文件夹选择对话框（PowerShell）。返回所选路径或 None。
fn pick_folder(current: &str) -> Option<String> {
    let script = format!(
        "Add-Type -AssemblyName System.Windows.Forms; \
         $d = New-Object System.Windows.Forms.FolderBrowserDialog; \
         $d.SelectedPath = '{}'; \
         if ($d.ShowDialog() -eq 'OK') {{ Write-Output $d.SelectedPath }}",
        current.replace('\'', "''")
    );
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-STA", "-Command", &script])
        .output()
        .ok()?;
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        let p = PathBuf::from(&path);
        if p.file_name()
            .map(|n| n == paths::INSTALL_DIR_NAME)
            .unwrap_or(false)
        {
            Some(path)
        } else {
            Some(
                p.join(paths::INSTALL_DIR_NAME)
                    .to_string_lossy()
                    .to_string(),
            )
        }
    }
}

/// 实际安装步骤（后台线程执行，通过 tx 推进度）。
/// 改进：更细粒度的进度反馈，真实反映安装过程。
fn do_install(
    dir: &std::path::Path,
    version: &str,
    create_desktop: bool,
    tx: &mpsc::Sender<Progress>,
) -> Result<()> {
    // 阶段 1: 解压 (0% -> 60%)
    let _ = tx.send(Progress::Step("正在检查安装目录…".into(), 0.05));
    std::thread::sleep(std::time::Duration::from_millis(100));

    let _ = tx.send(Progress::Step("正在解压程序文件…".into(), 0.10));
    deploy::deploy_to(dir)?;
    let _ = tx.send(Progress::Step("程序文件解压完成".into(), 0.60));

    let main_exe = dir.join(paths::MAIN_EXE);
    let icon = dir.join("icons").join("icon.ico");
    let icon = if icon.exists() {
        icon
    } else {
        main_exe.clone()
    };

    // 阶段 2: 创建快捷方式 (60% -> 80%)
    let _ = tx.send(Progress::Step("正在创建开始菜单快捷方式…".into(), 0.65));
    if let Some(appdata) = dirs::data_dir() {
        let start_menu = appdata
            .join("Microsoft\\Windows\\Start Menu\\Programs")
            .join(format!("{}.lnk", paths::DISPLAY_NAME));
        platform::create_shortcut(&start_menu, &main_exe, dir, &icon)?;
    }

    if create_desktop {
        let _ = tx.send(Progress::Step("正在创建桌面快捷方式…".into(), 0.75));
        if let Some(desktop) = dirs::desktop_dir() {
            let lnk = desktop.join(format!("{}.lnk", paths::DISPLAY_NAME));
            platform::create_shortcut(&lnk, &main_exe, dir, &icon)?;
        }
    }
    let _ = tx.send(Progress::Step("快捷方式创建完成".into(), 0.80));

    // 阶段 3: 注册表写入 (80% -> 95%)
    let _ = tx.send(Progress::Step("正在注册卸载信息…".into(), 0.85));
    let size_kb = deploy::dir_size_kb(dir);
    platform::write_uninstall_key(dir, version, size_kb)?;
    let _ = tx.send(Progress::Step("系统注册完成".into(), 0.95));

    // 阶段 4: 完成收尾 (95% -> 100%)
    let _ = tx.send(Progress::Step("正在完成安装…".into(), 0.98));
    std::thread::sleep(std::time::Duration::from_millis(200));
    let _ = tx.send(Progress::Step("安装完成！".into(), 1.0));
    Ok(())
}
