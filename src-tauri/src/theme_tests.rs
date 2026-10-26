use super::*;
use serde_json::json;

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("kal-theme-test-{}", store::unique_suffix()));
        std::fs::create_dir_all(&root).unwrap();
        Self(root)
    }
}
impl Drop for Temp {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}
fn draft() -> Theme {
    let mut t = preset("builtin-starport-paper").unwrap();
    t.id.clear();
    t.name = "同名用户主题".into();
    t
}

#[test]
fn theme_presets_complete_and_every_information_role_has_contrast() {
    let tmp = Temp::new();
    let mut modes = vec![];
    for (id, raw) in PRESETS {
        let t = parse(serde_json::from_str(raw).unwrap(), &tmp.0).unwrap();
        assert_eq!(t.id, id);
        modes.push(t.mode.clone());
        assert_eq!(t.color.bg_alpha, 1.0);
        assert_eq!(t.color.surface_alpha, 1.0);
        assert_eq!(t.color.surface_hover_alpha, 1.0);
        assert_eq!(t.color.today_bg_alpha, 1.0);
        assert_eq!(t.shape.blur, 0.0);
        assert!(!t.shape.shadow);
        let c = &t.color;
        let backgrounds = [("bg", &c.bg), ("surface", &c.surface), ("hover", &c.surface_hover), ("today", &c.today_bg), ("selected", &c.selected_bg)];
        for (role, fg) in [("fg", &c.fg), ("fgMuted", &c.fg_muted), ("fgDim", &c.fg_dim),
            ("fgWeekend", &c.fg_weekend), ("fgHoliday", &c.fg_holiday), ("fgOtherMonth", &c.fg_other_month),
            ("accent", &c.accent), ("danger", &c.danger), ("done", &c.done), ("selectedFg", &c.selected_fg)] {
            for (bg_role, bg) in backgrounds {
                let ratio = color::contrast(color::hex_to_rgb(fg).unwrap(), color::hex_to_rgb(bg).unwrap());
                assert!(ratio >= 4.5, "{id} {role}/{bg_role}: {ratio}");
            }
        }
        for (role, ring) in [("focus", &c.focus), ("todayRing", &c.today_ring)] {
            for (bg_role, bg) in backgrounds {
                let ratio = color::contrast(color::hex_to_rgb(ring).unwrap(), color::hex_to_rgb(bg).unwrap());
                assert!(ratio >= 3.0, "{id} {role}/{bg_role}: {ratio}");
            }
        }
        for (fg, bg) in [(&c.accent_fg, &c.accent), (&c.danger_fg, &c.danger)] {
            assert!(color::contrast(color::hex_to_rgb(fg).unwrap(), color::hex_to_rgb(bg).unwrap()) >= 4.5);
        }
    }
    assert_eq!(modes.iter().filter(|s| *s == "light").count(), 2);
    assert_eq!(modes.iter().filter(|s| *s == "dark").count(), 3);
    assert_eq!(list_at(&tmp.0).len(), 5);
}

#[test]
fn theme_schema_validation_and_v1_defaults() {
    let tmp = Temp::new();
    let old = parse(json!({"schema":"kal.theme/1", "id":"old", "name":"旧主题"}), &tmp.0).unwrap();
    assert_eq!(old.typography.stretch, 100.0);
    assert_eq!(old.color.danger, Colors::default().danger);
    assert!(parse(json!({"schema":"kal.theme/2", "name":"new"}), &tmp.0).is_err());
    assert!(parse(json!({"schema":null}), &tmp.0).is_err());
    let mut t = draft();
    t.schema = "kal.theme/2".into();
    assert!(commit_at(&tmp.0, &t).is_err());
    t = draft(); t.color.fg_dim = "red".into(); assert!(commit_at(&tmp.0, &t).is_err());
    t = draft(); t.color.bg_alpha = f32::NAN; assert!(commit_at(&tmp.0, &t).is_err());
    t = draft(); t.layout.agenda_width = 0.0; assert!(commit_at(&tmp.0, &t).is_err());
    t = draft(); t.typography.family_ui = "url(file:///font)".into(); assert!(commit_at(&tmp.0, &t).is_err());
    t = draft(); t.typography.family_ui = "\"Kal-local-612e747466\", sans-serif".into(); assert!(commit_at(&tmp.0, &t).is_err());
    for id in ["../escape", "a/b", "a\\b", "CON", "nul", "C:drive", "theme."] {
        t = draft(); t.id = id.into(); assert!(commit_at(&tmp.0, &t).is_err(), "{id}");
        assert!(load_at(&tmp.0, id).is_err());
    }
    assert!(!tmp.0.join("themes").exists());
    assert!(!tmp.0.join("settings.json").exists());
}

fn legacy_light_theme() -> serde_json::Value {
    serde_json::from_str(r##"{
        "schema":"kal.theme/1", "id":"legacy-light", "name":"旧浅色主题", "mode":"light",
        "color": {
            "bg":"#FAF8F2", "bgAlpha":1.0,
            "surface":"#F1EEE5", "surfaceAlpha":0.9,
            "surfaceHover":"#E8E3D8", "surfaceHoverAlpha":0.8,
            "fg":"#242424", "fgMuted":"#626262", "fgDim":"#717171",
            "fgWeekend":"#854242", "fgHoliday":"#A51E35", "fgOtherMonth":"#797979",
            "accent":"#345DA8", "accentFg":"#FFFFFF",
            "todayBg":"#D8E3F5", "todayBgAlpha":0.6,
            "todayRing":"#345DA8", "todayRingAlpha":0.9,
            "line":"#343434", "lineAlpha":0.12, "borderAlpha":0.2
        },
        "type":{"familyUi":"Legacy UI, sans-serif", "size":{"day":19.0}},
        "layout":{"agendaWidth":280.0}, "scale":1.2
    }"##).unwrap()
}

fn assert_color_values_preserved(serialized: &serde_json::Value, original: &serde_json::Value) {
    for (key, value) in original.as_object().unwrap() {
        if let Some(number) = value.as_f64() {
            // Alpha fields use f32 in the theme schema.
            assert_eq!(serialized[key].as_f64().unwrap() as f32, number as f32, "preserve {key}");
        } else {
            assert_eq!(&serialized[key], value, "preserve {key}");
        }
    }
}

#[test]
fn theme_legacy_v1_semantics_survive_parse_and_serialize() {
    let tmp = Temp::new();
    let raw = legacy_light_theme();
    let serialized = serde_json::to_value(parse(raw.clone(), &tmp.0).unwrap()).unwrap();
    for (role, expected) in [
        ("danger", "#A51E35"), ("dangerFg", "#FAF8F2"), ("focus", "#345DA8"),
        ("done", "#626262"), ("selectedBg", "#D8E3F5"), ("selectedFg", "#242424"),
    ] {
        assert_eq!(serialized["color"][role], expected, "legacy {role}");
    }
    assert_color_values_preserved(&serialized["color"], &raw["color"]);
    assert_eq!(serialized["type"]["familyUi"], raw["type"]["familyUi"]);
    assert_eq!(serialized["type"]["size"]["day"], 19.0);
    assert_eq!(serialized["type"]["stretch"], 100.0);
    assert_eq!(serialized["layout"]["agendaWidth"], 280.0);
    assert_eq!(serialized["scale"], 1.2_f32);

    // Match normalizeTheme's alternate fallbacks when older optional roles are absent.
    let mut sparse = raw;
    for key in ["fgHoliday", "fgMuted", "todayBg"] {
        sparse["color"].as_object_mut().unwrap().remove(key);
    }
    let serialized = serde_json::to_value(parse(sparse, &tmp.0).unwrap()).unwrap();
    assert_eq!(serialized["color"]["danger"], "#242424");
    assert_eq!(serialized["color"]["done"], "#242424");
    assert_eq!(serialized["color"]["selectedBg"], "#F1EEE5");
}

#[test]
fn theme_explicit_semantics_are_preserved() {
    let tmp = Temp::new();
    let mut raw = legacy_light_theme();
    for (key, value) in [
        ("danger", "#801122"), ("dangerFg", "#FFFFEE"), ("focus", "#443399"),
        ("done", "#446644"), ("selectedBg", "#EEDDBB"), ("selectedFg", "#112233"),
    ] {
        raw["color"][key] = json!(value);
    }
    let serialized = serde_json::to_value(parse(raw.clone(), &tmp.0).unwrap()).unwrap();
    assert_color_values_preserved(&serialized["color"], &raw["color"]);
    for (_, preset_raw) in PRESETS {
        let raw: serde_json::Value = serde_json::from_str(preset_raw).unwrap();
        let serialized = serde_json::to_value(parse(raw.clone(), &tmp.0).unwrap()).unwrap();
        assert_color_values_preserved(&serialized["color"], &raw["color"]);
    }
}

#[test]
fn theme_builtin_ids_read_only_and_not_shadowed_by_disk() {
    let tmp = Temp::new();
    std::fs::create_dir_all(tmp.0.join("themes")).unwrap();
    for (id, _) in PRESETS {
        let mut fake = draft(); fake.id = id.into(); fake.name = "假冒主题".into();
        assert!(save_at(&tmp.0, &fake).is_err());
        assert!(delete_at(&tmp.0, id).is_err());
        std::fs::write(tmp.0.join("themes").join(format!("{id}.json")), serde_json::to_vec(&fake).unwrap()).unwrap();
        assert_ne!(load_at(&tmp.0, id).unwrap().name, "假冒主题");
    }
    assert_eq!(list_at(&tmp.0).len(), 5);
    assert!(delete_at(&tmp.0, "default").is_err());
    assert!(load_at(&tmp.0, "builtin-unknown").is_err());
    // Copying a builtin through commit produces a new, editable user identity.
    let copy = commit_at(&tmp.0, &preset("builtin-mocha").unwrap()).unwrap();
    assert!(copy.id.starts_with("user-"));
    assert_eq!(copy.source, "manual");
}

#[test]
fn theme_commit_preserves_old_active_on_validation_and_file_failure() {
    let tmp = Temp::new();
    let original = json!({"schema":"kal.settings/1", "activeTheme":"builtin-nord", "window":{"x":42}});
    store::write_json(&tmp.0.join("settings.json"), &original).unwrap();
    let mut invalid = draft(); invalid.color.fg = "oops".into();
    assert!(commit_at(&tmp.0, &invalid).is_err());
    assert_eq!(store::read_json(&tmp.0.join("settings.json")).unwrap(), original);
    std::fs::write(tmp.0.join("themes"), "blocked theme directory").unwrap();
    assert!(commit_at(&tmp.0, &draft()).is_err());
    assert_eq!(store::read_json(&tmp.0.join("settings.json")).unwrap(), original);
}

#[test]
fn theme_commit_settings_failure_retains_new_unactivated_theme() {
    let tmp = Temp::new();
    let original = json!({"schema":"kal.settings/1", "activeTheme":"builtin-nord", "window":{"x":42}});
    store::write_json(&tmp.0.join("settings.json"), &original).unwrap();
    let result = commit_at_with(&tmp.0, &draft(), |_, _| Err("injected settings write failure".into()));
    assert!(result.unwrap_err().contains("已保存但未启用"));
    assert_eq!(store::read_json(&tmp.0.join("settings.json")).unwrap(), original);
    assert_eq!(list_at(&tmp.0).iter().filter(|r| !r.builtin).count(), 1);
    // Real settings read failure must also leave the original bytes untouched.
    std::fs::write(tmp.0.join("settings.json"), "corrupt existing settings").unwrap();
    assert!(commit_at(&tmp.0, &draft()).is_err());
    assert_eq!(std::fs::read_to_string(tmp.0.join("settings.json")).unwrap(), "corrupt existing settings");
    assert_eq!(list_at(&tmp.0).iter().filter(|r| !r.builtin).count(), 2);
}

#[test]
fn theme_same_name_concurrent_versions_do_not_overwrite_and_settings_merge() {
    let tmp = Temp::new();
    let workers = (0..6).map(|n| {
        let root = tmp.0.clone();
        std::thread::spawn(move || {
            let t = commit_at(&root, &draft()).unwrap();
            store::merge_settings_at(&root.join("settings.json"), &json!({format!("worker{n}"):n})).unwrap();
            t.id
        })
    }).collect::<Vec<_>>();
    let mut ids = workers.into_iter().map(|w| w.join().unwrap()).collect::<Vec<_>>();
    ids.sort(); ids.dedup(); assert_eq!(ids.len(), 6);
    let settings = store::read_json(&tmp.0.join("settings.json")).unwrap();
    for n in 0..6 { assert_eq!(settings[format!("worker{n}")], n); }
    let mut t = draft(); t.id = "same-id".into();
    let workers = (0..4).map(|_| {
        let root = tmp.0.clone(); let t = t.clone();
        std::thread::spawn(move || save_at(&root, &t))
    }).collect::<Vec<_>>();
    assert_eq!(workers.into_iter().map(|w| w.join().unwrap()).filter(Result::is_ok).count(), 1);
    assert_eq!(load_at(&tmp.0, "same-id").unwrap().name, "同名用户主题");
    let active = settings["activeTheme"].as_str().unwrap();
    assert!(delete_at(&tmp.0, active).is_err());
}

#[test]
fn theme_export_draft_has_no_library_or_active_side_effects() {
    let tmp = Temp::new();
    let app = tmp.0.join("Kal"); std::fs::create_dir_all(&app).unwrap();
    let export = tmp.0.join("draft.json");
    let mut t = draft(); t.name = "未保存的新草稿".into(); t.typography.stretch = 125.0;
    export_at(&app, &t, &export).unwrap();
    assert!(!app.join("themes").exists()); assert!(!app.join("settings.json").exists());
    let read = parse(store::read_json(&export).unwrap(), &app).unwrap();
    assert_eq!(read.name, t.name); assert_eq!(read.typography.stretch, 125.0);
    assert!(export_at(&app, &t, &export).is_err());
    assert!(export_at(&app, &t, &app.join("settings.json")).is_err());
    std::fs::create_dir_all(app.join("themes")).unwrap();
    assert!(export_at(&app, &t, &app.join("themes").join("builtin-mocha.json")).is_err());
    assert!(export_at(&app, &t, &PathBuf::from("relative.json")).is_err());
}

#[test]
fn theme_backdrop_and_extended_shape_roundtrip_and_validate() {
    let tmp = Temp::new();
    let mut t = draft();
    t.color.bg_alpha = 0.0; // Pure transparent desktop mode
    t.color.surface_alpha = 0.15;
    t.shape.cell_alpha = 0.45;
    t.shape.text_shadow = 0.65;
    t.shape.grid_style = "grid".into();
    t.backdrop.mode = "art".into();
    t.backdrop.preset = "ink-paper".into();
    t.backdrop.opacity = 0.82;
    t.backdrop.blur = 12.0;
    t.backdrop.brightness = 0.9;
    t.backdrop.saturate = 1.15;
    t.backdrop.fit = "cover".into();
    t.backdrop.vignette = 0.25;
    t.layout.bullet_style = "number".into();
    t.layout.show_holiday_badge = false;
    t.layout.show_week_number = false;
    t.layout.show_yi_ji = false;
    t.layout.hide_completed = true;
    t.layout.sort_completed_last = true;
    let saved = commit_at(&tmp.0, &t).unwrap();
    let loaded = load_at(&tmp.0, &saved.id).unwrap();
    assert_eq!(loaded.color.bg_alpha, 0.0);
    assert_eq!(loaded.shape.grid_style, "grid");
    assert_eq!(loaded.shape.text_shadow, 0.65);
    assert_eq!(loaded.backdrop.mode, "art");
    assert_eq!(loaded.backdrop.preset, "ink-paper");
    assert_eq!(loaded.layout.bullet_style, "number");
    assert!(!loaded.layout.show_holiday_badge);
    assert!(!loaded.layout.show_week_number);
    assert!(!loaded.layout.show_yi_ji);
    assert!(loaded.layout.hide_completed);
    assert!(loaded.layout.sort_completed_last);

    let mut bad = loaded.clone();
    bad.shape.grid_style = "unknown".into();
    assert!(commit_at(&tmp.0, &bad).is_err());
    let mut bad_bullet = loaded.clone();
    bad_bullet.layout.bullet_style = "stars".into();
    assert!(commit_at(&tmp.0, &bad_bullet).is_err());
    let mut bad_mode = loaded;
    bad_mode.backdrop.mode = "invalid".into();
    assert!(commit_at(&tmp.0, &bad_mode).is_err());
}


