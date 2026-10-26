// ui/src/lunar.js — 离线农历、二十四节气、法定调休（休/班）、黄历宜忌与周次引擎

const LUNAR_MONTH_MAP = {
  "正月": 1, "二月": 2, "三月": 3, "四月": 4, "五月": 5, "六月": 6,
  "七月": 7, "八月": 8, "九月": 9, "十月": 10, "冬月": 11, "十一月": 11, "腊月": 12, "十二月": 12
};

const LUNAR_DAYS = [
  "", "初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十",
  "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十",
  "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十"
];

const SOLAR_FESTIVALS = {
  "01-01": "元旦", "02-14": "情人节", "03-08": "妇女节", "05-01": "劳动节",
  "05-04": "青年节", "06-01": "儿童节", "07-01": "建党节", "08-01": "建军节",
  "09-10": "教师节", "10-01": "国庆节", "12-25": "圣诞节"
};

const LUNAR_FESTIVALS = {
  "1-1": "春节", "1-15": "元宵节", "2-2": "龙抬头", "5-5": "端午节",
  "7-7": "七夕节", "7-15": "中元节", "8-15": "中秋节", "9-9": "重阳节",
  "12-8": "腊八节", "12-23": "小年"
};

/**
 * 中国法定节假日「休」与调休补班「班」离线表（支持 2025–2028）
 * 值格式："rest:节日名" 或 "work:补班说明"
 */
const HOLIDAY_SCHEDULE = {
  // 2025 法定节假日与调休
  "2025-01-01": "rest:元旦",
  "2025-01-26": "work:春节补班",
  "2025-01-28": "rest:除夕", "2025-01-29": "rest:春节", "2025-01-30": "rest:春节", "2025-01-31": "rest:春节",
  "2025-02-01": "rest:春节", "2025-02-02": "rest:春节", "2025-02-03": "rest:春节", "2025-02-04": "rest:春节",
  "2025-02-08": "work:春节补班",
  "2025-04-04": "rest:清明节", "2025-04-05": "rest:清明节", "2025-04-06": "rest:清明节",
  "2025-04-27": "work:劳动节补班",
  "2025-05-01": "rest:劳动节", "2025-05-02": "rest:劳动节", "2025-05-03": "rest:劳动节", "2025-05-04": "rest:劳动节", "2025-05-05": "rest:劳动节",
  "2025-05-31": "rest:端午节", "2025-06-01": "rest:端午节", "2025-06-02": "rest:端午节",
  "2025-09-28": "work:国庆补班",
  "2025-10-01": "rest:国庆节", "2025-10-02": "rest:国庆节", "2025-10-03": "rest:国庆节", "2025-10-04": "rest:国庆节",
  "2025-10-05": "rest:国庆节", "2025-10-06": "rest:中秋节", "2025-10-07": "rest:国庆节", "2025-10-08": "rest:国庆节",
  "2025-10-11": "work:国庆补班",

  // 2026 法定节假日与调休
  "2026-01-01": "rest:元旦", "2026-01-02": "rest:元旦", "2026-01-03": "rest:元旦",
  "2026-01-04": "work:元旦补班",
  "2026-02-14": "work:春节补班",
  "2026-02-15": "rest:春节", "2026-02-16": "rest:除夕", "2026-02-17": "rest:春节", "2026-02-18": "rest:春节",
  "2026-02-19": "rest:春节", "2026-02-20": "rest:春节", "2026-02-21": "rest:春节", "2026-02-22": "rest:春节", "2026-02-23": "rest:春节",
  "2026-02-28": "work:春节补班",
  "2026-04-04": "rest:清明节", "2026-04-05": "rest:清明节", "2026-04-06": "rest:清明节",
  "2026-04-26": "work:劳动节补班",
  "2026-05-01": "rest:劳动节", "2026-05-02": "rest:劳动节", "2026-05-03": "rest:劳动节", "2026-05-04": "rest:劳动节", "2026-05-05": "rest:劳动节",
  "2026-05-09": "work:劳动节补班",
  "2026-06-19": "rest:端午节", "2026-06-20": "rest:端午节", "2026-06-21": "rest:端午节",
  "2026-09-20": "work:中秋补班",
  "2026-09-25": "rest:中秋节", "2026-09-26": "rest:中秋节", "2026-09-27": "rest:中秋节",
  "2026-10-01": "rest:国庆节", "2026-10-02": "rest:国庆节", "2026-10-03": "rest:国庆节", "2026-10-04": "rest:国庆节",
  "2026-10-05": "rest:国庆节", "2026-10-06": "rest:国庆节", "2026-10-07": "rest:国庆节",
  "2026-10-10": "work:国庆补班",

  // 2027 法定节假日与调休
  "2027-01-01": "rest:元旦", "2027-01-02": "rest:元旦", "2027-01-03": "rest:元旦",
  "2027-01-31": "work:春节补班",
  "2027-02-05": "rest:除夕", "2027-02-06": "rest:春节", "2027-02-07": "rest:春节", "2027-02-08": "rest:春节",
  "2027-02-09": "rest:春节", "2027-02-10": "rest:春节", "2027-02-11": "rest:春节", "2027-02-12": "rest:春节",
  "2027-02-13": "work:春节补班",
  "2027-04-03": "rest:清明节", "2027-04-04": "rest:清明节", "2027-04-05": "rest:清明节",
  "2027-04-25": "work:劳动节补班",
  "2027-05-01": "rest:劳动节", "2027-05-02": "rest:劳动节", "2027-05-03": "rest:劳动节", "2027-05-04": "rest:劳动节", "2027-05-05": "rest:劳动节",
  "2027-05-08": "work:劳动节补班",
  "2027-06-08": "rest:端午节", "2027-06-09": "rest:端午节", "2027-06-10": "rest:端午节",
  "2027-09-15": "rest:中秋节", "2027-09-16": "rest:中秋节", "2027-09-17": "rest:中秋节",
  "2027-09-18": "work:中秋补班",
  "2027-09-26": "work:国庆补班",
  "2027-10-01": "rest:国庆节", "2027-10-02": "rest:国庆节", "2027-10-03": "rest:国庆节", "2027-10-04": "rest:国庆节",
  "2027-10-05": "rest:国庆节", "2027-10-06": "rest:国庆节", "2027-10-07": "rest:国庆节",
  "2027-10-09": "work:国庆补班",

  // 2028 法定节假日与调休预排（支持后续通过 holiday-cn JSON 动态覆盖）
  "2028-01-01": "rest:元旦", "2028-01-02": "rest:元旦", "2028-01-03": "rest:元旦",
  "2028-01-22": "work:春节补班", "2028-01-23": "work:春节补班",
  "2028-01-25": "rest:除夕", "2028-01-26": "rest:春节", "2028-01-27": "rest:春节", "2028-01-28": "rest:春节",
  "2028-01-29": "rest:春节", "2028-01-30": "rest:春节", "2028-01-31": "rest:春节", "2028-02-01": "rest:春节",
  "2028-02-05": "work:春节补班",
  "2028-04-02": "rest:清明节", "2028-04-03": "rest:清明节", "2028-04-04": "rest:清明节",
  "2028-04-29": "rest:劳动节", "2028-04-30": "rest:劳动节", "2028-05-01": "rest:劳动节", "2028-05-02": "rest:劳动节", "2028-05-03": "rest:劳动节",
  "2028-05-06": "work:劳动节补班", "2028-05-07": "work:劳动节补班",
  "2028-05-27": "rest:端午节", "2028-05-28": "rest:端午节", "2028-05-29": "rest:端午节",
  "2028-09-30": "work:国庆补班",
  "2028-10-01": "rest:国庆节", "2028-10-02": "rest:国庆节", "2028-10-03": "rest:中秋节", "2028-10-04": "rest:国庆节",
  "2028-10-05": "rest:国庆节", "2028-10-06": "rest:国庆节", "2028-10-07": "rest:国庆节", "2028-10-08": "rest:国庆节",
  "2028-10-14": "work:国庆补班",
};

/** 运行时用户自定义节假日覆盖表（兼容 NateScarlet/holiday-cn 与键值映射） */
let customHolidaySchedule = {};

/**
 * 解析节假日配置：
 * 1) 兼容 GitHub `NateScarlet/holiday-cn` 格式：`{ year, days: [{ name, date, isOffDay }] }`
 * 2) 兼容 `days` 数组：`[{ name, date, isOffDay }]`
 * 3) 兼容 Kal 键值格式：`{ "2026-01-01": "rest:元旦", "2026-01-04": "work:元旦补班" }`
 */
export function parseHolidayConfig(input) {
  if (!input) return {};
  let data = input;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return {};
    data = JSON.parse(trimmed);
  }
  const normalized = {};
  const ingestDayObj = (item) => {
    if (!item || typeof item !== "object") return;
    const date = String(item.date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const rawName = String(item.name || "").trim();
    if (typeof item.isOffDay === "boolean") {
      if (item.isOffDay) {
        normalized[date] = `rest:${rawName || "法定假日"}`;
      } else {
        const workName = rawName ? (rawName.endsWith("补班") ? rawName : `${rawName}补班`) : "调休补班";
        normalized[date] = `work:${workName}`;
      }
    } else if (item.type === "rest" || item.type === "work") {
      normalized[date] = `${item.type}:${rawName || (item.type === "rest" ? "法定假日" : "调休补班")}`;
    }
  };

  if (Array.isArray(data)) {
    for (const entry of data) {
      if (entry && Array.isArray(entry.days)) {
        entry.days.forEach(ingestDayObj);
      } else {
        ingestDayObj(entry);
      }
    }
    return normalized;
  }

  if (typeof data === "object") {
    if (Array.isArray(data.days)) {
      data.days.forEach(ingestDayObj);
      return normalized;
    }
    for (const [key, val] of Object.entries(data)) {
      const date = String(key).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (typeof val === "string") {
        const v = val.trim();
        if (v.startsWith("rest:") || v.startsWith("work:")) {
          normalized[date] = v;
        } else if (v === "rest" || v === "休") {
          normalized[date] = "rest:法定假日";
        } else if (v === "work" || v === "班") {
          normalized[date] = "work:调休补班";
        } else if (v) {
          normalized[date] = `rest:${v}`;
        }
      } else if (typeof val === "boolean") {
        normalized[date] = val ? "rest:法定假日" : "work:调休补班";
      } else if (val && typeof val === "object") {
        ingestDayObj({ ...val, date });
      }
    }
  }
  return normalized;
}

/** 设置运行时自定义法定节假日覆盖表并自动刷新农历缓存 */
export function setCustomHolidays(input) {
  const parsed = parseHolidayConfig(input);
  customHolidaySchedule = parsed;
  cache.clear();
  return {
    count: Object.keys(customHolidaySchedule).length,
    entries: { ...customHolidaySchedule },
  };
}

/** 获取当前生效的自定义法定节假日覆盖表 */
export function getCustomHolidays() {
  return { ...customHolidaySchedule };
}

export function getHolidayBadge(year, month, day) {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  const key = `${year}-${mm}-${dd}`;
  const raw = Object.prototype.hasOwnProperty.call(customHolidaySchedule, key)
    ? customHolidaySchedule[key]
    : HOLIDAY_SCHEDULE[key];
  if (!raw) return null;
  const [type, name] = raw.split(":");
  return {
    type,
    label: type === "rest" ? "休" : "班",
    name: name || (type === "rest" ? "法定假日" : "调休补班"),
  };
}

const TERM_INFO = [
  0, 21208, 42467, 63836, 85337, 107014, 128867, 150921, 173149, 195551, 218072, 240693,
  263343, 285989, 308563, 331033, 353350, 375494, 397447, 419210, 440795, 462224, 483532, 504758
];
const SOLAR_NAMES = [
  "小寒", "大寒", "立春", "雨水", "惊蛰", "春分",
  "清明", "谷雨", "立夏", "小满", "芒种", "夏至",
  "小暑", "大暑", "立秋", "处暑", "白露", "秋分",
  "寒露", "霜降", "立冬", "小雪", "大雪", "冬至"
];

function getTermDay(year, n) {
  const ms = 31556925974.7 * (year - 1900) + TERM_INFO[n] * 60000;
  const off = new Date(Date.UTC(1900, 0, 6, 2, 5)).getTime() + ms;
  return new Date(off).getUTCDate();
}

export function getSolarTerm(year, month, day) {
  const n1 = (month - 1) * 2;
  const n2 = n1 + 1;
  if (day === getTermDay(year, n1)) return SOLAR_NAMES[n1];
  if (day === getTermDay(year, n2)) return SOLAR_NAMES[n2];
  return "";
}

const intlFmt = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric'
});

const cache = new Map();

export function getLunarDay(year, month, day) {
  const cacheKey = `${year}-${month}-${day}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const date = new Date(year, month - 1, day);
  const parts = intlFmt.formatToParts(date);
  const rawMonth = parts.find(p => p.type === 'month')?.value || '正月';
  const isLeapMonth = rawMonth.startsWith('闰');
  const cleanMonth = isLeapMonth ? rawMonth.slice(1) : rawMonth;
  const lMonthNum = LUNAR_MONTH_MAP[cleanMonth] || 1;
  const lDayNum = parseInt(parts.find(p => p.type === 'day')?.value || '1', 10);

  // Check 除夕 (next day is 1-1)
  const nextDate = new Date(year, month - 1, day + 1);
  const nextParts = intlFmt.formatToParts(nextDate);
  const nextRawMonth = nextParts.find(p => p.type === 'month')?.value || '';
  const nextCleanMonth = nextRawMonth.startsWith('闰') ? nextRawMonth.slice(1) : nextRawMonth;
  const isEve = (LUNAR_MONTH_MAP[nextCleanMonth] === 1 && nextParts.find(p => p.type === 'day')?.value === '1');

  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  const solarKey = `${mm}-${dd}`;
  const lunarKey = !isLeapMonth ? `${lMonthNum}-${lDayNum}` : '';

  const term = getSolarTerm(year, month, day);
  let fest = SOLAR_FESTIVALS[solarKey] || LUNAR_FESTIVALS[lunarKey] || "";
  if (isEve) fest = "除夕";
  if (term === "清明") fest = "清明节";

  const lDayStr = LUNAR_DAYS[lDayNum] || `${lDayNum}`;
  const isFirstDay = (lDayNum === 1);
  const displayMonth = rawMonth;

  let text = fest || term || (isFirstDay ? displayMonth : lDayStr);
  const isHighlight = Boolean(fest || term);
  const holiday = getHolidayBadge(year, month, day);

  const res = {
    text,
    isHighlight,
    solarTerm: term,
    festival: fest,
    lunarMonth: displayMonth,
    lunarDay: lDayStr,
    holidayBadge: holiday ? holiday.label : "",
    holidayType: holiday ? holiday.type : "",
    holidayName: holiday ? holiday.name : "",
    fullTitle: `农历${displayMonth}${lDayStr}${fest ? ' · ' + fest : ''}${term ? ' · ' + term : ''}${holiday ? ' · ' + holiday.name + '(' + holiday.label + ')' : ''}`
  };
  cache.set(cacheKey, res);
  return res;
}

const STEMS = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"];
const BRANCHES = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"];
const ZODIACS = ["鼠", "牛", "虎", "兔", "龙", "蛇", "马", "羊", "猴", "鸡", "狗", "猪"];

/** 返回干支纪年与生肖，如 2026 -> "丙午马年" */
export function getGanZhiYear(year) {
  const offset = ((Number(year) - 4) % 60 + 60) % 60;
  const stem = STEMS[offset % 10];
  const branch = BRANCHES[offset % 12];
  const zodiac = ZODIACS[offset % 12];
  return `${stem}${branch}${zodiac}年`;
}

/**
 * 传统十二建除（建、除、满、平、定、执、破、危、成、收、开、闭）宜忌表
 */
const JIANCHU_NAMES = ["建", "除", "满", "平", "定", "执", "破", "危", "成", "收", "开", "闭"];
const JIANCHU_YIJI = [
  { yi: ["出行", "上任", "会亲友", "签约", "祈福"], ji: ["动土", "开仓", "安葬"] }, // 建
  { yi: ["大扫除", "沐浴", "祈福", "求医", "安葬"], ji: ["结婚", "远行", "赴任"] }, // 除
  { yi: ["祈福", "开业", "签约", "祭祀", "纳财"], ji: ["动土", "求医", "栽种"] }, // 满
  { yi: ["修造", "打扫", "铺路", "祭祀", "安床"], ji: ["祈福", "开业", "远行"] }, // 平
  { yi: ["结婚", "订盟", "签约", "安床", "会亲友"], ji: ["诉讼", "出行", "动土"] }, // 定
  { yi: ["修造", "祭祀", "捕捉", "立契", "纳采"], ji: ["开业", "搬家", "远行"] }, // 执
  { yi: ["求医", "破屋", "拆卸", "整容"], ji: ["结婚", "签约", "开业", "搬家"] }, // 破
  { yi: ["祭祀", "祈福", "安床", "纳畜", "拆卸"], ji: ["登高", "行船", "动土"] }, // 危
  { yi: ["开业", "结婚", "签约", "入学", "搬家"], ji: ["诉讼", "争执"] },         // 成
  { yi: ["纳财", "交易", "进人口", "祭祀", "修造"], ji: ["安葬", "出行", "针灸"] }, // 收
  { yi: ["开业", "出行", "搬家", "结婚", "会亲友"], ji: ["安葬", "伐木"] },       // 开
  { yi: ["筑堤", "补垣", "塞穴", "收敛", "祭祀"], ji: ["开业", "出行", "求医", "动土"] } // 闭
];

/**
 * 六十甲子纳音表（按干支 0..59 每两位一组，共 30 纳音）
 */
const NAYIN_TABLE = [
  "海中金", "炉中火", "大林木", "路旁土", "剑锋金",
  "山头火", "涧下水", "城头土", "白蜡金", "杨柳木",
  "泉中水", "屋上土", "霹雳火", "松柏木", "长流水",
  "沙中金", "山下火", "平地木", "壁上土", "金箔金",
  "覆灯火", "天河水", "大驿土", "钗钏金", "桑柘木",
  "大溪水", "沙中土", "天上火", "石榴木", "大海水"
];

/** 三合煞方（申子辰煞南、巳酉丑煞东、寅午戌煞北、亥卯未煞西） */
const SHA_DIRS = ["南", "东", "北", "西"];

/** 吉神方位表（按日干 甲0..癸9） */
const XI_DIRS = ["东北", "西北", "西南", "正南", "东南"]; // 甲己艮、乙庚乾、丙辛坤、丁壬离、戊癸巽
const CAI_DIRS = ["东北", "西南", "正西", "正西", "正北", "正北", "正东", "正东", "正南", "正南"];
const FU_DIRS = ["东南", "东南", "正东", "正东", "正北", "正南", "西南", "西南", "西北", "正西"];
const JIU_NAMES = ["一九", "二九", "三九", "四九", "五九", "六九", "七九", "八九", "九九"];

/**
 * 计算冬至数九（一九至九九）与夏至三伏（初伏/中伏/末伏）
 */
export function getShuJiuOrFu(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const currUtcDays = Math.floor(Date.UTC(y, m - 1, d) / 86400000);

  // 1. 冬至数九（当年12月冬至起81天，或上年12月冬至起延伸至当年1-3月）
  if (m === 12 || m <= 3) {
    const dzYear = m === 12 ? y : y - 1;
    const dzDay = getTermDay(dzYear, 23); // 23 = 冬至
    const dzUtcDays = Math.floor(Date.UTC(dzYear, 11, dzDay) / 86400000);
    const diff = currUtcDays - dzUtcDays;
    if (diff >= 0 && diff < 81) {
      const jiuName = JIU_NAMES[Math.floor(diff / 9)];
      const dayInJiu = (diff % 9) + 1;
      return `${jiuName}第${dayInJiu}天`;
    }
  }

  // 2. 夏至三伏（夏至三庚便数伏，立秋首庚为末伏）
  if (m === 7 || m === 8) {
    const xiazhiDays = Math.floor(Date.UTC(y, 5, getTermDay(y, 11)) / 86400000); // 11 = 夏至（6月）
    const liqiuDays = Math.floor(Date.UTC(y, 7, getTermDay(y, 14)) / 86400000);  // 14 = 立秋（8月）
    const xzStem = ((xiazhiDays + 17) % 10 + 10) % 10;
    const deltaToGeng = (6 - xzStem + 10) % 10; // 6 = 庚
    const chuFuStart = xiazhiDays + deltaToGeng + 20;
    const zhongFuStart = xiazhiDays + deltaToGeng + 30;
    const lqStem = ((liqiuDays + 17) % 10 + 10) % 10;
    const moFuStart = liqiuDays + ((6 - lqStem + 10) % 10);
    const moFuEnd = moFuStart + 9;

    if (currUtcDays >= chuFuStart && currUtcDays < zhongFuStart) {
      return `初伏第${currUtcDays - chuFuStart + 1}天`;
    }
    if (currUtcDays >= zhongFuStart && currUtcDays < moFuStart) {
      return `中伏第${currUtcDays - zhongFuStart + 1}天`;
    }
    if (currUtcDays >= moFuStart && currUtcDays <= moFuEnd) {
      return `末伏第${currUtcDays - moFuStart + 1}天`;
    }
  }
  return "";
}

/**
 * 计算任意公历日期的干支纪年/纪月/纪日、纳音、冲煞、吉神方位与十二建除每日宜忌（零外部依赖，支持 1900–2100）
 */
export function getAlmanac(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);

  // 1. 干支年（以立春为界）
  const lichunDay = getTermDay(y, 2); // n=2 为立春（2月）
  const beforeLichun = (m < 2) || (m === 2 && d < lichunDay);
  const gzYearNum = beforeLichun ? y - 1 : y;
  const yOffset = ((gzYearNum - 4) % 60 + 60) % 60;
  const yStemIdx = yOffset % 10;
  const yBranchIdx = yOffset % 12;
  const gy = `${STEMS[yStemIdx]}${BRANCHES[yBranchIdx]}`;
  const zodiac = ZODIACS[yBranchIdx];

  // 2. 干支月（以十二节令为界：小寒->丑月(1), 立春->寅月(2) ... 大雪->子月(0)）
  const jieTermIdx = (m - 1) * 2;
  const jieDay = getTermDay(y, jieTermIdx);
  // 若在当月节令之前，则归属上一节令月
  const solarMonthOrder = d >= jieDay ? m : (m === 1 ? 12 : m - 1);
  // 寅月为正月（对应公历2月立春后，solarMonthOrder=2 -> 寅(2)）
  const mBranchIdx = solarMonthOrder % 12; // 1(小寒)->1(丑), 2(立春)->2(寅), ..., 12(大雪)->0(子)
  // 五虎遁月：甲己之年丙作首（寅月天干 = (yStemIdx % 5) * 2 + 2）
  const yinStem = ((yStemIdx % 5) * 2 + 2) % 10;
  const monthIndexFromYin = (mBranchIdx - 2 + 12) % 12;
  const mStemIdx = (yinStem + monthIndexFromYin) % 10;
  const gm = `${STEMS[mStemIdx]}${BRANCHES[mBranchIdx]}`;

  // 3. 干支日（1970-01-01 + 17 偏移精确对齐甲子表，2026-01-01 为乙亥日）
  const utcDays = Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  const dOffset = ((utcDays + 17) % 60 + 60) % 60;
  const dStemIdx = dOffset % 10;
  const dBranchIdx = dOffset % 12;
  const gd = `${STEMS[dStemIdx]}${BRANCHES[dBranchIdx]}`;

  // 4. 十二建除（月支与日支同位为「建」）
  const dutyIdx = (dBranchIdx - mBranchIdx + 12) % 12;
  const duty = JIANCHU_NAMES[dutyIdx];
  const rule = JIANCHU_YIJI[dutyIdx];

  // 5. 六十甲子纳音、六冲三合煞方、吉神方位、数九/三伏（借鉴 6tail/lunar-javascript）
  const nayin = NAYIN_TABLE[Math.floor(dOffset / 2)] || "";
  const chongBranchIdx = (dBranchIdx + 6) % 12;
  const chongZodiac = ZODIACS[chongBranchIdx];
  const shaDir = SHA_DIRS[dBranchIdx % 4];
  const chongSha = `冲${chongZodiac}煞${shaDir}`;
  const xi = XI_DIRS[dStemIdx % 5];
  const cai = CAI_DIRS[dStemIdx];
  const fu = FU_DIRS[dStemIdx];
  const positions = {
    xi,
    cai,
    fu,
    text: `喜神${xi} · 财神${cai} · 福神${fu}`,
  };
  const shuJiuOrFu = getShuJiuOrFu(y, m, d);

  return {
    gy,
    gm,
    gd,
    zodiac,
    duty,
    nayin,
    chongSha,
    positions,
    shuJiuOrFu,
    yi: rule.yi,
    ji: rule.ji,
    ganZhiText: `${gy}${zodiac}年 · ${gm}月 · ${gd}日（${duty}日${nayin ? " · " + nayin : ""}${shuJiuOrFu ? " · " + shuJiuOrFu : ""}）`,
    detailText: `${nayin} · ${chongSha} · ${positions.text}${shuJiuOrFu ? " · " + shuJiuOrFu : ""}`,
  };
}

/**
 * 计算指定日期属于当年第几周（ISO 8601 / 支持周起始日配置）
 */
export function getWeekOfYear(date, weekStart = 1) {
  const dt = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  if (weekStart === 0) {
    const startOfYear = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
    const days = Math.floor((dt - startOfYear) / 86400000) + startOfYear.getUTCDay();
    return Math.max(1, Math.ceil((days + 1) / 7));
  }
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  return Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);
}

