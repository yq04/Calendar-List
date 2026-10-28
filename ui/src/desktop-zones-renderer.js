import { zonePixelRect } from "./desktop-zones-model.js";

const MAX_PIXELS = 32 * 1024 * 1024;
const KIND_NAMES = { calendar: "日历", software: "软件", files: "文件" };
const probes = new WeakMap();
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = value => typeof value === "number" && Number.isFinite(value);
const rgba = (rgb, alpha) => `rgba(${rgb.join(",")},${clamp(alpha, 0, 1).toFixed(4)})`;

function displayScale(display) {
  const dpi = clamp(finite(display?.dpiScale) && display.dpiScale > 0 ? display.dpiScale : 1, 0.75, 4);
  // kalScale is a PPI correction, not another Windows DPI percentage.
  let physical = 1;
  if (display?.ppiKnown !== false) {
    if (finite(display?.kalScale) && display.kalScale > 0) physical = display.kalScale;
    else if (display?.ppiKnown && finite(display?.ppi) && display.ppi > 0) physical = display.ppi / 96;
  }
  return { dpi, physical: clamp(physical, 0.9, 1.18) };
}

/** Shared material tokens. Dimensions are physical monitor pixels. */
export function getZoneAppearance(config, display, zone, backgroundLuminance = 0.5) {
  const { dpi, physical } = displayScale(display);
  const opacity = clamp(finite(config?.panelOpacity) ? config.panelOpacity : 0.72, 0, 1);
  const luminance = clamp(finite(backgroundLuminance) ? backgroundLuminance : 0.5, 0, 1);
  const tone = config?.panelStyle === "light" || (config?.panelStyle !== "dark" && zone?.kind === "calendar") ? "light" : "dark";
  const light = tone === "light";
  // A brighter wallpaper needs a slightly steadier dark base for white icon labels.
  // Explicitly lowering strength still remains a user-controlled transparency choice.
  const materialAlpha = base => opacity * (base + (1 - base) * opacity);
  const topAlpha = materialAlpha(light ? 0.62 + luminance * 0.12 : 0.68 + luminance * 0.14);
  const bottomAlpha = materialAlpha(light ? 0.42 + luminance * 0.08 : 0.52 + luminance * 0.14);
  return {
    tone,
    fillTop: rgba(light ? [250, 249, 244] : [29, 38, 51], topAlpha),
    fillBottom: rgba(light ? [239, 241, 237] : [18, 27, 39], bottomAlpha),
    border: rgba(light ? [109, 126, 144] : [228, 237, 246], light ? 0.2 + opacity * 0.15 : 0.15 + opacity * 0.23),
    titleColor: light ? "#2d3b4d" : "#f4f7fa",
    titleFill: rgba(light ? [255, 255, 252] : [12, 22, 35], opacity * 0.14),
    divider: rgba(light ? [87, 107, 127] : [237, 243, 250], opacity * 0.16),
    highlight: rgba([255, 255, 255], opacity * (light ? 0.25 : 0.1)),
    lowerShade: rgba([4, 12, 22], opacity * (light ? 0.025 : 0.11)),
    fontSize: Math.round(clamp(13 * dpi * physical, 12 * dpi, 15 * dpi)),
    fontWeight: 500,
    titleHeight: Math.round(30 * dpi),
    radius: Math.round(12 * dpi * Math.sqrt(physical)),
    padding: Math.round(14 * dpi),
    borderWidth: Math.max(1, dpi),
    dpi,
  };
}

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, Math.max(0, Math.min(radius, width / 2, height / 2)));
}

function drawBackground(ctx, size, config, image) {
  ctx.fillStyle = "#18212c";
  ctx.fillRect(0, 0, size.width, size.height);
  if (image) {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) throw new Error("壁纸图片尚未加载完成。");
    if (config.fit === "stretch") ctx.drawImage(image, 0, 0, size.width, size.height);
    else {
      const ratio = (config.fit === "contain" ? Math.min : Math.max)(size.width / width, size.height / height);
      const scaledWidth = width * ratio, scaledHeight = height * ratio;
      ctx.drawImage(image, (size.width - scaledWidth) / 2, (size.height - scaledHeight) / 2, scaledWidth, scaledHeight);
    }
  } else {
    const gradient = ctx.createLinearGradient(0, 0, size.width, size.height);
    gradient.addColorStop(0, "#294d57");
    gradient.addColorStop(1, "#182137");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size.width, size.height);
  }
}

const linear = channel => {
  const encoded = channel / 255;
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
};

function sampleBackground(canvas, display, zones, size) {
  let probe = probes.get(canvas);
  if (!probe) {
    probe = canvas.ownerDocument?.createElement?.("canvas");
    if (!probe && typeof OffscreenCanvas !== "undefined") probe = new OffscreenCanvas(64, 64);
    if (!probe) return new Map();
    probe.width = 64; probe.height = 64;
    probes.set(canvas, probe);
  }
  try {
    const context = probe.getContext("2d", { willReadFrequently: true });
    if (!context) return new Map();
    context.drawImage(canvas, 0, 0, 64, 64);
    const pixels = context.getImageData(0, 0, 64, 64).data;
    const result = new Map();
    for (const zone of zones) {
      const rect = zonePixelRect(zone, display);
      if (!rect) continue;
      let luminance = 0;
      for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) {
        const x = clamp(Math.floor((rect.x + rect.width * (column + 0.5) / 4) / size.width * 64), 0, 63);
        const y = clamp(Math.floor((rect.y + rect.height * (row + 0.5) / 4) / size.height * 64), 0, 63);
        const index = (y * 64 + x) * 4;
        luminance += 0.2126 * linear(pixels[index]) + 0.7152 * linear(pixels[index + 1]) + 0.0722 * linear(pixels[index + 2]);
      }
      result.set(zone.id, luminance / 16);
    }
    return result;
  } catch {
    // A tainted or unusual canvas must not prevent the user from editing a layout.
    return new Map();
  }
}

function fitTitle(ctx, text, width) {
  const characters = Array.from(text);
  if (ctx.measureText(text).width <= width) return text;
  while (characters.length && ctx.measureText(`${characters.join("")}…`).width > width) characters.pop();
  return characters.length ? `${characters.join("")}…` : "";
}

function drawPanel(ctx, rect, appearance, label, drawTitle) {
  const a = appearance;
  ctx.save();
  // Final publication also uses a bounded bitmap, so rasterizer coverage cannot
  // affect pixels outside the zone even when a rounded clip is antialiased.
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();
  // All material, borders and shading are clipped inside the exact zone. No shadow
  // can spill into the reserved desktop icon margin or the taskbar.
  roundedRect(ctx, rect.x, rect.y, rect.width, rect.height, a.radius);
  ctx.clip();

  const fill = ctx.createLinearGradient(0, rect.y, 0, rect.y + rect.height);
  fill.addColorStop(0, a.fillTop);
  fill.addColorStop(1, a.fillBottom);
  ctx.fillStyle = fill;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

  const headerHeight = Math.min(a.titleHeight, rect.height);
  const header = ctx.createLinearGradient(0, rect.y, 0, rect.y + headerHeight);
  header.addColorStop(0, a.titleFill);
  header.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = header;
  ctx.fillRect(rect.x, rect.y, rect.width, headerHeight);

  // Inner highlights and a small lower shade separate the panels without blur.
  const edgeDepth = Math.min(10 * a.dpi, rect.height / 3);
  const upperEdge = ctx.createLinearGradient(0, rect.y, 0, rect.y + edgeDepth);
  upperEdge.addColorStop(0, a.highlight); upperEdge.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = upperEdge;
  ctx.fillRect(rect.x, rect.y, rect.width, edgeDepth);
  const lowerEdge = ctx.createLinearGradient(0, rect.y + rect.height - edgeDepth, 0, rect.y + rect.height);
  lowerEdge.addColorStop(0, "rgba(0,0,0,0)"); lowerEdge.addColorStop(1, a.lowerShade);
  ctx.fillStyle = lowerEdge;
  ctx.fillRect(rect.x, rect.y + rect.height - edgeDepth, rect.width, edgeDepth);

  const halfBorder = a.borderWidth / 2;
  roundedRect(ctx, rect.x + halfBorder, rect.y + halfBorder,
    Math.max(0, rect.width - a.borderWidth), Math.max(0, rect.height - a.borderWidth), a.radius - halfBorder);
  ctx.lineWidth = a.borderWidth;
  ctx.strokeStyle = a.border;
  ctx.stroke();

  if (rect.width > a.padding * 3 && rect.height > headerHeight + a.borderWidth) {
    ctx.beginPath();
    ctx.moveTo(rect.x + a.padding, rect.y + headerHeight - halfBorder);
    ctx.lineTo(rect.x + rect.width - a.padding, rect.y + headerHeight - halfBorder);
    ctx.lineWidth = Math.max(1, a.dpi * 0.65);
    ctx.strokeStyle = a.divider;
    ctx.stroke();
  }

  // The editor overlays readable DOM labels. Only the final wallpaper bakes a title.
  if (drawTitle) {
    ctx.font = `${a.fontWeight} ${a.fontSize}px "Microsoft YaHei UI", "Microsoft YaHei", sans-serif`;
    ctx.textBaseline = "middle";
    ctx.fillStyle = a.titleColor;
    if (a.tone === "dark") {
      ctx.shadowColor = "rgba(0,0,0,.32)";
      ctx.shadowBlur = 2 * a.dpi;
      ctx.shadowOffsetY = a.dpi;
    }
    const title = fitTitle(ctx, label, Math.max(0, rect.width - 2 * a.padding));
    if (title) ctx.fillText(title, rect.x + a.padding, rect.y + headerHeight / 2);
  }
  ctx.restore();
}

/** Preview and final PNG share one material path and exact physical zone geometry. */
export function renderDesktopZones(canvas, config, display, image, maxWidth = null) {
  const size = {
    width: display.rect[2] - display.rect[0],
    height: display.rect[3] - display.rect[1],
  };
  if (!finite(size.width) || !finite(size.height) || size.width <= 0 || size.height <= 0 || size.width * size.height > MAX_PIXELS) {
    throw new Error("显示器图像尺寸超出支持范围，请选择不超过 3200 万像素的屏幕。");
  }
  const scale = finite(maxWidth) && maxWidth > 0 ? Math.min(1, maxWidth / size.width) : 1;
  canvas.width = Math.max(1, Math.round(size.width * scale));
  canvas.height = Math.max(1, Math.round(size.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("当前环境无法绘制壁纸预览。");
  ctx.setTransform(canvas.width / size.width, 0, 0, canvas.height / size.height, 0, 0);
  drawBackground(ctx, size, config, image);
  const luminances = sampleBackground(canvas, display, config.zones, size);
  const finalOutput = maxWidth === null;
  const scratch = finalOutput ? canvas.ownerDocument?.createElement?.("canvas")
    || (typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : null) : null;
  if (finalOutput && !scratch) throw new Error("当前环境无法合成分区壁纸。");
  try {
    for (const zone of config.zones) {
      const rect = zonePixelRect(zone, display);
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      const appearance = getZoneAppearance(config, display, zone, luminances.get(zone.id));
      const label = zone.label || KIND_NAMES[zone.kind] || "分区";
      if (scratch) {
        scratch.width = rect.width;
        scratch.height = rect.height;
        const scratchContext = scratch.getContext("2d");
        if (!scratchContext) throw new Error("当前环境无法绘制分区壁纸。");
        drawPanel(scratchContext, { x: 0, y: 0, width: rect.width, height: rect.height }, appearance, label, true);
        ctx.drawImage(scratch, rect.x, rect.y);
      } else {
        drawPanel(ctx, rect, appearance, label, false);
      }
    }
  } finally {
    if (scratch) { scratch.width = 1; scratch.height = 1; }
  }
  return canvas;
}
