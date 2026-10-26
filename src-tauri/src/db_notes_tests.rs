use super::*;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let name = format!("kal-notes-{}-{}.db", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
        let path = std::env::temp_dir().join(name);
        let c = Connection::open(&path).unwrap();
        c.execute_batch("CREATE TABLE note_table (nt_id INTEGER PRIMARY KEY,nt_title TEXT,nt_content TEXT,nt_cdate TEXT,nt_mdate TEXT);").unwrap();
        Self(path)
    }
    fn db(&self) -> CalendarDb { CalendarDb::open(self.0.clone()).unwrap() }
}
impl Drop for Fixture {
    fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); }
}

#[test]
fn notes_are_discoverable_without_dates_and_paginated() {
    let fixture = Fixture::new();
    {
        let c = Connection::open(&fixture.0).unwrap();
        for id in 1..=53 {
            c.execute("INSERT INTO note_table VALUES (?1,'便签','正文\n第二行',NULL,NULL)", [id]).unwrap();
        }
    }
    let db = fixture.db();
    let first = db.notes_page(0).unwrap();
    assert_eq!(first.notes.len(), 50);
    assert!(first.has_more);
    assert_eq!(first.notes[0].id, "nt-53");
    assert_eq!(first.notes[0].preview, "正文\n第二行");
    let second = db.notes_page(50).unwrap();
    assert_eq!(second.notes.len(), 3);
    assert!(!second.has_more);
    assert_eq!(second.notes[2].id, "nt-1");
    assert_eq!(db.note_document("nt-1").unwrap().content, "正文\n第二行");
    assert!(db.note_document("nt-1 OR 1=1").is_err());
    assert!(db.note_document("nt-0").is_err());
}

#[test]
fn notes_long_content_is_explicitly_truncated_without_mutation() {
    let fixture = Fixture::new();
    let content = "汉".repeat(262145);
    {
        let c = Connection::open(&fixture.0).unwrap();
        c.execute("INSERT INTO note_table VALUES (1,'长便签',?1,'2026-01-01','2026-10-15')", [&content]).unwrap();
    }
    let db = fixture.db();
    let note = db.note_document("nt-1").unwrap();
    assert!(note.truncated);
    assert_eq!(note.content.chars().count(), 262144);
    assert_eq!(db.notes_page(0).unwrap().notes[0].preview.chars().count(), 160);
    let c = Connection::open(&fixture.0).unwrap();
    assert_eq!(c.query_row("SELECT nt_content FROM note_table", [], |r| r.get::<_,String>(0)).unwrap(), content);
}
