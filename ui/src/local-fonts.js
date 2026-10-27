// Private fonts stay in Kal's directory. Only the two selected font families are read.
import { onThemeApplied } from "./theme.js";

export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_LOADED_BYTES = 32 * 1024 * 1024;
const ID = /^local-(?:[0-9a-f]{2})+$/;
const FAMILY = /^"(Kal-local-(?:[0-9a-f]{2})+)"(?:\s*,|\s*$)/;

export function localFontId(stack) {
  return typeof stack === "string" ? stack.match(FAMILY)?.[1]?.slice(4) || null : null;
}

export function selectedLocalIds(theme) {
  return [...new Set([theme?.type?.familyUi, theme?.type?.familyNum].map(localFontId).filter(Boolean))];
}

export function createLocalFonts({ bridge, getTheme, onError = () => {}, doc = document, FontFaceClass = globalThis.FontFace }) {
  let catalog = null;
  let pendingCatalog = null;
  let latestTheme = getTheme();
  let generation = 0;
  let work = Promise.resolve();
  let disposed = false;
  let lastError = null;
  const loaded = new Map();
  const pendingFontReads = new Map();

  function clearFaces() {
    for (const { face } of loaded.values()) doc.fonts?.delete(face);
    loaded.clear();
  }

  async function list() {
    if (catalog) return catalog;
    if (!pendingCatalog) {
      pendingCatalog = Promise.resolve().then(() => bridge.localFontsList()).then(result => {
        if (!result || !Array.isArray(result.fonts)) throw new Error("私有字体列表格式无效");
        catalog = { ...result, fonts: result.fonts.filter(f => ID.test(f.id) && f.family === `Kal-${f.id}` && typeof f.name === "string" && Number.isInteger(f.bytes) && f.bytes > 0 && f.bytes <= MAX_FILE_BYTES) };
        return catalog;
      }).finally(() => { pendingCatalog = null; });
    }
    return pendingCatalog;
  }

  async function readFont(id) {
    if (pendingFontReads.has(id)) return pendingFontReads.get(id);
    const req = (async () => {
      try {
        return await bridge.localFontRead(id);
      } finally {
        pendingFontReads.delete(id);
      }
    })();
    pendingFontReads.set(id, req);
    return req;
  }

  async function loadSelected(theme, version) {
    const ids = selectedLocalIds(theme);
    // System-only themes need no catalog or font reads.
    if (!ids.length) {
      if (loaded.size > 0) clearFaces();
      return;
    }
    // If all selected fonts are already loaded and active, and no error exists, skip redundant work
    if (loaded.size === ids.length && ids.every(id => loaded.has(id)) && lastError === null) {
      return;
    }
    const data = await list();
    if (version !== generation || disposed) return;
    const fonts = ids.map(id => {
      const font = data.fonts.find(f => f.id === id);
      if (!font) throw new Error("主题使用的私有字体已移除或不可读取，请刷新并重新选择字体");
      return font;
    });
    if (fonts.reduce((n, f) => n + f.bytes, 0) > MAX_LOADED_BYTES) throw new Error("所选字体总大小超过 32 MiB 限制");
    // Drop old faces before loading replacements so total resident data stays bounded.
    for (const [id, entry] of loaded) {
      if (!ids.includes(id)) { doc.fonts?.delete(entry.face); loaded.delete(id); }
    }
    for (const font of fonts) {
      if (loaded.has(font.id)) continue;
      if (!FontFaceClass || !doc.fonts) throw new Error("当前环境不支持加载私有字体");
      const payload = await readFont(font.id);
      if (version !== generation || disposed) return;
      if (payload?.id !== font.id || !Array.isArray(payload.bytes) || !payload.bytes.length || payload.bytes.length > MAX_FILE_BYTES || payload.bytes.some(b => !Number.isInteger(b) || b < 0 || b > 255)) {
        throw new Error("字体读取结果无效或超过大小限制");
      }
      const resident = [...loaded.values()].reduce((n, f) => n + f.bytes, 0);
      if (resident + payload.bytes.length > MAX_LOADED_BYTES) throw new Error("所选字体总大小超过 32 MiB 限制");
      const buffer = Uint8Array.from(payload.bytes).buffer;
      payload.bytes = null;
      // No data URLs/base64 or catalog-wide buffers. WebView releases temporary IPC data.
      const face = new FontFaceClass(font.family, buffer, { weight: "100 900", stretch: "50% 200%", display: "swap" });
      try { await face.load(); }
      catch { throw new Error(`无法加载字体 ${font.name}，文件可能损坏或格式不受支持`); }
      if (version !== generation || disposed) return;
      doc.fonts.add(face);
      loaded.set(font.id, { face, bytes: buffer.byteLength });
    }
  }

  function sync(theme = getTheme()) {
    latestTheme = theme;
    const version = ++generation;
    work = work.catch(() => {}).then(() => loadSelected(theme, version));
    return work.then(() => {
      if (version === generation) lastError = null;
    }, err => {
      if (version === generation) lastError = err;
      throw err;
    });
  }

  const unsubscribe = onThemeApplied((theme, appliedDoc) => {
    if (appliedDoc !== doc || disposed) return;
    sync(theme).catch(onError);
  });

  return {
    get error() { return lastError; },
    list,
    sync,
    async refresh() {
      // Finish an older catalog request before invalidating it.
      if (pendingCatalog) await pendingCatalog.catch(() => {});
      ++generation;
      catalog = null;
      clearFaces();
      const result = await list();
      await sync(getTheme() || latestTheme);
      return result;
    },
    destroy() {
      disposed = true;
      ++generation;
      unsubscribe();
      clearFaces();
      catalog = null;
      pendingCatalog = null;
      pendingFontReads.clear();
      lastError = null;
    },
  };
}
