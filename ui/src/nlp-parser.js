// 零依赖中文自然语言速记解析器 (Chrono-style) + 任务内联语义装饰 + RFC 5545 .ics 导入解析器

import { fromKey, toKey, pad, isValidDateKey } from "./calendar.js";

const CN_NUM = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12,
};

const WEEKDAY_MAP = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0,
};

export const CELL_HIGHLIGHT_PALETTE = [
  { id: "", label: "默认无底色", dot: "transparent" },
  { id: "emerald", label: "休假松石绿", dot: "#10b981" },
  { id: "rose", label: "重要樱花粉", dot: "#f43f5e" },
  { id: "amber", label: "截止暖阳金", dot: "#f59e0b" },
  { id: "sky", label: "差旅晴空蓝", dot: "#0ea5e9" },
  { id: "violet", label: "灵感星云紫", dot: "#8b5cf6" },
  { id: "coral", label: "庆典珊瑚橙", dot: "#f97316" },
  { id: "gold", label: "发薪香槟黄", dot: "#eab308" },
];

function parseCnInt(raw) {
  if (!raw) return NaN;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (s in CN_NUM) return CN_NUM[s];
  if (s.startsWith("十") && s.length === 2 && s[1] in CN_NUM) {
    return 10 + CN_NUM[s[1]];
  }
  if (s.endsWith("十") && s.length === 2 && s[0] in CN_NUM) {
    return CN_NUM[s[0]] * 10;
  }
  if (s.length === 3 && s[1] === "十" && s[0] in CN_NUM && s[2] in CN_NUM) {
    return CN_NUM[s[0]] * 10 + CN_NUM[s[2]];
  }
  return NaN;
}

export function addDaysToKey(dateKey, deltaDays) {
  const dt = fromKey(dateKey);
  const next = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + Number(deltaDays || 0));
  return toKey(next);
}

/**
 * 解析中文自然语言速记输入
 * 例如：
 * - "明天下午3点半 产品架构评审 #工作 !高"
 * - "下周三 09:30 提交季度报告 #汇报"
 * - "10月28日至10月30日 杭州技术峰会 #差旅"
 * - "3天后 14:00 复查牙医"
 *
 * @param {string} rawInput
 * @param {string} baseDateKey 当前选中的日期 (YYYY-MM-DD)
 * @returns {{
 *   date: string,
 *   endDate: string,
 *   dates: string[],
 *   time: string,
 *   title: string,
 *   cleanTitle: string,
 *   tags: string[],
 *   priority: string,
 *   hasNlpHint: boolean,
 *   dateLabel: string
 * }}
 */
export function parseNaturalEntry(rawInput, baseDateKey) {
  const fallbackDate = isValidDateKey(baseDateKey) ? baseDateKey : toKey(new Date());
  if (typeof rawInput !== "string") {
    return {
      date: fallbackDate,
      endDate: "",
      dates: [fallbackDate],
      time: "",
      title: "",
      cleanTitle: "",
      tags: [],
      priority: "",
      hasNlpHint: false,
      dateLabel: "",
    };
  }

  let working = rawInput.replace(/[\r\n]+/g, " ").trim();
  if (!working) {
    return {
      date: fallbackDate,
      endDate: "",
      dates: [fallbackDate],
      time: "",
      title: "",
      cleanTitle: "",
      tags: [],
      priority: "",
      hasNlpHint: false,
      dateLabel: "",
    };
  }

  const baseDt = fromKey(fallbackDate);
  let targetDate = fallbackDate;
  let endDate = "";
  let dateLabel = "";
  let time = "";
  let hasNlpHint = false;

  // 1. 提取跨日日期区间：如 "10月1日至10月5日" / "10月1日-10月3日" / "2026-10-01~2026-10-03"
  const rangeMdMatch = working.match(
    /^(?:(\d{4})[年/-])?(\d{1,2})[月/-](\d{1,2})[日号]?\s*(?:至|到|~|—|-|～)\s*(?:(\d{4})[年/-])?(\d{1,2})[月/-](\d{1,2})[日号]?\s*/
  );
  if (rangeMdMatch) {
    const y1 = rangeMdMatch[1] ? Number(rangeMdMatch[1]) : baseDt.getFullYear();
    const m1 = Number(rangeMdMatch[2]);
    const d1 = Number(rangeMdMatch[3]);
    const y2 = rangeMdMatch[4] ? Number(rangeMdMatch[4]) : y1;
    const m2 = Number(rangeMdMatch[5]);
    const d2 = Number(rangeMdMatch[6]);
    const k1 = `${y1}-${pad(m1)}-${pad(d1)}`;
    const k2 = `${y2}-${pad(m2)}-${pad(d2)}`;
    if (isValidDateKey(k1) && isValidDateKey(k2) && k2 >= k1) {
      targetDate = k1;
      endDate = k2 > k1 ? k2 : "";
      dateLabel = endDate ? `${k1} ~ ${k2}` : k1;
      working = working.slice(rangeMdMatch[0].length).trim();
      hasNlpHint = true;
    }
  }

  // 2. 提取单日相对/绝对日期前缀（若尚未命中区间）
  if (!dateLabel) {
    const relMap = [
      { re: /^(今天|今日)\s*/, offset: 0, label: "今天" },
      { re: /^(明天|明日)\s*/, offset: 1, label: "明天" },
      { re: /^(后天)\s*/, offset: 2, label: "后天" },
      { re: /^(大后天)\s*/, offset: 3, label: "大后天" },
      { re: /^(昨天|昨日)\s*/, offset: -1, label: "昨天" },
    ];
    for (const item of relMap) {
      const m = working.match(item.re);
      if (m) {
        targetDate = addDaysToKey(fallbackDate, item.offset);
        dateLabel = `${targetDate} (${item.label})`;
        working = working.slice(m[0].length).trim();
        hasNlpHint = true;
        break;
      }
    }
  }

  // "N天后" / "N日后"
  if (!dateLabel) {
    const afterMatch = working.match(/^(\d{1,2}|[一二两三四五六七八九十]+)\s*(?:天|日)后\s*/);
    if (afterMatch) {
      const n = parseCnInt(afterMatch[1]);
      if (Number.isFinite(n) && n >= 0 && n <= 365) {
        targetDate = addDaysToKey(fallbackDate, n);
        dateLabel = `${targetDate} (${n}天后)`;
        working = working.slice(afterMatch[0].length).trim();
        hasNlpHint = true;
      }
    }
  }

  // "本周X" / "下周X" / "周X" / "星期X"
  if (!dateLabel) {
    const wkMatch = working.match(/^(本周|这周|下周|周|星期|礼拜)([一二三四五六日天])\s*/);
    if (wkMatch) {
      const prefix = wkMatch[1];
      const targetDow = WEEKDAY_MAP[wkMatch[2]];
      const curDow = baseDt.getDay();
      const curIso = curDow === 0 ? 7 : curDow;
      const targetIso = targetDow === 0 ? 7 : targetDow;
      let diff = targetIso - curIso;
      if (prefix === "下周") {
        diff += 7;
      } else if (diff < 0 && (prefix === "周" || prefix === "星期" || prefix === "礼拜")) {
        diff += 7;
      }
      targetDate = addDaysToKey(fallbackDate, diff);
      dateLabel = `${targetDate} (${prefix}${wkMatch[2]})`;
      working = working.slice(wkMatch[0].length).trim();
      hasNlpHint = true;
    }
  }

  // "YYYY-MM-DD" 或 "MM月DD日" / "M月D号"
  if (!dateLabel) {
    const absMatch = working.match(/^(?:(\d{4})[年/-])?(\d{1,2})[月/-](\d{1,2})(?:[日号])?\s+/);
    if (absMatch) {
      const y = absMatch[1] ? Number(absMatch[1]) : baseDt.getFullYear();
      const m = Number(absMatch[2]);
      const d = Number(absMatch[3]);
      const candidate = `${y}-${pad(m)}-${pad(d)}`;
      if (isValidDateKey(candidate)) {
        targetDate = candidate;
        dateLabel = candidate;
        working = working.slice(absMatch[0].length).trim();
        hasNlpHint = true;
      }
    }
  }

  // 2.5 检查“连续N天”后缀或前缀（如 "连续3天"）
  const spanDaysMatch = working.match(/^(?:连续|持续)(\d{1,2}|[两二三四五六七])天\s*/);
  if (spanDaysMatch && !endDate) {
    const span = parseCnInt(spanDaysMatch[1]);
    if (Number.isFinite(span) && span >= 2 && span <= 15) {
      endDate = addDaysToKey(targetDate, span - 1);
      dateLabel = `${targetDate} ~ ${endDate} (${span}天)`;
      working = working.slice(spanDaysMatch[0].length).trim();
      hasNlpHint = true;
    }
  }

  // 3. 提取时间表达式：
  // 3a) 标准 24h 时间前缀 "09:30 " / "9:30 " / "9：30 "
  const stdTimeMatch = working.match(/^(\d{1,2})[:：](\d{2})(?:\s+|$)/);
  if (stdTimeMatch) {
    const hh = Number(stdTimeMatch[1]);
    const mm = Number(stdTimeMatch[2]);
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
      time = `${pad(hh)}:${pad(mm)}`;
      working = working.slice(stdTimeMatch[0].length).trim();
      hasNlpHint = true;
    }
  }

  // 3b) 中文自然时间前缀："上午9点半" / "下午3点" / "晚上8点15分" / "中午12点" / "14点20"
  if (!time) {
    const cnTimeMatch = working.match(
      /^(?:(凌晨|早上|早晨|上午|中午|午间|下午|傍晚|晚上|夜间|夜里))?\s*(\d{1,2}|[一二两三四五六七八九十]+)\s*[点时](?:(半)|(\d{1,2}|[一二三四五六七八九十]+)\s*分?)?\s*/
    );
    if (cnTimeMatch) {
      const period = cnTimeMatch[1] || "";
      let hh = parseCnInt(cnTimeMatch[2]);
      let mm = 0;
      if (cnTimeMatch[3] === "半") {
        mm = 30;
      } else if (cnTimeMatch[4]) {
        mm = parseCnInt(cnTimeMatch[4]);
      }
      if (Number.isFinite(hh) && Number.isFinite(mm) && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
        if ((period === "下午" || period === "傍晚" || period === "晚上" || period === "夜间" || period === "夜里") && hh < 12) {
          hh += 12;
        } else if (period === "中午" && hh < 11) {
          hh += 12;
        } else if (period === "凌晨" && hh === 12) {
          hh = 0;
        }
        time = `${pad(hh)}:${pad(mm)}`;
        working = working.slice(cnTimeMatch[0].length).trim();
        hasNlpHint = true;
      }
    }
  }

  // 4. 提取优先级 (!高 / !中 / !低 / !1 / !2 / !3) 与 #标签
  let priority = "";
  const prioMatch = working.match(/(?:^|\s)[!！](高|中|低|紧急|重要|1|2|3)(?=\s|$)/);
  if (prioMatch) {
    const token = prioMatch[1];
    if (token === "高" || token === "紧急" || token === "重要" || token === "1") priority = "high";
    else if (token === "中" || token === "2") priority = "medium";
    else if (token === "低" || token === "3") priority = "low";
    working = (working.slice(0, prioMatch.index) + " " + working.slice(prioMatch.index + prioMatch[0].length)).trim();
    hasNlpHint = true;
  }

  const tags = [];
  const tagRegex = /#([^\s#.,;!?，。；！？]{1,16})/g;
  let tm;
  while ((tm = tagRegex.exec(working)) !== null) {
    if (!tags.includes(tm[1])) tags.push(tm[1]);
    hasNlpHint = true;
  }

  const cleanTitle = working.replace(/\s+/g, " ").trim();
  let formattedTitle = cleanTitle;
  if (priority === "high" && !formattedTitle.includes("[!高]")) {
    formattedTitle = `[!高] ${formattedTitle}`;
  } else if (priority === "medium" && !formattedTitle.includes("[!中]")) {
    formattedTitle = `[!中] ${formattedTitle}`;
  } else if (priority === "low" && !formattedTitle.includes("[!低]")) {
    formattedTitle = `[!低] ${formattedTitle}`;
  }
  if (endDate && !formattedTitle.includes(`[~${endDate}]`)) {
    formattedTitle = `[~${endDate}] ${formattedTitle}`;
  }

  // 计算跨日日期数组（最多展开 15 天）
  const dates = [targetDate];
  if (endDate && endDate > targetDate) {
    let cursor = targetDate;
    for (let step = 1; step < 15; step++) {
      cursor = addDaysToKey(cursor, 1);
      dates.push(cursor);
      if (cursor >= endDate) break;
    }
  }

  return {
    date: targetDate,
    endDate,
    dates,
    time,
    title: formattedTitle.trim(),
    cleanTitle,
    tags,
    priority,
    hasNlpHint,
    dateLabel,
  };
}

/**
 * 解析任务标题中的内联元数据（跨日标记 [~YYYY-MM-DD]、优先级 [!高]、#标签）
 */
export function parseTaskDecorations(rawTitle) {
  let text = String(rawTitle ?? "").trim();
  let spanEndDate = "";
  let priority = "";
  const tags = [];

  const spanMatch = text.match(/^\[~(\d{4}-\d{2}-\d{2})\]\s*/);
  if (spanMatch) {
    spanEndDate = spanMatch[1];
    text = text.slice(spanMatch[0].length).trim();
  }

  const prioMatch = text.match(/^\[!(高|中|低)\]\s*/);
  if (prioMatch) {
    priority = prioMatch[1] === "高" ? "high" : (prioMatch[1] === "中" ? "medium" : "low");
    text = text.slice(prioMatch[0].length).trim();
  }

  const displayText = text.replace(/#([^\s#.,;!?，。；！？]{1,16})/g, (_, tag) => {
    if (!tags.includes(tag)) tags.push(tag);
    return "";
  }).replace(/\s+/g, " ").trim();

  return {
    cleanTitle: displayText || text,
    rawTitle: String(rawTitle ?? "").trim(),
    spanEndDate,
    priority,
    tags,
    isMultiDay: Boolean(spanEndDate),
  };
}

/**
 * 解析 RFC 5545 标准 iCalendar (.ics) 文本为日程项数组
 */
export function parseIcsCalendar(icsText) {
  return parseIcsCalendarDetailed(icsText).items;
}

// Only import events representable by the current date/time/title data model.
export function parseIcsCalendarDetailed(icsText) {
  const result = { items: [], skipped: [], warnings: [], errors: [] };
  if (typeof icsText !== "string" || !icsText.trim()) {
    result.errors.push("文件为空");
    return result;
  }
  const lines = icsText.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const events = [];
  const stack = [];
  let event = null;
  let calendars = 0;
  for (const line of lines) {
    if (!line) continue;
    const boundary = /^(BEGIN|END):([A-Z0-9-]+)$/i.exec(line);
    if (boundary) {
      const action = boundary[1].toUpperCase(), component = boundary[2].toUpperCase();
      if (action === "BEGIN") {
        if (component === "VCALENDAR") { calendars++; if (stack.length) result.errors.push("VCALENDAR 嵌套无效"); }
        else if (!stack.length) result.errors.push("组件位于 VCALENDAR 之外");
        if (component === "VEVENT") {
          if (event || stack[stack.length - 1] !== "VCALENDAR") result.errors.push("VEVENT 结构无效");
          event = { properties: {}, reasons: [] };
          events.push(event);
        } else if (event) event.reasons.push(`不支持子组件 ${component}`);
        else if (component === "VTODO" || component === "VJOURNAL" || component === "VFREEBUSY") {
          result.skipped.push({ index: null, title: "", reason: `不支持 ${component}` });
        }
        stack.push(component);
      } else {
        if (stack.pop() !== component) result.errors.push("组件结束标记不匹配");
        if (component === "VEVENT") event = null;
      }
      continue;
    }
    if (!event && stack[stack.length - 1] === "VCALENDAR" && /^METHOD:/i.test(line) && !/^METHOD:PUBLISH$/i.test(line)) {
      result.errors.push("不支持此日历调度方法");
    }
    if (!event || stack[stack.length - 1] !== "VEVENT") continue;
    const match = /^([^:]+):(.*)$/.exec(line);
    if (!match) { event.reasons.push("属性格式无效"); continue; }
    const [name, ...params] = match[1].split(";");
    const key = name.toUpperCase();
    (event.properties[key] ||= []).push({ params: params.map(p => p.toUpperCase()), value: match[2] });
  }
  if (stack.length || calendars !== 1) result.errors.push("VCALENDAR 结构不完整或无效");
  if (result.errors.length) return result;

  const uidCounts = new Map();
  for (const ev of events) {
    const uid = ev.properties.UID?.[0]?.value;
    if (uid) uidCounts.set(uid, (uidCounts.get(uid) || 0) + 1);
  }
  events.forEach((ev, index) => {
    const p = ev.properties;
    const title = unescapeIcsText(p.SUMMARY?.[0]?.value);
    for (const key of ["DTSTART", "DTEND", "SUMMARY", "UID"]) {
      if (p[key]?.length > 1) ev.reasons.push(`${key} 重复`);
    }
    for (const key of ["RRULE", "RDATE", "EXRULE", "EXDATE", "RECURRENCE-ID", "DURATION"]) {
      if (p[key]) ev.reasons.push(`不支持 ${key}`);
    }
    if (p.STATUS?.some(v => v.value.toUpperCase() === "CANCELLED")) ev.reasons.push("已取消的事件");
    if (p.UID?.[0]?.value && uidCounts.get(p.UID[0].value) > 1) ev.reasons.push("文件中 UID 重复");
    if (!title) ev.reasons.push("缺少标题");
    const start = parseIcsDate(p.DTSTART?.[0]);
    if (!start) ev.reasons.push("开始日期无效或使用不支持的时区、精度或参数");
    if (p.DTEND) {
      const end = parseIcsDate(p.DTEND[0]);
      if (!end || !start || start.time || end.time || end.date !== addDaysToKey(start.date, 1)) {
        ev.reasons.push("不支持此结束时间或跨日事件");
      }
    }
    if (ev.reasons.length) {
      result.skipped.push({ index: index + 1, title, reason: [...new Set(ev.reasons)].join("；") });
      return;
    }
    if (!p.UID?.[0]?.value) result.warnings.push(`第 ${index + 1} 项没有 UID，将使用内容进行去重`);
    const ignored = Object.keys(p).filter(key => !["DTSTART", "DTEND", "SUMMARY", "UID", "DTSTAMP", "CREATED", "LAST-MODIFIED", "SEQUENCE"].includes(key));
    if (ignored.length) result.warnings.push(`第 ${index + 1} 项的属性不会导入：${ignored.join("、")}`);
    const item = { date: start.date, time: start.time, title, kind: "event" };
    if (p.UID?.[0]?.value) item.uid = p.UID[0].value;
    result.items.push(item);
  });
  return result;
}

function parseIcsDate(prop) {
  if (!prop) return null;
  const value = prop.value;
  const dateOnly = /^\d{8}$/.test(value);
  if (prop.params.some(p => p !== (dateOnly ? "VALUE=DATE" : "VALUE=DATE-TIME"))) return null;
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})00)?$/.exec(value);
  if (!match || (!dateOnly && !match[4])) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  if (!isValidDateKey(date) || (match[4] && (Number(match[4]) > 23 || Number(match[5]) > 59))) return null;
  return { date, time: match[4] ? `${match[4]}:${match[5]}` : "" };
}

function unescapeIcsText(s) {
  return String(s || "")
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .replace(/[\r\n]+/g, " ")
    .trim();
}
