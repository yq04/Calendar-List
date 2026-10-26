// 日程搜索纯函数模块：可脱离 DOM 独立测试
// 支持中文与英文字母大小写不敏感匹配、多词组合匹配、100 条上限与截断提示。

export const SEARCH_LIMIT = 100;

/** 归一化查询串：去首尾空白、折叠全角/多空白、英文转小写 */
export function normalizeSearchQuery(query) {
  return String(query ?? "")
    .replace(/\u3000/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** 拆分为非空关键词 token */
export function tokenizeQuery(query) {
  const norm = normalizeSearchQuery(query);
  if (!norm) return [];
  return norm.split(" ").filter(Boolean);
}

/** 判断单条 DayItem 是否匹配查询词（支持标题、日期、时间匹配） */
export function matchDayItem(item, query) {
  if (!item || typeof item !== "object") return false;
  const tokens = tokenizeQuery(query);
  if (!tokens.length) return false;

  const title = String(item.title ?? "").toLowerCase();
  const date = String(item.date ?? "").toLowerCase();
  const time = String(item.time ?? "").toLowerCase();
  const kindTag = item.kind === "note" ? "便签 note" : item.kind === "event" ? "日程 event" : "任务 item";
  const haystack = `${date} ${time} ${title} ${kindTag}`;

  for (const tk of tokens) {
    if (!haystack.includes(tk)) return false;
  }
  return true;
}

/** 排序比较器：按日期升序、时间升序、标题升序稳定排列 */
export function compareSearchItems(a, b) {
  const d = String(a?.date ?? "").localeCompare(String(b?.date ?? ""));
  if (d !== 0) return d;
  const t = String(a?.time ?? "").localeCompare(String(b?.time ?? ""));
  if (t !== 0) return t;
  return String(a?.title ?? "").localeCompare(String(b?.title ?? ""));
}

/**
 * 在内存中检索全部事项，返回最多 limit 条（默认 100 条）DayItem[]。
 * 供 Mock 数据源及纯函数测试使用，与后端 search_events 返回格式对齐。
 */
export function searchDayItems(items, query, limit = SEARCH_LIMIT) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : SEARCH_LIMIT;
  const tokens = tokenizeQuery(query);
  if (!tokens.length || !Array.isArray(items)) return [];
  const matched = items.filter(it => matchDayItem(it, query));
  matched.sort(compareSearchItems);
  return matched.slice(0, max);
}

/**
 * 构建搜索视图状态（包含结果列表、是否触发 100 条截断、用户提示文案）
 * 无论后端已截断到 100 条还是传入未截断数组，均能给出准确截断提示。
 */
export function buildSearchViewModel(rawItems, query, limit = SEARCH_LIMIT) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : SEARCH_LIMIT;
  const q = normalizeSearchQuery(query);
  if (!q) {
    return {
      query: "",
      items: [],
      count: 0,
      truncated: false,
      hint: "输入关键词搜索所有日期的安排",
    };
  }
  const list = Array.isArray(rawItems) ? rawItems.filter(Boolean) : [];
  const truncated = list.length >= max;
  const items = list.slice(0, max);
  let hint = "";
  if (!items.length) {
    hint = "未找到匹配的安排";
  } else if (truncated) {
    hint = `仅显示前 ${max} 条匹配结果，请补充更具体的关键词`;
  } else {
    hint = `找到 ${items.length} 条结果`;
  }
  return {
    query: q,
    items,
    count: items.length,
    truncated,
    hint,
  };
}
