import assert from "node:assert/strict";
import {
  createDefaultConfig, validateConfig, zonePixelRect, calendarContentRect,
  updateZoneRect, addZone, removeZone,
  getLayoutMetrics, zoneWorkRect, updateZonePixels, snapZoneRect, constrainZoneRect, fitLayoutToMargins,
  COMPOSITION_PRESETS, getCompositionInfo,
} from "./src/desktop-zones-model.js";

let passed = 0;
function test(name, run) { run(); passed++; console.log(`PASS ${name}`); }
const display = { monitor: "main", rect: [0, 0, 1920, 1080], work: [0, 0, 1920, 1040], dpiScale: 1 };
const base = createDefaultConfig(display);
const hasError = (config, text, screen = display) => assert.ok(validateConfig(config, screen).some((error) => error.includes(text)));

test("three presets and practical screen sizes produce valid templates", () => {
  for (const screen of [display,
    { monitor: "portrait", rect: [0, 0, 1080, 1920], work: [0, 0, 1080, 1880], dpiScale: 1.25 },
    { monitor: "narrow", rect: [0, 0, 512, 1200], work: [0, 0, 512, 1160], dpiScale: 1 },
    { monitor: "4k", rect: [0, 0, 3840, 2160], work: [0, 0, 3840, 2080], dpiScale: 2 },
  ]) for (const preset of ["right", "left", "portrait"]) {
    assert.deepEqual(validateConfig(createDefaultConfig(screen, preset), screen), []);
  }
  const left = createDefaultConfig(display, "left");
  assert.ok(left.zones[0].x < left.zones[1].x);
  assert.ok(base.zones[0].x > base.zones[1].x);
});

test("negative-origin displays and taskbar offsets map to canvas pixels", () => {
  const screen = { monitor: "left", rect: [-1600, -200, 0, 700], work: [-1560, -170, 0, 650], dpiScale: 1.5 };
  assert.deepEqual(zonePixelRect({ x: 0, y: 0, width: 1, height: 1 }, screen), { x: 40, y: 30, width: 1560, height: 820 });
  const config = createDefaultConfig(screen);
  const rect = zonePixelRect(config.zones[0], screen);
  const content = calendarContentRect(config, screen);
  assert.equal(content.x, rect.x + 15);
  assert.equal(content.y, rect.y + 45);
  assert.equal(content.width, rect.width - 30);
  assert.equal(content.height, rect.height - 60);
});

test("bounds, overlaps, count, kinds and unique ids are validated", () => {
  const config = structuredClone(base);
  config.zones[1].x = -0.1;
  hasError(config, "超出");
  config.zones[1] = { ...config.zones[0], kind: "files" };
  hasError(config, "重叠");
  hasError(config, "重复");
  config.zones[1].kind = "unknown";
  hasError(config, "类型");
  config.zones[1].kind = "calendar";
  hasError(config, "恰好");
  hasError({ ...base, zones: [base.zones[0]] }, "数量");
  hasError({ ...base, zones: Array(9).fill(base.zones[0]) }, "数量");
});

test("calendar has exact minimum content size and impossible displays report it", () => {
  const config = updateZoneRect(base, "calendar", { width: 480 / 1920, height: 400 / 1040 }, display);
  assert.equal(calendarContentRect(config, display).width, 460);
  assert.equal(calendarContentRect(config, display).height, 360);
  assert.ok(!validateConfig(config, display).some((error) => error.includes("日历内容")));
  hasError(updateZoneRect(config, "calendar", { width: 0.1 }, display), "日历内容");
  const tiny = { monitor: "tiny", rect: [0, 0, 400, 300], work: [0, 0, 400, 280], dpiScale: 1 };
  hasError(createDefaultConfig(tiny), "日历内容", tiny);
});

test("150 percent DPI requires 690 by 540 content pixels", () => {
  const screen = { ...display, dpiScale: 1.5 };
  let config = createDefaultConfig(screen);
  assert.deepEqual(validateConfig(config, screen), []);
  config = updateZoneRect(config, "calendar", { width: 710 / 1920, height: 600 / 1040 }, screen);
  assert.equal(calendarContentRect(config, screen).width, 680);
  hasError(config, "日历内容", screen);
  config = updateZoneRect(config, "calendar", { width: 720 / 1920 }, screen);
  assert.equal(calendarContentRect(config, screen).width, 690);
  assert.deepEqual(validateConfig(config, screen), []);
  hasError(updateZoneRect(config, "calendar", { height: 590 / 1040 }, screen), "日历内容", screen);
});

test("work area must remain inside monitor rectangle and monitors have string ids", () => {
  for (const work of [[-1, 0, 1920, 1040], [0, -1, 1920, 1040], [0, 0, 1921, 1040], [0, 0, 1920, 1081]]) {
    const screen = { ...display, work };
    hasError(base, "工作区域", screen);
    assert.equal(zonePixelRect(base.zones[0], screen), null);
  }
  hasError({ ...base, monitor: 1 }, "显示器", { ...display, monitor: 1 });
});

test("malformed geometry and settings produce errors without throwing", () => {
  for (const value of [NaN, Infinity, "0.5", null]) {
    const config = structuredClone(base);
    config.zones[1].x = value;
    hasError(config, "有限数值");
  }
  hasError({ ...base, panelOpacity: NaN }, "透明度");
  hasError({ ...base, fit: "bad" }, "适配");
  hasError({ ...base, panelStyle: "bad" }, "样式");
  hasError({ ...base, monitor: "missing" }, "显示器");
  hasError({ ...base, zones: null }, "列表");
  hasError({ ...base, zones: [null, base.zones[0]] }, "无效");
  const config = structuredClone(base);
  config.zones[1].label = "长".repeat(25);
  hasError(config, "24");
  assert.ok(validateConfig(base, { ...display, dpiScale: 0 }).length);
  assert.equal(calendarContentRect({ zones: [] }, display), null);
});

test("geometry edits clamp, preserve overlap errors, and never mutate input", () => {
  const snapshot = JSON.stringify(base);
  const changed = updateZoneRect(base, "software", { x: -5, y: 5, width: 0.01, height: 3, label: "ignored" }, display);
  assert.deepEqual(changed.zones[1], { ...base.zones[1], x: 0, y: 0, width: 0.1, height: 1 });
  const overlap = updateZoneRect(base, "software", base.zones[0], display);
  hasError(overlap, "重叠");
  assert.equal(JSON.stringify(base), snapshot);
  assert.notEqual(changed.zones[0], base.zones[0]);
});

test("add finds free space including exact fits and enforces the eight-zone cap", () => {
  const sparse = { ...base, zones: [
    { ...base.zones[0], x: 0, y: 0, width: 0.5, height: 0.8 },
    { ...base.zones[1], x: 0.5, y: 0, width: 0.5, height: 0.8 },
  ] };
  const snapshot = JSON.stringify(sparse);
  let added = addZone(sparse);
  assert.equal(added.zones.length, 3);
  assert.deepEqual(validateConfig(added, display), []);
  assert.equal(JSON.stringify(sparse), snapshot);
  let next;
  while ((next = addZone(added, "software"))) added = next;
  assert.ok(added.zones.length <= 8);
  assert.equal(addZone({ ...added, zones: Array(8).fill(added.zones[0]) }), null);
  assert.equal(addZone(sparse, "calendar"), null);
  const exact = { ...base, zones: [
    { ...base.zones[0], x: 0, y: 0, width: 0.9, height: 1 },
    { ...base.zones[1], x: 0.9, y: 0, width: 0.1, height: 0.9 },
  ] };
  assert.ok(addZone(exact));
  assert.equal(addZone({ ...base, zones: [{ ...base.zones[0], x: 0, y: 0, width: 1, height: 1 }] }), null);
});

test("remove preserves calendar and minimum count without mutating input", () => {
  const snapshot = JSON.stringify(base);
  assert.equal(removeZone(base, "calendar").zones.length, 3);
  const two = removeZone(base, "files");
  assert.equal(two.zones.length, 2);
  assert.equal(removeZone(two, "software").zones.length, 2);
  assert.equal(JSON.stringify(base), snapshot);
});

test("icon spacing creates exact physical margins and compact-screen fallback stays usable", () => {
  for (const [spacing, scale] of [[[75, 90], 1], [[96, 96], 1], [[144, 150], 1.5]]) {
    const screen = { ...display, dpiScale: scale, iconSpacing: spacing };
    const metrics = getLayoutMetrics(screen);
    assert.equal(metrics.iconX, spacing[0]); assert.equal(metrics.iconY, spacing[1]);
    for (const preset of ["right", "left", "portrait"]) {
      const config = createDefaultConfig(screen, preset);
      const rects = config.zones.map(zone => zoneWorkRect(zone, screen));
      assert.equal(Math.min(...rects.map(rect => rect.x)), spacing[0]);
      assert.equal(Math.min(...rects.map(rect => rect.y)), spacing[1]);
      assert.equal(Math.max(...rects.map(rect => rect.x + rect.width)), 1920 - spacing[0]);
      assert.ok(Math.max(...rects.map(rect => rect.y + rect.height)) <= 1040 - spacing[1]);
      assert.deepEqual(validateConfig(config, screen), []);
    }
  }
  assert.equal(getLayoutMetrics({ ...display, dpiScale: 1.5 }).iconX, 144);
  const small = { monitor: "small", rect: [-512, 0, 0, 1200], work: [-512, 0, 0, 1160], dpiScale: 1, iconSpacing: [96, 96] };
  const config = createDefaultConfig(small);
  assert.deepEqual(validateConfig(config, small), []);
  assert.equal(zoneWorkRect(config.zones[0], small).x, 16);
});

test("pixel edits round-trip exactly one pixel without changing size or source", () => {
  for (const screen of [display, { ...display, rect: [-1920, -1080, 0, 0], work: [-1880, -1040, 0, -40], dpiScale: 1.5 }]) {
    const config = createDefaultConfig(screen), snapshot = JSON.stringify(config);
    const original = zoneWorkRect(config.zones[1], screen);
    const moved = updateZonePixels(config, "software", { x: original.x + 1 }, screen, { mode: "move" });
    assert.deepEqual(moved.rect, { ...original, x: original.x + 1 });
    const back = updateZonePixels(moved.config, "software", { x: original.x }, screen, { mode: "move" });
    assert.deepEqual(zoneWorkRect(back.config.zones[1], screen), original);
    assert.equal(JSON.stringify(config), snapshot);
  }
});

test("large moves stop at the first panel and cannot tunnel through it", () => {
  const source = zoneWorkRect(base.zones[1], display), calendar = zoneWorkRect(base.zones[0], display);
  const moved = updateZonePixels(base, "software", { x: 1700 }, display, { mode: "move" });
  assert.equal(moved.rect.x + moved.rect.width, calendar.x);
  assert.equal(moved.rect.width, source.width); assert.equal(moved.rect.height, source.height);
  assert.equal(moved.blocked, true);
  assert.deepEqual(validateConfig(moved.config, display), []);
  const beyond = constrainZoneRect(base, "software", { ...source, y: 900 }, display, { mode: "move" });
  assert.equal(beyond.y + beyond.height, zoneWorkRect(base.zones[2], display).y);
});

test("resize holds the opposite edge, stops at neighbours and enforces calendar minimum", () => {
  const original = zoneWorkRect(base.zones[1], display);
  const enlarged = updateZonePixels(base, "software", { width: 1500 }, display, { mode: "resize", edges: "e" });
  assert.equal(enlarged.rect.x, original.x); assert.equal(enlarged.rect.y, original.y);
  assert.equal(enlarged.rect.x + enlarged.rect.width, zoneWorkRect(base.zones[0], display).x);
  const corner = updateZonePixels(base, "software", { x: original.x + 11, y: original.y + 9 }, display, { mode: "resize", edges: "nw" });
  assert.equal(corner.rect.x + corner.rect.width, original.x + original.width);
  assert.equal(corner.rect.y + corner.rect.height, original.y + original.height);
  const minimum = updateZonePixels(base, "calendar", { width: 1, height: 1 }, display, { mode: "resize", edges: "se" });
  assert.equal(minimum.rect.width, 480); assert.equal(minimum.rect.height, 400);
  assert.deepEqual(validateConfig(minimum.config, display), []);
});

test("snapping respects its physical threshold and does not change move dimensions", () => {
  const sparse = { ...base, zones: [
    { ...base.zones[0], x: 0.5, y: 0.5, width: 0.4, height: 0.4 },
    { ...base.zones[1], x: 0.1, y: 0.1, width: 0.15, height: 0.2 },
  ] };
  const source = zoneWorkRect(sparse.zones[1], display);
  const near = snapZoneRect(sparse, "software", { ...source, x: 103 }, display, { mode: "move", threshold: 8, marginIcons: 1 });
  assert.equal(near.rect.x, 96); assert.equal(near.rect.width, source.width);
  assert.ok(near.guides.some(guide => guide.axis === "x" && guide.value === 96));
  const far = snapZoneRect(sparse, "software", { ...source, x: 105 }, display, { mode: "move", threshold: 8, marginIcons: 1 });
  assert.equal(far.rect.x, 105);
  const edge = snapZoneRect(sparse, "software", { ...source, x: -50 }, display, { mode: "move", threshold: 8 });
  assert.equal(edge.rect.x, 0); assert.equal(edge.rect.width, source.width);
  const free = updateZonePixels(sparse, "software", { x: 103 }, display, { mode: "move", snap: false });
  assert.equal(free.rect.x, 103);
});

test("snapping an east edge keeps west edge fixed and aligns neighbour gap", () => {
  const tight = createDefaultConfig(display, "right", { composition: "compact" });
  const calendar = zoneWorkRect(tight.zones[0], display);
  tight.zones[1].width = (calendar.x - getLayoutMetrics(display).gap - zoneWorkRect(tight.zones[1], display).x) / 1920;
  const source = zoneWorkRect(tight.zones[1], display);
  const snapped = snapZoneRect(tight, "software", { ...source, width: source.width - 5 }, display, { mode: "resize", edges: "e", threshold: 8 });
  assert.equal(snapped.rect.x, source.x); assert.equal(snapped.rect.width, source.width);
  assert.ok(snapped.guides.some(guide => guide.axis === "x" && guide.kind === "gap"));
});

test("composition presets retain scenery while compact adapts small logical workspaces", () => {
  assert.deepEqual(COMPOSITION_PRESETS.map(item => item.id), ["balanced", "scenic", "compact"]);
  const balanced = createDefaultConfig(display), scenic = createDefaultConfig(display, "right", { composition: "scenic" });
  const balancedRects = balanced.zones.map(zone => zoneWorkRect(zone, display));
  const scenicRects = scenic.zones.map(zone => zoneWorkRect(zone, display));
  const metrics = getLayoutMetrics(display), safeHeight = metrics.workHeight - 2 * metrics.iconY;
  assert.ok(balancedRects[0].height < safeHeight);
  assert.ok(scenicRects[0].height < balancedRects[0].height);
  assert.ok(scenicRects[0].x - scenicRects[1].x - scenicRects[1].width >
    balancedRects[0].x - balancedRects[1].x - balancedRects[1].width);
  assert.ok(balancedRects[2].y - balancedRects[1].y - balancedRects[1].height > metrics.gap);
  const small = { ...display, rect: [0, 0, 1366, 768], work: [0, 0, 1366, 718], dpiScale: 1.25 };
  assert.equal(getCompositionInfo(small, "scenic").effective, "compact");
  assert.ok(getCompositionInfo(small, "scenic").hint.includes("可读性"));
  assert.equal(getCompositionInfo(display).effective, "balanced");
});

test("synthetic monitor matrix preserves readability, safe margins, and integer pixel geometry", () => {
  const screens = [];
  for (const [name, inches, width, height, scales] of [
    ["24-FHD", 24, 1920, 1080, [1, 1.25, 1.5]],
    ["27-FHD", 27, 1920, 1080, [1, 1.25]],
    ["27-QHD", 27, 2560, 1440, [1, 1.25, 1.5]],
    ["27-4K", 27, 3840, 2160, [1.5, 2]],
    ["small-HD", 15.6, 1366, 768, [1, 1.25]],
    ["24-portrait", 24, 1080, 1920, [1, 1.25, 1.5]],
  ]) for (const dpiScale of scales) {
    const title = `${name}-${dpiScale}`;
    const taskbar = Math.round(40 * dpiScale), icon = Math.round(75 * dpiScale);
    screens.push({ monitor: title, diagonalIn: inches, rect: [-width, -120, 0, height - 120],
      work: [-width, -120, 0, height - taskbar - 120], dpiScale, iconSpacing: [icon, icon] });
  }
  for (const screen of screens) for (const preset of ["right", "left", "portrait"]) for (const composition of COMPOSITION_PRESETS) {
    const config = createDefaultConfig(screen, preset, { composition: composition.id });
    assert.deepEqual(validateConfig(config, screen), [], `${screen.monitor} ${preset} ${composition.id}`);
    const metrics = getLayoutMetrics(screen), rects = config.zones.map(zone => zoneWorkRect(zone, screen));
    assert.ok(rects.every(rect => Object.values(rect).every(Number.isInteger)));
    assert.ok(rects.every(rect => rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= metrics.workWidth && rect.y + rect.height <= metrics.workHeight));
    const body = calendarContentRect(config, screen);
    assert.ok(body.width >= 460 * screen.dpiScale && body.height >= 360 * screen.dpiScale);
    const zone = config.zones[0], rect = zonePixelRect(zone, screen);
    assert.equal(body.x + screen.rect[0], screen.work[0] + Math.round(zone.x * metrics.workWidth) + Math.round(10 * screen.dpiScale));
    assert.equal(body.y + screen.rect[1], screen.work[1] + Math.round(zone.y * metrics.workHeight) + Math.round(30 * screen.dpiScale));
    assert.equal(rect.width, Math.round((zone.x + zone.width) * metrics.workWidth) - Math.round(zone.x * metrics.workWidth));
    // All requested consumer monitor fixtures have room for one full icon band.
    assert.ok(Math.min(...rects.map(rect => rect.x)) >= metrics.iconX);
    assert.ok(Math.min(...rects.map(rect => rect.y)) >= metrics.iconY);
    assert.ok(Math.max(...rects.map(rect => rect.x + rect.width)) <= metrics.workWidth - metrics.iconX);
    assert.ok(Math.max(...rects.map(rect => rect.y + rect.height)) <= metrics.workHeight - metrics.iconY);
  }
  const physicalA = { ...display, diagonalIn: 24 }, physicalB = { ...display, diagonalIn: 27 };
  assert.deepEqual(createDefaultConfig(physicalA).zones, createDefaultConfig(physicalB).zones,
    "same pixel workspace and scale must not be distorted by an inch-size guess");
});

test("preserving scenery only shrinks or translates an existing composition", () => {
  const scenic = createDefaultConfig(display, "right", { composition: "scenic" });
  const before = JSON.stringify(scenic);
  const untouched = fitLayoutToMargins(scenic, display, 1, { preserveBreathingRoom: true });
  assert.equal(untouched.error, null); assert.equal(JSON.stringify(untouched.config), before);
  const fitted = fitLayoutToMargins(scenic, display, 2, { preserveBreathingRoom: true });
  assert.equal(fitted.error, null);
  const beforeRect = zoneWorkRect(scenic.zones[0], display), afterRect = zoneWorkRect(fitted.config.zones[0], display);
  assert.ok(afterRect.width <= beforeRect.width && afterRect.height <= beforeRect.height);
  assert.deepEqual(validateConfig(fitted.config, display), []);
  assert.equal(JSON.stringify(scenic), before);
});

test("one-click margins preserve labels and appearance, reject undersized result immutably", () => {
  const full = createDefaultConfig(display, "left", { marginIcons: 0 });
  full.zones[1].label = "常用软件"; full.panelStyle = "dark"; full.panelOpacity = 0.61;
  const original = JSON.stringify(full);
  const fitted = fitLayoutToMargins(full, { ...display, iconSpacing: [75, 90] }, 1);
  assert.equal(fitted.error, null); assert.equal(fitted.config.zones[1].label, "常用软件");
  assert.equal(fitted.config.panelStyle, "dark"); assert.equal(fitted.config.panelOpacity, 0.61);
  const rects = fitted.config.zones.map(zone => zoneWorkRect(zone, display));
  assert.equal(Math.min(...rects.map(rect => rect.x)), 75);
  assert.equal(Math.min(...rects.map(rect => rect.y)), 90);
  assert.equal(JSON.stringify(full), original);
  const narrow = { monitor: "narrow", rect: [0, 0, 512, 1200], work: [0, 0, 512, 1160], dpiScale: 1 };
  const narrowConfig = createDefaultConfig(narrow), before = JSON.stringify(narrowConfig);
  const rejected = fitLayoutToMargins(narrowConfig, narrow, 1);
  assert.ok(rejected.error); assert.equal(JSON.stringify(rejected.config), before);
  assert.equal(JSON.stringify(narrowConfig), before);
});

console.log(`${passed} desktop zone model tests passed`);
