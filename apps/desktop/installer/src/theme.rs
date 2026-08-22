//! 安装器/卸载器统一视觉主题（深色无边框风格，参考现代 Tauri/Electron 安装器）。
//!
//! 提供深色调色板、无边框自定义标题栏（拖动+关闭）、居中 logo 纹理、红色主行动按钮、
//! 蓝色链接等可复用组件，让 install/uninstall 观感一致。egui 0.28 API。

use egui::{Color32, FontId, RichText, Rounding, Sense, Stroke, Vec2};

/// 红色主强调（行动按钮 / 自定义模式横幅）- 改用更现代的暖红色调。
pub const RED: Color32 = Color32::from_rgb(220, 80, 72);
/// 自定义模式顶部横幅红。
pub const BANNER_RED: Color32 = Color32::from_rgb(225, 84, 74);
/// 成功色（完成态）。
pub const SUCCESS: Color32 = Color32::from_rgb(74, 201, 126);
/// 窗口主背景（深灰）- 稍微提亮以改善对比度。
pub const BG: Color32 = Color32::from_rgb(45, 45, 45);
/// 输入框 / 凹陷区背景 - 与主背景有更清晰的层次。
pub const INPUT_BG: Color32 = Color32::from_rgb(60, 60, 60);
/// 主文字色（近白）- 确保 WCAG AA 对比度。
pub const TEXT: Color32 = Color32::from_rgb(240, 240, 240);
/// 次要文字色（灰）- 保持可读性。
pub const TEXT_MUTED: Color32 = Color32::from_rgb(160, 160, 160);
/// 边框色（中灰）- 更柔和的分隔线。
pub const BORDER: Color32 = Color32::from_rgb(90, 90, 90);
/// 链接蓝。
pub const LINK: Color32 = Color32::from_rgb(96, 150, 235);

/// 标题栏高度。
pub const TITLE_BAR_H: f32 = 40.0;

/// 应用整体 egui 风格（深色、圆角、留白）。
/// 改进：优化间距、Windows 11 风格圆角、更流畅的交互反馈。
pub fn apply_style(ctx: &egui::Context) {
    let mut style = (*ctx.style()).clone();

    style.visuals = egui::Visuals::dark();
    style.visuals.panel_fill = BG;
    style.visuals.window_fill = BG;
    style.visuals.extreme_bg_color = INPUT_BG; // TextEdit 背景
    style.visuals.override_text_color = Some(TEXT);
    style.visuals.widgets.noninteractive.bg_stroke = Stroke::new(1.0, BORDER);
    style.visuals.widgets.inactive.bg_fill = INPUT_BG;
    style.visuals.widgets.inactive.weak_bg_fill = INPUT_BG;
    style.visuals.widgets.inactive.rounding = Rounding::same(8.0); // Windows 11 风格圆角
    style.visuals.widgets.hovered.bg_fill = Color32::from_rgb(70, 70, 70); // 悬停时稍亮
    style.visuals.widgets.hovered.rounding = Rounding::same(8.0);
    style.visuals.widgets.active.rounding = Rounding::same(8.0);
    style.visuals.selection.bg_fill = RED;
    style.visuals.selection.stroke = Stroke::new(1.0, RED);

    // Windows 11 风格：更大的窗口圆角
    style.visuals.window_rounding = Rounding::same(12.0);
    style.visuals.menu_rounding = Rounding::same(8.0);

    use egui::TextStyle::*;
    style.text_styles = [
        (Heading, FontId::proportional(24.0)),
        (Body, FontId::proportional(15.0)),
        (Button, FontId::proportional(16.0)),
        (Small, FontId::proportional(12.5)),
        (Monospace, FontId::monospace(13.0)),
    ]
    .into();

    // 优化间距：更舒适的呼吸感
    style.spacing.button_padding = Vec2::new(18.0, 10.0);
    style.spacing.item_spacing = Vec2::new(12.0, 10.0);
    style.spacing.window_margin = egui::Margin::same(0.0); // 无边框窗口不需要额外边距

    ctx.set_style(style);
}

/// 加载系统中文字体（egui 默认字体不含 CJK，否则显示方框）。
pub fn install_fonts(ctx: &egui::Context) {
    let candidates = [
        "C:\\Windows\\Fonts\\msyh.ttc",   // 微软雅黑
        "C:\\Windows\\Fonts\\msyhl.ttc",  // 微软雅黑 Light
        "C:\\Windows\\Fonts\\simhei.ttf", // 黑体
        "C:\\Windows\\Fonts\\simsun.ttc", // 宋体
    ];
    for path in candidates {
        if let Ok(bytes) = std::fs::read(path) {
            let mut fonts = egui::FontDefinitions::default();
            fonts
                .font_data
                .insert("cjk".to_owned(), egui::FontData::from_owned(bytes));
            fonts
                .families
                .entry(egui::FontFamily::Proportional)
                .or_default()
                .insert(0, "cjk".to_owned());
            fonts
                .families
                .entry(egui::FontFamily::Monospace)
                .or_default()
                .push("cjk".to_owned());
            ctx.set_fonts(fonts);
            return;
        }
    }
}

/// 自定义标题栏：左侧标题文字，右侧关闭按钮，整条可拖动窗口。
/// Windows 11 风格：更大圆角的关闭按钮。
///
/// `over_red` 为 true 时（自定义模式横幅）用白色文字/浅色关闭图标。
/// 返回是否点击了关闭按钮。
pub fn title_bar(ui: &mut egui::Ui, title: &str, over_red: bool) -> bool {
    let full_w = ui.available_width();
    let (rect, resp) =
        ui.allocate_exact_size(Vec2::new(full_w, TITLE_BAR_H), Sense::click_and_drag());

    // 拖动窗口（点在标题栏空白处按住即可移动）。
    if resp.is_pointer_button_down_on() {
        ui.ctx().send_viewport_cmd(egui::ViewportCommand::StartDrag);
    }

    let fg = if over_red { Color32::WHITE } else { TEXT };
    let painter = ui.painter();

    // 标题文字。
    painter.text(
        egui::pos2(rect.min.x + 18.0, rect.center().y),
        egui::Align2::LEFT_CENTER,
        title,
        FontId::proportional(16.0),
        fg,
    );

    // 关闭按钮（右上角 X）- Windows 11 风格圆角
    let btn = egui::Rect::from_center_size(
        egui::pos2(rect.max.x - 26.0, rect.center().y),
        Vec2::splat(32.0), // 稍大的点击区域
    );
    let btn_resp = ui.interact(btn, ui.id().with("close_btn"), Sense::click());
    if btn_resp.hovered() {
        painter.rect_filled(btn, Rounding::same(6.0), Color32::from_rgb(232, 64, 60));
    }
    let x_color = if btn_resp.hovered() {
        Color32::WHITE
    } else {
        fg
    };
    let c = btn.center();
    let r = 6.0;
    let stroke = Stroke::new(1.8, x_color); // 稍粗的线条
    painter.line_segment(
        [egui::pos2(c.x - r, c.y - r), egui::pos2(c.x + r, c.y + r)],
        stroke,
    );
    painter.line_segment(
        [egui::pos2(c.x - r, c.y + r), egui::pos2(c.x + r, c.y - r)],
        stroke,
    );

    btn_resp.clicked()
}

/// 主行动按钮（红色填充，大号，可指定宽度）。返回是否被点击。
/// Windows 11 风格：更大圆角、平滑悬停效果。
pub fn primary_button(ui: &mut egui::Ui, text: &str, width: f32, enabled: bool) -> bool {
    let (fill, text_color) = if enabled {
        (RED, Color32::WHITE)
    } else {
        (
            Color32::from_rgb(90, 70, 70),
            Color32::from_rgb(170, 150, 150),
        )
    };

    let btn = egui::Button::new(RichText::new(text).color(text_color).size(17.0).strong())
        .fill(fill)
        .rounding(Rounding::same(8.0)) // Windows 11 风格圆角
        .min_size(Vec2::new(width, 56.0));

    let resp = ui.add_enabled(enabled, btn);

    // 优化悬停效果：使用 sense 而非双重绘制
    if resp.hovered() && enabled {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }

    resp.clicked()
}

/// 次要按钮（灰底白字），用于取消/次要操作。返回是否被点击。
pub fn secondary_button(ui: &mut egui::Ui, text: &str, width: f32) -> bool {
    let btn = egui::Button::new(RichText::new(text).color(TEXT).size(15.0))
        .fill(Color32::from_rgb(60, 60, 68))
        .rounding(Rounding::same(8.0))
        .min_size(Vec2::new(width, 56.0));
    let resp = ui.add(btn);
    if resp.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    resp.clicked()
}

/// 内嵌可点击链接文字。返回是否被点击。
pub fn link(ui: &mut egui::Ui, text: &str) -> bool {
    let resp =
        ui.add(egui::Label::new(RichText::new(text).color(LINK).size(13.0)).sense(Sense::click()));
    if resp.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    resp.clicked()
}

/// 居中绘制一个状态图标圆：`ok=true` 画对勾（绿），否则画叉（红）。
/// 改进：使用更流畅的线条和更清晰的视觉效果。
pub fn status_icon(ui: &mut egui::Ui, ok: bool, diameter: f32) {
    let (rect, _) = ui.allocate_exact_size(Vec2::splat(diameter), Sense::hover());
    let painter = ui.painter();
    let c = rect.center();
    let color = if ok { SUCCESS } else { RED };

    // 外圆：使用稍粗的线条，增强视觉冲击力
    painter.circle_stroke(c, diameter * 0.46, Stroke::new(2.8, color));

    let r = diameter * 0.24; // 稍微增大图标尺寸
    let stroke = Stroke::new(3.0, color); // 增加线条粗细

    if ok {
        // 对勾：调整比例使其更美观
        painter.line_segment(
            [
                egui::pos2(c.x - r * 0.9, c.y),
                egui::pos2(c.x - r * 0.15, c.y + r * 0.75),
            ],
            stroke,
        );
        painter.line_segment(
            [
                egui::pos2(c.x - r * 0.15, c.y + r * 0.75),
                egui::pos2(c.x + r * 0.95, c.y - r * 0.65),
            ],
            stroke,
        );
    } else {
        // 叉：使用对称的 X 形状
        painter.line_segment(
            [
                egui::pos2(c.x - r * 0.85, c.y - r * 0.85),
                egui::pos2(c.x + r * 0.85, c.y + r * 0.85),
            ],
            stroke,
        );
        painter.line_segment(
            [
                egui::pos2(c.x - r * 0.85, c.y + r * 0.85),
                egui::pos2(c.x + r * 0.85, c.y - r * 0.85),
            ],
            stroke,
        );
    }
}

/// 居中绘制 logo 纹理（按给定边长）。纹理为空时画一个占位环。
pub fn logo(ui: &mut egui::Ui, tex: &Option<egui::TextureHandle>, size: f32) {
    ui.vertical_centered(|ui| {
        if let Some(t) = tex {
            ui.add(egui::Image::new(t).fit_to_exact_size(Vec2::splat(size)));
        } else {
            let (rect, _) = ui.allocate_exact_size(Vec2::splat(size), Sense::hover());
            ui.painter()
                .circle_stroke(rect.center(), size * 0.4, Stroke::new(3.0, TEXT_MUTED));
        }
    });
}

/// 水平居中的「状态图标 + 标题」组合（用于完成/失败页，整体居中而非靠左）。
pub fn status_title(ui: &mut egui::Ui, ok: bool, title: &str, font_size: f32) {
    let color = if ok { SUCCESS } else { RED };
    let icon_d = font_size + 2.0;
    // 估算整体宽度：图标 + 间距 + 文字。文字宽用字符数粗估（CJK 约等于字号宽）。
    let galley =
        ui.painter()
            .layout_no_wrap(title.to_owned(), FontId::proportional(font_size), color);
    let total_w = icon_d + 8.0 + galley.size().x;
    let avail = ui.available_width();
    let indent = ((avail - total_w) * 0.5).max(0.0);
    ui.horizontal(|ui| {
        ui.add_space(indent);
        status_icon(ui, ok, icon_d);
        ui.add_space(6.0);
        ui.label(RichText::new(title).size(font_size).color(color).strong());
    });
}
/// 解码内嵌 PNG 为 egui 纹理（中间 logo 用，原图为 App icon.png）。
pub fn load_logo(ctx: &egui::Context) -> Option<egui::TextureHandle> {
    const PNG: &[u8] = include_bytes!("../../src-tauri/icons/128x128@2x.png");
    let (rgba, w, h) = decode_png(PNG)?;
    let img = egui::ColorImage::from_rgba_unmultiplied([w as usize, h as usize], &rgba);
    Some(ctx.load_texture("logo", img, egui::TextureOptions::LINEAR))
}

/// 窗口图标（标题栏/任务栏，64×64）。
pub fn window_icon() -> Option<egui::IconData> {
    const PNG: &[u8] = include_bytes!("../../src-tauri/icons/64x64.png");
    let (rgba, width, height) = decode_png(PNG)?;
    Some(egui::IconData {
        rgba,
        width,
        height,
    })
}

/// 解码 PNG → (RGBA8, width, height)。
fn decode_png(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf[..info.buffer_size()].to_vec(),
        png::ColorType::Rgb => buf[..info.buffer_size()]
            .chunks_exact(3)
            .flat_map(|p| [p[0], p[1], p[2], 255])
            .collect(),
        _ => return None,
    };
    Some((rgba, info.width, info.height))
}
