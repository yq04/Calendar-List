// Kal 前端入口：状态 -> 渲染，单向数据流
//
// 分工：
//   calendar.js   纯日历数学与导出构建
//   nlp-parser.js 零依赖中文自然语言速记解析、内联标签/优先级装饰与 RFC 5545 .ics 解析
//   theme.js      主题 -> CSS 变量
//   panel.js      个性化面板（声明式控件）
//   main.js       状态机 + 渲染 + 事件接线（本文件）

import {
  getMonthMatrix, weekHeadLabels, addMonths, pad,
  formatAgendaDate, groupByDay, pickDefaultSelected, fromKey, toKey, parseQuickEntry,
  buildIcsCalendar, buildMarkdownCalendar, buildPrintableCalendarHtml,
} from "./calendar.js";
import {
  parseNaturalEntry, parseTaskDecorations, parseIcsCalendar,
  addDaysToKey, CELL_HIGHLIGHT_PALETTE,
} from "./nlp-parser.js";
import { createDraftSessions, bindImeGuard, isImeComposing } from "./input-session.js";
import { createBridge } from "./bridge.js";
import { applyTheme, setUiScale, DEFAULT_THEME, normalizeTheme, mergeThemeAppearance, applyStyleRecipe } from "./theme.js";
import { createPanel } from "./panel.js";
import { buildSearchViewModel, SEARCH_LIMIT } from "./search.js";
import { createSearchScheduler } from "./search-scheduler.js";
import { getLunarDay, getGanZhiYear, getAlmanac, getWeekOfYear, setCustomHolidays } from "./lunar.js";
import { createProductivity } from "./productivity.js";
import { createLocalFonts } from "./local-fonts.js";
import { mountDesktopSettings } from "./desktop-settings.js";
import { createBackdropManager } from "./backdrop.js";
import {
  sanitizeUserMessage, normalizeWriteStatus, getItemCapabilities,
  buildExpectedSnapshot, validateCrudInput, interpretWriteResult, createSeqGuard,
} from "./write-state.js";

const state = {
  year: new Date().getFullYear(),
  month: new Date().getMonth(),
  selected: null,
  applied: DEFAULT_THEME,
  draft: DEFAULT_THEME,
  info: null,
  weekStart: 1,
  maxTasks: 4,
  writeStatus: {
    available: true,
    canCreate: true,
    canCreateEvent: true,
    label: "",
    hint: "",
  },
  writeBusy: false,
  pendingConfirm: null,  // { pendingId, summary, onConfirmed, onCancelled }
  readError: "",
  transientStatus: "",
  transientError: false,
  searchOpen: false,
  searchRawResults: [],
  searchLastQuery: "",
  searchFilter: "all",   // all | todo | done
  searchItems: [],
  searchActiveIdx: -1,
  ymOpen: false,
  exportOpen: false,
  exportOrient: "landscape",
  exportPaper: "A4",
  exportMargin: 6,
  privacyMode: false,
  windowLocked: false,
  clickThrough: false,
  viewMode: "month",     // "month" | "week"
  currentAgendaList: [],
  lastByDay: new Map(),
  cellColors: {},        // { "YYYY-MM-DD": "emerald" | "rose" | "amber" | ... }
  undoStack: [],         // 最近 20 步可撤销操作
  redoStack: [],
};

const renderGuard = createSeqGuard();
const agendaGuard = createSeqGuard();
const searchGuard = createSeqGuard();
const themeGuard = createSeqGuard();
let themeSnapshot = null;
let themeSaving = false;

const quickDrafts = createDraftSessions();
const editDrafts = createDraftSessions();
let quickDate = null;
let searchReturnFocus = null;
function rememberQuickDraft() {
  if (quickDate) quickDrafts.update(quickDate, el["kal-agenda-input"].value);
}
function syncQuickDraft() {
  const key = state.selected;
  if (key === quickDate) return;
  rememberQuickDraft();
  quickDate = key;
  const input = el["kal-agenda-input"];
  input.value = quickDrafts.get(key).text;
  input.setAttribute("aria-label", `添加 ${key} 的安排（草稿仅保留在本次会话）`);
  if (el["kal-agenda-date-input"]) {
    el["kal-agenda-date-input"].value = key || "";
  }
  syncComposerMetaUi();
  renderNlpPreview();
}

function normalizeManualTime(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const m = s.match(/^(\d{1,2})[:：]?(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return null;
  }
  return `${pad(hh)}:${pad(mm)}`;
}

function syncComposerMetaUi() {
  const timeInput = el["kal-agenda-time-input"];
  const dateInput = el["kal-agenda-date-input"];
  const prioBtn = el["kal-agenda-prio-btn"];
  const toggleBtn = el["kal-time-toggle-btn"];
  const metaBox = el["kal-agenda-add-meta"];
  const rawTime = timeInput ? timeInput.value.trim() : "";
  const normTime = normalizeManualTime(rawTime);
  const hasCustomDate = Boolean(dateInput?.value && state.selected && dateInput.value !== state.selected);
  const hasPrio = prioBtn?.getAttribute("aria-pressed") === "true";

  if (metaBox) {
    metaBox.querySelectorAll(".kal-time-chip:not(.kal-prio-chip)").forEach(chip => {
      const chipTime = chip.dataset.time ?? "";
      chip.classList.toggle("is-active", chipTime ? normTime === chipTime : !rawTime);
    });
  }
  if (toggleBtn) {
    toggleBtn.classList.toggle("is-active", Boolean(metaBox && !metaBox.hidden));
    toggleBtn.classList.toggle("has-time", Boolean(rawTime || hasCustomDate || hasPrio));
  }
}

const el = {};
function cacheEls() {
  for (const id of [
    "kal-month-label", "kal-year-label", "kal-lunar-year", "kal-week-badge", "kal-title-trigger",
    "kal-ym-popover", "kal-weekhead", "kal-grid",
    "kal-agenda-date", "kal-agenda-count", "kal-undo-btn", "kal-rollover-btn",
    "kal-agenda-copy", "kal-agenda-ics", "kal-agenda-sub", "kal-cell-color-bar", "kal-agenda-list",
    "kal-source-tag", "kal-display-tag", "kal-app-version", "kal-agenda-add", "kal-agenda-input",
    "kal-time-toggle-btn", "kal-agenda-add-meta", "kal-agenda-time-input", "kal-agenda-date-input", "kal-agenda-prio-btn",
    "kal-nlp-preview", "kal-write-status", "kal-pending-box", "kal-agenda-inline-trigger",
    "kal-search-btn", "kal-search-popover", "kal-search-input", "kal-search-filters",
    "kal-search-close", "kal-search-meta", "kal-search-list",
    "kal-export-btn", "kal-export-popover", "kal-export-close",
    "kal-export-orient", "kal-export-paper", "kal-export-margin",
    "kal-export-lunar", "kal-export-almanac", "kal-export-completed", "kal-export-detail",
    "kal-export-pdf", "kal-export-md", "kal-export-import-ics", "kal-ics-file-input",
    "kal-export-print", "kal-export-status",
    "kal-day-more-popover", "kal-day-more-title", "kal-day-more-close", "kal-day-more-list",
    "kal-refresh", "kal-lock-btn", "kal-quick-glass", "kal-privacy-btn", "kal-view-toggle",
    "kal-holiday-json", "kal-holiday-save", "kal-holiday-sample", "kal-holiday-reset", "kal-holiday-status",
  ]) {
    el[id] = document.getElementById(id);
  }
}

function invalidateReads() {
  renderGuard.next();
  agendaGuard.next();
}

/** One inclusive query for the visible 42 dates, including adjacent-month cells. */
async function matrixMapForView(year, month, weekStart) {
  const cells = getMonthMatrix(year, month, weekStart);
  const start = cells[0].key, end = cells[cells.length - 1].key;
  const events = await bridge.rangeEvents(start, end);
  return { cells, byDay: groupByDay(events), partialError: null };
}

function formatTaskListForDisplay(rawList) {
  if (!Array.isArray(rawList) || !rawList.length) return [];
  const layout = state.draft?.layout || {};
  let out = rawList;
  if (layout.hideCompleted) {
    out = out.filter(ev => !ev.done);
  }
  if (layout.sortCompletedLast) {
    out = out.slice().sort((a, b) => Number(Boolean(a.done)) - Number(Boolean(b.done)));
  }
  return out;
}

function focusQuickInputForCell({ focusInput = true } = {}) {
  const input = el["kal-agenda-input"];
  if (!input || input.disabled) return;
  if (focusInput) input.focus();
  input.classList.remove("is-quick-pulse");
  void input.offsetWidth;
  input.classList.add("is-quick-pulse");
}

/** 通用快速创建安排（默认无时间，支持左侧日格内联直编与右侧列表直编） */
async function createArrangementQuick(rawInput, baseDateKey) {
  const text = String(rawInput ?? "").trim();
  if (!text) return "empty";
  if (state.writeBusy || state.pendingConfirm || !state.writeStatus.available) return "blocked";
  const baseDate = baseDateKey || state.selected || toKey(new Date());
  const nlp = parseNaturalEntry(text, baseDate);
  const parsed = nlp.hasNlpHint && nlp.title ? nlp : parseQuickEntry(text);
  if (!parsed.title) return "empty";

  const finalTime = parsed.time || "";
  const finalTitle = parsed.title;
  if (finalTime && !state.writeStatus.canCreateEvent) {
    setWriteStatus("当前仅支持添加无具体时间的任务，请去掉时间后再试", true);
    return "error";
  }
  if (!finalTime && !state.writeStatus.canCreate) {
    setWriteStatus("当前暂不支持添加普通任务", true);
    return "error";
  }
  const targetDate = (nlp.hasNlpHint && nlp.date && nlp.date !== baseDate) ? nlp.date : baseDate;
  try {
    validateCrudInput({ date: targetDate, title: finalTitle, time: finalTime, checkTitle: true, checkTime: true });
  } catch (err) {
    setWriteStatus(err.message, true);
    return "error";
  }
  const targetDates = nlp.hasNlpHint && Array.isArray(nlp.dates) && nlp.dates.length > 1
    ? nlp.dates
    : [targetDate];

  return await writeAction(
    async () => {
      let lastRes = null;
      for (const dKey of targetDates) {
        lastRes = await bridge.itemCreate(dKey, finalTitle, finalTime);
        if (lastRes && lastRes.status === "pending_confirmation") break;
      }
      return lastRes;
    },
    {
      onConfirmed: () => {
        panel?.addLog?.("schedule", `新增安排「${finalTitle}」(${targetDate}${finalTime ? " " + finalTime : " 全天"})`);
      },
    },
  );
}

/** 在左侧日历单元格内部直接打开内联新增输入框（双击日格或点击日格 + 按钮触发） */
function openCellInlineEditor(cellNode, dateKey) {
  focusQuickInputForCell({ focusInput: false });
  if (!state.writeStatus.available || state.writeBusy || state.pendingConfirm) {
    focusQuickInputForCell({ focusInput: true });
    return;
  }
  const liveCell = el["kal-grid"]?.querySelector(`.kal-cell[data-key="${dateKey}"]`) || cellNode;
  if (!liveCell) return;

  // 关闭其他日格里未提交的空内联输入框
  el["kal-grid"]?.querySelectorAll(".kal-cell-inline-editor").forEach(node => {
    if (!node.closest(`.kal-cell[data-key="${dateKey}"]`)) node.remove();
  });

  const existingInput = liveCell.querySelector(".kal-cell-inline-editor .kal-cell-inline-input");
  if (existingInput) {
    existingInput.focus();
    return;
  }

  let tasksBox = liveCell.querySelector(".kal-tasks");
  if (!tasksBox) {
    tasksBox = document.createElement("div");
    tasksBox.className = "kal-tasks";
    const moreNode = liveCell.querySelector(".kal-task-more");
    if (moreNode) liveCell.insertBefore(tasksBox, moreNode);
    else liveCell.appendChild(tasksBox);
  }

  const wrap = document.createElement("div");
  wrap.className = "kal-cell-inline-editor";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "kal-cell-inline-input";
  input.placeholder = "输入安排，回车保存…";
  input.setAttribute("aria-label", `在 ${dateKey} 直接添加安排`);
  bindImeGuard(input);
  wrap.appendChild(input);
  tasksBox.appendChild(wrap);
  input.focus();
  if (typeof tasksBox.scrollTo === "function") {
    tasksBox.scrollTo({ top: tasksBox.scrollHeight });
  }

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    wrap.remove();
    if (tasksBox.isConnected && tasksBox.children.length === 0) {
      tasksBox.remove();
    }
  };

  const submitInline = async () => {
    if (done || isImeComposing(null, input)) return;
    const val = input.value.trim();
    if (!val) {
      cleanup();
      return;
    }
    done = true;
    input.disabled = true;
    const outcome = await createArrangementQuick(val, dateKey);
    if (outcome !== "saved" && outcome !== "pending" && wrap.isConnected) {
      done = false;
      input.disabled = false;
      input.focus();
    } else if (wrap.isConnected) {
      wrap.remove();
    }
  };

  input.addEventListener("click", e => e.stopPropagation());
  input.addEventListener("dblclick", e => e.stopPropagation());
  input.addEventListener("keydown", e => {
    if (isImeComposing(e)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      submitInline();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
    }
  });
  input.addEventListener("blur", () => {
    if (done || isImeComposing(null, input)) return;
    if (!input.value.trim()) cleanup();
  });
}

/** 在右侧每日清单区域内直接插入内联新增输入行（点击右侧列表底部按钮或空白提示触发） */
function openAgendaInlineEditor() {
  const ul = el["kal-agenda-list"];
  if (!ul || !state.writeStatus.available || state.writeBusy || state.pendingConfirm) {
    focusQuickInputForCell({ focusInput: true });
    return;
  }
  const existing = ul.querySelector(".kal-agenda-inline-new");
  if (existing) {
    existing.focus();
    return;
  }
  const dateKey = state.selected || toKey(new Date());
  const row = document.createElement("div");
  row.className = "kal-agenda-inline-new-row";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "kal-agenda-inline-new";
  input.placeholder = "直接输入新安排，回车保存（Esc 取消）…";
  input.setAttribute("aria-label", `在右侧列表直接添加 ${dateKey} 安排`);
  bindImeGuard(input);
  row.appendChild(input);
  ul.appendChild(row);
  input.focus();
  if (typeof ul.scrollTo === "function") {
    ul.scrollTo({ top: ul.scrollHeight });
  }

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    row.remove();
  };
  const submit = async () => {
    if (done || isImeComposing(null, input)) return;
    const val = input.value.trim();
    if (!val) {
      cleanup();
      return;
    }
    done = true;
    input.disabled = true;
    const outcome = await createArrangementQuick(val, dateKey);
    if (outcome !== "saved" && outcome !== "pending" && row.isConnected) {
      done = false;
      input.disabled = false;
      input.focus();
    } else if (row.isConnected) {
      row.remove();
    }
  };
  input.addEventListener("keydown", e => {
    if (isImeComposing(e)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
    }
  });
  input.addEventListener("blur", () => {
    if (!done && !isImeComposing(null, input) && !input.value.trim()) cleanup();
  });
}
function openCellInlineTaskEdit(taskEl, ev) {
  if (!state.writeStatus.available || state.writeBusy || state.pendingConfirm) return;
  const caps = getItemCapabilities(ev, { available: true });
  if (!caps.canEdit) return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "kal-cell-inline-input is-edit";
  input.value = ev.title;
  input.setAttribute("aria-label", `直接修改 ${ev.date} 安排：${ev.title}`);
  bindImeGuard(input);

  let finished = false;
  const restore = () => {
    if (finished) return;
    finished = true;
    if (input.isConnected) input.replaceWith(taskEl);
  };

  const commit = async () => {
    if (finished || isImeComposing(null, input)) return;
    const nextTitle = input.value.trim();
    if (!nextTitle || nextTitle === ev.title) {
      restore();
      return;
    }
    try {
      validateCrudInput({ date: ev.date, title: nextTitle, checkTitle: true });
    } catch (err) {
      setWriteStatus(err.message, true);
      return;
    }
    finished = true;
    input.disabled = true;
    const expected = buildExpectedSnapshot(ev);
    const outcome = await writeAction(
      () => bridge.itemUpdate(ev.id, ev.date, nextTitle, expected),
      {
        onConfirmed: () => {
          panel?.addLog?.("schedule", `左栏直编安排「${ev.title}」→「${nextTitle}」(${ev.date})`);
        },
        onCancelled: () => {
          finished = false;
          if (input.isConnected) input.replaceWith(taskEl);
        },
      },
    );
    if (outcome !== "saved" && outcome !== "pending" && input.isConnected) {
      finished = false;
      input.disabled = false;
      input.focus();
    }
  };

  taskEl.replaceWith(input);
  input.focus();
  input.select();
  input.addEventListener("click", e => e.stopPropagation());
  input.addEventListener("dblclick", e => e.stopPropagation());
  input.addEventListener("keydown", e => {
    if (isImeComposing(e)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      restore();
    }
  });
  input.addEventListener("blur", () => {
    if (!finished && !isImeComposing(null, input)) restore();
  });
}

// ---------------------------------------------------------------- 撤销 / 重做栈 (Ctrl+Z / Ctrl+Y)

function syncUndoButton() {
  const btn = el["kal-undo-btn"];
  if (!btn) return;
  const top = state.undoStack[state.undoStack.length - 1];
  btn.hidden = !top;
  if (top) {
    btn.title = `撤销：${top.label} (Ctrl+Z)`;
  }
}

function pushUndoAction(entry) {
  if (!entry || typeof entry.undo !== "function") return;
  state.undoStack.push(entry);
  if (state.undoStack.length > 20) state.undoStack.shift();
  state.redoStack.length = 0;
  syncUndoButton();
}

async function performUndo() {
  if (state.writeBusy || state.pendingConfirm || !state.undoStack.length) return;
  const entry = state.undoStack.pop();
  syncUndoButton();
  try {
    await entry.undo();
    if (typeof entry.redo === "function") {
      state.redoStack.push(entry);
    }
    invalidateReads();
    await render();
    setWriteStatus(`已撤销：${entry.label}`, false);
  } catch (err) {
    setWriteStatus(`撤销失败：${sanitizeUserMessage(err?.message || String(err))}`, true);
  }
}

async function performRedo() {
  if (state.writeBusy || state.pendingConfirm || !state.redoStack.length) return;
  const entry = state.redoStack.pop();
  try {
    await entry.redo();
    state.undoStack.push(entry);
    syncUndoButton();
    invalidateReads();
    await render();
    setWriteStatus(`已重做：${entry.label}`, false);
  } catch (err) {
    setWriteStatus(`重做失败：${sanitizeUserMessage(err?.message || String(err))}`, true);
  }
}

// ---------------------------------------------------------------- 自然语言速记实时预览胶囊

function renderNlpPreview() {
  const box = el["kal-nlp-preview"];
  const input = el["kal-agenda-input"];
  if (!box || !input) return;
  const raw = input.value.trim();
  if (!raw) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  const baseKey = state.selected || toKey(new Date());
  const parsed = parseNaturalEntry(raw, baseKey);
  if (!parsed.hasNlpHint || !parsed.cleanTitle) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }

  box.replaceChildren();
  box.hidden = false;

  if (parsed.dateLabel || parsed.date !== baseKey || parsed.endDate) {
    const pill = document.createElement("span");
    pill.className = "kal-nlp-pill";
    pill.textContent = `${parsed.dateLabel || parsed.date}`;
    box.appendChild(pill);
  }
  if (parsed.time) {
    const pill = document.createElement("span");
    pill.className = "kal-nlp-pill";
    pill.textContent = `${parsed.time}`;
    box.appendChild(pill);
  }
  if (parsed.priority) {
    const pill = document.createElement("span");
    pill.className = "kal-nlp-pill" + (parsed.priority === "high" ? " is-prio-high" : "");
    const labelMap = { high: "高优先级", medium: "中优先级", low: "低优先级" };
    pill.textContent = labelMap[parsed.priority] || parsed.priority;
    box.appendChild(pill);
  }
  for (const tag of parsed.tags) {
    const pill = document.createElement("span");
    pill.className = "kal-nlp-pill";
    pill.textContent = `#${tag}`;
    box.appendChild(pill);
  }
}

// ---------------------------------------------------------------- 单日单元格背景染色 (Cell Highlight Color)

function renderCellColorBar(dateKey) {
  const bar = el["kal-cell-color-bar"];
  if (!bar) return;
  bar.replaceChildren();
  const label = document.createElement("span");
  label.className = "kal-cell-color-label";
  label.textContent = "底色标记";
  bar.appendChild(label);

  const curColor = (dateKey && state.cellColors?.[dateKey]) || "";
  for (const preset of CELL_HIGHLIGHT_PALETTE) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "kal-color-swatch-btn" + (curColor === preset.id ? " is-active" : "");
    btn.dataset.colorId = preset.id;
    btn.title = preset.label;
    btn.setAttribute("aria-label", `标记当日底色：${preset.label}`);
    btn.style.background = preset.id ? preset.dot : "transparent";
    btn.addEventListener("click", () => setCellBgColor(dateKey, preset.id));
    bar.appendChild(btn);
  }
}

async function setCellBgColor(dateKey, colorId) {
  if (!dateKey) return;
  const prevColor = state.cellColors?.[dateKey] || "";
  const nextColor = prevColor === colorId && colorId !== "" ? "" : colorId;
  const applyLocal = (cId) => {
    if (!state.cellColors || typeof state.cellColors !== "object") state.cellColors = {};
    if (cId) state.cellColors[dateKey] = cId;
    else delete state.cellColors[dateKey];
    const cellNode = el["kal-grid"]?.querySelector(`.kal-cell[data-key="${dateKey}"]`);
    if (cellNode) {
      if (cId) cellNode.dataset.bgcolor = cId;
      else delete cellNode.dataset.bgcolor;
    }
    if (state.selected === dateKey) renderCellColorBar(dateKey);
  };

  applyLocal(nextColor);
  try {
    await bridge.settingsSet({ cellColors: { ...state.cellColors } });
    pushUndoAction({
      label: `${dateKey} 底色标记`,
      undo: async () => {
        applyLocal(prevColor);
        await bridge.settingsSet({ cellColors: { ...state.cellColors } });
      },
      redo: async () => {
        applyLocal(nextColor);
        await bridge.settingsSet({ cellColors: { ...state.cellColors } });
      },
    });
  } catch (err) {
    setWriteStatus(sanitizeUserMessage(err?.message || String(err)), true);
  }
}

// ---------------------------------------------------------------- +N 更多浮层

function openDayMorePopover(dateKey, fullList) {
  const pop = el["kal-day-more-popover"];
  const titleEl = el["kal-day-more-title"];
  const listEl = el["kal-day-more-list"];
  if (!pop || !titleEl || !listEl) return;
  titleEl.textContent = `${dateKey} 全部事项（${fullList.length} 项）`;
  listEl.replaceChildren();
  for (const ev of fullList) {
    const li = document.createElement("li");
    if (ev.done) li.classList.add("is-done");
    li.textContent = `${ev.time ? ev.time + " " : ""}${ev.title}`;
    listEl.appendChild(li);
  }
  pop.hidden = false;
}

function closeDayMorePopover() {
  if (el["kal-day-more-popover"]) el["kal-day-more-popover"].hidden = true;
}

// ---------------------------------------------------------------- 跨日拖拽改期 & 一键顺延

async function moveItemBetweenDates(ev, toDateKey) {
  if (!ev || !toDateKey || ev.date === toDateKey) return;
  if (state.writeBusy || state.pendingConfirm || !state.writeStatus.available) return;
  const fromDateKey = ev.date;
  const expected = buildExpectedSnapshot(ev);

  const outcome = await writeAction(
    async () => {
      if (typeof bridge.itemMove === "function") {
        return await bridge.itemMove(ev.id, fromDateKey, toDateKey, expected);
      }
      await bridge.itemCreate(toDateKey, ev.title, ev.time || "");
      return await bridge.itemDelete(ev.id, fromDateKey, expected);
    },
    {
      onConfirmed: () => {
        pushUndoAction({
          label: `将“${ev.title}”移至 ${toDateKey}`,
          undo: async () => {
            const movedItems = await bridge.dayEvents(toDateKey);
            const target = movedItems.find(x => x.title === ev.title && (x.time || "") === (ev.time || ""));
            if (target && typeof bridge.itemMove === "function") {
              await bridge.itemMove(target.id, toDateKey, fromDateKey, buildExpectedSnapshot(target));
            }
          },
          redo: async () => {
            const origItems = await bridge.dayEvents(fromDateKey);
            const target = origItems.find(x => x.title === ev.title && (x.time || "") === (ev.time || ""));
            if (target && typeof bridge.itemMove === "function") {
              await bridge.itemMove(target.id, fromDateKey, toDateKey, buildExpectedSnapshot(target));
            }
          },
        });
      },
    },
  );
  if (outcome === "saved") {
    setWriteStatus(`已将“${ev.title}”改期至 ${toDateKey}（可按 Ctrl+Z 撤销）`, false);
    panel?.addLog?.("schedule", `改期「${ev.title}」(${fromDateKey} → ${toDateKey})`);
  }
}

async function rolloverSelectedDayTodos(deltaDays = 1) {
  const key = state.selected || toKey(new Date());
  const todos = (state.currentAgendaList || []).filter(ev => !ev.done && ev.kind !== "note" && ev.canEdit !== false);
  if (!todos.length) {
    setWriteStatus("当日没有未完成的可顺延事项", false);
    return;
  }
  const targetDate = addDaysToKey(key, deltaDays);
  for (const ev of todos) {
    await moveItemBetweenDates(ev, targetDate);
  }
  setWriteStatus(`已将 ${todos.length} 项未完成事项顺延至 ${targetDate}`, false);
}

let dragSession = null;
function bindTaskDragHandle(taskNode, ev) {
  if (!ev || ev.kind === "note" || ev.canEdit === false) return;
  taskNode.dataset.itemId = ev.id;
  taskNode.dataset.itemDate = ev.date;

  taskNode.addEventListener("pointerdown", e => {
    if (e.button !== 0 || state.writeBusy || state.pendingConfirm || !state.writeStatus.available) return;
    dragSession = {
      ev,
      taskNode,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      hoverCell: null,
    };
  });
}

window.addEventListener("pointermove", e => {
  if (!dragSession) return;
  const dx = e.clientX - dragSession.startX;
  const dy = e.clientY - dragSession.startY;
  if (!dragSession.active && Math.hypot(dx, dy) > 6) {
    dragSession.active = true;
    dragSession.taskNode.classList.add("is-dragging");
  }
  if (!dragSession.active) return;
  const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".kal-cell[data-key]");
  if (dragSession.hoverCell && dragSession.hoverCell !== hit) {
    dragSession.hoverCell.classList.remove("is-drop-target");
  }
  dragSession.hoverCell = hit || null;
  if (hit && hit.dataset.key !== dragSession.ev.date) {
    hit.classList.add("is-drop-target");
  }
});

window.addEventListener("pointerup", () => {
  if (!dragSession) return;
  const session = dragSession;
  dragSession = null;
  session.taskNode.classList.remove("is-dragging");
  if (session.hoverCell) {
    session.hoverCell.classList.remove("is-drop-target");
  }
  if (session.active && session.hoverCell) {
    const targetKey = session.hoverCell.dataset.key;
    if (targetKey && targetKey !== session.ev.date) {
      moveItemBetweenDates(session.ev, targetKey);
    }
  }
});

// ---------------------------------------------------------------- 渲染

function renderHeader() {
  el["kal-month-label"].textContent = `${state.month + 1} 月`;
  el["kal-year-label"].textContent = String(state.year);
  if (el["kal-lunar-year"]) {
    el["kal-lunar-year"].textContent = getGanZhiYear(state.year);
  }
  if (el["kal-week-badge"]) {
    const refDate = state.selected ? fromKey(state.selected) : new Date(state.year, state.month, 1);
    const wk = getWeekOfYear(refDate, state.weekStart);
    el["kal-week-badge"].textContent = `第 ${wk} 周`;
  }
  if (state.ymOpen) renderYmPopover();
}

function renderWeekHead() {
  const head = el["kal-weekhead"];
  head.innerHTML = "";
  weekHeadLabels(state.weekStart).forEach((text, i) => {
    const d = document.createElement("div");
    d.textContent = text;
    const dow = (state.weekStart + i) % 7;
    if (dow === 0 || dow === 6) d.classList.add("is-weekend");
    head.appendChild(d);
  });
}

function syncCurrentWeekCells() {
  const grid = el["kal-grid"];
  if (!grid) return;
  const cellNodes = Array.from(grid.querySelectorAll(".kal-cell"));
  if (!cellNodes.length) return;
  const selIdx = Math.max(0, cellNodes.findIndex(node => node.dataset.key === state.selected));
  const selRow = Math.floor(selIdx / 7);
  cellNodes.forEach((node, idx) => {
    node.classList.toggle("is-current-week", Math.floor(idx / 7) === selRow);
  });
}

function renderGrid(cells, byDay) {
  state.lastByDay = byDay;
  const grid = el["kal-grid"];
  grid.innerHTML = "";
  const frag = document.createDocumentFragment();
  const selIdx = Math.max(0, cells.findIndex(c => c.key === state.selected));
  const selRow = Math.floor(selIdx / 7);
  const taskLimit = state.viewMode === "week" ? Math.max(state.maxTasks, 8) : state.maxTasks;

  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const cell = document.createElement("div");
    cell.className = "kal-cell";
    cell.dataset.key = c.key;
    const bgColor = state.cellColors?.[c.key];
    if (bgColor) cell.dataset.bgcolor = bgColor;
    if (!c.inMonth) cell.classList.add("is-other-month");
    if (c.isWeekend) cell.classList.add("is-weekend");
    if (c.isToday) cell.classList.add("is-today");
    if (state.selected === c.key) cell.classList.add("is-selected");
    if (Math.floor(i / 7) === selRow) cell.classList.add("is-current-week");

    const head = document.createElement("div");
    head.className = "kal-cell-head";
    const num = document.createElement("span");
    num.className = "kal-daynum";
    num.textContent = String(c.day);
    head.appendChild(num);

    const cy = c.date.getFullYear(), cm = c.date.getMonth() + 1, cd = c.day;
    const lunarInfo = getLunarDay(cy, cm, cd);
    if (lunarInfo?.holidayType === "rest") cell.classList.add("is-rest-day");
    if (lunarInfo?.holidayType === "work") cell.classList.add("is-work-makeup");

    const headRight = document.createElement("div");
    headRight.className = "kal-cell-head-right";
    if (lunarInfo?.holidayBadge) {
      const hBadge = document.createElement("span");
      hBadge.className = `kal-cell-badge is-${lunarInfo.holidayType}`;
      hBadge.textContent = lunarInfo.holidayBadge;
      hBadge.title = lunarInfo.holidayName;
      headRight.appendChild(hBadge);
    }
    if (lunarInfo && lunarInfo.text) {
      if (lunarInfo.festival) cell.classList.add("is-holiday");
      const sub = document.createElement("span");
      const subMod = lunarInfo.festival
        ? " is-festival"
        : (lunarInfo.isHighlight ? " is-term" : "");
      sub.className = "kal-sub" + subMod;
      sub.textContent = lunarInfo.text;
      sub.title = lunarInfo.fullTitle;
      headRight.appendChild(sub);
    }
    const addCellBtn = document.createElement("button");
    addCellBtn.type = "button";
    addCellBtn.className = "kal-cell-add-btn";
    addCellBtn.textContent = "+";
    addCellBtn.title = `在 ${c.key} 直接添加安排（双击日格也可直接输入）`;
    addCellBtn.setAttribute("aria-label", `在 ${c.key} 直接添加安排`);
    addCellBtn.addEventListener("click", e => {
      e.stopPropagation();
      selectDay(c.key);
      openCellInlineEditor(cell, c.key);
    });
    headRight.appendChild(addCellBtn);
    head.appendChild(headRight);
    cell.appendChild(head);

    const rawList = byDay.get(c.key) || [];
    const list = formatTaskListForDisplay(rawList);
    if (list.length >= 2) {
      cell.classList.add("is-multi-tasks");
    }
    if (list.length >= 3) {
      cell.classList.add("is-crowded");
    }
    if (list.length) {
      const cellLimit = state.viewMode === "week"
        ? taskLimit
        : (list.length > 3 ? Math.min(taskLimit, 3) : taskLimit);
      const tasks = document.createElement("div");
      tasks.className = "kal-tasks";
      list.slice(0, cellLimit).forEach((ev, idx) => {
        const dec = parseTaskDecorations(ev.title);
        const cleanText = (dec.isMultiDay || dec.priority || dec.tags.length)
          ? (dec.cleanTitle || ev.title)
          : ev.title;
        const t = document.createElement("div");
        t.className = "kal-task"
          + (ev.done ? " is-done" : "")
          + (dec.isMultiDay ? " is-multiday" : "")
          + (dec.priority === "high" ? " is-prio-high" : "");
        t.dataset.idx = `${idx + 1}.`;
        t.textContent = cleanText;
        t.title = `${ev.time || ""} ${cleanText}（双击可直接修改，拖拽可改期）`.trim();
        bindTaskDragHandle(t, ev);
        t.addEventListener("dblclick", e => {
          e.stopPropagation();
          selectDay(c.key);
          openCellInlineTaskEdit(t, ev);
        });
        tasks.appendChild(t);
      });
      cell.appendChild(tasks);
      if (list.length > cellLimit) {
        const more = document.createElement("div");
        more.className = "kal-task-more";
        more.textContent = `+${list.length - cellLimit} 更多`;
        more.title = `点击查看当日全部 ${list.length} 项安排`;
        more.addEventListener("click", e => {
          e.stopPropagation();
          selectDay(c.key);
          openDayMorePopover(c.key, list);
        });
        cell.appendChild(more);
      }
    }

    if (rawList.length > 3) {
      const badge = document.createElement("span");
      badge.className = "kal-cell-count";
      badge.textContent = String(rawList.length);
      cell.appendChild(badge);
    }

    cell.addEventListener("click", () => selectDay(c.key));
    cell.addEventListener("dblclick", e => {
      if (e.target.closest(".kal-cell-inline-editor, .kal-cell-inline-input, .kal-task-more")) return;
      selectDay(c.key);
      openCellInlineEditor(cell, c.key);
    });
    frag.appendChild(cell);
  }
  grid.appendChild(frag);
}

function relativeDayLabel(dateObj) {
  const now = new Date();
  const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const targetUtc = Date.UTC(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate());
  const diff = Math.round((targetUtc - todayUtc) / 86400000);
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  if (diff === 2) return "后天";
  if (diff === -1) return "昨天";
  if (diff === -2) return "前天";
  return diff > 0 ? `${diff} 天后` : `${Math.abs(diff)} 天前`;
}

function renderAgendaSub(dateObj, list) {
  const subEl = el["kal-agenda-sub"];
  if (!subEl) return;
  subEl.replaceChildren();
  const row = document.createElement("div");
  row.className = "kal-agenda-sub-row";

  const rel = document.createElement("span");
  rel.className = "kal-rel-badge";
  rel.textContent = relativeDayLabel(dateObj);
  row.appendChild(rel);

  const wkSpan = document.createElement("span");
  wkSpan.className = "kal-agenda-week-pill";
  wkSpan.textContent = `第 ${getWeekOfYear(dateObj, state.weekStart)} 周`;
  row.appendChild(wkSpan);

  const cy = dateObj.getFullYear(), cm = dateObj.getMonth() + 1, cd = dateObj.getDate();
  const lunar = getLunarDay(cy, cm, cd);
  if (lunar?.fullTitle) {
    const lunarSpan = document.createElement("span");
    lunarSpan.textContent = lunar.fullTitle;
    row.appendChild(lunarSpan);
  }
  subEl.appendChild(row);

  // 传统黄历干支、纳音、冲煞、吉神方位与每日宜忌胶囊（由 layout.showYiJi 控制显隐）
  const almanac = getAlmanac(cy, cm, cd);
  if (almanac) {
    const yijiBox = document.createElement("div");
    yijiBox.className = "kal-yiji-box";

    const gzLine = document.createElement("div");
    gzLine.className = "kal-yiji-ganzhi";
    gzLine.textContent = almanac.ganZhiText;
    yijiBox.appendChild(gzLine);

    if (almanac.detailText) {
      const detailLine = document.createElement("div");
      detailLine.className = "kal-yiji-detail";
      detailLine.textContent = almanac.detailText;
      yijiBox.appendChild(detailLine);
    }

    const pills = document.createElement("div");
    pills.className = "kal-yiji-pills";

    const yiPill = document.createElement("span");
    yiPill.className = "kal-yiji-pill is-yi";
    yiPill.innerHTML = `<b class="kal-yiji-tag">宜</b><span>${almanac.yi.slice(0, 4).join(" · ")}</span>`;
    yiPill.title = `今日宜：${almanac.yi.join("、")}`;

    const jiPill = document.createElement("span");
    jiPill.className = "kal-yiji-pill is-ji";
    jiPill.innerHTML = `<b class="kal-yiji-tag">忌</b><span>${almanac.ji.slice(0, 3).join(" · ")}</span>`;
    jiPill.title = `今日忌：${almanac.ji.join("、")}`;

    pills.append(yiPill, jiPill);
    yijiBox.appendChild(pills);
    subEl.appendChild(yijiBox);
  }

  if (list && list.length > 0) {
    const doneCount = list.filter(x => x.done).length;
    const pct = Math.round((doneCount / list.length) * 100);
    const bar = document.createElement("div");
    bar.className = "kal-agenda-progress";
    bar.title = `完成进度：${doneCount} / ${list.length} (${pct}%)`;
    const fill = document.createElement("div");
    fill.className = "kal-agenda-progress-fill";
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    subEl.appendChild(bar);
  }
}

async function renderAgenda(key, byDay, seqToken = agendaGuard.next()) {
  if (!agendaGuard.isCurrent(seqToken)) return;
  const dateObj = fromKey(key);
  el["kal-agenda-date"].textContent = formatAgendaDate(dateObj);
  renderCellColorBar(key);
  let list = byDay?.get(key);
  if (list === undefined) {
    try {
      list = await bridge.dayEvents(key);
      if (!agendaGuard.isCurrent(seqToken)) return;
    } catch (err) {
      if (!agendaGuard.isCurrent(seqToken)) return;
      state.readError = sanitizeUserMessage(err?.message || String(err), "无法读取当天日程数据");
      syncWriteUi();
      list = [];
    }
  }
  if (!agendaGuard.isCurrent(seqToken)) return;

  state.currentAgendaList = list;
  const doneCount = list.filter(x => x.done).length;
  el["kal-agenda-count"].textContent = list.length
    ? (doneCount > 0 ? `${doneCount}/${list.length} 项` : `${list.length} 项`)
    : "";
  renderAgendaSub(dateObj, list);

  const visibleList = formatTaskListForDisplay(list);
  const ul = el["kal-agenda-list"];
  ul.innerHTML = "";
  if (!visibleList.length) {
    const li = document.createElement("li");
    li.className = "is-empty";
    li.textContent = state.readError
      ? "暂时无法读取日历数据，您仍可浏览日期或打开右上角设置"
      : (list.length > 0 ? "当天事项已全部完成（已开启隐藏已完成任务）" : "这天没有安排");
    if (!state.readError && state.writeStatus.available) {
      li.title = "点击或双击直接在右侧添加安排";
      li.addEventListener("dblclick", () => openAgendaInlineEditor());
    }
    ul.appendChild(li);
    return;
  }
  const writeAllowed = state.writeStatus.available && !state.pendingConfirm;
  for (let i = 0; i < visibleList.length; i++) {
    const ev = visibleList[i];
    const caps = getItemCapabilities(ev, { available: writeAllowed });
    const li = document.createElement("li");
    li.dataset.idx = `${i + 1}.`;
    if (ev.done) li.classList.add("is-done");
    const dot = document.createElement(caps.canComplete ? "button" : "span");
    dot.className = "kal-agenda-dot";
    if (caps.canComplete) {
      dot.classList.add("is-toggleable");
      dot.type = "button";
      dot.setAttribute("aria-pressed", String(Boolean(ev.done)));
      dot.setAttribute("aria-label", `${ev.done ? "标记未完成" : "标记完成"}：${ev.title}`);
      dot.title = ev.done ? "标记未完成" : "标记完成";
      const expected = buildExpectedSnapshot(ev);
      const toggle = async () => writeAction(
        () => bridge.itemToggleDone(ev.id, ev.date, !ev.done, expected),
        {
          onConfirmed: () => {
            panel?.addLog?.("schedule", `${!ev.done ? "完成" : "取消完成"}安排「${ev.title}」(${ev.date})`);
          },
        },
      );
      dot.addEventListener("click", e => { e.stopPropagation(); toggle(); });
    } else {
      dot.classList.add("is-readonly");
      dot.title = ev.kind === "note"
        ? "便签（只读）"
        : (!state.writeStatus.available ? "当前为只读模式" : "该项暂不支持完成状态");
    }
    li.appendChild(dot);
    if (ev.time) {
      const time = document.createElement("span");
      time.className = "kal-agenda-time";
      time.textContent = ev.time;
      li.appendChild(time);
    }
    const dec = parseTaskDecorations(ev.title);
    const cleanAgendaTitle = (dec.isMultiDay || dec.priority || dec.tags.length)
      ? (dec.cleanTitle || ev.title)
      : ev.title;
    const txt = document.createElement("span");
    txt.className = "kal-agenda-text";
    txt.textContent = cleanAgendaTitle;
    if (caps.canEdit) {
      txt.title = "双击或聚焦后按 Enter / F2 编辑";
      txt.tabIndex = 0;
      txt.setAttribute("role", "button");
      txt.setAttribute("aria-label", `编辑：${ev.title}`);
      txt.addEventListener("keydown", e => {
        if (isImeComposing(e)) return;
        if (e.key === "Enter" || e.key === "F2") { e.preventDefault(); e.stopPropagation(); beginAgendaEdit(li, txt, ev); }
      });
      txt.addEventListener("dblclick", () => beginAgendaEdit(li, txt, ev));
    }
    li.appendChild(txt);
    if (caps.canEdit && !ev.done) {
      const postpone = document.createElement("button");
      postpone.type = "button";
      postpone.className = "kal-agenda-postpone";
      postpone.textContent = "+1天";
      postpone.title = "顺延至明天（Shift+点击顺延下周）";
      postpone.setAttribute("aria-label", `顺延：${ev.title}`);
      postpone.addEventListener("click", e => {
        e.stopPropagation();
        const delta = e.shiftKey ? 7 : 1;
        moveItemBetweenDates(ev, addDaysToKey(ev.date, delta));
      });
      li.appendChild(postpone);
    }
    if (caps.canDelete) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "kal-agenda-action";
      del.textContent = "×";
      del.title = "删除";
      del.setAttribute("aria-label", `删除：${ev.title}`);
      del.addEventListener("click", e => {
        e.stopPropagation();
        beginInlineDelete(li, del, ev);
      });
      li.appendChild(del);
    }
    ul.appendChild(li);
    if (editDrafts.has(`${ev.date}:${ev.id}`)) beginAgendaEdit(li, txt, ev, false);
  }
}

function setWriteStatus(message, error = false) {
  state.transientStatus = message ? sanitizeUserMessage(message, message) : "";
  state.transientError = Boolean(error);
  renderWriteStatusBar();
}

function renderWriteStatusBar() {
  if (!el["kal-write-status"]) return;
  let msg = state.transientStatus;
  let isErr = state.transientError;
  if (!msg) {
    if (state.readError) {
      msg = state.readError;
      isErr = true;
    } else if (!state.writeStatus.available && state.writeStatus.hint) {
      msg = state.writeStatus.hint;
      isErr = true;
    }
  }
  el["kal-write-status"].textContent = msg || "";
  el["kal-write-status"].classList.toggle("is-error", Boolean(isErr));
}

function renderPendingBox() {
  const box = el["kal-pending-box"];
  if (!box) return;
  box.innerHTML = "";
  if (!state.pendingConfirm) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const summary = document.createElement("div");
  summary.className = "kal-pending-summary";
  summary.textContent = state.pendingConfirm.summary || "该修改需要再次确认后才会生效";
  box.appendChild(summary);

  const actions = document.createElement("div");
  actions.className = "kal-pending-actions";

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "kal-btn kal-pending-btn is-confirm";
  confirmBtn.textContent = "确认保存";
  confirmBtn.disabled = state.writeBusy;
  confirmBtn.addEventListener("click", () => resolvePendingConfirm(true));

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "kal-btn kal-btn-ghost kal-pending-btn";
  cancelBtn.textContent = "取消";
  cancelBtn.disabled = state.writeBusy;
  cancelBtn.addEventListener("click", () => resolvePendingConfirm(false));

  box.addEventListener("keydown", e => {
    if (isImeComposing(e)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      resolvePendingConfirm(false);
    }
  });

  actions.appendChild(confirmBtn);
  actions.appendChild(cancelBtn);
  box.appendChild(actions);
}

function syncWriteUi() {
  const input = el["kal-agenda-input"];
  const addBtn = el["kal-agenda-add"]?.querySelector("button[type='submit']");
  const blocked = !state.writeStatus.available || state.writeBusy || Boolean(state.pendingConfirm);
  if (input) {
    input.disabled = blocked;
    if (state.pendingConfirm) {
      input.placeholder = "请先确认或取消下方待定修改…";
    } else if (!state.writeStatus.available) {
      input.placeholder = "当前仅可浏览与搜索";
    } else if (!state.writeStatus.canCreateEvent && state.writeStatus.canCreate) {
      input.placeholder = "添加安排…（当前仅支持无时间任务）";
    } else {
      input.placeholder = "添加安排（默认不设时间）";
    }
  }
  if (addBtn) addBtn.disabled = blocked;
  if (el["kal-time-toggle-btn"]) el["kal-time-toggle-btn"].disabled = blocked;
  if (el["kal-agenda-time-input"]) el["kal-agenda-time-input"].disabled = blocked;
  if (el["kal-agenda-date-input"]) el["kal-agenda-date-input"].disabled = blocked;
  if (el["kal-agenda-prio-btn"]) el["kal-agenda-prio-btn"].disabled = blocked;
  if (el["kal-agenda-inline-trigger"]) el["kal-agenda-inline-trigger"].disabled = blocked;
  renderPendingBox();
  renderWriteStatusBar();
}

async function refreshWriteStatus() {
  if (!bridge?.writeStatus) return;
  try {
    const raw = await bridge.writeStatus();
    state.writeStatus = normalizeWriteStatus(raw);
  } catch (err) {
    state.writeStatus = normalizeWriteStatus({
      available: false,
      canCreate: false,
      canCreateEvent: false,
      label: err?.message || String(err),
    });
  }
  syncWriteUi();
}

async function resolvePendingConfirm(accept) {
  const pending = state.pendingConfirm;
  if (!pending || state.writeBusy) return;
  state.writeBusy = true;
  syncWriteUi();
  let res;
  try {
    res = await bridge.itemConfirm(pending.pendingId, Boolean(accept));
  } catch (err) {
    state.writeBusy = false;
    state.pendingConfirm = null;
    pending.onCancelled?.();
    setWriteStatus(sanitizeUserMessage(err?.message || String(err)), true);
    syncWriteUi();
    return;
  }
  state.writeBusy = false;
  state.pendingConfirm = null;
  const interpreted = interpretWriteResult(res);
  if (interpreted.invalid) {
    setWriteStatus(interpreted.message, true);
    pending.onCancelled?.();
    syncWriteUi();
    return;
  }
  if (!accept || interpreted.outcome === "cancelled") {
    setWriteStatus("已取消修改", false);
    pending.onCancelled?.();
    syncWriteUi();
    await render();
    return;
  }
  invalidateReads();
  setWriteStatus("已保存", false);
  pending.onConfirmed?.();
  syncWriteUi();
  try {
    await render();
    if (state.readError) setWriteStatus("已保存（视图读取失败，可点右上角刷新）", false);
    if (state.searchOpen) await runSearch(el["kal-search-input"]?.value || "");
  } catch {
    setWriteStatus("已保存（视图刷新未完成，可点右上角刷新）", false);
  }
}

async function writeAction(action, { onConfirmed, onCancelled } = {}) {
  if (state.pendingConfirm) {
    setWriteStatus("请先确认或取消当前待定的修改", true);
    return "blocked";
  }
  if (state.writeBusy) {
    return "blocked";
  }
  if (!state.writeStatus.available) {
    setWriteStatus(state.writeStatus.hint || "当前不可保存修改", true);
    return "blocked";
  }
  state.writeBusy = true;
  syncWriteUi();
  let rawResult;
  try {
    rawResult = await action();
  } catch (err) {
    state.writeBusy = false;
    const message = sanitizeUserMessage(err?.message || String(err));
    setWriteStatus(message, true);
    syncWriteUi();
    console.warn("[kal] 日程写入失败:", err);
    return "error";
  }
  state.writeBusy = false;
  const interpreted = interpretWriteResult(rawResult);
  if (interpreted.invalid) {
    setWriteStatus(interpreted.message, true);
    onCancelled?.();
    syncWriteUi();
    return "error";
  }
  if (interpreted.outcome === "pending_confirmation") {
    state.pendingConfirm = {
      pendingId: interpreted.pendingId,
      summary: interpreted.message,
      onConfirmed,
      onCancelled,
    };
    setWriteStatus("请确认是否保存该修改", false);
    syncWriteUi();
    return "pending";
  }
  if (interpreted.outcome === "cancelled") {
    setWriteStatus(interpreted.message, false);
    onCancelled?.();
    syncWriteUi();
    return "cancelled";
  }

  invalidateReads();
  setWriteStatus("已保存", false);
  onConfirmed?.();
  syncWriteUi();
  try {
    await render();
    if (state.readError) setWriteStatus("已保存（视图读取失败，可点右上角刷新）", false);
    if (state.searchOpen) await runSearch(el["kal-search-input"]?.value || "");
  } catch (refreshErr) {
    console.warn("[kal] 写入成功但刷新失败:", refreshErr);
    setWriteStatus("已保存（视图刷新未完成，可点右上角刷新）", false);
  }
  return "saved";
}

function beginAgendaEdit(li, textEl, ev, focus = true) {
  if (li.querySelector(".kal-agenda-edit")) return;
  const key = `${ev.date}:${ev.id}`;
  const draft = editDrafts.get(key, ev.title, { expected: buildExpectedSnapshot(ev), submitting: false });
  const input = document.createElement("input");
  input.className = "kal-agenda-edit";
  input.value = draft.text;
  input.disabled = draft.submitting;
  input.setAttribute("aria-label", `编辑 ${ev.date} 日程，Enter 保存，Esc 取消`);
  bindImeGuard(input);
  textEl.replaceWith(input);
  const actions = document.createElement("span");
  actions.className = "kal-agenda-edit-actions";
  const save = document.createElement("button");
  save.type = "button"; save.className = "kal-agenda-confirm-btn"; save.textContent = "保存";
  const cancel = document.createElement("button");
  cancel.type = "button"; cancel.className = "kal-agenda-confirm-btn"; cancel.textContent = "取消";
  actions.append(save, cancel); li.append(actions);
  if (focus) { input.focus(); input.select(); }
  const remember = () => {
    if (editDrafts.has(key) && editDrafts.get(key) === draft && !draft.submitting) editDrafts.update(key, input.value);
  };
  input.addEventListener("input", remember);
  const restore = () => { if (input.isConnected) input.replaceWith(textEl); actions.remove(); };
  const cancelEdit = () => {
    if (draft.submitting || isImeComposing(null, input)) return;
    editDrafts.cancel(key); restore();
  };
  const commitEdit = async () => {
    if (draft.submitting || isImeComposing(null, input)) return;
    remember();
    const raw = draft.text, value = raw.trim();
    try { validateCrudInput({ date: ev.date, title: raw, checkTitle: true }); }
    catch (err) { input.setAttribute("aria-invalid", "true"); setWriteStatus(err.message, true); return; }
    input.removeAttribute("aria-invalid");
    if (value === ev.title) { editDrafts.cancel(key); restore(); return; }
    const snapshot = editDrafts.snapshot(key);
    draft.submitting = true;
    input.disabled = save.disabled = cancel.disabled = true;
    const release = () => {
      draft.submitting = false;
      input.disabled = save.disabled = cancel.disabled = false;
      const current = el["kal-agenda-list"].querySelector(`[data-edit-session="${draft.session}"]`);
      if (current) { current.disabled = false; current.parentElement.querySelectorAll(".kal-agenda-edit-actions button").forEach(b => b.disabled = false); }
    };
    input.dataset.editSession = draft.session;
    const outcome = await writeAction(() => bridge.itemUpdate(ev.id, ev.date, value, snapshot.expected), {
      onConfirmed: () => {
        editDrafts.acknowledge(snapshot);
        panel?.addLog?.("schedule", `编辑安排「${ev.title}」→「${value}」(${ev.date})`);
      },
      onCancelled: release,
    });
    if (outcome !== "saved" && outcome !== "pending") release();
  };
  input.dataset.editSession = draft.session;
  save.disabled = cancel.disabled = draft.submitting;
  save.addEventListener("click", commitEdit);
  cancel.addEventListener("click", cancelEdit);
  input.addEventListener("keydown", e => {
    if (isImeComposing(e)) return;
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Enter") commitEdit(); else cancelEdit();
    }
  });
  input.addEventListener("blur", remember);
}

/** 内联确认删除（替代 window.confirm，完整支持键盘 Enter/Space/Esc/方向键） */
function beginInlineDelete(li, delBtn, ev) {
  if (li.querySelector(".kal-agenda-confirm")) return;
  const wrap = document.createElement("span");
  wrap.className = "kal-agenda-confirm";
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", `确认删除 ${ev.title}`);

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "kal-agenda-confirm-btn is-danger";
  confirmBtn.textContent = "确认删除";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "kal-agenda-confirm-btn";
  cancelBtn.textContent = "取消";

  const restore = () => {
    if (wrap.parentNode) wrap.replaceWith(delBtn);
    delBtn.focus();
  };

  const executeDelete = async () => {
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    const expected = buildExpectedSnapshot(ev);
    const outcome = await writeAction(
      () => bridge.itemDelete(ev.id, ev.date, expected),
      {
        onConfirmed: () => {
          panel?.addLog?.("schedule", `删除安排「${ev.title}」(${ev.date})`);
        },
        onCancelled: () => restore(),
      },
    );
    if (outcome !== "saved" && outcome !== "pending") {
      confirmBtn.disabled = false;
      cancelBtn.disabled = false;
      confirmBtn.focus();
    }
  };

  confirmBtn.addEventListener("click", e => {
    e.stopPropagation();
    executeDelete();
  });
  cancelBtn.addEventListener("click", e => {
    e.stopPropagation();
    restore();
  });
  wrap.addEventListener("keydown", e => {
    if (isImeComposing(e)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      restore();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      if (document.activeElement === confirmBtn) cancelBtn.focus();
      else confirmBtn.focus();
    }
  });

  wrap.appendChild(confirmBtn);
  wrap.appendChild(cancelBtn);
  delBtn.replaceWith(wrap);
  confirmBtn.focus();
}

async function render() {
  const seq = renderGuard.next();
  const agendaSeq = agendaGuard.next();
  renderHeader();
  renderWeekHead();
  if (!state.selected) state.selected = pickDefaultSelected(state.year, state.month);
  syncQuickDraft();

  let cells = getMonthMatrix(state.year, state.month, state.weekStart);
  let byDay = new Map();
  try {
    const res = await matrixMapForView(state.year, state.month, state.weekStart);
    if (!renderGuard.isCurrent(seq)) return;
    cells = res.cells;
    byDay = res.byDay;
    state.readError = res.partialError
      ? sanitizeUserMessage(res.partialError?.message || String(res.partialError), "部分月份数据读取异常")
      : "";
  } catch (err) {
    if (!renderGuard.isCurrent(seq)) return;
    state.readError = sanitizeUserMessage(err?.message || String(err), "无法读取日历数据");
  }
  renderWriteStatusBar();
  renderGrid(cells, byDay);
  await renderAgenda(state.selected, byDay.has(state.selected) ? byDay : undefined, agendaSeq);
}

// ---------------------------------------------------------------- 搜索

function openSearch() {
  if (!el["kal-search-popover"]) return;
  if (!state.searchOpen) {
    const active = document.activeElement;
    searchReturnFocus = { element: active, start: active?.selectionStart, end: active?.selectionEnd };
    rememberQuickDraft();
  }
  state.searchOpen = true;
  el["kal-search-popover"].hidden = false;
  el["kal-search-btn"]?.setAttribute("aria-expanded", "true");
  const input = el["kal-search-input"];
  if (input) {
    input.focus();
    input.select();
    runSearch(input.value);
  }
}

function closeSearch(returnFocus = true) {
  if (!el["kal-search-popover"] || !state.searchOpen) return;
  state.searchOpen = false;
  cancelSearch();
  clearSearchResults();
  el["kal-search-popover"].hidden = true;
  el["kal-search-btn"]?.setAttribute("aria-expanded", "false");
  if (returnFocus) {
    const previous = searchReturnFocus;
    const target = previous?.element?.isConnected ? previous.element : el["kal-search-btn"];
    target?.focus();
    if (previous?.start != null && target?.setSelectionRange) target.setSelectionRange(previous.start, previous.end);
  }
  searchReturnFocus = null;
}

function toggleSearch() {
  if (state.searchOpen) closeSearch(true);
  else openSearch();
}

function jumpToSearchResult(item) {
  if (!item?.date) return;
  closeSearch(false);
  selectDay(item.date);
}

function updateSearchActiveItem() {
  const ul = el["kal-search-list"];
  if (!ul) return;
  const children = Array.from(ul.children);
  children.forEach((li, idx) => {
    const active = idx === state.searchActiveIdx;
    li.classList.toggle("is-active", active);
    li.setAttribute("aria-selected", active ? "true" : "false");
    if (active && typeof li.scrollIntoView === "function") {
      li.scrollIntoView({ block: "nearest" });
    }
  });
}

function clearSearchResults() {
  state.searchRawResults = [];
  state.searchItems = [];
  state.searchActiveIdx = -1;
  if (el["kal-search-list"]) el["kal-search-list"].replaceChildren();
}
function cancelSearch() {
  searchGuard.next();
  searchScheduler.cancel();
}
function renderFilteredSearchResults() {
  const q = state.searchLastQuery;
  let filtered = state.searchRawResults;
  if (state.searchFilter === "todo") {
    filtered = filtered.filter(item => !item.done);
  } else if (state.searchFilter === "done") {
    filtered = filtered.filter(item => Boolean(item.done));
  }
  const vm = buildSearchViewModel(filtered, q, SEARCH_LIMIT);
  state.searchItems = vm.items;
  state.searchActiveIdx = vm.items.length ? 0 : -1;
  if (el["kal-search-meta"]) {
    const filterSuffix = state.searchFilter === "todo"
      ? "（筛选：未完成）"
      : (state.searchFilter === "done" ? "（筛选：已完成）" : "");
    el["kal-search-meta"].textContent = vm.hint + filterSuffix;
    el["kal-search-meta"].classList.toggle("is-warn", vm.truncated);
  }
  const ul = el["kal-search-list"];
  if (!ul) return;
  ul.innerHTML = "";
  const frag = document.createDocumentFragment();
  vm.items.forEach((item, idx) => {
    const li = document.createElement("li");
    li.className = "kal-search-item" + (item.done ? " is-done" : "") + (idx === 0 ? " is-active" : "");
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", idx === 0 ? "true" : "false");
    li.tabIndex = -1;

    const dSpan = document.createElement("span");
    dSpan.className = "kal-search-item-date";
    dSpan.textContent = item.date;
    li.appendChild(dSpan);

    if (item.time) {
      const tSpan = document.createElement("span");
      tSpan.className = "kal-search-item-time";
      tSpan.textContent = item.time;
      li.appendChild(tSpan);
    }

    const titleSpan = document.createElement("span");
    titleSpan.className = "kal-search-item-title";
    titleSpan.textContent = item.title;
    titleSpan.title = `${item.date} ${item.time || ""} ${item.title}`.trim();
    li.appendChild(titleSpan);

    li.addEventListener("click", () => jumpToSearchResult(item));
    frag.appendChild(li);
  });
  ul.appendChild(frag);
}
function runSearch(rawQuery) {
  const seq = searchGuard.next();
  searchScheduler.cancel();
  clearSearchResults();
  const q = String(rawQuery ?? "").trim();
  state.searchLastQuery = q;
  const input = el["kal-search-input"];
  const composing = input && bindImeGuard(input).composing;
  if (!state.searchOpen || !q || composing) {
    if (el["kal-search-meta"]) {
      el["kal-search-meta"].textContent = buildSearchViewModel([], "").hint;
      el["kal-search-meta"].classList.remove("is-warn");
    }
    return Promise.resolve("cancelled");
  }
  if (el["kal-search-meta"]) {
    el["kal-search-meta"].textContent = "正在搜索…";
    el["kal-search-meta"].classList.remove("is-warn");
  }
  return searchScheduler.schedule(q, seq);
}
const searchScheduler = createSearchScheduler({
  search: query => bridge.searchEvents(query),
  onResult(rawResults, q, seq) {
    if (!state.searchOpen || !searchGuard.isCurrent(seq)) return;
    state.searchRawResults = Array.isArray(rawResults) ? rawResults : [];
    state.searchLastQuery = q;
    renderFilteredSearchResults();
  },
  onError(err, q, seq) {
    if (!state.searchOpen || !searchGuard.isCurrent(seq)) return;
    clearSearchResults();
    if (el["kal-search-meta"]) {
      el["kal-search-meta"].textContent = sanitizeUserMessage(err?.message || String(err), "搜索暂时不可用");
      el["kal-search-meta"].classList.add("is-warn");
    }
    if (el["kal-search-list"]) el["kal-search-list"].innerHTML = "";
  },
});

function selectDay(key) {
  const [year, month] = key.split("-").map(Number);
  const sameView = state.year === year && state.month === month - 1 && el["kal-grid"].children.length === 42;
  state.selected = key;
  const [y, m] = key.split("-").map(Number);
  state.year = y;
  state.month = m - 1;
  if (sameView) {
    syncQuickDraft();
    renderHeader();
    el["kal-grid"].querySelectorAll(".kal-cell").forEach(cell => cell.classList.toggle("is-selected", cell.dataset.key === key));
    syncCurrentWeekCells();
    renderAgenda(key);
  } else render();
}

function goto(delta) {
  if (state.viewMode === "week" && state.selected) {
    const dt = fromKey(state.selected);
    const nextDt = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + delta * 7);
    selectDay(toKey(nextDt));
    return;
  }
  const { year, month } = addMonths(state.year, state.month, delta);
  state.year = year;
  state.month = month;
  state.selected = null;
  render();
}

function toggleViewMode() {
  state.viewMode = state.viewMode === "week" ? "month" : "week";
  const isWeek = state.viewMode === "week";
  document.body.classList.toggle("kal-view-week", isWeek);
  const btn = el["kal-view-toggle"];
  if (btn) {
    btn.classList.toggle("is-active", isWeek);
    btn.setAttribute("aria-pressed", String(isWeek));
    btn.textContent = isWeek ? "月视图" : "周视图";
  }
  render();
}

// ---------------------------------------------------------------- 窗口位置锁定与鼠标穿透控制 (Phase 2)

async function toggleWindowLock(shiftKey = false) {
  const btn = el["kal-lock-btn"];
  if (shiftKey && bridge?.windowSetClickThrough) {
    try {
      const nextCt = !state.clickThrough;
      await bridge.windowSetClickThrough(nextCt);
      state.clickThrough = nextCt;
      if (btn) {
        btn.classList.toggle("is-active", state.windowLocked || state.clickThrough);
        const span = btn.querySelector("span");
        if (span) span.textContent = state.clickThrough ? "已穿透" : (state.windowLocked ? "已锁定" : "锁定");
      }
      setWriteStatus(
        nextCt
          ? "已开启鼠标穿透（可在系统托盘菜单或按 Win+Alt+C 恢复交互）"
          : "已恢复正常鼠标交互",
        false,
      );
    } catch (err) {
      setWriteStatus(sanitizeUserMessage(err?.message || String(err)), true);
    }
    return;
  }

  state.windowLocked = !state.windowLocked;
  document.body.classList.toggle("kal-window-locked", state.windowLocked);
  const headerEl = document.querySelector(".kal-header");
  const spacerEl = document.querySelector(".kal-spacer");
  if (state.windowLocked) {
    headerEl?.removeAttribute("data-tauri-drag-region");
    spacerEl?.removeAttribute("data-tauri-drag-region");
  } else {
    headerEl?.setAttribute("data-tauri-drag-region", "");
    spacerEl?.setAttribute("data-tauri-drag-region", "");
  }
  if (btn) {
    btn.classList.toggle("is-active", state.windowLocked || state.clickThrough);
    btn.setAttribute("aria-pressed", String(state.windowLocked));
    const span = btn.querySelector("span");
    if (span) span.textContent = state.windowLocked ? "已锁定" : "锁定";
  }
  setWriteStatus(state.windowLocked ? "已锁定窗口位置（再次点击可解锁拖动）" : "已解锁窗口拖动", false);
}

// ---------------------------------------------------------------- 年月快速跳转弹层

function renderYmPopover() {
  const pop = el["kal-ym-popover"];
  if (!pop) return;
  pop.replaceChildren();

  const head = document.createElement("div");
  head.className = "kal-ym-head";

  const prevY = document.createElement("button");
  prevY.type = "button";
  prevY.className = "kal-btn kal-btn-ghost";
  prevY.textContent = "‹ 年";
  prevY.addEventListener("click", () => {
    state.year = Math.max(1970, state.year - 1);
    state.selected = null;
    render();
  });

  const yearInput = document.createElement("input");
  yearInput.type = "number";
  yearInput.className = "kal-ym-year-input";
  yearInput.min = "1970";
  yearInput.max = "2099";
  yearInput.value = String(state.year);
  yearInput.setAttribute("aria-label", "选择年份");
  yearInput.addEventListener("change", () => {
    const y = Number(yearInput.value);
    if (Number.isFinite(y) && y >= 1970 && y <= 2099) {
      state.year = Math.round(y);
      state.selected = null;
      render();
    }
  });

  const nextY = document.createElement("button");
  nextY.type = "button";
  nextY.className = "kal-btn kal-btn-ghost";
  nextY.textContent = "年 ›";
  nextY.addEventListener("click", () => {
    state.year = Math.min(2099, state.year + 1);
    state.selected = null;
    render();
  });

  head.append(prevY, yearInput, nextY);
  pop.appendChild(head);

  const grid = document.createElement("div");
  grid.className = "kal-ym-grid";
  for (let m = 0; m < 12; m++) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "kal-ym-month" + (m === state.month ? " is-current" : "");
    btn.textContent = `${m + 1}月`;
    btn.addEventListener("click", () => {
      state.month = m;
      state.selected = null;
      closeYmPopover();
      render();
    });
    grid.appendChild(btn);
  }
  pop.appendChild(grid);
}

function closeYmPopover() {
  if (!el["kal-ym-popover"] || !state.ymOpen) return;
  state.ymOpen = false;
  el["kal-ym-popover"].hidden = true;
}

function toggleYmPopover() {
  if (!el["kal-ym-popover"]) return;
  if (state.ymOpen) {
    closeYmPopover();
  } else {
    closeExportPopover();
    state.ymOpen = true;
    el["kal-ym-popover"].hidden = false;
    renderYmPopover();
  }
}

// ---------------------------------------------------------------- 日历导出与导入 (.pdf / .md / .ics / 打印)

function setExportStatus(msg, isError = false) {
  const statusEl = el["kal-export-status"];
  if (!statusEl) return;
  statusEl.textContent = msg || "";
  statusEl.classList.toggle("is-error", Boolean(isError));
}

function syncExportControls() {
  el["kal-export-orient"]?.querySelectorAll(".kal-filter-chip, .kal-export-seg-btn").forEach(btn => {
    btn.classList.toggle("is-active", btn.dataset.orient === state.exportOrient);
  });
  el["kal-export-paper"]?.querySelectorAll(".kal-filter-chip, .kal-export-seg-btn").forEach(btn => {
    btn.classList.toggle("is-active", btn.dataset.paper === state.exportPaper);
  });
  el["kal-export-margin"]?.querySelectorAll(".kal-filter-chip, .kal-export-seg-btn").forEach(btn => {
    btn.classList.toggle("is-active", Number(btn.dataset.margin) === state.exportMargin);
  });
}

function openExportPopover() {
  if (!el["kal-export-popover"]) return;
  closeYmPopover();
  state.exportOpen = true;
  el["kal-export-popover"].hidden = false;
  el["kal-export-btn"]?.classList.add("is-active");
  syncExportControls();
}

function closeExportPopover() {
  if (!el["kal-export-popover"] || !state.exportOpen) return;
  state.exportOpen = false;
  el["kal-export-popover"].hidden = true;
  el["kal-export-btn"]?.classList.remove("is-active");
}

function toggleExportPopover() {
  if (state.exportOpen) closeExportPopover();
  else openExportPopover();
}

function collectExportOptions() {
  return {
    orientation: state.exportOrient || "landscape",
    paperSize: state.exportPaper || "A4",
    marginMm: Number.isFinite(state.exportMargin) ? state.exportMargin : 6,
    includeLunar: Boolean(el["kal-export-lunar"] ? el["kal-export-lunar"].checked : true),
    includeAlmanac: Boolean(el["kal-export-almanac"] ? el["kal-export-almanac"].checked : true),
    includeStats: Boolean(el["kal-export-almanac"] ? el["kal-export-almanac"].checked : true),
    includeCompleted: Boolean(el["kal-export-completed"] ? el["kal-export-completed"].checked : true),
    includeAgenda: Boolean(el["kal-export-detail"] ? el["kal-export-detail"].checked : true),
    includeAgendaDetail: Boolean(el["kal-export-detail"] ? el["kal-export-detail"].checked : true),
  };
}

function syncDynamicPrintStyle(opts) {
  let styleEl = document.getElementById("kal-dynamic-print-style");
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "kal-dynamic-print-style";
    document.head.appendChild(styleEl);
  }
  const paper = opts.paperSize === "A3" || opts.paperSize === "Letter" ? opts.paperSize : "A4";
  const orient = opts.orientation === "portrait" ? "portrait" : "landscape";
  const margin = Math.max(0, Math.min(20, Number(opts.marginMm ?? 6)));
  styleEl.textContent = `@page { size: ${paper} ${orient}; margin: ${margin}mm; }`;
}

async function exportCalendarMarkdown() {
  const opts = collectExportOptions();
  const md = buildMarkdownCalendar({
    year: state.year,
    month: state.month,
    weekStart: state.weekStart,
    byDay: state.lastByDay || new Map(),
    getLunarDay,
    getGanZhiYear,
    countdowns: productivity?.getCountdowns?.() || [],
    options: opts,
  });
  window.__KAL_LAST_EXPORT_MD__ = md;
  const defaultName = `Kal-${state.year}-${pad(state.month + 1)}-日历.md`;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(md).catch(() => {});
    }
    if (window.__TAURI__) {
      const path = await bridge.pickExportPath(defaultName, "md");
      if (!path) {
        setExportStatus("已复制 Markdown 到剪贴板（取消了文件另存）", false);
        return;
      }
      const saved = await bridge.calendarExportText(path, md);
      setExportStatus(`已导出 Markdown 日历：${saved}（同时已复制到剪贴板）`, false);
      setWriteStatus(`已导出 Markdown 日历：${defaultName}`, false);
    } else {
      await bridge.calendarExportText(defaultName, md);
      try {
        const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = defaultName;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
      } catch { /* ignore download error in headless */ }
      setExportStatus(`已导出 ${defaultName}（7列月历矩阵 + 每日清单，并已复制到剪贴板）`, false);
      setWriteStatus(`已导出 Markdown 日历：${defaultName}`, false);
    }
  } catch (err) {
    setExportStatus(`导出 Markdown 失败：${sanitizeUserMessage(err?.message || String(err))}`, true);
  }
}

async function exportCalendarPdf() {
  const opts = collectExportOptions();
  syncDynamicPrintStyle(opts);
  const html = buildPrintableCalendarHtml({
    year: state.year,
    month: state.month,
    weekStart: state.weekStart,
    byDay: state.lastByDay || new Map(),
    getLunarDay,
    getGanZhiYear,
    theme: state.draft,
    options: opts,
  });
  window.__KAL_LAST_EXPORT_HTML__ = html;
  const orientTag = opts.orientation === "portrait" ? "纵向" : "横向满幅";
  const defaultName = `Kal-${state.year}-${pad(state.month + 1)}-${opts.paperSize}-${orientTag}.pdf`;

  const pdfBtn = el["kal-export-pdf"];
  if (pdfBtn) pdfBtn.disabled = true;
  try {
    if (window.__TAURI__) {
      const path = await bridge.pickExportPath(defaultName, "pdf");
      if (!path) {
        setExportStatus("已取消导出 PDF", false);
        return;
      }
      setExportStatus(`正在排版并导出 ${opts.paperSize} ${orientTag} PDF（边距 ${opts.marginMm}mm）…`, false);
      const saved = await bridge.calendarExportPdf(path, html);
      setExportStatus(`已导出高清矢量 PDF：${saved}`, false);
      setWriteStatus(`已导出 ${opts.paperSize} ${orientTag} PDF 日历`, false);
    } else {
      await bridge.calendarExportPdf(defaultName, html);
      setExportStatus(
        `已生成 ${opts.paperSize} ${orientTag} PDF 日历（边距 ${opts.marginMm}mm，自动换行零截断）`,
        false,
      );
      setWriteStatus(`已导出 ${opts.paperSize} ${orientTag} PDF 日历`, false);
    }
  } catch (err) {
    setExportStatus(`导出 PDF 失败：${sanitizeUserMessage(err?.message || String(err))}`, true);
  } finally {
    if (pdfBtn) pdfBtn.disabled = false;
  }
}

function printCalendarPreview() {
  const opts = collectExportOptions();
  syncDynamicPrintStyle(opts);
  const html = buildPrintableCalendarHtml({
    year: state.year,
    month: state.month,
    weekStart: state.weekStart,
    byDay: state.lastByDay || new Map(),
    getLunarDay,
    getGanZhiYear,
    theme: state.draft,
    options: opts,
  });
  window.__KAL_LAST_EXPORT_HTML__ = html;
  window.__KAL_LAST_PRINT_PREVIEW__ = html;
  setExportStatus(`已应用 ${opts.paperSize} ${opts.orientation === "portrait" ? "纵向" : "横向满幅"} 打印样式（边距 ${opts.marginMm}mm）`, false);
  if (window.__TAURI__) {
    try { window.print(); } catch { /* ignore */ }
  }
}

async function importIcsCalendarText(icsText) {
  const items = parseIcsCalendar(icsText);
  if (!items.length) {
    setExportStatus("未在 .ics 文件中解析到有效 VEVENT 日程", true);
    return 0;
  }
  try {
    const res = await bridge.calendarImportItems(items);
    const count = res?.imported ?? items.length;
    invalidateReads();
    await render();
    setExportStatus(`成功导入 ${count} 条 iCalendar (.ics) 日程`, false);
    setWriteStatus(`已导入 ${count} 条 .ics 日程`, false);
    return count;
  } catch (err) {
    setExportStatus(`导入 .ics 失败：${sanitizeUserMessage(err?.message || String(err))}`, true);
    return 0;
  }
}

async function triggerImportIcs() {
  if (window.__TAURI__ && bridge.pickImportIcsFile && bridge.calendarReadTextFile) {
    const path = await bridge.pickImportIcsFile();
    if (!path) return;
    try {
      const text = await bridge.calendarReadTextFile(path);
      await importIcsCalendarText(text);
    } catch (err) {
      setExportStatus(`读取 .ics 文件失败：${sanitizeUserMessage(err?.message || String(err))}`, true);
    }
    return;
  }
  el["kal-ics-file-input"]?.click();
}

// ---------------------------------------------------------------- 主题

/** 只有这几个字段会影响格子结构；其余都是纯 CSS 变量，改它们不必重绘 DOM */
function layoutSignature(t) {
  return [
    t.layout?.weekStart, t.layout?.maxTasks, t.layout?.agenda,
    t.layout?.hideCompleted, t.layout?.sortCompletedLast, t.layout?.bulletStyle,
    t.layout?.taskWrap,
  ].join("|");
}

function togglePrivacyMode() {
  state.privacyMode = !state.privacyMode;
  document.body.classList.toggle("kal-privacy-mode", state.privacyMode);
  const btn = el["kal-privacy-btn"];
  if (btn) {
    btn.classList.toggle("is-active", state.privacyMode);
    btn.setAttribute("aria-pressed", String(state.privacyMode));
    const labelSpan = btn.querySelector("span");
    if (labelSpan) labelSpan.textContent = state.privacyMode ? "已防窥" : "防窥";
    else btn.textContent = state.privacyMode ? "已防窥" : "防窥";
  }
}

async function copyCurrentAgenda() {
  const key = state.selected || toKey(new Date());
  const dateObj = fromKey(key);
  const lunar = getLunarDay(dateObj.getFullYear(), dateObj.getMonth() + 1, dateObj.getDate());
  const list = state.currentAgendaList || [];
  const headLine = `### ${key} ${formatAgendaDate(dateObj)}（${lunar?.fullTitle || ""}）`;
  const lines = list.length
    ? list.map(ev => `- [${ev.done ? "x" : " "}] ${ev.time ? ev.time + " " : ""}${ev.title}`)
    : ["- （当日暂无安排）"];
  const md = [headLine, ...lines].join("\n");
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(md);
    }
    setWriteStatus(`已复制 ${key} 清单（共 ${list.length} 项）`, false);
    const copyBtn = el["kal-agenda-copy"];
    if (copyBtn) {
      copyBtn.textContent = "已复制";
      setTimeout(() => { if (copyBtn.isConnected) copyBtn.textContent = "复制"; }, 1400);
    }
  } catch {
    setWriteStatus("复制清单失败，请检查剪贴板权限", true);
  }
}

async function exportCurrentAgendaIcs(shiftKey = false) {
  const key = state.selected || toKey(new Date());
  let events = [];
  if (!shiftKey) {
    events = (state.currentAgendaList || []).map(ev => ({ ...ev, date: ev.date || key }));
    if (!events.length) {
      setWriteStatus("当日暂无日程可导出（按住 Shift 点击 ICS 可导出整月）", false);
      return;
    }
  } else if (state.lastByDay && typeof state.lastByDay.entries === "function") {
    for (const [dKey, list] of state.lastByDay.entries()) {
      for (const ev of list || []) {
        events.push({ ...ev, date: ev.date || dKey });
      }
    }
  }
  const ics = buildIcsCalendar(events, `Kal ${shiftKey ? `${state.year}-${pad(state.month + 1)}` : key}`);
  window.__KAL_LAST_ICS__ = ics;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(ics).catch(() => {});
    }
    if (window.__TAURI__ && bridge.pickExportPath && bridge.calendarExportText) {
      const defaultName = `Kal-${shiftKey ? `${state.year}-${pad(state.month + 1)}` : key}.ics`;
      const path = await bridge.pickExportPath(defaultName, "ics");
      if (path) {
        await bridge.calendarExportText(path, ics);
      }
    }
    setWriteStatus(`已导出 ${events.length} 项日程为标准 iCalendar (.ics)`, false);
    const icsBtn = el["kal-agenda-ics"];
    if (icsBtn) {
      icsBtn.textContent = "已导出";
      setTimeout(() => { if (icsBtn.isConnected) icsBtn.textContent = "ICS"; }, 1400);
    }
  } catch {
    setWriteStatus("导出 ICS 失败，请检查剪贴板或文件权限", true);
  }
}

async function initHolidayEditor() {
  const txt = el["kal-holiday-json"];
  const saveBtn = el["kal-holiday-save"];
  const sampleBtn = el["kal-holiday-sample"];
  const resetBtn = el["kal-holiday-reset"];
  const statusEl = el["kal-holiday-status"];
  if (!txt || !saveBtn || !statusEl) return;

  const setHolidayMsg = (msg, isErr = false) => {
    statusEl.textContent = msg;
    statusEl.classList.toggle("is-error", Boolean(isErr));
  };

  try {
    const settings = await bridge.settingsGet();
    if (settings?.cellColors && typeof settings.cellColors === "object") {
      state.cellColors = { ...settings.cellColors };
    }
    const rawSaved = settings?.customHolidays || settings?.holidays;
    if (rawSaved) {
      const res = setCustomHolidays(rawSaved);
      if (res.count > 0) {
        txt.value = JSON.stringify(res.entries, null, 2);
        setHolidayMsg(`已加载 ${res.count} 条自定义节假日规则`);
      } else {
        setHolidayMsg("支持粘贴 GitHub NateScarlet/holiday-cn 年度 JSON");
      }
    } else {
      setHolidayMsg("支持粘贴 GitHub NateScarlet/holiday-cn 年度 JSON");
    }
  } catch {
    setHolidayMsg("支持粘贴 GitHub NateScarlet/holiday-cn 年度 JSON");
  }

  sampleBtn?.addEventListener("click", () => {
    const sample = {
      year: 2028,
      days: [
        { name: "元旦", date: "2028-01-01", isOffDay: true },
        { name: "春节补班", date: "2028-01-22", isOffDay: false },
        { name: "春节", date: "2028-01-26", isOffDay: true },
      ],
    };
    txt.value = JSON.stringify(sample, null, 2);
    setHolidayMsg("已填入 holiday-cn 兼容示例，点击「应用并保存」生效");
  });

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      const raw = txt.value.trim();
      const res = setCustomHolidays(raw ? raw : {});
      await bridge.settingsSet({
        customHolidays: res.count > 0 ? JSON.stringify(res.entries) : "",
        holidays: null,
      });
      await render();
      setHolidayMsg(res.count ? `已生效并保存 ${res.count} 条节假日规则` : "已清空自定义规则，使用内置节假日表");
    } catch (err) {
      setHolidayMsg(`JSON 格式有误：${sanitizeUserMessage(err?.message || String(err))}`, true);
    } finally {
      saveBtn.disabled = false;
    }
  });

  resetBtn?.addEventListener("click", async () => {
    resetBtn.disabled = true;
    try {
      setCustomHolidays({});
      txt.value = "";
      await bridge.settingsSet({ customHolidays: "", holidays: null });
      await render();
      setHolidayMsg("已恢复内置法定节假日表（2025–2028）");
    } catch (err) {
      setHolidayMsg(sanitizeUserMessage(err?.message || String(err)), true);
    } finally {
      resetBtn.disabled = false;
    }
  });
}

function syncQuickGlassBtn(t = state.draft) {
  const btn = el["kal-quick-glass"];
  if (!btn) return;
  const isTransparent = (t?.color?.bgAlpha ?? 0.62) <= 0.08;
  btn.classList.toggle("is-active", isTransparent);
  btn.title = isTransparent
    ? "当前为全透悬浮模式（点击恢复毛玻璃底）"
    : "一键切换全透明底 / 毛玻璃";
}

function toggleQuickGlass() {
  const isTransparent = (state.draft?.color?.bgAlpha ?? 0.62) <= 0.08;
  const recipeId = isTransparent ? "frosted" : "transparent";
  const next = applyStyleRecipe(state.draft, recipeId);
  previewDraft(next);
  panel?.sync();
}

function applyDraft(t) {
  const before = layoutSignature(state.draft);
  state.draft = t;
  applyTheme(t);
  backdropManager?.sync(t);
  syncQuickGlassBtn(t);
  state.maxTasks = t.layout?.maxTasks ?? 4;
  state.weekStart = t.layout?.weekStart ?? 1;

  const pref = Number.isFinite(+t.scale) && +t.scale > 0 ? +t.scale : 1;
  const ppi = state.info?.display?.kalScale ?? 1;
  setUiScale(t.scaleMode === "fixed" ? pref : ppi * pref);

  return layoutSignature(t) !== before;
}

function previewDraft(t) {
  themeGuard.next();
  if (applyDraft(normalizeTheme(t))) render();
}

function applyApplied(t) {
  t = normalizeTheme(t);
  state.applied = t;
  state.draft = t;
  applyTheme(t);
  backdropManager?.sync(t);
  syncQuickGlassBtn(t);
  state.maxTasks = t.layout?.maxTasks ?? 4;
  state.weekStart = t.layout?.weekStart ?? 1;
  el["kal-source-tag"].textContent = t.name || "主题";
}

function reportHtml(rep) {
  const pct = v => `${Math.round(v * 100)}%`;
  const rows = rep.clusters
    .map(c => `<span class="kal-swatch" style="background:${c.hex}" title="${c.hex} · ${pct(c.share)}"></span>`)
    .join("");
  return `
    判定 <b>${rep.mode === "dark" ? "深色" : "浅色"}</b> ·
    区域明度 ${rep.regionL.toFixed(2)} · 采样 ${rep.sampled} px<br>
    强调色 ${rep.accent}（${rep.accentFrom}）· 面板不透明 ${pct(rep.bgAlpha)}<br>
    对比度 正文 ${rep.contrastFg.toFixed(1)} / 次要 ${rep.contrastMuted.toFixed(1)} / 强调 ${rep.contrastAccent.toFixed(1)}
    <div class="kal-swatches" style="margin-top:6px">${rows}</div>
  `;
}

function openThemeSession() {
  themeGuard.next();
  themeSnapshot = structuredClone(state.draft);
}
function cancelThemeSession() {
  if (themeSaving) return;
  themeGuard.next();
  if (themeSnapshot) {
    if (applyDraft(structuredClone(themeSnapshot))) render();
    el["kal-source-tag"].textContent = state.applied.name || "主题";
  }
}

async function regen(opts = {}) {
  const seq = themeGuard.next();
  let res;
  if (opts.file) {
    const path = await bridge.pickImage();
    if (!themeGuard.isCurrent(seq)) return "";
    if (!path) return "已取消。";
    const { file, ...rest } = opts;
    res = await bridge.themeGenerateFrom(path, rest);
  } else res = await bridge.themeGenerate(opts);
  if (!themeGuard.isCurrent(seq)) return "";
  if (applyDraft(mergeThemeAppearance(state.draft, res.theme))) await render();
  panel?.sync();
  return reportHtml(res.report);
}

async function regenMode(mode) {
  const report = await regen({ mode });
  if (report) panel.setReport(report);
}

async function saveTheme() {
  if (themeSaving) return false;
  themeSaving = true;
  themeGuard.next();
  panel?.setBusy(true);
  const t = structuredClone(state.draft);
  t.id = "";
  t.name = t.name || `主题 ${new Date().toLocaleString("zh-CN")}`;
  try {
    const saved = normalizeTheme(await bridge.themeCommit(t));
    const needsRender = applyDraft(saved);
    state.applied = saved;
    themeSnapshot = structuredClone(saved);
    el["kal-source-tag"].textContent = saved.name || "主题";
    panel?.setReportText("已保存并应用。关闭设置会保留这次保存。");
    panel?.addLog?.("theme", `保存并启用主题「${saved.name}」`);
    panel?.sync();
    await panel?.refreshLibrary();
    if (needsRender) await render();
    return true;
  } catch (err) {
    panel?.setReportText(`保存失败，草稿仍保留：${sanitizeUserMessage(err?.message || String(err))}`, true);
    return false;
  } finally { themeSaving = false; panel?.setBusy(false); }
}

async function applyThemeById(id) {
  const seq = themeGuard.next();
  try {
    const t = await bridge.themeLoad(id);
    if (!themeGuard.isCurrent(seq)) return false;
    if (applyDraft(mergeThemeAppearance(state.draft, t))) await render();
    return true;
  } catch (err) {
    if (themeGuard.isCurrent(seq)) panel?.setReportText(`预览失败：${sanitizeUserMessage(err?.message || String(err))}`, true);
    return false;
  }
}

async function exportTheme() {
  const draft = structuredClone(state.draft);
  try {
    const path = await bridge.pickSavePath(`${draft.name || "kal-theme"}.json`);
    if (!path) return "已取消导出。";
    await bridge.themeExportDraft(draft, path);
    return `已导出当前草稿：${path}`;
  } catch (err) { return `导出失败：${sanitizeUserMessage(err?.message || String(err))}`; }
}

async function importTheme() {
  const seq = themeGuard.next();
  try {
    const path = await bridge.pickThemeFile();
    if (!themeGuard.isCurrent(seq)) return "";
    if (!path) return "已取消导入。";
    const id = await bridge.themeImport(path);
    if (!themeGuard.isCurrent(seq)) return "";
    await applyThemeById(id);
    return `已导入为预览，点击保存后应用。`;
  } catch (err) { return `导入失败：${sanitizeUserMessage(err?.message || String(err))}`; }
}

// ---------------------------------------------------------------- 启动

let bridge = null;
let panel = null;
let productivity = null;
let localFonts = null;
let backdropManager = null;

async function boot() {
  cacheEls();
  if (!window.__TAURI__) document.body.classList.add("kal-debug-bg");

  bridge = await createBridge();
  backdropManager = createBackdropManager({ bridge, getTheme: () => state.draft });
  localFonts = createLocalFonts({
    bridge,
    getTheme: () => state.draft,
    onError: err => panel?.setFontError?.(err),
  });

  applyTheme(DEFAULT_THEME);

  try {
    const t = await bridge.themeActive();
    if (t && t.color) applyApplied(t);
  } catch { /* 用默认 */ }
  await localFonts.refresh().catch(() => {});

  try {
    const info = await bridge.appInfo();
    state.info = info;
    if (info?.uiScale) setUiScale(info.uiScale);
    if (info?.display?.ppiKnown) {
      const d = info.display;
      el["kal-display-tag"].textContent =
        `${d.pxW}×${d.pxH} · ${d.diagonalIn.toFixed(1)}" · ${d.dpiScale * 100}%`;
      el["kal-display-tag"].title =
        `${d.monitor}\n物理 ${d.mmW}×${d.mmH}mm\n真实 ${d.ppi.toFixed(1)} PPI\n缩放校正 ${d.kalScale.toFixed(3)}`;
    } else {
      el["kal-display-tag"].textContent = "物理尺寸未知";
    }
    el["kal-source-tag"].textContent = state.applied.name || info?.sourceLabel || "-";
    if (info && info.dbFound === false) {
      state.readError = "未找到日历数据库，当前仍可浏览日历与调整设置";
    }
  } catch (err) {
    state.readError = sanitizeUserMessage(
      bridge?.bootError || err?.message || String(err),
      "应用状态读取异常，仍可浏览日历与打开设置",
    );
    el["kal-source-tag"].textContent = "状态受限";
  }

  bindControls();
  await initHolidayEditor();
  await refreshWriteStatus();
  await render();

  productivity = createProductivity({ mount: document.getElementById("kal-productivity"), bridge });
  await productivity.refresh();

  panel = createPanel({
    mount: document.getElementById("kal-root"),
    getTheme: () => state.draft,
    onPreview: previewDraft,
    onCommit: saveTheme,
    onOpen: openThemeSession,
    onCancel: cancelThemeSession,
    onReset: () => { cancelThemeSession(); panel.sync(); },
    onModeChange: regenMode,
    onRegen: regen,
    onApply: applyThemeById,
    onExport: exportTheme,
    onImport: importTheme,
    onUndo: () => performUndo(),
    bridge,
    localFonts,
  });
  mountDesktopSettings({ mount: document.querySelector(".kal-panel-body"), bridge });
  panel.refreshLibrary();

  try {
    bridge.on("kal://settings", () => panel.open());
    bridge.on("kal://regen-theme", async () => {
      panel.open();
      panel.setReport(await regen({}));
    });
    bridge.on("kal://click-through", ev => {
      state.clickThrough = Boolean(ev?.payload);
      const btn = el["kal-lock-btn"];
      if (btn) {
        btn.classList.toggle("is-active", state.windowLocked || state.clickThrough);
        const span = btn.querySelector("span");
        if (span) span.textContent = state.clickThrough ? "已穿透" : (state.windowLocked ? "已锁定" : "锁定");
      }
    });
  } catch { /* 浏览器里没有 */ }

  window.__KAL_IMPORT_ICS__ = importIcsCalendarText;
}

function bindControls() {
  document.getElementById("kal-prev").addEventListener("click", () => goto(-1));
  document.getElementById("kal-next").addEventListener("click", () => goto(1));
  document.getElementById("kal-today").addEventListener("click", () => {
    const now = new Date();
    state.year = now.getFullYear();
    state.month = now.getMonth();
    state.selected = null;
    closeYmPopover();
    render();
  });
  el["kal-title-trigger"]?.addEventListener("click", () => toggleYmPopover());
  el["kal-title-trigger"]?.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleYmPopover();
    }
  });
  el["kal-lock-btn"]?.addEventListener("click", e => toggleWindowLock(Boolean(e.shiftKey)));
  el["kal-privacy-btn"]?.addEventListener("click", () => togglePrivacyMode());
  el["kal-quick-glass"]?.addEventListener("click", () => toggleQuickGlass());
  el["kal-view-toggle"]?.addEventListener("click", () => toggleViewMode());
  el["kal-export-btn"]?.addEventListener("click", () => toggleExportPopover());
  el["kal-export-close"]?.addEventListener("click", () => closeExportPopover());
  el["kal-day-more-close"]?.addEventListener("click", () => closeDayMorePopover());
  el["kal-export-orient"]?.addEventListener("click", e => {
    const btn = e.target.closest(".kal-filter-chip, .kal-export-seg-btn");
    if (!btn?.dataset.orient) return;
    state.exportOrient = btn.dataset.orient;
    syncExportControls();
  });
  el["kal-export-paper"]?.addEventListener("click", e => {
    const btn = e.target.closest(".kal-filter-chip, .kal-export-seg-btn");
    if (!btn?.dataset.paper) return;
    state.exportPaper = btn.dataset.paper;
    syncExportControls();
  });
  el["kal-export-margin"]?.addEventListener("click", e => {
    const btn = e.target.closest(".kal-filter-chip, .kal-export-seg-btn");
    if (!btn || btn.dataset.margin === undefined) return;
    state.exportMargin = Number(btn.dataset.margin);
    syncExportControls();
  });
  el["kal-export-pdf"]?.addEventListener("click", () => exportCalendarPdf());
  el["kal-export-md"]?.addEventListener("click", () => exportCalendarMarkdown());
  el["kal-export-import-ics"]?.addEventListener("click", () => triggerImportIcs());
  el["kal-ics-file-input"]?.addEventListener("change", async e => {
    const file = e.target?.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      await importIcsCalendarText(text);
    } finally {
      e.target.value = "";
    }
  });
  el["kal-export-print"]?.addEventListener("click", () => printCalendarPreview());
  el["kal-undo-btn"]?.addEventListener("click", () => performUndo());
  el["kal-rollover-btn"]?.addEventListener("click", e => rolloverSelectedDayTodos(e.shiftKey ? 7 : 1));
  el["kal-agenda-copy"]?.addEventListener("click", () => copyCurrentAgenda());
  el["kal-agenda-ics"]?.addEventListener("click", e => exportCurrentAgendaIcs(Boolean(e.shiftKey)));
  document.getElementById("kal-settings").addEventListener("click", () => panel?.toggle());
  el["kal-search-btn"]?.addEventListener("click", () => toggleSearch());
  el["kal-search-close"]?.addEventListener("click", () => closeSearch(true));
  el["kal-search-filters"]?.addEventListener("click", e => {
    const chip = e.target.closest(".kal-filter-chip");
    if (!chip) return;
    const filter = chip.dataset.filter || "all";
    state.searchFilter = filter;
    el["kal-search-filters"].querySelectorAll(".kal-filter-chip").forEach(btn => {
      btn.classList.toggle("is-active", btn.dataset.filter === filter);
    });
    if (state.searchLastQuery) renderFilteredSearchResults();
  });
  el["kal-refresh"]?.addEventListener("click", async () => {
    state.transientStatus = "";
    state.transientError = false;
    invalidateReads();
    await productivity?.refresh();
    await refreshWriteStatus();
    await render();
    if (state.searchOpen) await runSearch(el["kal-search-input"]?.value || "");
  });

  const quickInput = el["kal-agenda-input"];
  bindImeGuard(quickInput);
  quickInput.addEventListener("input", () => {
    rememberQuickDraft();
    renderNlpPreview();
  });
  quickInput.addEventListener("keydown", e => { if (e.key === "Enter" && isImeComposing(e)) e.preventDefault(); });

  el["kal-agenda-inline-trigger"]?.addEventListener("click", () => openAgendaInlineEditor());
  el["kal-agenda-list"]?.addEventListener("dblclick", e => {
    if (e.target === el["kal-agenda-list"]) openAgendaInlineEditor();
  });

  const timeToggleBtn = el["kal-time-toggle-btn"];
  const metaBox = el["kal-agenda-add-meta"];
  const timeInput = el["kal-agenda-time-input"];
  const dateInput = el["kal-agenda-date-input"];
  const prioBtn = el["kal-agenda-prio-btn"];

  timeToggleBtn?.addEventListener("click", () => {
    if (!metaBox) return;
    metaBox.hidden = !metaBox.hidden;
    timeToggleBtn.setAttribute("aria-expanded", String(!metaBox.hidden));
    if (!metaBox.hidden && dateInput && !dateInput.value) {
      dateInput.value = state.selected || toKey(new Date());
    }
    syncComposerMetaUi();
    if (!metaBox.hidden) timeInput?.focus();
  });

  timeInput?.addEventListener("input", () => {
    timeInput.removeAttribute("aria-invalid");
    syncComposerMetaUi();
    renderNlpPreview();
  });

  metaBox?.addEventListener("click", e => {
    const chip = e.target.closest(".kal-time-chip:not(.kal-prio-chip)");
    if (!chip || !timeInput) return;
    timeInput.value = chip.dataset.time ?? "";
    timeInput.removeAttribute("aria-invalid");
    syncComposerMetaUi();
    renderNlpPreview();
  });

  dateInput?.addEventListener("change", () => {
    syncComposerMetaUi();
    renderNlpPreview();
  });

  prioBtn?.addEventListener("click", () => {
    const next = prioBtn.getAttribute("aria-pressed") !== "true";
    prioBtn.setAttribute("aria-pressed", String(next));
    prioBtn.classList.toggle("is-active", next);
    syncComposerMetaUi();
    renderNlpPreview();
  });
  const searchInput = el["kal-search-input"];
  bindImeGuard(searchInput);
  if (searchInput) {
    searchInput.addEventListener("compositionstart", () => { cancelSearch(); clearSearchResults(); });
    searchInput.addEventListener("input", e => {
      if (isImeComposing(e)) { cancelSearch(); clearSearchResults(); return; }
      runSearch(searchInput.value);
    });
    searchInput.addEventListener("compositionend", () => {
      runSearch(searchInput.value);
    });
    searchInput.addEventListener("keydown", e => {
      if (isImeComposing(e)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeSearch(true);
      } else if (e.key === "ArrowDown") {
        if (!state.searchItems.length) return;
        e.preventDefault();
        state.searchActiveIdx = (state.searchActiveIdx + 1) % state.searchItems.length;
        updateSearchActiveItem();
      } else if (e.key === "ArrowUp") {
        if (!state.searchItems.length) return;
        e.preventDefault();
        state.searchActiveIdx = (state.searchActiveIdx - 1 + state.searchItems.length) % state.searchItems.length;
        updateSearchActiveItem();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (state.searchActiveIdx >= 0 && state.searchItems[state.searchActiveIdx]) {
          jumpToSearchResult(state.searchItems[state.searchActiveIdx]);
        } else {
          runSearch(searchInput.value);
        }
      }
    });
  }

  el["kal-agenda-add"]?.addEventListener("submit", async e => {
    e.preventDefault();
    if (state.writeBusy || state.pendingConfirm || isImeComposing(e, quickInput)) return;
    rememberQuickDraft();
    const snapshot = quickDrafts.snapshot(quickDate);
    const rawInput = el["kal-agenda-input"].value;
    const baseDate = snapshot.key || state.selected || toKey(new Date());
    const nlp = parseNaturalEntry(rawInput, baseDate);
    const parsed = nlp.hasNlpHint && nlp.title ? nlp : parseQuickEntry(rawInput);

    if (!parsed.title) {
      setWriteStatus("请输入内容", true);
      return;
    }

    const rawManualTime = el["kal-agenda-time-input"] ? el["kal-agenda-time-input"].value.trim() : "";
    let finalTime = parsed.time || "";
    if (rawManualTime) {
      const normManual = normalizeManualTime(rawManualTime);
      if (normManual === null) {
        el["kal-agenda-time-input"]?.setAttribute("aria-invalid", "true");
        setWriteStatus("时间格式应为 HH:MM（如 09:30 或 14:00），不需要时间请留空", true);
        return;
      }
      el["kal-agenda-time-input"]?.removeAttribute("aria-invalid");
      finalTime = normManual;
    }

    let finalTitle = parsed.title;
    const isPrioOn = el["kal-agenda-prio-btn"]?.getAttribute("aria-pressed") === "true";
    if (isPrioOn && !finalTitle.includes("[!高]")) {
      finalTitle = `[!高] ${finalTitle}`;
    }

    if (finalTime && !state.writeStatus.canCreateEvent) {
      setWriteStatus("当前仅支持添加无具体时间的任务，请去掉时间后再试", true);
      return;
    }
    if (!finalTime && !state.writeStatus.canCreate) {
      setWriteStatus("当前暂不支持添加普通任务", true);
      return;
    }

    const manualDateVal = el["kal-agenda-date-input"]?.value?.trim() || "";
    const targetDate = (nlp.hasNlpHint && nlp.date && nlp.date !== baseDate)
      ? nlp.date
      : (manualDateVal && /^\d{4}-\d{2}-\d{2}$/.test(manualDateVal) && manualDateVal !== baseDate ? manualDateVal : baseDate);

    try {
      validateCrudInput({ date: targetDate, title: finalTitle, time: finalTime, checkTitle: true, checkTime: true });
    } catch (err) {
      setWriteStatus(err.message, true);
      return;
    }
    const targetDates = nlp.hasNlpHint && Array.isArray(nlp.dates) && nlp.dates.length > 1
      ? nlp.dates
      : [targetDate];

    await writeAction(
      async () => {
        let lastRes = null;
        for (const dKey of targetDates) {
          lastRes = await bridge.itemCreate(dKey, finalTitle, finalTime);
          if (lastRes && lastRes.status === "pending_confirmation") break;
        }
        return lastRes;
      },
      {
        onConfirmed: () => {
          if (quickDate === snapshot.key) rememberQuickDraft();
          if (quickDrafts.acknowledge(snapshot) && quickDate === snapshot.key) {
            quickInput.value = "";
            if (el["kal-agenda-time-input"]) {
              el["kal-agenda-time-input"].value = "";
              el["kal-agenda-time-input"].removeAttribute("aria-invalid");
            }
            if (el["kal-agenda-prio-btn"]) {
              el["kal-agenda-prio-btn"].setAttribute("aria-pressed", "false");
              el["kal-agenda-prio-btn"].classList.remove("is-active");
            }
            syncComposerMetaUi();
            renderNlpPreview();
          }
          panel?.addLog?.("schedule", `新增安排「${finalTitle}」(${targetDate}${finalTime ? " " + finalTime : " 全天"})`);
          if (targetDate !== baseDate && state.selected === baseDate) {
            selectDay(targetDate);
          }
        },
      },
    );
  });

  // 键盘：面板关着时才接管左右键与撤销重做，避免和面板内控件冲突
  window.addEventListener("keydown", (e) => {
    if (isImeComposing(e)) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      openSearch();
      return;
    }
    if (!e.target?.matches?.("input, textarea, [contenteditable]")) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        performUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && ((e.key === "y" || e.key === "Y") || (e.shiftKey && (e.key === "z" || e.key === "Z")))) {
        e.preventDefault();
        performRedo();
        return;
      }
    }
    if (e.key === "Escape" && !el["kal-day-more-popover"]?.hidden) {
      e.preventDefault();
      closeDayMorePopover();
      return;
    }
    if (e.key === "Escape" && state.ymOpen) {
      e.preventDefault();
      closeYmPopover();
      return;
    }
    if (e.key === "Escape" && state.exportOpen) {
      e.preventDefault();
      closeExportPopover();
      return;
    }
    if (e.key === "Escape" && state.searchOpen) {
      e.preventDefault();
      closeSearch(true);
      return;
    }
    if (panel?.isOpen()) return;
    if (state.searchOpen || state.ymOpen || state.exportOpen) return;
    if (e.target?.matches?.("input, textarea, [contenteditable]")) return;
    if (e.key === "ArrowLeft") goto(-1);
    else if (e.key === "ArrowRight") goto(1);
    else if (e.key === "w" || e.key === "W") {
      toggleViewMode();
    }
    else if (e.key === "t" || e.key === "T") {
      const now = new Date();
      state.year = now.getFullYear();
      state.month = now.getMonth();
      state.selected = toKey(now);
      render();
    }
  });
}

boot().catch(err => {
  console.error("[kal] 启动失败:", err);
  const t = document.getElementById("kal-source-tag");
  if (t) t.textContent = "启动失败";
});
