//! 字体：枚举系统已装字体族 + 调用 Windows 原生字体对话框
//!
//! 枚举走注册表（快、无 COM）；选择走 `ChooseFontW`（原生对话框，
//! 免去自己在注册表里拼「族名 + 字重 + 斜体」这套易错逻辑）。
#![allow(non_snake_case)]

use std::collections::BTreeSet;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
use winreg::RegKey;
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};

pub const MAX_FONT_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_LOADED_FONT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_SCAN_ENTRIES: usize = 2048;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFont {
    pub id: String,
    pub name: String,
    pub family: String,
    pub bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFontList {
    pub directory: String,
    pub fonts: Vec<LocalFont>,
    pub skipped: usize,
    pub max_file_bytes: u64,
    pub max_loaded_bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct LocalFontData {
    pub id: String,
    pub bytes: Vec<u8>,
}

fn linked(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0 // all reparse points, including junctions
    }
    #[cfg(not(windows))]
    { meta.file_type().is_symlink() }
}

fn font_extension(path: &Path) -> bool {
    path.extension().and_then(|s| s.to_str()).is_some_and(|s|
        ["ttf", "otf", "woff", "woff2"].contains(&s.to_ascii_lowercase().as_str()))
}

fn font_id(name: &str) -> String {
    // Reversible filename encoding gives stable, collision-free IDs without exposing paths.
    let mut id = String::from("local-");
    for byte in name.as_bytes() { id.push_str(&format!("{byte:02x}")); }
    id
}

fn checked_root(root: &Path) -> Result<Option<PathBuf>, String> {
    // Never follow a replacement Kal directory or fonts junction outside the app directory.
    for dir in [root.parent().ok_or("字体目录无效")?, root] {
        match std::fs::symlink_metadata(dir) {
            Ok(m) if linked(&m) || !m.is_dir() => return Err("私有字体目录不能是链接或重解析点".into()),
            Ok(_) => {},
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("无法检查私有字体目录：{e}")),
        }
    }
    let parent = root.parent().ok_or("字体目录无效")?;
    let canonical_parent = parent.canonicalize().map_err(|e| format!("无法检查应用目录：{e}"))?;
    let canonical = root.canonicalize().map_err(|e| format!("无法读取私有字体目录：{e}"))?;
    // Also verify canonical relationships, so swapping in a junction between metadata
    // and canonicalization cannot make an outside directory become the trusted root.
    let base = parent.parent().ok_or("应用目录无效")?.canonicalize().map_err(|e| format!("无法检查应用目录：{e}"))?;
    if Some(canonical_parent.as_path()) != parent.file_name().map(|name| base.join(name)).as_deref()
        || Some(canonical.as_path()) != root.file_name().map(|name| canonical_parent.join(name)).as_deref() {
        return Err("字体目录必须位于 Kal 应用目录内".into());
    }
    Ok(Some(canonical))
}

fn scan_local(root: &Path) -> Result<LocalFontList, String> {
    let mut result = LocalFontList {
        directory: root.to_string_lossy().into_owned(), fonts: vec![], skipped: 0,
        max_file_bytes: MAX_FONT_BYTES, max_loaded_bytes: MAX_LOADED_FONT_BYTES,
    };
    let Some(canonical) = checked_root(root)? else { return Ok(result); };
    let entries = std::fs::read_dir(root).map_err(|e| format!("无法扫描私有字体：{e}"))?;
    for (index, entry) in entries.enumerate() {
        if index >= MAX_SCAN_ENTRIES { result.skipped += 1; break; }
        let Ok(entry) = entry else { result.skipped += 1; continue; };
        let path = entry.path();
        if !font_extension(&path) { continue; }
        let Ok(meta) = std::fs::symlink_metadata(&path) else { result.skipped += 1; continue; };
        if linked(&meta) || !meta.is_file() || meta.len() == 0 || meta.len() > MAX_FONT_BYTES {
            result.skipped += 1; continue;
        }
        if path.canonicalize().ok().as_deref().and_then(Path::parent) != Some(canonical.as_path()) {
            result.skipped += 1; continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else { result.skipped += 1; continue; };
        let id = font_id(&name);
        result.fonts.push(LocalFont { family: format!("Kal-{}", id), id, name, bytes: meta.len() });
    }
    result.fonts.sort_by(|a,b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(result)
}

pub fn list_local() -> Result<LocalFontList, String> {
    scan_local(&crate::store::app_dir().join("fonts"))
}

fn read_local_from(root: &Path, id: &str) -> Result<LocalFontData, String> {
    if id.len() > 2048 || !id.starts_with("local-") || !id[6..].bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("私有字体 ID 无效".into());
    }
    // Resolve only an ID present in the bounded, revalidated catalog. No caller path is joined.
    let font = scan_local(root)?.fonts.into_iter().find(|f| f.id == id).ok_or("字体已移除、超过大小限制或不可访问，请刷新列表")?;
    let canonical_root = checked_root(root)?.ok_or("私有字体目录不存在")?;
    let path = root.join(&font.name);
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
        options.share_mode(1); // FILE_SHARE_READ: prevent replacement/writes during this read
    }
    let file = options.open(&path).map_err(|e| format!("无法打开字体：{e}"))?;
    let meta = file.metadata().map_err(|e| format!("无法检查字体：{e}"))?;
    if linked(&meta) || !meta.is_file() || meta.len() == 0 || meta.len() > MAX_FONT_BYTES {
        return Err("字体文件无效或超过 16 MiB 限制".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
        let mut buf = vec![0u16; 32768];
        let len = unsafe { GetFinalPathNameByHandleW(file.as_raw_handle(), buf.as_mut_ptr(), buf.len() as u32, 0) };
        if len == 0 || len as usize >= buf.len() || PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])).parent() != Some(canonical_root.as_path()) {
            return Err("字体文件不在私有字体目录内".into());
        }
    }
    #[cfg(not(windows))]
    if path.canonicalize().ok().as_deref().and_then(Path::parent) != Some(canonical_root.as_path()) {
        return Err("字体文件不在私有字体目录内".into());
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(MAX_FONT_BYTES + 1).read_to_end(&mut bytes).map_err(|e| format!("读取字体失败：{e}"))?;
    if bytes.len() as u64 > MAX_FONT_BYTES { return Err("字体超过 16 MiB 限制".into()); }
    Ok(LocalFontData { id: id.into(), bytes })
}

pub fn read_local(id: &str) -> Result<LocalFontData, String> {
    read_local_from(&crate::store::app_dir().join("fonts"), id)
}

fn import_local_to(root: &Path, source_path: &Path) -> Result<LocalFont, String> {
    if !font_extension(source_path) {
        return Err("仅支持导入 .ttf / .otf / .woff / .woff2 字体文件".into());
    }
    let src_meta = std::fs::symlink_metadata(source_path).map_err(|_| "所选字体文件不存在或不可读取".to_string())?;
    if linked(&src_meta) || !src_meta.is_file() || src_meta.len() == 0 || src_meta.len() > MAX_FONT_BYTES {
        return Err("字体文件无效、为链接文件或超过 16 MiB 大小限制".into());
    }
    let raw_name = source_path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("字体文件名无效")?
        .trim();
    if raw_name.is_empty() || raw_name.contains(['/', '\\', ':']) || raw_name == "." || raw_name == ".." {
        return Err("字体文件名不合法".into());
    }
    if let Some(parent) = root.parent() {
        crate::store::reject_link(parent)?;
    }
    crate::store::reject_link(root)?;
    std::fs::create_dir_all(root).map_err(|e| format!("无法创建私有字体目录：{e}"))?;
    let _ = checked_root(root)?.ok_or("私有字体目录校验未通过")?;

    let mut bytes = Vec::with_capacity(src_meta.len() as usize);
    std::fs::File::open(source_path)
        .map_err(|e| format!("无法打开源字体：{e}"))?
        .take(MAX_FONT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取源字体失败：{e}"))?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_FONT_BYTES {
        return Err("字体文件大小超出 16 MiB 限制".into());
    }

    let stem = source_path.file_stem().and_then(|s| s.to_str()).unwrap_or("font");
    let ext = source_path.extension().and_then(|s| s.to_str()).unwrap_or("ttf");
    let mut final_name = raw_name.to_string();
    let mut dest = root.join(&final_name);
    let mut seq = 1u32;
    while dest.exists() {
        // If existing file is identical in size & content, reuse it directly
        if let Ok(existing) = std::fs::read(&dest) {
            if existing == bytes {
                let id = font_id(&final_name);
                return Ok(LocalFont {
                    family: format!("Kal-{id}"),
                    id,
                    name: final_name,
                    bytes: bytes.len() as u64,
                });
            }
        }
        seq += 1;
        final_name = format!("{stem}-{seq}.{ext}");
        dest = root.join(&final_name);
    }
    crate::store::reject_link(&dest)?;
    std::fs::write(&dest, &bytes).map_err(|e| format!("写入私有字体目录失败：{e}"))?;
    let id = font_id(&final_name);
    Ok(LocalFont {
        family: format!("Kal-{id}"),
        id,
        name: final_name,
        bytes: bytes.len() as u64,
    })
}

pub fn import_local(source_path: &str) -> Result<LocalFont, String> {
    import_local_to(&crate::store::app_dir().join("fonts"), Path::new(source_path))
}


/// 从 "Arial Bold Italic (TrueType)" 这类值名里剥出字体族
fn family_of(value_name: &str) -> Option<String> {
    let mut s = value_name.trim();
    for suffix in ["(TrueType)", "(OpenType)", "(All res)", "(VGA res)", "(Plotter)", "(Bitmap)"] {
        if let Some(i) = s.find(suffix) {
            s = s[..i].trim();
        }
    }
    let mut name = s.to_string();
    // 反复剥掉尾部的字重/样式词，直到没有为止
    const STYLES: [&str; 22] = [
        "Bold Italic", "Bold Oblique", "SemiBold Italic", "Light Italic", "Thin Italic",
        "ExtraLight Italic", "Black Italic", "Medium Italic",
        "Bold", "Italic", "Oblique", "SemiBold", "Semibold", "DemiBold", "Light", "Regular",
        "Medium", "Black", "Thin", "ExtraLight", "ExtraBold", "Condensed",
    ];
    loop {
        let before = name.clone();
        for st in STYLES {
            let pat = format!(" {st}");
            if name.ends_with(&pat) {
                name.truncate(name.len() - pat.len());
                break;
            }
            let pat = format!("-{st}");
            if name.ends_with(&pat) {
                name.truncate(name.len() - pat.len());
                break;
            }
        }
        name = name.trim().to_string();
        if name == before {
            break;
        }
    }
    if name.is_empty() || name.len() > 64 {
        None
    } else {
        Some(name)
    }
}

/// 已安装字体族清单（去重、按名称排序）
pub fn list_families() -> Vec<String> {
    let mut set: BTreeSet<String> = BTreeSet::new();
    let sources = [
        (HKEY_LOCAL_MACHINE, "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts"),
        (HKEY_CURRENT_USER, "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts"),
    ];
    for (hive, path) in sources {
        let key = match RegKey::predef(hive).open_subkey(path) {
            Ok(k) => k,
            Err(_) => continue,
        };
        for item in key.enum_values().flatten() {
            if let Some(f) = family_of(&item.0) {
                set.insert(f);
            }
        }
    }
    set.into_iter().collect()
}

#[cfg(test)]
mod local_font_tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let root = std::env::temp_dir().join(format!("kal-font-test-{}-{stamp}", std::process::id())).join("Kal").join("fonts");
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            // Only this fixture's unique, generated temporary directory is removed.
            if let Some(dir) = self.0.parent().and_then(Path::parent) { let _ = std::fs::remove_dir_all(dir); }
        }
    }

    #[test]
    fn local_font_catalog_filters_types_sizes_and_keeps_stable_ids() {
        let f = Fixture::new();
        for name in ["a.ttf", "中文.OTF", "c.woff", "d.woff2", "ignored.txt"] {
            std::fs::write(f.0.join(name), b"test").unwrap();
        }
        std::fs::write(f.0.join("empty.ttf"), b"").unwrap();
        std::fs::File::create(f.0.join("huge.ttf")).unwrap().set_len(MAX_FONT_BYTES + 1).unwrap();
        std::fs::create_dir(f.0.join("directory.ttf")).unwrap();
        let list = scan_local(&f.0).unwrap();
        assert_eq!(list.fonts.len(), 4);
        assert_eq!(list.skipped, 3);
        assert_eq!(list.fonts.iter().map(|font| &font.id).collect::<Vec<_>>(), scan_local(&f.0).unwrap().fonts.iter().map(|font| &font.id).collect::<Vec<_>>());
        assert_eq!(list.max_loaded_bytes, 32 * 1024 * 1024);
    }

    #[test]
    fn local_font_reads_only_catalog_ids_and_rechecks_size() {
        let f = Fixture::new();
        std::fs::write(f.0.join("chosen.ttf"), b"font fixture").unwrap();
        let font = scan_local(&f.0).unwrap().fonts.pop().unwrap();
        assert_eq!(read_local_from(&f.0, &font.id).unwrap().bytes, b"font fixture");
        for id in ["../chosen.ttf", "C:\\Windows\\Fonts\\arial.ttf", "local-2e2e2f", "local-", "local-ff"] {
            assert!(read_local_from(&f.0, id).is_err(), "accepted {id}");
        }
        std::fs::OpenOptions::new().write(true).open(f.0.join("chosen.ttf")).unwrap().set_len(MAX_FONT_BYTES + 1).unwrap();
        assert!(read_local_from(&f.0, &font.id).is_err());
    }

    #[test]
    fn local_font_rejects_linked_files_and_directory() {
        let f = Fixture::new();
        let outside = f.0.parent().unwrap().join("outside.ttf");
        std::fs::write(&outside, b"outside").unwrap();
        #[cfg(windows)]
        let linked_file = std::os::windows::fs::symlink_file(&outside, f.0.join("escape.ttf"));
        #[cfg(not(windows))]
        let linked_file = std::os::unix::fs::symlink(&outside, f.0.join("escape.ttf"));
        if let Err(e) = linked_file { panic!("Cannot test symlink protection: {e}"); }
        assert!(scan_local(&f.0).unwrap().fonts.is_empty());
        assert!(read_local_from(&f.0, &font_id("escape.ttf")).is_err());
        let alias = f.0.parent().unwrap().join("alias");
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&f.0, &alias).unwrap();
        #[cfg(not(windows))]
        std::os::unix::fs::symlink(&f.0, &alias).unwrap();
        assert!(scan_local(&alias).is_err());
    }

    #[test]
    fn local_font_import_copies_and_deduplicates_safely() {
        let f = Fixture::new();
        let src = f.0.parent().unwrap().join("custom-font.ttf");
        std::fs::write(&src, b"ttf-payload-1").unwrap();
        let imported1 = import_local_to(&f.0, &src).unwrap();
        assert_eq!(imported1.name, "custom-font.ttf");
        assert!(imported1.id.starts_with("local-"));
        // Importing the identical file reuses the existing entry
        let imported_same = import_local_to(&f.0, &src).unwrap();
        assert_eq!(imported_same.id, imported1.id);
        // Importing a different payload with the same filename allocates a new suffix without overwriting
        std::fs::write(&src, b"ttf-payload-different").unwrap();
        let imported2 = import_local_to(&f.0, &src).unwrap();
        assert_eq!(imported2.name, "custom-font-2.ttf");
        assert_ne!(imported2.id, imported1.id);
        assert_eq!(scan_local(&f.0).unwrap().fonts.len(), 2);
    }
}

