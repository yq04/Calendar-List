//! 当前壁纸定位
//!
//! 顺序：注册表主动设置的壁纸 -> 主题包里的转码壁纸（幻灯片/主题场景）
//!      -> 主题缓存目录 -> 系统自带壁纸。
//! 只读注册表，不改任何系统设置。

use std::path::{Path, PathBuf};
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperInfo {
    pub path: String,
    /// registry | transcoded | cached | fallback | none
    pub source: String,
    pub exists: bool,
    pub style: String,
}

fn reg_str(sub: &str, name: &str) -> Option<String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu.open_subkey(sub).ok()?;
    let v: String = key.get_value(name).ok()?;
    let v = v.trim().trim_matches('\0').to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

fn appdata() -> Option<PathBuf> {
    std::env::var("APPDATA").ok().map(PathBuf::from)
}

fn first_image(dir: &Path) -> Option<PathBuf> {
    let rd = std::fs::read_dir(dir).ok()?;
    let mut best: Option<PathBuf> = None;
    for e in rd.flatten() {
        let p = e.path();
        let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
        if matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "bmp") {
            // 取体积最大的那张：缓存目录里常有缩略图，大文件才是真正用的
            let bigger = match (&best, p.metadata().ok().map(|m| m.len())) {
                (Some(b), Some(len)) => {
                    b.metadata().map(|m| m.len()).unwrap_or(0) < len
                }
                (None, Some(_)) => true,
                _ => false,
            };
            if bigger {
                best = Some(p);
            }
        }
    }
    best
}

/// 定位当前壁纸
pub fn locate() -> WallpaperInfo {
    // 1) 用户主动设置的壁纸
    if let Some(p) = reg_str("Control Panel\\Desktop", "Wallpaper") {
        let pb = PathBuf::from(&p);
        if pb.is_file() {
            let style = reg_str("Control Panel\\Desktop", "WallpaperStyle").unwrap_or_else(|| "10".into());
            return WallpaperInfo {
                path: p,
                source: "registry".into(),
                exists: true,
                style,
            };
        }
    }

    // 2) 主题包转码壁纸（幻灯片会把当前帧转码到这里）
    if let Some(ad) = appdata() {
        let t = ad.join("Microsoft\\Windows\\Themes\\TranscodedWallpaper");
        if t.is_file() {
            return WallpaperInfo {
                path: t.display().to_string(),
                source: "transcoded".into(),
                exists: true,
                style: String::new(),
            };
        }
        // 3) 主题缓存目录
        if let Some(p) = first_image(&ad.join("Microsoft\\Windows\\Themes\\CachedFiles")) {
            return WallpaperInfo {
                path: p.display().to_string(),
                source: "cached".into(),
                exists: true,
                style: String::new(),
            };
        }
    }

    // 4) 系统自带
    if let Ok(win) = std::env::var("WINDIR") {
        let p = PathBuf::from(win).join("Web\\Wallpaper\\Windows\\img0.jpg");
        if p.is_file() {
            return WallpaperInfo {
                path: p.display().to_string(),
                source: "fallback".into(),
                exists: true,
                style: String::new(),
            };
        }
    }

    WallpaperInfo {
        path: String::new(),
        source: "none".into(),
        exists: false,
        style: String::new(),
    }
}

pub const MAX_WALLPAPER_BYTES: u64 = 24 * 1024 * 1024;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperImageData {
    pub path: String,
    pub source: String,
    pub mime: String,
    pub data_url: String,
}

fn detect_image_mime(bytes: &[u8], path: &Path) -> Option<&'static str> {
    if bytes.len() >= 3 && bytes[0..3] == [0xFF, 0xD8, 0xFF] {
        return Some("image/jpeg");
    }
    if bytes.len() >= 8 && bytes[0..8] == [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
        return Some("image/png");
    }
    if bytes.len() >= 2 && bytes[0..2] == [b'B', b'M'] {
        return Some("image/bmp");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    match path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "bmp" => Some("image/bmp"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((triple >> 18) & 0x3F) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(triple & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// 读取系统当前壁纸或用户指定的本地图片，返回安全的 Data URL 供前端背景层渲染
pub fn read_image_data(custom_path: Option<&str>) -> Result<WallpaperImageData, String> {
    let (target_path, source) = match custom_path.map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => (p.to_string(), "custom".to_string()),
        None => {
            let info = locate();
            if !info.exists || info.path.is_empty() {
                return Err("未找到可用的系统桌面壁纸".into());
            }
            (info.path, info.source)
        }
    };
    let pb = PathBuf::from(&target_path);
    crate::store::reject_link(&pb)?;
    let meta = std::fs::symlink_metadata(&pb).map_err(|_| "壁纸图片文件不存在或无法读取".to_string())?;
    if !meta.is_file() || meta.len() == 0 {
        return Err("壁纸路径不是有效的图片文件".into());
    }
    if meta.len() > MAX_WALLPAPER_BYTES {
        return Err("壁纸图片超过 24 MiB 大小限制，请选择更轻量的图片".into());
    }
    let bytes = std::fs::read(&pb).map_err(|e| format!("读取壁纸图片失败：{e}"))?;
    if bytes.len() as u64 > MAX_WALLPAPER_BYTES {
        return Err("壁纸图片超过 24 MiB 大小限制".into());
    }
    let mime = detect_image_mime(&bytes, &pb).ok_or_else(|| "不支持的图片格式（仅支持 JPG/PNG/WebP/BMP）".to_string())?;
    let encoded = base64_encode(&bytes);
    let data_url = format!("data:{mime};base64,{encoded}");
    Ok(WallpaperImageData {
        path: target_path,
        source,
        mime: mime.to_string(),
        data_url,
    })
}

