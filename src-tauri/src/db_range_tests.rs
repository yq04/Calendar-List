use super::*;

struct Fixture { path: PathBuf, db: CalendarDb }
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("kal-range-{}.db", crate::store::unique_suffix()));
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("
            CREATE TABLE item_table (it_id INTEGER PRIMARY KEY, it_unique_id TEXT, it_content TEXT, it_appinfo TEXT, u_id INTEGER, group_id TEXT);
            CREATE TABLE event_table (ev_id INTEGER PRIMARY KEY, ev_content TEXT, ev_date TEXT, ev_start_date TEXT, ev_status INTEGER, u_id INTEGER, ev_unique_id TEXT, group_id TEXT);
            CREATE TABLE note_table (nt_id INTEGER PRIMARY KEY, nt_title TEXT, nt_cdate TEXT);
        ").unwrap();
        let dates = ["20231231", "2024-01-01", "20240228", "20240229T120000", "2024-03-01", "20240302", "20240402", "20240403"];
        for (i, date) in dates.iter().enumerate() {
            conn.execute("INSERT INTO item_table VALUES (?1,?2,?3,'{}',7,'')", rusqlite::params![i as i64 + 1, date, "第一行\r\n\r\n~~第三行~~\n末行"]).unwrap();
        }
        // Duplicate same-day scope must still disable edits after range filtering.
        conn.execute("INSERT INTO item_table VALUES (20,'2024/02/29','重复分组','{}',7,'')", []).unwrap();
        conn.execute("INSERT INTO event_table VALUES (1,'跨月会议','2024-02-01','2024-03-01T09:30:00+08:00',1,7,'event-stable-id','')", []).unwrap();
        conn.execute("INSERT INTO event_table VALUES (2,'分组事件','20240229','',0,7,'group-event','group-a')", []).unwrap();
        conn.execute("INSERT INTO note_table VALUES (1,'闰日便签','2024-02-29 12:00:00')", []).unwrap();
        drop(conn);
        let db = CalendarDb::open_for_test(path.clone()).unwrap();
        Self { path, db }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) { let _ = std::fs::remove_file(&self.path); }
}

#[test]
fn range_cross_month_year_leap_day_and_inclusive_boundaries() {
    let f = Fixture::new();
    let all = f.db.all_items().unwrap();
    for (start, end) in [("2023-12-31", "2024-01-01"), ("2024-02-28", "2024-03-01"),
        ("2024-02-29", "2024-02-29"), ("2024-01-01", "2024-04-02")] {
        let expected: Vec<_> = all.iter().filter(|item| item.date.as_str() >= start && item.date.as_str() <= end).cloned().collect();
        let actual = f.db.range_items(start, end).unwrap();
        assert_eq!(actual, expected, "{start}..{end}");
        assert!(actual.iter().any(|i| i.date == start));
        assert!(actual.iter().any(|i| i.date == end));
    }
    assert!(f.db.range_items("2025-01-01", "2025-01-01").unwrap().is_empty());
    assert!(range_day_number("2000-02-29").is_ok());
    assert!(range_day_number("9999-12-31").is_ok());
    assert!(range_day_number("0001-01-01").is_ok());
}

#[test]
fn range_rejects_noncanonical_impossible_reversed_and_overlong_dates() {
    let f = Fixture::new();
    for date in ["", "20240229", "2024-2-29", "2024-02-29T00:00:00", " 2024-02-29", "2024-02-29 ",
        "2023-02-29", "1900-02-29", "2024-04-31", "2024-00-01", "2024-13-01", "2024-02-00", "0000-01-01", "２０２４-０２-２９"] {
        assert!(f.db.range_items(date, "2024-03-01").is_err(), "start: {date}");
        assert!(f.db.range_items("2024-01-01", date).is_err(), "end: {date}");
    }
    assert!(f.db.range_items("2024-03-01", "2024-02-29").is_err());
    assert!(f.db.range_items("2024-01-01", "2024-04-03").is_err()); // 94 inclusive days
    // Validation happens before opening/scanning the source database.
    let db = CalendarDb { path: f.path.with_extension("absent"), test_live: false };
    assert!(db.range_items("bad", "2024-03-01").unwrap_err().contains("YYYY-MM-DD"));
}

#[test]
fn range_preserves_real_line_indices_snapshots_scope_and_event_semantics() {
    let f = Fixture::new();
    let items = f.db.range_items("2024-02-29", "2024-03-01").unwrap();
    let row: Vec<_> = items.iter().filter(|i| i.id.starts_with("it-4:")).collect();
    assert_eq!(row.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["it-4:0", "it-4:2", "it-4:3"]);
    assert_eq!(row[1].title, "第三行"); assert!(row[1].done);
    assert!(!row[0].revision.is_empty());
    assert!(row.iter().all(|i| i.revision == row[0].revision && i.calendar_id == "7" && !i.can_edit && !i.can_complete));
    let unique = items.iter().find(|i| i.id == "it-5:2").unwrap();
    assert!(unique.can_edit && unique.can_delete && unique.can_complete);
    assert!(unique.done);
    let event = items.iter().find(|i| i.id == "ev-1").unwrap();
    assert_eq!(event.date, "2024-03-01"); assert_eq!(event.time, "09:30");
    assert!(event.done && event.can_edit && event.can_delete && !event.can_complete);
    assert_eq!(event.remote_id, "event-stable-id"); assert_eq!(event.calendar_id, "7");
    assert!(!event.revision.is_empty());
    assert!(!items.iter().find(|i| i.id == "ev-2").unwrap().can_edit);
    let note = items.iter().find(|i| i.id == "nt-1").unwrap();
    assert_eq!(note.date, "2024-02-29"); assert!(!note.can_edit && !note.can_delete);
    assert_eq!(items, f.db.all_items().unwrap().into_iter().filter(|i| i.date.as_str() >= "2024-02-29" && i.date.as_str() <= "2024-03-01").collect::<Vec<_>>());
}
