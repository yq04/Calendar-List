// 主题层：把主题 JSON 写进 CSS 自定义属性
//
// 设计要点：TOKENS 是一份**声明式映射表**，同时被三处复用 ——
//   1. applyTheme() 把主题写进 CSS 变量；
//   2. panel.js 由它自动生成设置控件（增删 token 只改这一处）；
//   3. 单元测试拿它做「主题字段是否都有出口」的覆盖检查。
// 这样就不会出现「主题里加了字段但界面调不到」的隐性漏配。

/**
 * kind 的语义：
 *   color  hex 字符串 -> "R G B" 三元组（配合 rgb(var(--x) / a) 用）
 *   alpha  0..1 数值，原样写入
 *   size   设计像素数 -> calc(N * var(--kal-u))，随缩放基元伸缩
 *   num    原样数值（字重、行高倍数）
 *   em     数值 -> "Nem"
 *   str    字符串原样
 */
export const TOKENS = [
  // ---- 表面 ----
  { path: "color.bg", var: "--kal-bg", kind: "color" },
  { path: "color.bgAlpha", var: "--kal-bg-alpha", kind: "alpha" },
  { path: "color.surface", var: "--kal-surface", kind: "color" },
  { path: "color.surfaceAlpha", var: "--kal-surface-alpha", kind: "alpha" },
  { path: "color.surfaceHover", var: "--kal-surface-hover", kind: "color" },
  { path: "color.surfaceHoverAlpha", var: "--kal-surface-hover-alpha", kind: "alpha" },
  { path: "color.line", var: "--kal-line", kind: "color" },
  { path: "color.lineAlpha", var: "--kal-line-alpha", kind: "alpha" },
  { path: "color.borderAlpha", var: "--kal-border-alpha", kind: "alpha" },

  { path: "color.danger", var: "--kal-danger", kind: "color" },
  { path: "color.dangerFg", var: "--kal-danger-fg", kind: "color" },
  { path: "color.focus", var: "--kal-focus", kind: "color" },
  { path: "color.done", var: "--kal-done", kind: "color" },
  { path: "color.selectedBg", var: "--kal-selected-bg", kind: "color" },
  { path: "color.selectedFg", var: "--kal-selected-fg", kind: "color" },
  // ---- 文字 ----
  { path: "color.fg", var: "--kal-fg", kind: "color" },
  { path: "color.fgMuted", var: "--kal-fg-muted", kind: "color" },
  { path: "color.fgDim", var: "--kal-fg-dim", kind: "color" },
  { path: "color.fgWeekend", var: "--kal-fg-weekend", kind: "color" },
  { path: "color.fgHoliday", var: "--kal-fg-holiday", kind: "color" },
  { path: "color.fgOtherMonth", var: "--kal-fg-othermonth", kind: "color" },

  // ---- 强调 ----
  { path: "color.accent", var: "--kal-accent", kind: "color" },
  { path: "color.accentFg", var: "--kal-accent-fg", kind: "color" },
  { path: "color.todayBg", var: "--kal-today-bg", kind: "color" },
  { path: "color.todayBgAlpha", var: "--kal-today-bg-alpha", kind: "alpha" },
  { path: "color.todayRing", var: "--kal-today-ring", kind: "color" },
  { path: "color.todayRingAlpha", var: "--kal-today-ring-alpha", kind: "alpha" },

  // ---- 字体 ----
  { path: "type.familyUi", var: "--kal-font-family", kind: "str" },
  { path: "type.familyNum", var: "--kal-font-family-num", kind: "str" },
  { path: "type.stretch", var: "--kal-font-stretch", kind: "stretch" },
  { path: "type.size.day", var: "--kal-fs-day", kind: "size" },
  { path: "type.size.sub", var: "--kal-fs-sub", kind: "size" },
  { path: "type.size.task", var: "--kal-fs-task", kind: "size" },
  { path: "type.size.title", var: "--kal-fs-title", kind: "size" },
  { path: "type.size.head", var: "--kal-fs-head", kind: "size" },
  { path: "type.size.agenda", var: "--kal-fs-agenda", kind: "size" },
  { path: "type.weight.day", var: "--kal-fw-day", kind: "num" },
  { path: "type.weight.title", var: "--kal-fw-title", kind: "num" },
  { path: "type.weight.task", var: "--kal-fw-task", kind: "num" },
  { path: "type.lineHeight.tight", var: "--kal-lh-tight", kind: "num" },
  { path: "type.lineHeight.normal", var: "--kal-lh-normal", kind: "num" },
  { path: "type.letterSpacing.title", var: "--kal-ls-title", kind: "em" },
  { path: "type.letterSpacing.head", var: "--kal-ls-head", kind: "em" },

  // ---- 形状 ----
  { path: "shape.radius", var: "--kal-radius", kind: "size" },
  { path: "shape.radiusCell", var: "--kal-radius-cell", kind: "size" },
  { path: "shape.blur", var: "--kal-blur", kind: "size" },
  { path: "shape.borderWidth", var: "--kal-border-w", kind: "size" },
  { path: "shape.cellAlpha", var: "--kal-cell-alpha", kind: "alpha" },
  { path: "shape.textShadow", var: "--kal-text-shadow-strength", kind: "alpha" },

  // ---- 壁纸与画布 ----
  { path: "backdrop.opacity", var: "--kal-backdrop-opacity", kind: "alpha" },
  { path: "backdrop.blur", var: "--kal-backdrop-blur", kind: "size" },
  { path: "backdrop.brightness", var: "--kal-backdrop-brightness", kind: "num" },
  { path: "backdrop.saturate", var: "--kal-backdrop-saturate", kind: "num" },
  { path: "backdrop.vignette", var: "--kal-backdrop-vignette", kind: "alpha" },
  { path: "backdrop.fit", var: "--kal-backdrop-fit", kind: "str" },

  // ---- 间距 ----
  { path: "layout.pad", var: "--kal-pad", kind: "size" },
  { path: "layout.padSm", var: "--kal-pad-sm", kind: "size" },
  { path: "layout.gap", var: "--kal-gap", kind: "size" },
  { path: "layout.cellGap", var: "--kal-cell-gap", kind: "size" },
  { path: "layout.agendaWidth", var: "--kal-agenda-w", kind: "size" },
];

// 这些字段不是 CSS 变量，而是切换 <body> 上的开关类
export const BODY_FLAGS = [
  { path: "mode", cls: "kal-mode-light", on: v => v === "light" },
  { path: "type.italic", cls: "kal-font-italic", on: v => v === true },
  { path: "type.cellAlign", cls: "kal-cell-center", on: v => v === "center" },
  { path: "layout.agenda", cls: "kal-agenda-hidden", on: v => v === "hidden" },
  { path: "layout.showWeekendColor", cls: "kal-no-weekend-color", on: v => v === false },
  { path: "layout.showCellCount", cls: "kal-no-cell-count", on: v => v === false },
  { path: "layout.showLunar", cls: "kal-no-lunar", on: v => v === false },
  { path: "layout.showHolidayBadge", cls: "kal-no-holiday-badge", on: v => v === false },
  { path: "layout.showWeekNumber", cls: "kal-no-week-number", on: v => v === false },
  { path: "layout.showYiJi", cls: "kal-no-yiji", on: v => v !== true },
  { path: "layout.taskWrap", cls: "kal-task-clamp2", on: v => v === "clamp2" },
  { path: "layout.taskWrap", cls: "kal-task-nowrap", on: v => v === "nowrap" },
  { path: "layout.bulletStyle", cls: "kal-bullet-number", on: v => v === "number" },
  { path: "layout.bulletStyle", cls: "kal-bullet-none", on: v => v === "none" },
  { path: "shape.blur", cls: "kal-use-blur", on: v => Number(v) > 0 },
  { path: "shape.gridStyle", cls: "kal-grid-table", on: v => v === "grid" },
  { path: "shape.gridStyle", cls: "kal-grid-minimal", on: v => v === "minimal" },
  { path: "backdrop.mode", cls: "kal-has-backdrop", on: v => v === "desktop" || v === "custom" || v === "art" },
  { path: "backdrop.mode", cls: "kal-backdrop-art-mode", on: v => v === "art" },
  { path: "backdrop.mode", cls: "kal-backdrop-img-mode", on: v => v === "desktop" || v === "custom" },
  { path: "layout.reducedMotion", cls: "kal-reduced-motion", on: v => v === true },
];

// ---------------------------------------------------------------- 路径工具

export function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** 不可变写入：返回新对象，便于做撤销与「预览/落盘」分离 */
export function setPath(obj, path, value) {
  const keys = path.split(".");
  const clone = Array.isArray(obj) ? obj.slice() : { ...obj };
  let cur = clone;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    cur[k] = Array.isArray(cur[k]) ? cur[k].slice() : { ...(cur[k] || {}) };
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return clone;
}

// ---------------------------------------------------------------- 值转换

/** "#RRGGBB" -> "R G B"（CSS 里配合 rgb(var(--x) / alpha) 使用） */
export function hexToTriplet(hex) {
  if (typeof hex !== "string") return null;
  const h = hex.replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  if (full.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(full)) return null;
  const n = parseInt(full, 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

export function tripletToHex(triplet) {
  const parts = String(triplet).trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return "#000000";
  const q = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${q(parts[0])}${q(parts[1])}${q(parts[2])}`.toUpperCase();
}

/** 把 token 值转成 CSS 变量能用的字符串；返回 null 表示跳过 */
export function toCssValue(kind, v) {
  switch (kind) {
    case "stretch":
      return typeof v === "number" && Number.isFinite(v) && v >= 50 && v <= 200 ? `${v}%` : null;
    case "color": {
      const t = hexToTriplet(v);
      return t;
    }
    case "alpha":
      return Number.isFinite(+v) ? String(+v) : null;
    case "size":
      return Number.isFinite(+v) ? `calc(${+v} * var(--kal-u))` : null;
    case "num":
      return Number.isFinite(+v) ? String(+v) : null;
    case "em":
      return Number.isFinite(+v) ? `${+v}em` : null;
    case "str":
      return typeof v === "string" && v.length ? v : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------- 应用

const themeListeners = new Set();
export function onThemeApplied(listener) {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
}

/**
 * 把主题写进 :root 的 CSS 变量，并同步 body 开关类。
 * @param {object} theme 主题对象（可只含部分字段，用于「实时预览」）
 * @param {{doc?: Document, flags?: boolean}} [opt]
 */
export function applyTheme(theme, opt = {}) {
  theme = normalizeTheme(theme);
  const doc = opt.doc || document;
  const root = doc.documentElement;

  for (const t of TOKENS) {
    const v = getPath(theme, t.path);
    if (v === undefined || v === null) continue;
    const css = toCssValue(t.kind, v);
    if (css === null) continue;
    root.style.setProperty(t.var, css);
  }
  // Old themes have no stretch field; reset it rather than inheriting a previous theme.
  const stretch = toCssValue("stretch", getPath(theme, "type.stretch")) || "100%";
  root.style.setProperty("--kal-font-stretch", stretch);
  doc.body.style?.setProperty("font-stretch", stretch);

  // 日格实际背景不透明度：由次级表面不透明度 × 日格浓度系数决定
  const surfAlpha = Number(getPath(theme, "color.surfaceAlpha") ?? DEFAULT_THEME.color.surfaceAlpha);
  const cellAlpha = Number(getPath(theme, "shape.cellAlpha") ?? DEFAULT_THEME.shape.cellAlpha);
  if (Number.isFinite(surfAlpha) && Number.isFinite(cellAlpha)) {
    root.style.setProperty("--kal-cell-bg-alpha", String(Math.max(0, Math.min(1, surfAlpha * cellAlpha))));
  }

  // 文字护航阴影：在透明底或复杂壁纸上提供自适应对比度光晕
  const ts = Number(getPath(theme, "shape.textShadow") ?? 0);
  const bgAlpha = Number(getPath(theme, "color.bgAlpha") ?? DEFAULT_THEME.color.bgAlpha);
  if (!Number.isFinite(ts) || ts <= 0) {
    root.style.setProperty("--kal-text-shadow", "none");
  } else {
    const isLight = getPath(theme, "mode") === "light";
    const c = isLight ? "255, 255, 255" : "0, 0, 0";
    const a1 = Math.min(0.98, ts * 0.92).toFixed(2);
    const a2 = Math.min(0.90, ts * 0.65).toFixed(2);
    if (Number.isFinite(bgAlpha) && bgAlpha <= 0.18) {
      root.style.setProperty(
        "--kal-text-shadow",
        `0 0 2px rgba(${c}, ${a1}), 0 1px 4px rgba(${c}, ${a1}), 0 0 12px rgba(${c}, ${a2})`
      );
    } else {
      root.style.setProperty("--kal-text-shadow", `0 1px 3px rgba(${c}, ${a1}), 0 0 10px rgba(${c}, ${a2})`);
    }
  }

  // 内置艺术背景预设标记
  const preset = getPath(theme, "backdrop.preset") || DEFAULT_THEME.backdrop.preset;
  if (doc.body?.dataset) {
    doc.body.dataset.backdropPreset = preset;
  }

  // 阴影是复合值：bool + 强度 -> 一条 box-shadow
  const shadow = getPath(theme, "shape.shadow");
  if (shadow !== undefined) {
    if (shadow === false) {
      root.style.setProperty("--kal-shadow", "none");
    } else {
      const s = Number(getPath(theme, "shape.shadowStrength"));
      const a = Number.isFinite(s) ? s : 0.42;
      root.style.setProperty("--kal-shadow", `0 18px 48px rgba(0,0,0,${a})`);
    }
  }

  if (opt.flags !== false) {
    for (const f of BODY_FLAGS) {
      const v = getPath(theme, f.path);
      if (v === undefined && f.path !== "layout.showYiJi") continue;
      doc.body.classList.toggle(f.cls, f.on(v));
    }
  }
  const lang = getPath(theme, "layout.language") || "zh-CN";
  if (doc?.documentElement && typeof doc.querySelector === "function") {
    applyI18nToDom(lang, doc);
  }
  for (const listener of themeListeners) listener(theme, doc);
}

/** 缩放基元：1 设计像素 = 1 * scale 个 CSS 像素 */
export function setUiScale(scale, doc = document) {
  const s = Number(scale);
  if (!Number.isFinite(s) || s <= 0) return;
  doc.documentElement.style.setProperty("--kal-ui-scale", String(s));
}

/** 内置默认主题：默认采用「星港素纸」浅色高对比度纸感主题（与 Rust 侧 Theme::default 保持一致） */
export const DEFAULT_THEME = {
  schema: "kal.theme/1",
  id: "default",
  name: "星港素纸",
  mode: "light",
  color: {
    bg: "#FBF6EC", bgAlpha: 1,
    surface: "#FFFDF7", surfaceAlpha: 1,
    surfaceHover: "#E8EDF8", surfaceHoverAlpha: 1,
    danger: "#A3314B", dangerFg: "#FFFDF7", focus: "#2649A0", done: "#536389", selectedBg: "#E2E9F7", selectedFg: "#172648",
    fg: "#172648", fgMuted: "#536389", fgDim: "#536389",
    fgWeekend: "#A3314B", fgHoliday: "#A3314B", fgOtherMonth: "#536389",
    accent: "#2649A0", accentFg: "#FFFDF7",
    todayBg: "#E2E9F7", todayBgAlpha: 1,
    todayRing: "#2649A0", todayRingAlpha: 1,
    line: "#D5DCEB", lineAlpha: 1, borderAlpha: 1,
  },
  type: {
    familyUi: '"Microsoft YaHei UI", "Segoe UI", "PingFang SC", "Noto Sans SC", system-ui, sans-serif',
    familyNum: '"Segoe UI Variable Display", "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif',
    stretch: 100,
    size: { day: 16.5, sub: 13, task: 13, title: 30, head: 12.5, agenda: 14 },
    weight: { day: 600, title: 700, task: 400 },
    lineHeight: { tight: 1.15, normal: 1.45 },
    letterSpacing: { title: -0.02, head: 0.14 },
    italic: false,
    cellAlign: "left",
  },
  shape: {
    radius: 18, radiusCell: 10, blur: 0,
    shadow: false, shadowStrength: 0, borderWidth: 1,
    cellAlpha: 1, textShadow: 0, gridStyle: "cards",
  },
  backdrop: {
    mode: "none",
    preset: "aurora",
    opacity: 0.72,
    blur: 0,
    brightness: 1,
    saturate: 1,
    fit: "cover",
    vignette: 0.15,
  },
  layout: {
    pad: 16, padSm: 8, gap: 6, cellGap: 3,
    agenda: "hidden", agendaWidth: 268,
    weekStart: 1, maxTasks: 4,
    showLunar: true, showWeekendColor: true, showCellCount: true,
    showHolidayBadge: true, showWeekNumber: true, showYiJi: false,
    taskWrap: "wrap", bulletStyle: "dot", hideCompleted: false, sortCompletedLast: false,
    language: "zh-CN", reducedMotion: false,
  },
  scale: 1,
  scaleMode: "auto",
};

/** 当前软件发布版本号与阶段标识 */
export const APP_VERSION = "0.1.2";
export const APP_STAGE_LABEL = "v0.1.2";

/** 6 款内置零依赖高颜值艺术壁纸预设 */
export const ART_BACKDROPS = [
  { id: "aurora", name: "极光星云", desc: "深邃北极光与星尘柔光" },
  { id: "ink-paper", name: "水墨宣纸", desc: "温润宣纸底纹与远山淡墨" },
  { id: "sunset-glow", name: "落日流金", desc: "暮色琥珀与霞光地平线" },
  { id: "cyber-grid", name: "赛博霓虹", desc: "暗夜青紫透视光栅" },
  { id: "forest-mist", name: "迷雾森林", desc: "松林晨雾与林间丁达尔光" },
  { id: "warm-grain", name: "暖阳胶片", desc: "复古暖焦糖散景光斑" },
];

/** 6 组一键视觉与透明质感配方（不破坏用户配色色相、字体与日程数据） */
export const STYLE_RECIPES = [
  {
    id: "paper",
    name: "温润实底（默认）",
    desc: "100%不透明纯净纸感，无模糊零干扰",
    patch: {
      "color.bgAlpha": 1,
      "color.surfaceAlpha": 1,
      "color.borderAlpha": 1,
      "color.lineAlpha": 1,
      "shape.cellAlpha": 1,
      "shape.blur": 0,
      "shape.shadow": false,
      "shape.shadowStrength": 0,
      "shape.radius": 18,
      "shape.radiusCell": 10,
      "shape.borderWidth": 1,
      "shape.textShadow": 0,
      "shape.gridStyle": "cards",
      "layout.cellGap": 3,
      "backdrop.mode": "none",
    },
  },
  {
    id: "transparent",
    name: "纯透悬浮",
    desc: "0%全透明底穿透桌面，开启文字护航光晕",
    patch: {
      "color.bgAlpha": 0,
      "color.surfaceAlpha": 0.14,
      "color.borderAlpha": 0,
      "color.lineAlpha": 0.08,
      "shape.cellAlpha": 0,
      "shape.blur": 0,
      "shape.shadow": false,
      "shape.borderWidth": 0,
      "shape.textShadow": 0.68,
      "shape.gridStyle": "minimal",
      "backdrop.mode": "none",
    },
  },
  {
    id: "frosted",
    name: "冰晶毛玻璃",
    desc: "半透磨砂质感与细腻内高光圆角卡片",
    patch: {
      "color.bgAlpha": 0.50,
      "color.surfaceAlpha": 0.48,
      "color.borderAlpha": 0.16,
      "color.lineAlpha": 0.10,
      "shape.cellAlpha": 0.42,
      "shape.blur": 28,
      "shape.shadow": true,
      "shape.shadowStrength": 0.45,
      "shape.radius": 20,
      "shape.radiusCell": 11,
      "shape.borderWidth": 1,
      "shape.textShadow": 0.18,
      "shape.gridStyle": "cards",
    },
  },
  {
    id: "canvas",
    name: "沉浸画布",
    desc: "内嵌艺术/自定义壁纸画布，带氛围暗角与微磨砂",
    patch: {
      "color.bgAlpha": 0.34,
      "color.surfaceAlpha": 0.38,
      "color.borderAlpha": 0.18,
      "shape.cellAlpha": 0.32,
      "shape.blur": 16,
      "shape.shadow": true,
      "shape.shadowStrength": 0.50,
      "shape.textShadow": 0.42,
      "shape.gridStyle": "cards",
      "backdrop.mode": "art",
      "backdrop.opacity": 0.84,
      "backdrop.blur": 4,
      "backdrop.vignette": 0.22,
    },
  },
  {
    id: "grid",
    name: "经典网格",
    desc: "无缝连线表格日历，紧凑清晰",
    patch: {
      "color.lineAlpha": 0.24,
      "shape.radiusCell": 0,
      "shape.cellAlpha": 0.18,
      "shape.borderWidth": 1,
      "shape.gridStyle": "grid",
      "layout.cellGap": 0,
    },
  },
  {
    id: "minimal",
    name: "极简无框",
    desc: "隐去格框与冗余线条，纯粹呈现日期与安排",
    patch: {
      "color.bgAlpha": 0.76,
      "color.surfaceAlpha": 0.24,
      "color.borderAlpha": 0.05,
      "color.lineAlpha": 0.06,
      "shape.cellAlpha": 0,
      "shape.borderWidth": 0,
      "shape.gridStyle": "minimal",
      "layout.cellGap": 4,
    },
  },
];

/** 6 组精选字体搭配预设 */
export const FONT_PRESETS = [
  {
    id: "default-ui",
    name: "现代雅黑（默认）",
    desc: "默认无衬线，清晰均衡",
    familyUi: DEFAULT_THEME.type.familyUi,
    familyNum: DEFAULT_THEME.type.familyNum,
    italic: false,
  },
  {
    id: "literary-kai",
    name: "书卷人文",
    desc: "霞鹜文楷 / 楷体 / 华文楷体",
    familyUi: '"LXGW WenKai", "霞鹜文楷", "KaiTi", "楷体", "STKaiti", "Microsoft YaHei UI", serif',
    familyNum: '"Georgia", "Cambria", "Times New Roman", "KaiTi", serif',
    italic: false,
  },
  {
    id: "editorial-song",
    name: "典雅报刊",
    desc: "思源宋体 / 宋体 / 衬线数字",
    familyUi: '"Source Han Serif SC", "Noto Serif SC", "思源宋体", "STSong", "SimSun", "宋体", serif',
    familyNum: '"Georgia", "Times New Roman", "Cambria", serif',
    italic: false,
  },
  {
    id: "geek-mono",
    name: "极客等宽",
    desc: "Geist Mono / Cascadia / JetBrains",
    familyUi: '"Geist Mono", "Cascadia Mono", "JetBrains Mono", "Sarasa Mono SC", "Consolas", "Microsoft YaHei UI", monospace',
    familyNum: '"Geist Mono", "Cascadia Mono", "JetBrains Mono", "Consolas", monospace',
    italic: false,
  },
  {
    id: "soft-round",
    name: "圆润亲和",
    desc: "Plus Jakarta / 幼圆 / 等线",
    familyUi: '"Plus Jakarta Sans", "YouYuan", "幼圆", "DengXian", "等线", "Microsoft YaHei UI", sans-serif',
    familyNum: '"Plus Jakarta Sans", "Segoe UI Variable Display", "DengXian", "Segoe UI", sans-serif',
    italic: false,
  },
  {
    id: "crisp-sans",
    name: "利落黑体",
    desc: "Geist / Manrope / 鸿蒙黑体 / 思源黑体",
    familyUi: '"Geist", "Manrope", "HarmonyOS Sans SC", "Source Han Sans SC", "Noto Sans SC", "思源黑体", "Microsoft YaHei UI", sans-serif',
    familyNum: '"Geist", "Manrope", "Segoe UI Variable Display", "Bahnschrift", "Segoe UI", sans-serif',
    italic: false,
  },
];

/** 4 组一键日历内容排版与换行密度方案 */
export const CONTENT_PRESETS = [
  {
    id: "standard-wrap",
    name: "标准全显（默认）",
    desc: "自动多行换行，完整呈现日程，字号清晰均衡",
    patch: {
      "layout.taskWrap": "wrap",
      "layout.maxTasks": 4,
      "layout.bulletStyle": "dot",
      "type.size.day": 16.5,
      "type.size.sub": 13,
      "type.size.task": 13,
      "type.lineHeight.normal": 1.45,
    },
  },
  {
    id: "large-comfort",
    name: "大字护眼",
    desc: "加大日期与事项字号，自动换行，高分屏友好",
    patch: {
      "layout.taskWrap": "wrap",
      "layout.maxTasks": 3,
      "layout.bulletStyle": "dot",
      "type.size.day": 18,
      "type.size.sub": 14,
      "type.size.task": 14.5,
      "type.lineHeight.normal": 1.5,
    },
  },
  {
    id: "clamp-2",
    name: "均衡紧凑",
    desc: "紧凑字号，安排内容自动换行完整显示",
    patch: {
      "layout.taskWrap": "wrap",
      "layout.maxTasks": 5,
      "layout.bulletStyle": "dot",
      "type.size.day": 15.5,
      "type.size.sub": 12.5,
      "type.size.task": 12,
    },
  },
  {
    id: "compact-single",
    name: "紧凑编号",
    desc: "紧凑字号与编号，安排内容自动换行完整显示",
    patch: {
      "layout.taskWrap": "wrap",
      "layout.maxTasks": 6,
      "layout.bulletStyle": "number",
      "type.size.day": 15,
      "type.size.sub": 12,
      "type.size.task": 11.5,
    },
  },
];

const CONTENT_RESET_PATHS = [
  "layout.taskWrap",
  "layout.maxTasks",
  "layout.bulletStyle",
  "type.size.day",
  "type.size.sub",
  "type.size.task",
  "type.lineHeight.normal",
];

/** 应用一键内容排版预设，返回新主题对象（先还原排版基准值再应用预设，避免跨预设残留） */
export function applyContentPreset(theme, presetId) {
  const preset = CONTENT_PRESETS.find(p => p.id === presetId);
  if (!preset) return theme;
  let next = structuredClone(theme);
  for (const path of CONTENT_RESET_PATHS) {
    next = setPath(next, path, getPath(DEFAULT_THEME, path));
  }
  for (const [path, val] of Object.entries(preset.patch)) {
    next = setPath(next, path, val);
  }
  return next;
}

const STYLE_RECIPE_RESET_PATHS = [
  "color.bgAlpha",
  "color.surfaceAlpha",
  "color.borderAlpha",
  "color.lineAlpha",
  "shape.cellAlpha",
  "shape.blur",
  "shape.shadow",
  "shape.shadowStrength",
  "shape.radius",
  "shape.radiusCell",
  "shape.borderWidth",
  "shape.textShadow",
  "shape.gridStyle",
  "layout.cellGap",
  "backdrop.mode",
  "backdrop.opacity",
  "backdrop.blur",
  "backdrop.vignette",
];

/** 应用一键风格配方，返回新主题对象（先重置质感相关字段到默认基准，再写入配方补丁，确保任意切换可完全还原） */
export function applyStyleRecipe(theme, recipeId) {
  const recipe = STYLE_RECIPES.find(r => r.id === recipeId);
  if (!recipe) return theme;
  let next = structuredClone(theme);
  for (const path of STYLE_RECIPE_RESET_PATHS) {
    next = setPath(next, path, getPath(DEFAULT_THEME, path));
  }
  for (const [path, val] of Object.entries(recipe.patch)) {
    next = setPath(next, path, val);
  }
  return next;
}

/** 应用精选字体预设，支持一键回到「现代雅黑（默认）」 */
export function applyFontPreset(theme, presetId) {
  const fp = FONT_PRESETS.find(f => f.id === presetId) || FONT_PRESETS[0];
  let next = structuredClone(theme);
  next = setPath(next, "type.familyUi", fp.familyUi);
  next = setPath(next, "type.familyNum", fp.familyNum);
  next = setPath(next, "type.italic", Boolean(fp.italic));
  if (fp.id === "default-ui") {
    next = setPath(next, "type.stretch", DEFAULT_THEME.type.stretch);
    next = setPath(next, "type.weight", structuredClone(DEFAULT_THEME.type.weight));
  }
  return next;
}

/**
 * 调节常驻桌面壁纸融合透明度（0 = 全透壁纸贴合，1 = 100% 温润实底），
 * 鼠标移入移出保持恒定透明度，不会忽明忽暗。
 */
export function applySteadyWallAlpha(theme, rawAlpha) {
  const alpha = Math.max(0, Math.min(1, Number(rawAlpha) || 0));
  let next = structuredClone(theme);
  if (alpha >= 0.98) {
    next = setPath(next, "color.bgAlpha", 1);
    next = setPath(next, "color.surfaceAlpha", 1);
    next = setPath(next, "color.borderAlpha", 1);
    next = setPath(next, "color.lineAlpha", 1);
    next = setPath(next, "shape.cellAlpha", 1);
    next = setPath(next, "shape.blur", 0);
    next = setPath(next, "shape.shadow", false);
    next = setPath(next, "shape.shadowStrength", 0);
    next = setPath(next, "shape.borderWidth", 1);
    next = setPath(next, "shape.textShadow", 0);
  } else if (alpha <= 0.03) {
    next = setPath(next, "color.bgAlpha", 0);
    next = setPath(next, "color.surfaceAlpha", 0.14);
    next = setPath(next, "color.borderAlpha", 0.08);
    next = setPath(next, "color.lineAlpha", 0.12);
    next = setPath(next, "shape.cellAlpha", 0.06);
    next = setPath(next, "shape.blur", 0);
    next = setPath(next, "shape.shadow", false);
    next = setPath(next, "shape.borderWidth", 0);
    next = setPath(next, "shape.textShadow", 0.68);
  } else {
    const a = Number(alpha.toFixed(2));
    next = setPath(next, "color.bgAlpha", a);
    next = setPath(next, "color.surfaceAlpha", Number(Math.max(0.22, Math.min(1, a * 0.92)).toFixed(2)));
    next = setPath(next, "color.borderAlpha", Number(Math.max(0.14, Math.min(1, a * 0.65)).toFixed(2)));
    next = setPath(next, "color.lineAlpha", Number(Math.max(0.12, Math.min(1, a * 0.55)).toFixed(2)));
    next = setPath(next, "shape.cellAlpha", Number(Math.max(0.18, Math.min(1, a * 0.84)).toFixed(2)));
    next = setPath(next, "shape.borderWidth", 1);
    next = setPath(next, "shape.textShadow", a < 0.55 ? 0.42 : (a < 0.82 ? 0.18 : 0));
  }
  return next;
}

/** Fill legacy semantic roles from that theme, never inherit a previous palette. */
export function normalizeTheme(theme) {
  if (theme?.schema && theme.schema !== "kal.theme/1") throw new Error(`不支持的主题版本：${theme.schema}`);
  const color = theme?.color;
  if (!color) return theme;
  return { ...theme, color: {
    danger: color.fgHoliday || color.fg,
    dangerFg: color.bg,
    focus: color.accent,
    done: color.fgMuted || color.fg,
    selectedBg: color.todayBg || color.surface,
    selectedFg: color.fg,
    ...color,
  }};
}

/** Palette previews keep personal typography, layout, geometry and scale. */
export function mergeThemeAppearance(current, source) {
  const selected = normalizeTheme(source);
  if (!selected?.color) throw new Error("主题缺少配色");
  const material = {};
  for (const key of ["blur", "shadow", "shadowStrength", "borderWidth"]) {
    if (selected.shape?.[key] !== undefined) material[key] = selected.shape[key];
  }
  return {
    ...current, schema: "kal.theme/1", id: "", name: selected.name,
    mode: selected.mode, source: selected.source, wallpaper: selected.wallpaper,
    color: structuredClone(selected.color), shape: { ...current.shape, ...material },
  };
}

/** 8 组精选主题强调色快选（参考 Antigravity Tools / Cockpit Tools / Claude-Local） */
export const ACCENT_SWATCHES = [
  { id: "starport-blue", name: "星港靛蓝", hex: "#2649A0", softLight: "#E2E9F7", softDark: "#1E3A8A" },
  { id: "claude-clay", name: "暖陶赤褐", hex: "#D97757", softLight: "#FCEEE8", softDark: "#5C2D1E" },
  { id: "emerald-pine", name: "松石翠绿", hex: "#059669", softLight: "#E0F7EF", softDark: "#064E3B" },
  { id: "aurora-violet", name: "极光暮紫", hex: "#7C3AED", softLight: "#EDE9FE", softDark: "#3B1D7A" },
  { id: "amber-gold", name: "琥珀暖金", hex: "#D97706", softLight: "#FEF3C7", softDark: "#5A3408" },
  { id: "crimson-rose", name: "朱砂海棠", hex: "#E11D48", softLight: "#FFE4E6", softDark: "#5F1429" },
  { id: "glacier-cyan", name: "冰川晴空", hex: "#0284C7", softLight: "#E0F2FE", softDark: "#0C4A6E" },
  { id: "graphite-slate", name: "石墨青灰", hex: "#334155", softLight: "#E2E8F0", softDark: "#1E293B" },
];

/** 应用一键强调色快选，联动更新焦点环、今日高亮框与选中底色 */
export function applyAccentSwatch(theme, hexOrId) {
  const swatch = ACCENT_SWATCHES.find(
    s => s.id === hexOrId || s.hex.toLowerCase() === String(hexOrId || "").toLowerCase()
  );
  const hex = swatch ? swatch.hex : (hexToTriplet(hexOrId) ? hexOrId : "#2649A0");
  const isLight = (theme?.mode || "light") === "light";
  const softBg = swatch
    ? (isLight ? swatch.softLight : swatch.softDark)
    : (theme?.color?.todayBg || "#E2E9F7");
  let next = structuredClone(theme);
  next = setPath(next, "color.accent", hex);
  next = setPath(next, "color.focus", hex);
  next = setPath(next, "color.todayRing", hex);
  next = setPath(next, "color.todayBg", softBg);
  next = setPath(next, "color.selectedBg", softBg);
  return next;
}

/** 多语言界面词典（简体中文 / 繁體中文 / English） */
export const I18N_BUNDLES = {
  "zh-CN": {
    today: "今天",
    weekView: "周视图",
    monthView: "月视图",
    lock: "固定",
    locked: "已固定",
    privacy: "防窥",
    privacyOn: "已防窥",
    glass: "透明底",
    search: "搜索",
    exportBtn: "导出",
    rollover: "顺延",
    copy: "复制",
    addPlaceholder: "添加安排",
    timePlaceholder: "HH:MM",
  },
  "zh-TW": {
    today: "今天",
    weekView: "週視圖",
    monthView: "月視圖",
    lock: "固定",
    locked: "已固定",
    privacy: "防窺",
    privacyOn: "已防窺",
    glass: "透明底",
    search: "搜尋",
    exportBtn: "匯出",
    rollover: "順延",
    copy: "複製",
    addPlaceholder: "新增安排",
    timePlaceholder: "HH:MM",
  },
  "en": {
    today: "Today",
    weekView: "Week",
    monthView: "Month",
    lock: "Pin",
    locked: "Pinned",
    privacy: "Privacy",
    privacyOn: "Masked",
    glass: "Glass",
    search: "Search",
    exportBtn: "Export",
    rollover: "+1d",
    copy: "Copy",
    addPlaceholder: "Add task",
    timePlaceholder: "HH:MM",
  },
};

export function applyI18nToDom(lang = "zh-CN", doc = document) {
  const bundle = I18N_BUNDLES[lang] || I18N_BUNDLES["zh-CN"];
  if (!doc?.documentElement) return bundle;
  doc.documentElement.lang = lang;
  const setSpanOrText = (sel, text) => {
    const node = doc.querySelector(sel);
    if (!node) return;
    const sp = node.querySelector?.("span");
    if (sp) sp.textContent = text;
    else node.textContent = text;
  };
  setSpanOrText("#kal-today", bundle.today);
  const viewBtn = doc.querySelector("#kal-view-toggle");
  if (viewBtn) {
    const isWeek = doc.body?.classList?.contains?.("kal-view-week");
    viewBtn.textContent = isWeek ? bundle.monthView : bundle.weekView;
  }
  const lockBtn = doc.querySelector("#kal-lock-btn");
  if (lockBtn && !lockBtn.classList.contains("is-active")) {
    setSpanOrText("#kal-lock-btn", bundle.lock);
  }
  const privBtn = doc.querySelector("#kal-privacy-btn");
  if (privBtn && !privBtn.classList.contains("is-active")) {
    setSpanOrText("#kal-privacy-btn", bundle.privacy);
  }
  setSpanOrText("#kal-quick-glass", bundle.glass);
  setSpanOrText("#kal-search-btn", bundle.search);
  setSpanOrText("#kal-export-btn", bundle.exportBtn);
  setSpanOrText("#kal-rollover-btn", bundle.rollover);
  const copyBtn = doc.querySelector("#kal-agenda-copy");
  if (copyBtn && copyBtn.textContent !== "已复制") {
    copyBtn.textContent = bundle.copy;
  }
  const input = doc.querySelector("#kal-agenda-input");
  if (input && !input.disabled) {
    input.placeholder = bundle.addPlaceholder;
  }
  const timeInput = doc.querySelector("#kal-agenda-time-input");
  if (timeInput) {
    timeInput.placeholder = bundle.timePlaceholder;
  }
  return bundle;
}


