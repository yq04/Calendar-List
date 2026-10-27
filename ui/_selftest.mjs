// 前端自检：只跑纯函数与主题映射，不碰 DOM
// 跑法：node ui/_selftest.mjs
import {
  getMonthMatrix, getMatrixMonths, mergeDayMaps, isValidDateKey, isValidTimeStr,
  weekHeadLabels, addMonths, toKey, groupByDay, pickDefaultSelected, parseQuickEntry,
  buildIcsCalendar, buildMarkdownCalendar, buildPrintableCalendarHtml,
} from "./src/calendar.js";
import {
  TOKENS, BODY_FLAGS, getPath, setPath, hexToTriplet, tripletToHex, toCssValue,
  DEFAULT_THEME, CONTENT_PRESETS, applyContentPreset, ACCENT_SWATCHES, applyAccentSwatch, I18N_BUNDLES,
} from "./src/theme.js";
import { createMockSource } from "./src/mock.js";
import { createBridge } from "./src/bridge.js";
import {
  SEARCH_LIMIT, normalizeSearchQuery, matchDayItem, searchDayItems, buildSearchViewModel,
} from "./src/search.js";
import {
  sanitizeUserMessage, normalizeWriteStatus, getItemCapabilities,
  buildExpectedSnapshot, matchesExpectedSnapshot, interpretWriteResult, createSeqGuard,
} from "./src/write-state.js";
import {
  getLunarDay, getGanZhiYear, getSolarTerm, getHolidayBadge, getAlmanac, getWeekOfYear,
  parseHolidayConfig, setCustomHolidays, getShuJiuOrFu,
} from "./src/lunar.js";
import {
  parseNaturalEntry, parseTaskDecorations, parseIcsCalendar, addDaysToKey, CELL_HIGHLIGHT_PALETTE,
} from "./src/nlp-parser.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};
const throwsAsync = async (fn) => {
  try { await fn(); return false; } catch { return true; }
};

console.log("[日历]");
const m = getMonthMatrix(2026, 9, 1);
ok("矩阵为 42 格", m.length === 42, `got ${m.length}`);
ok("首格 = 2026-09-28", m[0].key === "2026-09-28", m[0].key);
ok("首格为周一", m[0].dow === 1, String(m[0].dow));
ok("末格 = 2026-11-08", m[41].key === "2026-11-08", m[41].key);
ok("10/01 在当月", m.some(c => c.key === "2026-10-01" && c.inMonth));
ok("9/28 非当月", m.find(c => c.key === "2026-09-28").inMonth === false);
ok("10/03 是周末", m.find(c => c.key === "2026-10-03").isWeekend === true);
ok("isToday 至多一个", m.filter(c => c.isToday).length <= 1);

ok("周一首标签序列", JSON.stringify(weekHeadLabels(1)) === JSON.stringify(["一","二","三","四","五","六","日"]));
ok("周日首标签序列", JSON.stringify(weekHeadLabels(0)) === JSON.stringify(["日","一","二","三","四","五","六"]));

const a = addMonths(2026, 11, 1);
ok("跨年 +1 月", a.year === 2027 && a.month === 0, JSON.stringify(a));
const b = addMonths(2026, 0, -1);
ok("跨年 -1 月", b.year === 2025 && b.month === 11, JSON.stringify(b));
ok("toKey 格式", toKey(new Date(2026, 0, 5)) === "2026-01-05", toKey(new Date(2026, 0, 5)));

// 2 月闰年：2028-02 应有 29 天，且矩阵仍为 42 格
const feb = getMonthMatrix(2028, 1, 1);
ok("闰年 2 月有 29 号", feb.some(c => c.key === "2028-02-29" && c.inMonth));
ok("闰年矩阵仍 42 格", feb.length === 42);

const g = groupByDay([
  { date: "2026-10-01", time: "14:00", title: "B" },
  { date: "2026-10-01", time: "09:00", title: "A" },
  { date: "2026-10-02", time: "", title: "C" },
  null,
  { title: "无日期" },
]);
ok("分组：按日聚拢", g.size === 2, `size ${g.size}`);
ok("分组：按时间排序", g.get("2026-10-01")[0].title === "A");
ok("分组：忽略脏数据", !g.has(undefined));

const sel = pickDefaultSelected(2026, 9);
ok("默认选中格式正确", /^\d{4}-\d{2}-\d{2}$/.test(sel), sel);
const quickEvent = parseQuickEntry("09:30 晨会");
ok("快速输入识别时间", quickEvent.time === "09:30" && quickEvent.kind === "event" && quickEvent.title === "晨会");
const quickItem = parseQuickEntry("整理桌面");
ok("快速输入识别普通任务", quickItem.time === "" && quickItem.kind === "item" && quickItem.title === "整理桌面");
ok("快速输入拒绝非法时间", parseQuickEntry("25:99 错误").kind === "item");
ok("合法日期校验通过", isValidDateKey("2026-10-12") && isValidDateKey("2028-02-29"));
ok("非法日期被拒", !isValidDateKey("2026-02-30") && !isValidDateKey("2026-13-01") && !isValidDateKey("2026/10/12"));
ok("合法时间校验通过", isValidTimeStr("") && isValidTimeStr("09:30") && isValidTimeStr("23:59"));
ok("非法时间被拒", !isValidTimeStr("24:00") && !isValidTimeStr("9:30") && !isValidTimeStr("12:60"));

// 跨月 42 格月份提取与数据合并
const octMonths = getMatrixMonths(m);
ok("42 格覆盖上月/当月/下月共 3 个月", octMonths.length === 3 && octMonths[0].key === "2026-09" && octMonths[2].key === "2026-11");
const mergedCross = mergeDayMaps([
  groupByDay([{ id: "p1", date: "2026-09-28", time: "10:00", title: "上月尾任务" }]),
  groupByDay([{ id: "c1", date: "2026-10-12", time: "09:00", title: "当月任务" }]),
  groupByDay([{ id: "n1", date: "2026-11-08", time: "18:00", title: "下月头任务" }]),
]);
ok("跨月 42 格邻月数据合并完整", mergedCross.has("2026-09-28") && mergedCross.has("2026-10-12") && mergedCross.has("2026-11-08"));

console.log("[主题映射]");
ok("hex -> 三元组", hexToTriplet("#60A5FA") === "96 165 250", hexToTriplet("#60A5FA"));
ok("短写 hex 展开", hexToTriplet("#0f0") === "0 255 0", hexToTriplet("#0f0"));
ok("三元组 -> hex", tripletToHex("96 165 250") === "#60A5FA", tripletToHex("96 165 250"));
ok("非法 hex 返回 null", hexToTriplet("nope") === null);
ok("非法三元组回退黑色", tripletToHex("x y z") === "#000000");

ok("size 走缩放基元", toCssValue("size", 16) === "calc(16 * var(--kal-u))", toCssValue("size", 16));
ok("alpha 原样", toCssValue("alpha", 0.62) === "0.62");
ok("em 带单位", toCssValue("em", -0.02) === "-0.02em");
ok("非数值 size 被拒", toCssValue("size", "abc") === null);
ok("空字符串 str 被拒", toCssValue("str", "") === null);

// getPath / setPath
ok("getPath 深取", getPath(DEFAULT_THEME, "type.size.day") === 16.5);
ok("getPath 缺失返回 undefined", getPath(DEFAULT_THEME, "a.b.c") === undefined);
const t2 = setPath(DEFAULT_THEME, "color.accent", "#FF0000");
ok("setPath 生效", getPath(t2, "color.accent") === "#FF0000");
ok("setPath 不可变", getPath(DEFAULT_THEME, "color.accent") !== "#FF0000");
ok("setPath 不破坏兄弟字段", getPath(t2, "color.bg") === getPath(DEFAULT_THEME, "color.bg"));
ok("setPath 不改原对象引用", t2.color !== DEFAULT_THEME.color);

// 覆盖检查：每个 token 都要能在默认主题里取到值，否则就是「主题里有字段但界面上调不到」
const missing = TOKENS.filter(t => getPath(DEFAULT_THEME, t.path) === undefined).map(t => t.path);
ok("所有 token 路径都能在默认主题里取到", missing.length === 0, missing.join(", "));

const badFlags = BODY_FLAGS.filter(f => getPath(DEFAULT_THEME, f.path) === undefined).map(f => f.path);
ok("所有 body 开关路径都存在", badFlags.length === 0, badFlags.join(", "));

// 每个 color token 的默认值必须是合法 hex，否则运行时变量会被跳过
const badColors = TOKENS.filter(t => t.kind === "color" && hexToTriplet(getPath(DEFAULT_THEME, t.path)) === null).map(t => t.path);
ok("所有 color token 默认值合法", badColors.length === 0, badColors.join(", "));

// token 变量名不能重复
const vars = TOKENS.map(t => t.var);
ok("token 变量名唯一", new Set(vars).size === vars.length,
  vars.filter((v, i) => vars.indexOf(v) !== i).join(", "));

console.log("[编辑桥 Mock]");
const mock = createMockSource();
const mockDate = toKey(new Date());
const created = await mock.itemCreate(mockDate, "自检任务", "");
ok("Mock 新增任务", (await mock.dayEvents(mockDate)).some(e => e.id === created.id && e.title === "自检任务"));
await mock.itemToggleDone(created.id, mockDate, true);
ok("Mock 切换完成态", (await mock.dayEvents(mockDate)).find(e => e.id === created.id)?.done === true);
await mock.itemUpdate(created.id, mockDate, "修改后的任务");
ok("Mock 编辑标题", (await mock.dayEvents(mockDate)).find(e => e.id === created.id)?.title === "修改后的任务");
await mock.itemDelete(created.id, mockDate);
ok("Mock 删除任务", !(await mock.dayEvents(mockDate)).some(e => e.id === created.id));

console.log("[Mock 校验与快照核对]");
ok("Mock 拒绝空标题", await throwsAsync(() => mock.itemCreate(mockDate, "   ", "")));
ok("Mock 拒绝多行标题", await throwsAsync(() => mock.itemCreate(mockDate, "第一行\n第二行", "")));
ok("Mock 拒绝非法日期", await throwsAsync(() => mock.itemCreate("2026-02-30", "任务", "")));
ok("Mock 拒绝非法时间", await throwsAsync(() => mock.itemCreate(mockDate, "任务", "25:99")));
const evCreated = await mock.itemCreate(mockDate, "带时间日程", "09:30");
ok("带时间日程默认 canComplete=false", evCreated.canComplete === false);
ok("带时间日程禁止切换完成态", await throwsAsync(() => mock.itemToggleDone(evCreated.id, mockDate, true)));

const taskForSnap = await mock.itemCreate(mockDate, "快照测试任务", "");
const staleSnap = buildExpectedSnapshot(taskForSnap);
ok("buildExpectedSnapshot 完整保留 calendarId/remoteId/revision",
  staleSnap.calendarId === "mock-cal" && staleSnap.remoteId === taskForSnap.id && Boolean(staleSnap.revision));
await mock.itemUpdate(taskForSnap.id, mockDate, "快照已变更", staleSnap);
ok("过期 expected 快照更新被拒", await throwsAsync(() => mock.itemUpdate(taskForSnap.id, mockDate, "再次修改", staleSnap)));
ok("过期 expected 快照删除被拒", await throwsAsync(() => mock.itemDelete(taskForSnap.id, mockDate, staleSnap)));

const latestItem = (await mock.dayEvents(mockDate)).find(e => e.id === taskForSnap.id);
const revMismatchSnap = { ...buildExpectedSnapshot(latestItem), revision: "rev-stale-999" };
ok("matchesExpectedSnapshot 检测 revision 差异", !matchesExpectedSnapshot(latestItem, revMismatchSnap));
ok("revision 不匹配时 Mock 拒绝更新", await throwsAsync(() => mock.itemUpdate(latestItem.id, mockDate, "漏或错revision", revMismatchSnap)));
const calMismatchSnap = { ...buildExpectedSnapshot(latestItem), calendarId: "other-cal" };
const remMismatchSnap = { ...buildExpectedSnapshot(latestItem), remoteId: "other-remote" };
ok("matchesExpectedSnapshot 检测 calendarId/remoteId 差异",
  !matchesExpectedSnapshot(latestItem, calMismatchSnap) && !matchesExpectedSnapshot(latestItem, remMismatchSnap));

console.log("[搜索纯模块与 Mock 对齐]");
ok("查询归一化折叠全角空格并转小写", normalizeSearchQuery("  GPU\u3000Render  ") === "gpu render");
ok("中英文大小写混合匹配", matchDayItem({ date: "2026-10-12", time: "14:00", title: "GPU 渲染管线调研", kind: "event" }, "gpu 渲染"));
const mockSearchHits = await mock.searchEvents("gpu");
ok("Mock searchEvents 命中 GPU 事项", mockSearchHits.length >= 1 && mockSearchHits[0].title.includes("GPU"));

const manyItems = Array.from({ length: 135 }, (_, i) => ({
  id: `bulk-${i}`,
  date: `2026-10-${String((i % 28) + 1).padStart(2, "0")}`,
  time: "09:00",
  title: `批量检索事项 #${i} Alpha`,
  done: false,
  kind: "item",
}));
const limitedHits = searchDayItems(manyItems, "alpha");
ok("searchDayItems 严格限制 100 条", limitedHits.length === SEARCH_LIMIT, `got ${limitedHits.length}`);
const vmTrunc = buildSearchViewModel(limitedHits, "alpha");
ok("达到 100 条时标记 truncated 并给出提示", vmTrunc.truncated === true && vmTrunc.hint.includes("100"));
const vmNormal = buildSearchViewModel(limitedHits.slice(0, 12), "alpha");
ok("未达上限时不标记截断", vmNormal.truncated === false && vmNormal.count === 12);

console.log("[写入状态、能力位与待确认契约]");
const wsReadOnly = normalizeWriteStatus({ available: false, canCreate: false, canCreateEvent: false, label: "KAL_DB_PATH readonly" });
ok("只读 writeStatus 归一化", wsReadOnly.available === false && !wsReadOnly.hint.includes("KAL_DB_PATH"));
const capsNote = getItemCapabilities({ kind: "note", canEdit: true }, { available: true });
ok("便签始终只读", !capsNote.canEdit && !capsNote.canDelete && !capsNote.canComplete);
const capsEvent = getItemCapabilities({ kind: "event", canEdit: true, canDelete: true, canComplete: false }, { available: true });
ok("显式 canComplete=false 被尊重", capsEvent.canEdit && capsEvent.canDelete && !capsEvent.canComplete);
const capsWhenUnavailable = getItemCapabilities({ kind: "item", canEdit: true, canDelete: true, canComplete: true }, wsReadOnly);
ok("全局不可写时禁用全部单项写入口", !capsWhenUnavailable.canEdit && !capsWhenUnavailable.canDelete && !capsWhenUnavailable.canComplete);

const scrubbed = sanitizeUserMessage("Error: sys_aimcp_token=abcdef1234567890abcdef1234567890 Bearer secret_token_xyz");
ok("错误消息脱敏不泄露凭证", !scrubbed.includes("abcdef123456") && !scrubbed.includes("secret_token_xyz"));

const pendingMock = createMockSource({ requireConfirm: true });
const pendingRes = await pendingMock.itemCreate(mockDate, "待确认任务", "");
const interp = interpretWriteResult(pendingRes);
ok("pending_confirmation 不直接视为已保存", interp.outcome === "pending_confirmation" && interp.pendingId.startsWith("kal-pending-"));
ok("pending 期间禁止并发写入", await throwsAsync(() => pendingMock.itemCreate(mockDate, "并发第二个任务", "")));
const confirmSaved = await pendingMock.itemConfirm(interp.pendingId, true);
ok("点击确认后返回 saved 且数据落盘", confirmSaved.status === "saved" && (await pendingMock.dayEvents(mockDate)).some(e => e.title === "待确认任务"));

const pendingCancelRes = await pendingMock.itemCreate(mockDate, "将被取消的任务", "");
const cancelOut = await pendingMock.itemConfirm(pendingCancelRes.pendingId, false);
ok("点击取消后返回 cancelled 且不落盘", cancelOut.status === "cancelled" && !(await pendingMock.dayEvents(mockDate)).some(e => e.title === "将被取消的任务"));

// 待确认期间外部修改导致快照过期，itemConfirm 执行时必须拒绝覆盖
const targetItem = (await pendingMock.dayEvents(mockDate)).find(e => e.title === "待确认任务");
const pendingSnap = buildExpectedSnapshot(targetItem);
const pendingUpd = await pendingMock.itemUpdate(targetItem.id, mockDate, "确认后新标题", pendingSnap);
pendingMock._touchItemForTest(targetItem.id, { title: "外部并发抢先修改" });
ok("pendingConfirm 确认执行时重检过期快照并拒绝覆盖",
  await throwsAsync(() => pendingMock.itemConfirm(pendingUpd.pendingId, true)));
ok("被拒后外部修改未被覆盖",
  (await pendingMock.dayEvents(mockDate)).find(e => e.id === targetItem.id)?.title === "外部并发抢先修改");

// 未知 status 与缺失 pendingId 防御
const unknownRes = interpretWriteResult({ status: "unexpected_state", message: "异常状态" });
ok("未知 status 不默认当 saved", unknownRes.outcome !== "saved" && unknownRes.invalid === true);
const missingIdPending = interpretWriteResult({ status: "pending_confirmation", summary: "缺少ID" });
ok("pending_confirmation 缺 pendingId 时不进入锁死也不当 saved",
  missingIdPending.outcome !== "pending_confirmation" && missingIdPending.outcome !== "saved" && missingIdPending.reason === "missing_pending_id");
const objSummaryPending = interpretWriteResult({ status: "pending_confirmation", pendingId: "kal-pending-9", summary: { summary: "结构体摘要转文字" } });
ok("pending_confirmation 支持对象或字符串 summary", objSummaryPending.outcome === "pending_confirmation" && objSummaryPending.message.includes("结构体摘要"));

console.log("[外壳 Bridge 禁止静默回落 Mock]");
const recordedCalls = [];
const shellBridge = await createBridge({
  invoke: async (cmd, args) => {
    recordedCalls.push({ cmd, args });
    if (cmd === "app_info") throw new Error("模拟 app_info 异常");
    if (cmd === "search_events") return [];
    if (cmd === "item_update") return { status: "saved" };
    if (cmd === "item_confirm") return { status: "saved" };
    return null;
  },
});
ok("app_info 失败时仍保持 shell 模式不回落 Mock", shellBridge.kind === "shell" && Boolean(shellBridge.bootError));
await shellBridge.searchEvents("会议");
ok("Bridge 转发 search_events", recordedCalls.some(c => c.cmd === "search_events" && c.args.query === "会议"));
const snapSample = buildExpectedSnapshot({ id: "it-1:0", date: mockDate, time: "", title: "旧标题", done: false, kind: "item" });
await shellBridge.itemUpdate("it-1:0", mockDate, "新标题", snapSample);
ok("Bridge 转发 expected 快照", recordedCalls.some(c => c.cmd === "item_update" && c.args.expected?.title === "旧标题"));
await shellBridge.itemConfirm("kal-pending-1", true);
ok("Bridge 转发 item_confirm", recordedCalls.some(c => c.cmd === "item_confirm" && c.args.pendingId === "kal-pending-1" && c.args.accept === true));

const guard = createSeqGuard();
const s1 = guard.next();
const s2 = guard.next();
ok("异步渲染序号守卫丢弃过时结果", !guard.isCurrent(s1) && guard.isCurrent(s2));

console.log("[农历与二十四节气]");
const cSpring = getLunarDay(2026, 2, 17);
ok("2026 春节识别正确且高亮", cSpring.text === "春节" && cSpring.isHighlight && cSpring.festival === "春节");
const cEve = getLunarDay(2026, 2, 16);
ok("2026 除夕识别正确且高亮", cEve.text === "除夕" && cEve.isHighlight && cEve.festival === "除夕");
const cMidAutumn = getLunarDay(2026, 9, 25);
ok("2026 中秋节识别正确且高亮", cMidAutumn.text === "中秋节" && cMidAutumn.isHighlight && cMidAutumn.festival === "中秋节");
const cDuanWu = getLunarDay(2026, 6, 19);
ok("2026 端午节识别正确且高亮", cDuanWu.text === "端午节" && cDuanWu.isHighlight && cDuanWu.festival === "端午节");
const cNational = getLunarDay(2026, 10, 1);
ok("2026 国庆节识别正确且高亮", cNational.text === "国庆节" && cNational.isHighlight && cNational.festival === "国庆节");
const cQingMing = getLunarDay(2026, 4, 5);
ok("2026 清明节识别正确且节气为清明", cQingMing.text === "清明节" && cQingMing.solarTerm === "清明" && cQingMing.isHighlight);
const cQiuFen = getLunarDay(2026, 9, 23);
ok("2026 秋分节气识别正确且高亮", cQiuFen.text === "秋分" && cQiuFen.solarTerm === "秋分" && cQiuFen.isHighlight);
const cHanLu = getLunarDay(2026, 10, 8);
ok("2026 寒露节气识别正确且高亮", cHanLu.text === "寒露" && cHanLu.solarTerm === "寒露" && cHanLu.isHighlight);
const cNormal = getLunarDay(2026, 10, 13);
ok("常规日历显示农历日（非高亮）", cNormal.text === "初四" && !cNormal.isHighlight && cNormal.lunarDay === "初四");
const cFirst = getLunarDay(2026, 11, 9);
ok("农历月初第一天显示月份名称", cFirst.lunarDay === "初一" && cFirst.lunarMonth === "十月");
ok("同一日期缓存复用", getLunarDay(2026, 10, 13) === cNormal);

const hRest = getHolidayBadge(2026, 10, 1);
ok("法定节假日休假角标识别为「休」", hRest?.type === "rest" && hRest?.label === "休" && cNational.holidayBadge === "休");
const hWork = getHolidayBadge(2026, 10, 10);
ok("法定调休补班角标识别为「班」", hWork?.type === "work" && hWork?.label === "班");

const alm260101 = getAlmanac(2026, 1, 1);
ok("黄历干支年/月/日对齐（2026-01-01 为乙巳蛇年戊子月乙亥日）",
  alm260101.gy === "乙巳" && alm260101.zodiac === "蛇" && alm260101.gm === "戊子" && alm260101.gd === "乙亥");
ok("黄历十二建除与宜忌非空",
  alm260101.duty === "闭" && Array.isArray(alm260101.yi) && alm260101.yi.length >= 3 && Array.isArray(alm260101.ji) && alm260101.ji.length >= 2);
ok("黄历六十甲子纳音、冲煞与吉神方位计算正确（乙亥日为山头火、冲蛇煞西）",
  alm260101.nayin === "山头火" && alm260101.chongSha === "冲蛇煞西" && alm260101.positions?.xi === "西北" && alm260101.positions?.cai === "西南");
ok("冬至数九与夏至三伏计算正确",
  getShuJiuOrFu(2026, 1, 1).startsWith("二九") && getShuJiuOrFu(2026, 7, 25).includes("伏"));
const alm260301 = getAlmanac(2026, 3, 1);
ok("立春后干支纪年切换为丙午马年", alm260301.gy === "丙午" && alm260301.zodiac === "马");

const h2028 = getHolidayBadge(2028, 1, 26);
ok("内置 2028 法定节假日排期生效", h2028?.type === "rest" && h2028?.name === "春节");
const parsedHolidayCn = parseHolidayConfig({
  year: 2029,
  days: [
    { name: "元旦", date: "2029-01-01", isOffDay: true },
    { name: "春节", date: "2029-02-10", isOffDay: false },
  ],
});
ok("兼容 NateScarlet/holiday-cn JSON 格式解析",
  parsedHolidayCn["2029-01-01"] === "rest:元旦" && parsedHolidayCn["2029-02-10"] === "work:春节补班");
setCustomHolidays(parsedHolidayCn);
ok("自定义节假日运行时覆盖生效且刷新缓存",
  getLunarDay(2029, 1, 1).holidayBadge === "休" && getLunarDay(2029, 2, 10).holidayBadge === "班");
setCustomHolidays({});
ok("恢复内置节假日后清空自定义覆盖", getHolidayBadge(2029, 1, 1) === null);

const icsSample = buildIcsCalendar([
  { id: "ev-1", date: "2026-10-18", time: "09:30", title: "架构评审", note: "带好材料" },
  { id: "ev-2", date: "2026-10-19", time: "", title: "全天复盘" },
], "Kal 测试日历");
ok("RFC 5545 iCalendar (.ics) 导出格式合规",
  icsSample.includes("BEGIN:VCALENDAR\r\n") &&
  icsSample.includes("DTSTART:20261018T093000\r\n") &&
  icsSample.includes("DTSTART;VALUE=DATE:20261019\r\n") &&
  icsSample.includes("SUMMARY:架构评审\r\n") &&
  icsSample.includes("END:VCALENDAR\r\n"));

const wk42 = getWeekOfYear(new Date(2026, 9, 18), 1);
ok("ISO 周次计算正确（2026-10-18 为第 42 周）", wk42 === 42, `got ${wk42}`);

console.log("[星港素纸默认主题、内容自动换行与日历导出]");
ok("默认主题为星港素纸（浅色暖宣纸 + 靛青正文 + 自动换行）",
  DEFAULT_THEME.name === "星港素纸" &&
  DEFAULT_THEME.mode === "light" &&
  DEFAULT_THEME.color.bg === "#FBF6EC" &&
  DEFAULT_THEME.color.fg === "#172648" &&
  DEFAULT_THEME.layout.taskWrap === "wrap" &&
  DEFAULT_THEME.layout.maxTasks === 4);

ok("CONTENT_PRESETS 包含 4 套日历内容与换行方案", Array.isArray(CONTENT_PRESETS) && CONTENT_PRESETS.length === 4);
const presetClamp2 = applyContentPreset(DEFAULT_THEME, "clamp-2");
const presetSingle = applyContentPreset(DEFAULT_THEME, "compact-single");
const presetStandard = applyContentPreset(presetSingle, "standard-wrap");
ok("applyContentPreset 正确切换自动换行 / 两行精简 / 单行高密",
  presetClamp2.layout.taskWrap === "clamp2" &&
  presetSingle.layout.taskWrap === "nowrap" &&
  presetStandard.layout.taskWrap === "wrap");

const exportDayMap = new Map([
  ["2026-10-01", [
    { id: "e1", date: "2026-10-01", time: "09:30", title: "国庆假期长线架构设计评审与跨模块联调压测", done: true },
    { id: "e2", date: "2026-10-01", time: "", title: "陪伴家人秋游摄影", done: false },
  ]],
  ["2026-10-18", [
    { id: "e3", date: "2026-10-18", time: "14:00", title: "准备导出横向 PDF 与 Markdown 月度计划", done: false },
  ]],
]);

const mdCal = buildMarkdownCalendar({
  year: 2026,
  month: 9,
  weekStart: 1,
  byDay: exportDayMap,
  getLunarDay,
  getGanZhiYear,
  options: { orientation: "landscape", paperSize: "A4" },
});
ok("Markdown 日历导出包含 YAML Frontmatter 与月度统计",
  mdCal.startsWith("---\ntitle: \"2026年10月 日历与日程归档\"") &&
  mdCal.includes("completion_rate: \"33%\"") &&
  mdCal.includes("已完成 **1** 项（**33%**）"));
ok("Markdown 日历导出包含 7 列 GFM 月历网格表与多行 <br> 任务",
  mdCal.includes("| 周一 | 周二 | 周三 | 周四 | 周五 | 周六 | 周日 |") &&
  mdCal.includes("<br>✅ 09:30 国庆假期长线架构设计评审与跨模块联调压测<br>⬜ 陪伴家人秋游摄影") &&
  mdCal.includes("### 📌 2026-10-01") &&
  mdCal.includes("- [x] `09:30` 国庆假期长线架构设计评审与跨模块联调压测"));

const printHtml = buildPrintableCalendarHtml({
  year: 2026,
  month: 9,
  weekStart: 1,
  byDay: exportDayMap,
  getLunarDay,
  getGanZhiYear,
  theme: DEFAULT_THEME,
  options: { orientation: "landscape", paperSize: "A4", marginMm: 6 },
});
ok("PDF/打印 HTML 默认横向 A4 满幅且自动换行",
  printHtml.includes("@page {") &&
  printHtml.includes("size: A4 landscape;") &&
  printHtml.includes("margin: 6mm;") &&
  printHtml.includes("width: 100vw;") &&
  printHtml.includes("height: 100vh;") &&
  printHtml.includes("white-space: pre-wrap;") &&
  printHtml.includes("国庆假期长线架构设计评审与跨模块联调压测"));

console.log("[2026 路线图全量升级：中文自然语言解析、任务装饰、ICS 导入、跨天移动与便签 CRUD]");
const nlp1 = parseNaturalEntry("明天下午3点半 项目评审 !1 #核心", "2026-10-12");
ok("NLP 解析『明天下午3点半 项目评审 !1 #核心』",
  nlp1.date === "2026-10-13" &&
  nlp1.time === "15:30" &&
  nlp1.priority === "high" &&
  nlp1.tags.includes("核心") &&
  nlp1.title.includes("[!高]") &&
  nlp1.title.includes("项目评审"));

const nlp2 = parseNaturalEntry("10月14日至10月16日 早上9点 晨会汇报", "2026-10-12");
ok("NLP 解析跨日区间『10月14日至10月16日 早上9点』",
  nlp2.date === "2026-10-14" &&
  nlp2.time === "09:00" &&
  nlp2.endDate === "2026-10-16" &&
  nlp2.title.includes("[~2026-10-16]"));

const deco = parseTaskDecorations("[~2026-10-20] [!高] 完成跨天拖拽设计 #架构");
ok("parseTaskDecorations 拆解优先级、标签与跨天结束日",
  deco.priority === "high" &&
  deco.tags.length === 1 && deco.tags[0] === "架构" &&
  deco.spanEndDate === "2026-10-20" &&
  deco.isMultiDay === true &&
  deco.cleanTitle === "完成跨天拖拽设计");

ok("addDaysToKey 跨月计算正确", addDaysToKey("2026-10-30", 3) === "2026-11-02");
ok("CELL_HIGHLIGHT_PALETTE 提供 8 组单日背景高亮色", Array.isArray(CELL_HIGHLIGHT_PALETTE) && CELL_HIGHLIGHT_PALETTE.length === 8);

const parsedIcs = parseIcsCalendar(icsSample);
ok("RFC 5545 (.ics) 导入解析器往返还原",
  parsedIcs.length === 2 &&
  parsedIcs[0].date === "2026-10-18" &&
  parsedIcs[0].time === "09:30" &&
  parsedIcs[0].title === "架构评审" &&
  parsedIcs[1].date === "2026-10-19" &&
  parsedIcs[1].time === "" &&
  parsedIcs[1].title === "全天复盘");

const moveSourceDate = "2026-10-15";
const moveTargetDate = "2026-10-16";
const movable = await mock.itemCreate(moveSourceDate, "可跨天移动的任务", "10:00");
const moveRes = await mock.itemMove(movable.id, moveSourceDate, moveTargetDate, buildExpectedSnapshot(movable));
ok("Mock itemMove 跨天移动成功",
  moveRes.status === "saved" &&
  !(await mock.dayEvents(moveSourceDate)).some(e => e.title === "可跨天移动的任务") &&
  (await mock.dayEvents(moveTargetDate)).some(e => e.title === "可跨天移动的任务" && e.time === "10:00"));

const impRes = await mock.calendarImportItems([
  { date: "2026-10-22", time: "14:00", title: "ICS导入日程A" },
  { date: "2026-10-23", time: "", title: "ICS导入任务B" },
]);
ok("Mock calendarImportItems 批量导入成功", impRes.status === "saved" && impRes.imported === 2);

const fallbackBridge = await createBridge({});
const savedNote = await fallbackBridge.noteSave(null, "新建灵感便签", "第一行内容\n第二行内容");
const notesAfterSave = await fallbackBridge.notesList(0);
ok("Bridge noteSave 新建便签成功", notesAfterSave.notes.some(n => n.id === savedNote.id && n.title === "新建灵感便签"));
await fallbackBridge.noteDelete(savedNote.id);
const notesAfterDel = await fallbackBridge.notesList(0);
ok("Bridge noteDelete 删除便签成功", !notesAfterDel.notes.some(n => n.id === savedNote.id));

console.log("[无时间默认速记、强调色快选、多语言与减少动画]");
const nowSeedMonth = await mock.monthEvents(new Date().getFullYear(), new Date().getMonth());
ok("Mock 默认种子安排均不強制带时间且可勾选完成",
  nowSeedMonth.filter(x => /^mock-\d+-\d+$/.test(x.id)).every(x => x.time === "" && x.canComplete === true));
ok("ACCENT_SWATCHES 提供 8 组精选强调色且 applyAccentSwatch 联动更新焦点与今日高亮",
  Array.isArray(ACCENT_SWATCHES) && ACCENT_SWATCHES.length === 8 &&
  applyAccentSwatch(DEFAULT_THEME, "claude-clay").color.accent === "#D97757" &&
  applyAccentSwatch(DEFAULT_THEME, "claude-clay").color.todayRing === "#D97757");
ok("I18N_BUNDLES 完整支持 zh-CN / zh-TW / en 三语词典",
  Boolean(I18N_BUNDLES["zh-CN"] && I18N_BUNDLES["zh-TW"] && I18N_BUNDLES["en"]));

console.log(`\n  结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);


