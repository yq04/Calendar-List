use super::*;

struct Fixture { root: PathBuf, db: CalendarDb }
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("kal-integrity-{}", crate::store::unique_suffix()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("kal_sandbox.db");
        let conn = Connection::open(&path).unwrap();
        ensure_sandbox_schema(&conn).unwrap();
        drop(conn);
        let db = CalendarDb::synthetic_owned(path).unwrap();
        Self { root, db }
    }
}

#[test]
fn storage_integrity_moves_backup_wal_and_history() {
    let fixture = Fixture::new();
    let db = &fixture.db;
    let conn = Connection::open(&db.path).unwrap();
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;").unwrap();
    let id = db.sandbox_create("2026-10-27", "~~完成任务~~", "").unwrap();
    db.sandbox_create("2026-10-28", "原目标", "").unwrap();
    let before = db.all_items().unwrap();
    conn.execute_batch("CREATE TRIGGER fail_target BEFORE UPDATE ON item_table WHEN NEW.it_unique_id='20261028' BEGIN SELECT RAISE(ABORT,'synthetic target failure'); END;").unwrap();
    assert!(db.sandbox_move_item(&id, "2026-10-27", "2026-10-28").is_err());
    assert_eq!(db.all_items().unwrap(), before);
    conn.execute_batch("DROP TRIGGER fail_target").unwrap();
    let target = db.sandbox_move_item(&id, "2026-10-27", "2026-10-28").unwrap();
    let item = db.day_items("2026-10-28").unwrap().into_iter().find(|i| i.id == target).unwrap();
    assert!(item.done);
    let moved_back = db.sandbox_move_item(&target, "2026-10-28", "2026-10-27").unwrap();
    assert!(db.day_items("2026-10-27").unwrap().iter().any(|i| i.id == moved_back && i.done));

    // Keep the WAL connection alive: the snapshot must include committed WAL pages.
    let snapshot = fixture.root.join("live-snapshot.db");
    snapshot_sqlite(&db.path, &snapshot).unwrap();
    let copied = CalendarDb::open(snapshot.clone()).unwrap();
    assert_eq!(copied.all_items().unwrap().len(), db.all_items().unwrap().len());
    let copy = Connection::open(&snapshot).unwrap();
    assert_eq!(copy.query_row("PRAGMA integrity_check", [], |r| r.get::<_,String>(0)).unwrap(), "ok");
    drop(copy);
    let stable_bytes = std::fs::read(&snapshot).unwrap();
    assert!(snapshot_sqlite(&fixture.root.join("missing-source.db"), &snapshot).is_err());
    assert_eq!(std::fs::read(&snapshot).unwrap(), stable_bytes);

    let blocked = Fixture::new();
    std::fs::write(blocked.root.join("backups"), "synthetic blocked backup directory").unwrap();
    assert!(blocked.db.sandbox_create("2026-10-27", "不得在备份失败后写入", "").is_err());
    assert!(blocked.db.all_items().unwrap().is_empty());
    assert!(!LAST_BACKUPS.get().unwrap().lock().unwrap().contains_key(&blocked.db.path));

    let mut shadowed = CalendarDb::synthetic_owned(db.path.clone()).unwrap();
    let shadow = fixture.root.join("isolated-shadow.db");
    shadowed.shadow_path = Some(shadow.clone());
    let event_id = shadowed.sandbox_create("2026-10-27", "已完成事件", "09:30").unwrap();
    conn.execute("UPDATE event_table SET ev_start_date='2026-10-27T09:30:00-04:00' WHERE ev_id=?1", [event_id.strip_prefix("ev-").unwrap().parse::<i64>().unwrap()]).unwrap();
    shadowed.sandbox_toggle(&event_id, "2026-10-27", true).unwrap();
    shadowed.sandbox_move_item(&event_id, "2026-10-27", "2026-10-28").unwrap();
    let shadow_db = CalendarDb::open(shadow).unwrap();
    assert!(shadow_db.day_items("2026-10-28").unwrap().iter().any(|i| i.id == event_id && i.done && i.time == "09:30"));
    assert_eq!(conn.query_row("SELECT ev_start_date FROM event_table WHERE ev_id=?1", [event_id.strip_prefix("ev-").unwrap().parse::<i64>().unwrap()], |r| r.get::<_,String>(0)).unwrap(), "2026-10-28T09:30:00-04:00");
    shadowed.sandbox_move_item(&event_id, "2026-10-28", "2026-10-27").unwrap();

    let expected = db.day_items("2026-10-27").unwrap().into_iter().find(|i| i.id == moved_back).unwrap();
    let result = crate::editing::delete_internal(db, crate::mcp::PIPE, expected.id.clone(), expected.date.clone(), Some(expected.clone())).unwrap();
    let token = result["historyToken"].as_str().unwrap();
    assert!(crate::editing::history_apply_internal(db, token, "undo").is_ok());
    assert_eq!(db.day_items("2026-10-27").unwrap().into_iter().find(|i| i.id == expected.id).unwrap(), expected);
    assert!(crate::editing::history_apply_internal(db, token, "undo").is_err());
    crate::editing::history_apply_internal(db, token, "redo").unwrap();
    crate::editing::history_apply_internal(db, token, "undo").unwrap();
    db.sandbox_create("2026-10-27", "并发新增", "").unwrap();
    assert!(crate::editing::history_apply_internal(db, token, "redo").is_err());

    // Legacy events may use only ev_start_date, or keep a stale ev_date.
    // Both must be captured using the same date that day_items displays.
    for raw_date in [None, Some("2026-10-26")] {
        conn.execute("INSERT INTO event_table(ev_content,ev_date,ev_start_date,ev_status) VALUES ('仅起始日期事件',?1,'2026-10-29T09:00:00',1)", [raw_date]).unwrap();
        let id = format!("ev-{}",conn.last_insert_rowid());
        let event = db.day_items("2026-10-29").unwrap().into_iter().find(|i| i.id == id).unwrap();
        let result = crate::editing::delete_internal(db,crate::mcp::PIPE,event.id.clone(),event.date.clone(),Some(event.clone())).unwrap();
        let token = result["historyToken"].as_str().unwrap();
        crate::editing::history_apply_internal(db,token,"undo").unwrap();
        assert_eq!(db.day_items("2026-10-29").unwrap().into_iter().find(|i| i.id == id).unwrap(),event);
        crate::editing::history_apply_internal(db,token,"redo").unwrap();
        assert!(!db.day_items("2026-10-29").unwrap().iter().any(|i| i.id == id));
        crate::editing::history_apply_internal(db,token,"undo").unwrap();
        let restored_date: Option<String> = conn.query_row("SELECT ev_date FROM event_table WHERE ev_id=?1",[id.strip_prefix("ev-").unwrap().parse::<i64>().unwrap()],|r|r.get(0)).unwrap();
        assert_eq!(restored_date.as_deref(),raw_date);
    }
}

#[test]
fn import_integrity_atomic_identity_and_note_fidelity() {
    let source = Fixture::new();
    source.db.sandbox_create("2026-10-27", "同名", "").unwrap();
    source.db.sandbox_create("2026-10-27", "同名", "").unwrap();
    source.db.sandbox_create("2026-10-27", "~~普通已完成~~", "").unwrap();
    let event = source.db.sandbox_create("2026-10-27", "定时已完成", "10:45").unwrap();
    source.db.sandbox_toggle(&event, "2026-10-27", true).unwrap();
    let unsupported_event = source.db.sandbox_create("2026-10-27", "有结束时间的事件", "11:00").unwrap();
    let body = format!("多行\n{}\n末行", "汉".repeat(262150));
    let source_conn = Connection::open(&source.db.path).unwrap();
    source_conn.execute_batch("ALTER TABLE event_table ADD COLUMN ev_end_date TEXT").unwrap();
    source_conn.execute("UPDATE event_table SET ev_end_date='2026-10-27T12:00:00' WHERE ev_id=?1", [unsupported_event.strip_prefix("ev-").unwrap().parse::<i64>().unwrap()]).unwrap();
    source_conn.execute("INSERT INTO note_table(nt_title,nt_content,nt_cdate,nt_mdate) VALUES ('无日期便签',?1,NULL,NULL)", [&body]).unwrap();
    drop(source_conn);
    let original = std::fs::read(&source.db.path).unwrap();
    let target = Fixture::new();
    let conn = Connection::open(&target.db.path).unwrap();
    conn.execute_batch("CREATE TRIGGER fail_note BEFORE INSERT ON note_table BEGIN SELECT RAISE(ABORT,'synthetic failure at final note'); END;").unwrap();
    assert!(target.db.sandbox_import_external_db(&source.db.path).is_err());
    assert!(target.db.all_items().unwrap().is_empty());
    assert_eq!(conn.query_row("SELECT count(*) FROM kal_import_identity", [], |r| r.get::<_,i64>(0)).unwrap(), 0);
    conn.execute_batch("DROP TRIGGER fail_note").unwrap();
    let report = target.db.sandbox_import_external_db(&source.db.path).unwrap();
    assert_eq!(report.imported, 5);
    assert_eq!(report.unsupported, 1);
    assert_eq!(target.db.sandbox_import_external_db(&source.db.path).unwrap().skipped, 5);
    let items = target.db.all_items().unwrap();
    assert_eq!(items.iter().filter(|i| i.title == "同名").count(), 2);
    assert!(items.iter().any(|i| i.title == "定时已完成" && i.done && i.time == "10:45"));
    assert!(items.iter().any(|i| i.title == "普通已完成" && i.done));
    assert_eq!(conn.query_row("SELECT nt_content FROM note_table", [], |r| r.get::<_,String>(0)).unwrap(), body);
    assert_eq!(std::fs::read(&source.db.path).unwrap(), original);
    let entries = serde_json::from_value(serde_json::json!([
        {"date":"2026-10-28","title":"第一条","uid":"a"},
        {"date":"2026-10-28","title":"非法时间","time":"25:00","uid":"b"}
    ])).unwrap();
    assert!(crate::editing::import_items_internal(&target.db, entries).is_err());
    assert!(target.db.day_items("2026-10-28").unwrap().is_empty());
    let entries = serde_json::json!([
        {"date":"2026-10-28","title":"同名","uid":"a"},
        {"date":"2026-10-28","title":"同名","uid":"b"}
    ]);
    assert_eq!(crate::editing::import_items_internal(&target.db, serde_json::from_value(entries.clone()).unwrap()).unwrap()["imported"], 2);
    assert_eq!(crate::editing::import_items_internal(&target.db, serde_json::from_value(entries).unwrap()).unwrap()["skipped"], 2);
}

#[test]
fn storage_isolation_explicit_root_and_filename_spoofing() {
    let fixture = Fixture::new();
    let fake = CalendarDb::open(fixture.db.path.clone()).unwrap();
    assert!(!fake.is_sandbox());
    assert!(fake.sandbox_create("2026-10-27", "禁止写", "").is_err());
    let legacy = fixture.root.join("legacy");
    std::fs::create_dir_all(legacy.join("Kal")).unwrap();
    std::fs::write(legacy.join("Kal/settings.json"), r#"{"productionSentinel":true}"#).unwrap();
    let isolated = fixture.root.join("isolated");
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "db::storage_integrity_tests::storage_isolation_child", "--nocapture"])
        .env("KAL_DATA_DIR", &isolated).env("APPDATA", &legacy).env("KAL_ISOLATION_TEST_CHILD", "1")
        .env_remove("KAL_DB_PATH").env_remove("KAL_USE_LIVE_MCP").status().unwrap();
    assert!(status.success());
    assert!(!isolated.join("productionSentinel").exists());
    assert_eq!(std::fs::read_to_string(legacy.join("Kal/settings.json")).unwrap(), r#"{"productionSentinel":true}"#);
}

#[test]
fn storage_isolation_child() {
    if std::env::var("KAL_ISOLATION_TEST_CHILD").ok().as_deref() != Some("1") { return; }
    assert!(crate::store::is_isolated());
    assert!(!crate::store::is_portable_install_dir());
    assert!(CalendarDb::locate_readonly_source().is_none());
    assert!(crate::store::read_settings().get("productionSentinel").is_none());
    let db = open_default().unwrap();
    assert!(db.all_items().unwrap().is_empty());
    db.sandbox_create("2026-10-27", "隔离 CRUD", "").unwrap();
    assert_eq!(db.day_items("2026-10-27").unwrap().len(), 1);
    assert_eq!(crate::store::INSTALL_REGISTRY_READS.load(std::sync::atomic::Ordering::Relaxed), 0);
    assert_eq!(crate::store::INSTALL_REGISTRY_WRITES.load(std::sync::atomic::Ordering::Relaxed), 0);
}
