import { isValidDateKey } from "./calendar.js";
// Mock 数据源：让前端能在浏览器里独立开发与调试，同时与真实后端契约保持一致
import { searchDayItems, SEARCH_LIMIT } from "./search.js";
import { validateCrudInput, matchesExpectedSnapshot } from "./write-state.js";

export function createMockSource(options = {}) {
  const events = [];
  const pendingMap = new Map();
  let pendingSeq = 0;
  let revSeq = 1;
  const history = new Map();
  const importIdentities = new Set();
  let historySeq = 0;
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

  function requireSnapshot(item, expected) {
    if (!expected) throw new Error("编辑缺少原始快照，请刷新后重试");
    if (!matchesExpectedSnapshot(item, expected) || ["canEdit", "canDelete", "canComplete"].some(key => item[key] !== expected[key])) {
      throw new Error("该安排刚刚已发生变化，请刷新后再试");
    }
  }

  function cellSnapshot(dates) {
    return events.filter(item => dates.includes(item.date)).map(cloneItem)
      .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  }

  function saveMutation(dates, before, commit) {
    const cellsBefore = cellSnapshot(dates);
    const after = commit();
    const historyToken = `mock-history-${++historySeq}`;
    history.set(historyToken, { dates, cellsBefore, cellsAfter: cellSnapshot(dates), before, after, direction: "redo" });
    if (history.size > 100) history.delete(history.keys().next().value);
    return { status: "saved", before, after, historyToken };
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
    return commitFn();
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
        return saveMutation([date], null, () => {
          events.push(item);
          return cloneItem(item);
        });
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
      requireSnapshot(item, expected);
      const cleanTitle = title.trim();
      const expectedCopy = expected ? { ...expected } : null;
      return maybePending(`确认将内容修改为“${cleanTitle}”？`, () => {
        const current = events.find(e => e.id === id);
        if (!current || (date && current.date !== date)) throw new Error("找不到日程");
        requireSnapshot(current, expectedCopy);
        return saveMutation([date], cloneItem(current), () => {
          current.title = cleanTitle;
          current.revision = nextRevision();
          return cloneItem(current);
        });
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
      requireSnapshot(item, expected);
      const nextDone = Boolean(done);
      const expectedCopy = expected ? { ...expected } : null;
      return maybePending(`确认${nextDone ? "标记完成" : "取消完成"}“${item.title}”？`, () => {
        const current = events.find(e => e.id === id);
        if (!current || (date && current.date !== date)) throw new Error("找不到日程");
        requireSnapshot(current, expectedCopy);
        return saveMutation([date], cloneItem(current), () => {
          current.done = nextDone;
          current.revision = nextRevision();
          return cloneItem(current);
        });
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
      requireSnapshot(item, expected);
      const expectedCopy = expected ? { ...expected } : null;
      return maybePending(`确认删除“${item.title}”？`, () => {
        const idx = events.findIndex(e => e.id === id);
        if (idx < 0) throw new Error("找不到日程");
        const current = events[idx];
        if (date && current.date !== date) throw new Error("找不到日程");
        requireSnapshot(current, expectedCopy);
        return saveMutation([date], cloneItem(current), () => {
          events.splice(idx, 1);
          return null;
        });
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
      requireSnapshot(item, expected);
      return saveMutation([...new Set([fromDate, toDate])], cloneItem(item), () => {
        item.date = toDate;
        item.revision = nextRevision();
        return cloneItem(item);
      });
    },
    async itemHistoryApply(historyToken, direction) {
      ensureWritable();
      if (!["undo", "redo"].includes(direction)) throw new Error("撤销方向无效");
      const entry = history.get(historyToken);
      if (!entry) throw new Error("撤销记录已失效");
      if (entry.direction === direction) throw new Error("该撤销步骤已经执行");
      const expected = direction === "undo" ? entry.cellsAfter : entry.cellsBefore;
      if (JSON.stringify(cellSnapshot(entry.dates)) !== JSON.stringify(expected)) throw new Error("安排已发生变化，请刷新后重试");
      const restored = direction === "undo" ? entry.cellsBefore : entry.cellsAfter;
      const remaining = events.filter(item => !entry.dates.includes(item.date));
      events.splice(0, events.length, ...remaining, ...restored.map(cloneItem));
      entry.direction = direction;
      return { status: "saved", historyToken, before: direction === "undo" ? entry.after : entry.before, after: direction === "undo" ? entry.before : entry.after };
    },
    async calendarImportItems(items = []) {
      ensureWritable();
      if (!Array.isArray(items) || !items.length) throw new Error("没有可导入的日程");
      if (items.length > 1000) throw new Error("单次最多导入 1000 条日程");
      const occurrences = new Map(), staged = [], identities = new Set();
      let skipped = 0, missingIdentity = false;
      for (const [index, entry] of items.entries()) {
        if (!entry) throw new Error(`第 ${index + 1} 条导入项无效；整批未写入`);
        const normTime = String(entry.time ?? "").trim();
        validateCrudInput({ date: entry.date, title: entry.title, time: normTime, checkTime: true });
        if (!isValidDateKey(entry.date) || entry.title.includes("\0") || new TextEncoder().encode(entry.title.trim()).length > 16384) throw new Error("导入项内容无效；整批未写入");
        const uid = entry.uid ?? "", source = entry.source || "ics", done = entry.done ?? false, kind = entry.kind ?? "";
        if (typeof uid !== "string" || typeof source !== "string" || typeof done !== "boolean" || uid.length > 4096 || source.length > 4096) throw new Error("导入项来源身份无效；整批未写入");
        if (!["", "item", "event"].includes(kind) || (kind === "item" && normTime)) throw new Error("导入项类型无效；整批未写入");
        let identity;
        if (uid) identity = `uid:${JSON.stringify([source, uid])}`;
        else {
          missingIdentity = true;
          const content = JSON.stringify([source, kind, entry.date, normTime, entry.title.trim(), done]);
          const ordinal = (occurrences.get(content) || 0) + 1;
          occurrences.set(content, ordinal);
          identity = `content:${content}:${ordinal}`;
        }
        if (importIdentities.has(identity) || identities.has(identity)) { skipped++; continue; }
        identities.add(identity);
        const isEvent = kind === "event" || Boolean(normTime);
        const id = `mock-import-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 6)}`;
        staged.push({
          id,
          date: entry.date,
          time: normTime,
          title: String(entry.title).trim(),
          done,
          kind: isEvent ? "event" : "item",
          canEdit: true,
          canDelete: true,
          canComplete: !isEvent,
          calendarId: "mock-cal",
          remoteId: id,
          revision: nextRevision(),
        });
      }
      events.push(...staged);
      for (const identity of identities) importIdentities.add(identity);
      const warnings = missingIdentity ? ["部分日程没有 UID：按内容及本批相同内容的出现次数识别；内容或批次组成改变后无法保证来源身份。"] : [];
      return { status: "saved", imported: staged.length, skipped, invalid: 0, unsupported: 0, warnings };
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
      return commitFn();
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
