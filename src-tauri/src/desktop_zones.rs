//! Static desktop zones: per-monitor wallpaper snapshots and reversible publication.
//! The calendar stays interactive in its existing window. No desktop item is moved.

use std::collections::{BTreeMap, HashSet};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine;
use serde::{Deserialize, Serialize};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::{
    DesktopWallpaper, IDesktopWallpaper, DSS_SLIDESHOW,
};
use windows_sys::Win32::UI::HiDpi::GetSystemMetricsForDpi;
use windows_sys::Win32::UI::WindowsAndMessaging::{SM_CXICONSPACING, SM_CYICONSPACING};

use crate::{display, embed, store};

static ZONES_OPERATION: Mutex<()> = Mutex::new(());
const MAX_PNG_BYTES: usize = 48 * 1024 * 1024;
const MAX_PIXELS: u64 = 32 * 1024 * 1024;
const MAX_ORIGINAL_BYTES: u64 = 48 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Zone {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ZoneConfig {
    pub schema: u32,
    pub monitor: String,
    pub source_path: String,
    pub fit: String,
    pub panel_style: String,
    pub panel_opacity: f32,
    pub zones: Vec<Zone>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreRecord {
    original_path: String,
    backup_path: String,
    applied_path: String,
    #[serde(default)]
    previous_applied_path: String,
    #[serde(default)]
    pending: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedState {
    #[serde(default)]
    configs: BTreeMap<String, ZoneConfig>,
    #[serde(default)]
    records: BTreeMap<String, RestoreRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoneMonitor {
    #[serde(flatten)]
    pub display: display::DisplayInfo,
    pub wallpaper_path: String,
    /// Uncomposited source, so editing does not bake existing panels in again.
    pub source_path: String,
    /// Desktop icon grid spacing in this monitor's physical pixels.
    pub icon_spacing: [i32; 2],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZonesStatus {
    pub monitors: Vec<ZoneMonitor>,
    pub configs: BTreeMap<String, ZoneConfig>,
    pub active_monitor: String,
    pub can_restore: BTreeMap<String, bool>,
    pub position: String,
    pub position_code: i32,
    pub slideshow: bool,
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Balance both S_OK and S_FALSE, but never uninitialize an existing apartment.
struct ComApartment(bool);
impl ComApartment {
    fn enter() -> Result<Self, String> {
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        if hr.is_ok() {
            Ok(Self(true))
        } else if hr.0 == 0x80010106u32 as i32 {
            Ok(Self(false)) // RPC_E_CHANGED_MODE: COM was initialized by the host.
        } else {
            Err(format!("无法初始化 Windows 壁纸接口：{hr}"))
        }
    }
}
impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

fn take_com_string(value: PWSTR) -> Result<String, String> {
    if value.is_null() {
        return Ok(String::new());
    }
    let result = unsafe { value.to_string() }.map_err(|e| format!("Windows 壁纸路径无效：{e}"));
    unsafe { CoTaskMemFree(Some(value.0.cast())) };
    result
}

struct WallpaperSession {
    // Drop interface before its apartment.
    api: IDesktopWallpaper,
    _apartment: ComApartment,
}
impl WallpaperSession {
    fn open() -> Result<Self, String> {
        let apartment = ComApartment::enter()?;
        // Windows registers DesktopWallpaper through the shell's out-of-process
        // activation service on some versions; in-process-only activation fails.
        let api = unsafe { CoCreateInstance(&DesktopWallpaper, None, CLSCTX_ALL) }
            .map_err(|e| format!("Windows 壁纸接口不可用：{e}"))?;
        Ok(Self { api, _apartment: apartment })
    }

    fn monitor_id(&self, display: &display::DisplayInfo) -> Result<String, String> {
        let count = unsafe { self.api.GetMonitorDevicePathCount() }.map_err(|e| e.to_string())?;
        for index in 0..count {
            let id = take_com_string(unsafe { self.api.GetMonitorDevicePathAt(index) }.map_err(|e| e.to_string())?)?;
            let id_wide = wide(&id);
            let rect = unsafe { self.api.GetMonitorRECT(PCWSTR(id_wide.as_ptr())) }.map_err(|e| e.to_string())?;
            if [rect.left, rect.top, rect.right, rect.bottom] == display.rect {
                return Ok(id);
            }
        }
        Err("未找到匹配的显示器壁纸，请刷新显示器列表后重试".into())
    }

    fn get(&self, id: &str) -> Result<String, String> {
        let id_wide = wide(id);
        take_com_string(unsafe { self.api.GetWallpaper(PCWSTR(id_wide.as_ptr())) }
            .map_err(|e| format!("读取显示器壁纸失败：{e}"))?)
    }

    fn set(&self, id: &str, path: &str) -> Result<(), String> {
        let id_wide = wide(id);
        let path_wide = wide(path);
        unsafe { self.api.SetWallpaper(PCWSTR(id_wide.as_ptr()), PCWSTR(path_wide.as_ptr())) }
            .map_err(|e| format!("设置显示器壁纸失败：{e}"))
    }

    fn position(&self) -> Result<i32, String> {
        unsafe { self.api.GetPosition() }.map(|p| p.0).map_err(|e| format!("读取壁纸填充方式失败：{e}"))
    }

    fn slideshow(&self) -> Result<bool, String> {
        let state = unsafe { self.api.GetStatus() }.map_err(|e| format!("读取壁纸轮播状态失败：{e}"))?;
        Ok(state.0 & DSS_SLIDESHOW.0 != 0)
    }
}

fn position_name(code: i32) -> &'static str {
    match code {
        0 => "center", 1 => "tile", 2 => "stretch", 3 => "fit", 4 => "fill", 5 => "span", _ => "unknown",
    }
}

fn read_state() -> Result<SavedState, String> {
    match store::read_settings().get("desktopZones") {
        None | Some(serde_json::Value::Null) => Ok(SavedState::default()),
        Some(value) => serde_json::from_value(value.clone()).map_err(|_| "壁纸分区恢复记录损坏，未覆盖现有壁纸".into()),
    }
}

fn save_state(state: &SavedState) -> Result<(), String> {
    store::merge_settings(&serde_json::json!({"desktopZones": state})).map(|_| ())
}

fn same_path(a: &str, b: &str) -> bool {
    if a.is_empty() || b.is_empty() { return false; }
    let normalize = |p: &str| {
        std::fs::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p))
            .to_string_lossy().replace('/', "\\").trim_start_matches("\\\\?\\").to_lowercase()
    };
    normalize(a) == normalize(b)
}

fn managed_dir() -> Result<PathBuf, String> {
    let root = store::app_dir();
    store::reject_link(&root)?;
    let dir = root.join("desktop-zones");
    store::reject_link(&dir)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建壁纸分区目录：{e}"))?;
    Ok(dir)
}

fn checked_managed_file(path: &str, prefix: &str) -> Result<PathBuf, String> {
    let dir = managed_dir()?;
    let candidate = PathBuf::from(path);
    if !candidate.is_absolute()
        || !candidate.file_name().is_some_and(|n| n.to_string_lossy().starts_with(prefix))
        || !candidate.parent().is_some_and(|p| same_path(&p.to_string_lossy(), &dir.to_string_lossy())) {
        return Err("壁纸恢复路径不属于受管目录，未修改系统壁纸".into());
    }
    store::reject_link(&candidate)?;
    if !candidate.is_file() { return Err("壁纸备份文件不存在，未修改系统壁纸".into()); }
    Ok(candidate)
}

fn current_is_managed(current: &str, record: &RestoreRecord) -> bool {
    (checked_managed_file(&record.applied_path, "zones-").is_ok() && same_path(current, &record.applied_path))
        || (record.pending && !record.previous_applied_path.is_empty()
            && checked_managed_file(&record.previous_applied_path, "zones-").is_ok()
            && same_path(current, &record.previous_applied_path))
}

fn status_with(hwnd: embed::Hwnd, session: &WallpaperSession, state: SavedState) -> Result<ZonesStatus, String> {
    let mut monitors = Vec::new();
    let mut can_restore = BTreeMap::new();
    for mon in display::list_monitors(hwnd) {
        let id = session.monitor_id(&mon)?;
        let current = session.get(&id)?;
        let record = state.records.get(&mon.monitor);
        let active = record.is_some_and(|record| current_is_managed(&current, record));
        let recoverable = active && record.is_some_and(|r| checked_managed_file(&r.backup_path, "original-").is_ok());
        let source = if active {
            state.configs.get(&mon.monitor).map(|c| c.source_path.clone()).filter(|p| !p.is_empty())
                .or_else(|| record.map(|r| r.backup_path.clone())).unwrap_or_else(|| current.clone())
        } else { current.clone() };
        can_restore.insert(mon.monitor.clone(), recoverable);
        let icon_spacing = monitor_icon_spacing(&mon);
        monitors.push(ZoneMonitor { display: mon, wallpaper_path: current, source_path: source, icon_spacing });
    }
    let code = session.position()?;
    Ok(ZonesStatus {
        monitors, configs: state.configs, active_monitor: display::for_window(hwnd).monitor,
        can_restore, position: position_name(code).into(), position_code: code, slideshow: session.slideshow()?,
    })
}

fn monitor_icon_spacing(monitor: &display::DisplayInfo) -> [i32; 2] {
    let dpi = monitor.dpi.max(72);
    let fallback = (96.0 * monitor.dpi_scale.clamp(0.75, 4.0)).round() as i32;
    let metric = |index| {
        let spacing = unsafe { GetSystemMetricsForDpi(index, dpi) };
        if spacing > 0 { spacing } else { fallback }
    };
    [metric(SM_CXICONSPACING), metric(SM_CYICONSPACING)]
}

pub fn status(hwnd: embed::Hwnd) -> Result<ZonesStatus, String> {
    let _guard = ZONES_OPERATION.lock().map_err(|_| "壁纸分区暂时不可用，请重新启动")?;
    let session = WallpaperSession::open()?;
    status_with(hwnd, &session, read_state()?)
}

pub fn validate_config(config: &ZoneConfig, monitor: &display::DisplayInfo) -> Result<(), String> {
    if config.schema != 1 || config.monitor != monitor.monitor { return Err("壁纸分区版本或显示器不匹配".into()); }
    if !matches!(config.fit.as_str(), "cover" | "contain" | "stretch")
        || !matches!(config.panel_style.as_str(), "auto" | "light" | "dark")
        || !config.panel_opacity.is_finite() || !(0.0..=1.0).contains(&config.panel_opacity) {
        return Err("壁纸分区外观参数无效".into());
    }
    if config.source_path.len() > 32767 || config.source_path.contains('\0') {
        return Err("壁纸来源路径无效".into());
    }
    if !(2..=8).contains(&config.zones.len()) { return Err("请保留 2 至 8 个桌面区域".into()); }
    let mut ids = HashSet::new();
    let mut calendars = 0;
    for zone in &config.zones {
        if zone.id.is_empty() || zone.id.len() > 64 || !zone.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            || !ids.insert(&zone.id) || zone.label.chars().count() > 40 || zone.label.chars().any(char::is_control)
            || !matches!(zone.kind.as_str(), "calendar" | "software" | "files") {
            return Err("区域名称、类型或标识无效".into());
        }
        if ![zone.x, zone.y, zone.width, zone.height].iter().all(|v| v.is_finite())
            || zone.x < 0.0 || zone.y < 0.0 || zone.width < 0.02 || zone.height < 0.02
            || zone.x + zone.width > 1.0 + 1e-8 || zone.y + zone.height > 1.0 + 1e-8 {
            return Err("桌面区域必须完整位于工作区内".into());
        }
        if zone.kind == "calendar" {
            calendars += 1;
            let work_w = (monitor.work[2] - monitor.work[0]).max(1) as f64;
            let work_h = (monitor.work[3] - monitor.work[1]).max(1) as f64;
            let scale = (monitor.dpi_scale as f64).clamp(0.75, 4.0);
            if zone.width * work_w + 1.0 < 480.0 * scale
                || zone.height * work_h + 1.0 < 400.0 * scale {
                return Err("日历区域过小，请扩大到至少 480 × 400 个逻辑像素（含边距与标题）".into());
            }
        }
    }
    if calendars != 1 { return Err("每个布局必须恰好包含一个日历区域".into()); }
    for (index, a) in config.zones.iter().enumerate() {
        for b in &config.zones[index + 1..] {
            if a.x < b.x + b.width - 1e-8 && b.x < a.x + a.width - 1e-8
                && a.y < b.y + b.height - 1e-8 && b.y < a.y + a.height - 1e-8 {
                return Err("桌面区域不能重叠，请调整位置或尺寸".into());
            }
        }
    }
    Ok(())
}

pub fn calendar_rect(config: &ZoneConfig, monitor: &display::DisplayInfo) -> Result<[i32; 4], String> {
    validate_config(config, monitor)?;
    let zone = config.zones.iter().find(|z| z.kind == "calendar").ok_or("没有日历区域")?;
    let w = (monitor.work[2] - monitor.work[0]) as f64;
    let h = (monitor.work[3] - monitor.work[1]) as f64;
    let inset = (10.0 * monitor.dpi_scale as f64).round() as i32;
    let title = (30.0 * monitor.dpi_scale as f64).round() as i32;
    let left = monitor.work[0] + (zone.x * w).round() as i32;
    let top = monitor.work[1] + (zone.y * h).round() as i32;
    let right = monitor.work[0] + ((zone.x + zone.width) * w).round() as i32;
    let bottom = monitor.work[1] + ((zone.y + zone.height) * h).round() as i32;
    // x, y, width, height in physical pixels: leave the wallpaper zone's title visible.
    Ok([
        left + inset, top + title, right - left - inset * 2, bottom - top - title - inset,
    ])
}

fn validate_png(data_url: &str, dimensions: (u32, u32)) -> Result<Vec<u8>, String> {
    let encoded = data_url.strip_prefix("data:image/png;base64,").ok_or("只接受 PNG 壁纸预览")?;
    if encoded.len() > MAX_PNG_BYTES.div_ceil(3) * 4 { return Err("生成的壁纸超过 48 MiB 限制".into()); }
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| "PNG 壁纸编码无效")?;
    if bytes.len() > MAX_PNG_BYTES || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") { return Err("PNG 壁纸文件无效或过大".into()); }
    if dimensions.0 == 0 || dimensions.1 == 0 || dimensions.0 > 16384 || dimensions.1 > 16384
        || dimensions.0 as u64 * dimensions.1 as u64 > MAX_PIXELS {
        return Err("目标显示器分辨率超过安全合成范围（最多 3200 万像素）".into());
    }
    let mut reader = image::ImageReader::with_format(Cursor::new(&bytes), image::ImageFormat::Png);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(dimensions.0);
    limits.max_image_height = Some(dimensions.1);
    limits.max_alloc = Some(MAX_PIXELS * 8);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|_| "无法解码 PNG 壁纸，未修改系统设置")?;
    if decoded.width() != dimensions.0 || decoded.height() != dimensions.1 {
        return Err("壁纸尺寸与显示器不一致，请刷新预览后重试".into());
    }
    Ok(bytes)
}

fn publish_file(prefix: &str, extension: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let path = managed_dir()?.join(format!("{prefix}{}.{}", store::unique_suffix(), extension));
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path)
        .map_err(|e| format!("无法创建独立壁纸副本：{e}"))?;
    file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|e| format!("保存壁纸副本失败：{e}"))?;
    Ok(path)
}

fn backup_original(path: &str) -> Result<PathBuf, String> {
    if path.is_empty() { return Err("当前显示器没有静态图片壁纸，请先选择一张系统壁纸".into()); }
    let path = Path::new(path);
    store::reject_link(path)?;
    let file = std::fs::File::open(path).map_err(|e| format!("无法备份当前壁纸，未修改系统设置：{e}"))?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() { return Err("当前壁纸不是普通图片文件".into()); }
    let mut bytes = Vec::new();
    file.take(MAX_ORIGINAL_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_ORIGINAL_BYTES { return Err("原壁纸超过 48 MiB，无法创建安全恢复副本".into()); }
    let extension = match image::guess_format(&bytes).map_err(|_| "当前壁纸格式无法备份")? {
        image::ImageFormat::Png => "png", image::ImageFormat::Jpeg => "jpg",
        image::ImageFormat::Bmp => "bmp", image::ImageFormat::WebP => "webp",
        _ => return Err("请先将系统壁纸设为 JPG、PNG、BMP 或 WebP 静态图片".into()),
    };
    publish_file("original-", extension, &bytes)
}

/// Only the OS boundary and settings commit are injected. Both production commands
/// and fixture tests execute the same snapshot, publication, and rollback code.
trait TransactionIo {
    fn get(&mut self) -> Result<String, String>;
    fn set(&mut self, path: &str) -> Result<(), String>;
    fn save(&mut self, state: &SavedState) -> Result<(), String>;
}

struct SystemTransaction<'a> {
    session: &'a WallpaperSession,
    id: &'a str,
}
impl TransactionIo for SystemTransaction<'_> {
    fn get(&mut self) -> Result<String, String> { self.session.get(self.id) }
    fn set(&mut self, path: &str) -> Result<(), String> { self.session.set(self.id, path) }
    fn save(&mut self, state: &SavedState) -> Result<(), String> { save_state(state) }
}

fn prepare_apply_state(previous: &SavedState, config: ZoneConfig, current: &str, generated: &str) -> Result<SavedState, String> {
    let existing = previous.records.get(&config.monitor).filter(|r| current_is_managed(current, r));
    let (original_path, backup_path) = if let Some(record) = existing {
        checked_managed_file(&record.backup_path, "original-")?;
        (record.original_path.clone(), record.backup_path.clone())
    } else {
        (current.to_string(), backup_original(current)?.to_string_lossy().into_owned())
    };
    let mut next = previous.clone();
    let mut stored_config = config;
    // The original source may be a mutable Windows cache, unlike our snapshot.
    if stored_config.source_path.is_empty() || same_path(&stored_config.source_path, current) {
        stored_config.source_path = existing.and_then(|_| previous.configs.get(&stored_config.monitor))
            .map(|c| c.source_path.clone()).filter(|p| !p.is_empty()).unwrap_or_else(|| backup_path.clone());
    }
    let monitor_name = stored_config.monitor.clone();
    next.configs.insert(monitor_name.clone(), stored_config);
    next.records.insert(monitor_name.clone(), RestoreRecord {
        original_path, backup_path, applied_path: generated.to_string(), previous_applied_path: current.to_string(), pending: true,
    });
    Ok(next)
}

fn apply_transaction(io: &mut impl TransactionIo, previous: &SavedState, mut next: SavedState, monitor_name: &str, current: &str, generated: &str) -> Result<SavedState, String> {
    // Persist recovery intent before touching the OS. A crash still leaves a usable snapshot.
    io.save(&next)?;
    if !same_path(&io.get()?, current) {
        let rollback = io.save(previous).err();
        return Err(format!("桌面壁纸刚被其他程序更换，已取消应用{}", rollback.map(|e| format!("；恢复设置记录失败：{e}")).unwrap_or_default()));
    }
    if let Err(error) = io.set(generated) {
        let (preserve_intent, os_error) = match io.get() {
            Ok(actual) if same_path(&actual, generated) => match io.set(current) {
                Ok(()) => (false, None),
                Err(e) => (true, Some(e)),
            },
            Ok(_) => (false, None),
            Err(e) => (true, Some(e)),
        };
        let rollback = if preserve_intent { None } else { io.save(previous).err() };
        return Err(format!("{error}{}{}", os_error.map(|e| format!("；壁纸状态未能确认，恢复副本与记录已保留：{e}")).unwrap_or_default(), rollback.map(|e| format!("；恢复设置记录失败：{e}")).unwrap_or_default()));
    }
    if let Some(record) = next.records.get_mut(monitor_name) {
        record.pending = false;
        record.previous_applied_path.clear();
    }
    if let Err(error) = io.save(&next) {
        let os_rollback = io.set(current);
        let settings_rollback = if os_rollback.is_ok() { io.save(previous) } else { Ok(()) };
        return Err(format!("壁纸设置保存失败：{error}；{}{}",
            if os_rollback.is_ok() { "已恢复应用前壁纸".into() } else { "系统回退失败，恢复副本仍保留，可使用恢复壁纸重试".to_string() },
            settings_rollback.err().map(|e| format!("；记录回退失败：{e}")).unwrap_or_default()));
    }
    Ok(next)
}

fn restore_transaction(io: &mut impl TransactionIo, previous: &SavedState, monitor: &str) -> Result<(SavedState, String), String> {
    let record = previous.records.get(monitor).ok_or("该显示器没有可恢复的壁纸记录")?;
    let backup = checked_managed_file(&record.backup_path, "original-")?.to_string_lossy().into_owned();
    let current = io.get()?;
    if !current_is_managed(&current, record) {
        return Err("壁纸已由 Windows 或其他软件更换，未覆盖新壁纸；原图恢复副本仍保留".into());
    }
    io.set(&backup)?;
    let mut next = previous.clone();
    next.records.remove(monitor);
    if let Err(error) = io.save(&next) {
        let rollback = io.set(&current);
        return Err(format!("保存壁纸恢复状态失败：{error}；{}", if rollback.is_ok() { "已回到恢复前的分区壁纸" } else { "原壁纸已恢复，但状态尚未保存" }));
    }
    Ok((next, backup))
}

pub fn apply(hwnd: embed::Hwnd, config: ZoneConfig, png_data_url: String) -> Result<ZonesStatus, String> {
    if store::is_isolated() { return Err("隔离模式不能更改系统壁纸".into()); }
    let _guard = ZONES_OPERATION.lock().map_err(|_| "壁纸分区正在处理其他操作")?;
    let monitor = display::list_monitors(hwnd).into_iter().find(|m| m.monitor == config.monitor).ok_or("目标显示器已断开，请刷新后重试")?;
    validate_config(&config, &monitor)?;
    let png = validate_png(&png_data_url, ((monitor.rect[2] - monitor.rect[0]) as u32, (monitor.rect[3] - monitor.rect[1]) as u32))?;
    let session = WallpaperSession::open()?;
    if session.position()? == 5 { return Err("当前使用跨屏壁纸，请先在 Windows 个性化中改为填充或适应，再为单屏划分区域".into()); }
    if session.slideshow()? { return Err("当前启用了壁纸幻灯片，请先在 Windows 个性化中选择静态图片，避免分区随轮播丢失".into()); }
    let id = session.monitor_id(&monitor)?;
    let current = session.get(&id)?;
    let previous = read_state()?;
    // Gather fallible read-only status before publication; a committed wallpaper must
    // not be reported as failed merely because a different display disappears later.
    let mut result = status_with(hwnd, &session, previous.clone())?;
    let generated = publish_file("zones-", "png", &png)?.to_string_lossy().into_owned();
    let monitor_name = config.monitor.clone();
    let next = prepare_apply_state(&previous, config, &current, &generated)?;
    let next = apply_transaction(&mut SystemTransaction { session: &session, id: &id }, &previous, next, &monitor_name, &current, &generated)?;
    result.configs = next.configs;
    result.can_restore.insert(monitor_name.clone(), true);
    for mon in &mut result.monitors {
        if mon.display.monitor == monitor_name {
            mon.wallpaper_path = generated.clone();
            mon.source_path = result.configs[&monitor_name].source_path.clone();
        }
    }
    Ok(result)
}

pub fn restore(hwnd: embed::Hwnd, monitor: String) -> Result<ZonesStatus, String> {
    if store::is_isolated() { return Err("隔离模式不能更改系统壁纸".into()); }
    let _guard = ZONES_OPERATION.lock().map_err(|_| "壁纸分区正在处理其他操作")?;
    let display = display::list_monitors(hwnd).into_iter().find(|m| m.monitor == monitor).ok_or("目标显示器已断开")?;
    let previous = read_state()?;
    let session = WallpaperSession::open()?;
    if session.position()? == 5 || session.slideshow()? { return Err("系统壁纸模式已更改，未覆盖当前跨屏壁纸或幻灯片".into()); }
    let id = session.monitor_id(&display)?;
    let mut result = status_with(hwnd, &session, previous.clone())?;
    let (next, backup) = restore_transaction(&mut SystemTransaction { session: &session, id: &id }, &previous, &monitor)?;
    result.configs = next.configs;
    result.can_restore.insert(monitor.clone(), false);
    for mon in &mut result.monitors {
        if mon.display.monitor == monitor {
            mon.wallpaper_path = backup.clone();
            mon.source_path = mon.wallpaper_path.clone();
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_zones_frontend_compositions_match_native_window_geometry() {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Contract {
            display: display::DisplayInfo,
            config: ZoneConfig,
            expected_calendar: [i32; 4],
        }
        let cases: Vec<Contract> = serde_json::from_str(include_str!("../tests/fixtures/desktop-zones-layouts.json")).unwrap();
        for case in cases {
            validate_config(&case.config, &case.display).unwrap();
            assert_eq!(calendar_rect(&case.config, &case.display).unwrap(), case.expected_calendar, "{}", case.display.monitor);
        }
    }

    struct FixtureIo {
        current: String,
        saved: SavedState,
        settings_path: PathBuf,
        saves: usize,
        sets: usize,
        fail_saves: HashSet<usize>,
        // true models a SetWallpaper failure that nevertheless changed the OS.
        fail_sets: BTreeMap<usize, bool>,
    }

    impl TransactionIo for FixtureIo {
        fn get(&mut self) -> Result<String, String> { Ok(self.current.clone()) }
        fn set(&mut self, path: &str) -> Result<(), String> {
            self.sets += 1;
            if let Some(partial) = self.fail_sets.get(&self.sets) {
                if *partial { self.current = path.into(); }
                return Err("fixture SetWallpaper failed".into());
            }
            self.current = path.into();
            Ok(())
        }
        fn save(&mut self, state: &SavedState) -> Result<(), String> {
            self.saves += 1;
            if self.fail_saves.contains(&self.saves) { return Err("fixture settings write failed".into()); }
            store::merge_settings_at(&self.settings_path, &serde_json::json!({"desktopZones": state}))?;
            self.saved = state.clone();
            Ok(())
        }
    }

    fn transaction_fixture() -> (FixtureIo, ZoneConfig, Vec<u8>) {
        // Explicit ignored tests may write only their isolated synthetic fixture.
        assert!(store::is_isolated(), "transaction fixtures require KAL_ISOLATED=1 and KAL_DATA_DIR");
        let root = PathBuf::from(std::env::var_os("KAL_DATA_DIR").expect("set KAL_DATA_DIR"));
        let task_fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()
            .join("plans/2026-10-27-wallpaper-zones/_fixture");
        assert!(root.starts_with(task_fixtures), "fixture data must stay in this task's _fixture directory");
        let mut png = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(12, 8).write_to(&mut png, image::ImageFormat::Png).unwrap();
        let png = png.into_inner();
        let original = publish_file("fixture-source-", "png", &png).unwrap().to_string_lossy().into_owned();
        let settings_path = managed_dir().unwrap().join(format!("fixture-settings-{}.json", store::unique_suffix()));
        (FixtureIo { current: original, saved: SavedState::default(), settings_path, saves: 0, sets: 0,
            fail_saves: HashSet::new(), fail_sets: BTreeMap::new() }, fixture().0, png)
    }

    fn fixture_apply(io: &mut FixtureIo, config: ZoneConfig, png: &[u8]) -> Result<SavedState, String> {
        let previous = io.saved.clone();
        let current = io.get()?;
        let generated = publish_file("zones-", "png", png)?.to_string_lossy().into_owned();
        let monitor = config.monitor.clone();
        let next = prepare_apply_state(&previous, config, &current, &generated)?;
        apply_transaction(io, &previous, next, &monitor, &current, &generated)
    }

    #[test]
    #[ignore = "explicit isolated file fixtures; system wallpaper is fully simulated"]
    fn desktop_zones_transaction_apply_reapply_and_restore_original_snapshot() {
        let (mut io, config, png) = transaction_fixture();
        let original = io.current.clone();
        let first = fixture_apply(&mut io, config.clone(), &png).unwrap();
        let snapshot = first.records[&config.monitor].backup_path.clone();
        assert_eq!(std::fs::read(&snapshot).unwrap(), std::fs::read(&original).unwrap());
        assert!(!first.records[&config.monitor].pending);
        let first_generated = io.current.clone();
        let second = fixture_apply(&mut io, config.clone(), &png).unwrap();
        assert_eq!(second.records[&config.monitor].backup_path, snapshot);
        assert_eq!(second.records[&config.monitor].original_path, original);
        assert_ne!(io.current, first_generated);
        let (restored, backup) = restore_transaction(&mut io, &second, &config.monitor).unwrap();
        assert_eq!(io.current, snapshot);
        assert_eq!(backup, snapshot);
        assert!(restored.records.is_empty());
        let persisted: serde_json::Value = serde_json::from_slice(&std::fs::read(&io.settings_path).unwrap()).unwrap();
        assert_eq!(persisted["desktopZones"]["records"], serde_json::json!({}));
    }

    #[test]
    #[ignore = "explicit isolated file fixtures; system wallpaper is fully simulated"]
    fn desktop_zones_transaction_refuses_restore_after_external_wallpaper_change() {
        let (mut io, config, png) = transaction_fixture();
        let applied = fixture_apply(&mut io, config.clone(), &png).unwrap();
        let external = publish_file("fixture-external-", "png", &png).unwrap().to_string_lossy().into_owned();
        io.current = external.clone();
        let sets = io.sets;
        let saves = io.saves;
        assert!(restore_transaction(&mut io, &applied, &config.monitor).unwrap_err().contains("其他软件"));
        assert_eq!(io.current, external);
        assert_eq!((io.sets, io.saves), (sets, saves));
        assert_eq!(io.saved.records[&config.monitor].backup_path, applied.records[&config.monitor].backup_path);
    }

    #[test]
    #[ignore = "explicit isolated file fixtures; system wallpaper is fully simulated"]
    fn desktop_zones_transaction_failure_rollbacks_and_preserves_recovery_intent() {
        // Save intent failure: no OS setter is called.
        let (mut io, config, png) = transaction_fixture();
        let original = io.current.clone();
        io.fail_saves.insert(1);
        assert!(fixture_apply(&mut io, config, &png).is_err());
        assert_eq!(io.sets, 0);
        assert_eq!(io.current, original);
        assert!(io.saved.records.is_empty());

        // Failed setter, and failed final settings commit with successful OS rollback.
        for setter_fails in [true, false] {
            let (mut io, config, png) = transaction_fixture();
            let original = io.current.clone();
            if setter_fails { io.fail_sets.insert(1, false); } else { io.fail_saves.insert(2); }
            assert!(fixture_apply(&mut io, config, &png).is_err());
            assert_eq!(io.current, original);
            assert!(io.saved.records.is_empty());
        }

        // If final commit or a partially successful setter fails and OS rollback also
        // fails, the previously persisted pending record remains usable by restore.
        for partial_set_failure in [false, true] {
            let (mut io, config, png) = transaction_fixture();
            if partial_set_failure { io.fail_sets.insert(1, true); } else { io.fail_saves.insert(2); }
            io.fail_sets.insert(2, false);
            assert!(fixture_apply(&mut io, config.clone(), &png).is_err());
            let pending = io.saved.clone();
            let record = &pending.records[&config.monitor];
            assert!(record.pending);
            assert!(same_path(&io.current, &record.applied_path));
            assert!(Path::new(&record.backup_path).is_file());
            io.fail_saves.clear(); io.fail_sets.clear();
            let (_, backup) = restore_transaction(&mut io, &pending, &config.monitor).unwrap();
            assert_eq!(io.current, backup);
            assert!(io.saved.records.is_empty());
        }

        // Restore metadata failure rolls the OS back to the previous generated image.
        let (mut io, config, png) = transaction_fixture();
        let applied = fixture_apply(&mut io, config.clone(), &png).unwrap();
        let generated = io.current.clone();
        io.fail_saves.insert(io.saves + 1);
        assert!(restore_transaction(&mut io, &applied, &config.monitor).is_err());
        assert_eq!(io.current, generated);
        assert!(!io.saved.records.is_empty());
    }

    fn fixture() -> (ZoneConfig, display::DisplayInfo) {
        let monitor = display::DisplayInfo {
            monitor: "DISPLAY-TEST".into(), px_w: 1920, px_h: 1080, mm_w: 0, mm_h: 0,
            diagonal_in: 0.0, ppi: 96.0, dpi: 96, dpi_scale: 1.0, kal_scale: 1.0, ppi_known: false,
            work: [-1920, 0, 0, 1040], rect: [-1920, 0, 0, 1080], orientation: "landscape".into(), is_primary: false,
        };
        let config = ZoneConfig {
            schema: 1, monitor: monitor.monitor.clone(), source_path: String::new(), fit: "cover".into(), panel_style: "auto".into(), panel_opacity: 0.4,
            zones: vec![
                Zone { id: "calendar".into(), kind: "calendar".into(), label: "日历".into(), x: 0.5, y: 0.02, width: 0.48, height: 0.96 },
                Zone { id: "software".into(), kind: "software".into(), label: "软件".into(), x: 0.02, y: 0.02, width: 0.45, height: 0.45 },
                Zone { id: "files".into(), kind: "files".into(), label: "文件".into(), x: 0.02, y: 0.5, width: 0.45, height: 0.48 },
            ],
        };
        (config, monitor)
    }

    #[test]
    fn desktop_zones_accept_negative_monitor_coordinates_and_map_work_area() {
        let (config, monitor) = fixture();
        assert_eq!(calendar_rect(&config, &monitor).unwrap(), [-950, 51, 902, 958]);
    }

    #[test]
    fn desktop_zones_reject_overlap_bounds_duplicate_and_small_calendar() {
        let (config, monitor) = fixture();
        let mut overlap = config.clone(); overlap.zones[1].width = 0.7;
        assert!(validate_config(&overlap, &monitor).unwrap_err().contains("重叠"));
        let mut bounds = config.clone(); bounds.zones[0].x = 0.8;
        assert!(validate_config(&bounds, &monitor).is_err());
        let mut duplicate = config.clone(); duplicate.zones[1].id = "calendar".into();
        assert!(validate_config(&duplicate, &monitor).is_err());
        let mut small = config; small.zones[0].width = 0.1;
        assert!(validate_config(&small, &monitor).unwrap_err().contains("过小"));
    }

    #[test]
    fn desktop_zones_reject_nonfinite_and_multiple_calendars() {
        let (mut config, monitor) = fixture();
        config.zones[0].x = f64::NAN;
        assert!(validate_config(&config, &monitor).is_err());
        config.zones[0].x = 0.5; config.zones[1].kind = "calendar".into();
        assert!(validate_config(&config, &monitor).is_err());
    }

    #[test]
    fn desktop_zones_validate_png_dimensions_and_reject_corrupt_data() {
        let image = image::DynamicImage::new_rgb8(12, 8);
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        let data = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes.into_inner()));
        assert!(validate_png(&data, (12, 8)).is_ok());
        assert!(validate_png(&data, (13, 8)).is_err());
        assert!(validate_png("data:image/png;base64,aGVsbG8=", (12, 8)).is_err());
        assert!(validate_png(&data, (16384, 16384)).is_err());
    }

    #[test]
    #[ignore = "explicit Windows read-only COM smoke check; requires fresh isolated data root"]
    fn desktop_zones_native_readonly_status() {
        assert!(store::is_isolated(), "native smoke check requires isolation");
        let root = std::env::var_os("KAL_DATA_DIR").expect("set a fresh KAL_DATA_DIR");
        assert!(!root.is_empty());
        assert!(!Path::new(&root).join("settings.json").exists(), "use a fresh fixture root");
        let result = status(0).expect("read-only DesktopWallpaper COM status");
        assert!(!result.monitors.is_empty());
        assert!((0..=5).contains(&result.position_code));
        assert!(result.configs.is_empty());
        assert!(result.can_restore.values().all(|v| !*v));
        for mon in &result.monitors {
            assert!(mon.display.rect[2] > mon.display.rect[0]);
            assert!(mon.display.rect[3] > mon.display.rect[1]);
            assert!(mon.icon_spacing.iter().all(|spacing| *spacing > 0));
        }
        println!("read-only DesktopWallpaper COM: monitors={}, position={}, slideshow={}, iconSpacing={:?}",
            result.monitors.len(), result.position, result.slideshow,
            result.monitors.iter().map(|monitor| monitor.icon_spacing).collect::<Vec<_>>());
    }
}
