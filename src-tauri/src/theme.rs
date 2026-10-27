//! 主题：schema 定义、由壁纸生成、本地主题库。
//!
//! ## 设计约束（重要，后续不要破坏）
//! 1. 主题是**渲染器无关**的纯数据：颜色是 hex、尺寸是「设计像素数（scale=1 时）」。
//!    哪天把 WebView2 换成自绘渲染器，这份 schema 一字不用改。
//! 2. 所有尺寸字段一律是**数字**，不带单位。前端负责乘上 `--kal-u`（缩放基元）。
//!    单位混进数据里，缩放模型就没法统一了。
//! 3. 所有颜色字段一律是 `#RRGGBB`，透明度**单独**一个 alpha 字段。
//!    这样「同一个色换透明度」不用改颜色，取色/对比度校正也好算。
//! 4. 新增字段必须带 serde default —— 老主题文件要能继续读。

use crate::color::{self, Rgb};
use crate::palette::{self, Analysis, SampleOpts};
use crate::{store, wallpaper};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const SCHEMA: &str = "kal.theme/1";

// ---------------------------------------------------------------- schema

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Theme {
    pub schema: String,
    pub id: String,
    pub name: String,
    /// manual | wallpaper | preset
    pub source: String,
    /// dark | light
    pub mode: String,
    pub wallpaper: String,
    pub created: String,
    pub color: Colors,
    #[serde(rename = "type")]
    pub typography: Typography,
    pub shape: Shape,
    pub backdrop: Backdrop,
    pub layout: Layout,
    /// 用户偏好的额外缩放倍率（与屏幕 PPI 校正相乘）
    pub scale: f32,
    /// auto = 跟随屏幕 PPI 校正；fixed = 恒为 1
    pub scale_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Colors {
    pub bg: String,
    pub bg_alpha: f32,

    pub surface: String,
    pub surface_alpha: f32,
    pub surface_hover: String,
    pub surface_hover_alpha: f32,

    pub fg: String,
    pub fg_muted: String,
    pub fg_dim: String,
    pub fg_weekend: String,
    pub fg_holiday: String,
    pub fg_other_month: String,

    pub accent: String,
    pub accent_fg: String,
    pub danger: String,
    pub danger_fg: String,
    pub focus: String,
    pub done: String,
    pub selected_bg: String,
    pub selected_fg: String,
    pub today_bg: String,
    pub today_bg_alpha: f32,
    pub today_ring: String,
    pub today_ring_alpha: f32,

    pub line: String,
    pub line_alpha: f32,
    pub border_alpha: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Typography {
    pub family_ui: String,
    pub family_num: String,
    /// 字体宽度百分比；具体效果取决于字体宽度轴支持。
    pub stretch: f32,
    pub size: FontSizes,
    pub weight: FontWeights,
    pub line_height: LineHeights,
    pub letter_spacing: LetterSpacing,
    pub italic: bool,
    /// left | center —— 月历格内文字对齐
    pub cell_align: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FontSizes {
    /// 月历格里的日期数字
    pub day: f32,
    /// 农历 / 节气副标题
    pub sub: f32,
    /// 格内任务行
    pub task: f32,
    /// 顶栏大月份标题
    pub title: f32,
    /// 星期头
    pub head: f32,
    /// 右侧日程列表
    pub agenda: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FontWeights {
    pub day: u32,
    pub title: u32,
    pub task: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LineHeights {
    pub tight: f32,
    pub normal: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LetterSpacing {
    pub title: f32,
    pub head: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Shape {
    pub radius: f32,
    pub radius_cell: f32,
    pub blur: f32,
    pub shadow: bool,
    pub shadow_strength: f32,
    pub border_width: f32,
    /// 日格背景不透明度系数 (0.0..=1.0)，与 surfaceAlpha 相乘
    pub cell_alpha: f32,
    /// 文字护航阴影强度 (0.0..=1.0)，在透明底或壁纸底上增强文字可读性
    pub text_shadow: f32,
    /// 网格风格：cards（独立圆角卡片）| grid（经典无缝网格线）| minimal（极简无框悬浮）
    pub grid_style: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Backdrop {
    /// none（纯色/穿透桌面）| desktop（同步系统桌面壁纸）| custom（自定义图片）| art（内置艺术壁纸）
    pub mode: String,
    /// 内置艺术壁纸预设 ID：aurora | ink-paper | sunset-glow | cyber-grid | forest-mist | warm-grain
    pub preset: String,
    /// 壁纸层不透明度 (0.0..=1.0)
    pub opacity: f32,
    /// 壁纸层模糊度 px (0.0..=60.0)
    pub blur: f32,
    /// 壁纸明度倍率 (0.2..=2.0)
    pub brightness: f32,
    /// 壁纸饱和度倍率 (0.0..=3.0)
    pub saturate: f32,
    /// 填充方式：cover | contain | center
    pub fit: String,
    /// 暗角强度 (0.0..=1.0)
    pub vignette: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Layout {
    pub pad: f32,
    pub pad_sm: f32,
    pub gap: f32,
    pub cell_gap: f32,
    /// side | hidden
    pub agenda: String,
    pub agenda_width: f32,
    /// 0 = 周日起始，1 = 周一起始
    pub week_start: u32,
    /// 每格最多显示几行任务，超出折叠为 +N
    pub max_tasks: u32,
    pub show_lunar: bool,
    pub show_weekend_color: bool,
    pub show_cell_count: bool,
    /// 是否显示法定节假日「休/班」角标与调休底色
    pub show_holiday_badge: bool,
    /// 是否显示周次徽章（第 N 周）
    pub show_week_number: bool,
    /// 是否显示每日黄历干支与「宜 / 忌」提示
    pub show_yi_ji: bool,
    /// 格内任务换行方式：wrap（自动多行换行，默认）| clamp2（最多两行）| nowrap（单行省略）
    pub task_wrap: String,
    /// 格内与清单项目符号样式：dot（圆点）| number（1. 2. 3. 编号）| none（无符号）
    pub bullet_style: String,
    /// 是否隐藏已完成任务
    pub hide_completed: bool,
    /// 是否将已完成任务自动排到末尾
    pub sort_completed_last: bool,
    /// 界面显示语言：zh-CN | zh-TW | en
    pub language: String,
    /// 是否减少界面过渡与微交互动画
    pub reduced_motion: bool,
}

// ---------------------------------------------------------------- 默认值

impl Default for FontSizes {
    fn default() -> Self {
        Self { day: 15.0, sub: 12.5, task: 11.5, title: 30.0, head: 11.0, agenda: 13.0 }
    }
}
impl Default for FontWeights {
    fn default() -> Self {
        Self { day: 600, title: 700, task: 400 }
    }
}
impl Default for LineHeights {
    fn default() -> Self {
        Self { tight: 1.15, normal: 1.45 }
    }
}
impl Default for LetterSpacing {
    fn default() -> Self {
        Self { title: -0.02, head: 0.14 }
    }
}
impl Default for Shape {
    fn default() -> Self {
        Self {
            radius: 18.0,
            radius_cell: 10.0,
            blur: 0.0,
            shadow: false,
            shadow_strength: 0.0,
            border_width: 1.0,
            cell_alpha: 1.0,
            text_shadow: 0.0,
            grid_style: "cards".into(),
        }
    }
}
impl Default for Backdrop {
    fn default() -> Self {
        Self {
            mode: "none".into(),
            preset: "aurora".into(),
            opacity: 0.72,
            blur: 0.0,
            brightness: 1.0,
            saturate: 1.0,
            fit: "cover".into(),
            vignette: 0.15,
        }
    }
}
impl Default for Layout {
    fn default() -> Self {
        Self {
            pad: 16.0,
            pad_sm: 8.0,
            gap: 6.0,
            cell_gap: 3.0,
            agenda: "hidden".into(),
            agenda_width: 268.0,
            week_start: 1,
            max_tasks: 4,
            show_lunar: true,
            show_weekend_color: true,
            show_cell_count: true,
            show_holiday_badge: true,
            show_week_number: true,
            show_yi_ji: false,
            task_wrap: "wrap".into(),
            bullet_style: "dot".into(),
            hide_completed: false,
            sort_completed_last: false,
            language: "zh-CN".into(),
            reduced_motion: false,
        }
    }
}
impl Default for Typography {
    fn default() -> Self {
        Self {
            family_ui: default_ui_family(),
            family_num: default_num_family(),
            stretch: 100.0,
            size: FontSizes::default(),
            weight: FontWeights::default(),
            line_height: LineHeights::default(),
            letter_spacing: LetterSpacing::default(),
            italic: false,
            cell_align: "left".into(),
        }
    }
}
impl Default for Colors {
    fn default() -> Self {
        Self {
            bg: "#FBF6EC".into(),
            bg_alpha: 1.0,
            surface: "#FFFDF7".into(),
            surface_alpha: 1.0,
            surface_hover: "#E8EDF8".into(),
            surface_hover_alpha: 1.0,
            fg: "#172648".into(),
            fg_muted: "#536389".into(),
            fg_dim: "#536389".into(),
            fg_weekend: "#A3314B".into(),
            fg_holiday: "#A3314B".into(),
            fg_other_month: "#536389".into(),
            accent: "#2649A0".into(),
            accent_fg: "#FFFDF7".into(),
            danger: "#A3314B".into(),
            danger_fg: "#FFFDF7".into(),
            focus: "#2649A0".into(),
            done: "#536389".into(),
            selected_bg: "#E2E9F7".into(),
            selected_fg: "#172648".into(),
            today_bg: "#E2E9F7".into(),
            today_bg_alpha: 1.0,
            today_ring: "#2649A0".into(),
            today_ring_alpha: 1.0,
            line: "#D5DCEB".into(),
            line_alpha: 1.0,
            border_alpha: 1.0,
        }
    }
}
impl Default for Theme {
    fn default() -> Self {
        Self {
            schema: SCHEMA.into(),
            id: "default".into(),
            name: "星港素纸".into(),
            source: "preset".into(),
            mode: "light".into(),
            wallpaper: String::new(),
            created: String::new(),
            color: Colors::default(),
            typography: Typography::default(),
            shape: Shape::default(),
            backdrop: Backdrop::default(),
            layout: Layout::default(),
            scale: 1.0,
            scale_mode: "auto".into(),
        }
    }
}

pub fn default_ui_family() -> String {
    // 中文优先：雅黑 UI 在 Win10/11 上都稳定，且等宽数字表现好
    "\"Microsoft YaHei UI\", \"Segoe UI\", \"PingFang SC\", \"Noto Sans SC\", system-ui, sans-serif"
        .into()
}
pub fn default_num_family() -> String {
    "\"Segoe UI Variable Display\", \"Segoe UI\", \"Microsoft YaHei UI\", system-ui, sans-serif".into()
}

// ---------------------------------------------------------------- 生成

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GenOpts {
    pub name: Option<String>,
    /// 强制明暗模式：dark | light
    pub mode: Option<String>,
    /// 强制面板不透明度
    pub alpha: Option<f32>,
    pub k: usize,
    /// 面板在壁纸上的归一化矩形
    pub region: Option<(f32, f32, f32, f32)>,
    /// 手动指定强调色
    pub accent: Option<String>,
    /// 取色区域加权倍数（1 = 关闭区域加权）
    pub region_boost: f32,
    /// 解码后降采样的长边上限
    pub max_side: u32,
    /// 是否按「窗口在屏幕上的位置」加权取色（面板背后那块壁纸）
    pub region_from_window: bool,
}

impl Default for GenOpts {
    fn default() -> Self {
        Self {
            name: None,
            mode: None,
            alpha: None,
            k: 8,
            region: None,
            accent: None,
            region_boost: 4.0,
            max_side: 224,
            region_from_window: false,
        }
    }
}

/// 可解释的生成报告 —— 前端「为什么是这个颜色」面板直接吃这个
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenReport {
    pub mode: String,
    pub region_l: f32,
    pub ambient_l: f32,
    pub sampled: usize,
    pub wallpaper_source: String,
    pub base: String,
    pub accent: String,
    pub accent_from: String,
    pub bg_alpha: f32,
    pub contrast_fg: f32,
    pub contrast_muted: f32,
    pub contrast_accent: f32,
    pub clusters: Vec<ClusterBrief>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterBrief {
    pub hex: String,
    pub share: f32,
}

fn hex(c: Rgb) -> String {
    color::rgb_to_hex(c)
}

/// 挑强调色：彩度 × 面积^0.35 最大者。
/// 用面积开方（而非线性）是刻意的 —— 一个只占 3% 但极鲜艳的颜色
/// 才是壁纸的「记忆点」，直接按面积排会永远被大片背景吃掉。
fn pick_accent(a: &Analysis, bg: Rgb, dark: bool, over: Option<Rgb>) -> (Rgb, String) {
    if let Some(rgb) = over {
        return (rgb, "manual".into());
    }
    let mut best: Option<(f32, f32, f32)> = None; // (score, hue, chroma)
    for c in &a.clusters {
        if c.share < 0.02 {
            continue;
        }
        let (_, ch, h) = color::lch(c.lab);
        let score = ch * c.share.powf(0.35);
        if best.map(|b| score > b.0).unwrap_or(true) {
            best = Some((score, h, ch));
        }
    }

    let (hue, chroma, from) = match best {
        Some((_, h, ch)) if ch >= 0.045 => (h, (ch * 1.25).clamp(0.09, 0.22), "cluster"),
        Some((_, h, _)) => {
            // 壁纸偏灰但有可辨色相：借用主色色相，把彩度补起来
            let base_c = a.clusters.first().map(|c| color::lch(c.lab).1).unwrap_or(0.0);
            if base_c >= 0.02 {
                (h, 0.145, "wallpaper-hue")
            } else {
                (if dark { 255.0 } else { 262.0 }, 0.135, "fallback")
            }
        }
        None => (if dark { 255.0 } else { 262.0 }, 0.135, "fallback"),
    };

    let target = if dark { 5.4 } else { 4.6 };
    let lab = color::at_contrast(bg, hue, chroma, target, dark);
    (color::lab_to_rgb(lab), from.into())
}

/// 由「当前壁纸」生成主题
pub fn generate(opts: &GenOpts) -> Result<(Theme, GenReport), String> {
    let wp = wallpaper::locate();
    if !wp.exists {
        return Err("未找到当前壁纸文件".into());
    }
    generate_from_path(&wp.path, &wp.source, opts)
}

/// 由指定图片生成主题（CLI 与「指定图片」入口走这里）
pub fn generate_from_path(
    path: &str,
    source: &str,
    opts: &GenOpts,
) -> Result<(Theme, GenReport), String> {
    let rgba = palette::load_rgba(path, opts.max_side)?;

    let sopts = SampleOpts {
        k: opts.k.clamp(4, 16),
        region: opts.region,
        region_boost: opts.region_boost.clamp(1.0, 12.0),
    };
    let a = palette::analyze(&rgba, &sopts);

    let mode = opts
        .mode
        .clone()
        .unwrap_or_else(|| palette::decide_mode(a.region_l).to_string());
    let dark = mode == "dark";

    let base = a.clusters.first().copied().unwrap_or(palette::Cluster {
        lab: color::Lab { l: 0.2, a: 0.0, b: 0.0 },
        share: 1.0,
        color: Rgb::gray(0.2),
    });
    let (_, base_c, base_h) = color::lch(base.lab);

    // ---- 面板底色：落在固定明度区间内，只借壁纸的色相与一点点彩度 ----
    // 不直接拿主色当底色，否则面板会和壁纸糊成一片，字就没处站了。
    let bg_l = if dark {
        0.115 + (1.0 - base.lab.l) * 0.075
    } else {
        0.955 - base.lab.l * 0.075
    };
    let bg_c = (base_c * 0.50 + 0.008).min(0.060);
    let bg = color::lab_to_rgb(color::from_lch(bg_l, bg_c, base_h));

    // ---- 次级表面 ----
    let surf_l = if dark { bg_l + 0.075 } else { bg_l - 0.055 };
    let surf_c = (bg_c * 1.15).min(0.070);
    let surface = color::lab_to_rgb(color::from_lch(surf_l, surf_c, base_h));

    // ---- 文字层级：全部靠二分吃对比度，不靠拍脑袋的灰阶 ----
    let fg = color::lab_to_rgb(color::at_contrast(bg, base_h, 0.006, 13.0, dark));
    let fg_muted = color::lab_to_rgb(color::at_contrast(bg, base_h, 0.008, 6.5, dark));
    let fg_dim = color::lab_to_rgb(color::at_contrast(bg, base_h, 0.010, 4.2, dark));
    let fg_other = color::lab_to_rgb(color::at_contrast(bg, base_h, 0.008, 2.6, dark));

    // ---- 强调色 ----
    let over = opts.accent.as_deref().and_then(color::hex_to_rgb);
    let (accent, accent_from) = pick_accent(&a, bg, dark, over);

    // ---- 周末 / 节假日：借壁纸的暖色相，没有就用标准暖橙 ----
    let warm = a.warm_hue.unwrap_or(32.0);
    let week_c = if a.warm_hue.is_some() { 0.115 } else { 0.135 };
    let fg_weekend = color::lab_to_rgb(color::at_contrast(bg, warm, week_c, 4.8, dark));
    let fg_holiday = color::lab_to_rgb(color::at_contrast(bg, warm, week_c, 6.0, dark));

    // ---- 面板不透明度：面板与背后壁纸的明度差越小，越要加不透明度 ----
    let sep = (bg_l - a.region_l).abs();
    let need = (0.30 - sep).max(0.0);
    let bg_alpha = opts.alpha.unwrap_or_else(|| (0.58 + need * 0.9).clamp(0.55, 0.90));

    // ---- 线 / 悬停：一律用前景色 + 低 alpha，跟着模式自动适配 ----
    let line_alpha = if dark { 0.075 } else { 0.10 };
    let border_alpha = if dark { 0.11 } else { 0.14 };
    let hover_alpha = if dark { 0.05 } else { 0.06 };

    let mut t = Theme {
        schema: SCHEMA.into(),
        id: store::safe_id(opts.name.as_deref().unwrap_or("wallpaper")),
        name: opts.name.clone().unwrap_or_else(|| "壁纸主题".into()),
        source: "wallpaper".into(),
        mode: mode.clone(),
        wallpaper: path.to_string(),
        created: now_stamp(),
        scale: 1.0,
        scale_mode: "auto".into(),
        ..Default::default()
    };

    t.color = Colors {
        bg: hex(bg),
        bg_alpha,
        surface: hex(surface),
        surface_alpha: if dark { 0.42 } else { 0.55 },
        surface_hover: hex(fg),
        surface_hover_alpha: hover_alpha,
        fg: hex(fg),
        fg_muted: hex(fg_muted),
        fg_dim: hex(fg_dim),
        fg_weekend: hex(fg_weekend),
        fg_holiday: hex(fg_holiday),
        fg_other_month: hex(fg_other),
        accent: hex(accent),
        accent_fg: hex(color::best_on(accent)),
        today_bg: hex(accent),
        today_bg_alpha: if dark { 0.18 } else { 0.16 },
        today_ring: hex(accent),
        today_ring_alpha: if dark { 0.55 } else { 0.60 },
        line: hex(fg),
        line_alpha,
        border_alpha,
        danger: if dark { "#FF9FB4" } else { "#9E2947" }.into(),
        danger_fg: if dark { "#181A20" } else { "#FFFFFF" }.into(),
        focus: hex(accent),
        done: hex(fg_muted),
        selected_bg: hex(surface),
        selected_fg: hex(fg),
    };

    let report = GenReport {
        mode,
        region_l: a.region_l,
        ambient_l: a.ambient_l,
        sampled: a.sampled,
        wallpaper_source: source.to_string(),
        base: hex(base.color),
        accent: hex(accent),
        accent_from,
        bg_alpha,
        contrast_fg: color::contrast(fg, bg),
        contrast_muted: color::contrast(fg_muted, bg),
        contrast_accent: color::contrast(accent, bg),
        clusters: a
            .clusters
            .iter()
            .map(|c| ClusterBrief { hex: hex(c.color), share: c.share })
            .collect(),
    };

    Ok((t, report))
}

pub fn now_stamp() -> String {
    // 不引 chrono，用系统时间戳换算一个本地可读串
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86_400;
    let (y, m, d) = civil_from_days(days as i64);
    let rem = secs % 86_400;
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m, d, rem / 3600, (rem % 3600) / 60, rem % 60)
}

/// Howard Hinnant 的 civil_from_days：由「1970-01-01 起的天数」反推年月日
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as i64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// ---------------------------------------------------------------- 主题库

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeRef {
    pub id: String,
    pub name: String,
    pub mode: String,
    pub source: String,
    pub created: String,
    pub builtin: bool,
}

// Lock order is THEMES_WRITE -> SETTINGS_WRITE -> JSON_WRITE; never the reverse.
static THEMES_WRITE: Mutex<()> = Mutex::new(());
const PRESETS: [(&str, &str); 5] = [
    ("builtin-starport-paper", include_str!("../themes/starport-paper.json")),
    ("builtin-deep-ocean", include_str!("../themes/deep-ocean.json")),
    ("builtin-mocha", include_str!("../themes/mocha.json")),
    ("builtin-nord", include_str!("../themes/nord.json")),
    ("builtin-rose-dawn", include_str!("../themes/rose-dawn.json")),
];

fn builtin_id(id: &str) -> bool { id.eq_ignore_ascii_case("default") || id.to_ascii_lowercase().starts_with("builtin-") }

fn checked_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 180 || id.chars().any(|c| !(c.is_alphanumeric() || c == '-' || c == '_')) {
        return Err("主题 ID 只能包含字母、数字、- 和 _".into());
    }
    // Windows device names are invalid even with a .json extension.
    let upper = id.to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"].contains(&upper.as_str()) {
        return Err("主题 ID 是系统保留名称".into());
    }
    Ok(())
}

fn check_root(root: &Path) -> Result<(), String> {
    // Includes every existing ancestor: do not permit a redirected Kal/themes path.
    for path in root.ancestors() { store::reject_link(path)?; }
    Ok(())
}

fn theme_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    checked_id(id)?;
    check_root(root)?;
    let path = root.join("themes").join(format!("{id}.json"));
    store::reject_link(&root.join("themes"))?;
    store::reject_link(&path)?;
    Ok(path)
}

fn reference(t: &Theme, builtin: bool) -> ThemeRef {
    ThemeRef { id: t.id.clone(), name: t.name.clone(), mode: t.mode.clone(), source: t.source.clone(), created: t.created.clone(), builtin }
}

fn preset(id: &str) -> Option<Theme> {
    if id == "default" { return Some(Theme::default()); }
    PRESETS.iter().find(|(key, _)| *key == id).and_then(|(_, json)| serde_json::from_str(json).ok())
}

pub fn list() -> Vec<ThemeRef> { list_at(&store::app_dir()) }

fn list_at(root: &Path) -> Vec<ThemeRef> {
    let dir = root.join("themes");
    let mut out = PRESETS.iter().filter_map(|(id, _)| preset(id).map(|t| reference(&t, true))).collect::<Vec<_>>();
    if check_root(&dir).is_err() { return out; }
    let mut user = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let Some(id) = p.file_stem().and_then(|s| s.to_str()) else { continue };
            if builtin_id(id) { continue; }
            if let Ok(t) = load_at(root, id) { user.push(reference(&t, false)); }
        }
    }
    user.sort_by(|a, b| b.created.cmp(&a.created));
    out.extend(user);
    out
}

pub fn save(t: &Theme) -> Result<String, String> {
    let _guard = THEMES_WRITE.lock().map_err(|_| "主题暂时无法保存")?;
    save_at(&store::app_dir(), t)
}

fn save_at(root: &Path, t: &Theme) -> Result<String, String> {
    let mut t = t.clone();
    if t.id.is_empty() { t.id = format!("user-{}", store::unique_suffix()); }
    if builtin_id(&t.id) { return Err("内置主题只读，请复制并另存为我的主题".into()); }
    validate(&t, root)?;
    if t.created.is_empty() { t.created = now_stamp(); }
    t.source = "manual".into();
    let p = theme_path(root, &t.id)?;
    let v = serde_json::to_value(&t).map_err(|e| e.to_string())?;
    store::write_new_json(&p, &v)?;
    Ok(t.id)
}

pub fn load(id: &str) -> Result<Theme, String> {
    load_at(&store::app_dir(), id)
}

fn load_at(root: &Path, id: &str) -> Result<Theme, String> {
    checked_id(id)?;
    if let Some(t) = preset(id) { return Ok(t); }
    if builtin_id(id) { return Err("未知的内置主题 ID".into()); }
    let p = theme_path(root, id)?;
    let v = store::read_json(&p).ok_or_else(|| format!("主题不存在: {id}"))?;
    let t = parse(v, root)?;
    if t.id != id { return Err("主题文件名与 ID 不匹配".into()); }
    Ok(t)
}

pub fn delete(id: &str) -> Result<(), String> {
    let _guard = THEMES_WRITE.lock().map_err(|_| "主题暂时无法删除")?;
    delete_at(&store::app_dir(), id)
}

fn delete_at(root: &Path, id: &str) -> Result<(), String> {
    if builtin_id(id) { return Err("内置主题不能删除".into()); }
    let p = theme_path(root, id)?;
    // Do not leave an active pointer referring to a deleted theme.
    if store::read_json(&root.join("settings.json")).and_then(|s| s.get("activeTheme").and_then(|v| v.as_str()).map(str::to_owned)).as_deref() == Some(id) {
        return Err("请先切换到其他主题，再删除当前主题".into());
    }
    if p.is_file() {
        std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn activate(id: &str) -> Result<(), String> {
    let _guard = THEMES_WRITE.lock().map_err(|_| "主题暂时无法启用")?;
    load(id)?;
    store::merge_settings(&serde_json::json!({ "activeTheme": id }))?;
    Ok(())
}

pub fn settings_patch(patch: &serde_json::Value) -> Result<serde_json::Value, String> {
    let _guard = THEMES_WRITE.lock().map_err(|_| "主题设置暂时无法保存")?;
    if let Some(id) = patch.get("activeTheme") {
        let id = id.as_str().ok_or("activeTheme 必须是主题 ID")?;
        load(id)?;
    }
    store::merge_settings(patch)
}

/// Save as a new user version; activeTheme is the application-level commit point.
/// The new unactivated file is retained on settings failure; no user file is removed.
pub fn commit(t: &Theme) -> Result<Theme, String> {
    let _guard = THEMES_WRITE.lock().map_err(|_| "主题暂时无法提交")?;
    commit_at(&store::app_dir(), t)
}

fn commit_at(root: &Path, t: &Theme) -> Result<Theme, String> {
    commit_at_with(root, t, store::merge_settings_at)
}

fn commit_at_with(root: &Path, t: &Theme, update_settings: impl FnOnce(&PathBuf, &serde_json::Value) -> Result<serde_json::Value, String>) -> Result<Theme, String> {
    validate(t, root)?; // Check the caller's schema/ID before allocating a new identity.
    let mut saved = t.clone();
    saved.id = format!("user-{}", store::unique_suffix());
    saved.source = "manual".into();
    saved.created = now_stamp();
    save_at(root, &saved)?;
    update_settings(&root.join("settings.json"), &serde_json::json!({"activeTheme": saved.id}))
        .map_err(|e| format!("主题 {} 已保存但未启用，旧活动主题保留: {e}", saved.id))?;
    Ok(saved)
}

pub fn parse(mut v: serde_json::Value, root: &Path) -> Result<Theme, String> {
    if let Some(schema) = v.get("schema") {
        if schema.as_str() != Some(SCHEMA) { return Err("不支持的主题 schema；只支持 kal.theme/1，未自动转换".into()); }
    }
    // Match ui/src/theme.js normalizeTheme before serde defaults erase missing roles.
    // Preserve explicit semantic colors; an absent color object still uses Colors::default.
    if let Some(colors) = v.get_mut("color").and_then(serde_json::Value::as_object_mut) {
        let fallbacks: [(&str, &[&str]); 6] = [
            ("danger", &["fgHoliday", "fg"]),
            ("dangerFg", &["bg"]),
            ("focus", &["accent"]),
            ("done", &["fgMuted", "fg"]),
            ("selectedBg", &["todayBg", "surface"]),
            ("selectedFg", &["fg"]),
        ];
        for (role, sources) in fallbacks {
            if colors.contains_key(role) { continue; }
            if let Some(value) = sources.iter().find_map(|key| {
                colors.get(*key).filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
            }).cloned() {
                colors.insert(role.into(), value);
            }
        }
    }
    let t: Theme = serde_json::from_value(v).map_err(|e| format!("不是合法的 Kal 主题: {e}"))?;
    validate(&t, root)?;
    Ok(t)
}

fn range(value: f32, min: f32, max: f32, name: &str) -> Result<(), String> {
    if !value.is_finite() || value < min || value > max { return Err(format!("{name} 必须在 {min}–{max} 之间")); }
    Ok(())
}

fn validate_font(stack: &str, root: &Path) -> Result<(), String> {
    if stack.is_empty() || stack.len() > 4096 || stack.chars().any(|c| c.is_control() || "\\/;:{}()<>@=".contains(c)) {
        return Err("字体族必须是安全的字体名称列表，不能包含路径或 CSS 表达式".into());
    }
    for family in stack.split(',').map(|f| f.trim().trim_matches(['\"', '\''])) {
        if family.is_empty() { return Err("字体族列表包含空项".into()); }
        if let Some(hex) = family.strip_prefix("Kal-local-") {
            if hex.is_empty() || hex.len() > 2048 || hex.len() % 2 != 0 || !hex.bytes().all(|c| c.is_ascii_hexdigit()) { return Err("私有字体引用无效".into()); }
            let bytes = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i+2], 16)).collect::<Result<Vec<_>, _>>().map_err(|_| "私有字体引用无效")?;
            let filename = String::from_utf8(bytes).map_err(|_| "私有字体引用无效")?;
            if filename.contains(['/', '\\', ':']) || filename == "." || filename == ".." { return Err("私有字体不能引用目录路径".into()); }
            let folder = root.join("fonts");
            check_root(&folder)?;
            let path = folder.join(&filename);
            store::reject_link(&path)?;
            let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
            let meta = std::fs::metadata(&path).map_err(|_| "主题引用的私有字体不存在，请重新选择字体")?;
            if !["ttf", "otf", "woff", "woff2"].contains(&ext.as_str()) || !meta.is_file() || meta.len() == 0 || meta.len() > crate::fonts::MAX_FONT_BYTES { return Err("主题引用的私有字体无效或超限".into()); }
        }
    }
    Ok(())
}

fn validate(t: &Theme, root: &Path) -> Result<(), String> {
    if t.schema != SCHEMA { return Err("不支持的主题 schema；只支持 kal.theme/1".into()); }
    if !t.id.is_empty() { checked_id(&t.id)?; }
    if t.name.trim().is_empty() || t.name.len() > 512 || t.name.chars().any(char::is_control) { return Err("主题名称不能为空或包含控制字符，最长 512 字节".into()); }
    if !["light", "dark"].contains(&t.mode.as_str()) || !["manual", "wallpaper", "preset"].contains(&t.source.as_str()) || !["auto", "fixed"].contains(&t.scale_mode.as_str()) { return Err("主题模式、来源或缩放模式无效".into()); }
    // Wallpaper is metadata only; it is never joined/read during theme commit/import.
    if t.wallpaper.len() > 32768 || t.wallpaper.chars().any(char::is_control) { return Err("壁纸路径元数据无效".into()); }
    let colors = serde_json::to_value(&t.color).map_err(|e| e.to_string())?;
    for (key, value) in colors.as_object().ok_or("主题颜色无效")? {
        if let Some(hex) = value.as_str() {
            if hex.len() != 7 || !hex.starts_with('#') || !hex[1..].bytes().all(|b| b.is_ascii_hexdigit()) { return Err(format!("颜色 {key} 必须为 #RRGGBB")); }
        } else if let Some(n) = value.as_f64() { range(n as f32, 0.0, 1.0, key)?; }
        else { return Err(format!("颜色字段 {key} 无效")); }
    }
    validate_font(&t.typography.family_ui, root)?;
    validate_font(&t.typography.family_num, root)?;
    range(t.scale, 0.5, 2.5, "scale")?;
    range(t.typography.stretch, 50.0, 200.0, "type.stretch")?;
    let sizes = &t.typography.size;
    for n in [sizes.day, sizes.sub, sizes.task, sizes.title, sizes.head, sizes.agenda] { range(n, 6.0, 96.0, "字号")?; }
    let weights = &t.typography.weight;
    for n in [weights.day, weights.title, weights.task] { if !(100..=900).contains(&n) { return Err("字重必须在 100–900 之间".into()); } }
    for n in [t.typography.line_height.tight, t.typography.line_height.normal] { range(n, 0.8, 3.0, "行高")?; }
    for n in [t.typography.letter_spacing.title, t.typography.letter_spacing.head] { range(n, -0.2, 1.0, "字间距")?; }
    if !["left", "center"].contains(&t.typography.cell_align.as_str()) || !["side", "hidden"].contains(&t.layout.agenda.as_str()) { return Err("文字对齐或日程栏模式无效".into()); }
    for n in [t.shape.radius, t.shape.radius_cell] { range(n, 0.0, 80.0, "圆角")?; }
    range(t.shape.blur, 0.0, 80.0, "模糊")?;
    range(t.shape.shadow_strength, 0.0, 1.0, "阴影")?;
    range(t.shape.border_width, 0.0, 8.0, "边框")?;
    range(t.shape.cell_alpha, 0.0, 1.0, "日格透明度")?;
    range(t.shape.text_shadow, 0.0, 1.0, "文字阴影")?;
    if !["cards", "grid", "minimal"].contains(&t.shape.grid_style.as_str()) {
        return Err("网格风格无效".into());
    }
    if !["none", "desktop", "custom", "art"].contains(&t.backdrop.mode.as_str()) {
        return Err("背景壁纸模式无效".into());
    }
    if !["aurora", "ink-paper", "sunset-glow", "cyber-grid", "forest-mist", "warm-grain"].contains(&t.backdrop.preset.as_str()) {
        return Err("内置艺术壁纸预设无效".into());
    }
    if !["cover", "contain", "center"].contains(&t.backdrop.fit.as_str()) {
        return Err("壁纸填充方式无效".into());
    }
    range(t.backdrop.opacity, 0.0, 1.0, "壁纸透明度")?;
    range(t.backdrop.blur, 0.0, 60.0, "壁纸模糊度")?;
    range(t.backdrop.brightness, 0.2, 2.0, "壁纸明度")?;
    range(t.backdrop.saturate, 0.0, 3.0, "壁纸饱和度")?;
    range(t.backdrop.vignette, 0.0, 1.0, "壁纸暗角")?;
    for n in [t.layout.pad, t.layout.pad_sm, t.layout.gap, t.layout.cell_gap] { range(n, 0.0, 80.0, "间距")?; }
    range(t.layout.agenda_width, 120.0, 800.0, "日程栏宽度")?;
    if t.layout.week_start > 1 || t.layout.max_tasks > 20 { return Err("周起始或任务行数超限".into()); }
    if !["wrap", "clamp2", "nowrap"].contains(&t.layout.task_wrap.as_str()) {
        return Err("任务换行模式无效".into());
    }
    if !["dot", "number", "none"].contains(&t.layout.bullet_style.as_str()) {
        return Err("项目符号样式无效".into());
    }
    Ok(())
}

pub fn import(path: &str) -> Result<String, String> {
    let root = store::app_dir();
    let v = store::read_json(&PathBuf::from(path)).ok_or("无法读取合法的主题 JSON")?;
    let mut t = parse(v, &root)?;
    t.id = String::new();
    t.source = "manual".into();
    t.created = now_stamp();
    save(&t)
}

pub fn export_draft(t: &Theme, path: &str) -> Result<String, String> {
    export_at(&store::app_dir(), t, &PathBuf::from(path))
}

fn export_at(root: &Path, t: &Theme, path: &PathBuf) -> Result<String, String> {
    validate(t, root)?;
    if !path.is_absolute() || path.extension().and_then(|e| e.to_str()).map(|s| s.eq_ignore_ascii_case("json")) != Some(true) { return Err("导出位置必须是绝对 .json 文件路径".into()); }
    let parent = path.parent().ok_or("导出目录无效")?;
    check_root(parent)?;
    // Canonical parent blocks '..', aliases and links from reaching Kal's data.
    let dest_parent = parent.canonicalize().map_err(|_| "请先创建导出目录")?;
    let canonical_root = if root.exists() { root.canonicalize().map_err(|e| e.to_string())? } else {
        let base = root.parent().ok_or("应用目录无效")?.canonicalize().map_err(|e| e.to_string())?;
        base.join(root.file_name().ok_or("应用目录无效")?)
    };
    if dest_parent.starts_with(&canonical_root) { return Err("不能导出到 Kal 配置、主题或字体目录，请选择外部目录".into()); }
    // Explicit export is also non-overwriting; preserve any existing file.
    store::write_new_json(path, &serde_json::to_value(t).map_err(|e| e.to_string())?)?;
    Ok(path.display().to_string())
}

#[cfg(test)]
#[path = "theme_tests.rs"]
mod tests;

/// 当前生效主题：settings 里有就用它，否则用内置默认
pub fn active() -> Theme {
    let s = store::read_settings();
    if let Some(id) = s.get("activeTheme").and_then(|x| x.as_str()) {
        if !id.is_empty() {
            if let Ok(t) = load(id) {
                return t;
            }
        }
    }
    Theme::default()
}
