//! 本地存储：优先使用用户安装目录下的 `<安装目录>\data\`，开发/测试或只读目录回退至 `%APPDATA%\Kal\`
//!
//! 升级或重装时自动从 `%APPDATA%\Kal\` 及历史注册表 `DataDir` 无损继承设置、数据库、主题、字体、备份与日志。
//! 只写自己的数据目录，绝不碰 DesktopCal 的安装目录与原版数据库。

use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

// 窗口几何、桌面选项与本地卡片可在不同线程保存，保护整个读改写周期。
static SETTINGS_WRITE: Mutex<()> = Mutex::new(());
static JSON_WRITE: Mutex<()> = Mutex::new(());
static LOG_WRITE: Mutex<()> = Mutex::new(());
static FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static APP_DIR_STATE: OnceLock<(PathBuf, bool)> = OnceLock::new();

pub(crate) fn unique_suffix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(
        "{:x}-{:x}-{:x}",
        std::process::id(),
        nanos,
        FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

pub(crate) fn reject_link(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => {
            #[cfg(windows)]
            let linked = {
                use std::os::windows::fs::MetadataExt;
                meta.file_attributes() & 0x400 != 0
            };
            #[cfg(not(windows))]
            let linked = meta.file_type().is_symlink();
            if linked {
                return Err(format!("路径不能是链接或重解析点: {}", path.display()));
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// 传统 `%APPDATA%\Kal` 路径（用于开发构建及 v0.1.0 历史数据自动迁移与热备）
pub fn legacy_appdata_dir() -> PathBuf {
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    base.join("Kal")
}

fn is_cargo_build_dir(dir: &Path) -> bool {
    let norm = dir
        .to_string_lossy()
        .to_ascii_lowercase()
        .replace('/', "\\");
    norm.contains("\\target\\debug")
        || norm.contains("\\target\\release")
        || norm.ends_with("\\deps")
}

fn probe_dir_writable(dir: &Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(format!(".kal_probe_{}", unique_suffix()));
    match std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&probe)
    {
        Ok(mut f) => {
            let _ = f.write_all(b"ok");
            drop(f);
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

fn copy_dir_missing_recursive(src: &Path, dst: &Path) {
    if !src.is_dir() || src == dst {
        return;
    }
    let _ = std::fs::create_dir_all(dst);
    let entries = match std::fs::read_dir(src) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.eq_ignore_ascii_case("webview2")
            || name_str.ends_with(".tmp")
            || name_str.starts_with(".kal_probe_")
        {
            continue;
        }
        if reject_link(&path).is_err() {
            continue;
        }
        let target = dst.join(&name);
        if path.is_dir() {
            copy_dir_missing_recursive(&path, &target);
        } else if path.is_file() && !target.exists() {
            let _ = std::fs::copy(&path, &target);
        }
    }
}

#[cfg(windows)]
fn sync_install_registry_and_prev_dir(target_data_dir: &Path, exe_dir: Option<&Path>) -> Option<PathBuf> {
    use winreg::enums::*;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let mut prev_data_dir: Option<PathBuf> = None;
    if let Ok((key, _)) = hkcu.create_subkey("Software\\kal\\CalendarList") {
        if let Ok(existing) = key.get_value::<String, _>("DataDir") {
            let p = PathBuf::from(existing.trim());
            if !existing.trim().is_empty() && p != target_data_dir {
                prev_data_dir = Some(p);
            }
        }
        let _ = key.set_value("DataDir", &target_data_dir.to_string_lossy().to_string());
        if let Some(inst) = exe_dir {
            let cur_inst: String = key.get_value("").unwrap_or_default();
            if cur_inst.trim().is_empty() {
                let _ = key.set_value("", &inst.to_string_lossy().to_string());
            }
        }
    }
    prev_data_dir
}

#[cfg(not(windows))]
fn sync_install_registry_and_prev_dir(_target_data_dir: &Path, _exe_dir: Option<&Path>) -> Option<PathBuf> {
    None
}

fn migrate_existing_data_into(target_data_dir: &Path, exe_dir: Option<&Path>) {
    for sub in ["themes", "fonts", "sandbox", "backups", "logs"] {
        let _ = std::fs::create_dir_all(target_data_dir.join(sub));
    }
    if let Some(prev) = sync_install_registry_and_prev_dir(target_data_dir, exe_dir) {
        if prev.exists() && prev != target_data_dir {
            copy_dir_missing_recursive(&prev, target_data_dir);
        }
    }
    let legacy = legacy_appdata_dir();
    if legacy.exists() && legacy != target_data_dir {
        copy_dir_missing_recursive(&legacy, target_data_dir);
    }
}

fn resolve_app_dir_state() -> &'static (PathBuf, bool) {
    APP_DIR_STATE.get_or_init(|| {
        if let Some(custom) = std::env::var_os("KAL_DATA_DIR") {
            let custom_path = PathBuf::from(custom);
            if !custom_path.as_os_str().is_empty() && probe_dir_writable(&custom_path) {
                migrate_existing_data_into(&custom_path, None);
                return (custom_path, true);
            }
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(exe_dir) = exe.parent() {
                if !is_cargo_build_dir(exe_dir) {
                    let portable_data = exe_dir.join("data");
                    if probe_dir_writable(&portable_data) {
                        migrate_existing_data_into(&portable_data, Some(exe_dir));
                        return (portable_data, true);
                    }
                }
            }
        }
        (legacy_appdata_dir(), false)
    })
}

pub fn app_dir() -> PathBuf {
    resolve_app_dir_state().0.clone()
}

pub fn is_portable_install_dir() -> bool {
    resolve_app_dir_state().1
}

pub fn themes_dir() -> PathBuf {
    app_dir().join("themes")
}

pub fn logs_dir() -> PathBuf {
    app_dir().join("logs")
}

pub fn settings_path() -> PathBuf {
    app_dir().join("settings.json")
}

pub fn ensure_dirs() -> std::io::Result<()> {
    let base = app_dir();
    std::fs::create_dir_all(base.join("themes"))?;
    std::fs::create_dir_all(base.join("fonts"))?;
    std::fs::create_dir_all(base.join("sandbox"))?;
    std::fs::create_dir_all(base.join("backups"))?;
    std::fs::create_dir_all(base.join("logs"))
}

pub fn append_log_line(line: &str) -> Result<(), String> {
    let _guard = LOG_WRITE.lock().map_err(|_| "日志写入繁忙")?;
    let dir = logs_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let log_file = dir.join("kal.log");
    reject_link(&log_file)?;
    if let Ok(meta) = std::fs::metadata(&log_file) {
        if meta.len() > 2 * 1024 * 1024 {
            let rotated = dir.join("kal.log.1");
            let _ = std::fs::remove_file(&rotated);
            let _ = std::fs::rename(&log_file, &rotated);
        }
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file)
        .map_err(|e| e.to_string())?;
    let clean = line.trim().replace(['\r', '\n'], " ");
    writeln!(f, "{clean}").map_err(|e| e.to_string())?;
    Ok(())
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
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
        own_temp = true;
        file.write_all(s.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        // Read back before publication; settings remains the commit point, not this file.
        if read_json(&tmp).as_ref() != Some(v) {
            return Err("临时 JSON 校验失败".into());
        }
        if new_only {
            // hard_link is an exclusive publication: it fails if the destination exists,
            // including in another process, unlike a replacing rename.
            std::fs::hard_link(&tmp, path).map_err(|e| format!("文件已存在或无法创建: {e}"))?;
            Ok(())
        } else {
            std::fs::rename(&tmp, path).map_err(|e| e.to_string())
        }
    })();
    if own_temp {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

pub fn read_settings() -> Value {
    read_json(&settings_path()).unwrap_or_else(|| {
        // 若安装目录首次读取为空但旧版 %APPDATA%\Kal\settings.json 存在，则自动继承并落盘
        let legacy_path = legacy_appdata_dir().join("settings.json");
        if legacy_path != settings_path() {
            if let Some(v) = read_json(&legacy_path) {
                let _ = write_json(&settings_path(), &v);
                return v;
            }
        }
        serde_json::json!({ "schema": "kal.settings/1" })
    })
}

/// 浅合并一层：`{"ui":{"scale":1.1}}` 这种补丁式更新，前端不用回传整份设置
pub fn merge_settings(patch: &Value) -> Result<Value, String> {
    merge_settings_at(&settings_path(), patch)
}

pub(crate) fn merge_settings_at(path: &PathBuf, patch: &Value) -> Result<Value, String> {
    let _guard = SETTINGS_WRITE
        .lock()
        .map_err(|_| "设置暂时无法保存，请重新启动 Kal")?;
    let mut cur = match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str::<Value>(&s).map_err(|_| "现有设置不是合法 JSON，未覆盖")?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let legacy_path = legacy_appdata_dir().join("settings.json");
            if path == &settings_path() && legacy_path != *path {
                read_json(&legacy_path)
                    .unwrap_or_else(|| serde_json::json!({ "schema": "kal.settings/1" }))
            } else {
                serde_json::json!({ "schema": "kal.settings/1" })
            }
        }
        Err(e) => return Err(format!("无法读取现有设置，未覆盖: {e}")),
    };
    if !cur.is_object() || !patch.is_object() {
        return Err("设置必须是 JSON 对象".into());
    }
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
    // 同步热备一份设置到 %APPDATA%\Kal\settings.json，防止用户误删安装目录后重装丢失配置
    if path == &settings_path() && is_portable_install_dir() {
        let legacy_path = legacy_appdata_dir().join("settings.json");
        if legacy_path != *path {
            let _ = write_json(&legacy_path, &cur);
        }
    }
    Ok(cur)
}

/// 主题文件名消毒：只允许字母数字与 -_ ，防止路径穿越
pub fn safe_id(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let s = s.trim_matches('_').to_string();
    if s.is_empty() {
        "theme".into()
    } else {
        s
    }
}
