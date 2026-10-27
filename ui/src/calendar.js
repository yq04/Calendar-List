// 日历核心逻辑：纯函数，可脱离 DOM 单独测试

export function pad(n) { return String(n).padStart(2, "0"); }
export function toKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
export function fromKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** 严格校验 YYYY-MM-DD 是否为真实存在的公历日期 */
export function isValidDateKey(key) {
  if (typeof key !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const [y, m, d] = key.split("-").map(Number);
  if (!Number.isInteger(y) || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** 校验时间字符串（允许空串或合法 24 小时制 HH:MM） */
export function isValidTimeStr(time) {
  if (time === "" || time === null || time === undefined) return true;
  if (typeof time !== "string") return false;
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(time.trim());
}

/**
 * 生成月历矩阵（固定 6 行 x 7 列 = 42 格）
 *
 * 固定 42 格是刻意的：行数随月份变化会让面板高度跳动，
 * 而桌面上一个会自己长高的挂件是很烦人的。
 */
export function getMonthMatrix(year, month, weekStart = 1) {
  const first = new Date(year, month, 1);
  const firstDow = first.getDay();               // 0=周日
  const lead = (firstDow - weekStart + 7) % 7;   // 往前补几天
  const start = new Date(year, month, 1 - lead);

  const todayKey = toKey(new Date());
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const dow = d.getDay();
    const key = toKey(d);
    cells.push({
      date: d,
      key,
      day: d.getDate(),
      inMonth: d.getMonth() === month && d.getFullYear() === year,
      isToday: key === todayKey,
      isWeekend: dow === 0 || dow === 6,
      dow,
    });
  }
  return cells;
}

/**
 * 裁剪月历末尾完全属于下个月的多余整周行（默认保留 5 行 = 35 格；仅当当月跨入第 6 周时保留 6 行）
 */
export function trimRedundantMonthRows(cells) {
  if (!Array.isArray(cells) || cells.length < 42) return cells || [];
  if (cells.slice(35, 42).every(c => !c.inMonth)) {
    return cells.slice(0, 35);
  }
  return cells;
}

/** 提取 42 格矩阵实际覆盖到的所有 (year, month) 组合，用于跨月邻格数据加载 */
export function getMatrixMonths(cells) {
  const seen = new Set();
  const out = [];
  for (const c of cells || []) {
    if (!c || !c.date) continue;
    const y = c.date.getFullYear();
    const m = c.date.getMonth();
    const k = `${y}-${pad(m + 1)}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ year: y, month: m, key: k });
    }
  }
  return out;
}

/** 合并多个月份的按日分组 Map，供 42 格跨月完整展示 */
export function mergeDayMaps(maps) {
  const merged = new Map();
  for (const mp of maps || []) {
    if (!mp || typeof mp.entries !== "function") continue;
    for (const [dateKey, list] of mp.entries()) {
      if (!Array.isArray(list) || !list.length) continue;
      if (!merged.has(dateKey)) {
        merged.set(dateKey, [...list]);
      } else {
        const existing = merged.get(dateKey);
        const ids = new Set(existing.map(e => e.id));
        for (const item of list) {
          if (!ids.has(item.id)) existing.push(item);
        }
        existing.sort((a, b) => String(a.time || "").localeCompare(String(b.time || "")));
      }
    }
  }
  return merged;
}

export function weekHeadLabels(weekStart = 1, labels = ["日", "一", "二", "三", "四", "五", "六"]) {
  const out = [];
  for (let i = 0; i < 7; i++) out.push(labels[(weekStart + i) % 7]);
  return out;
}

export function addMonths(year, month, delta) {
  const d = new Date(year, month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

const WEEKDAY_CN = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

export function formatAgendaDate(d) {
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAY_CN[d.getDay()]}`;
}

/** 把事件列表按日期分组，并按时间排序 */
export function groupByDay(events) {
  const map = new Map();
  for (const ev of events) {
    if (!ev || !ev.date) continue;
    let list = map.get(ev.date);
    if (!list) { list = []; map.set(ev.date, list); }
    list.push(ev);
  }
  for (const list of map.values()) {
    list.sort((a, b) => String(a.time || "").localeCompare(String(b.time || "")));
  }
  return map;
}

/** 解析右侧快速输入：`09:30 会议` 识别为带时间事件，其余作为普通日格任务。 */
export function parseQuickEntry(value) {
  const text = String(value ?? "").trim();
  const m = text.match(/^([01]\d|2[0-3]):([0-5]\d)\s+(.+)$/);
  if (m) return { time: `${m[1]}:${m[2]}`, title: m[3].trim(), kind: "event" };
  return { time: "", title: text, kind: "item" };
}

/** 从今天或本月 1 号里挑一个默认选中日 */
export function pickDefaultSelected(year, month) {
  const now = new Date();
  if (now.getFullYear() === year && now.getMonth() === month) return toKey(now);
  return `${year}-${pad(month + 1)}-01`;
}

function escapeIcsText(str) {
  return String(str ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * 生成符合 RFC 5545 标准的 iCalendar (.ics) 文本，支持导入 Apple 日历 / Outlook / Google Calendar / 飞书日历
 */
export function buildIcsCalendar(events = [], calName = "Kal Desktop Calendar") {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Kal//Desktop Calendar//CN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(calName)}`,
  ];

  for (let i = 0; i < (events || []).length; i++) {
    const ev = events[i];
    if (!ev || !isValidDateKey(ev.date) || !String(ev.title ?? "").trim()) continue;
    const ymd = ev.date.replace(/-/g, "");
    const uid = escapeIcsText(ev.id || `${ev.date}-${i}`) + "@kal.local";
    const timeStr = String(ev.time ?? "").trim();
    const tm = timeStr.match(/^([01]\d|2[0-3]):([0-5]\d)$/);

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${stamp}`);
    if (tm) {
      lines.push(`DTSTART:${ymd}T${tm[1]}${tm[2]}00`);
    } else {
      const dt = fromKey(ev.date);
      const nextDt = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + 1);
      const nextYmd = toKey(nextDt).replace(/-/g, "");
      lines.push(`DTSTART;VALUE=DATE:${ymd}`);
      lines.push(`DTEND;VALUE=DATE:${nextYmd}`);
    }
    lines.push(`SUMMARY:${escapeIcsText(String(ev.title).trim())}`);
    if (ev.note && String(ev.note).trim()) {
      lines.push(`DESCRIPTION:${escapeIcsText(String(ev.note).trim())}`);
    }
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

function escapeMdCell(str) {
  return String(str ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 导出月度日历为结构化 Markdown (.md)
 * 包含：YAML Frontmatter + 月度统计概览 + 7列 GFM 日历网格表（支持格内多行任务换行） + 按日分组待办明细
 */
export function buildMarkdownCalendar({
  year,
  month,
  weekStart = 1,
  byDay = new Map(),
  getLunarDay = null,
  getGanZhiYear = null,
  countdowns = [],
  options = {},
} = {}) {
  const includeLunar = options.includeLunar !== false;
  const includeCompleted = options.includeCompleted !== false;
  const includeAgendaDetail = options.includeAgenda !== false && options.includeAgendaDetail !== false;
  const includeStats = options.includeStats !== false;

  const cells = trimRedundantMonthRows(getMonthMatrix(year, month, weekStart));
  const rowCount = Math.ceil(cells.length / 7);
  const ymStr = `${year}-${pad(month + 1)}`;
  const lunarYearStr = typeof getGanZhiYear === "function" ? getGanZhiYear(year) : "";

  let totalTasks = 0;
  let completedTasks = 0;
  const monthDaysWithTasks = [];

  for (const c of cells) {
    const rawList = byDay.get(c.key) || [];
    const filtered = includeCompleted ? rawList : rawList.filter(ev => !ev.done);
    if (c.inMonth) {
      totalTasks += rawList.length;
      completedTasks += rawList.filter(ev => ev.done).length;
    }
    if (filtered.length > 0 && c.inMonth) {
      monthDaysWithTasks.push({ cell: c, list: filtered });
    }
  }

  const pendingTasks = Math.max(0, totalTasks - completedTasks);
  const rateStr = totalTasks > 0 ? `${Math.round((completedTasks / totalTasks) * 100)}%` : "100%";

  const md = [
    "---",
    `title: "${year}年${month + 1}月 日历与日程归档"`,
    `month: "${ymStr}"`,
    ...(lunarYearStr ? [`lunar_year: "${lunarYearStr}"`] : []),
    `total_tasks: ${totalTasks}`,
    `completed_tasks: ${completedTasks}`,
    `completion_rate: "${rateStr}"`,
    "---",
    "",
    `# 📅 ${year} 年 ${month + 1} 月 日历日程表${lunarYearStr ? `（${lunarYearStr}）` : ""}`,
  ];

  if (includeStats) {
    md.push(
      "",
      `> **📊 月度概览**：当月共 **${totalTasks}** 项安排 ｜ 已完成 **${completedTasks}** 项（**${rateStr}**） ｜ 待办 **${pendingTasks}** 项`,
    );
  }

  if (Array.isArray(countdowns) && countdowns.length > 0) {
    const cdParts = countdowns.slice(0, 4).map(c => `**${escapeMdCell(c.title)}** (${c.date})`);
    md.push(`> **⏳ 重要日期**：${cdParts.join(" ｜ ")}`);
  }

  md.push("", "## 一、月度日历网格 (Monthly Grid)", "");

  const wLabels = weekHeadLabels(weekStart).map(w => `周${w}`);
  md.push(`| ${wLabels.join(" | ")} |`);
  md.push(`| ${wLabels.map(() => ":---").join(" | ")} |`);

  for (let row = 0; row < rowCount; row++) {
    const rowCells = cells.slice(row * 7, row * 7 + 7);
    const cols = rowCells.map(c => {
      const cy = c.date.getFullYear();
      const cm = c.date.getMonth() + 1;
      const cd = c.day;
      const dayLabel = c.inMonth ? `**${cd}**` : `*${cm}/${cd}*`;

      let metaParts = [];
      if (includeLunar && typeof getLunarDay === "function") {
        const l = getLunarDay(cy, cm, cd);
        if (l?.holidayBadge) metaParts.push(`[${l.holidayBadge}]`);
        if (l?.text) metaParts.push(`\`${escapeMdCell(l.text)}\``);
      }

      const headStr = [dayLabel, ...metaParts].join(" ");
      const rawList = byDay.get(c.key) || [];
      const list = includeCompleted ? rawList : rawList.filter(ev => !ev.done);
      if (!list.length) return headStr;

      const taskLines = list.map(ev => {
        const icon = ev.done ? "✅" : "⬜";
        const timePrefix = ev.time ? `${ev.time} ` : "";
        return `${icon} ${timePrefix}${escapeMdCell(ev.title)}`;
      });
      return [headStr, ...taskLines].join("<br>");
    });
    md.push(`| ${cols.join(" | ")} |`);
  }

  if (includeAgendaDetail) {
    md.push("", "## 二、每日日程与待办明细 (Daily Agenda)", "");
    if (monthDaysWithTasks.length === 0) {
      md.push("_本月暂无安排记录。_");
    } else {
      for (const { cell, list } of monthDaysWithTasks) {
        const cy = cell.date.getFullYear();
        const cm = cell.date.getMonth() + 1;
        const cd = cell.day;
        const lunar = includeLunar && typeof getLunarDay === "function" ? getLunarDay(cy, cm, cd) : null;
        const lunarSuffix = lunar?.fullTitle ? ` · ${lunar.fullTitle}` : "";
        md.push(`### 📌 ${cell.key}（${WEEKDAY_CN[cell.dow]}${lunarSuffix}）`);
        for (const ev of list) {
          const chk = ev.done ? "x" : " ";
          const tStr = ev.time ? `\`${ev.time}\` ` : "";
          md.push(`- [${chk}] ${tStr}${String(ev.title ?? "").trim()}`);
        }
        md.push("");
      }
    }
  }

  return md.join("\n").trimEnd() + "\n";
}

/**
 * 生成面向横向/纵向打印与 PDF 导出的自包含全幅 HTML（默认 A4 横向 Landscape，占满打印区域，格内自动多行换行）
 */
export function buildPrintableCalendarHtml({
  year,
  month,
  weekStart = 1,
  byDay = new Map(),
  getLunarDay = null,
  getGanZhiYear = null,
  theme = null,
  options = {},
} = {}) {
  const orientation = options.orientation === "portrait" ? "portrait" : "landscape";
  const paperSize = ["A4", "Letter", "A3"].includes(options.paperSize) ? options.paperSize : "A4";
  const marginMm = Number.isFinite(+options.marginMm) && +options.marginMm >= 0 ? +options.marginMm : 6;
  const includeLunar = options.includeLunar !== false;
  const includeAlmanac = options.includeStats !== false && options.includeAlmanac !== false;
  const includeCompleted = options.includeCompleted !== false;

  const cells = trimRedundantMonthRows(getMonthMatrix(year, month, weekStart));
  const rowCount = Math.ceil(cells.length / 7);
  const lunarYearStr = typeof getGanZhiYear === "function" ? getGanZhiYear(year) : "";

  let totalTasks = 0;
  let completedTasks = 0;
  let maxCellTasks = 0;

  for (const c of cells) {
    const rawList = byDay.get(c.key) || [];
    const filtered = includeCompleted ? rawList : rawList.filter(ev => !ev.done);
    if (c.inMonth) {
      totalTasks += rawList.length;
      completedTasks += rawList.filter(ev => ev.done).length;
    }
    if (filtered.length > maxCellTasks) maxCellTasks = filtered.length;
  }

  // 根据单格最高任务密度自适应字号，确保单页满幅不溢出第二页
  const taskFontPt = maxCellTasks >= 6 ? 7.5 : (maxCellTasks >= 4 ? 8.2 : 9.0);

  const c = theme?.color || {};
  const bg = c.bg || "#FBF6EC";
  const surface = c.surface || "#FFFDF7";
  const fg = c.fg || "#172648";
  const fgMuted = c.fgMuted || "#536389";
  const fgWeekend = c.fgWeekend || "#A3314B";
  const fgHoliday = c.fgHoliday || "#A3314B";
  const fgOther = c.fgOtherMonth || "#8A94A8";
  const accent = c.accent || "#2649A0";
  const line = c.line || "#D5DCEB";
  const fontUi = theme?.type?.familyUi || '"Microsoft YaHei UI", "Segoe UI", "PingFang SC", system-ui, sans-serif';
  const fontNum = theme?.type?.familyNum || '"Segoe UI Variable Display", "Segoe UI", "Microsoft YaHei UI", sans-serif';

  const wLabels = weekHeadLabels(weekStart);
  const weekHeadHtml = wLabels.map((w, idx) => {
    const dow = (weekStart + idx) % 7;
    const isWknd = dow === 0 || dow === 6;
    return `<div class="kal-print-wh${isWknd ? " is-weekend" : ""}">星期${escapeHtml(w)}</div>`;
  }).join("");

  const cellsHtml = cells.map(cell => {
    const cy = cell.date.getFullYear();
    const cm = cell.date.getMonth() + 1;
    const cd = cell.day;
    const lunar = includeLunar && typeof getLunarDay === "function" ? getLunarDay(cy, cm, cd) : null;

    const classes = ["kal-print-cell"];
    if (!cell.inMonth) classes.push("is-other-month");
    if (cell.isWeekend) classes.push("is-weekend");
    if (cell.isToday) classes.push("is-today");
    if (lunar?.holidayType === "rest") classes.push("is-rest-day");
    if (lunar?.holidayType === "work") classes.push("is-work-makeup");

    let badgeHtml = "";
    if (lunar?.holidayBadge) {
      badgeHtml = `<span class="kal-print-badge is-${escapeHtml(lunar.holidayType)}">${escapeHtml(lunar.holidayBadge)}</span>`;
    }
    let subHtml = "";
    if (lunar?.text) {
      const subCls = lunar.festival ? " is-festival" : (lunar.isHighlight ? " is-term" : "");
      subHtml = `<span class="kal-print-sub${subCls}">${escapeHtml(lunar.text)}</span>`;
    }

    const rawList = byDay.get(cell.key) || [];
    const list = includeCompleted ? rawList : rawList.filter(ev => !ev.done);
    const tasksHtml = list.map((ev, idx) => {
      const doneCls = ev.done ? " is-done" : "";
      const timeHtml = ev.time ? `<span class="kal-print-time">${escapeHtml(ev.time)}</span> ` : "";
      return `<div class="kal-print-task${doneCls}" data-idx="${idx + 1}.">${timeHtml}${escapeHtml(ev.title)}</div>`;
    }).join("");

    return `<div class="${classes.join(" ")}" data-key="${escapeHtml(cell.key)}">
      <div class="kal-print-cell-head">
        <span class="kal-print-daynum">${cell.inMonth ? cd : `${cm}/${cd}`}</span>
        <span class="kal-print-head-right">${badgeHtml}${subHtml}</span>
      </div>
      <div class="kal-print-tasks">${tasksHtml}</div>
    </div>`;
  }).join("\n");

  const metaStats = includeAlmanac
    ? `<span>${escapeHtml(lunarYearStr || "")}</span><span>当月共 ${totalTasks} 项安排 · 已完成 ${completedTasks} 项</span>`
    : `<span>${year}-${pad(month + 1)}</span>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>Kal 日历导出 - ${year}年${month + 1}月</title>
<style>
  @page {
    size: ${paperSize} ${orientation};
    margin: ${marginMm}mm;
  }
  *, *::before, *::after {
    box-sizing: border-box;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
  html, body {
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    background: ${bg};
    color: ${fg};
    font-family: ${fontUi};
    overflow: hidden;
  }
  .kal-print-sheet {
    width: 100vw;
    height: 100vh;
    max-height: 100vh;
    display: flex;
    flex-direction: column;
    padding: 2.5mm 3mm;
    gap: 2mm;
    background: ${bg};
    page-break-inside: avoid;
    break-inside: avoid;
    page-break-after: avoid;
    break-after: avoid;
  }
  .kal-print-header {
    flex: 0 0 auto;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding-bottom: 1.5mm;
    border-bottom: 1.5px solid ${accent};
  }
  .kal-print-title-wrap {
    display: flex;
    align-items: baseline;
    gap: 3.5mm;
  }
  .kal-print-month {
    font-family: ${fontNum};
    font-size: 22pt;
    font-weight: 800;
    color: ${fg};
    letter-spacing: -0.02em;
    line-height: 1;
  }
  .kal-print-year {
    font-family: ${fontNum};
    font-size: 13pt;
    font-weight: 600;
    color: ${fgMuted};
  }
  .kal-print-meta {
    display: flex;
    align-items: center;
    gap: 4mm;
    font-size: 9pt;
    color: ${fgMuted};
  }
  .kal-print-weekhead {
    flex: 0 0 auto;
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    gap: 1.2mm;
  }
  .kal-print-wh {
    text-align: center;
    font-size: 9pt;
    font-weight: 700;
    color: ${fgMuted};
    padding: 0.8mm 0;
    letter-spacing: 0.08em;
  }
  .kal-print-wh.is-weekend {
    color: ${fgWeekend};
  }
  .kal-print-grid {
    flex: 1 1 auto;
    min-height: 0;
    width: 100%;
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    grid-template-rows: repeat(${rowCount}, minmax(0, 1fr));
    gap: 1.2mm;
  }
  .kal-print-cell {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 0.8mm;
    padding: 1.5mm 1.8mm;
    background: ${surface};
    border: 1px solid ${line};
    border-radius: 2mm;
    overflow: hidden;
    break-inside: avoid;
  }
  .kal-print-cell.is-other-month {
    opacity: 0.52;
    background: ${bg};
  }
  .kal-print-cell.is-today {
    border: 1.5px solid ${accent};
  }
  .kal-print-cell-head {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1mm;
    border-bottom: 0.5px solid ${line};
    padding-bottom: 0.6mm;
  }
  .kal-print-daynum {
    font-family: ${fontNum};
    font-size: 11pt;
    font-weight: 700;
    color: ${fg};
    line-height: 1.1;
  }
  .kal-print-cell.is-weekend .kal-print-daynum {
    color: ${fgWeekend};
  }
  .kal-print-cell.is-rest-day .kal-print-daynum {
    color: ${fgHoliday};
  }
  .kal-print-cell.is-other-month .kal-print-daynum {
    color: ${fgOther};
  }
  .kal-print-head-right {
    display: inline-flex;
    align-items: center;
    gap: 1mm;
    min-width: 0;
  }
  .kal-print-badge {
    font-size: 7pt;
    font-weight: 700;
    padding: 0.2mm 1mm;
    border-radius: 0.8mm;
    line-height: 1.1;
  }
  .kal-print-badge.is-rest {
    color: ${fgHoliday};
    border: 0.75px solid ${fgHoliday};
  }
  .kal-print-badge.is-work {
    color: ${fgMuted};
    border: 0.75px solid ${fgMuted};
  }
  .kal-print-sub {
    font-size: 8pt;
    color: ${fgMuted};
    white-space: nowrap;
  }
  .kal-print-sub.is-term {
    color: ${accent};
    font-weight: 700;
  }
  .kal-print-sub.is-festival {
    color: ${fgHoliday};
    font-weight: 700;
  }
  .kal-print-tasks {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 0.7mm;
    overflow: hidden;
  }
  .kal-print-task {
    font-size: ${taskFontPt}pt;
    line-height: 1.28;
    color: ${fg};
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: normal;
    padding-left: 2.6mm;
    text-indent: -2.6mm;
  }
  .kal-print-task::before {
    content: "";
    display: inline-block;
    width: 1.3mm;
    height: 1.3mm;
    margin-right: 1.3mm;
    border-radius: 50%;
    background: ${accent};
    vertical-align: middle;
    transform: translateY(-0.2mm);
  }
  .kal-print-task.is-done {
    color: ${fgMuted};
    text-decoration: line-through;
  }
  .kal-print-task.is-done::before {
    background: ${fgMuted};
  }
  .kal-print-time {
    font-family: ${fontNum};
    font-weight: 600;
    color: ${accent};
  }
</style>
</head>
<body>
  <div class="kal-print-sheet">
    <header class="kal-print-header">
      <div class="kal-print-title-wrap">
        <span class="kal-print-month">${month + 1} 月</span>
        <span class="kal-print-year">${year}</span>
      </div>
      <div class="kal-print-meta">${metaStats}</div>
    </header>
    <div class="kal-print-weekhead">${weekHeadHtml}</div>
    <div class="kal-print-grid">
${cellsHtml}
    </div>
  </div>
</body>
</html>`;
}


