//! Kal 桌历 —— Tauri 外壳
//!
//! 分层：
//!   color / palette / theme   —— 色彩与主题（渲染器无关的纯数据）
//!   display                   —— 物理尺寸感知缩放
//!   wallpaper / store / fonts —— Windows 环境与本地存储
//!   embed                     —— 桌面层嵌入
//!   db                        —— 只读读取 DesktopCal 数据

mod color;
mod db;
mod display;
mod desktop;
mod embed;
mod editing;
mod fonts;
mod model;
mod mcp;
mod palette;
mod selftest;
pub mod single_instance;
mod store;
mod theme;
mod wallpaper;

use model::{AppInfo, DayItem};
use std::sync::Mutex;
use std::time::Instant;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, State, WebviewWindow};

/// 全局状态：当前嵌入模式与上次桌面扫描结果
struct ShellState {
    embed_mode: Mutex<String>,
    desk_desc: Mutex<String>,
    summoned: Mutex<bool>,
    previous_foreground: Mutex<embed::Hwnd>,
}

fn hwnd_of(window: &tauri::WebviewWindow) -> embed::Hwnd {
    match window.hwnd() {
        Ok(h) => h.0 as isize,
        Err(_) => 0,
    }
}

// ---------------------------------------------------------------- 基础

#[tauri::command]
fn app_info(window: tauri::WebviewWindow, state: State<'_, ShellState>) -> AppInfo {
    let hwnd = hwnd_of(&window);
    let dsp = display::for_window(hwnd);
    let th = theme::active();
    let wp = wallpaper::locate();

    let ui_scale = if th.scale_mode == "fixed" {
        th.scale as f64
    } else {
        dsp.kal_scale as f64 * th.scale as f64
    };

    let (db_path, db_found) = match db::CalendarDb::locate() {
        Some(p) => (p.display().to_string(), true),
        None => (String::new(), false),
    };

    AppInfo {
        name: "Kal".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        source_label: if db_found { "DesktopCal".into() } else { "未找到数据库".into() },
        db_path,
        db_found,
        embed_mode: state.embed_mode.lock().unwrap().clone(),
        ui_scale,
        dpi: dsp.dpi,
        desk: state.desk_desc.lock().unwrap().clone(),
        display: dsp,
        theme_id: th.id.clone(),
        theme_name: th.name.clone(),
        wallpaper: wp.path,
        app_dir: store::app_dir().display().to_string(),
    }
}

#[tauri::command]
fn display_info(window: tauri::WebviewWindow) -> display::DisplayInfo {
    display::for_window(hwnd_of(&window))
}

#[tauri::command]
async fn month_events(year: i32, month: u32) -> Result<Vec<DayItem>, String> {
    tauri::async_runtime::spawn_blocking(move || db::open_default()?.month_items(year, month))
        .await.map_err(|_| "月份日程读取未能完成".to_string())?
}

#[tauri::command]
async fn day_events(date: String) -> Result<Vec<DayItem>, String> {
    tauri::async_runtime::spawn_blocking(move || db::open_default()?.day_items(&date))
        .await.map_err(|_| "当日日程读取未能完成".to_string())?
}

#[tauri::command]
async fn range_events(start: String, end: String) -> Result<Vec<DayItem>, String> {
    tauri::async_runtime::spawn_blocking(move || db::open_default()?.range_items(&start, &end))
        .await.map_err(|_| "日期范围日程读取未能完成".to_string())?
}

async fn edit_worker<F>(action: F) -> Result<serde_json::Value, String>
where F: FnOnce() -> Result<serde_json::Value, String> + Send + 'static {
    tauri::async_runtime::spawn_blocking(action).await.map_err(|_| "日历操作未能完成".to_string())?
}

#[tauri::command]
async fn calendar_write_status() -> Result<serde_json::Value, String> {
    edit_worker(|| Ok(editing::status())).await
}

#[tauri::command]
async fn item_create(date: String, title: String, time: String) -> Result<serde_json::Value, String> {
    edit_worker(move || editing::create(date, title, time)).await
}

#[tauri::command]
async fn item_update(id: String, date: String, title: String, expected: Option<DayItem>) -> Result<serde_json::Value, String> {
    edit_worker(move || editing::update(id, date, title, expected)).await
}

#[tauri::command]
async fn item_toggle_done(id: String, date: String, done: bool, expected: Option<DayItem>) -> Result<serde_json::Value, String> {
    edit_worker(move || editing::toggle(id, date, done, expected)).await
}

#[tauri::command]
async fn item_delete(id: String, date: String, expected: Option<DayItem>) -> Result<serde_json::Value, String> {
    edit_worker(move || editing::delete(id, date, expected)).await
}

#[tauri::command]
async fn item_confirm(pending_id: String, accept: bool) -> Result<serde_json::Value, String> {
    edit_worker(move || editing::confirm(pending_id, accept)).await
}

#[tauri::command]
async fn item_move(id: String, from_date: String, to_date: String, expected: Option<DayItem>) -> Result<serde_json::Value, String> {
    edit_worker(move || editing::move_item(id, from_date, to_date, expected)).await
}

#[tauri::command]
async fn calendar_import_items(items: Vec<editing::ImportEntry>) -> Result<serde_json::Value, String> {
    edit_worker(move || editing::import_items(items)).await
}

#[tauri::command]
async fn note_save(id: Option<String>, title: String, content: String) -> Result<db::NoteSummary, String> {
    tauri::async_runtime::spawn_blocking(move || editing::note_save(id, title, content))
        .await.map_err(|_| "保存便签未能完成".to_string())?
}

#[tauri::command]
async fn note_delete(id: String) -> Result<serde_json::Value, String> {
    edit_worker(move || editing::note_delete(id)).await
}

#[tauri::command]
async fn search_events(query: String) -> Result<Vec<DayItem>, String> {
    tauri::async_runtime::spawn_blocking(move || db::open_default()?.search_items(&query))
        .await.map_err(|_| "搜索未能完成".to_string())?
}

#[tauri::command]
async fn notes_list(offset: Option<u32>) -> Result<db::NotePage, String> {
    tauri::async_runtime::spawn_blocking(move || db::open_default()?.notes_page(offset.unwrap_or(0)))
        .await.map_err(|_| "便签列表读取未能完成".to_string())?
}

#[tauri::command]
async fn note_get(id: String) -> Result<db::NoteDocument, String> {
    tauri::async_runtime::spawn_blocking(move || db::open_default()?.note_document(&id))
        .await.map_err(|_| "便签正文读取未能完成".to_string())?
}

#[tauri::command]
fn db_doctor() -> Result<String, String> {
    Ok(db::open_default()?.doctor())
}

// ---------------------------------------------------------------- 主题

#[tauri::command]
fn wallpaper_info() -> wallpaper::WallpaperInfo {
    wallpaper::locate()
}

#[tauri::command]
async fn wallpaper_read_image(path: Option<String>) -> Result<wallpaper::WallpaperImageData, String> {
    tauri::async_runtime::spawn_blocking(move || wallpaper::read_image_data(path.as_deref()))
        .await.map_err(|_| "壁纸图片读取未能完成".to_string())?
}


#[tauri::command]
fn theme_active() -> theme::Theme {
    theme::active()
}

#[tauri::command]
fn theme_list() -> Vec<theme::ThemeRef> {
    theme::list()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GenResult {
    theme: theme::Theme,
    report: theme::GenReport,
}

/// 把「窗口矩形 + 所在显示器 + 壁纸尺寸」换算成壁纸图内的归一化矩形
fn window_region(win: &WebviewWindow) -> Option<(f32, f32, f32, f32)> {
    let hwnd = hwnd_of(win);
    let pos = win.outer_position().ok()?;
    let size = win.outer_size().ok()?;
    let dsp = display::for_window(hwnd);
    if !dsp.ppi_known && dsp.rect == [0, 0, 0, 0] {
        return None;
    }
    let wp = wallpaper::locate();
    let (ww, wh) = image::image_dimensions(&wp.path).ok()?;
    palette::map_window_to_wallpaper(
        (pos.x, pos.y, size.width, size.height),
        dsp.rect,
        (ww, wh),
    )
}

/// 由壁纸生成主题 —— 只生成不落盘，让前端先预览
#[tauri::command]
fn theme_generate(window: tauri::WebviewWindow, opts: theme::GenOpts) -> Result<GenResult, String> {
    let mut opts = opts;
    if opts.region_from_window && opts.region.is_none() {
        opts.region = window_region(&window);
    }
    let (t, r) = theme::generate(&opts)?;
    Ok(GenResult { theme: t, report: r })
}

/// 从指定图片生成（用户可以挑一张，不必是当前壁纸）
#[tauri::command]
fn theme_generate_from(path: String, opts: theme::GenOpts) -> Result<GenResult, String> {
    let (t, r) = theme::generate_from_path(&path, "file", &opts)?;
    Ok(GenResult { theme: t, report: r })
}

#[tauri::command]
fn theme_save(theme: theme::Theme) -> Result<String, String> {
    theme::save(&theme)
}

#[tauri::command]
fn theme_commit(theme: theme::Theme) -> Result<theme::Theme, String> {
    theme::commit(&theme)
}

#[tauri::command]
fn theme_export_draft(theme: theme::Theme, path: String) -> Result<String, String> {
    theme::export_draft(&theme, &path)
}

#[tauri::command]
fn theme_load(id: String) -> Result<theme::Theme, String> {
    theme::load(&id)
}

#[tauri::command]
fn theme_delete(id: String) -> Result<(), String> {
    theme::delete(&id)
}

#[tauri::command]
fn theme_activate(id: String) -> Result<(), String> {
    theme::activate(&id)
}

/// 导出：把主题 JSON 写到任意路径（分享/备份）
#[tauri::command]
fn theme_export(id: String, path: String) -> Result<String, String> {
    let t = theme::load(&id)?;
    theme::export_draft(&t, &path)
}

/// 导入：读一份主题 JSON，另存为一份新主题（不覆盖同名）
#[tauri::command]
fn theme_import(path: String) -> Result<String, String> {
    theme::import(&path)
}

#[tauri::command]
fn fonts_list() -> Vec<String> {
    fonts::list_families()
}

#[tauri::command]
async fn local_fonts_list() -> Result<fonts::LocalFontList, String> {
    tauri::async_runtime::spawn_blocking(fonts::list_local)
        .await.map_err(|_| "字体目录读取未能完成".to_string())?
}

#[tauri::command]
async fn local_font_read(id: String) -> Result<fonts::LocalFontData, String> {
    tauri::async_runtime::spawn_blocking(move || fonts::read_local(&id))
        .await.map_err(|_| "字体读取未能完成".to_string())?
}

#[tauri::command]
async fn local_font_import(path: String) -> Result<fonts::LocalFont, String> {
    tauri::async_runtime::spawn_blocking(move || fonts::import_local(&path))
        .await.map_err(|_| "字体导入未能完成".to_string())?
}


// ---------------------------------------------------------------- 设置

#[tauri::command]
fn settings_get() -> serde_json::Value {
    store::read_settings()
}

#[tauri::command]
fn settings_set(patch: serde_json::Value) -> Result<serde_json::Value, String> {
    theme::settings_patch(&patch)
}

fn check_safe_export_dest(path_str: &str, allowed_exts: &[&str]) -> Result<std::path::PathBuf, String> {
    let path = std::path::PathBuf::from(path_str);
    if !path.is_absolute() {
        return Err("导出路径必须是绝对路径".into());
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    if !allowed_exts.iter().any(|allowed| *allowed == ext) {
        return Err(format!("不支持的导出文件后缀 .{ext}"));
    }
    let parent = path.parent().ok_or("导出目录无效")?;
    for anc in parent.ancestors() {
        store::reject_link(anc)?;
    }
    store::reject_link(&path)?;
    let dest_parent = parent.canonicalize().map_err(|_| "导出目标文件夹不存在")?;
    let app_root = store::app_dir();
    if let Ok(canon_app) = app_root.canonicalize() {
        if dest_parent.starts_with(&canon_app) {
            return Err("不能导出到 Kal 内部配置目录，请选择桌面或文档等外部文件夹".into());
        }
    }
    Ok(path)
}

#[tauri::command]
async fn calendar_export_text(path: String, content: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dest = check_safe_export_dest(&path, &["md", "ics", "html"])?;
        std::fs::write(&dest, content.as_bytes()).map_err(|e| format!("写入导出文件失败: {e}"))?;
        Ok(dest.display().to_string())
    })
    .await
    .map_err(|_| "导出任务未能完成".to_string())?
}

#[tauri::command]
async fn calendar_read_text_file(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pb = std::path::PathBuf::from(&path);
        let ext = pb
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        if ext != "ics" && ext != "json" && ext != "md" {
            return Err("仅支持读取 .ics 日历文件".into());
        }
        store::reject_link(&pb)?;
        let meta = std::fs::metadata(&pb).map_err(|e| format!("无法读取文件信息: {e}"))?;
        if meta.len() > 4 * 1024 * 1024 {
            return Err("日历文件过大（超过 4 MB）".into());
        }
        std::fs::read_to_string(&pb).map_err(|e| format!("读取文件失败: {e}"))
    })
    .await
    .map_err(|_| "读取文件任务未能完成".to_string())?
}

#[tauri::command]
async fn calendar_export_pdf(path: String, html: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dest = check_safe_export_dest(&path, &["pdf"])?;
        let edge_candidates = [
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        ];
        let edge_bin = edge_candidates
            .iter()
            .map(std::path::Path::new)
            .find(|p| p.is_file())
            .ok_or_else(|| "未找到 Microsoft Edge 浏览器组件，请使用「打印预览」导出 PDF".to_string())?;

        let suffix = store::unique_suffix();
        let tmp_html = std::env::temp_dir().join(format!("kal-print-{suffix}.html"));
        let tmp_profile = std::env::temp_dir().join(format!("kal-edge-profile-{suffix}"));
        std::fs::write(&tmp_html, html.as_bytes()).map_err(|e| format!("无法创建打印临时文件: {e}"))?;
        let _ = std::fs::create_dir_all(&tmp_profile);

        let mut cmd = std::process::Command::new(edge_bin);
        cmd.arg("--headless=new")
            .arg("--disable-gpu")
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .arg("--no-pdf-header-footer")
            .arg(format!("--user-data-dir={}", tmp_profile.display()))
            .arg(format!("--print-to-pdf={}", dest.display()))
            .arg(&tmp_html);

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }

        let status = cmd.status();
        let _ = std::fs::remove_file(&tmp_html);
        let _ = std::fs::remove_dir_all(&tmp_profile);
        match status {
            Ok(s) if s.success() && dest.is_file() => Ok(dest.display().to_string()),
            Ok(s) => Err(format!("PDF 渲染进程退出异常 (code={:?})", s.code())),
            Err(e) => Err(format!("启动 PDF 渲染引擎失败: {e}")),
        }
    })
    .await
    .map_err(|_| "PDF 导出任务未能完成".to_string())?
}

// ---------------------------------------------------------------- 桌面嵌入

#[tauri::command]
fn desktop_status(state: State<'_, desktop::Controller>) -> desktop::Status {
    state.status()
}

#[tauri::command]
fn desktop_set_hotkey(enabled: bool, state: State<'_, desktop::Controller>) -> desktop::Status {
    state.set_enabled(enabled)
}

fn dismiss_window(window: &WebviewWindow) {
    let state = window.state::<ShellState>();
    *state.summoned.lock().unwrap() = false;
    let hwnd = hwnd_of(window);
    embed::clear_topmost(hwnd);
    let previous = *state.previous_foreground.lock().unwrap();
    embed::return_focus(hwnd, previous);
    let wallpaper = *state.embed_mode.lock().unwrap() == "wallpaper";
    if wallpaper {
        match embed::apply_wallpaper(hwnd) {
            Ok(scan) => { *state.desk_desc.lock().unwrap() = embed::describe(&scan); return; }
            Err(error) => {
                eprintln!("[kal] 壁纸模式恢复失败，回退 anchored：{error}");
                *state.embed_mode.lock().unwrap() = "anchored".into();
                embed::detach(hwnd);
            }
        }
    }
    let _ = embed::apply_anchored(hwnd);
    let _ = embed::set_desktop_owner(hwnd);
}

fn summon_window(window: &WebviewWindow, toggle: bool) {
    let state = window.state::<ShellState>();
    if toggle && *state.summoned.lock().unwrap() {
        dismiss_window(window);
        return;
    }
    if !*state.summoned.lock().unwrap() {
        *state.previous_foreground.lock().unwrap() = embed::foreground_window();
    }
    // Set the flag first: activation can synchronously generate window events.
    *state.summoned.lock().unwrap() = true;
    if let Err(error) = embed::summon(hwnd_of(window)) {
        *state.summoned.lock().unwrap() = false;
        eprintln!("[kal] 呼出失败：{error}");
        return;
    }
    let _ = window.show();
    let _ = window.set_focus();
}

#[tauri::command]
fn attach_desktop(window: tauri::WebviewWindow) -> Result<String, String> {
    *window.state::<ShellState>().embed_mode.lock().unwrap() = "anchored".into();
    embed::detach(hwnd_of(&window));
    dismiss_window(&window);
    let hwnd = hwnd_of(&window);
    let owner = embed::set_desktop_owner(hwnd)?;
    Ok(format!("已挂到桌面层（owner=0x{owner:X}）"))
}

#[tauri::command]
fn desk_report() -> String {
    embed::describe(&embed::scan_desktop())
}

#[tauri::command]
fn set_embed_mode(
    mode: String,
    window: tauri::WebviewWindow,
    state: State<'_, ShellState>,
) -> Result<String, String> {
    let hwnd = hwnd_of(&window);
    if hwnd == 0 {
        return Err("无法获取窗口句柄".into());
    }
    if mode != "anchored" && mode != "wallpaper" {
        return Err("嵌入模式只支持 anchored 或 wallpaper".into());
    }
    *state.summoned.lock().unwrap() = false;
    embed::clear_topmost(hwnd);
    let msg = match mode.as_str() {
        "wallpaper" => match embed::apply_wallpaper(hwnd) {
            Ok(scan) => {
                *state.desk_desc.lock().unwrap() = embed::describe(&scan);
                "已切到壁纸层真嵌入（仅展示）".to_string()
            }
            Err(e) => {
                embed::detach(hwnd);
                let _ = embed::apply_anchored(hwnd);
                let _ = embed::set_desktop_owner(hwnd);
                *state.embed_mode.lock().unwrap() = "anchored".into();
                return Err(format!("壁纸嵌入失败，已回退 anchored：{e}"));
            }
        },
        _ => {
            embed::detach(hwnd);
            embed::apply_anchored(hwnd)?;
            embed::set_desktop_owner(hwnd)?;
            "已切到桌面挂件式（可完全交互）".to_string()
        }
    };
    *state.embed_mode.lock().unwrap() = mode;
    Ok(msg)
}

#[tauri::command]
fn hit_test_self(window: tauri::WebviewWindow) -> Result<String, String> {
    let hwnd = hwnd_of(&window);
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let x = pos.x + (size.width as i32) / 2;
    let y = pos.y + (size.height as i32) / 2;
    let (hit, cls) = embed::hit_test(x, y);
    Ok(format!(
        "self=0x{hwnd:X}  取样点=({x},{y})  命中=0x{hit:X} [{cls}]  {}\n健康={}",
        if hit == hwnd { "OK 可交互" } else { "被其他窗口遮挡" },
        embed::health(hwnd)
    ))
}

// ---------------------------------------------------------------- 窗口几何

static LAST_GEO_SAVE: Mutex<Option<Instant>> = Mutex::new(None);

fn save_geometry(win: &WebviewWindow) {
    let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else {
        return;
    };
    let _ = store::merge_settings(&serde_json::json!({
        "window": {
            "x": pos.x, "y": pos.y,
            "w": size.width, "h": size.height,
        }
    }));
}

fn save_geometry_throttled(win: &WebviewWindow) {
    {
        let mut g = match LAST_GEO_SAVE.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let now = Instant::now();
        if let Some(prev) = *g {
            if now.duration_since(prev).as_millis() < 600 {
                return;
            }
        }
        *g = Some(now);
    }
    save_geometry(win);
}

/// 恢复上次位置尺寸；位置若已不在任何显示器上则丢弃（防止换显示器后窗口跑到屏外）
fn restore_geometry(win: &WebviewWindow) {
    let s = store::read_settings();
    let Some(w) = s.get("window").and_then(|v| v.as_object()) else {
        return;
    };
    let g = |k: &str| w.get(k).and_then(|v| v.as_i64()).map(|v| v as i32);
    let (Some(x), Some(y), Some(cw), Some(ch)) = (g("x"), g("y"), g("w"), g("h")) else {
        return;
    };
    if cw < 320 || ch < 240 {
        return;
    }
    if !display::on_any_monitor(x + cw / 2, y + ch / 2) {
        println!("[kal] 上次位置 ({x},{y}) 不在任何显示器上，忽略");
        return;
    }
    let _ = win.set_size(tauri::PhysicalSize::new(cw as u32, ch as u32));
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
}

#[tauri::command]
fn window_geometry_save(window: tauri::WebviewWindow) {
    save_geometry(&window);
}

#[tauri::command]
fn window_set_click_through(enabled: bool, window: tauri::WebviewWindow) -> Result<bool, String> {
    let hwnd = hwnd_of(&window);
    embed::set_click_through(hwnd, enabled)?;
    Ok(enabled)
}

// ---------------------------------------------------------------- 托盘

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "显示 / 隐藏", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "个性化设置…", true, None::<&str>)?;
    let regen = MenuItem::with_id(app, "regen", "按当前壁纸重新生成主题", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let click_through_off = MenuItem::with_id(app, "click_through_off", "恢复鼠标交互（关闭穿透）", true, None::<&str>)?;
    let show_all = MenuItem::with_id(app, "show_all", "恢复窗口为普通窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出日历清单", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&toggle, &settings, &regen, &sep, &click_through_off, &show_all, &quit])?;

    let mut b = TrayIconBuilder::with_id("kal-tray")
        .tooltip("日历清单 · Calendar List")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "toggle" => {
                if let Some(w) = app.get_webview_window("main") {
                    if w.is_visible().unwrap_or(false) {
                        let _ = w.hide();
                    } else {
                        let _ = w.show();
                    }
                }
            }
            "settings" => {
                if let Some(w) = app.get_webview_window("main") {
                    summon_window(&w, false);
                }
                let _ = app.emit("kal://settings", ());
            }
            "regen" => {
                let _ = app.emit("kal://regen-theme", ());
            }
            "click_through_off" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = embed::set_click_through(hwnd_of(&w), false);
                }
                let _ = app.emit("kal://click-through", false);
            }
            "show_all" => {
                if let Some(w) = app.get_webview_window("main") {
                    *w.state::<ShellState>().embed_mode.lock().unwrap() = "anchored".into();
                    let _ = embed::set_click_through(hwnd_of(&w), false);
                    summon_window(&w, false);
                }
                let _ = app.emit("kal://click-through", false);
            }
            "quit" => {
                if let Some(w) = app.get_webview_window("main") {
                    save_geometry(&w);
                }
                app.exit(0);
            }
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone());
    }
    b.build(app)?;
    Ok(())
}

// ---------------------------------------------------------------- 入口

pub fn run() {
    let _ = store::ensure_dirs();
    let context = tauri::generate_context!();
    // 仅 debug 构建接受调试端口，无需临时改配置，也不会进入 release 成品。
    #[cfg(debug_assertions)]
    let context = {
        let mut context = context;
        if let Some(port) = std::env::var("KAL_DEBUG_PORT").ok().and_then(|v| v.parse::<u16>().ok()).filter(|p| *p >= 1024) {
            if let Some(window) = context.config_mut().app.windows.iter_mut().find(|w| w.label == "main") {
                window.additional_browser_args = Some(format!("--remote-debugging-address=127.0.0.1 --remote-debugging-port={port}"));
            }
        }
        context
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ShellState {
            embed_mode: Mutex::new("anchored".into()),
            desk_desc: Mutex::new(String::new()),
            summoned: Mutex::new(false),
            previous_foreground: Mutex::new(0),
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            display_info,
            month_events,
            day_events,
            range_events,
            calendar_write_status,
            item_create,
            item_update,
            item_toggle_done,
            item_delete,
            item_confirm,
            item_move,
            calendar_import_items,
            calendar_read_text_file,
            note_save,
            note_delete,
            search_events,
            notes_list,
            note_get,
            db_doctor,
            wallpaper_info,
            wallpaper_read_image,
            theme_active,
            theme_list,
            theme_generate,
            theme_generate_from,
            theme_save,
            theme_commit,
            theme_export_draft,
            theme_load,
            theme_delete,
            theme_activate,
            theme_export,
            theme_import,
            fonts_list,
            local_fonts_list,
            local_font_read,
            local_font_import,
            settings_get,
            settings_set,
            calendar_export_text,
            calendar_export_pdf,
            desktop_status,
            desktop_set_hotkey,
            window_geometry_save,
            window_set_click_through,
            desk_report,
            attach_desktop,
            set_embed_mode,
            hit_test_self
        ])
        .setup(|app| {
            let scan = embed::scan_desktop();
            if let Some(state) = app.try_state::<ShellState>() {
                *state.desk_desc.lock().unwrap() = embed::describe(&scan);
            }

            if let Some(win) = app.get_webview_window("main") {
                restore_geometry(&win);
                let hwnd = hwnd_of(&win);
                if let Err(e) = embed::apply_anchored(hwnd) {
                    eprintln!("[kal] anchored 模式应用失败: {e}");
                }
                match embed::set_desktop_owner(hwnd) {
                    Ok(owner) => println!("[kal] 已挂到桌面层 owner=0x{owner:X}"),
                    Err(e) => eprintln!("[kal] 挂桌面层失败: {e}"),
                }
                println!("[kal] 桌面结构: {}", embed::describe(&scan));
                let dsp = display::for_window(hwnd);
                println!("[kal] hwnd=0x{hwnd:X} {}", display::describe(&dsp));

                let w2 = win.clone();
                win.on_window_event(move |ev| {
                    if matches!(ev, tauri::WindowEvent::Focused(false)) {
                        // 用户结束编辑后恢复桌面底层，不影响其他应用的键盘焦点。
                        dismiss_window(&w2);
                    }
                    if matches!(
                        ev,
                        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
                    ) {
                        save_geometry_throttled(&w2);
                    }
                });
            }

            if let Err(e) = build_tray(app.handle()) {
                eprintln!("[kal] 托盘创建失败: {e}");
            }
            app.manage(desktop::Controller::new(app.handle().clone()));
            Ok(())
        })
        .build(context)
        .expect("Kal 启动失败")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(desktop) = app.try_state::<desktop::Controller>() { desktop.shutdown(); }
            }
        });
}

// ---------------------------------------------------------------- CLI

/// 命令行诊断：桌面结构 + 显示器 + 壁纸 + 数据库 + 主题库
pub fn doctor_cli() {
    println!("==== Kal 诊断 ====");
    println!("[桌面结构] {}", embed::describe(&embed::scan_desktop()));
    println!("[显示器] {}", display::describe(&display::for_window(0)));
    let w = wallpaper::locate();
    println!("[壁纸] source={} exists={} path={}", w.source, w.exists, w.path);
    let t = theme::active();
    println!("[主题] id={} name={} mode={} scale={}", t.id, t.name, t.mode, t.scale);
    println!("[主题库] {:?}", store::themes_dir());
    for r in theme::list() {
        println!("        {}  {}  [{}]  {}", r.id, r.name, r.mode, r.created);
    }
    println!("[设置] {:?}", store::settings_path());
    println!("[字体] 已装字体族 {} 个", fonts::list_families().len());
    match db::open_default() {
        Ok(d) => print!("{}", d.doctor()),
        Err(e) => println!("[数据库] {e}"),
    }
}

/// 命令行取色：`kal --palette [图片路径]`，不指定则用当前壁纸
pub fn palette_cli(path: Option<String>) {
    let opts = theme::GenOpts::default();
    let res = match path {
        Some(p) => theme::generate_from_path(&p, "cli", &opts),
        None => theme::generate(&opts),
    };
    match res {
        Ok((t, r)) => {
            println!("==== 取色报告 ====");
            println!("判定模式 : {}  (区域明度 {:.3} / 全图明度 {:.3} / 采样 {} px)",
                r.mode, r.region_l, r.ambient_l, r.sampled);
            println!("壁纸来源 : {}", r.wallpaper_source);
            println!("主导色   : {}", r.base);
            println!("强调色   : {}  (来源 {})", r.accent, r.accent_from);
            println!("面板不透明: {:.3}", r.bg_alpha);
            println!("对比度   : 正文 {:.2} / 次要 {:.2} / 强调 {:.2}",
                r.contrast_fg, r.contrast_muted, r.contrast_accent);
            println!("色簇占比 :");
            for c in &r.clusters {
                println!("   {}  {:>6.1}%", c.hex, c.share * 100.0);
            }
            println!("\n---- 生成的主题 JSON ----");
            println!("{}", serde_json::to_string_pretty(&t).unwrap_or_default());
        }
        Err(e) => println!("生成失败: {e}"),
    }
}

/// 命令行生成并保存主题：`kal --theme-save [名称] [--light|--dark]`
///
/// 给「快捷方式 / 计划任务 / 脚本」用：不必开界面也能按当前壁纸刷新主题。
pub fn theme_save_cli(name: Option<String>, mode: Option<String>) -> i32 {
    let opts = theme::GenOpts {
        name: name.clone(),
        mode,
        ..Default::default()
    };
    match theme::generate(&opts) {
        Ok((t, r)) => {
            let mut t = t;
            if t.id == "wallpaper" {
                // 多次生成时不要互相覆盖：带上时间戳后缀
                t.id = format!("wallpaper-{}", theme::now_stamp().replace([':', 'T', '-'], ""));
                t.name = name.unwrap_or_else(|| format!("壁纸 {}", t.created[5..16].replace('T', " ")));
            }
            match theme::save(&t) {
                Ok(id) => {
                    if let Err(e) = theme::activate(&id) {
                        eprintln!("主题已保存但激活失败: {e}");
                        return 1;
                    }
                    println!(
                        "已生成并启用主题：{} (id={id})  mode={} 强调色={} 正文对比度={:.1}",
                        t.name, r.mode, r.accent, r.contrast_fg
                    );
                    0
                }
                Err(e) => {
                    eprintln!("保存主题失败: {e}");
                    1
                }
            }
        }
        Err(e) => {
            eprintln!("生成主题失败: {e}");
            1
        }
    }
}

/// 命令行自检：`kal --selftest`
pub fn selftest_cli() -> i32 {
    selftest::run()
}
