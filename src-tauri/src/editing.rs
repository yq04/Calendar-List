//! 官方写入适配与本地沙盒直写双引擎：来源校验、过期快照检查、串行提交和显式确认。
use crate::{db, mcp, model::DayItem};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

static WRITE_LOCK: Mutex<()> = Mutex::new(());
static PENDING: Mutex<Option<Pending>> = Mutex::new(None);
static NEXT_PENDING: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, serde::Deserialize)]
pub struct ImportEntry {
    pub date: String,
    #[serde(default)]
    pub time: String,
    pub title: String,
}

struct Pending {
    id: String,
    confirm: String,
    credential: Option<String>,
    expected: Option<DayItem>,
    expires: Instant,
    pipe: String,
}

pub fn validate_date(date: &str) -> Result<(), String> {
    let b = date.as_bytes();
    if b.len() != 10
        || b[4] != b'-'
        || b[7] != b'-'
        || !b
            .iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
    {
        return Err("日期格式必须为 YYYY-MM-DD".into());
    }
    let y: u32 = date[..4].parse().unwrap_or(0);
    let m: u32 = date[5..7].parse().unwrap_or(0);
    let d: u32 = date[8..].parse().unwrap_or(0);
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let max = match m {
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        1..=12 => 31,
        _ => 0,
    };
    if !(1900..=9999).contains(&y) || d == 0 || d > max {
        return Err("日期不存在或超出支持范围".into());
    }
    Ok(())
}

fn validate_time_opt(time: &str) -> Result<&str, String> {
    let t = time.trim();
    if t.is_empty() {
        return Ok("");
    }
    let bytes = t.as_bytes();
    if bytes.len() != 5
        || bytes[2] != b':'
        || !bytes[0].is_ascii_digit()
        || !bytes[1].is_ascii_digit()
        || !bytes[3].is_ascii_digit()
        || !bytes[4].is_ascii_digit()
    {
        return Err("时间格式必须为 HH:MM".into());
    }
    let hh: u32 = t[..2].parse().unwrap_or(99);
    let mm: u32 = t[3..].parse().unwrap_or(99);
    if hh > 23 || mm > 59 {
        return Err("时间必须在 00:00 到 23:59 之间".into());
    }
    Ok(t)
}

fn title(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("内容不能为空".into());
    }
    if value.contains(['\r', '\n', '\0']) {
        return Err("内容必须是一行文字".into());
    }
    if value.len() > 16_384 {
        return Err("内容过长".into());
    }
    Ok(value)
}

fn source() -> Result<db::CalendarDb, String> {
    let db = db::open_default()?;
    if !db.is_live_source() && !db.is_sandbox() {
        return Err("当前为外部或测试数据，只能查看".into());
    }
    Ok(db)
}

pub fn snapshot(
    db: &db::CalendarDb,
    id: &str,
    date: &str,
    expected: Option<&DayItem>,
) -> Result<DayItem, String> {
    validate_date(date)?;
    let expected = expected.ok_or_else(|| "编辑缺少原始快照，请刷新后重试".to_string())?;
    let item = db
        .day_items(date)?
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| "安排已被移动或删除，请刷新后重试".to_string())?;
    if &item != expected {
        return Err("安排已发生变化，请刷新后重试".into());
    }
    Ok(item)
}

fn credential(db: &db::CalendarDb) -> Result<Option<String>, String> {
    db.aimcp_token()
}

fn calendar_route(
    db: &db::CalendarDb,
    pipe: &str,
    item: Option<&DayItem>,
) -> Result<String, String> {
    let list = mcp::call_at(pipe, "calendar_list", json!({}), credential(db)?)?;
    let current = list
        .get("current_calendar_id")
        .and_then(Value::as_str)
        .ok_or("日历服务未提供当前日历标识")?;
    let id = item.map(|i| i.calendar_id.as_str()).unwrap_or(current);
    let known = list
        .get("calendars")
        .and_then(Value::as_array)
        .ok_or("日历列表响应无效")?;
    if !known
        .iter()
        .any(|c| c.get("id").and_then(Value::as_str) == Some(id))
    {
        return Err("该安排不属于可写日历，请刷新后重试".into());
    }
    if item.is_some_and(|i| i.kind == "event") && id != current {
        return Err("此事件不属于当前主日历，暂只支持查看".into());
    }
    Ok(id.to_string())
}

fn preflight_cell(
    db: &db::CalendarDb,
    pipe: &str,
    date: &str,
    calendar_id: &str,
    expected: Option<&DayItem>,
) -> Result<(), String> {
    let original = match expected {
        Some(item) => db.item_cell_text(&item.id)?,
        None => db.calendar_day_text(date, calendar_id)?,
    };
    let remote = mcp::call_at(
        pipe,
        "items_get",
        json!({"date":date,"calendar_id":calendar_id}),
        credential(db)?,
    )?;
    if remote.get("text").and_then(Value::as_str) != Some(&original) {
        return Err("日历服务与当前数据源内容不同，请刷新后再试".into());
    }
    Ok(())
}

fn confirmation_summary(summary: &Value) -> String {
    let op = summary.get("op").and_then(Value::as_str).unwrap_or("");
    let verb = match op {
        "items_append_line" => "添加",
        "item_line_delete" | "event_delete" => "删除",
        "item_line_set_done" => "修改完成状态",
        _ => "保存修改",
    };
    let content = summary
        .get("preview")
        .or_else(|| summary.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("");
    format!(
        "确认{verb}{}？",
        if content.is_empty() {
            String::new()
        } else {
            format!("“{}”", content.chars().take(120).collect::<String>())
        }
    )
}

fn perform(
    db: &db::CalendarDb,
    pipe: &str,
    method: &str,
    params: Value,
    expected: Option<DayItem>,
) -> Result<Value, String> {
    let mut pending = PENDING.lock().map_err(|_| "确认状态不可用")?;
    if pending.as_ref().is_some_and(|p| p.expires > Instant::now()) {
        return Err("请先确认或取消上一次保存".into());
    }
    *pending = None;
    drop(pending);
    let auth = credential(db)?;
    let result = mcp::call_at(pipe, method, params, auth.clone())?;
    if result.get("status").and_then(Value::as_str) == Some("pending_confirmation") {
        let confirm = result
            .get("confirm_token")
            .and_then(Value::as_str)
            .ok_or_else(|| "日历服务未提供有效确认凭证".to_string())?
            .to_string();
        let id = format!("kal-pending-{}", NEXT_PENDING.fetch_add(1, Ordering::Relaxed));
        let summary = confirmation_summary(result.get("summary").unwrap_or(&Value::Null));
        // 确认凭证仅存内存，前端只得到无授权能力的本地句柄。
        *PENDING.lock().map_err(|_| "确认状态不可用")? = Some(Pending {
            id: id.clone(),
            confirm,
            credential: auth,
            expected,
            expires: Instant::now() + Duration::from_secs(300),
            pipe: pipe.to_string(),
        });
        return Ok(json!({"status":"pending_confirmation", "pendingId":id, "summary":summary}));
    }
    Ok(json!({"status":"saved"}))
}

pub fn status_internal(db: &db::CalendarDb, pipe: &str) -> Value {
    if db.is_sandbox() && pipe == mcp::PIPE {
        return json!({
            "available": true,
            "canCreate": true,
            "canCreateEvent": true,
            "sandbox": true,
            "label": "可直接添加或修改安排"
        });
    }
    let result = (|| -> Result<(), String> {
        if pipe == mcp::PIPE && !db.is_live_source() {
            return Err("当前为外部或测试数据，只能查看".into());
        }
        let token = std::env::var("DESKTOPCAL_AIMCP_TOKEN")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .or(credential(db)?);
        if token.is_none() {
            return Err("请在 DesktopCal 中启用 AI MCP 后刷新".into());
        }
        mcp::ping_at(pipe)?;
        calendar_route(db, pipe, None)?;
        Ok(())
    })();
    match result {
        Ok(()) => json!({"available":true,"canCreate":true,"canCreateEvent":false,"label":"可以保存安排"}),
        Err(label) => json!({"available":false,"canCreate":false,"canCreateEvent":false,"label":label}),
    }
}

pub fn status() -> Value {
    let db = match source() {
        Ok(db) => db,
        Err(label) => {
            return json!({"available":false,"canCreate":false,"canCreateEvent":false,"label":label})
        }
    };
    status_internal(&db, mcp::PIPE)
}

pub fn create_internal(
    db: &db::CalendarDb,
    pipe: &str,
    date: String,
    value: String,
    time: String,
) -> Result<Value, String> {
    if db.is_sandbox() && pipe == mcp::PIPE {
        let _guard = WRITE_LOCK.try_lock().map_err(|_| "正在保存，请稍候")?;
        validate_date(&date)?;
        let clean_title = title(&value)?;
        let clean_time = validate_time_opt(&time)?;
        db.sandbox_create(&date, clean_title, clean_time)?;
        return Ok(json!({"status":"saved"}));
    }
    if pipe == mcp::PIPE && !db.is_live_source() {
        return Err("当前为外部或测试数据，只能查看".into());
    }
    let _guard = WRITE_LOCK.try_lock().map_err(|_| "正在保存，请稍候")?;
    validate_date(&date)?;
    let value = title(&value)?;
    if !time.trim().is_empty() {
        return Err("带时间事件的写入协议尚待核实，暂只支持普通安排".into());
    }
    let calendar_id = calendar_route(db, pipe, None)?;
    preflight_cell(db, pipe, &date, &calendar_id, None)?;
    perform(
        db,
        pipe,
        "items_append_line",
        json!({"date":date,"text":value,"calendar_id":calendar_id}),
        None,
    )
}

pub fn create(date: String, value: String, time: String) -> Result<Value, String> {
    let db = source()?;
    create_internal(&db, mcp::PIPE, date, value, time)
}

pub fn update_internal(
    db: &db::CalendarDb,
    pipe: &str,
    id: String,
    date: String,
    value: String,
    expected: Option<DayItem>,
) -> Result<Value, String> {
    if db.is_sandbox() && pipe == mcp::PIPE {
        let _guard = WRITE_LOCK.try_lock().map_err(|_| "正在保存，请稍候")?;
        let clean_title = title(&value)?;
        let item = snapshot(db, &id, &date, expected.as_ref())?;
        if !item.can_edit {
            return Err("此安排暂不支持编辑".into());
        }
        db.sandbox_update(&id, &date, clean_title)?;
        return Ok(json!({"status":"saved"}));
    }
    if pipe == mcp::PIPE && !db.is_live_source() {
        return Err("当前为外部或测试数据，只能查看".into());
    }
    let _guard = WRITE_LOCK.try_lock().map_err(|_| "正在保存，请稍候")?;
    let value = title(&value)?;
    let item = snapshot(db, &id, &date, expected.as_ref())?;
    if !item.can_edit {
        return Err("此安排暂不支持编辑".into());
    }
    let calendar_id = calendar_route(db, pipe, Some(&item))?;
    if item.kind == "event" {
        return perform(
            db,
            pipe,
            "event_update",
            json!({"id":item.remote_id,"title":value}),
            Some(item),
        );
    }
    preflight_cell(db, pipe, &date, &calendar_id, Some(&item))?;
    let line = id
        .rsplit_once(':')
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .ok_or("任务行号无效")?;
    perform(
        db,
        pipe,
        "item_line_update",
        json!({"date":date,"line_index":line,"text":value,"calendar_id":calendar_id}),
        Some(item),
    )
}

pub fn update(
    id: String,
    date: String,
    value: String,
    expected: Option<DayItem>,
) -> Result<Value, String> {
    let db = source()?;
    update_internal(&db, mcp::PIPE, id, date, value, expected)
}

pub fn toggle_internal(
    db: &db::CalendarDb,
    pipe: &str,
    id: String,
    date: String,
    done: bool,
    expected: Option<DayItem>,
) -> Result<Value, String> {
    if db.is_sandbox() && pipe == mcp::PIPE {
        let _guard = WRITE_LOCK.try_lock().map_err(|_| "正在保存，请稍候")?;
        let item = snapshot(db, &id, &date, expected.as_ref())?;
        if !item.can_complete {
            return Err("此安排暂不支持完成状态".into());
        }
        db.sandbox_toggle(&id, &date, done)?;
        return Ok(json!({"status":"saved"}));
    }
    if pipe == mcp::PIPE && !db.is_live_source() {
        return Err("当前为外部或测试数据，只能查看".into());
    }
    let _guard = WRITE_LOCK.try_lock().map_err(|_| "正在保存，请稍候")?;
    let item = snapshot(db, &id, &date, expected.as_ref())?;
    if !item.can_complete {
        return Err("此安排暂不支持完成状态".into());
    }
    let calendar_id = calendar_route(db, pipe, Some(&item))?;
    preflight_cell(db, pipe, &date, &calendar_id, Some(&item))?;
    let line = id
        .rsplit_once(':')
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .ok_or("任务行号无效")?;
    perform(
        db,
        pipe,
        "item_line_set_done",
        json!({"date":date,"line_index":line,"done":done,"calendar_id":calendar_id}),
        Some(item),
    )
}

pub fn toggle(
    id: String,
    date: String,
    done: bool,
    expected: Option<DayItem>,
) -> Result<Value, String> {
    let db = source()?;
    toggle_internal(&db, mcp::PIPE, id, date, done, expected)
}

pub fn delete_internal(
    db: &db::CalendarDb,
    pipe: &str,
    id: String,
    date: String,
    expected: Option<DayItem>,
) -> Result<Value, String> {
    if db.is_sandbox() && pipe == mcp::PIPE {
        let _guard = WRITE_LOCK.try_lock().map_err(|_| "正在保存，请稍候")?;
        let item = snapshot(db, &id, &date, expected.as_ref())?;
        if !item.can_delete {
            return Err("此安排暂不支持删除".into());
        }
        db.sandbox_delete(&id, &date)?;
        return Ok(json!({"status":"saved"}));
    }
    if pipe == mcp::PIPE && !db.is_live_source() {
        return Err("当前为外部或测试数据，只能查看".into());
    }
    let _guard = WRITE_LOCK.try_lock().map_err(|_| "正在保存，请稍候")?;
    let item = snapshot(db, &id, &date, expected.as_ref())?;
    if !item.can_delete {
        return Err("此安排暂不支持删除".into());
    }
    let calendar_id = calendar_route(db, pipe, Some(&item))?;
    if item.kind == "event" {
        return perform(
            db,
            pipe,
            "event_delete",
            json!({"id":item.remote_id}),
            Some(item),
        );
    }
    preflight_cell(db, pipe, &date, &calendar_id, Some(&item))?;
    let line = id
        .rsplit_once(':')
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .ok_or("任务行号无效")?;
    perform(
        db,
        pipe,
        "item_line_delete",
        json!({"date":date,"line_index":line,"calendar_id":calendar_id}),
        Some(item),
    )
}

pub fn delete(id: String, date: String, expected: Option<DayItem>) -> Result<Value, String> {
    let db = source()?;
    delete_internal(&db, mcp::PIPE, id, date, expected)
}

pub fn move_item_internal(
    db: &db::CalendarDb,
    id: String,
    from_date: String,
    to_date: String,
    expected: Option<DayItem>,
) -> Result<Value, String> {
    let _guard = WRITE_LOCK.try_lock().map_err(|_| "正在保存，请稍候")?;
    validate_date(&from_date)?;
    validate_date(&to_date)?;
    if let Some(exp) = expected.as_ref() {
        snapshot(db, &id, &from_date, Some(exp))?;
    }
    if !db.is_sandbox() {
        return Err("跨日移动日程仅在本地沙盒可写模式下支持".into());
    }
    db.sandbox_move_item(&id, &from_date, &to_date)?;
    Ok(json!({"status":"saved"}))
}

pub fn move_item(
    id: String,
    from_date: String,
    to_date: String,
    expected: Option<DayItem>,
) -> Result<Value, String> {
    let db = source()?;
    move_item_internal(&db, id, from_date, to_date, expected)
}

pub fn import_items(items: Vec<ImportEntry>) -> Result<Value, String> {
    let db = source()?;
    if !db.is_sandbox() {
        return Err("导入日历仅在本地沙盒可写模式下支持".into());
    }
    let _guard = WRITE_LOCK.try_lock().map_err(|_| "正在保存，请稍候")?;
    if items.is_empty() {
        return Err("没有可导入的日程项".into());
    }
    if items.len() > 1000 {
        return Err("单次最多导入 1000 条日程".into());
    }
    let mut imported = 0usize;
    for entry in items {
        if validate_date(&entry.date).is_err() {
            continue;
        }
        let Ok(clean_title) = title(&entry.title) else {
            continue;
        };
        let clean_time = validate_time_opt(&entry.time).unwrap_or("");
        db.sandbox_create(&entry.date, clean_title, clean_time)?;
        imported += 1;
    }
    Ok(json!({"status": "saved", "imported": imported}))
}

pub fn note_save(
    id: Option<String>,
    note_title: String,
    content: String,
) -> Result<db::NoteSummary, String> {
    let db = source()?;
    if !db.is_sandbox() {
        return Err("便签编辑仅在本地沙盒可写模式下支持".into());
    }
    let _guard = WRITE_LOCK.try_lock().map_err(|_| "正在保存，请稍候")?;
    db.sandbox_note_save(id.as_deref(), &note_title, &content)
}

pub fn note_delete(id: String) -> Result<Value, String> {
    let db = source()?;
    if !db.is_sandbox() {
        return Err("便签删除仅在本地沙盒可写模式下支持".into());
    }
    let _guard = WRITE_LOCK.try_lock().map_err(|_| "正在保存，请稍候")?;
    db.sandbox_note_delete(&id)?;
    Ok(json!({"status": "saved"}))
}

pub fn confirm_internal(
    db: &db::CalendarDb,
    pending_id: String,
    accept: bool,
) -> Result<Value, String> {
    let _guard = WRITE_LOCK.try_lock().map_err(|_| "正在保存，请稍候")?;
    let mut slot = PENDING.lock().map_err(|_| "确认状态不可用")?;
    let pending = slot.as_ref().ok_or("保存确认已失效，请刷新")?;
    if pending.id != pending_id {
        return Err("保存确认不匹配".into());
    }
    if pending.expires <= Instant::now() {
        *slot = None;
        return Err("保存确认已过期，请刷新".into());
    }
    let pending = slot.take().unwrap();
    drop(slot);
    if pending.pipe == mcp::PIPE && !db.is_live_source() {
        return Err("当前为外部或测试数据，只能查看".into());
    }
    if accept {
        if let Some(item) = &pending.expected {
            snapshot(db, &item.id, &item.date, Some(item))?;
            let calendar_id = calendar_route(db, &pending.pipe, Some(item))?;
            if item.kind == "item" {
                preflight_cell(db, &pending.pipe, &item.date, &calendar_id, Some(item))?;
            }
        }
    }
    let result = mcp::call_at(
        &pending.pipe,
        "event_confirm",
        json!({"confirm_token":pending.confirm,"accept":accept}),
        pending.credential,
    )?;
    if result.get("status").and_then(Value::as_str) == Some("pending_confirmation") {
        return Err("保存确认未完成，请刷新核对".into());
    }
    Ok(json!({"status":if accept {"saved"} else {"cancelled"}}))
}

pub fn confirm(pending_id: String, accept: bool) -> Result<Value, String> {
    let db = source()?;
    confirm_internal(&db, pending_id, accept)
}

#[cfg(test)]
#[path = "editing_tests.rs"]
mod tests;
