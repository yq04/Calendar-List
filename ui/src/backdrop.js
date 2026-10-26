// 壁纸与画布背景加载器：响应主题的 backdrop.mode 与 wallpaper 路径变化
// 仅在 desktop / custom 模式下按需读取图片并缓存，拖滑块调参不会重复触发磁盘读取。

import { onThemeApplied } from "./theme.js";

export function createBackdropManager({ bridge, getTheme, onError = () => {}, doc = document }) {
  const cache = new Map(); // key -> dataUrl
  let generation = 0;
  let disposed = false;

  async function resolveDataUrl(mode, customPath) {
    const cacheKey = mode === "desktop" ? "__desktop__" : `custom:${customPath}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    if (!bridge?.wallpaperReadImage) return null;
    const res = await bridge.wallpaperReadImage(mode === "desktop" ? null : customPath);
    if (!res?.dataUrl) return null;
    if (cache.size >= 4) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    cache.set(cacheKey, res.dataUrl);
    return res.dataUrl;
  }

  async function sync(theme = getTheme?.()) {
    const version = ++generation;
    const root = doc?.documentElement;
    if (!root?.style) return;
    const mode = theme?.backdrop?.mode || "none";
    const customPath = (theme?.wallpaper || "").trim();

    if (mode !== "desktop" && mode !== "custom") {
      root.style.setProperty("--kal-wallpaper-image", "none");
      return;
    }
    if (mode === "custom" && !customPath) {
      root.style.setProperty("--kal-wallpaper-image", "none");
      return;
    }
    try {
      const dataUrl = await resolveDataUrl(mode, customPath);
      if (version !== generation || disposed) return;
      if (dataUrl) {
        root.style.setProperty("--kal-wallpaper-image", `url("${dataUrl.replace(/"/g, "%22")}")`);
      } else {
        root.style.setProperty("--kal-wallpaper-image", "none");
      }
    } catch (err) {
      if (version !== generation || disposed) return;
      root.style.setProperty("--kal-wallpaper-image", "none");
      onError(err);
    }
  }

  const unsubscribe = onThemeApplied((theme, appliedDoc) => {
    if (appliedDoc !== doc || disposed) return;
    sync(theme);
  });

  return {
    sync,
    invalidateDesktop() {
      cache.delete("__desktop__");
      return sync(getTheme?.());
    },
    destroy() {
      disposed = true;
      ++generation;
      unsubscribe();
      cache.clear();
    },
  };
}
