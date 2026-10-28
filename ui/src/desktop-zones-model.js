// Geometry is normalized to the monitor work area; pixels are canvas-relative.
const MIN_SIZE = 0.1;
const EPSILON = 1e-9;
const KINDS = ["calendar", "software", "files"];
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const copy = (config) => ({ ...config, zones: (config.zones || []).map((zone) => ({ ...zone })) });

function validDisplay(display) {
  return display && typeof display.monitor === "string" && display.monitor.trim() && [display.rect, display.work].every((rect) =>
    Array.isArray(rect) && rect.length === 4 && rect.every(finite) &&
    rect[2] > rect[0] && rect[3] > rect[1]) &&
    finite(display.dpiScale) && display.dpiScale > 0 &&
    display.work[0] >= display.rect[0] && display.work[1] >= display.rect[1] &&
    display.work[2] <= display.rect[2] && display.work[3] <= display.rect[3];
}

function overlaps(a, b) {
  return a.x < b.x + b.width - EPSILON && b.x < a.x + a.width - EPSILON &&
    a.y < b.y + b.height - EPSILON && b.y < a.y + a.height - EPSILON;
}

function hasGeometry(zone) {
  return zone && [zone.x, zone.y, zone.width, zone.height].every(finite);
}

export function zoneWorkRect(zone, display) {
  if (!validDisplay(display) || !hasGeometry(zone)) return null;
  const [left, top, right, bottom] = display.work;
  const x = Math.round(zone.x * (right - left));
  const y = Math.round(zone.y * (bottom - top));
  return {
    x, y,
    width: Math.round((zone.x + zone.width) * (right - left)) - x,
    height: Math.round((zone.y + zone.height) * (bottom - top)) - y,
  };
}

export function zonePixelRect(zone, display) {
  const rect = zoneWorkRect(zone, display);
  return rect && { ...rect, x: rect.x + display.work[0] - display.rect[0], y: rect.y + display.work[1] - display.rect[1] };
}

export function getLayoutMetrics(display) {
  const usable = validDisplay(display);
  const scale = usable ? display.dpiScale : 1;
  const spacing = display?.iconSpacing;
  return {
    workWidth: usable ? display.work[2] - display.work[0] : 1920,
    workHeight: usable ? display.work[3] - display.work[1] : 1040,
    iconX: Math.round(Array.isArray(spacing) && finite(spacing[0]) && spacing[0] > 0 ? spacing[0] : 96 * scale),
    iconY: Math.round(Array.isArray(spacing) && finite(spacing[1]) && spacing[1] > 0 ? spacing[1] : 96 * scale),
    gap: Math.max(1, Math.round(16 * scale)),
  };
}

function minimumPixels(zone, display) {
  const { workWidth, workHeight } = getLayoutMetrics(display);
  const scale = validDisplay(display) ? display.dpiScale : 1;
  const inset = Math.round(10 * scale), title = Math.round(30 * scale);
  return {
    width: Math.max(Math.ceil(MIN_SIZE * workWidth), zone?.kind === "calendar" ? Math.ceil(460 * scale) + 2 * inset : 1),
    height: Math.max(Math.ceil(MIN_SIZE * workHeight), zone?.kind === "calendar" ? Math.ceil(360 * scale) + inset + title : 1),
  };
}

function normalizedRect(rect, display) {
  const { workWidth, workHeight } = getLayoutMetrics(display);
  return { x: rect.x / workWidth, y: rect.y / workHeight, width: rect.width / workWidth, height: rect.height / workHeight };
}

export function calendarContentRect(config, display) {
  const zone = config?.zones?.find((item) => item?.kind === "calendar");
  const rect = zonePixelRect(zone, display);
  if (!rect) return null;
  const inset = Math.round(10 * display.dpiScale);
  const title = Math.round(30 * display.dpiScale);
  return { x: rect.x + inset, y: rect.y + title,
    width: rect.width - 2 * inset, height: rect.height - inset - title };
}

export const COMPOSITION_PRESETS = Object.freeze([
  { id: "balanced", label: "均衡分区", description: "日历与图标区分明，保留适当壁纸留景" },
  { id: "scenic", label: "疏朗留景", description: "缩小图标底板，保留更多壁纸画面" },
  { id: "compact", label: "紧凑适配", description: "优先保证小屏与高缩放下的日历空间" },
]);

function compositionPlan(display, preset, marginIcons, composition) {
  const { workWidth: W, workHeight: H, iconX, iconY, gap } = getLayoutMetrics(display);
  const calendarMin = minimumPixels({ kind: "calendar" }, display);
  const otherMin = minimumPixels({ kind: "files" }, display);
  const scale = validDisplay(display) ? display.dpiScale : 1;
  const margin = finite(marginIcons) ? clamp(marginIcons, 0, 2) : 1;
  const requested = ["right", "left", "portrait"].includes(preset) ? preset : "right";
  const id = COMPOSITION_PRESETS.some(item => item.id === composition) ? composition : "balanced";
  const logicalWidth = W / scale, logicalHeight = H / scale;
  // Layout responds to usable logical space, not an assumed resolution for a given inch size.
  const recommended = Math.min(logicalWidth, logicalHeight) < 640 || Math.max(logicalWidth, logicalHeight) < 1180 ? "compact" : "balanced";
  const effective = recommended === "compact" ? "compact" : id;
  const choices = [requested, requested === "portrait" ? "right" : "portrait"].map(layout => {
    const requiredW = layout === "portrait" ? Math.max(calendarMin.width, 2 * otherMin.width + gap) : calendarMin.width + gap + otherMin.width;
    const requiredH = layout === "portrait" ? calendarMin.height + gap + otherMin.height : Math.max(calendarMin.height, 2 * otherMin.height + gap);
    const mx = Math.max(0, Math.min(Math.round(iconX * margin), Math.floor((W - requiredW) / 2)));
    const my = Math.max(0, Math.min(Math.round(iconY * margin), Math.floor((H - requiredH) / 2)));
    return { layout, mx, my, fits: W >= requiredW && H >= requiredH,
      fullMargin: mx === Math.round(iconX * margin) && my === Math.round(iconY * margin) };
  });
  const choice = choices.find(item => item.fits && item.fullMargin) || choices.find(item => item.fits) || choices[0];
  return { ...choice, id, effective, recommended, logicalWidth, logicalHeight,
    marginReduced: choice.mx < Math.round(iconX * margin) || choice.my < Math.round(iconY * margin),
    W, H, iconX, iconY, gap, calendarMin, otherMin, scale };
}

export function getCompositionInfo(display, composition = "balanced") {
  const metrics = getLayoutMetrics(display);
  const natural = metrics.workHeight > metrics.workWidth ? "portrait" : "right";
  const plan = compositionPlan(display, natural, 1, composition);
  const preset = COMPOSITION_PRESETS.find(item => item.id === plan.id);
  const adapted = plan.effective !== plan.id;
  return {
    id: plan.id, label: preset.label, description: preset.description,
    effective: plan.effective, recommended: plan.recommended,
    logicalWidth: Math.round(plan.logicalWidth), logicalHeight: Math.round(plan.logicalHeight),
    marginReduced: plan.marginReduced,
    hint: adapted ? "当前屏幕或缩放下可用空间较小，已优先保证日历可读性" :
      plan.marginReduced ? "已按可用空间适当减少留白，保证日历最低尺寸" : preset.description,
  };
}

function iconPanelHeight(target, minimum, maximum, iconY, scale) {
  const title = Math.round(32 * scale);
  const rows = Math.max(1, Math.round((target - title) / iconY));
  return clamp(title + rows * iconY, minimum, maximum);
}

export function createDefaultConfig(display, preset = "right", { marginIcons = 1, composition = "balanced" } = {}) {
  const plan = compositionPlan(display, preset, marginIcons, composition);
  const { W, H, calendarMin, otherMin, iconY, scale, effective } = plan;
  const gap = plan.gap;
  const { layout, mx, my } = plan;
  const width = Math.max(1, W - 2 * mx), height = Math.max(1, H - 2 * my);
  const airy = effective === "scenic", compact = effective === "compact";
  let rectangles;
  if (layout === "portrait") {
    const calendarH = Math.max(1, Math.min(height - gap - otherMin.height,
      Math.max(calendarMin.height, Math.round(height * (compact ? 0.64 : airy ? 0.51 : 0.56)))));
    const rowEnd = my + (compact ? height : Math.max(calendarH + gap + otherMin.height, Math.round(height * 0.95)));
    const rowH = Math.max(1, iconPanelHeight(height * (compact ? 0.28 : airy ? 0.19 : 0.23), otherMin.height,
      Math.max(1, rowEnd - my - calendarH - gap), iconY, scale));
    const rowGap = Math.min(Math.max(gap, Math.round(width * (airy ? 0.08 : 0.04))), Math.max(gap, width - 2 * otherMin.width));
    const half = Math.max(1, Math.floor((width - rowGap) / 2));
    rectangles = [
      { x: mx, y: my, width, height: calendarH },
      { x: mx, y: rowEnd - rowH, width: half, height: rowH },
      { x: mx + half + rowGap, y: rowEnd - rowH, width: Math.max(1, width - half - rowGap), height: rowH },
    ];
  } else {
    const calendarW = Math.max(1, Math.min(width - gap - otherMin.width,
      Math.max(calendarMin.width, Math.round(width * (compact ? 0.56 : airy ? 0.48 : 0.52)))));
    const columnGap = Math.min(Math.max(gap, Math.round(width * (compact ? 0.025 : airy ? 0.10 : 0.045))), Math.max(gap, width - calendarW - otherMin.width));
    const otherW = Math.max(1, width - calendarW - columnGap);
    const calendarH = Math.max(calendarMin.height, Math.min(height, Math.round(height * (compact ? 1 : airy ? 0.84 : 0.92))));
    const softwareH = Math.max(1, iconPanelHeight(height * (compact ? 0.44 : airy ? 0.27 : 0.34), otherMin.height,
      Math.max(1, calendarH - gap - otherMin.height), iconY, scale));
    const filesH = Math.max(1, iconPanelHeight(height * (compact ? 0.44 : airy ? 0.34 : 0.42), otherMin.height,
      Math.max(1, calendarH - gap - softwareH), iconY, scale));
    const cx = layout === "left" ? mx : mx + width - calendarW, ox = layout === "left" ? mx + calendarW + columnGap : mx;
    rectangles = [
      { x: cx, y: my, width: calendarW, height: Math.max(1, calendarH) },
      { x: ox, y: my, width: otherW, height: softwareH },
      { x: ox, y: my + calendarH - filesH, width: otherW, height: filesH },
    ];
  }
  const zones = rectangles.map((rect, index) => ({ id: KINDS[index], kind: KINDS[index], label: ["日历", "软件", "文件"][index], ...normalizedRect(rect, display) }));
  return { schema: 1, monitor: display?.monitor ?? "", sourcePath: "", fit: "cover", panelStyle: "auto", panelOpacity: 0.72, zones };
}

export function validateConfig(config, display) {
  const errors = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) return ["分区配置无效"];
  if (config.schema !== 1) errors.push("不支持的配置版本");
  if (!validDisplay(display)) errors.push("显示器工作区域或缩放比例无效");
  if (typeof config.monitor !== "string" || !config.monitor.trim() || config.monitor !== display?.monitor) errors.push("配置与当前显示器不匹配");
  if (typeof config.sourcePath !== "string") errors.push("壁纸路径必须是文本");
  if (!["cover", "contain", "stretch"].includes(config.fit)) errors.push("壁纸适配方式无效");
  if (!["auto", "light", "dark"].includes(config.panelStyle)) errors.push("面板样式无效");
  if (!finite(config.panelOpacity) || config.panelOpacity < 0 || config.panelOpacity > 1) errors.push("面板透明度必须在 0 到 1 之间");
  if (!Array.isArray(config.zones)) return [...errors, "分区列表无效"];
  if (config.zones.length < 2 || config.zones.length > 8) errors.push("分区数量必须为 2 到 8 个");
  if (config.zones.filter((zone) => zone?.kind === "calendar").length !== 1) errors.push("必须恰好保留一个日历分区");
  const ids = new Set();
  config.zones.forEach((zone, index) => {
    const name = `第 ${index + 1} 个分区`;
    if (!zone || typeof zone !== "object") { errors.push(`${name}无效`); return; }
    if (typeof zone.id !== "string" || !zone.id.trim() || ids.has(zone.id)) errors.push(`${name}标识为空或重复`);
    ids.add(zone.id);
    if (!KINDS.includes(zone.kind)) errors.push(`${name}类型无效`);
    if (typeof zone.label !== "string" || [...zone.label].length > 24) errors.push(`${name}标签最多为 24 个字符`);
    if (!hasGeometry(zone)) { errors.push(`${name}坐标和尺寸必须为有限数值`); return; }
    if (zone.width < MIN_SIZE - EPSILON || zone.height < MIN_SIZE - EPSILON) errors.push(`${name}宽高不能小于工作区域的 10%`);
    if (zone.x < 0 || zone.y < 0 || zone.x + zone.width > 1 + EPSILON || zone.y + zone.height > 1 + EPSILON) errors.push(`${name}超出显示器工作区域`);
    for (let previous = 0; previous < index; previous++) {
      if (hasGeometry(config.zones[previous]) && overlaps(zone, config.zones[previous])) errors.push(`${name}与第 ${previous + 1} 个分区重叠`);
    }
  });
  const content = calendarContentRect(config, display);
  if (content && (content.width < 460 * display.dpiScale - EPSILON || content.height < 360 * display.dpiScale - EPSILON)) errors.push("日历内容区域至少需要 460 × 360 逻辑像素，请放大日历分区");
  return errors;
}

export function updateZoneRect(config, id, patch, display) {
  const result = copy(config);
  const zone = result.zones.find((item) => item.id === id);
  if (!zone) return result;
  for (const key of ["x", "y", "width", "height"]) {
    if (finite(patch?.[key])) zone[key] = patch[key];
  }
  zone.width = clamp(finite(zone.width) ? zone.width : MIN_SIZE, MIN_SIZE, 1);
  zone.height = clamp(finite(zone.height) ? zone.height : MIN_SIZE, MIN_SIZE, 1);
  zone.x = clamp(finite(zone.x) ? zone.x : 0, 0, 1 - zone.width);
  zone.y = clamp(finite(zone.y) ? zone.y : 0, 0, 1 - zone.height);
  return result;
}

function editingMode(patch, options) {
  return options.mode || (finite(patch?.width) || finite(patch?.height) ? "resize" : "move");
}

function boundedRect(original, proposed, zone, display, options) {
  const { workWidth: W, workHeight: H } = getLayoutMetrics(display);
  const minimum = minimumPixels(zone, display);
  const minW = Math.min(W, minimum.width), minH = Math.min(H, minimum.height);
  if (editingMode(proposed, options) === "move") return {
    ...original,
    x: clamp(Math.round(finite(proposed.x) ? proposed.x : original.x), 0, Math.max(0, W - original.width)),
    y: clamp(Math.round(finite(proposed.y) ? proposed.y : original.y), 0, Math.max(0, H - original.height)),
  };
  const edges = options.edges || "se";
  let left = original.x, top = original.y, right = left + original.width, bottom = top + original.height;
  if (edges.includes("w")) left = clamp(Math.round(finite(proposed.x) ? proposed.x : right - proposed.width), 0, right - minW);
  if (edges.includes("e")) right = clamp(Math.round(left + (finite(proposed.width) ? proposed.width : original.width)), left + minW, W);
  if (edges.includes("n")) top = clamp(Math.round(finite(proposed.y) ? proposed.y : bottom - proposed.height), 0, bottom - minH);
  if (edges.includes("s")) bottom = clamp(Math.round(top + (finite(proposed.height) ? proposed.height : original.height)), top + minH, H);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

// All four separating edges vary linearly, so even a large pointer jump stops
// at the first contact rather than tunnelling through another panel.
function collisionTime(start, end, obstacle) {
  if (overlaps(start, obstacle)) return overlaps(end, obstacle) ? 0 : 1;
  const inequalities = [
    [start.x - obstacle.x - obstacle.width, end.x - start.x],
    [obstacle.x - start.x - start.width, start.x + start.width - end.x - end.width],
    [start.y - obstacle.y - obstacle.height, end.y - start.y],
    [obstacle.y - start.y - start.height, start.y + start.height - end.y - end.height],
  ];
  let enter = 0, leave = 1;
  for (const [initial, delta] of inequalities) {
    if (Math.abs(delta) < EPSILON) { if (initial >= -EPSILON) return 1; }
    else if (delta < 0) enter = Math.max(enter, -initial / delta);
    else leave = Math.min(leave, -initial / delta);
  }
  return enter < leave - EPSILON && leave > 0 && enter < 1 ? Math.max(0, enter) : 1;
}

export function constrainZoneRect(config, id, proposedRect, display, options = {}) {
  const zone = config?.zones?.find(item => item.id === id);
  const original = zoneWorkRect(zone, display);
  if (!original || !proposedRect) return original;
  const target = boundedRect(original, proposedRect, zone, display, options);
  let time = 1;
  for (const other of config.zones) {
    if (other.id === id) continue;
    const obstacle = zoneWorkRect(other, display);
    if (obstacle) time = Math.min(time, collisionTime(original, target, obstacle));
  }
  if (time >= 1) return target;
  const x = original.x + Math.trunc((target.x - original.x) * time + Math.sign(target.x - original.x) * EPSILON);
  const y = original.y + Math.trunc((target.y - original.y) * time + Math.sign(target.y - original.y) * EPSILON);
  const right = original.x + original.width + Math.trunc((target.x + target.width - original.x - original.width) * time + Math.sign(target.x + target.width - original.x - original.width) * EPSILON);
  const bottom = original.y + original.height + Math.trunc((target.y + target.height - original.y - original.height) * time + Math.sign(target.y + target.height - original.y - original.height) * EPSILON);
  return { x, y, width: right - x, height: bottom - y };
}

function snappingTargets(config, id, display, axis, marginIcons) {
  const metrics = getLayoutMetrics(display), horizontal = axis === "x";
  const extent = horizontal ? metrics.workWidth : metrics.workHeight;
  const margin = Math.round((horizontal ? metrics.iconX : metrics.iconY) * clamp(marginIcons, 0, 2));
  const targets = [
    { value: margin, kind: "margin" }, { value: extent - margin, kind: "margin" },
    { value: extent / 2, kind: "center" }, { value: 0, kind: "edge" }, { value: extent, kind: "edge" },
  ];
  for (const other of config.zones) {
    if (other.id === id) continue;
    const rect = zoneWorkRect(other, display);
    if (!rect) continue;
    const start = rect[axis], length = horizontal ? rect.width : rect.height;
    targets.push({ value: start, kind: "alignment" }, { value: start + length, kind: "alignment" },
      { value: start + length / 2, kind: "center" },
      { value: start - metrics.gap, kind: "gap" }, { value: start + length + metrics.gap, kind: "gap" });
  }
  return targets;
}

export function snapZoneRect(config, id, proposedRect, display, options = {}) {
  const mode = editingMode(proposedRect, options), edges = options.edges || "se";
  const threshold = Math.max(0, finite(options.threshold) ? options.threshold : Math.round(8 * (display?.dpiScale || 1)));
  const marginIcons = finite(options.marginIcons) ? options.marginIcons : 1;
  let rect = constrainZoneRect(config, id, proposedRect, display, { ...options, mode });
  if (!rect) return { rect, guides: [] };
  const guides = [];
  for (const axis of ["x", "y"]) {
    const horizontal = axis === "x", dimension = horizontal ? "width" : "height";
    const leading = horizontal ? "w" : "n", trailing = horizontal ? "e" : "s";
    const offsets = mode === "move" ? [0, rect[dimension] / 2, rect[dimension]] :
      edges.includes(leading) ? [0] : edges.includes(trailing) ? [rect[dimension]] : [];
    const targets = snappingTargets(config, id, display, axis, marginIcons);
    const grid = Math.round(options.grid || 0);
    if (grid > 0) for (const offset of offsets) targets.push({ value: Math.round((rect[axis] + offset) / grid) * grid, kind: "grid" });
    const candidates = offsets.flatMap(offset => targets.map(target => ({ ...target, offset, delta: Math.round(target.value - rect[axis] - offset) })))
      .filter(candidate => Math.abs(candidate.delta) <= threshold)
      .sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
    for (const candidate of candidates) {
      const next = { ...rect };
      if (mode === "move") next[axis] += candidate.delta;
      else if (edges.includes(leading)) { next[axis] += candidate.delta; next[dimension] -= candidate.delta; }
      else next[dimension] += candidate.delta;
      const constrained = constrainZoneRect(config, id, next, display, { ...options, mode });
      if (Object.keys(next).some(key => next[key] !== constrained[key])) continue;
      rect = next;
      guides.push({ axis, value: rect[axis] + (mode === "move" ? candidate.offset : edges.includes(leading) ? 0 : rect[dimension]), kind: candidate.kind });
      break;
    }
  }
  return { rect, guides };
}

export function updateZonePixels(config, id, patch, display, options = {}) {
  const result = copy(config), zone = result.zones.find(item => item.id === id);
  const original = zoneWorkRect(zone, display);
  if (!original) return { config: result, rect: null, guides: [], blocked: true };
  const proposed = { ...original };
  for (const key of ["x", "y", "width", "height"]) if (finite(patch?.[key])) proposed[key] = Math.round(patch[key]);
  const mode = editingMode(patch, options);
  const output = options.snap ? snapZoneRect(config, id, proposed, display, { ...options, mode }) :
    { rect: constrainZoneRect(config, id, proposed, display, { ...options, mode }), guides: [] };
  Object.assign(zone, normalizedRect(output.rect, display));
  const bounded = boundedRect(original, proposed, zone, display, { ...options, mode });
  return { config: result, ...output, blocked: Object.keys(bounded).some(key => bounded[key] !== output.rect[key]) };
}

export function fitLayoutToMargins(config, display, marginIcons = 1, { preserveBreathingRoom = false } = {}) {
  const unchanged = () => copy(config);
  if (!validDisplay(display) || !Array.isArray(config?.zones) || !config.zones.length) return { config: unchanged(), error: "分区或显示器信息无效" };
  const metrics = getLayoutMetrics(display);
  const margin = finite(marginIcons) ? clamp(marginIcons, 0, 2) : 1;
  const mx = Math.round(metrics.iconX * margin), my = Math.round(metrics.iconY * margin);
  const targetW = metrics.workWidth - 2 * mx, targetH = metrics.workHeight - 2 * my;
  const rectangles = config.zones.map(zone => zoneWorkRect(zone, display));
  if (rectangles.some(rect => !rect)) return { config: unchanged(), error: "分区坐标无效" };
  const left = Math.min(...rectangles.map(rect => rect.x)), top = Math.min(...rectangles.map(rect => rect.y));
  const width = Math.max(...rectangles.map(rect => rect.x + rect.width)) - left;
  const height = Math.max(...rectangles.map(rect => rect.y + rect.height)) - top;
  if (targetW <= 0 || targetH <= 0 || width <= 0 || height <= 0) return { config: unchanged(), error: "屏幕空间不足，无法预留所选图标宽度" };
  if (preserveBreathingRoom && rectangles.every(rect => rect.x >= mx && rect.y >= my &&
      rect.x + rect.width <= mx + targetW && rect.y + rect.height <= my + targetH)) {
    return { config: unchanged(), error: null };
  }
  const result = copy(config);
  const factor = Math.min(1, targetW / width, targetH / height);
  const fitW = preserveBreathingRoom ? width * factor : targetW;
  const fitH = preserveBreathingRoom ? height * factor : targetH;
  const fitX = preserveBreathingRoom ? clamp(left, mx, mx + targetW - fitW) : mx;
  const fitY = preserveBreathingRoom ? clamp(top, my, my + targetH - fitH) : my;
  result.zones.forEach((zone, index) => {
    const rect = rectangles[index];
    const x = Math.round(fitX + (rect.x - left) / width * fitW), y = Math.round(fitY + (rect.y - top) / height * fitH);
    const right = Math.round(fitX + (rect.x + rect.width - left) / width * fitW), bottom = Math.round(fitY + (rect.y + rect.height - top) / height * fitH);
    Object.assign(zone, normalizedRect({ x, y, width: right - x, height: bottom - y }, display));
  });
  const errors = validateConfig(result, display);
  return errors.length ? { config: unchanged(), error: `当前布局无法预留所选图标宽度：${errors[0]}` } : { config: result, error: null };
}

export function addZone(config, kind = "files") {
  if (!["software", "files"].includes(kind) || !Array.isArray(config.zones) || config.zones.length >= 8) return null;
  const zones = config.zones;
  if (!zones.every(hasGeometry)) return null;
  const xs = [0, ...zones.flatMap((zone) => [zone.x + zone.width + 0.01, zone.x + zone.width])];
  const ys = [0, ...zones.flatMap((zone) => [zone.y + zone.height + 0.01, zone.y + zone.height])];
  for (const size of [0.2, 0.15, MIN_SIZE]) {
    for (const y of ys) for (const x of xs) {
      const rect = { x, y, width: size, height: size };
      if (x + size > 1 + EPSILON || y + size > 1 + EPSILON || zones.some((zone) => overlaps(rect, zone))) continue;
      let number = 1;
      while (zones.some((zone) => zone.id === `${kind}-${number}`)) number++;
      return { ...config, zones: [...zones.map((zone) => ({ ...zone })), {
        id: `${kind}-${number}`, kind, label: kind === "software" ? "软件" : "文件", ...rect,
      }] };
    }
  }
  return null;
}

export function removeZone(config, id) {
  const result = copy(config);
  if (result.zones.length <= 2 || result.zones.find((zone) => zone.id === id)?.kind === "calendar") return result;
  result.zones = result.zones.filter((zone) => zone.id !== id);
  return result;
}
