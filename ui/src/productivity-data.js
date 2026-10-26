// 自然日计算与本机倒计时数据，不依赖 DOM、时区偏移或 DesktopCal 写入。
export const MAX_COUNTDOWNS = 12;

export function dateOrdinal(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error("请选择有效日期");
  const [y, m, d] = key.split("-").map(Number);
  const value = new Date(0);
  value.setUTCFullYear(y, m - 1, d);
  value.setUTCHours(0, 0, 0, 0);
  if (y < 1 || value.getUTCFullYear() !== y || value.getUTCMonth() !== m - 1 || value.getUTCDate() !== d) {
    throw new Error("请选择有效日期");
  }
  return value.getTime() / 86400000;
}

export function localToday(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function countdownLabel(date, today = localToday()) {
  const days = dateOrdinal(date) - dateOrdinal(today);
  return days === 0 ? "就是今天" : days > 0 ? `还有 ${days} 天` : `已过 ${-days} 天`;
}

export function normalizeCountdowns(raw) {
  if (!Array.isArray(raw)) return [];
  const ids = new Set();
  return raw.filter(item => {
    if (!item || typeof item.id !== "string" || !item.id || ids.has(item.id) ||
        typeof item.title !== "string" || !item.title.trim() || item.title.length > 80 ||
        typeof item.date !== "string") return false;
    try { dateOrdinal(item.date); } catch { return false; }
    ids.add(item.id);
    return true;
  }).slice(0, MAX_COUNTDOWNS).map(({ id, title, date }) => ({ id, title: title.trim(), date }));
}

export function makeCountdown(title, date) {
  title = String(title ?? "").trim();
  if (!title || title.length > 80) throw new Error("标题需要 1–80 个字符");
  dateOrdinal(date);
  return { id: globalThis.crypto.randomUUID(), title, date };
}

export function createCountdownStore(bridge) {
  let items = [];
  let busy = false;
  let ready = false;
  return {
    get items() { return items.map(item => ({ ...item })); },
    get ready() { return ready; },
    async load() {
      const settings = await bridge.settingsGet();
      items = normalizeCountdowns(settings?.productivity?.countdowns);
      ready = true;
      return this.items;
    },
    async save(next) {
      if (!ready) throw new Error("本地设置尚未读入，请刷新后重试");
      if (busy) throw new Error("正在保存，请稍候");
      const validated = normalizeCountdowns(next);
      if (validated.length !== next.length) throw new Error("倒计时数据无效或已达到 12 条上限");
      busy = true;
      try {
        await bridge.settingsSet({ productivity: { countdowns: validated } });
        items = validated;
        return this.items;
      } finally { busy = false; }
    },
  };
}
