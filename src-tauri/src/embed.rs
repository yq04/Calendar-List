//! 桌面层嵌入模块
//!
//! 两种模式：
//!   - `anchored`  桌面挂件式：正常窗口 + 不抢焦点 + 不出现在任务栏/Alt+Tab。可完全交互。
//!   - `wallpaper` 壁纸层真嵌入：SetParent 到壁纸 WorkerW。视觉融合度最高，但位于图标层之下，仅展示。
//!
//! 实测依据（见 findings.md 第 2 节）：本机 z 序中壁纸层 WorkerW 位于含 SHELLDLL_DefView
//! 的图标层 WorkerW 之下，因此真嵌入只能展示。所以默认用 anchored。

#![allow(non_snake_case)]

pub type Hwnd = isize;

// ---- Win32 常量 ----
const GWL_EXSTYLE: i32 = -20;
const WS_EX_LAYERED: isize = 0x0008_0000;
const WS_EX_TRANSPARENT: isize = 0x0000_0020;
const WS_EX_NOACTIVATE: isize = 0x0800_0000;
const WS_EX_TOOLWINDOW: isize = 0x0000_0080;

const SWP_NOSIZE: u32 = 0x0001;
const SWP_NOMOVE: u32 = 0x0002;
const SWP_NOACTIVATE: u32 = 0x0010;
const SWP_FRAMECHANGED: u32 = 0x0020;

const GW_HWNDNEXT: u32 = 2;
const GWLP_HWNDPARENT: i32 = -8;
const HWND_BOTTOM: Hwnd = 1;

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

#[link(name = "user32")]
extern "system" {
    fn EnumWindows(cb: extern "system" fn(Hwnd, isize) -> i32, lparam: isize) -> i32;
    fn GetClassNameW(hwnd: Hwnd, buf: *mut u16, max: i32) -> i32;
    fn FindWindowExW(parent: Hwnd, after: Hwnd, cls: *const u16, win: *const u16) -> Hwnd;
    fn SetParent(child: Hwnd, parent: Hwnd) -> Hwnd;
    fn GetParent(hwnd: Hwnd) -> Hwnd;
    fn IsWindowVisible(hwnd: Hwnd) -> i32;
    fn GetWindowLongW(hwnd: Hwnd, index: i32) -> i32;
    fn SetWindowLongW(hwnd: Hwnd, index: i32, value: i32) -> i32;
    fn SetWindowPos(hwnd: Hwnd, after: Hwnd, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
    fn GetWindow(hwnd: Hwnd, cmd: u32) -> Hwnd;
    fn WindowFromPoint(pt: Point) -> Hwnd;
    fn GetDpiForWindow(hwnd: Hwnd) -> u32;
    fn GetDpiForSystem() -> u32;
    fn GetWindowRect(hwnd: Hwnd, rect: *mut windows_sys::Win32::Foundation::RECT) -> i32;
    fn MapWindowPoints(from: Hwnd, to: Hwnd, points: *mut Point, count: u32) -> i32;
    fn ShowWindow(hwnd: Hwnd, command: i32) -> i32;
    fn SetForegroundWindow(hwnd: Hwnd) -> i32;
    fn GetForegroundWindow() -> Hwnd;
    fn IsWindow(hwnd: Hwnd) -> i32;
}

#[cfg(target_pointer_width = "64")]
#[link(name = "user32")]
extern "system" {
    fn SetWindowLongPtrW(hwnd: Hwnd, index: i32, value: isize) -> isize;
    fn GetWindowLongPtrW(hwnd: Hwnd, index: i32) -> isize;
}

#[cfg(target_pointer_width = "32")]
unsafe fn SetWindowLongPtrW(hwnd: Hwnd, index: i32, value: isize) -> isize {
    SetWindowLongW(hwnd, index, value as i32) as isize
}

#[cfg(target_pointer_width = "32")]
unsafe fn GetWindowLongPtrW(hwnd: Hwnd, index: i32) -> isize {
    GetWindowLongW(hwnd, index) as isize
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe fn class_of(hwnd: Hwnd) -> String {
    if hwnd == 0 {
        return String::new();
    }
    let mut buf = [0u16; 256];
    let n = GetClassNameW(hwnd, buf.as_mut_ptr(), 256);
    if n <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..n as usize])
}

/// 桌面层结构扫描结果
#[derive(Default, Debug, Clone)]
pub struct DesktopScan {
    pub progman: Hwnd,
    pub defview_host: Hwnd,
    pub wallpaper: Hwnd,
    pub worker_count: usize,
    pub worker_visible_without_defview: usize,
}

struct ScanCtx {
    progman: Hwnd,
    defview_host: Hwnd,
    workers: Vec<Hwnd>,
}

extern "system" fn scan_cb(hwnd: Hwnd, lparam: isize) -> i32 {
    unsafe {
        let ctx = &mut *(lparam as *mut ScanCtx);
        let cls = class_of(hwnd);
        if cls == "Progman" {
            ctx.progman = hwnd;
        } else if cls == "WorkerW" {
            ctx.workers.push(hwnd);
            let dv = FindWindowExW(hwnd, 0, wide("SHELLDLL_DefView").as_ptr(), std::ptr::null());
            if dv != 0 {
                ctx.defview_host = hwnd;
            }
        }
        1
    }
}

/// 扫描桌面窗口层级，选出壁纸承载 WorkerW
pub fn scan_desktop() -> DesktopScan {
    let mut ctx = ScanCtx { progman: 0, defview_host: 0, workers: Vec::new() };
    unsafe {
        EnumWindows(scan_cb, &mut ctx as *mut ScanCtx as isize);
    }

    let mut out = DesktopScan {
        progman: ctx.progman,
        defview_host: ctx.defview_host,
        worker_count: ctx.workers.len(),
        ..Default::default()
    };

    unsafe {
        // 优先：可见且不含 DefView 的 WorkerW
        for &w in &ctx.workers {
            if w == ctx.defview_host {
                continue;
            }
            let dv = FindWindowExW(w, 0, wide("SHELLDLL_DefView").as_ptr(), std::ptr::null());
            if dv != 0 {
                continue;
            }
            if IsWindowVisible(w) != 0 {
                out.worker_visible_without_defview += 1;
                if out.wallpaper == 0 {
                    out.wallpaper = w;
                }
            }
        }
        // 兜底：DefView 宿主的 z 序后继
        if out.wallpaper == 0 && out.defview_host != 0 {
            let nx = GetWindow(out.defview_host, GW_HWNDNEXT);
            if nx != 0 && class_of(nx) == "WorkerW" {
                out.wallpaper = nx;
            }
        }
        // 再兜底：Progman
        if out.wallpaper == 0 {
            out.wallpaper = out.progman;
        }
    }
    out
}

/// anchored 模式：启动/布局时不抢焦点，用户点击后可激活并输入文字。
pub fn apply_anchored(hwnd: Hwnd) -> Result<(), String> {
    if hwnd == 0 {
        return Err("hwnd 无效".into());
    }
    unsafe {
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as isize;
        let want = ((ex | WS_EX_LAYERED | WS_EX_TOOLWINDOW) & !WS_EX_NOACTIVATE) as i32;
        SetWindowLongW(hwnd, GWL_EXSTYLE, want);
        SetWindowPos(
            hwnd,
            0,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
    }
    Ok(())
}

/// wallpaper 模式：SetParent 到壁纸层 WorkerW，并做健康检查
pub fn apply_wallpaper(hwnd: Hwnd) -> Result<DesktopScan, String> {
    if hwnd == 0 {
        return Err("hwnd 无效".into());
    }
    let scan = scan_desktop();
    if scan.wallpaper == 0 {
        return Err("未找到可用的壁纸层 WorkerW".into());
    }
    unsafe {
        apply_anchored(hwnd)?;
        let mut rect = std::mem::zeroed();
        GetWindowRect(hwnd, &mut rect);
        SetParent(hwnd, scan.wallpaper);
        // 健康检查：粘连是否真的生效
        let got = GetParent(hwnd);
        if got != scan.wallpaper {
            return Err(format!(
                "SetParent 未生效（期望 0x{:X}，实际 0x{:X}）——常见原因：进程以管理员运行，或 DPI 感知上下文不一致",
                scan.wallpaper, got
            ));
        }
        let mut point = Point { x: rect.left, y: rect.top };
        MapWindowPoints(0, scan.wallpaper, &mut point, 1);
        SetWindowPos(hwnd, 0, point.x, point.y, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE);
    }
    Ok(scan)
}

/// 脱离嵌入，恢复为独立窗口
pub fn detach(hwnd: Hwnd) {
    if hwnd != 0 {
        unsafe {
            let mut rect = std::mem::zeroed();
            GetWindowRect(hwnd, &mut rect);
            SetParent(hwnd, 0);
            SetWindowPos(hwnd, 0, rect.left, rect.top, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }
}

/// Temporary interactive call-out. Remove desktop ownership before focusing.
pub fn summon(hwnd: Hwnd) -> Result<(), String> {
    if hwnd == 0 { return Err("hwnd 无效".into()); }
    detach(hwnd);
    apply_anchored(hwnd)?;
    let _ = set_click_through(hwnd, false);
    unsafe {
        SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, 0);
        ShowWindow(hwnd, 9); // SW_RESTORE: also restores a Win+D/minimized window.
        SetWindowPos(hwnd, -1, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE); // HWND_TOPMOST
        SetForegroundWindow(hwnd);
    }
    Ok(())
}

pub fn clear_topmost(hwnd: Hwnd) {
    if hwnd != 0 {
        unsafe { SetWindowPos(hwnd, -2, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE); }
    }
}

pub fn foreground_window() -> Hwnd { unsafe { GetForegroundWindow() } }

/// Only return focus during explicit dismissal; focus loss must never steal it.
pub fn return_focus(hwnd: Hwnd, previous: Hwnd) {
    unsafe {
        if GetForegroundWindow() == hwnd && previous != 0 && previous != hwnd && IsWindow(previous) != 0 {
            SetForegroundWindow(previous);
        }
    }
}

/// 健康检查：窗口是否仍然可见
pub fn health(hwnd: Hwnd) -> bool {
    if hwnd == 0 {
        return false;
    }
    unsafe { IsWindowVisible(hwnd) != 0 }
}

pub fn window_dpi(hwnd: Hwnd) -> u32 {
    unsafe {
        let d = if hwnd != 0 { GetDpiForWindow(hwnd) } else { 0 };
        if d == 0 {
            GetDpiForSystem()
        } else {
            d
        }
    }
}

/// 命中测试：某点会命中哪个窗口（用于验证可交互性）
pub fn hit_test(x: i32, y: i32) -> (Hwnd, String) {
    unsafe {
        let h = WindowFromPoint(Point { x, y });
        (h, class_of(h))
    }
}

/// 把窗口的 owner 设为 Progman（桌面）。
pub fn set_desktop_owner(hwnd: Hwnd) -> Result<Hwnd, String> {
    if hwnd == 0 {
        return Err("hwnd 无效".into());
    }
    let scan = scan_desktop();
    let owner = if scan.progman != 0 { scan.progman } else { scan.defview_host };
    if owner == 0 {
        return Err("未找到桌面窗口（Progman）".into());
    }
    unsafe {
        let prev = GetWindowLongPtrW(hwnd, GWLP_HWNDPARENT);
        SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, owner as isize);
        let now = GetWindowLongPtrW(hwnd, GWLP_HWNDPARENT);
        if now != owner as isize {
            return Err(format!(
                "设置 owner 未生效（期望 0x{owner:X}，实际 0x{now:X}，之前 0x{prev:X}）"
            ));
        }
        // 让 z 序立即重排，落到桌面层
        SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
    Ok(owner)
}

/// 鼠标穿透开关（WS_EX_TRANSPARENT | WS_EX_LAYERED）
/// 开启后鼠标点击会直接穿透日历落到下方桌面图标或窗口；可通过托盘菜单或全局热键恢复交互。
pub fn set_click_through(hwnd: Hwnd, enabled: bool) -> Result<(), String> {
    if hwnd == 0 {
        return Err("hwnd 无效".into());
    }
    unsafe {
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as isize;
        let next = if enabled {
            (ex | WS_EX_LAYERED | WS_EX_TRANSPARENT) as i32
        } else {
            ((ex | WS_EX_LAYERED) & !WS_EX_TRANSPARENT) as i32
        };
        SetWindowLongW(hwnd, GWL_EXSTYLE, next);
        SetWindowPos(
            hwnd,
            0,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
    }
    Ok(())
}

/// 调试用：打印桌面结构
pub fn describe(scan: &DesktopScan) -> String {
    format!(
        "Progman=0x{:X}  DefView宿主=0x{:X}  壁纸承载=0x{:X}  WorkerW数={}  可见且无DefView={}",
        scan.progman, scan.defview_host, scan.wallpaper, scan.worker_count,
        scan.worker_visible_without_defview
    )
}
