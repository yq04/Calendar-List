// 壁纸与画布背景加载器：响应主题的 backdrop.mode 与 wallpaper 路径变化
// 仅在 desktop / custom 模式下按需读取图片并缓存，拖滑块调参不会重复触发磁盘读取。

import { onThemeApplied } from "./theme.js";

export const MAX_BACKDROP_CACHE_COUNT = 2;
export const MAX_BACKDROP_CACHE_BYTES = 32 * 1024 * 1024;

export function createBackdropManager({ bridge, getTheme, onError = () => {}, doc = document }) {
  const cache = new Map(); // key -> dataUrl
  const inflight = new Map(); // key -> Promise<dataUrl | null>
  let cachedBytes = 0;
  let appliedCssValue = null;
  let generation = 0;
  let disposed = false;

  function evictOldest() {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      const oldestVal = cache.get(oldestKey);
      cachedBytes -= (typeof oldestVal === "string" ? oldestVal.length : 0);
      cache.delete(oldestKey);
    }
  }

  function setCache(key, dataUrl) {
    if (cache.has(key)) {
      const old = cache.get(key);
      cachedBytes -= (typeof old === "string" ? old.length : 0);
      cache.delete(key);
    }
    const itemBytes = typeof dataUrl === "string" ? dataUrl.length : 0;
    while (cache.size > 0 && (cache.size >= MAX_BACKDROP_CACHE_COUNT || cachedBytes + itemBytes > MAX_BACKDROP_CACHE_BYTES)) {
      evictOldest();
    }
    cache.set(key, dataUrl);
    cachedBytes += itemBytes;
  }

  function clearCache() {
    cache.clear();
    cachedBytes = 0;
  }

  function applyCss(cssValue) {
    const root = doc?.documentElement;
    if (!root?.style) return;
    if (appliedCssValue === cssValue) return;
    appliedCssValue = cssValue;
    root.style.setProperty("--kal-wallpaper-image", cssValue);
  }

  async function resolveDataUrl(mode, customPath) {
    const cacheKey = mode === "desktop" ? "__desktop__" : `custom:${customPath}`;
    if (cache.has(cacheKey)) {
      const dataUrl = cache.get(cacheKey);
      // Refresh LRU order
      cache.delete(cacheKey);
      cache.set(cacheKey, dataUrl);
      return dataUrl;
    }
    if (inflight.has(cacheKey)) {
      return inflight.get(cacheKey);
    }
    if (!bridge?.wallpaperReadImage) return null;

    const reqPromise = (async () => {
      try {
        const res = await bridge.wallpaperReadImage(mode === "desktop" ? null : customPath);
        const dataUrl = res?.dataUrl || null;
        if (dataUrl && !disposed) {
          setCache(cacheKey, dataUrl);
        }
        return dataUrl;
      } finally {
        inflight.delete(cacheKey);
      }
    })();

    inflight.set(cacheKey, reqPromise);
    return reqPromise;
  }

  async function sync(theme = getTheme?.()) {
    const version = ++generation;
    const root = doc?.documentElement;
    if (!root?.style) return;
    const mode = theme?.backdrop?.mode || "none";
    const customPath = (theme?.wallpaper || "").trim();

    const isImageMode = (mode === "desktop") || (mode === "custom" && customPath.length > 0);
    if (!isImageMode) {
      // Mode switch release: non-image mode releases cached wallpaper image memory
      clearCache();
      inflight.clear();
      applyCss("none");
      return;
    }

    try {
      const dataUrl = await resolveDataUrl(mode, customPath);
      if (version !== generation || disposed) return;
      if (dataUrl) {
        applyCss(`url("${dataUrl.replace(/"/g, "%22")}")`);
      } else {
        applyCss("none");
      }
    } catch (err) {
      if (version !== generation || disposed) return;
      applyCss("none");
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
      if (cache.has("__desktop__")) {
        const old = cache.get("__desktop__");
        cachedBytes -= (typeof old === "string" ? old.length : 0);
        cache.delete("__desktop__");
      }
      inflight.delete("__desktop__");
      appliedCssValue = null;
      return sync(getTheme?.());
    },
    destroy() {
      disposed = true;
      ++generation;
      unsubscribe();
      inflight.clear();
      clearCache();
      appliedCssValue = null;
    },
  };
}
