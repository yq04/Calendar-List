//! calendar.db 访问层（原版只读 + Kal 本地沙盒独立可写层）
//!
//! 设计原则：
//!   1. 原版 DesktopCal 数据库始终以 READ_ONLY 打开，绝不直接写入原版库（严守红线）；
//!   2. 当未显式指定 `KAL_DB_PATH` 且原版 MCP 管道未启用时，默认使用 `%APPDATA%\Kal\sandbox\kal_sandbox.db`
//!      （首次自动从原版库只读克隆初始快照，并在 `%APPDATA%\Kal\backups\` 保留滚动备份）；
//!   3. 日期字段格式存在多种可能，因此用「提取 8 位数字」的宽策略做归一化，并在日期过滤后再做行切分。

use crate::model::DayItem;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static LAST_BACKUP_EPOCH_SECS: AtomicU64 = AtomicU64::new(0);

fn revision(parts: &[&str]) -> String {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    parts.hash(&mut hash);
    format!("{:016x}", hash.finish())
}

/// 剥离 DesktopCal 遗留的 IxMarkdown 内部标记
fn clean_legacy_tags(raw: &str) -> String {
    if raw.contains("<!--IxMarkdown-->") {
        raw.replace("<!--IxMarkdown-->", "").trim().to_string()
    } else {
        raw.trim().to_string()
    }
}

pub struct CalendarDb {
    path: PathBuf,
    #[cfg(test)]
    test_live: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub created: String,
    pub modified: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotePage {
    pub notes: Vec<NoteSummary>,
    pub has_more: bool,
}

#[derive(Debug, serde::Serialize)]
pub struct NoteDocument {
    pub content: String,
    pub truncated: bool,
}

fn extract_date(raw: &str) -> Option<String> {
    // 只保留数字，取前 8 位：20261012 / 2026-10-12 / 20261012T090000 均可
    let digits: String = raw.chars().filter(|c| c.is_ascii_digit()).take(8).collect();
    if digits.len() != 8 {
        return None;
    }
    let (y, m, d) = (&digits[0..4], &digits[4..6], &digits[6..8]);
    let mi: u32 = m.parse().ok()?;
    let di: u32 = d.parse().ok()?;
    let yi: u32 = y.parse().ok()?;
    let leap = yi % 4 == 0 && (yi % 100 != 0 || yi % 400 == 0);
    let max_day = match mi {
        2 => if leap { 29 } else { 28 },
        4 | 6 | 9 | 11 => 30,
        1..=12 => 31,
        _ => 0,
    };
    if yi == 0 || di == 0 || di > max_day {
        return None;
    }
    Some(format!("{}-{}-{}", y, m, d))
}

fn key(data: &str) -> String {
    data.chars().filter(|c| c.is_ascii_digit()).take(8).collect()
}

/// Validate the public range format, then compute a Gregorian day ordinal.
/// Database dates continue to use extract_date's established normalization.
fn range_day_number(date: &str) -> Result<i32, String> {
    let bytes = date.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes
            .iter()
            .enumerate()
            .any(|(i, c)| i != 4 && i != 7 && !c.is_ascii_digit())
        || extract_date(date).as_deref() != Some(date)
    {
        return Err("日期范围必须使用真实的 YYYY-MM-DD 日期".into());
    }
    let year: i32 = date[..4].parse().map_err(|_| "年份无效")?;
    let month: usize = date[5..7].parse().map_err(|_| "月份无效")?;
    let day: i32 = date[8..].parse().map_err(|_| "日期无效")?;
    let prior_year = year - 1;
    let before_month = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    Ok(prior_year * 365 + prior_year / 4 - prior_year / 100 + prior_year / 400
        + before_month[month - 1]
        + i32::from(leap && month > 2)
        + day)
}

fn col(conn: &Connection, table: &str) -> Vec<String> {
    let mut out = Vec::new();
    let sql = format!("PRAGMA table_info({table})");
    if let Ok(mut st) = conn.prepare(&sql) {
        if let Ok(rows) = st.query_map([], |r| r.get::<_, String>(1)) {
            for n in rows.flatten() {
                out.push(n);
            }
        }
    }
    out
}

pub fn sandbox_db_path() -> PathBuf {
    crate::store::app_dir().join("sandbox").join("kal_sandbox.db")
}

pub fn backups_dir() -> PathBuf {
    crate::store::app_dir().join("backups")
}

fn ensure_sandbox_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS item_table (
            it_id INTEGER PRIMARY KEY AUTOINCREMENT,
            it_unique_id TEXT,
            it_content TEXT,
            it_appinfo TEXT DEFAULT '{}',
            u_id INTEGER DEFAULT 0,
            group_id TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS event_table (
            ev_id INTEGER PRIMARY KEY AUTOINCREMENT,
            ev_content TEXT,
            ev_date TEXT,
            ev_start_date TEXT,
            ev_status INTEGER DEFAULT 0,
            u_id INTEGER DEFAULT 0,
            ev_unique_id TEXT DEFAULT '',
            group_id TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS note_table (
            nt_id INTEGER PRIMARY KEY AUTOINCREMENT,
            nt_title TEXT,
            nt_content TEXT,
            nt_cdate TEXT,
            nt_mdate TEXT
        );
        CREATE TABLE IF NOT EXISTS setting_table (
            st_id INTEGER PRIMARY KEY AUTOINCREMENT,
            st_name TEXT,
            st_sval TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_kal_item_uid ON item_table(it_unique_id);
        CREATE INDEX IF NOT EXISTS idx_kal_event_date ON event_table(ev_date);
        ",
    )
    .map_err(|e| format!("初始化本地沙盒数据库表结构失败: {e}"))
}

pub fn ensure_sandbox_db() -> Result<PathBuf, String> {
    let sb_path = sandbox_db_path();
    if let Some(parent) = sb_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("无法创建沙盒目录: {e}"))?;
    }
    if !sb_path.is_file() {
        let legacy_sb = crate::store::legacy_appdata_dir()
            .join("sandbox")
            .join("kal_sandbox.db");
        if legacy_sb != sb_path && legacy_sb.is_file() {
            let _ = std::fs::copy(&legacy_sb, &sb_path);
        }
        if !sb_path.is_file() {
            if let Some(orig) = CalendarDb::locate_readonly_source() {
                if orig.is_file() {
                    let _ = std::fs::copy(&orig, &sb_path);
                }
            }
        }
    }
    let conn = Connection::open(&sb_path).map_err(|e| format!("打开本地沙盒数据库失败: {e}"))?;
    ensure_sandbox_schema(&conn)?;
    Ok(sb_path)
}

impl CalendarDb {
    /// 仅定位原版只读数据库（不看环境变量）
    pub fn locate_readonly_source() -> Option<PathBuf> {
        let candidates = [
            r"D:\1_app\CalendarTask\Db\calendar.db",
            r"C:\Program Files\CalendarTask\Db\calendar.db",
            r"C:\Program Files (x86)\CalendarTask\Db\calendar.db",
        ];
        for c in candidates {
            let pb = PathBuf::from(c);
            if pb.is_file() {
                return Some(pb);
            }
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let pb = dir.join("Db").join("calendar.db");
                if pb.is_file() {
                    return Some(pb);
                }
            }
        }
        None
    }

    /// 定位数据库：环境变量 > 原版路径 > 本地沙盒数据库
    pub fn locate() -> Option<PathBuf> {
        if let Ok(p) = std::env::var("KAL_DB_PATH") {
            let pb = PathBuf::from(p);
            // 显式路径不可用时仍交给 open 报错，禁止悄悄切回真实数据源。
            return Some(pb);
        }
        if let Some(orig) = Self::locate_readonly_source() {
            return Some(orig);
        }
        let sb = sandbox_db_path();
        if sb.is_file() {
            return Some(sb);
        }
        None
    }

    pub fn open(path: PathBuf) -> Result<Self, String> {
        if !path.is_file() {
            return Err(format!("数据库不存在: {}", path.display()));
        }
        Ok(Self {
            path,
            #[cfg(test)]
            test_live: false,
        })
    }

    #[cfg(test)]
    pub fn open_for_test(path: PathBuf) -> Result<Self, String> {
        let mut s = Self::open(path)?;
        s.test_live = true;
        Ok(s)
    }

    pub fn is_sandbox(&self) -> bool {
        self.path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|name| name == "kal_sandbox.db" || name.starts_with("kal-sandbox-"))
    }

    fn conn(&self) -> Result<Connection, String> {
        Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| format!("打开数据库失败: {e}"))
    }

    fn conn_rw(&self) -> Result<Connection, String> {
        if !self.is_sandbox() {
            return Err("安全红线拦截：严禁直接写入非沙盒数据库".into());
        }
        let conn = Connection::open(&self.path).map_err(|e| format!("打开沙盒数据库失败: {e}"))?;
        ensure_sandbox_schema(&conn)?;
        Ok(conn)
    }

    fn backup_sandbox_if_needed(&self) {
        if !self.is_sandbox() || !self.path.is_file() {
            return;
        }
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let prev = LAST_BACKUP_EPOCH_SECS.load(Ordering::Relaxed);
        if prev != 0 && now_secs.saturating_sub(prev) < 600 {
            return;
        }
        LAST_BACKUP_EPOCH_SECS.store(now_secs, Ordering::Relaxed);
        let bdir = backups_dir();
        if std::fs::create_dir_all(&bdir).is_err() {
            return;
        }
        let dest = bdir.join(format!("kal_sandbox_{now_secs}.db"));
        let _ = std::fs::copy(&self.path, &dest);
        self.sync_portable_shadow();

        // 保留最近 20 份备份
        if let Ok(entries) = std::fs::read_dir(&bdir) {
            let mut files: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.extension().and_then(|s| s.to_str()) == Some("db")
                        && p.file_name()
                            .and_then(|n| n.to_str())
                            .is_some_and(|n| n.starts_with("kal_sandbox_"))
                })
                .collect();
            files.sort();
            if files.len() > 20 {
                let remove_count = files.len() - 20;
                for old in files.into_iter().take(remove_count) {
                    let _ = std::fs::remove_file(old);
                }
            }
        }
    }

    pub fn sync_portable_shadow(&self) {
        if !self.is_sandbox() || !crate::store::is_portable_install_dir() || !self.path.is_file() {
            return;
        }
        let legacy_sb = crate::store::legacy_appdata_dir()
            .join("sandbox")
            .join("kal_sandbox.db");
        if legacy_sb != self.path {
            if let Some(p) = legacy_sb.parent() {
                let _ = std::fs::create_dir_all(p);
            }
            let _ = std::fs::copy(&self.path, &legacy_sb);
        }
    }

    pub fn is_live_source(&self) -> bool {
        #[cfg(test)]
        if self.test_live {
            return true;
        }
        if self.is_sandbox() {
            return true;
        }
        // 测试库和任意外部副本永远不能把编辑转发到真实宿主。
        let Some(path) = self.path.canonicalize().ok() else {
            return false;
        };
        [
            r"D:\1_app\CalendarTask\Db\calendar.db",
            r"C:\Program Files\CalendarTask\Db\calendar.db",
            r"C:\Program Files (x86)\CalendarTask\Db\calendar.db",
        ]
        .iter()
        .filter_map(|p| std::path::Path::new(p).canonicalize().ok())
        .any(|p| p == path)
    }

    pub fn search_items(&self, query: &str) -> Result<Vec<DayItem>, String> {
        let query = query
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        if query.chars().count() > 200 {
            return Err("搜索内容过长".into());
        }
        let words: Vec<_> = query.split_whitespace().collect();
        let mut items: Vec<_> = self
            .all_items()?
            .into_iter()
            .filter(|item| {
                let tag = match item.kind.as_str() {
                    "note" => "便签 note",
                    "event" => "日程 event",
                    _ => "任务 item",
                };
                let text = format!("{} {} {} {tag}", item.date, item.time, item.title).to_lowercase();
                words.iter().all(|word| text.contains(word))
            })
            .collect();
        items.sort_by(|a, b| (&a.date, &a.time, &a.title).cmp(&(&b.date, &b.time, &b.title)));
        items.truncate(100);
        Ok(items)
    }

    pub fn item_cell_text(&self, id: &str) -> Result<String, String> {
        let row = id
            .strip_prefix("it-")
            .and_then(|id| id.split_once(':'))
            .and_then(|(row, _)| row.parse::<i64>().ok())
            .ok_or_else(|| "任务行标识无效".to_string())?;
        self.conn()?
            .query_row(
                "SELECT it_content FROM item_table WHERE it_id=?1",
                [row],
                |r| r.get::<_, Option<String>>(0),
            )
            .map(|value| value.unwrap_or_default())
            .map_err(|_| "任务已不存在，请刷新".into())
    }

    pub fn calendar_day_text(&self, date: &str, calendar_id: &str) -> Result<String, String> {
        let user: i64 = calendar_id.parse().map_err(|_| "日历标识无效")?;
        let conn = self.conn()?;
        let columns = col(&conn, "item_table");
        if !["u_id", "group_id"]
            .iter()
            .all(|name| columns.iter().any(|v| v == name))
        {
            return Err("数据源缺少日历作用域信息".into());
        }
        let mut statement = conn
            .prepare(
                "SELECT it_unique_id,it_content FROM item_table WHERE u_id=?1 AND coalesce(group_id,'')='' ",
            )
            .map_err(|e| e.to_string())?;
        let records = statement
            .query_map([user], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .map_err(|e| e.to_string())?;
        let mut matched = Vec::new();
        for record in records {
            let (raw, text) = record.map_err(|e| e.to_string())?;
            if extract_date(&raw).as_deref() == Some(date) {
                matched.push(text.unwrap_or_default());
            }
        }
        if matched.len() > 1 {
            return Err("该日期存在多个数据分组，暂只支持查看".into());
        }
        Ok(matched.pop().unwrap_or_default())
    }

    pub fn table_names(&self) -> Result<Vec<String>, String> {
        let c = self.conn()?;
        let mut st = c
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .map_err(|e| e.to_string())?;
        let it = st
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        Ok(it.filter_map(|x| x.ok()).collect())
    }

    /// 读取 DesktopCal AI MCP 凭证。值只在内存中短暂使用，不写入日志或前端。
    pub fn aimcp_token(&self) -> Result<Option<String>, String> {
        let c = self.conn()?;
        if !col(&c, "setting_table").iter().any(|x| x == "st_sval") {
            return Ok(None);
        }
        let value = c
            .query_row(
                "SELECT st_sval FROM setting_table WHERE st_name = 'sys_aimcp_token' LIMIT 1",
                [],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .flatten()
            .filter(|s| !s.trim().is_empty());
        Ok(value)
    }

    fn count(&self, table: &str) -> i64 {
        let Ok(c) = self.conn() else { return -1 };
        c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap_or(-1)
    }

    pub fn month_items(&self, year: i32, month: u32) -> Result<Vec<DayItem>, String> {
        let prefix = format!("{:04}{:02}", year, month);
        self.items_filtered(|date| key(date).starts_with(&prefix))
    }

    pub fn day_items(&self, date: &str) -> Result<Vec<DayItem>, String> {
        let want = key(date);
        self.items_filtered(|d| key(d) == want)
    }

    /// Inclusive visible-date interval, at most 93 natural days. Normalize all
    /// records once before filtering so row indices, revisions and scope remain intact.
    pub fn range_items(&self, start: &str, end: &str) -> Result<Vec<DayItem>, String> {
        let first = range_day_number(start)?;
        let last = range_day_number(end)?;
        if last < first || last - first >= 93 {
            return Err("日期范围必须按先后排序，且最多包含 93 天".into());
        }
        self.items_filtered(|date| date >= start && date <= end)
    }

    /// 不依赖创建日期的便签浏览；列表只取摘要，正文在展开时读取。
    pub fn notes_page(&self, offset: u32) -> Result<NotePage, String> {
        if offset > 1_000_000 {
            return Err("便签分页位置无效".into());
        }
        let c = self.conn()?;
        let columns = col(&c, "note_table");
        if columns.is_empty() {
            return Ok(NotePage {
                notes: vec![],
                has_more: false,
            });
        }
        if !["nt_id", "nt_title"]
            .iter()
            .all(|n| columns.iter().any(|v| v == n))
        {
            return Err("当前便签数据格式暂不支持".into());
        }
        let field = |name: &str| {
            if columns.iter().any(|v| v == name) {
                format!("coalesce({name},'')")
            } else {
                "''".to_string()
            }
        };
        let sql = format!(
            "SELECT nt_id,substr(coalesce(nt_title,''),1,1000),substr({},1,160),{},{} \
             FROM note_table ORDER BY {} DESC,nt_id DESC LIMIT 51 OFFSET ?1",
            field("nt_content"),
            field("nt_cdate"),
            field("nt_mdate"),
            field(if columns.iter().any(|v| v == "nt_mdate") {
                "nt_mdate"
            } else {
                "nt_cdate"
            }),
        );
        let mut st = c.prepare(&sql).map_err(|_| "便签列表读取失败")?;
        let records = st
            .query_map([offset], |r| {
                Ok(NoteSummary {
                    id: format!("nt-{}", r.get::<_, i64>(0)?),
                    title: r.get(1)?,
                    preview: r.get(2)?,
                    created: r.get(3)?,
                    modified: r.get(4)?,
                })
            })
            .map_err(|_| "便签列表读取失败")?;
        let mut notes = records
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "便签列表读取失败")?;
        let has_more = notes.len() > 50;
        notes.truncate(50);
        Ok(NotePage { notes, has_more })
    }

    pub fn note_document(&self, id: &str) -> Result<NoteDocument, String> {
        let row = id
            .strip_prefix("nt-")
            .and_then(|s| s.parse::<i64>().ok())
            .filter(|n| *n > 0)
            .ok_or("便签标识无效")?;
        let c = self.conn()?;
        if !col(&c, "note_table").iter().any(|v| v == "nt_content") {
            return Err("当前数据源没有便签正文".into());
        }
        c.query_row(
            "SELECT substr(coalesce(nt_content,''),1,262144),length(coalesce(nt_content,''))>262144 FROM note_table WHERE nt_id=?1",
            [row],
            |r| {
                Ok(NoteDocument {
                    content: r.get(0)?,
                    truncated: r.get(1)?,
                })
            },
        )
        .map_err(|_| "便签已不存在或暂时无法读取，请刷新".into())
    }

    /// 全量读取并归一化
    pub fn all_items(&self) -> Result<Vec<DayItem>, String> {
        self.items_filtered(|_| true)
    }

    /// 按日期断言前置过滤，避免对非目标日期的记录做字符串切分、JSON 解析和哈希计算
    fn items_filtered<F>(&self, date_pred: F) -> Result<Vec<DayItem>, String>
    where
        F: Fn(&str) -> bool,
    {
        let c = self.conn()?;
        let mut out: Vec<DayItem> = Vec::new();
        let live = self.is_live_source();
        let sandbox = self.is_sandbox();

        // ---- 1) event_table：日程事件 ----
        let ev_cols = col(&c, "event_table");
        if ev_cols.iter().any(|x| x == "ev_content") {
            let scoped = ["u_id", "ev_unique_id", "group_id"]
                .iter()
                .all(|name| ev_cols.iter().any(|v| v == name));
            let sql = if scoped {
                "SELECT ev_id, ev_content, ev_date, ev_start_date, ev_status, u_id, ev_unique_id, group_id FROM event_table"
            } else {
                "SELECT ev_id, ev_content, ev_date, ev_start_date, ev_status, NULL, '', '' FROM event_table"
            };
            let mut st = c.prepare(sql).map_err(|e| e.to_string())?;
            let rows = st
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0).unwrap_or(0),
                        r.get::<_, Option<String>>(1).unwrap_or(None),
                        r.get::<_, Option<String>>(2).unwrap_or(None),
                        r.get::<_, Option<String>>(3).unwrap_or(None),
                        r.get::<_, Option<i64>>(4).unwrap_or(None),
                        r.get::<_, Option<i64>>(5).unwrap_or(None),
                        r.get::<_, String>(6).unwrap_or_default(),
                        r.get::<_, String>(7).unwrap_or_default(),
                    ))
                })
                .map_err(|e| e.to_string())?;
            for row in rows.flatten() {
                let (id, content, ev_date, start, status, user, remote_id, group) = row;
                let src = start
                    .filter(|s| !s.is_empty())
                    .or_else(|| ev_date.filter(|s| !s.is_empty()));
                let Some(ds) = src else { continue };
                let Some(date) = extract_date(&ds) else {
                    continue;
                };
                if !date_pred(&date) {
                    continue;
                }
                let time = match ds.find([' ', 'T']) {
                    Some(p) => ds[p + 1..].chars().take(5).collect::<String>(),
                    None => String::new(),
                };
                let content = content.unwrap_or_default();
                let rev = revision(&[
                    &content,
                    &ds,
                    &status.unwrap_or(0).to_string(),
                    &remote_id,
                    &group,
                ]);
                let editable = sandbox
                    || (live && scoped && user.is_some() && group.is_empty() && !remote_id.is_empty());
                out.push(DayItem {
                    date,
                    time: if time.contains(':') {
                        time
                    } else {
                        String::new()
                    },
                    title: clean_legacy_tags(&content),
                    done: status.unwrap_or(0) != 0,
                    kind: "event".into(),
                    id: format!("ev-{id}"),
                    can_edit: editable,
                    can_delete: editable,
                    can_complete: sandbox,
                    calendar_id: user.map(|v| v.to_string()).unwrap_or_default(),
                    remote_id,
                    revision: rev,
                });
            }
        }

        // ---- 2) item_table：日格内的普通任务行 ----
        let item_cols = col(&c, "item_table");
        if item_cols.iter().any(|x| x == "it_content") {
            let scoped = ["u_id", "group_id"]
                .iter()
                .all(|name| item_cols.iter().any(|v| v == name));
            let sql = if scoped {
                "SELECT it_id, it_unique_id, it_content, it_appinfo, u_id, group_id FROM item_table"
            } else {
                "SELECT it_id, it_unique_id, it_content, it_appinfo, NULL, '' FROM item_table"
            };
            let mut st = c.prepare(sql).map_err(|e| e.to_string())?;
            let rows = st
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0).unwrap_or(0),
                        r.get::<_, String>(1).unwrap_or_default(),
                        r.get::<_, Option<String>>(2).unwrap_or(None),
                        r.get::<_, Option<String>>(3).unwrap_or(None),
                        r.get::<_, Option<i64>>(4).unwrap_or(None),
                        r.get::<_, String>(5).unwrap_or_default(),
                    ))
                })
                .map_err(|e| e.to_string())?;
            let rows: Vec<_> = rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
            let mut scopes = std::collections::HashMap::new();
            for (_, uid, _, _, user, group) in &rows {
                if let Some(date) = extract_date(uid) {
                    *scopes.entry((date, *user, group.clone())).or_insert(0usize) += 1;
                }
            }
            for row in rows {
                let (id, uid, content, appinfo, user, group) = row;
                let Some(date) = extract_date(&uid) else {
                    continue;
                };
                if !date_pred(&date) {
                    continue;
                }
                let text = content.unwrap_or_default();
                let rev = revision(&[&text, appinfo.as_deref().unwrap_or(""), &uid, &group]);
                let editable = sandbox
                    || (live
                        && scoped
                        && user.is_some()
                        && group.is_empty()
                        && scopes.get(&(date.clone(), user, group.clone())) == Some(&1));
                let done = appinfo
                    .as_deref()
                    .and_then(|a| serde_json::from_str::<serde_json::Value>(a).ok())
                    .and_then(|a| a.get("done").and_then(serde_json::Value::as_bool))
                    .unwrap_or(false);
                for (line_idx, raw_line) in text.split('\n').enumerate() {
                    let raw_line = raw_line.trim();
                    if raw_line.is_empty() {
                        continue;
                    }
                    let line_done =
                        raw_line.starts_with("~~") && raw_line.ends_with("~~") && raw_line.len() >= 4;
                    let raw_title = if line_done {
                        raw_line[2..raw_line.len() - 2].trim()
                    } else {
                        raw_line
                    };
                    let title = clean_legacy_tags(raw_title);
                    if title.is_empty() {
                        continue;
                    }
                    out.push(DayItem {
                        date: date.clone(),
                        time: String::new(),
                        title,
                        done: done || line_done,
                        kind: "item".into(),
                        id: format!("it-{id}:{line_idx}"),
                        can_edit: editable,
                        can_delete: editable,
                        can_complete: editable,
                        calendar_id: user.map(|v| v.to_string()).unwrap_or_default(),
                        remote_id: String::new(),
                        revision: rev.clone(),
                    });
                }
            }
        }

        // ---- 3) note_table：便签 ----
        if col(&c, "note_table").iter().any(|x| x == "nt_title") {
            let mut st = c
                .prepare("SELECT nt_id, nt_title, nt_cdate FROM note_table")
                .map_err(|e| e.to_string())?;
            let rows = st
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0).unwrap_or(0),
                        r.get::<_, Option<String>>(1).unwrap_or(None),
                        r.get::<_, Option<String>>(2).unwrap_or(None),
                    ))
                })
                .map_err(|e| e.to_string())?;
            for row in rows.flatten() {
                let (id, title, cdate) = row;
                let Some(ds) = cdate else { continue };
                let Some(date) = extract_date(&ds) else {
                    continue;
                };
                if !date_pred(&date) {
                    continue;
                }
                out.push(DayItem {
                    date,
                    time: String::new(),
                    title: format!("[便签] {}", clean_legacy_tags(&title.unwrap_or_default())),
                    done: false,
                    kind: "note".into(),
                    id: format!("nt-{id}"),
                    can_edit: false,
                    can_delete: false,
                    can_complete: false,
                    calendar_id: String::new(),
                    remote_id: String::new(),
                    revision: String::new(),
                });
            }
        }

        out.sort_by(|a, b| (a.date.clone(), a.time.clone()).cmp(&(b.date.clone(), b.time.clone())));
        Ok(out)
    }

    // ---------------------------------------------------------------- 本地沙盒直写引擎

    pub fn sandbox_create(&self, date: &str, value: &str, time: &str) -> Result<(), String> {
        let conn = self.conn_rw()?;
        self.backup_sandbox_if_needed();
        let clean_title = value.trim();
        let clean_time = time.trim();

        if !clean_time.is_empty() {
            let start_dt = format!("{date}T{clean_time}:00+08:00");
            let uid = format!("kal-ev-{}", crate::store::unique_suffix());
            conn.execute(
                "INSERT INTO event_table (ev_content, ev_date, ev_start_date, ev_status, u_id, ev_unique_id, group_id) \
                 VALUES (?1, ?2, ?3, 0, 0, ?4, '')",
                rusqlite::params![clean_title, date, start_dt, uid],
            )
            .map_err(|e| format!("保存日程事件失败: {e}"))?;
            drop(conn);
            self.sync_portable_shadow();
            return Ok(());
        }

        // 查找当天是否已有默认分组行
        let mut st = conn
            .prepare("SELECT it_id, it_unique_id, coalesce(it_content, '') FROM item_table WHERE coalesce(group_id, '') = ''")
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        let mut target_row: Option<(i64, String)> = None;
        for r in rows.flatten() {
            if extract_date(&r.1).as_deref() == Some(date) {
                target_row = Some((r.0, r.2));
                break;
            }
        }
        drop(st);

        if let Some((row_id, existing)) = target_row {
            let trimmed = existing.trim_end_matches(['\r', '\n']);
            let next_content = if trimmed.is_empty() {
                clean_title.to_string()
            } else {
                format!("{trimmed}\r\n{clean_title}")
            };
            conn.execute(
                "UPDATE item_table SET it_content = ?1 WHERE it_id = ?2",
                rusqlite::params![next_content, row_id],
            )
            .map_err(|e| format!("追加任务失败: {e}"))?;
        } else {
            let uid = key(date);
            conn.execute(
                "INSERT INTO item_table (it_unique_id, it_content, it_appinfo, u_id, group_id) VALUES (?1, ?2, '{}', 0, '')",
                rusqlite::params![uid, clean_title],
            )
            .map_err(|e| format!("新建任务失败: {e}"))?;
        }
        drop(conn);
        self.sync_portable_shadow();
        Ok(())
    }

    pub fn sandbox_update(&self, id: &str, _date: &str, new_title: &str) -> Result<(), String> {
        let conn = self.conn_rw()?;
        self.backup_sandbox_if_needed();
        let clean_title = new_title.trim();

        if let Some(ev_id_str) = id.strip_prefix("ev-") {
            let ev_id: i64 = ev_id_str.parse().map_err(|_| "事件 ID 无效")?;
            let changed = conn
                .execute(
                    "UPDATE event_table SET ev_content = ?1 WHERE ev_id = ?2",
                    rusqlite::params![clean_title, ev_id],
                )
                .map_err(|e| format!("更新事件失败: {e}"))?;
            if changed == 0 {
                return Err("日程不存在，请刷新后重试".into());
            }
            return Ok(());
        }

        let (row_id, line_idx) = id
            .strip_prefix("it-")
            .and_then(|s| s.split_once(':'))
            .and_then(|(r, l)| Some((r.parse::<i64>().ok()?, l.parse::<usize>().ok()?)))
            .ok_or_else(|| "任务行标识无效".to_string())?;

        let existing: String = conn
            .query_row(
                "SELECT coalesce(it_content, '') FROM item_table WHERE it_id = ?1",
                [row_id],
                |r| r.get(0),
            )
            .map_err(|_| "任务不存在，请刷新后重试".to_string())?;

        let mut lines: Vec<String> = existing
            .split('\n')
            .map(|l| l.trim_end_matches('\r').to_string())
            .collect();
        if line_idx >= lines.len() {
            return Err("任务行号超出范围，请刷新后重试".into());
        }
        let raw = lines[line_idx].trim();
        let is_done = raw.starts_with("~~") && raw.ends_with("~~") && raw.len() >= 4;
        lines[line_idx] = if is_done {
            format!("~~{clean_title}~~")
        } else {
            clean_title.to_string()
        };
        let next_content = lines.join("\r\n");
        conn.execute(
            "UPDATE item_table SET it_content = ?1 WHERE it_id = ?2",
            rusqlite::params![next_content, row_id],
        )
        .map_err(|e| format!("保存修改失败: {e}"))?;
        drop(conn);
        self.sync_portable_shadow();
        Ok(())
    }

    pub fn sandbox_toggle(&self, id: &str, _date: &str, done: bool) -> Result<(), String> {
        let conn = self.conn_rw()?;
        self.backup_sandbox_if_needed();

        if let Some(ev_id_str) = id.strip_prefix("ev-") {
            let ev_id: i64 = ev_id_str.parse().map_err(|_| "事件 ID 无效")?;
            let status_val = if done { 1 } else { 0 };
            conn.execute(
                "UPDATE event_table SET ev_status = ?1 WHERE ev_id = ?2",
                rusqlite::params![status_val, ev_id],
            )
            .map_err(|e| format!("更新事件完成状态失败: {e}"))?;
            return Ok(());
        }

        let (row_id, line_idx) = id
            .strip_prefix("it-")
            .and_then(|s| s.split_once(':'))
            .and_then(|(r, l)| Some((r.parse::<i64>().ok()?, l.parse::<usize>().ok()?)))
            .ok_or_else(|| "任务行标识无效".to_string())?;

        let existing: String = conn
            .query_row(
                "SELECT coalesce(it_content, '') FROM item_table WHERE it_id = ?1",
                [row_id],
                |r| r.get(0),
            )
            .map_err(|_| "任务不存在，请刷新后重试".to_string())?;

        let mut lines: Vec<String> = existing
            .split('\n')
            .map(|l| l.trim_end_matches('\r').to_string())
            .collect();
        if line_idx >= lines.len() {
            return Err("任务行号超出范围，请刷新后重试".into());
        }
        let raw = lines[line_idx].trim();
        let cur_done = raw.starts_with("~~") && raw.ends_with("~~") && raw.len() >= 4;
        let base = if cur_done {
            raw[2..raw.len() - 2].trim()
        } else {
            raw
        };
        lines[line_idx] = if done {
            format!("~~{base}~~")
        } else {
            base.to_string()
        };
        let next_content = lines.join("\r\n");
        conn.execute(
            "UPDATE item_table SET it_content = ?1 WHERE it_id = ?2",
            rusqlite::params![next_content, row_id],
        )
        .map_err(|e| format!("更新完成状态失败: {e}"))?;
        drop(conn);
        self.sync_portable_shadow();
        Ok(())
    }

    pub fn sandbox_delete(&self, id: &str, _date: &str) -> Result<(), String> {
        let conn = self.conn_rw()?;
        self.backup_sandbox_if_needed();

        if let Some(ev_id_str) = id.strip_prefix("ev-") {
            let ev_id: i64 = ev_id_str.parse().map_err(|_| "事件 ID 无效")?;
            conn.execute("DELETE FROM event_table WHERE ev_id = ?1", [ev_id])
                .map_err(|e| format!("删除事件失败: {e}"))?;
            return Ok(());
        }

        let (row_id, line_idx) = id
            .strip_prefix("it-")
            .and_then(|s| s.split_once(':'))
            .and_then(|(r, l)| Some((r.parse::<i64>().ok()?, l.parse::<usize>().ok()?)))
            .ok_or_else(|| "任务行标识无效".to_string())?;

        let existing: String = conn
            .query_row(
                "SELECT coalesce(it_content, '') FROM item_table WHERE it_id = ?1",
                [row_id],
                |r| r.get(0),
            )
            .map_err(|_| "任务不存在，请刷新后重试".to_string())?;

        let mut lines: Vec<String> = existing
            .split('\n')
            .map(|l| l.trim_end_matches('\r').to_string())
            .collect();
        if line_idx >= lines.len() {
            return Err("任务行号超出范围，请刷新后重试".into());
        }
        lines.remove(line_idx);
        let next_content = lines.join("\r\n");
        conn.execute(
            "UPDATE item_table SET it_content = ?1 WHERE it_id = ?2",
            rusqlite::params![next_content, row_id],
        )
        .map_err(|e| format!("删除任务失败: {e}"))?;
        drop(conn);
        self.sync_portable_shadow();
        Ok(())
    }

    pub fn sandbox_move_item(&self, id: &str, from_date: &str, to_date: &str) -> Result<(), String> {
        if from_date == to_date {
            return Ok(());
        }
        let item = self
            .day_items(from_date)?
            .into_iter()
            .find(|i| i.id == id)
            .ok_or_else(|| "要移动的日程已不存在，请刷新后重试".to_string())?;

        let conn = self.conn_rw()?;
        self.backup_sandbox_if_needed();

        if let Some(ev_id_str) = id.strip_prefix("ev-") {
            let ev_id: i64 = ev_id_str.parse().map_err(|_| "事件 ID 无效")?;
            let new_start = if item.time.is_empty() {
                to_date.to_string()
            } else {
                format!("{to_date}T{}:00+08:00", item.time)
            };
            conn.execute(
                "UPDATE event_table SET ev_date = ?1, ev_start_date = ?2 WHERE ev_id = ?3",
                rusqlite::params![to_date, new_start, ev_id],
            )
            .map_err(|e| format!("移动事件日期失败: {e}"))?;
            return Ok(());
        }

        // 普通任务行：先从原日期移除，再追加到目标日期（保留完成态删除线）
        self.sandbox_delete(id, from_date)?;
        let line_text = if item.done {
            format!("~~{}~~", item.title)
        } else {
            item.title
        };
        self.sandbox_create(to_date, &line_text, "")
    }

    pub fn sandbox_note_save(
        &self,
        id: Option<&str>,
        title: &str,
        content: &str,
    ) -> Result<NoteSummary, String> {
        let conn = self.conn_rw()?;
        self.backup_sandbox_if_needed();
        let clean_title = title.trim();
        if clean_title.is_empty() {
            return Err("便签标题不能为空".into());
        }
        if clean_title.chars().count() > 200 {
            return Err("便签标题过长".into());
        }
        let now_str = chrono_like_now();
        let preview: String = content.chars().take(160).collect();

        if let Some(raw_id) = id.filter(|s| !s.trim().is_empty()) {
            let row_id = raw_id
                .strip_prefix("nt-")
                .unwrap_or(raw_id)
                .parse::<i64>()
                .map_err(|_| "便签标识无效")?;
            conn.execute(
                "UPDATE note_table SET nt_title = ?1, nt_content = ?2, nt_mdate = ?3 WHERE nt_id = ?4",
                rusqlite::params![clean_title, content, now_str, row_id],
            )
            .map_err(|e| format!("更新便签失败: {e}"))?;
            return Ok(NoteSummary {
                id: format!("nt-{row_id}"),
                title: clean_title.to_string(),
                preview,
                created: now_str.clone(),
                modified: now_str,
            });
        }

        conn.execute(
            "INSERT INTO note_table (nt_title, nt_content, nt_cdate, nt_mdate) VALUES (?1, ?2, ?3, ?3)",
            rusqlite::params![clean_title, content, now_str],
        )
        .map_err(|e| format!("创建便签失败: {e}"))?;
        let row_id = conn.last_insert_rowid();
        Ok(NoteSummary {
            id: format!("nt-{row_id}"),
            title: clean_title.to_string(),
            preview,
            created: now_str.clone(),
            modified: now_str,
        })
    }

    pub fn sandbox_note_delete(&self, id: &str) -> Result<(), String> {
        let conn = self.conn_rw()?;
        self.backup_sandbox_if_needed();
        let row_id = id
            .strip_prefix("nt-")
            .unwrap_or(id)
            .parse::<i64>()
            .map_err(|_| "便签标识无效")?;
        conn.execute("DELETE FROM note_table WHERE nt_id = ?1", [row_id])
            .map_err(|e| format!("删除便签失败: {e}"))?;
        drop(conn);
        self.sync_portable_shadow();
        Ok(())
    }

    /// 从任意外部 SQLite 数据库（如原版 calendar.db / dcal.db）只读导入日程与任务到当前沙盒库
    pub fn sandbox_import_external_db(&self, external_path: &std::path::Path) -> Result<(usize, usize), String> {
        if !self.is_sandbox() {
            return Err("安全红线拦截：仅允许向本地沙盒库导入数据".into());
        }
        if !external_path.is_file() {
            return Err(format!("所选数据库文件不存在: {}", external_path.display()));
        }
        let src_db = CalendarDb::open(external_path.to_path_buf())?;
        let src_items = src_db.all_items()?;
        let existing = self.all_items().unwrap_or_default();
        let mut seen: std::collections::HashSet<(String, String, String)> = existing
            .into_iter()
            .map(|it| (it.date, it.time, it.title.trim().to_string()))
            .collect();

        let mut imported = 0usize;
        let mut skipped = 0usize;
        for item in src_items {
            if item.kind == "note" {
                continue;
            }
            let clean_title = item.title.trim().to_string();
            if clean_title.is_empty() {
                continue;
            }
            let key_tuple = (item.date.clone(), item.time.clone(), clean_title.clone());
            if !seen.insert(key_tuple) {
                skipped += 1;
                continue;
            }
            let payload = if item.done && item.time.is_empty() {
                format!("~~{clean_title}~~")
            } else {
                clean_title
            };
            self.sandbox_create(&item.date, &payload, &item.time)?;
            imported += 1;
        }
        self.sync_portable_shadow();
        Ok((imported, skipped))
    }

    /// 诊断报告：用于校准字段语义
    pub fn doctor(&self) -> String {
        let mut s = String::new();
        s.push_str(&format!(
            "db: {} (sandbox={})\n",
            self.path.display(),
            self.is_sandbox()
        ));
        match self.table_names() {
            Ok(t) => {
                s.push_str(&format!("tables({}): {}\n", t.len(), t.join(", ")));
                for name in [
                    "setting_table",
                    "project_table",
                    "item_table",
                    "event_table",
                    "note_table",
                ] {
                    if t.iter().any(|x| x == name) {
                        s.push_str(&format!("  {:<16} {} rows\n", name, self.count(name)));
                    }
                }
            }
            Err(e) => s.push_str(&format!("tables 读取失败: {e}\n")),
        }
        match self.all_items() {
            Ok(items) => {
                s.push_str(&format!("归一化项目总数: {}\n", items.len()));
                for it in items.iter().take(12) {
                    s.push_str(&format!(
                        "  {} {} [{}] {}\n",
                        it.date, it.time, it.kind, it.title
                    ));
                }
            }
            Err(e) => s.push_str(&format!("归一化失败: {e}\n")),
        }
        s
    }
}

fn chrono_like_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
        + 8 * 3600; // UTC+8
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let hh = rem / 3600;
    let mm = (rem % 3600) / 60;
    let ss = rem % 60;
    // Civil date from days since 1970-01-01 (Howard Hinnant algorithm)
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{year:04}-{m:02}-{d:02} {hh:02}:{mm:02}:{ss:02}")
}

pub fn open_default() -> Result<CalendarDb, String> {
    if let Ok(p) = std::env::var("KAL_DB_PATH") {
        return CalendarDb::open(PathBuf::from(p));
    }
    // 若用户显式启用实时 MCP 模式且原版管道在线，则使用原版库 + MCP 管道
    if std::env::var("KAL_USE_LIVE_MCP").ok().as_deref() == Some("1") {
        if let Some(orig) = CalendarDb::locate_readonly_source() {
            if crate::mcp::ping_at(crate::mcp::PIPE).is_ok() {
                return CalendarDb::open(orig);
            }
        }
    }
    // 默认使用本地独立可写沙盒库（首次自动从原版库只读克隆初始快照）
    let sb = ensure_sandbox_db()?;
    CalendarDb::open(sb)
}

#[cfg(test)]
#[path = "db_notes_tests.rs"]
mod notes_tests;

#[cfg(test)]
#[path = "db_range_tests.rs"]
mod range_tests;
