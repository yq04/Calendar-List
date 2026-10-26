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
  if (typeof icsText !== "string" || !icsText.trim()) return [];
  // RFC 5545 折行展开 (CRLF/LF + Space/Tab)
  const unfolded = icsText.replace(/\r?\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n/);
  const items = [];
  let inEvent = false;
  let cur = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.toUpperCase() === "BEGIN:VEVENT") {
      inEvent = true;
      cur = { dtstart: "", dtend: "", summary: "", categories: "" };
      continue;
    }
    if (line.toUpperCase() === "END:VEVENT") {
      if (inEvent && cur && cur.dtstart && cur.summary) {
        const parsed = normalizeIcsEvent(cur);
        if (parsed) items.push(parsed);
      }
      inEvent = false;
      cur = null;
      continue;
    }
    if (!inEvent || !cur) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) continue;
    const propPart = line.slice(0, colonIdx).toUpperCase();
    const valPart = line.slice(colonIdx + 1).trim();
    const propName = propPart.split(";")[0];

    if (propName === "DTSTART") cur.dtstart = valPart;
    else if (propName === "DTEND") cur.dtend = valPart;
    else if (propName === "SUMMARY") cur.summary = unescapeIcsText(valPart);
    else if (propName === "CATEGORIES") cur.categories = unescapeIcsText(valPart);
  }
  return items;
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

function normalizeIcsEvent(ev) {
  const digits = ev.dtstart.replace(/\D/g, "");
  if (digits.length < 8) return null;
  const date = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  if (!isValidDateKey(date)) return null;

  let time = "";
  if (ev.dtstart.includes("T") && digits.length >= 12) {
    const hh = Number(digits.slice(8, 10));
    const mm = Number(digits.slice(10, 12));
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
      time = `${pad(hh)}:${pad(mm)}`;
    }
  }

  let title = ev.summary;
  if (ev.categories) {
    const firstCat = ev.categories.split(",")[0].trim();
    if (firstCat && !title.includes(`#${firstCat}`)) {
      title = `${title} #${firstCat}`;
    }
  }
  return { date, time, title };
}
