// 数据桥：外壳内走 Tauri IPC，浏览器里回落 Mock
// 这一层是前端唯一知道「自己在不在外壳里」的地方，其余模块都当它是纯数据源。

import { DEFAULT_THEME } from "./theme.js";
import { createMockSource } from "./mock.js";

function tauriInvoke() {
  return typeof window !== "undefined" ? window.__TAURI__?.core?.invoke : null;
}

export function inShell() {
  return !!tauriInvoke();
}

export async function createBridge(env = {}) {
  const invoke = env.invoke ?? tauriInvoke();
  if (invoke) {
    let cachedInfo = null;
    let bootError = null;
    try {
      cachedInfo = await invoke("app_info");
    } catch (err) {
      bootError = err;
      console.warn("[kal] app_info 调用失败（保持外壳模式，不回落 Mock）：", err);
    }
    return {
      kind: "shell",
      label: cachedInfo?.sourceLabel ?? (bootError ? "状态异常" : "DesktopCal"),
      bootError: bootError ? (bootError?.message || String(bootError)) : null,
      appInfo: async () => {
        if (cachedInfo) return cachedInfo;
        cachedInfo = await invoke("app_info");
        bootError = null;
        return cachedInfo;
      },
      monthEvents: (year, month) => invoke("month_events", { year, month: month + 1 }),
      rangeEvents: (start, end) => invoke("range_events", { start, end }),
      dayEvents: (key) => invoke("day_events", { date: key }),
      searchEvents: (query) => invoke("search_events", { query: String(query ?? "") }),
      notesList: (offset = 0) => invoke("notes_list", { offset }),
      noteGet: id => invoke("note_get", { id }),
      noteSave: (id, title, content) => invoke("note_save", { id: id || null, title, content }),
      noteDelete: id => invoke("note_delete", { id }),
      desktopStatus: () => invoke("desktop_status"),
      desktopSetHotkey: enabled => invoke("desktop_set_hotkey", { enabled: Boolean(enabled) }),
      writeStatus: () => invoke("calendar_write_status"),
      itemCreate: (date, title, time = "") => invoke("item_create", { date, title, time }),
      itemUpdate: (id, date, title, expected = null) =>
        invoke("item_update", { id, date, title, expected: expected ?? null }),
      itemToggleDone: (id, date, done, expected = null) =>
        invoke("item_toggle_done", { id, date, done, expected: expected ?? null }),
      itemDelete: (id, date, expected = null) =>
        invoke("item_delete", { id, date, expected: expected ?? null }),
      itemMove: (id, fromDate, toDate, expected = null) =>
        invoke("item_move", { id, fromDate, toDate, expected: expected ?? null }),
      calendarImportItems: items => invoke("calendar_import_items", { items }),
      calendarReadTextFile: path => invoke("calendar_read_text_file", { path }),
      itemConfirm: (pendingId, accept) =>
        invoke("item_confirm", { pendingId, accept: Boolean(accept) }),
      displayInfo: () => invoke("display_info"),
      settingsGet: () => invoke("settings_get"),
      settingsSet: (patch) => invoke("settings_set", { patch }),

      wallpaperInfo: () => invoke("wallpaper_info"),
      wallpaperReadImage: (path = null) => invoke("wallpaper_read_image", { path: path || null }),
      themeActive: () => invoke("theme_active"),
      themeList: () => invoke("theme_list"),
      themeGenerate: (opts) => invoke("theme_generate", { opts }),
      themeGenerateFrom: (path, opts) => invoke("theme_generate_from", { path, opts }),
      themeCommit: theme => invoke("theme_commit", { theme }),
      themeExportDraft: (theme, path) => invoke("theme_export_draft", { theme, path }),
      themeSave: (theme) => invoke("theme_save", { theme }),
      themeLoad: (id) => invoke("theme_load", { id }),
      themeDelete: (id) => invoke("theme_delete", { id }),
      themeActivate: (id) => invoke("theme_activate", { id }),
      themeImport: (path) => invoke("theme_import", { path }),
      themeExport: (id, path) => invoke("theme_export", { id, path }),
      // 原生文件对话框（rfd）：选一张图 / 存一份主题 / 选字体
      pickImage: async () => {
        const r = await window.__TAURI__?.dialog?.open?.({
          multiple: false,
          filters: [{ name: "图片", extensions: ["jpg", "jpeg", "png", "bmp", "webp"] }],
        });
        return typeof r === "string" ? r : null;
      },
      pickFontFile: async () => {
        const r = await window.__TAURI__?.dialog?.open?.({
          multiple: false,
          filters: [{ name: "字体文件", extensions: ["ttf", "otf", "woff", "woff2"] }],
        });
        return typeof r === "string" ? r : null;
      },
      pickSavePath: async (defaultName) => {
        const r = await window.__TAURI__?.dialog?.save?.({
          defaultPath: defaultName,
          filters: [{ name: "Kal 主题", extensions: ["json"] }],
        });
        return typeof r === "string" ? r : null;
      },
      pickExportPath: async (defaultName, ext = "pdf") => {
        const filterMap = {
          pdf: { name: "PDF 日历文档", extensions: ["pdf"] },
          md: { name: "Markdown 日历归档", extensions: ["md"] },
          ics: { name: "iCalendar 日程", extensions: ["ics"] },
          html: { name: "可打印网页日历", extensions: ["html"] },
        };
        const r = await window.__TAURI__?.dialog?.save?.({
          defaultPath: defaultName,
          filters: [filterMap[ext] || filterMap.pdf],
        });
        return typeof r === "string" ? r : null;
      },
      pickImportIcsFile: async () => {
        const r = await window.__TAURI__?.dialog?.open?.({
          multiple: false,
          filters: [{ name: "iCalendar 日历 (.ics)", extensions: ["ics"] }],
        });
        return typeof r === "string" ? r : null;
      },
      calendarExportText: (path, content) => invoke("calendar_export_text", { path, content }),
      calendarExportPdf: (path, html) => invoke("calendar_export_pdf", { path, html }),
      pickThemeFile: async () => {
        const r = await window.__TAURI__?.dialog?.open?.({
          multiple: false,
          filters: [{ name: "Kal 主题", extensions: ["json"] }],
        });
        return typeof r === "string" ? r : null;
      },
      fontsList: () => invoke("fonts_list"),
      localFontsList: () => invoke("local_fonts_list"),
      localFontRead: (id) => invoke("local_font_read", { id }),
      localFontImport: (path) => invoke("local_font_import", { path }),

      setEmbedMode: (mode) => invoke("set_embed_mode", { mode }),
      windowSetClickThrough: (enabled) => invoke("window_set_click_through", { enabled: Boolean(enabled) }),
      deskReport: () => invoke("desk_report"),
      hitTestSelf: () => invoke("hit_test_self"),
      geometrySave: () => invoke("window_geometry_save"),

      on: (event, cb) => window.__TAURI__?.event?.listen ? window.__TAURI__.event.listen(event, cb) : Promise.resolve(() => {}),
    };
  }

  const mock = createMockSource();
  mock.label = "演示数据";
  mock.bootError = null;
  mock.appInfo = async () => ({ uiScale: 1, themeId: "default", display: null, dbFound: true });
  mock.wallpaperInfo = async () => ({ path: "", source: "none", exists: false });
  mock.wallpaperReadImage = async (path = null) => ({
    path: path || "demo-wallpaper.svg",
    source: path ? "custom" : "demo",
    mime: "image/svg+xml",
    dataUrl: "data:image/svg+xml;utf8," + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0f2027"/><stop offset="50%" stop-color="#203a43"/><stop offset="100%" stop-color="#2c5364"/></linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/><circle cx="920" cy="220" r="180" fill="#60a5fa" opacity="0.22"/><path d="M0 620 Q320 480 640 590 T1200 540 L1200 800 L0 800 Z" fill="#0b151c" opacity="0.55"/></svg>`
    ),
  });
  const memoryThemes = new Map();
  let activeTheme = structuredClone(DEFAULT_THEME);
  mock.themeActive = async () => structuredClone(activeTheme);
  mock.themeList = async () => [...memoryThemes.values()].map(t => ({ id: t.id, name: t.name, mode: t.mode, builtin: false }));
  mock.themeLoad = async id => {
    if (!memoryThemes.has(id)) throw new Error("演示主题不存在");
    return structuredClone(memoryThemes.get(id));
  };
  mock.themeCommit = async theme => {
    const saved = { ...structuredClone(theme), id: `demo-${Date.now()}-${memoryThemes.size}` };
    memoryThemes.set(saved.id, saved); activeTheme = saved;
    return structuredClone(saved);
  };
  mock.themeExportDraft = async () => { throw new Error("请在 Kal 桌面程序中导出主题"); };
  mock.themeGenerate = async () => ({ theme: null, report: null });
  mock.themeGenerateFrom = async () => ({ theme: null, report: null });
  mock.fontsList = async () => ["Microsoft YaHei UI", "Segoe UI", "Consolas", "霞鹜文楷", "思源黑体"];
  mock.localFontsList = async () => ({ directory: "%APPDATA%\\Kal\\fonts", fonts: [], skipped: 0, maxFileBytes: 16777216, maxLoadedBytes: 33554432 });
  mock.localFontRead = async () => { throw new Error("浏览器演示模式无法读取本机字体，请在 Kal 桌面程序中使用"); };
  mock.localFontImport = async () => { throw new Error("浏览器演示模式无法导入本机字体，请在 Kal 桌面程序中使用"); };
  let memorySettings = {};
  mock.settingsGet = async () => {
    if (typeof window === "undefined") return structuredClone(memorySettings);
    const raw = window.localStorage.getItem("kal.local-settings/1");
    if (!raw) return {};
    const settings = JSON.parse(raw);
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("本地设置格式无效");
    return settings;
  };
  mock.settingsSet = async patch => {
    let next = await mock.settingsGet();
    for (const [key, value] of Object.entries(patch)) {
      const old = next[key];
      next = { ...next, [key]: old && value && typeof old === "object" && typeof value === "object" &&
        !Array.isArray(old) && !Array.isArray(value) ? { ...old, ...value } : value };
    }
    if (typeof window !== "undefined") window.localStorage.setItem("kal.local-settings/1", JSON.stringify(next));
    memorySettings = next;
    return structuredClone(next);
  };
  const mockNotes = [
    {
      id: "demo-note",
      title: "欢迎使用 Kal",
      content: "这是演示便签。\n支持在便签本中直接新建、编辑和删除个人随手记。",
      preview: "这是演示便签。\n支持在便签本中直接新建、编辑和删除个人随手记。",
      created: "2026-10-26 09:00",
      modified: "2026-10-26 09:00",
    },
  ];
  mock.notesList = async (offset = 0) => ({
    notes: offset ? [] : mockNotes.map(({ content: _c, ...rest }) => ({ ...rest })),
    hasMore: false,
  });
  mock.noteGet = async id => {
    const found = mockNotes.find(n => n.id === id) || mockNotes[0];
    return { content: found ? found.content : "", truncated: false };
  };
  mock.noteSave = async (id, title, content) => {
    const cleanTitle = String(title ?? "").trim();
    if (!cleanTitle) throw new Error("便签标题不能为空");
    const nowStr = new Date().toISOString().slice(0, 16).replace("T", " ");
    const preview = String(content ?? "").slice(0, 160);
    if (id) {
      const existing = mockNotes.find(n => n.id === id);
      if (existing) {
        existing.title = cleanTitle;
        existing.content = String(content ?? "");
        existing.preview = preview;
        existing.modified = nowStr;
        return { id: existing.id, title: existing.title, preview: existing.preview, created: existing.created, modified: existing.modified };
      }
    }
    const newNote = {
      id: `nt-mock-${Date.now()}`,
      title: cleanTitle,
      content: String(content ?? ""),
      preview,
      created: nowStr,
      modified: nowStr,
    };
    mockNotes.unshift(newNote);
    return { id: newNote.id, title: newNote.title, preview: newNote.preview, created: newNote.created, modified: newNote.modified };
  };
  mock.noteDelete = async id => {
    const idx = mockNotes.findIndex(n => n.id === id);
    if (idx >= 0) mockNotes.splice(idx, 1);
    return { status: "saved" };
  };
  mock.desktopStatus = async () => ({ enabled: false, registered: false, shortcut: "Win+Alt+C", error: null });
  mock.desktopSetHotkey = async () => { throw new Error("请在 Kal 桌面应用中使用全局快捷键"); };
  mock.windowSetClickThrough = async enabled => Boolean(enabled);
  mock.pickImage = async () => null;
  mock.pickFontFile = async () => null;
  mock.pickSavePath = async () => null;
  mock.pickExportPath = async () => null;
  mock.pickImportIcsFile = async () => null;
  mock.calendarExportText = async (path) => path;
  mock.calendarExportPdf = async (path) => path;
  mock.pickThemeFile = async () => null;
  mock.on = () => Promise.resolve(() => {});
  return mock;
}
