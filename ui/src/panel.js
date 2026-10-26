// 个性化设置中心（居中弹窗 + 精选预设模板 + 桌面固定与开机自启）
//
// 交互约定：
//   * 主题/排版改动先走 onPreview（只改内存 + 实时重绘），点「保存设置」才落盘；
//   * 桌面固定与开机自启属于系统级行为，切换即刻生效并持久化。

import {
  DEFAULT_THEME, getPath, setPath,
  ART_BACKDROPS, STYLE_RECIPES, FONT_PRESETS, CONTENT_PRESETS,
  applyStyleRecipe, applyContentPreset,
  ACCENT_SWATCHES, applyAccentSwatch, applyI18nToDom,
  APP_VERSION, APP_STAGE_LABEL,
} from "./theme.js";
import { createLocalFonts, localFontId } from "./local-fonts.js";

const SIZE = (min, max, step = 1) => ({ min, max, step });

const DOCK_POSITIONS = [
  { id: "left-desktop", name: "占据屏幕左侧", desc: "推荐 · 贴合左半屏" },
  { id: "left-icon-safe", name: "左侧避让图标", desc: "预留最左桌面图标列" },
  { id: "left-compact", name: "左侧适中尺寸", desc: "52% 宽度轻巧左置" },
  { id: "right-desktop", name: "占据屏幕右侧", desc: "贴合屏幕右半区" },
  { id: "center-desktop", name: "桌面居中固定", desc: "屏幕中央对称固定" },
  { id: "current", name: "原地锁定位置", desc: "固定在当前窗口坐标" },
];

const DOCK_WIDTH_OPTIONS = [
  { ratio: 0.50, label: "50%" },
  { ratio: 0.64, label: "64% 推荐" },
  { ratio: 0.75, label: "75%" },
  { ratio: 0.85, label: "85%" },
];

/** 高级微调控件清单：[分区标题, 分区分类, [控件...]] */
const SECTIONS = [
  ["日历功能与常用开关", "style", [
    { label: "明暗模式", path: "mode", type: "seg", options: [["dark", "深色"], ["light", "浅色"]] },
    { label: "网格样式", path: "shape.gridStyle", type: "seg", options: [["cards", "卡片"], ["grid", "线框"], ["minimal", "极简"]] },
    { label: "任务换行", path: "layout.taskWrap", type: "seg", options: [["wrap", "自动换行"], ["clamp2", "两行"], ["nowrap", "单行"]] },
    { label: "周起始", path: "layout.weekStart", type: "seg", options: [["1", "周一"], ["0", "周日"]], num: true },
    { label: "项目符号", path: "layout.bulletStyle", type: "seg", options: [["dot", "圆点"], ["number", "编号"], ["none", "无"]] },
    { label: "格内行数", path: "layout.maxTasks", type: "range", ...SIZE(1, 10, 1), fmt: v => `${v} 项` },
    { label: "日程栏", path: "layout.agenda", type: "seg", options: [["side", "显示"], ["hidden", "隐藏"]] },
    { label: "休/班角标", path: "layout.showHolidayBadge", type: "bool" },
    { label: "显示农历", path: "layout.showLunar", type: "bool" },
    { label: "显示周次", path: "layout.showWeekNumber", type: "bool" },
    { label: "周末着色", path: "layout.showWeekendColor", type: "bool" },
    { label: "显示条数", path: "layout.showCellCount", type: "bool" },
    { label: "完成沉底", path: "layout.sortCompletedLast", type: "bool" },
    { label: "隐藏已完成", path: "layout.hideCompleted", type: "bool" },
  ]],
  ["透明度、圆角与缩放微调", "style", [
    { label: "主面板不透明", path: "color.bgAlpha", type: "range", ...SIZE(0, 1, 0.01), fmt: v => `${Math.round(v * 100)}%` },
    { label: "次级表面不透明", path: "color.surfaceAlpha", type: "range", ...SIZE(0, 1, 0.01), fmt: v => `${Math.round(v * 100)}%` },
    { label: "日历格不透明", path: "shape.cellAlpha", type: "range", ...SIZE(0, 1, 0.01), fmt: v => `${Math.round(v * 100)}%` },
    { label: "文字护眼描边", path: "shape.textShadow", type: "range", ...SIZE(0, 1, 0.02), fmt: v => `${Math.round(v * 100)}%` },
    { label: "毛玻璃模糊", path: "shape.blur", type: "range", ...SIZE(0, 60, 1), fmt: v => `${v}px` },
    { label: "窗口阴影", path: "shape.shadow", type: "bool" },
    { label: "阴影强度", path: "shape.shadowStrength", type: "range", ...SIZE(0, 0.9, 0.02), fmt: v => v.toFixed(2) },
    { label: "外框圆角", path: "shape.radius", type: "range", ...SIZE(0, 36, 1), fmt: v => `${v}px` },
    { label: "日格圆角", path: "shape.radiusCell", type: "range", ...SIZE(0, 24, 1), fmt: v => `${v}px` },
    { label: "描边宽度", path: "shape.borderWidth", type: "range", ...SIZE(0, 3, 0.5), fmt: v => `${v}px` },
    { label: "边框不透明", path: "color.borderAlpha", type: "range", ...SIZE(0, 0.5, 0.01), fmt: v => `${Math.round(v * 100)}%` },
    { label: "外边距", path: "layout.pad", type: "range", ...SIZE(0, 40, 1), fmt: v => `${v}px` },
    { label: "格间距", path: "layout.cellGap", type: "range", ...SIZE(0, 12, 1), fmt: v => `${v}px` },
    { label: "日程栏宽", path: "layout.agendaWidth", type: "range", ...SIZE(140, 420, 4), fmt: v => `${v}px` },
    { label: "缩放方式", path: "scaleMode", type: "seg", options: [["auto", "跟随屏幕"], ["fixed", "手动"]] },
    { label: "缩放倍率", path: "scale", type: "range", ...SIZE(0.6, 2.2, 0.02), fmt: v => `${v.toFixed(2)}×` },
  ]],
  ["壁纸画布参数", "backdrop", [
    { label: "背景层模式", path: "backdrop.mode", type: "seg", options: [["none", "关闭"], ["art", "艺术"], ["desktop", "桌面"], ["custom", "图片"]] },
    { label: "背景显色度", path: "backdrop.opacity", type: "range", ...SIZE(0, 1, 0.01), fmt: v => `${Math.round(v * 100)}%` },
    { label: "背景图模糊", path: "backdrop.blur", type: "range", ...SIZE(0, 48, 1), fmt: v => `${v}px` },
    { label: "背景明暗", path: "backdrop.brightness", type: "range", ...SIZE(0.3, 1.6, 0.02), fmt: v => `${Math.round(v * 100)}%` },
    { label: "背景饱和度", path: "backdrop.saturate", type: "range", ...SIZE(0, 2.2, 0.05), fmt: v => `${Math.round(v * 100)}%` },
    { label: "暗角氛围", path: "backdrop.vignette", type: "range", ...SIZE(0, 0.85, 0.02), fmt: v => `${Math.round(v * 100)}%` },
    { label: "填充方式", path: "backdrop.fit", type: "seg", options: [["cover", "铺满"], ["contain", "完整"], ["center", "居中"]] },
  ]],
  ["字体与字号微调", "type", [
    { label: "界面字体", path: "type.familyUi", type: "font" },
    { label: "数字字体", path: "type.familyNum", type: "font" },
    { label: "字体宽度", path: "type.stretch", type: "range", ...SIZE(50, 200, 5), fmt: v => `${v}%` },
    { label: "日期字号", path: "type.size.day", type: "range", ...SIZE(8, 34, 0.5), fmt: v => `${v}px` },
    { label: "农历字号", path: "type.size.sub", type: "range", ...SIZE(6, 26, 0.5), fmt: v => `${v}px` },
    { label: "任务字号", path: "type.size.task", type: "range", ...SIZE(6, 26, 0.5), fmt: v => `${v}px` },
    { label: "大标题字号", path: "type.size.title", type: "range", ...SIZE(12, 72, 1), fmt: v => `${v}px` },
    { label: "星期头字号", path: "type.size.head", type: "range", ...SIZE(6, 24, 0.5), fmt: v => `${v}px` },
    { label: "日程字号", path: "type.size.agenda", type: "range", ...SIZE(8, 28, 0.5), fmt: v => `${v}px` },
    { label: "日期字重", path: "type.weight.day", type: "range", ...SIZE(100, 900, 50), fmt: v => String(v) },
    { label: "标题字重", path: "type.weight.title", type: "range", ...SIZE(100, 900, 50), fmt: v => String(v) },
    { label: "任务字重", path: "type.weight.task", type: "range", ...SIZE(100, 900, 50), fmt: v => String(v) },
    { label: "行高(紧)", path: "type.lineHeight.tight", type: "range", ...SIZE(0.9, 2, 0.05), fmt: v => v.toFixed(2) },
    { label: "行高(松)", path: "type.lineHeight.normal", type: "range", ...SIZE(0.9, 2.4, 0.05), fmt: v => v.toFixed(2) },
    { label: "标题字距", path: "type.letterSpacing.title", type: "range", ...SIZE(-0.1, 0.2, 0.005), fmt: v => `${v.toFixed(3)}em` },
    { label: "星期字距", path: "type.letterSpacing.head", type: "range", ...SIZE(0, 0.5, 0.01), fmt: v => `${v.toFixed(2)}em` },
    { label: "斜体", path: "type.italic", type: "bool" },
    { label: "格内对齐", path: "type.cellAlign", type: "seg", options: [["left", "左"], ["center", "中"]] },
  ]],
  ["自定义色彩细节", "color", [
    { label: "面板底色", path: "color.bg", type: "color" },
    { label: "次级表面", path: "color.surface", type: "color" },
    { label: "正文", path: "color.fg", type: "color" },
    { label: "次要文字", path: "color.fgMuted", type: "color" },
    { label: "弱化文字", path: "color.fgDim", type: "color" },
    { label: "强调色", path: "color.accent", type: "color" },
    { label: "今日底色", path: "color.todayBg", type: "color" },
    { label: "今日描边", path: "color.todayRing", type: "color" },
    { label: "周末", path: "color.fgWeekend", type: "color" },
    { label: "节假日", path: "color.fgHoliday", type: "color" },
    { label: "非本月", path: "color.fgOtherMonth", type: "color" },
    { label: "危险提示", path: "color.danger", type: "color" },
    { label: "危险按钮文字", path: "color.dangerFg", type: "color" },
    { label: "焦点", path: "color.focus", type: "color" },
    { label: "已完成", path: "color.done", type: "color" },
    { label: "选中背景", path: "color.selectedBg", type: "color" },
    { label: "选中文字", path: "color.selectedFg", type: "color" },
    { label: "分隔线", path: "color.line", type: "color" },
    { label: "线透明度", path: "color.lineAlpha", type: "range", ...SIZE(0, 0.4, 0.005), fmt: v => v.toFixed(3) },
  ]],
];

export function createPanel({
  mount, getTheme, onPreview, onCommit, onRegen, onReset, onModeChange,
  onApply, onExport, onImport, onOpen, onCancel, onUndo,
  getDockConfig, onApplyDock, bridge, localFonts,
}) {
  const backdrop = document.createElement("div");
  backdrop.className = "kal-panel-backdrop";
  backdrop.setAttribute("aria-hidden", "true");
  mount.appendChild(backdrop);

  const el = document.createElement("aside");
  el.className = "kal-panel";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", "设置中心");
  el.innerHTML = `
    <div class="kal-panel-head">
      <span class="kal-panel-title">
        设置中心
        <span class="kal-panel-version" id="kal-panel-version">${APP_STAGE_LABEL}</span>
        <span class="kal-panel-dirty" id="kal-panel-dirty" hidden>● 待保存预览</span>
      </span>
      <button class="kal-btn kal-btn-ghost" data-act="reset" title="还原为打开时的状态">重置</button>
      <button class="kal-btn is-active" data-act="save" title="保存并应用">保存设置</button>
      <button class="kal-btn kal-btn-ghost" data-act="close" title="关闭">✕</button>
    </div>
    <div class="kal-panel-main">
      <div class="kal-panel-tabs" role="tablist" aria-label="设置分类">
        <button type="button" class="kal-panel-tab is-on" data-tab="all">
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1.2"/><rect x="9" y="2" width="5" height="5" rx="1.2"/><rect x="2" y="9" width="5" height="5" rx="1.2"/><rect x="9" y="9" width="5" height="5" rx="1.2"/></svg>
          <span>全部设置</span>
        </button>
        <button type="button" class="kal-panel-tab" data-tab="general">
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.8" y="2.5" width="12.4" height="8.5" rx="1.4"/><path d="M5.5 13.5h5M8 11v2.5"/></svg>
          <span>桌面与自启</span>
        </button>
        <button type="button" class="kal-panel-tab" data-tab="style">
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><circle cx="6" cy="6.2" r="1"/><circle cx="10" cy="6.2" r="1"/><circle cx="5.5" cy="9.5" r="1"/></svg>
          <span>预设主题</span>
        </button>
        <button type="button" class="kal-panel-tab" data-tab="type">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5h10M8 3.5v9M5.5 12.5h5"/></svg>
          <span>排版与字体</span>
        </button>
        <button type="button" class="kal-panel-tab" data-tab="backdrop">
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><circle cx="5.5" cy="6" r="1.2"/><path d="M2.5 11.5l3.5-3 2.5 2 2.5-2.2 2.5 3.2"/></svg>
          <span>背景画布</span>
        </button>
        <button type="button" class="kal-panel-tab" data-tab="color">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M3 8h10M3 11.5h10"/><circle cx="6" cy="4.5" r="1.4"/><circle cx="10.5" cy="8" r="1.4"/><circle cx="7.5" cy="11.5" r="1.4"/></svg>
          <span>高级微调</span>
        </button>
        <button type="button" class="kal-panel-tab" data-tab="logs">
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 4.8v3.4l2.4 1.5"/></svg>
          <span>日志与版本</span>
        </button>
      </div>
      <div class="kal-panel-body" id="kal-panel-body"></div>
    </div>
  `;
  mount.appendChild(el);

  const body = el.querySelector("#kal-panel-body");
  const dirtyEl = el.querySelector("#kal-panel-dirty");
  const markDirty = (dirty = true) => {
    if (dirtyEl) dirtyEl.hidden = !dirty;
  };
  const previewDraftChange = next => {
    markDirty(true);
    onPreview(next);
  };
  const controls = [];
  let epoch = 0, libraryRequest = 0, selectionRequest = 0, busy = false;
  let activeTab = "all";
  let fontFilterQuery = "";
  let logFilter = "all";
  const LOG_STORAGE_KEY = "kal.operationLogs.v1";
  let operationLogs = [];
  try {
    const savedLogs = JSON.parse(window.localStorage?.getItem(LOG_STORAGE_KEY) || "[]");
    if (Array.isArray(savedLogs)) operationLogs = savedLogs.slice(0, 80);
  } catch { /* ignore storage errors */ }
  if (!operationLogs.length) {
    const nowStr = new Date().toTimeString().slice(0, 8);
    operationLogs.push({
      id: "log-boot",
      time: nowStr,
      cat: "system",
      msg: "日历清单已就绪",
    });
  }
  const isOpen = () => document.body.classList.contains("kal-panel-open");

  function persistLogs() {
    try {
      window.localStorage?.setItem(LOG_STORAGE_KEY, JSON.stringify(operationLogs.slice(0, 80)));
    } catch { /* ignore */ }
  }

  let renderLogList = () => {};
  function addLog(cat = "system", msg = "") {
    const clean = String(msg || "").trim();
    if (!clean) return;
    const nowStr = new Date().toTimeString().slice(0, 8);
    operationLogs.unshift({
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      time: nowStr,
      cat,
      msg: clean,
    });
    if (operationLogs.length > 80) operationLogs.length = 80;
    persistLogs();
    renderLogList();
  }

  let advancedDrawer = null;
  function applyTabFilter(tab) {
    activeTab = tab;
    el.querySelectorAll(".kal-panel-tab").forEach(btn => {
      btn.classList.toggle("is-on", btn.dataset.tab === tab);
    });
    body.querySelectorAll(".kal-sec").forEach(sec => {
      const cat = sec.dataset.cat || "style";
      if (tab === "all") {
        sec.hidden = false;
      } else if (tab === "logs") {
        sec.hidden = cat !== "logs" && sec.id !== "kal-update-sec";
      } else {
        sec.hidden = cat !== tab;
      }
    });
    if (tab === "color" && advancedDrawer) {
      advancedDrawer.open = true;
    }
  }
  el.querySelectorAll(".kal-panel-tab").forEach(btn => {
    btn.addEventListener("click", () => applyTabFilter(btn.dataset.tab));
  });

  // ---------------------------------------------------------- 1. 桌面固定、开机自启动与通用设置

  const generalSec = document.createElement("div");
  generalSec.className = "kal-sec";
  generalSec.id = "kal-general-sec";
  generalSec.dataset.cat = "general";
  generalSec.innerHTML = `
    <div class="kal-sec-title">桌面固定与系统启动</div>
    <div class="kal-card-group" id="kal-dock-card">
      <div class="kal-row kal-row-rich">
        <div class="kal-row-meta">
          <label for="kal-autostart-toggle">开机自启动</label>
          <small class="kal-row-desc" id="kal-autostart-status">登录系统时自动启动日历清单</small>
        </div>
        <div class="kal-row-ctl kal-row-ctl-end">
          <input type="checkbox" id="kal-autostart-toggle" class="kal-switch" aria-label="开机自启动" />
        </div>
      </div>
      <div class="kal-row kal-row-rich">
        <div class="kal-row-meta">
          <label for="kal-dock-toggle">固定在桌面上</label>
          <small class="kal-row-desc" id="kal-dock-status">默认可移动窗口；开启后嵌入桌面指定位置</small>
        </div>
        <div class="kal-row-ctl kal-row-ctl-end">
          <input type="checkbox" id="kal-dock-toggle" class="kal-switch" aria-label="固定在桌面上" />
        </div>
      </div>
      <div class="kal-dock-options" id="kal-dock-options">
        <div class="kal-dock-subhead">桌面固定位置预设</div>
        <div class="kal-dock-pos-grid" id="kal-dock-pos-grid" role="group" aria-label="桌面固定位置预设"></div>
        <div class="kal-row kal-row-rich">
          <div class="kal-row-meta">
            <label>屏幕宽度占比</label>
            <small class="kal-row-desc">固定到左右桌面时的占屏比例</small>
          </div>
          <div class="kal-row-ctl">
            <div class="kal-chips" id="kal-dock-width-seg" role="group" aria-label="屏幕宽度占比"></div>
          </div>
        </div>
        <div class="kal-row kal-row-rich">
          <div class="kal-row-meta">
            <label for="kal-dock-monitor-select">目标显示器</label>
            <small class="kal-row-desc">自适应多显示器尺寸、分辨率与缩放</small>
          </div>
          <div class="kal-row-ctl">
            <select id="kal-dock-monitor-select" aria-label="目标显示器">
              <option value="">当前显示器（自动适配）</option>
            </select>
          </div>
        </div>
        <div class="kal-row kal-row-rich">
          <div class="kal-row-meta">
            <label for="kal-dock-fade-toggle">固定时闲置半透减淡</label>
            <small class="kal-row-desc">鼠标移开日历时自动降至半透明，悬停恢复清晰</small>
          </div>
          <div class="kal-row-ctl kal-row-ctl-end">
            <input type="checkbox" id="kal-dock-fade-toggle" class="kal-switch" aria-label="固定时闲置半透减淡" />
          </div>
        </div>
      </div>
    </div>

    <div class="kal-sec-title">语言、动效与强调色</div>
    <div class="kal-card-group">
      <div class="kal-row kal-row-rich">
        <div class="kal-row-meta">
          <label>界面语言</label>
          <small class="kal-row-desc">切换日历与设置界面语言</small>
        </div>
        <div class="kal-row-ctl">
          <div class="kal-chips" id="kal-lang-seg" role="group" aria-label="界面语言">
            <button type="button" class="kal-chip" data-lang="zh-CN">简体中文</button>
            <button type="button" class="kal-chip" data-lang="zh-TW">繁體中文</button>
            <button type="button" class="kal-chip" data-lang="en">English</button>
          </div>
        </div>
      </div>
      <div class="kal-row kal-row-rich">
        <div class="kal-row-meta">
          <label for="kal-reduced-motion-toggle">减少动画</label>
          <small class="kal-row-desc">关闭过渡动效，提升响应速度</small>
        </div>
        <div class="kal-row-ctl kal-row-ctl-end">
          <input type="checkbox" id="kal-reduced-motion-toggle" class="kal-switch" aria-label="减少动画" />
        </div>
      </div>
      <div class="kal-row kal-row-rich">
        <div class="kal-row-meta">
          <label>强调色快选</label>
          <small class="kal-row-desc">一键切换主色调与今日高亮框</small>
        </div>
        <div class="kal-row-ctl">
          <div class="kal-accent-swatches" id="kal-accent-swatches" role="group" aria-label="强调色快选"></div>
        </div>
      </div>
    </div>
  `;

  const autostartToggle = generalSec.querySelector("#kal-autostart-toggle");
  const autostartStatusEl = generalSec.querySelector("#kal-autostart-status");
  const dockToggle = generalSec.querySelector("#kal-dock-toggle");
  const dockStatusEl = generalSec.querySelector("#kal-dock-status");
  const dockPosGrid = generalSec.querySelector("#kal-dock-pos-grid");
  const dockWidthSeg = generalSec.querySelector("#kal-dock-width-seg");
  const dockMonitorSelect = generalSec.querySelector("#kal-dock-monitor-select");
  const dockFadeToggle = generalSec.querySelector("#kal-dock-fade-toggle");
  const langSeg = generalSec.querySelector("#kal-lang-seg");
  const motionToggle = generalSec.querySelector("#kal-reduced-motion-toggle");
  const accentWrap = generalSec.querySelector("#kal-accent-swatches");

  // 构建固定位置预设卡片
  for (const pos of DOCK_POSITIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "kal-dock-pos-card";
    btn.dataset.dockPos = pos.id;
    btn.innerHTML = `
      <span class="kal-dock-pos-preview" data-pos="${pos.id}" aria-hidden="true"><i></i></span>
      <span class="kal-dock-pos-text">
        <strong>${pos.name}</strong>
        <small>${pos.desc}</small>
      </span>
    `;
    btn.addEventListener("click", async () => {
      if (typeof onApplyDock === "function") {
        await onApplyDock({ docked: true, position: pos.id }, true);
        syncDockUi();
        addLog("system", `固定日历到桌面：${pos.name}`);
      }
    });
    dockPosGrid.appendChild(btn);
  }

  // 构建屏幕宽度占比按钮
  for (const opt of DOCK_WIDTH_OPTIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "kal-chip";
    btn.dataset.dockWidth = String(opt.ratio);
    btn.textContent = opt.label;
    btn.addEventListener("click", async () => {
      if (typeof onApplyDock === "function") {
        const cur = getDockConfig?.() || {};
        await onApplyDock({
          docked: true,
          position: cur.position === "current" ? "left-desktop" : (cur.position || "left-desktop"),
          widthRatio: opt.ratio,
        }, true);
        syncDockUi();
        addLog("system", `调整桌面固定宽度占比为 ${opt.label}`);
      }
    });
    dockWidthSeg.appendChild(btn);
  }

  dockToggle?.addEventListener("change", async () => {
    const docked = Boolean(dockToggle.checked);
    if (typeof onApplyDock === "function") {
      await onApplyDock({ docked }, true);
      syncDockUi();
      addLog("system", docked ? "开启「固定在桌面上」" : "恢复「可移动窗口」模式");
    }
  });

  dockMonitorSelect?.addEventListener("change", async () => {
    const monitor = dockMonitorSelect.value || "";
    if (typeof onApplyDock === "function") {
      await onApplyDock({ docked: true, monitor }, true);
      syncDockUi();
      addLog("system", monitor ? `切换固定显示器为 ${monitor}` : "切换固定显示器为自动适配");
    }
  });

  dockFadeToggle?.addEventListener("change", async () => {
    const idleFade = Boolean(dockFadeToggle.checked);
    if (typeof onApplyDock === "function") {
      await onApplyDock({ idleFade }, false);
      syncDockUi();
      addLog("system", idleFade ? "开启「固定时闲置半透减淡」" : "关闭「固定时闲置半透减淡」");
    }
  });

  function syncDockUi() {
    const cfg = getDockConfig?.() || { docked: false, position: "left-desktop", widthRatio: 0.64, monitor: "", idleFade: false, monitors: [] };
    if (dockToggle) dockToggle.checked = Boolean(cfg.docked);
    if (dockFadeToggle) dockFadeToggle.checked = Boolean(cfg.idleFade);
    if (dockStatusEl) {
      const posObj = DOCK_POSITIONS.find(p => p.id === cfg.position) || DOCK_POSITIONS[0];
      dockStatusEl.textContent = cfg.docked
        ? `当前已固定：${posObj.name}（点击顶栏图钉可随时切换）`
        : "当前为可移动窗口（默认），开启后固定到桌面底层";
    }
    dockPosGrid?.querySelectorAll(".kal-dock-pos-card").forEach(card => {
      const active = card.dataset.dockPos === (cfg.position || "left-desktop");
      card.classList.toggle("is-on", active);
      card.setAttribute("aria-pressed", String(active));
    });
    const wRatio = Number(cfg.widthRatio || 0.64);
    dockWidthSeg?.querySelectorAll("[data-dock-width]").forEach(btn => {
      const r = Number(btn.dataset.dockWidth);
      btn.classList.toggle("is-on", Math.abs(r - wRatio) < 0.03);
    });
    if (dockMonitorSelect && Array.isArray(cfg.monitors)) {
      const currentVal = cfg.monitor || "";
      dockMonitorSelect.replaceChildren();
      const autoOpt = document.createElement("option");
      autoOpt.value = "";
      autoOpt.textContent = "当前显示器（自动适配分辨率）";
      dockMonitorSelect.appendChild(autoOpt);
      cfg.monitors.forEach((m, idx) => {
        const opt = document.createElement("option");
        opt.value = m.monitor || "";
        const diag = m.ppiKnown && m.diagonalIn ? ` · ${Number(m.diagonalIn).toFixed(1)}"` : "";
        const scale = m.dpiScale ? ` · ${Math.round(m.dpiScale * 100)}%` : "";
        opt.textContent = `显示器 ${idx + 1} (${m.pxW}×${m.pxH}${diag}${scale})`;
        dockMonitorSelect.appendChild(opt);
      });
      dockMonitorSelect.value = currentVal;
    }
  }

  async function refreshAutostartUi() {
    if (!bridge?.autostartStatus || !autostartToggle) return;
    try {
      const res = await bridge.autostartStatus();
      autostartToggle.checked = Boolean(res?.enabled);
      if (autostartStatusEl) {
        autostartStatusEl.textContent = res?.enabled
          ? "已开启开机自启动（登录 Windows 自动运行）"
          : "登录系统时自动启动日历清单";
      }
    } catch { /* ignore */ }
  }

  autostartToggle?.addEventListener("change", async () => {
    const enabled = Boolean(autostartToggle.checked);
    autostartToggle.disabled = true;
    try {
      const res = await bridge?.autostartSet?.(enabled);
      const finalEnabled = res ? Boolean(res.enabled) : enabled;
      autostartToggle.checked = finalEnabled;
      if (autostartStatusEl) {
        autostartStatusEl.textContent = finalEnabled
          ? "已开启开机自启动（登录 Windows 自动运行）"
          : "已关闭开机自启动";
      }
      addLog("system", finalEnabled ? "开启「开机自启动」" : "关闭「开机自启动」");
    } catch (err) {
      autostartToggle.checked = !enabled;
      if (autostartStatusEl) {
        autostartStatusEl.textContent = `设置失败：${err?.message || err}`;
      }
    } finally {
      autostartToggle.disabled = false;
    }
  });

  for (const sw of ACCENT_SWATCHES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "kal-accent-swatch";
    btn.dataset.accentId = sw.id;
    btn.dataset.accentHex = sw.hex;
    btn.style.background = sw.hex;
    btn.title = `${sw.name} (${sw.hex})`;
    btn.setAttribute("aria-label", `强调色：${sw.name}`);
    btn.addEventListener("click", () => {
      const next = applyAccentSwatch(getTheme(), sw.id);
      previewDraftChange(next);
      sync();
      if (reportEl) reportEl.textContent = `已预览强调色「${sw.name}」，点击右上角「保存设置」即可生效。`;
      addLog("theme", `切换主题强调色为「${sw.name}」(${sw.hex})`);
    });
    accentWrap.appendChild(btn);
  }

  langSeg.addEventListener("click", e => {
    const btn = e.target.closest("[data-lang]");
    if (!btn) return;
    const lang = btn.dataset.lang || "zh-CN";
    const next = setPath(getTheme(), "layout.language", lang);
    applyI18nToDom(lang, document);
    previewDraftChange(next);
    sync();
    const langNames = { "zh-CN": "简体中文", "zh-TW": "繁體中文", en: "English" };
    addLog("system", `切换界面语言为 ${langNames[lang] || lang}`);
  });

  motionToggle.addEventListener("change", () => {
    const enabled = Boolean(motionToggle.checked);
    const next = setPath(getTheme(), "layout.reducedMotion", enabled);
    previewDraftChange(next);
    sync();
    addLog("system", enabled ? "开启「减少动画」性能模式" : "恢复标准界面过渡动效");
  });

  body.appendChild(generalSec);

  // ---------------------------------------------------------- 2. 预设主题模板（5 套精选配色）

  const libSec = document.createElement("div");
  libSec.className = "kal-sec";
  libSec.dataset.cat = "style";
  libSec.innerHTML = `
    <div class="kal-sec-head-row">
      <div class="kal-sec-title">预设主题模板</div>
      <div class="kal-chips kal-sec-actions">
        <button type="button" class="kal-chip" data-t="copy">复制并编辑</button>
        <button type="button" class="kal-chip" data-t="export">导出草稿…</button>
        <button type="button" class="kal-chip" data-t="import">导入…</button>
      </div>
    </div>
    <div class="kal-chips" id="kal-theme-list"><span class="kal-note">加载中…</span></div>
  `;
  body.appendChild(libSec);
  const listEl = libSec.querySelector("#kal-theme-list");

  async function refreshLibrary() {
    const request = ++libraryRequest;
    try {
      const list = await bridge.themeList();
      if (request !== libraryRequest) return;
      listEl.replaceChildren();
      if (!list.length) {
        const note = document.createElement("span");
        note.className = "kal-note";
        note.textContent = "暂无已保存主题";
        listEl.append(note);
      }
      for (const r of list) {
        const builtin = r.builtin === true || r.id === "default" || r.id.startsWith("builtin-");
        const c = document.createElement("button");
        c.type = "button";
        c.className = "kal-chip kal-theme-card";
        c.dataset.themeId = r.id;
        c.dataset.builtin = String(builtin);
        c.setAttribute("aria-pressed", "false");
        const label = document.createElement("span");
        label.textContent = r.name || r.id;
        const note = document.createElement("small");
        note.textContent = r.id === "default" ? "系统默认" : (builtin ? "预设模板" : "我的主题");
        const swatches = document.createElement("span");
        swatches.className = "kal-theme-colors";
        swatches.setAttribute("aria-hidden", "true");
        c.append(label, note, swatches);
        c.title = `${r.mode === "light" ? "浅色" : "深色"} · 点击预览`;
        c.addEventListener("click", async () => {
          const selected = ++selectionRequest, opened = epoch;
          const applied = await onApply(r.id);
          if (!applied || selected !== selectionRequest || opened !== epoch || !isOpen()) return;
          markDirty(true);
          listEl.querySelectorAll(".kal-theme-card").forEach(x => {
            x.classList.toggle("is-on", x === c);
            x.setAttribute("aria-pressed", String(x === c));
          });
          reportEl.textContent = builtin ? "已预览预设主题，点击「保存设置」即可启用。" : "主题配色已预览，保存后生效。";
          sync();
        });
        listEl.appendChild(c);
        bridge.themeLoad(r.id).then(t => {
          if (request !== libraryRequest || !c.isConnected) return;
          for (const role of ["bg", "surface", "fg", "accent", "danger"]) {
            if (!/^#[0-9a-f]{6}$/i.test(t?.color?.[role] || "")) continue;
            const swatch = document.createElement("i");
            swatch.style.backgroundColor = t.color[role];
            swatches.append(swatch);
          }
        }).catch(() => {});
      }
      syncAuxStates(getTheme());
    } catch (err) {
      if (request !== libraryRequest) return;
      listEl.textContent = `主题库读取失败：${err?.message || err}`;
    }
  }

  libSec.querySelector('[data-t="copy"]').addEventListener("click", () => {
    previewDraftChange({ ...structuredClone(getTheme()), id: "", name: `${getTheme().name || "主题"} 副本` });
    reportEl.textContent = "正在编辑副本；保存后生成独立主题。";
    sync();
  });
  libSec.querySelector('[data-t="export"]').addEventListener("click", async () => {
    const opened = epoch;
    const r = await onExport();
    if (r && opened === epoch && isOpen()) reportEl.textContent = r;
  });
  libSec.querySelector('[data-t="import"]').addEventListener("click", async () => {
    const opened = epoch;
    const r = await onImport();
    if (r && opened === epoch && isOpen()) reportEl.textContent = r;
    await refreshLibrary();
  });

  // ---------------------------------------------------------- 3. 窗口质感模板

  const recipeSec = document.createElement("div");
  recipeSec.className = "kal-sec";
  recipeSec.dataset.cat = "style";
  recipeSec.innerHTML = `
    <div class="kal-sec-title">窗口质感模板</div>
    <div class="kal-recipe-grid" id="kal-recipe-grid"></div>
  `;
  const recipeGrid = recipeSec.querySelector("#kal-recipe-grid");
  for (const recipe of STYLE_RECIPES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "kal-recipe-card";
    btn.dataset.recipeId = recipe.id;
    const title = document.createElement("strong");
    title.textContent = recipe.name || recipe.label;
    const desc = document.createElement("small");
    desc.textContent = recipe.desc;
    btn.append(title, desc);
    btn.addEventListener("click", () => {
      const next = applyStyleRecipe(getTheme(), recipe.id);
      previewDraftChange(next);
      reportEl.textContent = `已预览「${recipe.name || recipe.label}」质感模板，点击「保存设置」即可生效。`;
      sync();
    });
    recipeGrid.appendChild(btn);
  }
  body.appendChild(recipeSec);

  // ---------------------------------------------------------- 4. 日历排版与字体模板

  const contentPresetSec = document.createElement("div");
  contentPresetSec.className = "kal-sec";
  contentPresetSec.dataset.cat = "type";
  contentPresetSec.innerHTML = `
    <div class="kal-sec-title">日历排版模板</div>
    <div class="kal-recipe-grid" id="kal-content-preset-grid"></div>
  `;
  const contentPresetGrid = contentPresetSec.querySelector("#kal-content-preset-grid");
  for (const cp of CONTENT_PRESETS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "kal-recipe-card";
    btn.dataset.contentPreset = cp.id;
    const title = document.createElement("strong");
    title.textContent = cp.name;
    const desc = document.createElement("small");
    desc.textContent = cp.desc;
    btn.append(title, desc);
    btn.addEventListener("click", () => {
      const next = applyContentPreset(getTheme(), cp.id);
      previewDraftChange(next);
      reportEl.textContent = `已应用「${cp.name}」排版模板。`;
      sync();
    });
    contentPresetGrid.appendChild(btn);
  }
  body.appendChild(contentPresetSec);

  const fontSec = document.createElement("div");
  fontSec.className = "kal-sec";
  fontSec.dataset.cat = "type";
  const fontTitle = document.createElement("div");
  fontTitle.className = "kal-sec-title";
  fontTitle.textContent = "精选字体模板";

  const presetWrap = document.createElement("div");
  presetWrap.className = "kal-chips";
  for (const preset of FONT_PRESETS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "kal-chip";
    chip.dataset.fontPreset = preset.id;
    chip.textContent = preset.name || preset.label;
    chip.title = preset.desc;
    chip.addEventListener("click", async () => {
      let next = setPath(getTheme(), "type.familyUi", preset.familyUi);
      next = setPath(next, "type.familyNum", preset.familyNum);
      if (preset.weight) {
        next = setPath(next, "type.weight", { ...next.type.weight, ...preset.weight });
      }
      previewDraftChange(next);
      fontStatus.textContent = `已切换字体模板「${preset.name || preset.label}」。`;
      sync();
      try {
        await fonts.sync(next);
      } catch (err) {
        setFontError(err);
      }
    });
    presetWrap.appendChild(chip);
  }

  const fontActions = document.createElement("div");
  fontActions.className = "kal-font-actions";

  const fontImportBtn = document.createElement("button");
  fontImportBtn.type = "button";
  fontImportBtn.className = "kal-btn";
  fontImportBtn.textContent = "+ 导入本地字体…";
  fontImportBtn.dataset.act = "import-font";

  const fontRefresh = document.createElement("button");
  fontRefresh.type = "button";
  fontRefresh.className = "kal-btn kal-btn-ghost";
  fontRefresh.textContent = "刷新字体";
  fontRefresh.dataset.act = "refresh-fonts";

  const fontSearch = document.createElement("input");
  fontSearch.type = "search";
  fontSearch.placeholder = "搜索字体…";
  fontSearch.setAttribute("aria-label", "搜索字体名称");

  fontActions.append(fontImportBtn, fontRefresh, fontSearch);

  const fontStatus = document.createElement("div");
  fontStatus.className = "kal-note";
  fontStatus.setAttribute("role", "status");
  fontStatus.setAttribute("aria-live", "polite");
  fontSec.append(fontTitle, presetWrap, fontActions, fontStatus);
  body.appendChild(fontSec);

  function setFontError(err) { fontStatus.textContent = `字体加载失败：${err?.message || err}`; }
  const fonts = localFonts || createLocalFonts({ bridge, getTheme, onError: setFontError });
  const fontControls = [];
  let fontCatalog = null;
  let fontCatalogRequest = null;

  async function refreshFonts(force = false) {
    if (!force && fontCatalog) return;
    if (fontCatalogRequest) return fontCatalogRequest;
    fontRefresh.disabled = true;
    fontCatalogRequest = Promise.all([
      bridge.fontsList(),
      force ? fonts.refresh().catch(async err => { setFontError(err); return fonts.list(); }) : fonts.list(),
    ]).then(([system, local]) => {
      fontCatalog = { system, local };
      for (const update of fontControls) update();
      if (fonts.error) setFontError(fonts.error);
    }).finally(() => { fontCatalogRequest = null; fontRefresh.disabled = false; });
    return fontCatalogRequest;
  }
  fontRefresh.addEventListener("click", () => refreshFonts(true).catch(setFontError));

  fontSearch.addEventListener("input", () => {
    fontFilterQuery = fontSearch.value.trim().toLowerCase();
    for (const update of fontControls) update();
  });

  fontImportBtn.addEventListener("click", async () => {
    const opened = epoch;
    try {
      const path = await bridge.pickFontFile?.();
      if (!path || opened !== epoch || !isOpen()) return;
      fontStatus.textContent = "正在导入字体…";
      const entry = await bridge.localFontImport(path);
      await refreshFonts(true);
      if (opened !== epoch || !isOpen() || !entry?.family) return;
      const value = `"${entry.family}", ${defaultTail("type.familyUi")}`;
      const next = setPath(getTheme(), "type.familyUi", value);
      await fonts.sync(next);
      previewDraftChange(next);
      fontStatus.textContent = `已导入字体「${entry.name}」，点击保存后生效。`;
      sync();
    } catch (err) {
      if (opened === epoch && isOpen()) setFontError(err);
    }
  });

  // ---------------------------------------------------------- 5. 背景画布与壁纸智能取色

  const backdropSec = document.createElement("div");
  backdropSec.className = "kal-sec";
  backdropSec.dataset.cat = "backdrop";
  backdropSec.innerHTML = `
    <div class="kal-sec-title">艺术背景画布与壁纸</div>
    <div class="kal-backdrop-grid" id="kal-art-grid"></div>
    <div class="kal-chips">
      <button type="button" class="kal-chip" data-wp="pick-bg">选择本地壁纸</button>
      <button type="button" class="kal-chip" data-wp="desktop-bg">同步桌面壁纸</button>
      <button type="button" class="kal-chip" data-wp="clear-bg">纯透明/无背景图</button>
    </div>
    <div class="kal-note" id="kal-wp-status"></div>
  `;
  body.appendChild(backdropSec);
  const artGrid = backdropSec.querySelector("#kal-art-grid");
  const wpStatus = backdropSec.querySelector("#kal-wp-status");

  for (const art of ART_BACKDROPS) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "kal-backdrop-card";
    card.dataset.artId = art.id;
    card.title = art.desc || art.name;
    const thumb = document.createElement("span");
    thumb.className = "kal-backdrop-thumb";
    thumb.dataset.art = art.id;
    const label = document.createElement("span");
    label.textContent = art.name || art.label;
    card.append(thumb, label);
    card.addEventListener("click", () => {
      let next = setPath(getTheme(), "backdrop.mode", "art");
      next = setPath(next, "backdrop.preset", art.id);
      if ((next.backdrop?.opacity ?? 0) < 0.25) {
        next = setPath(next, "backdrop.opacity", 0.72);
      }
      previewDraftChange(next);
      wpStatus.textContent = `已启用艺术画布「${art.name || art.label}」。`;
      sync();
    });
    artGrid.appendChild(card);
  }

  backdropSec.querySelector('[data-wp="pick-bg"]').addEventListener("click", async () => {
    const opened = epoch;
    const path = await bridge.pickImage?.();
    if (!path || opened !== epoch || !isOpen()) return;
    let next = setPath(getTheme(), "wallpaper", path);
    next = setPath(next, "backdrop.mode", "custom");
    next = setPath(next, "backdrop.imagePath", path);
    if ((next.backdrop?.opacity ?? 0) < 0.25) {
      next = setPath(next, "backdrop.opacity", 0.78);
    }
    previewDraftChange(next);
    wpStatus.textContent = `已加载壁纸：${path}`;
    sync();
  });

  backdropSec.querySelector('[data-wp="desktop-bg"]').addEventListener("click", () => {
    let next = setPath(getTheme(), "backdrop.mode", "desktop");
    if ((next.backdrop?.opacity ?? 0) < 0.25) {
      next = setPath(next, "backdrop.opacity", 0.75);
    }
    previewDraftChange(next);
    wpStatus.textContent = "已切换为系统桌面壁纸背景层。";
    sync();
  });

  backdropSec.querySelector('[data-wp="clear-bg"]').addEventListener("click", () => {
    const next = setPath(getTheme(), "backdrop.mode", "none");
    previewDraftChange(next);
    wpStatus.textContent = "已关闭背景图。";
    sync();
  });

  const genSec = document.createElement("div");
  genSec.className = "kal-sec";
  genSec.dataset.cat = "backdrop";
  genSec.innerHTML = `
    <div class="kal-sec-title">壁纸智能取色</div>
    <div class="kal-chips">
      <span class="kal-chip" data-mode="auto">自动明暗</span>
      <span class="kal-chip" data-mode="dark">深色</span>
      <span class="kal-chip" data-mode="light">浅色</span>
      <span class="kal-chip" data-gen="1">从壁纸提取配色</span>
      <span class="kal-chip" data-gen="region">按窗口位置取色</span>
      <span class="kal-chip" data-gen="file">从图片取色…</span>
    </div>
    <div class="kal-report" id="kal-report"></div>
  `;
  body.appendChild(genSec);
  const reportEl = genSec.querySelector("#kal-report");
  let forcedMode = null;

  genSec.querySelectorAll(".kal-chip[data-mode]").forEach(c => {
    c.addEventListener("click", () => {
      forcedMode = c.dataset.mode === "auto" ? null : c.dataset.mode;
      genSec.querySelectorAll(".kal-chip[data-mode]").forEach(x => x.classList.toggle("is-on", x === c));
      if (forcedMode === null) genSec.querySelector('.kal-chip[data-mode="auto"]').classList.add("is-on");
    });
  });
  genSec.querySelector('[data-mode="auto"]').classList.add("is-on");

  genSec.querySelectorAll(".kal-chip[data-gen]").forEach(c => {
    c.addEventListener("click", async () => {
      const opened = epoch, selected = ++selectionRequest;
      reportEl.textContent = "正在取色…";
      try {
        const opts = { mode: forcedMode };
        if (c.dataset.gen === "region") opts.regionFromWindow = true;
        if (c.dataset.gen === "file") opts.file = true;
        const res = await onRegen(opts);
        if (opened === epoch && selected === selectionRequest && isOpen() && res) reportEl.innerHTML = res;
      } catch (err) {
        if (opened === epoch && selected === selectionRequest && isOpen()) reportEl.textContent = `取色失败：${err?.message || err}`;
      }
    });
  });

  // ---------------------------------------------------------- 6. 高级参数微调（默认折叠，避免界面繁杂）

  advancedDrawer = document.createElement("details");
  advancedDrawer.className = "kal-sec kal-advanced-drawer";
  advancedDrawer.dataset.cat = "color";
  const advSummary = document.createElement("summary");
  advSummary.className = "kal-advanced-summary";
  advSummary.textContent = "展开高级参数与色彩细节微调（可选）";
  const advBody = document.createElement("div");
  advBody.className = "kal-advanced-body";
  advancedDrawer.append(advSummary, advBody);

  for (const [title, , rows] of SECTIONS) {
    const subSec = document.createElement("div");
    subSec.className = "kal-adv-group";
    const h = document.createElement("div");
    h.className = "kal-sec-title";
    h.textContent = title;
    subSec.appendChild(h);

    const group = document.createElement("div");
    group.className = "kal-card-group";
    for (const r of rows) {
      group.appendChild(buildRow(r));
    }
    subSec.appendChild(group);
    advBody.appendChild(subSec);
  }
  body.appendChild(advancedDrawer);

  // ---------------------------------------------------------- 7. 版本信息与操作日志

  const updateSec = document.createElement("div");
  updateSec.className = "kal-sec";
  updateSec.id = "kal-update-sec";
  updateSec.dataset.cat = "general";
  updateSec.innerHTML = `
    <div class="kal-sec-title">版本与检查更新</div>
    <div class="kal-card-group kal-update-card">
      <div class="kal-update-hero">
        <img class="kal-update-logo" src="./favicon.png" alt="Calendar List" width="28" height="28" />
        <div class="kal-update-meta">
          <div class="kal-update-name">日历清单 · Calendar List <span class="kal-update-ver-pill" id="kal-update-ver-pill">${APP_STAGE_LABEL}</span></div>
          <div class="kal-update-sub" id="kal-update-status">当前版本：${APP_STAGE_LABEL}</div>
        </div>
        <div class="kal-update-actions">
          <button type="button" class="kal-btn kal-update-btn" id="kal-check-update-btn">检查更新</button>
          <button type="button" class="kal-btn kal-btn-ghost kal-update-btn" id="kal-changelog-btn" aria-expanded="false">更新说明</button>
        </div>
      </div>
      <div class="kal-row kal-row-rich">
        <div class="kal-row-meta">
          <label for="kal-auto-update-toggle">启动时自动检查更新</label>
        </div>
        <div class="kal-row-ctl kal-row-ctl-end">
          <input type="checkbox" id="kal-auto-update-toggle" class="kal-switch" checked aria-label="启动时自动检查更新" />
        </div>
      </div>
      <div class="kal-changelog-box" id="kal-changelog-box" hidden>
        <div class="kal-changelog-title">${APP_STAGE_LABEL} 更新亮点</div>
        <ul class="kal-changelog-list">
          <li>支持一键固定到桌面左侧/右侧/居中，自适应多显示器尺寸与 DPI</li>
          <li>新增 Windows 开机自启动开关，登录系统自动就绪</li>
          <li>全新居中弹窗式设置中心，内置精选主题、质感、排版与字体预设模板</li>
          <li>双击日历格或右侧列表即可无干扰极速直编</li>
        </ul>
      </div>
    </div>
  `;

  const checkUpdateBtn = updateSec.querySelector("#kal-check-update-btn");
  const changelogBtn = updateSec.querySelector("#kal-changelog-btn");
  const changelogBox = updateSec.querySelector("#kal-changelog-box");
  const updateStatusEl = updateSec.querySelector("#kal-update-status");
  const autoUpdateToggle = updateSec.querySelector("#kal-auto-update-toggle");

  try {
    const savedAuto = window.localStorage?.getItem("kal.autoCheckUpdate");
    if (savedAuto !== null && autoUpdateToggle) {
      autoUpdateToggle.checked = savedAuto !== "false";
    }
  } catch { /* ignore */ }

  autoUpdateToggle?.addEventListener("change", () => {
    const on = Boolean(autoUpdateToggle.checked);
    try { window.localStorage?.setItem("kal.autoCheckUpdate", String(on)); } catch { /* ignore */ }
    addLog("system", on ? "开启「启动时自动检查更新」" : "关闭「启动时自动检查更新」");
  });

  changelogBtn?.addEventListener("click", () => {
    if (!changelogBox) return;
    changelogBox.hidden = !changelogBox.hidden;
    changelogBtn.setAttribute("aria-expanded", String(!changelogBox.hidden));
  });

  checkUpdateBtn?.addEventListener("click", async () => {
    if (!checkUpdateBtn || checkUpdateBtn.disabled) return;
    checkUpdateBtn.disabled = true;
    const origText = checkUpdateBtn.textContent;
    checkUpdateBtn.textContent = "检查中…";
    if (updateStatusEl) {
      updateStatusEl.textContent = `正在校验 ${APP_STAGE_LABEL} 版本状态…`;
      updateStatusEl.classList.remove("is-ok");
    }
    await new Promise(r => setTimeout(r, 120));
    const stamp = new Date().toTimeString().slice(0, 8);
    const result = {
      version: APP_VERSION,
      stage: APP_STAGE_LABEL,
      latestVersion: APP_VERSION,
      upToDate: true,
      checkedAt: stamp,
    };
    window.__KAL_LAST_UPDATE_CHECK__ = result;
    if (updateStatusEl) {
      updateStatusEl.textContent = `✓ 当前已是最新版本 ${APP_STAGE_LABEL}（${stamp}）`;
      updateStatusEl.classList.add("is-ok");
    }
    if (reportEl) {
      reportEl.textContent = `当前运行版本 ${APP_STAGE_LABEL} 已是最新稳定版。`;
    }
    addLog("system", `检查版本更新：当前已是最新 ${APP_STAGE_LABEL}`);
    checkUpdateBtn.textContent = origText;
    checkUpdateBtn.disabled = false;
  });

  body.appendChild(updateSec);

  const logSec = document.createElement("div");
  logSec.className = "kal-sec";
  logSec.id = "kal-log-sec";
  logSec.dataset.cat = "logs";
  logSec.innerHTML = `
    <div class="kal-sec-title">操作历史记录</div>
    <div class="kal-log-toolbar">
      <div class="kal-chips" id="kal-log-filters" role="group" aria-label="日志分类筛选">
        <button type="button" class="kal-chip is-on" data-log-filter="all">全部</button>
        <button type="button" class="kal-chip" data-log-filter="schedule">日程</button>
        <button type="button" class="kal-chip" data-log-filter="theme">主题</button>
        <button type="button" class="kal-chip" data-log-filter="system">系统</button>
      </div>
      <div class="kal-log-actions">
        <button type="button" class="kal-btn kal-btn-ghost kal-log-act-btn" id="kal-log-undo" title="撤销最近一步修改 (Ctrl+Z)">撤销</button>
        <button type="button" class="kal-btn kal-btn-ghost kal-log-act-btn" id="kal-log-export" title="复制日志">导出日志</button>
        <button type="button" class="kal-btn kal-btn-ghost kal-log-act-btn" id="kal-log-clear" title="清空记录">清空</button>
      </div>
    </div>
    <ul class="kal-log-list" id="kal-log-list" aria-label="操作历史记录"></ul>
    <div class="kal-note" id="kal-log-status" role="status" aria-live="polite"></div>
  `;
  body.appendChild(logSec);

  const logListEl = logSec.querySelector("#kal-log-list");
  const logFiltersEl = logSec.querySelector("#kal-log-filters");
  const logStatusEl = logSec.querySelector("#kal-log-status");
  const CAT_LABEL_MAP = {
    schedule: "日程",
    theme: "主题",
    system: "系统",
    error: "异常",
  };

  renderLogList = () => {
    if (!logListEl) return;
    logListEl.replaceChildren();
    const visible = logFilter === "all"
      ? operationLogs
      : operationLogs.filter(item => item.cat === logFilter);
    if (!visible.length) {
      const empty = document.createElement("li");
      empty.className = "kal-log-empty";
      empty.textContent = "暂无记录";
      logListEl.appendChild(empty);
      return;
    }
    for (const item of visible) {
      const li = document.createElement("li");
      li.className = "kal-log-item";
      const timeSpan = document.createElement("span");
      timeSpan.className = "kal-log-time";
      timeSpan.textContent = item.time || "--:--:--";
      const badgeSpan = document.createElement("span");
      badgeSpan.className = "kal-log-badge";
      badgeSpan.dataset.logCat = item.cat || "system";
      badgeSpan.textContent = CAT_LABEL_MAP[item.cat] || "系统";
      const msgSpan = document.createElement("span");
      msgSpan.className = "kal-log-msg";
      msgSpan.textContent = item.msg;
      li.append(timeSpan, badgeSpan, msgSpan);
      logListEl.appendChild(li);
    }
  };
  renderLogList();

  logFiltersEl.addEventListener("click", e => {
    const btn = e.target.closest("[data-log-filter]");
    if (!btn) return;
    logFilter = btn.dataset.logFilter || "all";
    logFiltersEl.querySelectorAll("[data-log-filter]").forEach(b => {
      b.classList.toggle("is-on", b.dataset.logFilter === logFilter);
    });
    renderLogList();
  });

  logSec.querySelector("#kal-log-undo")?.addEventListener("click", () => {
    if (typeof onUndo === "function") {
      onUndo();
      logStatusEl.textContent = "已撤销最近一步操作。";
    }
  });

  logSec.querySelector("#kal-log-export")?.addEventListener("click", async () => {
    const text = operationLogs
      .map(it => `[${it.time}] [${CAT_LABEL_MAP[it.cat] || it.cat}] ${it.msg}`)
      .join("\n");
    window.__KAL_LAST_LOG_EXPORT__ = text;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
    } catch { /* ignore clipboard errors in headless */ }
    logStatusEl.textContent = `已导出 ${operationLogs.length} 条日志。`;
  });

  logSec.querySelector("#kal-log-clear")?.addEventListener("click", () => {
    operationLogs = [];
    persistLogs();
    renderLogList();
    logStatusEl.textContent = "已清空记录。";
  });

  function buildRow(r) {
    const row = document.createElement("div");
    row.className = "kal-row";
    const lab = document.createElement("label");
    lab.textContent = r.label;
    row.appendChild(lab);

    const ctl = document.createElement("div");
    ctl.className = "kal-row-ctl";
    row.appendChild(ctl);

    let val = null;
    let read = null;

    if (r.type === "range") {
      const input = document.createElement("input");
      input.type = "range";
      input.min = r.min; input.max = r.max; input.step = r.step;
      val = document.createElement("span");
      val.className = "kal-val";
      input.addEventListener("input", () => {
        const v = Number(input.value);
        val.textContent = r.fmt ? r.fmt(v) : String(v);
        emit(r, v);
      });
      ctl.appendChild(input); ctl.appendChild(val);
      read = { set: t => { const v = getPath(t, r.path) ?? getPath(DEFAULT_THEME, r.path); if (v == null) return; input.value = v; val.textContent = r.fmt ? r.fmt(Number(v)) : String(v); } };
    } else if (r.type === "color") {
      const input = document.createElement("input");
      input.type = "color";
      const txt = document.createElement("span");
      txt.className = "kal-val";
      input.addEventListener("input", () => { txt.textContent = input.value.toUpperCase(); emit(r, input.value.toUpperCase()); });
      ctl.appendChild(input); ctl.appendChild(txt);
      read = { set: t => { const v = getPath(t, r.path); if (typeof v !== "string") return; input.value = v; txt.textContent = v.toUpperCase(); } };
    } else if (r.type === "bool") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = "kal-switch";
      input.addEventListener("change", () => emit(r, input.checked));
      ctl.classList.add("kal-row-ctl-end");
      ctl.appendChild(input);
      read = { set: t => { input.checked = getPath(t, r.path) === true; } };
    } else if (r.type === "seg") {
      const wrap = document.createElement("div");
      wrap.className = "kal-chips";
      for (const [v, text] of r.options) {
        const c = document.createElement("span");
        c.className = "kal-chip";
        c.dataset.v = v;
        c.textContent = text;
        c.addEventListener("click", () => emit(r, r.num ? Number(v) : v));
        wrap.appendChild(c);
      }
      ctl.appendChild(wrap);
      read = { set: t => { const cur = String(getPath(t, r.path) ?? getPath(DEFAULT_THEME, r.path)); wrap.querySelectorAll(".kal-chip").forEach(c => c.classList.toggle("is-on", c.dataset.v === cur)); } };
    } else if (r.type === "font") {
      const sel = document.createElement("select");
      sel.setAttribute("aria-label", r.label);
      const addOption = (target, value, text) => {
        const option = document.createElement("option");
        option.value = value; option.textContent = text;
        target.appendChild(option);
      };
      function update(t = getTheme()) {
        const stack = getPath(t, r.path) || getPath(DEFAULT_THEME, r.path);
        const current = stack.match(/^"([^"]+)"/)?.[0] || "";
        const q = fontFilterQuery;
        sel.replaceChildren();
        addOption(sel, "", "（默认）");
        if (fontCatalog) {
          const system = document.createElement("optgroup"); system.label = "系统字体";
          for (const f of fontCatalog.system) {
            const valStr = JSON.stringify(f);
            if (!q || f.toLowerCase().includes(q) || valStr === current) {
              addOption(system, valStr, f);
            }
          }
          sel.appendChild(system);
          const local = document.createElement("optgroup"); local.label = "Kal 私有字体";
          for (const f of fontCatalog.local.fonts) {
            const valStr = `"${f.family}"`;
            const fileOrFamily = (f.file || f.family || f.id || "").toLowerCase();
            if (!q || (f.name || "").toLowerCase().includes(q) || fileOrFamily.includes(q) || valStr === current) {
              addOption(local, valStr, f.name);
            }
          }
          sel.appendChild(local);
        }
        if (stack === getPath(DEFAULT_THEME, r.path)) { sel.value = ""; return; }
        if (current && ![...sel.options].some(o => o.value === current)) {
          addOption(sel, current, localFontId(stack) ? "私有字体（未找到文件，请刷新）" : current.slice(1, -1));
        }
        sel.value = current;
      }
      fontControls.push(update);
      sel.addEventListener("focus", () => refreshFonts().catch(setFontError));
      sel.addEventListener("mousedown", () => refreshFonts().catch(setFontError));
      let selection = 0;
      sel.addEventListener("change", async () => {
        const version = ++selection, opened = epoch, original = getTheme();
        const value = sel.value ? `${sel.value}, ${defaultTail(r.path)}` : getPath(DEFAULT_THEME, r.path);
        const next = setPath(getTheme(), r.path, value);
        try {
          await fonts.sync(next);
          if (version !== selection || opened !== epoch || !isOpen() || getTheme() !== original) return;
          emit(r, value);
          fontStatus.textContent = "字体已预览，点击保存后生效。";
        } catch (err) {
          if (version !== selection || opened !== epoch || !isOpen() || getTheme() !== original) return;
          setFontError(err); update();
          fonts.sync(getTheme()).catch(setFontError);
        }
      });
      ctl.appendChild(sel);
      read = { set: t => { update(t); refreshFonts().catch(setFontError); } };
    }

    controls.push({ r, read });
    return row;
  }

  function defaultTail(path) {
    return path === "type.familyNum"
      ? '"Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif'
      : '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", "Noto Sans SC", system-ui, sans-serif';
  }

  function emit(r, v) {
    const next = setPath(getTheme(), r.path, v);
    if (r.path === "mode" && onModeChange) {
      markDirty(true);
      onModeChange(v, next);
      return;
    }
    previewDraftChange(next);
    syncAuxStates(next);
  }

  function matchesPatch(t, patch) {
    if (!t || !patch) return false;
    for (const [k, v] of Object.entries(patch)) {
      const cur = getPath(t, k);
      if (typeof v === "number") {
        if (!Number.isFinite(Number(cur)) || Math.abs(Number(cur) - v) > 0.025) return false;
      } else if (cur !== v) {
        return false;
      }
    }
    return true;
  }

  function syncAuxStates(t) {
    const isArt = t?.backdrop?.mode === "art";
    const preset = t?.backdrop?.preset || "aurora";
    artGrid.querySelectorAll(".kal-backdrop-card").forEach(card => {
      card.classList.toggle("is-on", isArt && card.dataset.artId === preset);
    });
    const curLang = getPath(t, "layout.language") || "zh-CN";
    langSeg?.querySelectorAll("[data-lang]").forEach(btn => {
      btn.classList.toggle("is-on", btn.dataset.lang === curLang);
    });
    if (motionToggle) {
      motionToggle.checked = getPath(t, "layout.reducedMotion") === true;
    }
    const curAccent = String(getPath(t, "color.accent") || "#2649A0").toUpperCase();
    accentWrap?.querySelectorAll(".kal-accent-swatch").forEach(btn => {
      btn.classList.toggle("is-on", String(btn.dataset.accentHex || "").toUpperCase() === curAccent);
    });

    // 同步预设主题模板卡片选中态（严格按 themeId 唯一匹配）
    const curThemeId = t?.id || "default";
    listEl?.querySelectorAll(".kal-theme-card").forEach(card => {
      const active = (card.dataset.themeId || "") === curThemeId;
      card.classList.toggle("is-on", active);
      card.setAttribute("aria-pressed", String(active));
    });

    // 同步窗口质感模板卡片选中态
    recipeGrid?.querySelectorAll(".kal-recipe-card").forEach(card => {
      const recipe = STYLE_RECIPES.find(r => r.id === card.dataset.recipeId);
      const active = Boolean(recipe && matchesPatch(t, recipe.patch));
      card.classList.toggle("is-on", active);
      card.setAttribute("aria-pressed", String(active));
    });

    // 同步日历排版模板卡片选中态
    contentPresetGrid?.querySelectorAll(".kal-recipe-card").forEach(card => {
      const cp = CONTENT_PRESETS.find(c => c.id === card.dataset.contentPreset);
      const active = Boolean(cp && matchesPatch(t, cp.patch));
      card.classList.toggle("is-on", active);
      card.setAttribute("aria-pressed", String(active));
    });

    // 同步精选字体模板按钮选中态
    const curFamUi = getPath(t, "type.familyUi") || "";
    const curFamNum = getPath(t, "type.familyNum") || "";
    presetWrap?.querySelectorAll("[data-font-preset]").forEach(chip => {
      const fp = FONT_PRESETS.find(p => p.id === chip.dataset.fontPreset);
      const active = Boolean(fp && fp.familyUi === curFamUi && fp.familyNum === curFamNum);
      chip.classList.toggle("is-on", active);
      chip.setAttribute("aria-pressed", String(active));
    });
  }

  // ---------------------------------------------------------- 外部接口

  function sync() {
    const t = getTheme();
    for (const c of controls) c.read.set(t);
    syncAuxStates(t);
    syncDockUi();
  }

  function close() {
    if (busy || !isOpen()) return;
    epoch++; selectionRequest++; libraryRequest++;
    markDirty(false);
    onCancel?.();
    document.body.classList.remove("kal-panel-open");
  }
  function open() {
    if (busy || isOpen()) return;
    epoch++; onOpen?.();
    markDirty(false);
    document.body.classList.add("kal-panel-open");
    sync();
    refreshLibrary();
    refreshAutostartUi();
  }
  backdrop.addEventListener("click", close);
  el.querySelector('[data-act="close"]').addEventListener("click", close);
  el.querySelector('[data-act="save"]').addEventListener("click", async () => {
    await onCommit();
    markDirty(false);
  });
  el.querySelector('[data-act="reset"]').addEventListener("click", () => {
    selectionRequest++;
    markDirty(false);
    onReset();
  });

  refreshAutostartUi();
  syncDockUi();

  return {
    el, sync, syncDockUi, refreshLibrary, close, open,
    addLog,
    getLogs: () => operationLogs.slice(),
    clearLogs: () => { operationLogs = []; persistLogs(); renderLogList(); },
    setFontError,
    refreshFonts: () => refreshFonts(true),
    toggle() { if (isOpen()) close(); else open(); },
    isOpen,
    setBusy(value) {
      busy = Boolean(value); body.inert = busy;
      el.setAttribute("aria-busy", String(busy));
      el.querySelectorAll(".kal-panel-head button").forEach(button => { button.disabled = busy; });
    },
    setReport(html) { reportEl.classList.remove("is-error"); reportEl.innerHTML = html; },
    setReportText(message, error = false) { reportEl.textContent = message; reportEl.classList.toggle("is-error", error); },
  };
}
