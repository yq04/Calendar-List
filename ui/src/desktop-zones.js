import {
  createDefaultConfig, validateConfig, zonePixelRect, calendarContentRect,
  getLayoutMetrics, zoneWorkRect, updateZonePixels, fitLayoutToMargins,
  addZone, removeZone, COMPOSITION_PRESETS, getCompositionInfo,
} from "./desktop-zones-model.js";
import { sanitizeUserMessage } from "./write-state.js";
import { renderDesktopZones } from "./desktop-zones-renderer.js";
export { renderDesktopZones } from "./desktop-zones-renderer.js";

const copy = value => structuredClone(value);
const screenSize = display => ({
  width: display.rect[2] - display.rect[0],
  height: display.rect[3] - display.rect[1],
});
const KIND_NAMES = { calendar: "日历", software: "软件", files: "文件" };
const PANEL_RECIPES = [
  { id: "soft", label: "柔和", style: "auto", opacity: 0.72 },
  { id: "clear", label: "清透", style: "auto", opacity: 0.46 },
  { id: "dark", label: "深色", style: "dark", opacity: 0.64 },
];

function decodeImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法解码这张壁纸，请选择 JPG、PNG、WebP 或 BMP 图片。"));
    image.src = dataUrl;
  });
}

export function mountDesktopZones({ mount, bridge, onApplied }) {
  const section = document.createElement("section");
  section.className = "kal-sec kal-desktop-zones";
  section.dataset.cat = "backdrop";
  section.hidden = true;
  section.innerHTML = `
    <div class="kal-sec-head-row">
      <div class="kal-sec-title">桌面壁纸分区 <span class="kal-zones-dirty" hidden>未应用</span></div>
      <button type="button" class="kal-btn" data-zone-act="expand" aria-pressed="false">放大编辑</button>
      <button type="button" class="kal-btn kal-btn-ghost" data-zone-act="refresh">刷新</button>
    </div>
    <p class="kal-zones-intro">图标可拖入分区，文件位置不变。</p>
    <div class="kal-zones-top-row">
      <label>显示器<select data-zone-field="monitor" aria-label="壁纸分区显示器"></select></label>
      <div class="kal-zones-source-buttons">
        <button type="button" class="kal-btn" data-zone-act="desktop">当前壁纸</button>
        <button type="button" class="kal-btn" data-zone-act="image">选择图片</button>
      </div>
    </div>
    <p class="kal-zones-display-info" role="status"></p>
    <div class="kal-zones-presets" aria-label="分区布局模板">
      <button type="button" class="kal-zones-preset" data-zone-preset="right"><span class="kal-zones-preset-icon is-right" aria-hidden="true"><i></i><i></i><i></i></span>右侧日历</button>
      <button type="button" class="kal-zones-preset" data-zone-preset="left"><span class="kal-zones-preset-icon is-left" aria-hidden="true"><i></i><i></i><i></i></span>左侧日历</button>
      <button type="button" class="kal-zones-preset" data-zone-preset="portrait"><span class="kal-zones-preset-icon is-portrait" aria-hidden="true"><i></i><i></i><i></i></span>上下分区</button>
    </div>
    <div class="kal-zones-design-row">
      <label>分区比例<select data-zone-field="composition" aria-label="分区比例"><option value="custom">自定义布局</option>${COMPOSITION_PRESETS.map(item => `<option value="${item.id}">${item.label}</option>`).join("")}</select></label>
      <div class="kal-zones-recipe-group"><span>板面风格</span><div class="kal-zones-recipes" role="group" aria-label="板面风格">${PANEL_RECIPES.map(item => `<button type="button" class="kal-zones-recipe" data-zone-recipe="${item.id}" aria-pressed="false"><i aria-hidden="true"></i>${item.label}</button>`).join("")}</div></div>
    </div>
    <p class="kal-zones-composition-info"></p>
    <div class="kal-zones-toolbar">
      <label class="kal-zones-margin-label">四周留白<select data-zone-field="margin" aria-label="四周预留图标空间"><option value="1">1 个图标（推荐）</option><option value="2">2 个图标</option><option value="0">不留白</option></select></label>
      <button type="button" class="kal-btn" data-zone-act="margins">一键留白</button>
      <label class="kal-zones-snap-label"><input type="checkbox" data-zone-field="snap" checked />自动吸附</label>
      <div class="kal-zones-history"><button type="button" class="kal-btn kal-btn-ghost" data-zone-act="undo" title="撤销分区调整（Ctrl+Z）" aria-label="撤销分区调整">撤销</button><button type="button" class="kal-btn kal-btn-ghost" data-zone-act="redo" title="重做分区调整（Ctrl+Y）" aria-label="重做分区调整">重做</button></div>
    </div>
    <div class="kal-zones-workspace">
    <div class="kal-zones-stage-column">
    <div class="kal-zones-stage" role="group" aria-label="壁纸分区预览，拖动移动，拖边或角调整尺寸">
      <canvas class="kal-zones-canvas" aria-hidden="true"></canvas>
      <div class="kal-zones-safe-area" aria-hidden="true"><span></span></div>
      <div class="kal-zones-taskbar" aria-hidden="true">任务栏保留区</div>
      <div class="kal-zones-handles"></div>
      <div class="kal-zones-guides" aria-hidden="true"></div>
    </div>
    <div class="kal-zones-hint kal-zones-keys">方向键移动 1 px，Shift 加速至 10 px；Ctrl + 方向键调整尺寸。Alt 拖动临时关闭吸附。</div>
    </div>
    <details class="kal-zones-editor-details">
    <summary>精确调整 <span>位置、尺寸与名称</span></summary>
    <div class="kal-zones-edit-card">
      <div class="kal-zones-edit-head">
        <label>编辑分区<select data-zone-field="selected" aria-label="选择要编辑的分区"></select></label>
        <button type="button" class="kal-btn kal-btn-ghost" data-zone-act="add">添加分区</button>
        <button type="button" class="kal-btn kal-btn-ghost" data-zone-act="remove">移除</button>
      </div>
      <div class="kal-zones-name-row">
        <label>名称<input type="text" maxlength="24" data-zone-field="label" aria-label="分区名称" /></label>
        <label>用途<select data-zone-field="kind" aria-label="分区用途"><option value="calendar">日历</option><option value="software">软件</option><option value="files">文件</option></select></label>
      </div>
      <div class="kal-zones-unit-row"><span>位置与尺寸</span><select data-zone-field="unit" aria-label="位置尺寸单位"><option value="px">像素 px（精确）</option><option value="percent">百分比 %</option></select></div>
      <div class="kal-zones-geometry">
        <label><span data-zone-label="x">左侧 px</span><input type="number" min="0" step="1" data-zone-geometry="x" aria-label="分区左侧像素" /></label>
        <label><span data-zone-label="y">顶部 px</span><input type="number" min="0" step="1" data-zone-geometry="y" aria-label="分区顶部像素" /></label>
        <label><span data-zone-label="width">宽度 px</span><input type="number" min="1" step="1" data-zone-geometry="width" aria-label="分区宽度像素" /></label>
        <label><span data-zone-label="height">高度 px</span><input type="number" min="1" step="1" data-zone-geometry="height" aria-label="分区高度像素" /></label>
      </div>
      <div class="kal-zones-nudge" aria-label="微调位置"><span>移动 1 px</span><button type="button" class="kal-btn" data-zone-nudge="left" aria-label="向左移动1像素">←</button><button type="button" class="kal-btn" data-zone-nudge="up" aria-label="向上移动1像素">↑</button><button type="button" class="kal-btn" data-zone-nudge="down" aria-label="向下移动1像素">↓</button><button type="button" class="kal-btn" data-zone-nudge="right" aria-label="向右移动1像素">→</button></div>
      <div class="kal-zones-selection-info" role="status" aria-live="polite"></div>
    </div>
    </details>
    </div>
    <details class="kal-zones-surface-details">
    <summary>底板与图片微调</summary>
    <div class="kal-zones-appearance">
      <label>图片铺放<select data-zone-field="fit" aria-label="分区壁纸图片铺放"><option value="cover">填满屏幕</option><option value="contain">完整显示</option><option value="stretch">拉伸适配</option></select></label>
      <label>分区底板<select data-zone-field="panelStyle" aria-label="分区底板颜色"><option value="auto">自动（推荐）</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
      <label class="kal-zones-opacity">底板强度<div><input type="range" min="0" max="100" step="1" data-zone-field="opacity" aria-label="分区底板强度" /><input type="number" min="0" max="100" step="1" data-zone-field="opacityNumber" aria-label="分区底板强度百分比" /><span>%</span></div></label>
    </div>
    </details>
    <p class="kal-zones-source" title=""></p>
    <p class="kal-zones-limitation" hidden></p>
    <div class="kal-zones-errors" role="status" aria-live="polite"></div>
    <div class="kal-zones-actions">
      <button type="button" class="kal-btn is-active" data-zone-act="apply" title="应用壁纸并将日历对齐到分区">应用分区</button>
      <button type="button" class="kal-btn" data-zone-act="restore">恢复原壁纸</button>
    </div>
    <p class="kal-zones-hint">应用后立即生效，与顶部“保存设置”分开。原图保留，日历内容仍可直接编辑。</p>
    <div class="kal-zones-status" role="status" aria-live="polite"></div>
  `;
  const backdropSec = mount.querySelector('[data-cat="backdrop"]');
  if (backdropSec) mount.insertBefore(section, backdropSec); else mount.append(section);

  const query = selector => section.querySelector(selector);
  const field = name => query(`[data-zone-field="${name}"]`);
  const action = name => query(`[data-zone-act="${name}"]`);
  const stage = query(".kal-zones-stage");
  const canvas = query("canvas");
  const handles = query(".kal-zones-handles");
  const statusEl = query(".kal-zones-status");
  const errorEl = query(".kal-zones-errors");
  const dirtyBadge = query(".kal-zones-dirty");
  // Keep the primary actions visible before the full-size preview and fine controls.
  section.querySelector(".kal-sec-head-row").insertBefore(query(".kal-zones-actions"), action("expand"));
  section.insertBefore(query(".kal-zones-toolbar"), query(".kal-zones-surface-details"));
  const quickControls = document.createElement("div");
  quickControls.className = "kal-zones-quick-controls";
  section.insertBefore(quickControls, query(".kal-zones-top-row"));
  for (const selector of [".kal-zones-top-row", ".kal-zones-display-info", ".kal-zones-presets", ".kal-zones-design-row", ".kal-zones-composition-info"]) {
    quickControls.append(query(selector));
  }
  const zoneNodes = new Map();
  const drafts = new Map();
  let state = { status: null, config: null, display: null, image: null, sourceReady: false,
    selected: "", busy: false, dirty: false, initialized: false, epoch: 0, preset: "", drag: null,
    unit: "px", marginIcons: 1, snap: true, guides: [], expanded: false, past: [], future: [], composition: "balanced" };
  let refreshRequest = null;
  let renderQueued = false;
  let beforeExpandFocus = null;
  let detailsBeforeExpand = false;

  function tell(message, error = false) {
    statusEl.textContent = message === "" || message == null ? "" : sanitizeUserMessage(message);
    statusEl.classList.toggle("is-error", error);
  }

  function isUnsupported() {
    const s = state.status;
    return s?.position === "span" || !!s?.slideshow;
  }

  function selectedZone() { return state.config?.zones.find(zone => zone.id === state.selected); }

  function keepDraft() {
    if (state.config && state.display) drafts.set(state.display.monitor, {
      config: copy(state.config), dirty: state.dirty, preset: state.preset,
      marginIcons: state.marginIcons, composition: state.composition, past: copy(state.past), future: copy(state.future),
    });
  }

  const configEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function snapshot() {
    return { zones: copy(state.config.zones), dirty: state.dirty, preset: state.preset, composition: state.composition, selected: state.selected };
  }
  function remember(before) {
    if (!before?.zones || configEqual(before.zones, state.config.zones)) return;
    state.past.push(before);
    if (state.past.length > 30) state.past.shift();
    state.future = [];
  }
  function setConfig(config, { dirty = true, preset = "", composition = "", history = true } = {}) {
    const before = state.config ? snapshot() : null;
    const changed = !configEqual(state.config, config);
    state.config = config; state.dirty = changed ? dirty : state.dirty; state.preset = preset; state.composition = composition;
    if (!config.zones.some(zone => zone.id === state.selected)) state.selected = config.zones[0]?.id || "";
    if (history) remember(before);
    keepDraft(); render();
  }
  function travelHistory(direction) {
    if (state.busy || state.drag) return;
    const from = direction === "undo" ? state.past : state.future;
    const to = direction === "undo" ? state.future : state.past;
    if (!from.length) return;
    to.push(snapshot());
    const previous = from.pop();
    state.config = { ...state.config, zones: previous.zones }; state.dirty = true;
    state.preset = previous.preset; state.composition = previous.composition || ""; state.selected = previous.selected;
    state.guides = []; keepDraft(); render(); tell("");
  }
  function syncInput(control, value, force = false) {
    if (force || document.activeElement !== control) control.value = String(value);
  }

  function syncControls() {
    const config = state.config, zone = selectedZone();
    for (const control of section.querySelectorAll("button,input,select")) control.disabled = state.busy || !config;
    action("refresh").disabled = state.busy;
    action("expand").disabled = state.busy || !config;
    field("monitor").disabled = state.busy || !state.status?.monitors?.length;
    if (!config || !state.display) return;
    action("undo").disabled = state.busy || !state.past.length;
    action("redo").disabled = state.busy || !state.future.length;
    field("unit").value = state.unit;
    field("margin").value = String(state.marginIcons);
    field("snap").checked = state.snap;
    field("composition").value = state.composition || "custom";
    const size = screenSize(state.display);
    const scale = Number(state.display.dpiScale) || 1;
    const diagonal = state.display.ppiKnown && Number.isFinite(state.display.diagonalIn) && state.display.diagonalIn > 0
      ? `${state.display.diagonalIn.toFixed(1)} 英寸 · ` : "";
    query(".kal-zones-display-info").textContent = `${diagonal}${size.width} × ${size.height} · 缩放 ${Math.round(scale * 100)}% · 按工作区自动适配`;
    const compositionInfo = getCompositionInfo(state.display, state.composition || "balanced");
    query(".kal-zones-composition-info").textContent = state.composition
      ? compositionInfo.hint || compositionInfo.description
      : "自定义布局 · 比例和位置保持你的调整";
    field("composition").title = compositionInfo.description;
    for (const button of section.querySelectorAll("[data-zone-recipe]")) {
      const recipe = PANEL_RECIPES.find(item => item.id === button.dataset.zoneRecipe);
      const active = recipe.style === config.panelStyle && Math.abs(recipe.opacity - config.panelOpacity) < 0.001;
      button.classList.toggle("is-on", active); button.setAttribute("aria-pressed", String(active));
      button.title = active ? "再次点击恢复默认板面" : `应用${recipe.label}板面，不更改布局`;
    }
    dirtyBadge.hidden = !state.dirty;
    const selected = field("selected");
    const oldOptions = [...selected.options].map(option => `${option.value}:${option.textContent}`).join("|");
    const newOptions = config.zones.map(item => `${item.id}:${item.label || KIND_NAMES[item.kind]}`).join("|");
    if (oldOptions !== newOptions) {
      selected.replaceChildren(...config.zones.map(item => {
        const option = document.createElement("option"); option.value = item.id;
        option.textContent = item.label || KIND_NAMES[item.kind]; return option;
      }));
    }
    selected.value = state.selected;
    if (zone) {
      syncInput(field("label"), zone.label);
      field("kind").value = zone.kind;
      field("kind").disabled = state.busy || zone.kind === "calendar";
      for (const option of field("kind").options) option.disabled = option.value === "calendar" && zone.kind !== "calendar";
      const rect = zoneWorkRect(zone, state.display);
      const metrics = getLayoutMetrics(state.display);
      const captions = { x: "左侧", y: "顶部", width: "宽度", height: "高度" };
      for (const input of section.querySelectorAll("[data-zone-geometry]")) {
        const key = input.dataset.zoneGeometry;
        const extent = ["x", "width"].includes(key) ? metrics.workWidth : metrics.workHeight;
        const percent = state.unit === "percent";
        input.min = ["width", "height"].includes(key) ? percent ? "0.01" : "1" : "0";
        input.max = String(percent ? 100 : extent);
        input.step = percent ? "0.01" : "1";
        input.setAttribute("aria-label", `分区${captions[key]}${percent ? "百分比" : "像素"}`);
        query(`[data-zone-label="${key}"]`).textContent = `${captions[key]} ${percent ? "%" : "px"}`;
        syncInput(input, percent ? Number((rect[key] / extent * 100).toFixed(6)) : rect[key]);
      }
      query(".kal-zones-selection-info").textContent = `${rect.width} × ${rect.height} px · 左 ${rect.x} / 上 ${rect.y}`;
    }
    field("fit").value = config.fit; field("panelStyle").value = config.panelStyle;
    const opacity = String(Math.round(config.panelOpacity * 100));
    syncInput(field("opacity"), opacity); syncInput(field("opacityNumber"), opacity);
    action("remove").disabled = state.busy || !zone || zone.kind === "calendar" || config.zones.length <= 2;
    action("add").disabled = state.busy || config.zones.length >= 8;
    const errors = validateConfig(config, state.display);
    errorEl.textContent = errors.join("；");
    action("apply").disabled = state.busy || !state.sourceReady || !!errors.length || isUnsupported();
    action("restore").disabled = state.busy || !state.status?.canRestore?.[state.display.monitor];
    for (const button of section.querySelectorAll("[data-zone-preset]")) {
      const active = button.dataset.zonePreset === state.preset;
      button.classList.toggle("is-on", active); button.setAttribute("aria-pressed", String(active));
    }
    const source = query(".kal-zones-source");
    source.textContent = config.sourcePath ? `壁纸：${config.sourcePath.split(/[\\/]/).pop()}` : "请选择一张壁纸";
    source.title = config.sourcePath || "";
    const limitation = query(".kal-zones-limitation");
    limitation.hidden = !isUnsupported();
    limitation.textContent = state.status?.slideshow ?
      "当前是系统幻灯片壁纸。可先编辑预览；请在 Windows 个性化中改为静态图片后应用。" :
      "当前壁纸跨屏延展。可先编辑预览；请在 Windows 个性化中改为填充或适应后应用。";
  }

  function updateOverlay() {
    const config = state.config, display = state.display;
    if (!config || !display) return;
    const size = screenSize(display);
    const liveIds = new Set(config.zones.map(zone => zone.id));
    for (const [id, node] of zoneNodes) if (!liveIds.has(id)) { node.remove(); zoneNodes.delete(id); }
    for (const zone of config.zones) {
      let node = zoneNodes.get(zone.id);
      if (!node) {
        node = document.createElement("div"); node.className = "kal-zones-zone";
        node.tabIndex = 0; node.setAttribute("role", "button"); node.dataset.zoneId = zone.id;
        const label = document.createElement("span"); label.className = "kal-zones-zone-label";
        const dimensions = document.createElement("span"); dimensions.className = "kal-zones-zone-size";
        node.append(label, dimensions);
        for (const edge of ["se", "s", "e", "ne", "n", "nw", "w", "sw"]) {
          const grip = document.createElement("span"); grip.className = "kal-zones-grip";
          grip.dataset.zoneResize = edge; grip.setAttribute("aria-hidden", "true"); node.append(grip);
        }
        node.addEventListener("pointerdown", event => startDrag(event, zone.id, event.target.closest("[data-zone-resize]")?.dataset.zoneResize || ""));
        node.addEventListener("pointermove", moveDrag);
        node.addEventListener("pointerup", endDrag);
        node.addEventListener("pointercancel", endDrag);
        node.addEventListener("lostpointercapture", () => { if (state.drag) finishDrag(); });
        node.addEventListener("focus", () => { if (state.selected !== zone.id) { state.selected = zone.id; render(); } });
        node.addEventListener("keydown", event => keyboardGeometry(event, zone.id));
        handles.append(node); zoneNodes.set(zone.id, node);
      }
      const rect = zonePixelRect(zone, display);
      Object.assign(node.style, { left: `${rect.x / size.width * 100}%`, top: `${rect.y / size.height * 100}%`,
        width: `${rect.width / size.width * 100}%`, height: `${rect.height / size.height * 100}%` });
      node.classList.toggle("is-selected", state.selected === zone.id);
      node.classList.toggle("is-calendar", zone.kind === "calendar");
      node.classList.toggle("is-light", config.panelStyle === "light" || (config.panelStyle === "auto" && zone.kind === "calendar"));
      const workRect = zoneWorkRect(zone, display);
      node.querySelector(".kal-zones-zone-label").textContent = zone.label || KIND_NAMES[zone.kind];
      node.querySelector(".kal-zones-zone-size").textContent = `${workRect.width} × ${workRect.height} px`;
      node.setAttribute("aria-label", `${zone.label || KIND_NAMES[zone.kind]}分区，${workRect.width}乘${workRect.height}像素。方向键移动1像素，Shift加速，Ctrl加方向键调整尺寸`);
      node.setAttribute("aria-pressed", String(state.selected === zone.id));
      node.setAttribute("aria-disabled", String(state.busy));
      let ghost = node.querySelector(".kal-zones-calendar-ghost");
      if (zone.kind === "calendar") {
        if (!ghost) {
          ghost = document.createElement("div"); ghost.className = "kal-zones-calendar-ghost";
          ghost.setAttribute("aria-hidden", "true");
          for (let day = 1; day <= 35; day++) { const cell = document.createElement("i"); cell.textContent = day <= 31 ? String(day) : ""; ghost.append(cell); }
          node.append(ghost);
        }
        const inner = calendarContentRect(config, display);
        if (inner) Object.assign(ghost.style, {
          left: `${(inner.x - rect.x) / rect.width * 100}%`, top: `${(inner.y - rect.y) / rect.height * 100}%`,
          width: `${inner.width / rect.width * 100}%`, height: `${inner.height / rect.height * 100}%`,
        });
      } else ghost?.remove();
    }
    const metrics = getLayoutMetrics(display);
    const safe = query(".kal-zones-safe-area");
    const mx = metrics.iconX * state.marginIcons, my = metrics.iconY * state.marginIcons;
    const workLeft = display.work[0] - display.rect[0], workTop = display.work[1] - display.rect[1];
    safe.hidden = state.marginIcons === 0 || metrics.workWidth <= mx * 2 || metrics.workHeight <= my * 2;
    Object.assign(safe.style, {
      left: `${(workLeft + mx) / size.width * 100}%`, top: `${(workTop + my) / size.height * 100}%`,
      width: `${Math.max(0, metrics.workWidth - mx * 2) / size.width * 100}%`,
      height: `${Math.max(0, metrics.workHeight - my * 2) / size.height * 100}%`,
    });
    safe.querySelector("span").textContent = `图标留白 ${mx} × ${my} px`;
    const guides = query(".kal-zones-guides");
    guides.replaceChildren(...state.guides.map(guide => {
      const line = document.createElement("i"); line.className = `is-${guide.axis}`;
      if (guide.axis === "x") line.style.left = `${(workLeft + guide.value) / size.width * 100}%`;
      else line.style.top = `${(workTop + guide.value) / size.height * 100}%`;
      return line;
    }));
    const taskbar = query(".kal-zones-taskbar");
    const bottom = display.rect[3] - display.work[3];
    const top = display.work[1] - display.rect[1];
    const left = display.work[0] - display.rect[0];
    const right = display.rect[2] - display.work[2];
    taskbar.hidden = Math.max(bottom, top, left, right) <= 0;
    Object.assign(taskbar.style, { inset: "auto 0 0", width: "100%", height: `${bottom / size.height * 100}%` });
    if (top > 0) Object.assign(taskbar.style, { inset: "0 0 auto", height: `${top / size.height * 100}%` });
    else if (left > 0) Object.assign(taskbar.style, { inset: "0 auto 0 0", width: `${left / size.width * 100}%`, height: "100%" });
    else if (right > 0) Object.assign(taskbar.style, { inset: "0 0 0 auto", width: `${right / size.width * 100}%`, height: "100%" });
  }

  function draw() {
    renderQueued = false;
    if (!state.config || !state.display) return;
    try { renderDesktopZones(canvas, state.config, state.display, state.image, state.expanded ? 2200 : 1100); }
    catch (error) { tell(error.message, true); }
  }

  function render() {
    syncControls(); updateOverlay();
    if (state.display) { const size = screenSize(state.display); stage.style.aspectRatio = `${size.width} / ${size.height}`; }
    fitStage();
    if (!renderQueued) { renderQueued = true; requestAnimationFrame(draw); }
  }

  function fitStage() {
    if (!state.display) { stage.style.width = ""; return; }
    const column = query(".kal-zones-stage-column"), size = screenSize(state.display);
    const availableHeight = state.expanded
      ? Math.max(80, column.clientHeight - query(".kal-zones-keys").offsetHeight - 12)
      : Math.max(120, Math.min(220, window.innerHeight * 0.26));
    stage.style.width = `${Math.max(80, Math.min(column.clientWidth - 2, availableHeight * size.width / size.height))}px`;
  }

  function setExpanded(expanded, { returnFocus = true } = {}) {
    if (expanded && (!state.config || state.busy)) return;
    if (expanded === state.expanded) return;
    if (expanded) {
      beforeExpandFocus = document.activeElement;
      detailsBeforeExpand = query(".kal-zones-editor-details").open;
      query(".kal-zones-editor-details").open = true;
    } else query(".kal-zones-editor-details").open = detailsBeforeExpand;
    state.expanded = expanded;
    section.classList.toggle("is-expanded", expanded);
    document.body.classList.toggle("kal-zones-expanded", expanded);
    action("expand").textContent = expanded ? "收起编辑" : "放大编辑";
    action("expand").setAttribute("aria-pressed", String(expanded));
    if (expanded) section.setAttribute("aria-label", "壁纸分区放大编辑器");
    else section.removeAttribute("aria-label");
    render();
    requestAnimationFrame(() => {
      fitStage();
      if (expanded) zoneNodes.get(state.selected)?.focus({ preventScroll: true });
      else if (returnFocus && document.body.classList.contains("kal-panel-open")) beforeExpandFocus?.focus?.({ preventScroll: true });
    });
  }

  async function loadSource(path, { markDirty = false } = {}) {
    const epoch = ++state.epoch;
    const monitorId = state.display?.monitor;
    state.sourceReady = false; state.image = null; render();
    tell("正在读取壁纸…");
    try {
      const result = await bridge.wallpaperReadImage(path || null);
      const image = await decodeImage(result.dataUrl);
      if (epoch !== state.epoch || monitorId !== state.display?.monitor) return;
      state.image = image; state.sourceReady = true;
      state.config.sourcePath = result.path || path || "";
      if (markDirty) state.dirty = true;
      keepDraft(); render(); tell("");
    } catch (error) {
      if (epoch !== state.epoch) return;
      state.sourceReady = false; tell(error.message || String(error), true); render();
    }
  }

  async function chooseMonitor(id, { preserve = true } = {}) {
    if (preserve) keepDraft();
    const display = state.status?.monitors?.find(item => item.monitor === id);
    if (!display) return;
    state.display = display; field("monitor").value = display.monitor;
    const draft = drafts.get(id);
    const saved = state.status.configs?.[id];
    const direction = display.rect[3] - display.rect[1] > display.rect[2] - display.rect[0] ? "portrait" : "right";
    const initial = createDefaultConfig(display, direction, { marginIcons: 1, composition: "balanced" });
    initial.fit = state.status.position === "fit" ? "contain" : state.status.position === "stretch" ? "stretch" : "cover";
    state.config = copy(draft?.config || saved || initial);
    state.dirty = draft?.dirty || false; state.preset = draft?.preset || (!saved && !draft ? direction : "");
    state.composition = draft?.composition ?? (saved ? "" : "balanced");
    state.marginIcons = draft?.marginIcons ?? 1;
    state.past = copy(draft?.past || []); state.future = copy(draft?.future || []); state.guides = [];
    state.selected = state.config.zones.find(zone => zone.kind === "calendar")?.id || state.config.zones[0]?.id || "";
    const source = state.config.sourcePath || display.sourcePath || display.wallpaperPath;
    render(); await loadSource(source);
  }

  async function refresh({ force = false } = {}) {
    if (section.hidden && !force) return;
    if (refreshRequest || state.busy) return refreshRequest;
    keepDraft();
    tell("正在读取显示器…");
    refreshRequest = (async () => {
      try {
        const result = await bridge.desktopZonesStatus();
        const monitors = result?.monitors || [];
        if (!monitors.length) throw new Error("未找到可用显示器，请连接显示器后重试。");
        state.status = result; state.initialized = true;
        field("monitor").replaceChildren(...monitors.map((display, index) => {
          const option = document.createElement("option"); option.value = display.monitor;
          const size = screenSize(display);
          option.textContent = `${display.isPrimary ? "主屏" : `屏幕 ${index + 1}`} · ${size.width} × ${size.height}`;
          return option;
        }));
        const target = monitors.some(display => display.monitor === state.display?.monitor) ? state.display.monitor :
          monitors.some(display => display.monitor === result.activeMonitor) ? result.activeMonitor : monitors[0].monitor;
        await chooseMonitor(target, { preserve: false });
      } catch (error) { tell(error.message || String(error), true); syncControls(); }
      finally { refreshRequest = null; }
    })();
    return refreshRequest;
  }

  function startDrag(event, id, edges) {
    if (state.busy || event.button !== 0 || !state.config) return;
    event.preventDefault(); event.stopPropagation();
    state.selected = id;
    const zone = state.config.zones.find(item => item.id === id);
    state.drag = { id, edges, pointer: event.pointerId, startX: event.clientX, startY: event.clientY,
      rect: zoneWorkRect(zone, state.display), config: copy(state.config), before: snapshot(), node: event.currentTarget };
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId); render();
  }

  function moveDrag(event) {
    const drag = state.drag;
    if (!drag || drag.pointer !== event.pointerId || state.busy) return;
    const box = stage.getBoundingClientRect(), display = state.display;
    const size = screenSize(display);
    const dx = Math.round((event.clientX - drag.startX) / Math.max(1, stage.clientWidth) * size.width);
    const dy = Math.round((event.clientY - drag.startY) / Math.max(1, stage.clientHeight) * size.height);
    const patch = { ...drag.rect };
    if (!drag.edges) { patch.x += dx; patch.y += dy; }
    else {
      if (drag.edges.includes("e")) patch.width += dx;
      if (drag.edges.includes("s")) patch.height += dy;
      if (drag.edges.includes("w")) { patch.x += dx; patch.width -= dx; }
      if (drag.edges.includes("n")) { patch.y += dy; patch.height -= dy; }
    }
    const result = updateZonePixels(drag.config, drag.id, patch, display, {
      mode: drag.edges ? "resize" : "move", edges: drag.edges || "se", snap: state.snap && !event.altKey,
      threshold: Math.max(1, Math.round(6 * size.width / Math.max(1, box.width))), marginIcons: state.marginIcons,
    });
    state.guides = result.guides;
    setConfig(result.config, { history: false });
  }

  function finishDrag() {
    if (!state.drag) return;
    const drag = state.drag;
    state.drag = null; remember(drag.before);
    if (drag.node.hasPointerCapture(drag.pointer)) drag.node.releasePointerCapture(drag.pointer);
    state.guides = []; keepDraft(); render();
  }

  function endDrag(event) {
    if (state.drag?.pointer !== event.pointerId) return;
    // Pointerup can carry a final coordinate without a preceding move event.
    if (event.type === "pointerup") moveDrag(event);
    finishDrag();
  }

  function keyboardGeometry(event, id) {
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction || state.busy) return;
    event.preventDefault(); event.stopPropagation();
    const zone = state.config.zones.find(item => item.id === id);
    const rect = zoneWorkRect(zone, state.display), step = event.shiftKey ? 10 : 1;
    const resizing = event.ctrlKey || event.metaKey;
    const patch = resizing ? { width: rect.width + direction[0] * step, height: rect.height + direction[1] * step } :
      { x: rect.x + direction[0] * step, y: rect.y + direction[1] * step };
    const result = updateZonePixels(state.config, id, patch, state.display, { mode: resizing ? "resize" : "move", edges: "se", snap: false });
    state.guides = []; setConfig(result.config);
  }

  field("monitor").addEventListener("change", () => { if (!state.busy) chooseMonitor(field("monitor").value); });
  field("selected").addEventListener("change", () => { state.selected = field("selected").value; render(); });
  field("label").addEventListener("input", () => {
    if (state.busy) return;
    const config = copy(state.config); config.zones.find(zone => zone.id === state.selected).label = field("label").value;
    setConfig(config);
  });
  field("kind").addEventListener("change", () => {
    if (state.busy || selectedZone()?.kind === "calendar") return;
    const config = copy(state.config); config.zones.find(zone => zone.id === state.selected).kind = field("kind").value;
    setConfig(config);
  });
  for (const input of section.querySelectorAll("[data-zone-geometry]")) input.addEventListener("change", () => {
    if (state.busy || !state.config) return;
    const value = Number(input.value), key = input.dataset.zoneGeometry;
    if (input.value === "" || !Number.isFinite(value) || value < Number(input.min) || value > Number(input.max)
        || (state.unit === "px" && !Number.isInteger(value))) {
      input.setAttribute("aria-invalid", "true"); tell(state.unit === "px" ? "请输入范围内的整数像素。" : "请输入范围内的百分比。", true); return;
    }
    input.removeAttribute("aria-invalid");
    const metrics = getLayoutMetrics(state.display), extent = ["x", "width"].includes(key) ? metrics.workWidth : metrics.workHeight;
    const pixels = state.unit === "percent" ? Math.round(value * extent / 100) : value;
    const resizing = ["width", "height"].includes(key);
    const result = updateZonePixels(state.config, state.selected, { [key]: pixels }, state.display,
      { mode: resizing ? "resize" : "move", edges: key === "height" ? "s" : "e", snap: false });
    state.guides = []; setConfig(result.config);
    const actual = zoneWorkRect(selectedZone(), state.display)[key];
    syncInput(input, state.unit === "px" ? actual : Number((actual / extent * 100).toFixed(6)), true);
    tell(result.blocked ? "已停在可用边界，避免与其他分区重叠。" : "");
  });
  field("unit").addEventListener("change", () => {
    state.unit = field("unit").value === "percent" ? "percent" : "px";
    // Changing units only changes the display, never the saved geometry.
    render();
  });
  field("margin").addEventListener("change", () => {
    state.marginIcons = Number(field("margin").value); keepDraft(); render();
  });
  field("snap").addEventListener("change", () => { state.snap = field("snap").checked; state.guides = []; render(); });
  action("margins").addEventListener("click", () => {
    if (state.busy || !state.config) return;
    const result = fitLayoutToMargins(state.config, state.display, state.marginIcons, { preserveBreathingRoom: true });
    if (result.error) { tell(result.error, true); return; }
    setConfig(result.config); tell(state.marginIcons ? `已在四周预留 ${state.marginIcons} 个图标的空间，可继续微调。` : "已整理至工作区内，可继续微调。");
  });
  action("expand").addEventListener("click", () => setExpanded(!state.expanded));
  action("undo").addEventListener("click", () => travelHistory("undo"));
  action("redo").addEventListener("click", () => travelHistory("redo"));
  for (const button of section.querySelectorAll("[data-zone-nudge]")) button.addEventListener("click", () => {
    if (state.busy || !selectedZone()) return;
    const direction = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[button.dataset.zoneNudge];
    const rect = zoneWorkRect(selectedZone(), state.display);
    const result = updateZonePixels(state.config, state.selected,
      { x: rect.x + direction[0], y: rect.y + direction[1] }, state.display, { mode: "move", snap: false });
    state.guides = []; setConfig(result.config);
  });
  for (const name of ["fit", "panelStyle"]) field(name).addEventListener("change", () => {
    if (!state.busy) setConfig({ ...state.config, [name]: field(name).value }, { preset: state.preset, composition: state.composition });
  });
  function setOpacity(value) {
    if (state.busy || !state.config || !Number.isFinite(value)) return;
    setConfig({ ...state.config, panelOpacity: Math.max(0, Math.min(100, value)) / 100 }, { preset: state.preset, composition: state.composition });
  }
  field("opacity").addEventListener("input", () => setOpacity(Number(field("opacity").value)));
  field("opacityNumber").addEventListener("change", () => {
    if (!field("opacityNumber").validity.valid || field("opacityNumber").value === "") {
      tell("底板强度请输入 0 到 100。", true); return;
    }
    setOpacity(Number(field("opacityNumber").value));
  });
  for (const button of section.querySelectorAll("[data-zone-preset]")) button.addEventListener("click", () => {
    if (!state.config || state.busy) return;
    const preset = button.dataset.zonePreset;
    const composition = state.composition || "balanced";
    const template = createDefaultConfig(state.display, preset, { marginIcons: state.marginIcons, composition });
    setConfig({ ...state.config, zones: template.zones }, { preset, composition }); tell("");
  });
  field("composition").addEventListener("change", () => {
    if (state.busy || !state.config) return;
    const composition = field("composition").value;
    if (composition === "custom") { state.composition = ""; keepDraft(); render(); return; }
    const preset = state.preset || (state.display.orientation === "portrait" ? "portrait" : "right");
    const template = createDefaultConfig(state.display, preset, { marginIcons: state.marginIcons, composition });
    setConfig({ ...state.config, zones: template.zones }, { preset, composition }); tell("");
  });
  for (const button of section.querySelectorAll("[data-zone-recipe]")) button.addEventListener("click", () => {
    if (state.busy || !state.config) return;
    const recipe = PANEL_RECIPES.find(item => item.id === button.dataset.zoneRecipe);
    const active = state.config.panelStyle === recipe.style && Math.abs(state.config.panelOpacity - recipe.opacity) < 0.001;
    setConfig({ ...state.config, panelStyle: active ? "auto" : recipe.style, panelOpacity: active ? 0.72 : recipe.opacity },
      { preset: state.preset, composition: state.composition }); tell("");
  });
  action("add").addEventListener("click", () => {
    if (state.busy || !state.config) return;
    const next = addZone(state.config, "files");
    if (!next) { tell("请先缩小或移动已有分区，留出空位后再添加。", true); return; }
    state.selected = next.zones.at(-1).id; setConfig(next); tell("");
  });
  action("remove").addEventListener("click", () => { if (!state.busy) setConfig(removeZone(state.config, state.selected)); });
  action("refresh").addEventListener("click", () => refresh({ force: true }));
  action("desktop").addEventListener("click", async () => {
    if (state.busy || !state.display) return;
    const monitor = state.display.monitor;
    state.busy = true; render();
    try {
      const result = await bridge.desktopZonesStatus();
      const current = result.monitors?.find(display => display.monitor === monitor);
      if (!current) throw new Error("这台显示器已断开，请刷新显示器列表。");
      state.status = result; state.display = current;
      await loadSource(current.sourcePath || current.wallpaperPath, { markDirty: true });
    } catch (error) { tell(error.message || String(error), true); }
    finally { state.busy = false; render(); }
  });
  action("image").addEventListener("click", async () => {
    if (state.busy) return;
    const epoch = state.epoch, monitor = state.display?.monitor;
    try {
      const path = await bridge.pickImage?.();
      if (path && epoch === state.epoch && monitor === state.display?.monitor && !state.busy) await loadSource(path, { markDirty: true });
    } catch (error) { tell(error.message || String(error), true); }
  });

  action("apply").addEventListener("click", async () => {
    if (state.busy || !state.sourceReady || !state.config || isUnsupported()) return;
    const errors = validateConfig(state.config, state.display);
    if (errors.length) { render(); return; }
    state.busy = true; render(); tell("正在生成分区壁纸…");
    try {
      const output = document.createElement("canvas");
      renderDesktopZones(output, state.config, state.display, state.image);
      const png = output.toDataURL("image/png");
      output.width = 1; output.height = 1;
      tell("正在应用壁纸并对齐日历…");
      const result = await bridge.desktopZonesApply(copy(state.config), png);
      state.status = result; state.dirty = false; keepDraft();
      tell("分区壁纸已应用，日历已对齐。软件与文件图标可直接拖入对应区域。");
      try { await onApplied?.(result); }
      catch (error) { tell(`壁纸已应用，日历状态刷新失败：${error.message || String(error)}`, true); }
    } catch (error) { tell(error.message || String(error), true); }
    finally { state.busy = false; render(); }
  });

  action("restore").addEventListener("click", async () => {
    if (state.busy || !state.display) return;
    state.busy = true; render(); tell("正在恢复原壁纸…");
    try {
      const result = await bridge.desktopZonesRestore(state.display.monitor);
      state.status = result;
      tell(state.dirty ? "原壁纸已恢复。当前未应用的分区草稿仍保留。" : "原壁纸已恢复，当前布局可随时再次应用。");
      try { await onApplied?.(result); }
      catch (error) { tell(`原壁纸已恢复，日历状态刷新失败：${error.message || String(error)}`, true); }
    } catch (error) { tell(error.message || String(error), true); }
    finally { state.busy = false; render(); }
  });

  // Images are loaded only when this section becomes visible, avoiding startup work.
  const visibility = new MutationObserver(() => {
    if (state.expanded && (section.hidden || !document.body.classList.contains("kal-panel-open"))) setExpanded(false, { returnFocus: false });
    if (!section.hidden && !state.initialized) refresh();
  });
  visibility.observe(section, { attributes: true, attributeFilter: ["hidden"] });
  visibility.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  const editingInput = target => target?.closest?.("input,textarea,select,[contenteditable='true']");
  section.addEventListener("keydown", event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing) return;
    const key = event.key.toLowerCase();
    if (!["z", "y"].includes(key)) return;
    // Inputs keep native text undo, while the calendar's window handler must not run.
    event.stopPropagation();
    if (editingInput(event.target)) return;
    event.preventDefault(); travelHistory(key === "y" || event.shiftKey ? "redo" : "undo");
  }, true);
  window.addEventListener("keydown", event => {
    if (!state.expanded) return;
    if (event.key === "Escape" && !event.isComposing) {
      event.preventDefault(); event.stopImmediatePropagation(); finishDrag(); setExpanded(false); return;
    }
    if (event.key !== "Tab") return;
    const controls = [...section.querySelectorAll("button,input,select,[tabindex='0']")]
      .filter(node => !node.disabled && node.getClientRects().length && getComputedStyle(node).visibility !== "hidden");
    const target = document.activeElement;
    if (!controls.length) return;
    if (!section.contains(target) || (!event.shiftKey && target === controls.at(-1)) || (event.shiftKey && target === controls[0])) {
      event.preventDefault(); (event.shiftKey ? controls.at(-1) : controls[0]).focus();
    }
  }, true);
  if (typeof ResizeObserver !== "undefined") {
    const sizeObserver = new ResizeObserver(() => fitStage());
    sizeObserver.observe(query(".kal-zones-stage-column"));
  }
  if (typeof IntersectionObserver !== "undefined") {
    const intersection = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting) && !state.initialized) refresh();
    });
    intersection.observe(section);
  }
  syncControls();
  return { section, refresh };
}
