//! 显示器物理尺寸感知
//!
//! ## 要解决什么问题
//! Windows 的字号只跟「DPI 百分比」走，而百分比是用户偏好、不是物理尺寸。
//! 于是同样 15px 的字：
//!   24" 1080p（91.8 PPI，100%）-> 4.15 mm
//!   27" 1440p（108.8 PPI，100%）-> 3.50 mm
//! 差 18%，肉眼一眼可见。用户说的「换分辨率就不一样」正是这个。
//!
//! ## 怎么修
//! 取显示器「像素对角 / 物理对角」得到真实 PPI，再令
//!   `kalScale = PPI / 96`
//! 于是 1 设计像素恒等于 1/96 英寸的物理尺寸，跨屏视觉大小一致。
//! DPI 百分比仍照常生效 —— 那是用户的意愿，不该被我们抵消。
//!
//! ## 物理尺寸从哪来（踩过的坑）
//! 一开始用 `QueryDisplayConfig` 的 `targetVideoSignalInfo.activeSize`，
//! 结果它返回的是 **像素**（2560x1440），不是毫米 —— 字段名有误导性。
//! 真正可用的是 GDI 的 `HORZSIZE/VERTSIZE`（活动显示区毫米），
//! 实测本机返回 597x336mm -> 27.0" -> 108.9 PPI，与 EDID 一致。
//! 像素侧则要用 `DESKTOPHORZRES`（物理像素），`HORZRES` 在 DPI 虚拟化下会缩水。

#![allow(non_snake_case)]

use crate::embed::Hwnd;
use windows_sys::core::BOOL;
use windows_sys::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    CreateDCW, DeleteDC, EnumDisplayMonitors, GetDeviceCaps, DESKTOPHORZRES, DESKTOPVERTRES,
    HDC, HMONITOR, HORZSIZE, VERTSIZE,
};
use windows_sys::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromPoint, MonitorFromWindow, MONITORINFO, MONITORINFOEXW,
    MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTOPRIMARY,
};

#[link(name = "shcore")]
extern "system" {
    fn GetDpiForMonitor(hmonitor: HMONITOR, dpi_type: i32, dpi_x: *mut u32, dpi_y: *mut u32) -> i32;
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn default_orientation() -> String {
    "landscape".to_string()
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    /// 形如 `\\.\DISPLAY1`
    pub monitor: String,
    pub px_w: u32,
    pub px_h: u32,
    /// 活动显示区物理尺寸（毫米）
    pub mm_w: u32,
    pub mm_h: u32,
    /// 屏幕对角线英寸
    pub diagonal_in: f32,
    /// 真实 PPI（每英寸像素）
    pub ppi: f32,
    pub dpi: u32,
    /// Windows 缩放比（1.0 = 100%）
    pub dpi_scale: f32,
    /// 我们施加的 PPI 校正系数
    pub kal_scale: f32,
    /// 是否成功拿到物理尺寸
    pub ppi_known: bool,
    /// 工作区（排除任务栏）left, top, right, bottom
    pub work: [i32; 4],
    /// 显示器完整矩形
    pub rect: [i32; 4],
    /// 屏幕方向：landscape（横屏）| portrait（竖屏）
    #[serde(default = "default_orientation")]
    pub orientation: String,
    /// 是否为主显示器
    #[serde(default)]
    pub is_primary: bool,
}

/// GDI 取某输出口的物理像素与毫米尺寸 -> (px_w, px_h, mm_w, mm_h)
fn gdi_metrics(device: &str) -> Option<(u32, u32, u32, u32)> {
    let dev = wide(device);
    unsafe {
        let hdc = CreateDCW(std::ptr::null(), dev.as_ptr(), std::ptr::null(), std::ptr::null());
        if hdc.is_null() {
            return None;
        }
        let pw = GetDeviceCaps(hdc, DESKTOPHORZRES as i32);
        let ph = GetDeviceCaps(hdc, DESKTOPVERTRES as i32);
        let hz = GetDeviceCaps(hdc, HORZSIZE as i32);
        let vt = GetDeviceCaps(hdc, VERTSIZE as i32);
        DeleteDC(hdc);

        if pw <= 0 || ph <= 0 || hz <= 0 || vt <= 0 {
            return None;
        }
        Some((pw as u32, ph as u32, hz as u32, vt as u32))
    }
}

struct Mon {
    hmon: HMONITOR,
    device: String,
    rect: RECT,
    work: RECT,
    is_primary: bool,
}

fn mon_from_handle(mon: HMONITOR) -> Option<Mon> {
    if mon.is_null() {
        return None;
    }
    unsafe {
        // MONITORINFOEXW 要比 MONITORINFO 大，cbSize 必须给足，否则拿不到 szDevice
        let mut mi: MONITORINFOEXW = std::mem::zeroed();
        mi.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(mon, &mut mi as *mut _ as *mut MONITORINFO) == 0 {
            return None;
        }

        let len = mi
            .szDevice
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(mi.szDevice.len());
        Some(Mon {
            hmon: mon,
            device: String::from_utf16_lossy(&mi.szDevice[..len]),
            rect: mi.monitorInfo.rcMonitor,
            work: mi.monitorInfo.rcWork,
            is_primary: (mi.monitorInfo.dwFlags & 1) != 0,
        })
    }
}

fn monitor_of(hwnd: Hwnd) -> Option<Mon> {
    unsafe {
        let mon = if hwnd != 0 {
            MonitorFromWindow(hwnd as HWND, MONITOR_DEFAULTTONEAREST)
        } else {
            MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY)
        };
        mon_from_handle(mon)
    }
}

fn monitor_dpi(hmon: HMONITOR, hwnd: Hwnd) -> u32 {
    if !hmon.is_null() {
        unsafe {
            let mut dx: u32 = 0;
            let mut dy: u32 = 0;
            // MDT_EFFECTIVE_DPI = 0
            if GetDpiForMonitor(hmon, 0, &mut dx, &mut dy) == 0 && dx > 0 {
                return dx;
            }
        }
    }
    let d = if hwnd != 0 { crate::embed::window_dpi(hwnd) } else { 0 };
    if d > 0 {
        return d;
    }
    96
}

fn info_from_mon(mon: Option<Mon>, hwnd: Hwnd) -> DisplayInfo {
    let (hmon, device, rect, work, is_primary) = match &mon {
        Some(m) => (
            m.hmon,
            m.device.clone(),
            [m.rect.left, m.rect.top, m.rect.right, m.rect.bottom],
            [m.work.left, m.work.top, m.work.right, m.work.bottom],
            m.is_primary,
        ),
        None => (std::ptr::null_mut(), String::new(), [0; 4], [0; 4], true),
    };

    let dpi = monitor_dpi(hmon, hwnd);
    let dpi_scale = dpi as f32 / 96.0;

    let metrics = if device.is_empty() { None } else { gdi_metrics(&device) };
    let (px_w, px_h, mut mm_w, mut mm_h) = match metrics {
        Some(m) => m,
        None => {
            // GDI 失败时退回显示器矩形（逻辑像素），并声明「物理尺寸未知」
            let w = (rect[2] - rect[0]).max(0) as u32;
            let h = (rect[3] - rect[1]).max(0) as u32;
            (w, h, 0, 0)
        }
    };

    // 当显示器旋转为竖屏 (px_h > px_w) 但 EDID 毫米宽高仍按横屏上报时，同步对齐物理宽高方向
    let is_portrait = px_h > px_w;
    if is_portrait && mm_w > mm_h {
        std::mem::swap(&mut mm_w, &mut mm_h);
    } else if !is_portrait && mm_h > mm_w {
        std::mem::swap(&mut mm_w, &mut mm_h);
    }

    // 毫米尺寸缺失或明显不合理时判定为「未取到」：宁可不校正，也不要瞎校正
    let diag_mm = ((mm_w as f32).powi(2) + (mm_h as f32).powi(2)).sqrt();
    let min_side_mm = mm_w.min(mm_h);
    let max_side_mm = mm_w.max(mm_h);
    let ppi_known = max_side_mm >= 100 && min_side_mm >= 60 && (100.0..=2000.0).contains(&diag_mm) && px_w > 0;
    let diag_px = ((px_w as f32).powi(2) + (px_h as f32).powi(2)).sqrt();
    let ppi = if ppi_known { diag_px / diag_mm * 25.4 } else { dpi as f32 };
    // WebView2 已按系统 DPI (dpi/96) 缩放 CSS 像素，因此物理尺寸校正仅补偿真实 PPI 与当前 DPI 的比值
    let kal_scale = if ppi_known {
        (ppi / (dpi as f32)).clamp(0.85, 1.32)
    } else {
        1.0
    };

    DisplayInfo {
        monitor: device,
        px_w,
        px_h,
        mm_w,
        mm_h,
        diagonal_in: if ppi_known { diag_mm / 25.4 } else { 0.0 },
        ppi,
        dpi,
        dpi_scale,
        kal_scale,
        ppi_known,
        work,
        rect,
        orientation: if is_portrait { "portrait".to_string() } else { "landscape".to_string() },
        is_primary,
    }
}

/// 取某个窗口所在显示器的信息；hwnd 为 0 时取主屏
pub fn for_window(hwnd: Hwnd) -> DisplayInfo {
    info_from_mon(monitor_of(hwnd), hwnd)
}

unsafe extern "system" fn enum_monitor_cb(
    hmon: HMONITOR,
    _hdc: HDC,
    _rc: *mut RECT,
    lparam: LPARAM,
) -> BOOL {
    let vec_ptr = lparam as *mut Vec<Mon>;
    if !vec_ptr.is_null() {
        if let Some(m) = mon_from_handle(hmon) {
            (*vec_ptr).push(m);
        }
    }
    1
}

/// 枚举当前连接的所有显示器信息（主屏优先，其余按从左到右、从上到下排序）
pub fn list_monitors(hwnd: Hwnd) -> Vec<DisplayInfo> {
    let mut mons: Vec<Mon> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(
            std::ptr::null_mut(),
            std::ptr::null(),
            Some(enum_monitor_cb),
            &mut mons as *mut Vec<Mon> as LPARAM,
        );
    }
    if mons.is_empty() {
        return vec![for_window(hwnd)];
    }
    let mut infos: Vec<DisplayInfo> = mons.into_iter().map(|m| info_from_mon(Some(m), hwnd)).collect();
    infos.sort_by(|a, b| {
        b.is_primary
            .cmp(&a.is_primary)
            .then_with(|| a.rect[0].cmp(&b.rect[0]))
            .then_with(|| a.rect[1].cmp(&b.rect[1]))
    });
    infos
}

/// 某点是否落在任意显示器上。恢复窗口位置时用来防止窗口跑到屏外再也找不回来。
pub fn on_any_monitor(x: i32, y: i32) -> bool {
    unsafe { !MonitorFromPoint(POINT { x, y }, 0).is_null() }
}

/// 供调试打印
pub fn describe(d: &DisplayInfo) -> String {
    if d.ppi_known {
        format!(
            "{} {}x{} {}x{}mm {:.1}\" PPI {:.1} dpi {} ({:.0}%) 校正 {:.3}",
            d.monitor, d.px_w, d.px_h, d.mm_w, d.mm_h, d.diagonal_in, d.ppi,
            d.dpi, d.dpi_scale * 100.0, d.kal_scale
        )
    } else {
        format!(
            "{} {}x{} 物理尺寸未知 dpi {} ({:.0}%) 校正 1.000",
            d.monitor, d.px_w, d.px_h, d.dpi, d.dpi_scale * 100.0
        )
    }
}
