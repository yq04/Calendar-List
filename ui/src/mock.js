import { isValidDateKey } from "./calendar.js";
// Mock 数据源：让前端能在浏览器里独立开发与调试，同时与真实后端契约保持一致
import { searchDayItems, SEARCH_LIMIT } from "./search.js";
import { validateCrudInput, matchesExpectedSnapshot } from "./write-state.js";

export function createMockSource(options = {}) {
  const events = [];
  const pendingMap = new Map();
  let pendingSeq = 0;
  let revSeq = 1;
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();

  const seed = [
    [0, "", "周一晨会 · 项目对齐", false],
    [0, "", "整理 Kal 渲染框架笔记", false],
    [1, "", "评审壁纸取色方案", false],
    [2, "", "牙医复诊", false],
    [2, "", "长距离慢跑 8km", true],
    [3, "", "与 YG 过一遍进度", false],
    [3, "", "买咖啡豆", true],
    [4, "", "把主题 schema 定稿", false],
    [4, "", "旧笔记归档", false],
    [4, "", "重装键盘轴体", true],
    [5, "", "家庭聚餐", false],
    [8, "", "季度目标复盘", false],
    [9, "", "体检预约", false],
    [11, "", "GPU 渲染管线调研", false],
    [11, "", "羽毛球", true],
    [14, "", "写 Kal 的第一版发布说明", false],
    [16, "", "备份日历数据库", false],
    [18, "", "和外包对接图标风格", false],
    [20, "", "把 DPI 缩放模型跑通", false],
    [21, "", "看电影", true],
    [23, "", "整理调研结论", false],
    [25, "", "给 Kal 加倒计时卡片", false],
    [27, "", "月度账单", false],
  ];

  seed.forEach(([dayOffset, time, title, done], idx) => {
    const d = new Date(y, m, 1 + dayOffset);
    const normTime = String(time ?? "").trim();
    const isEvent = Boolean(normTime);
    const id = `mock-${dayOffset}-${idx}`;
    events.push({
      id,
      date: toKey(d),
      time: normTime,
      title,
      done: Boolean(done),
      kind: isEvent ? "event" : "item",
      canEdit: true,
      canDelete: true,
      canComplete: !isEvent,
      calendarId: "mock-cal",
      remoteId: id,
      revision: `rev-${revSeq++}`,
    });
  });

  function cloneItem(it) {
    return { ...it };
  }

  function nextRevision() {
    revSeq += 1;
    return `rev-${revSeq}`;
  }

  function ensureWritable() {
    if (options.readOnly) {
      throw new Error("当前日历处于只读模式，仅支持浏览与搜索");
    }
    if (pendingMap.size > 0) {
      throw new Error("请先确认或取消上一项待确认的修改");
    }
  }

  function maybePending(summary, commitFn) {
    if (options.requireConfirm) {
      pendingSeq += 1;
      const pendingId = `kal-pending-mock-${pendingSeq}`;
      pendingMap.set(pendingId, commitFn);
      return {
        status: "pending_confirmation",
        pendingId,
        summary,
      };
    }
    const item = commitFn();
    return item ? { ...item, status: "saved" } : { status: "saved" };
  }

  return {
    kind: "mock",
    async monthEvents(year, month) {
      const prefix = `${year}-${pad(month + 1)}`;
      return events.filter(e => e.date.startsWith(prefix)).map(cloneItem);
    },
    async rangeEvents(start, end) {
      if (!isValidDateKey(start) || !isValidDateKey(end)) throw new Error("日期范围无效");
      const days = (Date.parse(end) - Date.parse(start)) / 86400000 + 1;
      if (days < 1 || days > 93) throw new Error("日期范围必须为 1–93 天");
      return events.filter(item => item.date >= start && item.date <= end).map(cloneItem);
    },
    async dayEvents(key) {
      validateCrudInput({ date: key, checkTitle: false });
      return events.filter(e => e.date === key).map(cloneItem);
    },
    async searchEvents(query) {
      return searchDayItems(events, query, SEARCH_LIMIT).map(cloneItem);
    },
    async writeStatus() {
      if (options.readOnly) {
        return {
          available: false,
          canCreate: false,
          canCreateEvent: false,
          label: "只读演示模式：当前不可保存修改",
        };
      }
      return {
        available: true,
        canCreate: options.canCreate !== false,
        canCreateEvent: options.canCreateEvent !== false,
        label: "演示模式：修改仅保存在当前会话",
      };
    },
    async itemCreate(date, title, time = "") {
      ensureWritable();
      const normTime = String(time ?? "").trim();
      validateCrudInput({ date, title, time: normTime, checkTitle: true, checkTime: true });
      if (normTime && options.canCreateEvent === false) {
        throw new Error("当前暂不支持新建带时间的日程");
      }
      if (!normTime && options.canCreate === false) {
        throw new Error("当前暂不支持新建普通任务");
      }
      const cleanTitle = title.trim();
      const isEvent = Boolean(normTime);
      return maybePending(`确认添加“${cleanTitle}”？`, () => {
        const id = `mock-local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const item = {
          id,
          date,
          time: normTime,
          title: cleanTitle,
          done: false,
          kind: isEvent ? "event" : "item",
          canEdit: true,
          canDelete: true,
          canComplete: !isEvent,
          calendarId: "mock-cal",
          remoteId: id,
          revision: nextRevision(),
        };
        events.push(item);
        return cloneItem(item);
      });
    },
    async itemUpdate(id, date, title, expected = null) {
      ensureWritable();
      validateCrudInput({ date, title, checkTitle: true });
      const item = events.find(e => e.id === id);
      if (!item || (date && item.date !== date)) throw new Error("找不到日程");
      if (item.canEdit === false || item.kind === "note") {
        throw new Error("该类型暂不支持编辑");
      }
      if (expected && !matchesExpectedSnapshot(item, expected)) {
        throw new Error("该安排刚刚已发生变化，请刷新后再试");
      }
      const cleanTitle = title.trim();
      const expectedCopy = expected ? { ...expected } : null;
      return maybePending(`确认将内容修改为“${cleanTitle}”？`, () => {
        const current = events.find(e => e.id === id);
        if (!current || (date && current.date !== date)) throw new Error("找不到日程");
        if (expectedCopy && !matchesExpectedSnapshot(current, expectedCopy)) {
          throw new Error("该安排在确认前已发生变化，请刷新后再试");
        }
        current.title = cleanTitle;
        current.revision = nextRevision();
        return cloneItem(current);
      });
    },
    async itemToggleDone(id, date, done, expected = null) {
      ensureWritable();
      if (date !== undefined) validateCrudInput({ date, checkTitle: false });
      const item = events.find(e => e.id === id);
      if (!item || (date && item.date !== date)) throw new Error("找不到日程");
      if (item.canComplete === false || item.kind === "note") {
        throw new Error("该类型暂不支持完成状态");
      }
      if (expected && !matchesExpectedSnapshot(item, expected)) {
        throw new Error("该安排刚刚已发生变化，请刷新后再试");
      }
      const nextDone = Boolean(done);
      const expectedCopy = expected ? { ...expected } : null;
      return maybePending(`确认${nextDone ? "标记完成" : "取消完成"}“${item.title}”？`, () => {
        const current = events.find(e => e.id === id);
        if (!current || (date && current.date !== date)) throw new Error("找不到日程");
        if (expectedCopy && !matchesExpectedSnapshot(current, expectedCopy)) {
          throw new Error("该安排在确认前已发生变化，请刷新后再试");
        }
        current.done = nextDone;
        current.revision = nextRevision();
        return cloneItem(current);
      });
    },
    async itemDelete(id, date, expected = null) {
      ensureWritable();
      if (date !== undefined) validateCrudInput({ date, checkTitle: false });
      const i = events.findIndex(e => e.id === id);
      if (i < 0) throw new Error("找不到日程");
      const item = events[i];
      if (date && item.date !== date) throw new Error("找不到日程");
      if (item.canDelete === false || item.kind === "note") {
        throw new Error("该类型暂不支持删除");
      }
      if (expected && !matchesExpectedSnapshot(item, expected)) {
        throw new Error("该安排刚刚已发生变化，请刷新后再试");
      }
      const expectedCopy = expected ? { ...expected } : null;
      return maybePending(`确认删除“${item.title}”？`, () => {
        const idx = events.findIndex(e => e.id === id);
        if (idx < 0) throw new Error("找不到日程");
        const current = events[idx];
        if (date && current.date !== date) throw new Error("找不到日程");
        if (expectedCopy && !matchesExpectedSnapshot(current, expectedCopy)) {
          throw new Error("该安排在确认前已发生变化，请刷新后再试");
        }
        events.splice(idx, 1);
        return null;
      });
    },
    async itemMove(id, fromDate, toDate, expected = null) {
      ensureWritable();
      validateCrudInput({ date: fromDate, checkTitle: false });
      validateCrudInput({ date: toDate, checkTitle: false });
      const item = events.find(e => e.id === id);
      if (!item || (fromDate && item.date !== fromDate)) throw new Error("找不到要改期的日程");
      if (item.canEdit === false || item.kind === "note") {
        throw new Error("该类型暂不支持移动日期");
      }
      if (expected && !matchesExpectedSnapshot(item, expected)) {
        throw new Error("该安排刚刚已发生变化，请刷新后再试");
      }
      item.date = toDate;
      item.revision = nextRevision();
      return { ...cloneItem(item), status: "saved" };
    },
    async calendarImportItems(items = []) {
      ensureWritable();
      if (!Array.isArray(items) || !items.length) throw new Error("没有可导入的日程");
      let imported = 0;
      for (const entry of items) {
        if (!entry || !isValidDateKey(entry.date) || !String(entry.title ?? "").trim()) continue;
        const normTime = String(entry.time ?? "").trim();
        const isEvent = Boolean(normTime);
        const id = `mock-import-${Date.now()}-${imported}-${Math.random().toString(36).slice(2, 6)}`;
        events.push({
          id,
          date: entry.date,
          time: normTime,
          title: String(entry.title).trim(),
          done: false,
          kind: isEvent ? "event" : "item",
          canEdit: true,
          canDelete: true,
          canComplete: !isEvent,
          calendarId: "mock-cal",
          remoteId: id,
          revision: nextRevision(),
        });
        imported += 1;
      }
      return { status: "saved", imported };
    },
    async itemConfirm(pendingId, accept) {
      const id = String(pendingId ?? "");
      const commitFn = pendingMap.get(id);
      if (!commitFn) {
        throw new Error("待确认请求不存在或已过期");
      }
      pendingMap.delete(id);
      if (!accept) {
        return { status: "cancelled" };
      }
      const item = commitFn();
      return item ? { ...item, status: "saved" } : { status: "saved" };
    },
    /** 仅测试辅助：模拟确认期间外部改动导致 revision 变化 */
    _touchItemForTest(id, patch = {}) {
      const item = events.find(e => e.id === id);
      if (!item) return null;
      Object.assign(item, patch);
      if (!("revision" in patch)) item.revision = nextRevision();
      return cloneItem(item);
    },
  };
}

export function pad(n) { return String(n).padStart(2, "0"); }
export function toKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
