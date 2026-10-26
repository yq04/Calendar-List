use super::*;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(1);
static TEST_LOCK: Mutex<()> = Mutex::new(());
struct Fixture { path: PathBuf, db: db::CalendarDb }
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("kal-edit-fixture-{}-{}.db", std::process::id(), NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)));
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("
            CREATE TABLE item_table (it_id INTEGER PRIMARY KEY, it_unique_id TEXT, it_content TEXT, it_appinfo TEXT, u_id INTEGER, group_id TEXT);
            CREATE TABLE event_table (ev_id INTEGER PRIMARY KEY, ev_content TEXT, ev_date TEXT, ev_start_date TEXT, ev_status INTEGER, u_id INTEGER, ev_unique_id TEXT, group_id TEXT);
            CREATE TABLE setting_table (st_id INTEGER PRIMARY KEY, st_name TEXT, st_sval TEXT);
        ").unwrap();
        conn.execute("INSERT INTO setting_table VALUES (1, 'sys_aimcp_token', 'mock-aimcp-token-test')", []).unwrap();
        conn.execute("INSERT INTO item_table VALUES (1, '20261012', ?1, ?2, 0, '')", ["第一行\r\n\r\n~~第三行~~\r\n末行", r#"{"undone_count":1}"#]).unwrap();
        conn.execute("INSERT INTO event_table VALUES (1, '会议', '2026-10-13', '2026-10-13T09:30:00+08:00', 0, 0, 'ev-mock-1', '')", []).unwrap();
        drop(conn);
        let db = db::CalendarDb::open(path.clone()).unwrap();
        Self { path, db }
    }

    fn new_test_live() -> Self {
        let mut f = Self::new();
        f.db = db::CalendarDb::open_for_test(f.path.clone()).unwrap();
        f
    }
}
impl Drop for Fixture {
    fn drop(&mut self) { let _ = std::fs::remove_file(&self.path); }
}

#[derive(Clone)]
enum PendingWrite {
    Append { date: String, text: String },
}

#[cfg(windows)]
struct MockMcpServer {
    pipe: String,
    thread: Option<std::thread::JoinHandle<()>>,
    require_confirm: Arc<AtomicBool>,
}

#[cfg(windows)]
impl MockMcpServer {
    fn start(db_path: PathBuf) -> Self {
        use std::os::windows::io::{FromRawHandle, AsRawHandle};
        use std::io::{Read, Write};
        use windows_sys::Win32::{
            Foundation::{GetLastError, ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE},
            Storage::FileSystem::{FlushFileBuffers, PIPE_ACCESS_DUPLEX},
            System::Pipes::{CreateNamedPipeW, ConnectNamedPipe, DisconnectNamedPipe, PIPE_READMODE_MESSAGE, PIPE_TYPE_MESSAGE},
        };

        let pipe_name = format!(r"\\.\pipe\Kal-mock-mcp-{}-{}", std::process::id(), NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed));
        let pipe = pipe_name.clone();
        let require_confirm = Arc::new(AtomicBool::new(false));
        let require_confirm_thread = require_confirm.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();

        let thread = std::thread::spawn(move || {
            let wide: Vec<u16> = pipe_name.encode_utf16().chain(Some(0)).collect();
            let handle = unsafe {
                CreateNamedPipeW(wide.as_ptr(), PIPE_ACCESS_DUPLEX, PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE, 1, 65_536, 65_536, 0, std::ptr::null())
            };
            assert_ne!(handle, INVALID_HANDLE_VALUE);
            let mut file = unsafe { std::fs::File::from_raw_handle(handle) };
            ready_tx.send(()).unwrap();

            let pending_store: Arc<Mutex<Option<PendingWrite>>> = Arc::new(Mutex::new(None));

            loop {
                let connected = unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) };
                if connected == 0 {
                    let err = unsafe { GetLastError() };
                    if err != ERROR_PIPE_CONNECTED {
                        break;
                    }
                }

                let mut input = vec![0u8; 65_536];
                let n = match file.read(&mut input) {
                    Ok(0) => {
                        unsafe { DisconnectNamedPipe(handle); }
                        continue;
                    }
                    Ok(n) => n,
                    Err(_) => {
                        unsafe { DisconnectNamedPipe(handle); }
                        continue;
                    }
                };

                let request: Value = match serde_json::from_slice(&input[..n]) {
                    Ok(v) => v,
                    Err(_) => {
                        unsafe { DisconnectNamedPipe(handle); }
                        continue;
                    }
                };

                let method = request.get("method").and_then(Value::as_str).unwrap_or("");
                let req_id = request.get("id").and_then(Value::as_str).unwrap_or("req-id");
                let params = request.get("params").cloned().unwrap_or(json!({}));

                if method == "shutdown" {
                    let resp = json!({"id": req_id, "ok": true, "result": {}});
                    let _ = file.write_all(&serde_json::to_vec(&resp).unwrap());
                    unsafe { FlushFileBuffers(file.as_raw_handle()); }
                    unsafe { DisconnectNamedPipe(handle); }
                    break;
                }

                let response = match method {
                    "ping" => json!({"id": req_id, "ok": true, "result": {"pong": true}}),
                    "calendar_list" => json!({
                        "id": req_id,
                        "ok": true,
                        "result": {
                            "calendars": [{"id": "0", "name": "默认日历", "current": true}],
                            "current_calendar_id": "0"
                        }
                    }),
                    "items_get" => {
                        let date = params.get("date").and_then(Value::as_str).unwrap_or("");
                        let unique_id: String = date.chars().filter(|c| c.is_ascii_digit()).collect();
                        let conn = Connection::open(&db_path).unwrap();
                        let content: String = conn.query_row(
                            "SELECT it_content FROM item_table WHERE u_id=0 AND it_unique_id=?1",
                            [&unique_id],
                            |r| r.get(0),
                        ).unwrap_or_default();
                        let lines: Vec<Value> = content.split('\n').enumerate().filter_map(|(idx, raw)| {
                            let clean = raw.trim_end_matches('\r');
                            if clean.is_empty() { return None; }
                            let done = clean.starts_with("~~") && clean.ends_with("~~") && clean.len() >= 4;
                            let title = if done { &clean[2..clean.len()-2] } else { clean };
                            Some(json!({"line_index": idx, "text": title, "done": done}))
                        }).collect();
                        json!({
                            "id": req_id,
                            "ok": true,
                            "result": {
                                "date": date,
                                "text": content,
                                "bgcolor": "",
                                "lines": lines
                            }
                        })
                    }
                    "items_append_line" => {
                        let date = params.get("date").and_then(Value::as_str).unwrap_or("");
                        let text = params.get("text").and_then(Value::as_str).unwrap_or("");
                        if require_confirm_thread.load(Ordering::SeqCst) {
                            *pending_store.lock().unwrap() = Some(PendingWrite::Append {
                                date: date.to_string(),
                                text: text.to_string(),
                            });
                            json!({
                                "id": req_id,
                                "ok": true,
                                "result": {
                                    "status": "pending_confirmation",
                                    "confirm_token": "mock-confirm-token-12345",
                                    "summary": {
                                        "op": "items_append_line",
                                        "date": date,
                                        "preview": text
                                    }
                                }
                            })
                        } else {
                            let unique_id: String = date.chars().filter(|c| c.is_ascii_digit()).collect();
                            let conn = Connection::open(&db_path).unwrap();
                            let existing: String = conn.query_row(
                                "SELECT it_content FROM item_table WHERE u_id=0 AND it_unique_id=?1",
                                [&unique_id],
                                |r| r.get(0),
                            ).unwrap_or_default();
                            let new_content = if existing.is_empty() {
                                text.to_string()
                            } else {
                                format!("{existing}\r\n{text}")
                            };
                            conn.execute(
                                "UPDATE item_table SET it_content=?1 WHERE u_id=0 AND it_unique_id=?2",
                                [&new_content, &unique_id],
                            ).unwrap();
                            let lines: Vec<Value> = new_content.split('\n').enumerate().filter_map(|(idx, raw)| {
                                let clean = raw.trim_end_matches('\r');
                                if clean.is_empty() { return None; }
                                let done = clean.starts_with("~~") && clean.ends_with("~~") && clean.len() >= 4;
                                let title = if done { &clean[2..clean.len()-2] } else { clean };
                                Some(json!({"line_index": idx, "text": title, "done": done}))
                            }).collect();
                            json!({
                                "id": req_id,
                                "ok": true,
                                "result": {
                                    "date": date,
                                    "text": new_content,
                                    "bgcolor": "",
                                    "lines": lines
                                }
                            })
                        }
                    }
                    "item_line_update" => {
                        let date = params.get("date").and_then(Value::as_str).unwrap_or("");
                        let line_idx = params.get("line_index").and_then(Value::as_u64).unwrap_or(0) as usize;
                        let text = params.get("text").and_then(Value::as_str).unwrap_or("");
                        let unique_id: String = date.chars().filter(|c| c.is_ascii_digit()).collect();
                        let conn = Connection::open(&db_path).unwrap();
                        let existing: String = conn.query_row(
                            "SELECT it_content FROM item_table WHERE u_id=0 AND it_unique_id=?1",
                            [&unique_id],
                            |r| r.get(0),
                        ).unwrap_or_default();
                        let mut lines: Vec<String> = existing.split('\n').map(|l| l.trim_end_matches('\r').to_string()).collect();
                        if line_idx < lines.len() {
                            lines[line_idx] = text.to_string();
                        }
                        let new_content = lines.join("\r\n");
                        conn.execute(
                            "UPDATE item_table SET it_content=?1 WHERE u_id=0 AND it_unique_id=?2",
                            [&new_content, &unique_id],
                        ).unwrap();
                        let result_lines: Vec<Value> = new_content.split('\n').enumerate().filter_map(|(idx, raw)| {
                            let clean = raw.trim_end_matches('\r');
                            if clean.is_empty() { return None; }
                            let done = clean.starts_with("~~") && clean.ends_with("~~") && clean.len() >= 4;
                            let title = if done { &clean[2..clean.len()-2] } else { clean };
                            Some(json!({"line_index": idx, "text": title, "done": done}))
                        }).collect();
                        json!({
                            "id": req_id,
                            "ok": true,
                            "result": {
                                "date": date,
                                "text": new_content,
                                "bgcolor": "",
                                "lines": result_lines
                            }
                        })
                    }
                    "item_line_set_done" => {
                        let date = params.get("date").and_then(Value::as_str).unwrap_or("");
                        let line_idx = params.get("line_index").and_then(Value::as_u64).unwrap_or(0) as usize;
                        let done = params.get("done").and_then(Value::as_bool).unwrap_or(false);
                        let unique_id: String = date.chars().filter(|c| c.is_ascii_digit()).collect();
                        let conn = Connection::open(&db_path).unwrap();
                        let existing: String = conn.query_row(
                            "SELECT it_content FROM item_table WHERE u_id=0 AND it_unique_id=?1",
                            [&unique_id],
                            |r| r.get(0),
                        ).unwrap_or_default();
                        let mut lines: Vec<String> = existing.split('\n').map(|l| l.trim_end_matches('\r').to_string()).collect();
                        if line_idx < lines.len() {
                            let raw = &lines[line_idx];
                            let is_currently_done = raw.starts_with("~~") && raw.ends_with("~~") && raw.len() >= 4;
                            let base = if is_currently_done { &raw[2..raw.len()-2] } else { raw.as_str() };
                            lines[line_idx] = if done { format!("~~{base}~~") } else { base.to_string() };
                        }
                        let new_content = lines.join("\r\n");
                        conn.execute(
                            "UPDATE item_table SET it_content=?1 WHERE u_id=0 AND it_unique_id=?2",
                            [&new_content, &unique_id],
                        ).unwrap();
                        let result_lines: Vec<Value> = new_content.split('\n').enumerate().filter_map(|(idx, raw)| {
                            let clean = raw.trim_end_matches('\r');
                            if clean.is_empty() { return None; }
                            let is_d = clean.starts_with("~~") && clean.ends_with("~~") && clean.len() >= 4;
                            let title = if is_d { &clean[2..clean.len()-2] } else { clean };
                            Some(json!({"line_index": idx, "text": title, "done": is_d}))
                        }).collect();
                        json!({
                            "id": req_id,
                            "ok": true,
                            "result": {
                                "date": date,
                                "text": new_content,
                                "bgcolor": "",
                                "lines": result_lines
                            }
                        })
                    }
                    "item_line_delete" => {
                        let date = params.get("date").and_then(Value::as_str).unwrap_or("");
                        let line_idx = params.get("line_index").and_then(Value::as_u64).unwrap_or(0) as usize;
                        let unique_id: String = date.chars().filter(|c| c.is_ascii_digit()).collect();
                        let conn = Connection::open(&db_path).unwrap();
                        let existing: String = conn.query_row(
                            "SELECT it_content FROM item_table WHERE u_id=0 AND it_unique_id=?1",
                            [&unique_id],
                            |r| r.get(0),
                        ).unwrap_or_default();
                        let mut lines: Vec<String> = existing.split('\n').map(|l| l.trim_end_matches('\r').to_string()).collect();
                        if line_idx < lines.len() {
                            lines.remove(line_idx);
                        }
                        let new_content = lines.join("\r\n");
                        conn.execute(
                            "UPDATE item_table SET it_content=?1 WHERE u_id=0 AND it_unique_id=?2",
                            [&new_content, &unique_id],
                        ).unwrap();
                        let result_lines: Vec<Value> = new_content.split('\n').enumerate().filter_map(|(idx, raw)| {
                            let clean = raw.trim_end_matches('\r');
                            if clean.is_empty() { return None; }
                            let is_d = clean.starts_with("~~") && clean.ends_with("~~") && clean.len() >= 4;
                            let title = if is_d { &clean[2..clean.len()-2] } else { clean };
                            Some(json!({"line_index": idx, "text": title, "done": is_d}))
                        }).collect();
                        json!({
                            "id": req_id,
                            "ok": true,
                            "result": {
                                "date": date,
                                "text": new_content,
                                "bgcolor": "",
                                "lines": result_lines
                            }
                        })
                    }
                    "event_confirm" => {
                        let token = params.get("confirm_token").and_then(Value::as_str).unwrap_or("");
                        let accept = params.get("accept").and_then(Value::as_bool).unwrap_or(false);
                        if token != "mock-confirm-token-12345" {
                            json!({"id": req_id, "ok": false, "error": {"code": "INVALID_TOKEN", "message": "token mismatch"}})
                        } else if !accept {
                            *pending_store.lock().unwrap() = None;
                            json!({"id": req_id, "ok": true, "result": {"status": "cancelled"}})
                        } else {
                            let pending = pending_store.lock().unwrap().take();
                            match pending {
                                Some(PendingWrite::Append { date, text }) => {
                                    let unique_id: String = date.chars().filter(|c| c.is_ascii_digit()).collect();
                                    let conn = Connection::open(&db_path).unwrap();
                                    let existing: String = conn.query_row(
                                        "SELECT it_content FROM item_table WHERE u_id=0 AND it_unique_id=?1",
                                        [&unique_id],
                                        |r| r.get(0),
                                    ).unwrap_or_default();
                                    let new_content = if existing.is_empty() { text } else { format!("{existing}\r\n{text}") };
                                    conn.execute(
                                        "UPDATE item_table SET it_content=?1 WHERE u_id=0 AND it_unique_id=?2",
                                        [&new_content, &unique_id],
                                    ).unwrap();
                                    let lines: Vec<Value> = new_content.split('\n').enumerate().filter_map(|(idx, raw)| {
                                        let clean = raw.trim_end_matches('\r');
                                        if clean.is_empty() { return None; }
                                        let done = clean.starts_with("~~") && clean.ends_with("~~") && clean.len() >= 4;
                                        let title = if done { &clean[2..clean.len()-2] } else { clean };
                                        Some(json!({"line_index": idx, "text": title, "done": done}))
                                    }).collect();
                                    json!({
                                        "id": req_id,
                                        "ok": true,
                                        "result": {
                                            "status": "ok",
                                            "date": date,
                                            "text": new_content,
                                            "lines": lines
                                        }
                                    })
                                }
                                None => json!({"id": req_id, "ok": false, "error": {"code": "NO_PENDING", "message": "no pending write"}}),
                            }
                        }
                    }
                    _ => json!({"id": req_id, "ok": false, "error": {"code": "UNKNOWN_METHOD", "message": "unsupported method"}}),
                };

                let out = serde_json::to_vec(&response).unwrap();
                let _ = file.write_all(&out);
                unsafe { FlushFileBuffers(file.as_raw_handle()); }
                unsafe { DisconnectNamedPipe(handle); }
            }
        });

        ready_rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        Self {
            pipe,
            thread: Some(thread),
            require_confirm,
        }
    }
}

#[cfg(windows)]
impl Drop for MockMcpServer {
    fn drop(&mut self) {
        if let Some(t) = self.thread.take() {
            let req = json!({"id": "shutdown", "method": "shutdown"});
            let _ = mcp::exchange_at(&self.pipe, &req, 1_000);
            let _ = t.join();
        }
    }
}

#[test]
fn edit_fixture_raw_lines_and_reload_preserve_identity() {
    let fixture = Fixture::new();
    let items = fixture.db.day_items("2026-10-12").unwrap();
    assert_eq!(items.len(), 3);
    assert_eq!(items[1].id, "it-1:2");
    assert!(items[1].done);
    assert_eq!(items[1].title, "第三行");
    assert!(!items[0].done, "无关 appinfo 中的 1 不代表整格完成");
    assert!(!fixture.db.is_live_source());
    assert!(items.iter().all(|i| !i.can_edit && !i.can_complete && !i.can_delete));
    let reload = db::CalendarDb::open(fixture.path.clone()).unwrap();
    assert_eq!(items, reload.day_items("2026-10-12").unwrap());
    assert_eq!(reload.day_items("2026-10-13").unwrap()[0].time, "09:30");
}

#[test]
fn edit_fixture_rejects_stale_snapshot_and_searches_all_dates() {
    let fixture = Fixture::new();
    let old = fixture.db.day_items("2026-10-12").unwrap()[0].clone();
    assert!(snapshot(&fixture.db, &old.id, &old.date, Some(&old)).is_ok());
    assert!(snapshot(&fixture.db, &old.id, &old.date, None).is_err());
    let conn = Connection::open(&fixture.path).unwrap();
    conn.execute("UPDATE item_table SET it_content = '外部修改'", []).unwrap();
    assert!(snapshot(&fixture.db, &old.id, &old.date, Some(&old)).unwrap_err().contains("变化"));
    assert_eq!(fixture.db.search_items("会议").unwrap()[0].date, "2026-10-13");
    assert!(fixture.db.search_items(" ").unwrap().is_empty());
    assert_eq!(fixture.db.search_items("2026-10").unwrap().len(), 2);
}

#[test]
fn edit_validation_checks_real_dates_and_single_line_content() {
    assert!(validate_date("2028-02-29").is_ok());
    for bad in ["2026-02-29", "2026-04-31", "2026-00-12", "2026-1-02", "你好", "2026-10-00"] {
        assert!(validate_date(bad).is_err(), "{bad}");
    }
    assert!(title(" ").is_err());
    assert!(title("第一行\n第二行").is_err());
    assert_eq!(title("  安排  ").unwrap(), "安排");
}

#[test]
#[cfg(windows)]
fn edit_roundtrip_crud_with_mock_pipe_and_sqlite_reload() {
    let _test_guard = TEST_LOCK.lock().unwrap();
    let fixture = Fixture::new_test_live();
    let server = MockMcpServer::start(fixture.path.clone());

    // 1. 验证写入状态正常可写
    let st = status_internal(&fixture.db, &server.pipe);
    assert_eq!(st["available"], true);
    assert_eq!(st["canCreate"], true);

    // 2. 新增任务：create_internal
    let res = create_internal(&fixture.db, &server.pipe, "2026-10-12".into(), "新任务A".into(), "".into()).unwrap();
    assert_eq!(res["status"], "saved");

    // 3. 从 SQLite 重载并验证落盘数据
    let items = fixture.db.day_items("2026-10-12").unwrap();
    assert_eq!(items.len(), 4, "原有3条 + 新增1条 = 4条");
    let added = items.iter().find(|i| i.title == "新任务A").expect("新任务应已落盘");
    assert_eq!(added.done, false);
    assert_eq!(added.id, "it-1:4");

    // 4. 更新任务：update_internal
    let res = update_internal(&fixture.db, &server.pipe, added.id.clone(), added.date.clone(), "新任务A已修改".into(), Some(added.clone())).unwrap();
    assert_eq!(res["status"], "saved");

    let items_after_update = fixture.db.day_items("2026-10-12").unwrap();
    let updated = items_after_update.iter().find(|i| i.id == added.id).expect("任务应存在");
    assert_eq!(updated.title, "新任务A已修改");
    assert_ne!(updated.revision, added.revision, "快照版本号应发生变化");

    // 5. 切换完成态：toggle_internal
    let res = toggle_internal(&fixture.db, &server.pipe, updated.id.clone(), updated.date.clone(), true, Some(updated.clone())).unwrap();
    assert_eq!(res["status"], "saved");

    let items_after_toggle = fixture.db.day_items("2026-10-12").unwrap();
    let toggled = items_after_toggle.iter().find(|i| i.id == updated.id).expect("任务应存在");
    assert_eq!(toggled.done, true);
    assert_eq!(toggled.title, "新任务A已修改");

    // 6. 删除任务：delete_internal
    let res = delete_internal(&fixture.db, &server.pipe, toggled.id.clone(), toggled.date.clone(), Some(toggled.clone())).unwrap();
    assert_eq!(res["status"], "saved");

    let items_after_delete = fixture.db.day_items("2026-10-12").unwrap();
    assert_eq!(items_after_delete.len(), 3, "删除后恢复为3条");
    assert!(items_after_delete.iter().all(|i| i.id != toggled.id));
}

#[test]
#[cfg(windows)]
fn edit_confirmation_flow_accept_cancel_and_stale_guards() {
    let _test_guard = TEST_LOCK.lock().unwrap();
    let fixture = Fixture::new_test_live();
    let server = MockMcpServer::start(fixture.path.clone());
    server.require_confirm.store(true, Ordering::SeqCst);

    // 1. 发起新增 -> 触发 pending_confirmation
    let res = create_internal(&fixture.db, &server.pipe, "2026-10-12".into(), "待确认任务".into(), "".into()).unwrap();
    assert_eq!(res["status"], "pending_confirmation");
    let pending_id = res["pendingId"].as_str().unwrap().to_string();
    assert!(res["summary"].as_str().unwrap().contains("待确认任务"));

    // 2. 核对 SQLite：在未点击确认前，数据绝对不得落盘
    let items_before_confirm = fixture.db.day_items("2026-10-12").unwrap();
    assert_eq!(items_before_confirm.len(), 3, "未确认前不能写入数据库");

    // 3. 点击确认 -> 数据落盘
    let res = confirm_internal(&fixture.db, pending_id, true).unwrap();
    assert_eq!(res["status"], "saved");

    let items_after_confirm = fixture.db.day_items("2026-10-12").unwrap();
    assert_eq!(items_after_confirm.len(), 4, "确认后已写入数据库");
    assert!(items_after_confirm.iter().any(|i| i.title == "待确认任务"));

    // 4. 测试取消保存：再次发起新增 -> 用户取消
    let res = create_internal(&fixture.db, &server.pipe, "2026-10-12".into(), "要取消的任务".into(), "".into()).unwrap();
    let cancel_pending_id = res["pendingId"].as_str().unwrap().to_string();
    let res = confirm_internal(&fixture.db, cancel_pending_id, false).unwrap();
    assert_eq!(res["status"], "cancelled");

    // 取消后数据不应增加
    let items_after_cancel = fixture.db.day_items("2026-10-12").unwrap();
    assert_eq!(items_after_cancel.len(), 4);
    assert!(!items_after_cancel.iter().any(|i| i.title == "要取消的任务"));

    // 5. 非 Live 数据源严禁转发至真实 MCP 管道
    let regular_fixture = Fixture::new();
    assert!(!regular_fixture.db.is_live_source());
    let err = create_internal(&regular_fixture.db, mcp::PIPE, "2026-10-12".into(), "攻击项".into(), "".into()).unwrap_err();
    assert!(err.contains("外部或测试数据"));
}

#[test]
fn sandbox_standalone_crud_move_and_notes_work_without_mcp() {
    let _test_guard = TEST_LOCK.lock().unwrap();
    let sb_path = std::env::temp_dir().join(format!(
        "kal-sandbox-test-{}-{}.db",
        std::process::id(),
        NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
    ));
    let conn = Connection::open(&sb_path).unwrap();
    conn.execute_batch("
        CREATE TABLE item_table (it_id INTEGER PRIMARY KEY AUTOINCREMENT, it_unique_id TEXT, it_content TEXT, it_appinfo TEXT, u_id INTEGER, group_id TEXT);
        CREATE TABLE event_table (ev_id INTEGER PRIMARY KEY AUTOINCREMENT, ev_content TEXT, ev_date TEXT, ev_start_date TEXT, ev_status INTEGER, u_id INTEGER, ev_unique_id TEXT, group_id TEXT);
        CREATE TABLE note_table (nt_id INTEGER PRIMARY KEY AUTOINCREMENT, nt_title TEXT, nt_content TEXT, nt_cdate TEXT, nt_mdate TEXT);
        CREATE TABLE setting_table (st_id INTEGER PRIMARY KEY AUTOINCREMENT, st_name TEXT, st_sval TEXT);
    ").unwrap();
    conn.execute("INSERT INTO item_table (it_unique_id, it_content, it_appinfo, u_id, group_id) VALUES ('20261026', '<!--IxMarkdown-->早会纪要', '{}', 0, '')", []).unwrap();
    drop(conn);

    let db = db::CalendarDb::open(sb_path.clone()).unwrap();
    assert!(db.is_sandbox());
    assert!(db.is_live_source());

    // 1. status_internal 在沙盒模式下无需 MCP 即可写，且支持创建带时间日程
    let st = status_internal(&db, mcp::PIPE);
    assert_eq!(st["available"], true);
    assert_eq!(st["canCreate"], true);
    assert_eq!(st["canCreateEvent"], true);

    // 2. 验证 IxMarkdown 遗留标记被自动剥离
    let initial = db.day_items("2026-10-26").unwrap();
    assert_eq!(initial.len(), 1);
    assert_eq!(initial[0].title, "早会纪要");

    // 3. 在沙盒中直接新建普通任务 + 带时间日程
    create_internal(&db, mcp::PIPE, "2026-10-26".into(), "撰写架构方案 #工作".into(), "".into()).unwrap();
    create_internal(&db, mcp::PIPE, "2026-10-26".into(), "评审会议".into(), "14:30".into()).unwrap();

    let items = db.day_items("2026-10-26").unwrap();
    assert_eq!(items.len(), 3);
    let task = items.iter().find(|i| i.title == "撰写架构方案 #工作").unwrap().clone();
    let ev = items.iter().find(|i| i.title == "评审会议").unwrap().clone();
    assert_eq!(ev.time, "14:30");
    assert!(ev.can_complete);

    // 4. 切换完成状态并跨日移动到 2026-10-27
    toggle_internal(&db, mcp::PIPE, task.id.clone(), "2026-10-26".into(), true, Some(task)).unwrap();
    let toggled_task = db.day_items("2026-10-26").unwrap().into_iter().find(|i| i.title == "撰写架构方案 #工作").unwrap();
    assert!(toggled_task.done);

    move_item_internal(&db, toggled_task.id.clone(), "2026-10-26".into(), "2026-10-27".into(), Some(toggled_task)).unwrap();
    let day26 = db.day_items("2026-10-26").unwrap();
    let day27 = db.day_items("2026-10-27").unwrap();
    assert_eq!(day26.len(), 2);
    assert_eq!(day27.len(), 1);
    assert_eq!(day27[0].title, "撰写架构方案 #工作");
    assert!(day27[0].done);

    // 5. 沙盒便签 CRUD
    let note = db.sandbox_note_save(None, "项目复盘", "第一阶段已完成").unwrap();
    assert!(note.id.starts_with("nt-"));
    assert_eq!(db.note_document(&note.id).unwrap().content, "第一阶段已完成");
    let updated_note = db.sandbox_note_save(Some(&note.id), "项目复盘（更新）", "全部阶段已完成").unwrap();
    assert_eq!(updated_note.title, "项目复盘（更新）");
    assert_eq!(db.note_document(&note.id).unwrap().content, "全部阶段已完成");
    db.sandbox_note_delete(&note.id).unwrap();
    assert!(db.notes_page(0).unwrap().notes.is_empty());

    let _ = std::fs::remove_file(&sb_path);
}
