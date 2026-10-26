//! 本地存储：`%APPDATA%\Kal\` 下的设置与主题文件
//!
//! 只写自己的目录，绝不碰 DesktopCal 的安装目录与数据库。

use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::io::Write;
use std::path::Path;

// 窗口几何、桌面选项与本地卡片可在不同线程保存，保护整个读改写周期。
static SETTINGS_WRITE: Mutex<()> = Mutex::new(());
static JSON_WRITE: Mutex<()> = Mutex::new(());
static FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(crate) fn unique_suffix() -> String {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos()).unwrap_or(0);
    format!("{:x}-{:x}-{:x}", std::process::id(), nanos, FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed))
}

pub(crate) fn reject_link(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => {
            #[cfg(windows)]
            let linked = { use std::os::windows::fs::MetadataExt; meta.file_attributes() & 0x400 != 0 };
            #[cfg(not(windows))]
            let linked = meta.file_type().is_symlink();
            if linked { return Err(format!("路径不能是链接或重解析点: {}", path.display())); }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn app_dir() -> PathBuf {
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    base.join("Kal")
}

pub fn themes_dir() -> PathBuf {
    app_dir().join("themes")
}

pub fn settings_path() -> PathBuf {
    app_dir().join("settings.json")
}

pub fn ensure_dirs() -> std::io::Result<()> {
    std::fs::create_dir_all(themes_dir())?;
    std::fs::create_dir_all(app_dir().join("fonts"))
}

pub fn read_json(path: &PathBuf) -> Option<Value> {
    let s = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&s).ok()
}

pub fn write_json(path: &PathBuf, v: &Value) -> Result<(), String> {
    write_json_mode(path, v, false)
}

/// Publish a complete new JSON file without replacing an existing user file.
pub(crate) fn write_new_json(path: &PathBuf, v: &Value) -> Result<(), String> {
    write_json_mode(path, v, true)
}

fn write_json_mode(path: &PathBuf, v: &Value, new_only: bool) -> Result<(), String> {
    let _guard = JSON_WRITE.lock().map_err(|_| "本地文件暂时无法保存")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let s = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    reject_link(path)?;
    // Unique create_new temporary file; a failed operation only removes its own temp.
    let tmp = path.with_extension(format!("json.{}.tmp", unique_suffix()));
    let mut own_temp = false;
    let result = (|| {
        let mut file = std::fs::OpenOptions::new().create_new(true).write(true).open(&tmp).map_err(|e| e.to_string())?;
        own_temp = true;
        file.write_all(s.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        // Read back before publication; settings remains the commit point, not this file.
        if read_json(&tmp).as_ref() != Some(v) { return Err("临时 JSON 校验失败".into()); }
        if new_only {
            // hard_link is an exclusive publication: it fails if the destination exists,
            // including in another process, unlike a replacing rename.
            std::fs::hard_link(&tmp, path).map_err(|e| format!("文件已存在或无法创建: {e}"))?;
            Ok(())
        } else {
            std::fs::rename(&tmp, path).map_err(|e| e.to_string())
        }
    })();
    if own_temp { let _ = std::fs::remove_file(&tmp); }
    result
}

pub fn read_settings() -> Value {
    read_json(&settings_path()).unwrap_or_else(|| serde_json::json!({ "schema": "kal.settings/1" }))
}

/// 浅合并一层：`{"ui":{"scale":1.1}}` 这种补丁式更新，前端不用回传整份设置
pub fn merge_settings(patch: &Value) -> Result<Value, String> {
    merge_settings_at(&settings_path(), patch)
}

pub(crate) fn merge_settings_at(path: &PathBuf, patch: &Value) -> Result<Value, String> {
    let _guard = SETTINGS_WRITE.lock().map_err(|_| "设置暂时无法保存，请重新启动 Kal")?;
    let mut cur = match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str::<Value>(&s).map_err(|_| "现有设置不是合法 JSON，未覆盖")?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({ "schema": "kal.settings/1" }),
        Err(e) => return Err(format!("无法读取现有设置，未覆盖: {e}")),
    };
    if !cur.is_object() || !patch.is_object() { return Err("设置必须是 JSON 对象".into()); }
    if let (Some(a), Some(b)) = (cur.as_object_mut(), patch.as_object()) {
        for (k, v) in b {
            match (a.get_mut(k), v) {
                (Some(Value::Object(inner)), Value::Object(newer)) => {
                    for (k2, v2) in newer {
                        inner.insert(k2.clone(), v2.clone());
                    }
                }
                _ => {
                    a.insert(k.clone(), v.clone());
                }
            }
        }
    }
    write_json(path, &cur)?;
    Ok(cur)
}

/// 主题文件名消毒：只允许字母数字与 -_ ，防止路径穿越
pub fn safe_id(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let s = s.trim_matches('_').to_string();
    if s.is_empty() {
        "theme".into()
    } else {
        s
    }
}
