// Kal 前端针对性浏览器 DOM 验证工具
// 仅依赖 Node 22+ 内置模块、内置 WebSocket CDP 与本机 Microsoft Edge。
//
// 运行方式：
//   node tools/ui-check.mjs

import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const UI_DIR = path.join(ROOT_DIR, "ui");
const EDGE_PATH = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const DEFAULT_CDP_PORT = Number(process.env.KAL_UI_CHECK_PORT || 9337);
const WAIT_TIMEOUT_MS = 10000;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 寻找可用本地端口（优先尝试 preferredPort，若被占用则分配随机空闲端口） */
async function findAvailablePort(preferredPort) {
  const tryListen = (port) =>
    new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.unref();
      srv.on("error", reject);
      srv.listen(port, "127.0.0.1", () => {
        const addr = srv.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : port;
        srv.close(() => resolve(actualPort));
      });
    });
  try {
    return await tryListen(preferredPort);
  } catch {
    return await tryListen(0);
  }
}

/** 启动仅绑定 127.0.0.1 且仅暴露 ui/ 目录的静态 HTTP 服务 */
async function startUiServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url || "/", "http://127.0.0.1");
      let reqPath = decodeURIComponent(urlObj.pathname);
      if (reqPath === "/") reqPath = "/index.html";
      const absPath = path.resolve(UI_DIR, "." + reqPath);
      const rel = path.relative(UI_DIR, absPath);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Forbidden");
        return;
      }
      const stat = await fs.stat(absPath);
      if (!stat.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }
      const ext = path.extname(absPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";
      const content = await fs.readFile(absPath);
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
      });
      res.end(content);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        server,
        port: typeof addr === "object" && addr ? addr.port : 0,
      });
    });
  });
}

/** 轮询等待本地 Edge CDP 页面目标就绪 */
async function waitForPageTarget(cdpPort, timeoutMs = WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      if (res.ok) {
        const list = await res.json();
        const page = list.find(t => t.type === "page" && t.webSocketDebuggerUrl);
        if (page) return page;
      }
    } catch (err) {
      lastErr = err;
    }
    await sleep(50);
  }
  throw new Error(`等待 CDP 页面目标超时 (${timeoutMs}ms): ${lastErr?.message || "未就绪"}`);
}

/** 轻量 CDP 会话封装 */
class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect(timeoutMs = WAIT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("CDP WebSocket 连接超时"));
      }, timeoutMs);

      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej, timer: t } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(t);
          if (msg.error) {
            rej(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            res(msg.result);
          }
        }
      };
      ws.onerror = (err) => {
        clearTimeout(timer);
        reject(new Error("CDP WebSocket 错误: " + (err?.message || String(err))));
      };
      ws.onclose = () => {
        for (const { reject: rej, timer: t } of this.pending.values()) {
          clearTimeout(t);
          rej(new Error("CDP WebSocket 已关闭"));
        }
        this.pending.clear();
      };
    });
  }

  send(method, params = {}, timeoutMs = WAIT_TIMEOUT_MS) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP 未连接，无法调用 ${method}`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMs = WAIT_TIMEOUT_MS) {
    const res = await this.send(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        generatePreview: false,
      },
      timeoutMs,
    );
    if (res?.exceptionDetails) {
      const desc =
        res.exceptionDetails.exception?.description ||
        res.exceptionDetails.text ||
        JSON.stringify(res.exceptionDetails);
      throw new Error(`页面执行异常: ${desc}`);
    }
    return res?.result?.value;
  }

  async waitFor(checkExpr, description, timeoutMs = WAIT_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    let lastVal = undefined;
    let lastErr = null;
    while (Date.now() < deadline) {
      try {
        lastVal = await this.evaluate(checkExpr, Math.min(2500, timeoutMs));
        if (lastVal) return lastVal;
        lastErr = null;
      } catch (err) {
        lastErr = err;
      }
      await sleep(35);
    }
    const extra = lastErr ? ` (${lastErr.message})` : ` (last=${JSON.stringify(lastVal)})`;
    throw new Error(`等待条件超时 [${description}]${extra}`);
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch { /* ignore */ }
      this.ws = null;
    }
  }
}

/**
 * 构造通过 Page.addScriptToEvaluateOnNewDocument 注入的假 Tauri IPC 脚本。
 * 内部动态 import("/src/mock.js") 与 import("/src/theme.js")，
 * 开启 requireConfirm: true，保持 bridge.kind === "shell"（不连真实后端）。
 */
function buildPreloadScript(presets) {
  return `
(() => {
  function scrubCredentials(val) {
    if (typeof val === "string") {
      return val
        .replace(/Bearer\\s+[A-Za-z0-9._\\-~+/=]+/gi, "Bearer ***")
        .replace(/(sys_aimcp_token|confirm_token|aimcp_token|token|secret|password|apikey|api_key)\\s*([:=])\\s*\\S+/gi, "$1$2***")
        .replace(/\\b[A-Fa-f0-9]{28,}\\b/g, "***")
        .replace(/\\b[A-Za-z0-9_-]{36,}\\b/g, "***");
    }
    if (Array.isArray(val)) return val.map(scrubCredentials);
    if (val && typeof val === "object") {
      const out = {};
      for (const [k, v] of Object.entries(val)) {
        if (/token|secret|password|apikey|api_key|credential/i.test(k)) {
          out[k] = "***";
        } else {
          out[k] = scrubCredentials(v);
        }
      }
      return out;
    }
    return val;
  }

  const state = {
    initPromise: null,
    mock: null,
    defaultTheme: null,
    calls: [],
    writeStatusOverride: null,
    failNextWriteMessage: null,
    readFailureMessage: null,
    writeDelayMs: 0,
    readDelayMs: 0,
    searchDelayMs: 0,
    searchesActive: 0,
    searchesMaxActive: 0,
    dayDelays: {},
    daysActive: 0,
    requireConfirm: true,
    themes: new Map(${JSON.stringify(presets)}.map(t => [t.id, t])),
    activeTheme: null,
    themeLoadDelay: {},
    failThemeCommit: false,
    savePath: null,
    settings: {},
    failNextSettings: false,
    desktopEnabled: false,
    desktopConflict: false,
  };

  async function ensureInit() {
    if (!state.initPromise) {
      state.initPromise = (async () => {
        const [mockMod, themeMod] = await Promise.all([
          import("/src/mock.js"),
          import("/src/theme.js"),
        ]);
        state.mock = mockMod.createMockSource({ get requireConfirm() { return state.requireConfirm; } });
        state.defaultTheme = JSON.parse(JSON.stringify(themeMod.DEFAULT_THEME));
        state.activeTheme = state.defaultTheme;
        state.themes.set("default", state.defaultTheme);
      })();
    }
    return state.initPromise;
  }

  function recordCall(cmd, args) {
    state.calls.push({
      cmd: String(cmd),
      args: scrubCredentials(args ?? {}),
      ts: Date.now(),
    });
  }

  async function invoke(cmd, args = {}) {
    await ensureInit();
    recordCall(cmd, args);

    const mock = state.mock;
    switch (cmd) {
      case "app_info":
        return {
          uiScale: 1,
          themeId: "default",
          sourceLabel: "DesktopCal",
          dbFound: true,
          display: {
            ppiKnown: true,
            pxW: 1920,
            pxH: 1080,
            diagonalIn: 24.0,
            dpiScale: 1,
            monitor: "Kal Test Monitor",
            mmW: 531,
            mmH: 299,
            ppi: 91.8,
            kalScale: 1,
          },
        };
      case "theme_active":
        return structuredClone(state.activeTheme);
      case "theme_list":
        return [...state.themes.values()].map(t=>({id:t.id,name:t.name,mode:t.mode,builtin:t.id==="default"||t.id.startsWith("builtin-")}));
      case "theme_load":
        if(state.themeLoadDelay[args.id]) await new Promise(r=>setTimeout(r,state.themeLoadDelay[args.id]));
        if(!state.themes.has(args.id))throw new Error("Theme not found");
        return structuredClone(state.themes.get(args.id));
      case "theme_commit": {
        if(state.failThemeCommit){state.failThemeCommit=false;throw new Error("模拟活动设置提交失败");}
        const saved={...structuredClone(args.theme),id:"user-"+Date.now()+"-"+state.themes.size};
        state.themes.set(saved.id,saved);state.activeTheme=saved;return structuredClone(saved);
      }
      case "theme_export_draft": return args.path;
      case "fonts_list":
        return ["Microsoft YaHei UI", "Segoe UI", "Consolas", "霞鹜文楷"];
      case "settings_get":
        return structuredClone(state.settings);
      case "settings_set":
        if (state.failNextSettings) { state.failNextSettings = false; throw new Error("本地设置保存失败"); }
        for (const [key, value] of Object.entries(args.patch ?? {})) {
          state.settings[key] = typeof value === "object" && !Array.isArray(value)
            ? { ...state.settings[key], ...value } : value;
        }
        return structuredClone(state.settings);
      case "local_fonts_list":
        return { directory: "Kal/fonts", fonts: [], skipped: 0, maxFileBytes: 16777216, maxLoadedBytes: 33554432 };
      case "desktop_status":
        return { enabled: state.desktopEnabled, registered: state.desktopEnabled && !state.desktopConflict, shortcut: "Win+Alt+C", error: state.desktopEnabled && state.desktopConflict ? "快捷键已被其他应用占用" : null };
      case "desktop_set_hotkey":
        state.desktopEnabled = Boolean(args.enabled);
        return { enabled: state.desktopEnabled, registered: state.desktopEnabled && !state.desktopConflict, shortcut: "Win+Alt+C", error: state.desktopEnabled && state.desktopConflict ? "快捷键已被其他应用占用" : null };
      case "autostart_status":
        return { enabled: Boolean(state.autostartEnabled) };
      case "autostart_set":
        state.autostartEnabled = Boolean(args?.enabled);
        return { enabled: state.autostartEnabled };
      case "display_info":
        return {
          ppiKnown: true,
          pxW: 1920,
          pxH: 1080,
          diagonalIn: 24.0,
          dpi: 96,
          dpiScale: 1,
          monitor: "Kal Test Monitor",
          mmW: 531,
          mmH: 299,
          ppi: 91.8,
          kalScale: 1,
          orientation: "landscape",
          isPrimary: true,
        };
      case "desktop_dock_status":
        return state.dockState || {
          docked: false,
          position: "left-desktop",
          monitor: "",
          widthRatio: 0.64,
          heightRatio: 0.94,
          idleFade: false,
          monitors: [
            {
              monitor: "Kal Test Monitor",
              pxW: 1920,
              pxH: 1080,
              diagonalIn: 24.0,
              dpi: 96,
              dpiScale: 1,
              kalScale: 1,
              ppiKnown: true,
              orientation: "landscape",
              isPrimary: true,
              work: [0, 0, 1920, 1040],
            },
            {
              monitor: "Kal Portrait 27",
              pxW: 1440,
              pxH: 2560,
              diagonalIn: 27.0,
              dpi: 96,
              dpiScale: 1,
              kalScale: 1.13,
              ppiKnown: true,
              orientation: "portrait",
              isPrimary: false,
              work: [1920, 0, 3360, 2520],
            },
          ],
        };
      case "desktop_apply_dock": {
        const opts = args?.opts || args || {};
        state.dockState = {
          docked: Boolean(opts.docked),
          position: opts.position || "left-desktop",
          monitor: opts.monitor || "",
          widthRatio: opts.widthRatio ?? 0.64,
          heightRatio: opts.heightRatio ?? 0.94,
          idleFade: Boolean(opts.idleFade),
          monitors: [
            {
              monitor: "Kal Test Monitor",
              pxW: 1920,
              pxH: 1080,
              diagonalIn: 24.0,
              dpi: 96,
              dpiScale: 1,
              kalScale: 1,
              ppiKnown: true,
              orientation: "landscape",
              isPrimary: true,
              work: [0, 0, 1920, 1040],
            },
            {
              monitor: "Kal Portrait 27",
              pxW: 1440,
              pxH: 2560,
              diagonalIn: 27.0,
              dpi: 96,
              dpiScale: 1,
              kalScale: 1.13,
              ppiKnown: true,
              orientation: "portrait",
              isPrimary: false,
              work: [1920, 0, 3360, 2520],
            },
          ],
        };
        return state.dockState;
      }
      case "notes_list":
        if (!state.customNotes) {
          state.customNotes = [{ id: "nt-1", title: "跨日期便签", preview: "测试正文", content: "测试正文" + String.fromCharCode(10) + "<img src=x onerror=alert(1)>", created: "2000-01-01", modified: "" }];
        }
        return { notes: args.offset ? [] : state.customNotes.map(({ content: _c, ...rest }) => ({ ...rest })), hasMore: false };
      case "note_get": {
        if (!state.customNotes) {
          state.customNotes = [{ id: "nt-1", title: "跨日期便签", preview: "测试正文", content: "测试正文" + String.fromCharCode(10) + "<img src=x onerror=alert(1)>", created: "2000-01-01", modified: "" }];
        }
        const found = state.customNotes.find(n => n.id === args?.id) || state.customNotes[0];
        return { content: found ? found.content : "", truncated: false };
      }
      case "note_save": {
        if (!state.customNotes) {
          state.customNotes = [{ id: "nt-1", title: "跨日期便签", preview: "测试正文", content: "测试正文" + String.fromCharCode(10) + "<img src=x onerror=alert(1)>", created: "2000-01-01", modified: "" }];
        }
        const cleanTitle = String(args?.title ?? "").trim();
        const content = String(args?.content ?? "");
        const preview = content.slice(0, 160);
        if (args?.id) {
          const existing = state.customNotes.find(n => n.id === args.id);
          if (existing) {
            existing.title = cleanTitle;
            existing.content = content;
            existing.preview = preview;
            return { id: existing.id, title: existing.title, preview: existing.preview, created: existing.created, modified: "2026-10-26" };
          }
        }
        const newNote = { id: "nt-" + Date.now(), title: cleanTitle, preview, content, created: "2026-10-26", modified: "2026-10-26" };
        state.customNotes.unshift(newNote);
        return { id: newNote.id, title: newNote.title, preview: newNote.preview, created: newNote.created, modified: newNote.modified };
      }
      case "note_delete": {
        if (state.customNotes) {
          state.customNotes = state.customNotes.filter(n => n.id !== args?.id);
        }
        return { status: "saved" };
      }
      case "window_set_click_through":
        return Boolean(args?.enabled);
      case "display_info":
        return {
          ppiKnown: true,
          pxW: 1920,
          pxH: 1080,
          diagonalIn: 24.0,
          dpiScale: 1,
          monitor: "Kal Test Monitor",
          mmW: 531,
          mmH: 299,
          ppi: 91.8,
          kalScale: 1,
        };
      case "month_events": {
        if (state.readDelayMs) await new Promise(r => setTimeout(r, state.readDelayMs));
        if (state.readFailureMessage) {
          throw new Error(state.readFailureMessage);
        }
        const year = Number(args?.year);
        const month0 = Number(args?.month) - 1;
        return await mock.monthEvents(year, month0);
      }
      case "range_events": {
        if (state.readDelayMs) await new Promise(r => setTimeout(r, state.readDelayMs));
        if (state.readFailureMessage) throw new Error(state.readFailureMessage);
        return await mock.rangeEvents(args.start, args.end);
      }
      case "day_events": {
        if (state.readFailureMessage) {
          throw new Error(state.readFailureMessage);
        }
        state.daysActive++;
        try {
          if (state.dayDelays[args.date]) await new Promise(r=>setTimeout(r,state.dayDelays[args.date]));
          return await mock.dayEvents(args?.date);
        } finally { state.daysActive--; }
      }
      case "search_events":
        state.searchesActive++;
        state.searchesMaxActive = Math.max(state.searchesMaxActive, state.searchesActive);
        try {
          if (state.searchDelayMs) await new Promise(r => setTimeout(r, state.searchDelayMs));
          return await mock.searchEvents(args?.query ?? "");
        } finally { state.searchesActive--; }
      case "calendar_write_status":
        if (state.writeStatusOverride) {
          return JSON.parse(JSON.stringify(state.writeStatusOverride));
        }
        return {
          available: true,
          canCreate: true,
          canCreateEvent: true,
          label: "可直接添加或修改安排",
        };
      case "item_create": {
        if (state.writeDelayMs > 0) {
          await new Promise(r => setTimeout(r, state.writeDelayMs));
        }
        if (state.failNextWriteMessage) {
          const msg = state.failNextWriteMessage;
          state.failNextWriteMessage = null;
          throw new Error(msg);
        }
        return await mock.itemCreate(args?.date, args?.title, args?.time ?? "");
      }
      case "item_update": {
        if (state.writeDelayMs > 0) {
          await new Promise(r => setTimeout(r, state.writeDelayMs));
        }
        if (state.failNextWriteMessage) {
          const msg = state.failNextWriteMessage;
          state.failNextWriteMessage = null;
          throw new Error(msg);
        }
        return await mock.itemUpdate(args?.id, args?.date, args?.title, args?.expected ?? null);
      }
      case "item_toggle_done": {
        if (state.writeDelayMs > 0) {
          await new Promise(r => setTimeout(r, state.writeDelayMs));
        }
        if (state.failNextWriteMessage) {
          const msg = state.failNextWriteMessage;
          state.failNextWriteMessage = null;
          throw new Error(msg);
        }
        return await mock.itemToggleDone(args?.id, args?.date, args?.done, args?.expected ?? null);
      }
      case "item_delete": {
        if (state.writeDelayMs > 0) {
          await new Promise(r => setTimeout(r, state.writeDelayMs));
        }
        if (state.failNextWriteMessage) {
          const msg = state.failNextWriteMessage;
          state.failNextWriteMessage = null;
          throw new Error(msg);
        }
        return await mock.itemDelete(args?.id, args?.date, args?.expected ?? null);
      }
      case "item_move": {
        if (state.writeDelayMs > 0) {
          await new Promise(r => setTimeout(r, state.writeDelayMs));
        }
        if (state.failNextWriteMessage) {
          const msg = state.failNextWriteMessage;
          state.failNextWriteMessage = null;
          throw new Error(msg);
        }
        return await mock.itemMove(args?.id, args?.fromDate, args?.toDate, args?.expected ?? null);
      }
      case "calendar_import_items":
        return await mock.calendarImportItems(args?.items ?? []);
      case "calendar_import_db":
        return await mock.calendarImportDb(args?.path ?? "mock-external.db");
      case "app_log_append":
        return true;
      case "calendar_read_text_file":
        return state.mockIcsContent || "";
      case "item_confirm":
        return await mock.itemConfirm(args?.pendingId, Boolean(args?.accept));
      default:
        return null;
    }
  }

  window.__TAURI__ = {
    core: { invoke },
    event: { listen: async () => () => {} },
    dialog: {
      open: async () => null,
      save: async () => state.savePath,
    },
  };

  window.__KAL_TEST__ = {
    setThemeLoadDelay(id, ms) { state.themeLoadDelay[id] = Number(ms)||0; },
    failNextThemeCommit() { state.failThemeCommit = true; },
    setSavePath(path) { state.savePath = path; },
    getCalls(cmd = null) {
      const list = cmd ? state.calls.filter(c => c.cmd === cmd) : state.calls;
      return JSON.parse(JSON.stringify(list));
    },
    clearCalls() {
      state.calls.length = 0;
    },
    setDayDelay(key, ms) { state.dayDelays[key] = Number(ms)||0; },
    dayActivity() { return state.daysActive; },
    setSearchDelay(ms) { state.searchDelayMs = Number(ms) || 0; state.searchesMaxActive = state.searchesActive; },
    searchActivity() { return { active: state.searchesActive, max: state.searchesMaxActive }; },
    setReadDelay(ms) { state.readDelayMs = Number(ms) || 0; },
    setRequireConfirm(value) { state.requireConfirm = Boolean(value); },
    setWriteDelay(ms) {
      state.writeDelayMs = Number(ms) || 0;
    },
    failNextSettings() { state.failNextSettings = true; },
    setDesktopConflict(value) { state.desktopConflict = Boolean(value); },
    setFailNextWrite(msg) {
      state.failNextWriteMessage = msg ? String(msg) : null;
    },
    setWriteStatusOverride(override) {
      state.writeStatusOverride = override;
    },
    setReadFailure(msg) {
      state.readFailureMessage = msg ? String(msg) : null;
    },
    async seedDirectItem(date, title, time = "") {
      await ensureInit();
      const pending = await state.mock.itemCreate(date, title, time);
      if (pending && pending.status === "pending_confirmation") {
        return await state.mock.itemConfirm(pending.pendingId, true);
      }
      return pending;
    },
  };
})();
`;
}

async function run() {
  const results = [];
  let passCount = 0;
  let failCount = 0;

  const record = (id, name, ok, detail = "") => {
    results.push({ id, name, ok, detail });
    if (ok) {
      passCount++;
      console.log(`  PASS  [${id}] ${name}${detail ? " — " + detail : ""}`);
    } else {
      failCount++;
      console.error(`  FAIL  [${id}] ${name}${detail ? " — " + detail : ""}`);
    }
  };

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "kal-ui-check-"));
  const { server: httpServer, port: httpPort } = await startUiServer();
  const cdpPort = await findAvailablePort(DEFAULT_CDP_PORT);

  let edgeProc = null;
  let cdp = null;

  try {
    edgeProc = spawn(
      EDGE_PATH,
      [
        "--headless=new",
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "about:blank",
      ],
      { stdio: "ignore", windowsHide: true },
    );

    const target = await waitForPageTarget(cdpPort, WAIT_TIMEOUT_MS);
    cdp = new CdpSession(target.webSocketDebuggerUrl);
    await cdp.connect(WAIT_TIMEOUT_MS);

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: buildPreloadScript(await Promise.all(["starport-paper","deep-ocean","mocha","nord","rose-dawn"].map(async name => JSON.parse(await fs.readFile(path.join(ROOT_DIR,"src-tauri/themes",name+".json"),"utf8"))))),
    });

    const pageUrl = `http://127.0.0.1:${httpPort}/index.html`;
    await cdp.send("Page.navigate", { url: pageUrl });

    // =========================================================================
    // 测试 1：42 格启动（保持 shell 外壳模式，不回落 Mock 调试背景）
    // =========================================================================
    try {
      const bootInfo = await cdp.waitFor(
        `(() => {
          const cells = document.querySelectorAll("#kal-grid .kal-cell");
          const agendaReady = document.querySelectorAll("#kal-agenda-list li").length > 0;
          if ((cells.length !== 35 && cells.length !== 42) || !agendaReady) return null;
          const calls = window.__KAL_TEST__.getCalls();
          return {
            cellCount: cells.length,
            isShellMode: !document.body.classList.contains("kal-debug-bg") && Boolean(window.__TAURI__?.core?.invoke),
            sourceTag: document.getElementById("kal-source-tag")?.textContent || "",
            selectedKey: document.querySelector("#kal-grid .kal-cell.is-selected")?.dataset?.key || "",
            appInfoCalled: calls.some(c => c.cmd === "app_info"),
            rangeEventsCount: calls.filter(c => c.cmd === "range_events").length,
            monthEventsCount: calls.filter(c => c.cmd === "month_events").length,
            defaultAgendaHidden: document.body.classList.contains("kal-agenda-hidden"),
          };
        })()`,
        "测试1: 42格日历与日程栏渲染就绪",
      );
      // Wait for settings panel (#kal-agenda-sidebar-toggle) to mount, then enable right sidebar for subsequent right-pane tests
      await cdp.waitFor(`Boolean(document.getElementById("kal-agenda-sidebar-toggle"))`, "测试1: 等待设置面板开关挂载");
      await cdp.evaluate(`(() => {
        const toggle = document.getElementById("kal-agenda-sidebar-toggle");
        if (toggle && !toggle.checked) toggle.click();
      })()`);
      await cdp.waitFor(`!document.body.classList.contains("kal-agenda-hidden")`, "测试1后开启右侧栏以执行后续右侧栏用例");
      const ok =
        (bootInfo.cellCount === 35 || bootInfo.cellCount === 42) &&
        bootInfo.isShellMode === true &&
        bootInfo.appInfoCalled === true &&
        bootInfo.defaultAgendaHidden === true &&
        bootInfo.rangeEventsCount === 1 && bootInfo.monthEventsCount === 0 &&
        /^\d{4}-\d{2}-\d{2}$/.test(bootInfo.selectedKey);
      record(
        1,
        "42格启动（shell模式挂载 + 默认仅展示左侧日历）",
        ok,
        `cells=${bootInfo.cellCount}, shell=${bootInfo.isShellMode}, defaultAgendaHidden=${bootInfo.defaultAgendaHidden}, selected=${bootInfo.selectedKey}`,
      );
    } catch (err) {
      record(1, "42格启动（shell模式挂载）", false, err.message);
    }

    try {
      await cdp.evaluate(`(() => {
        window.__KAL_TEST__.setRequireConfirm(false);
        window.__KAL_TEST__.setReadDelay(350);
        const input = document.getElementById("kal-agenda-input");
        input.value = "延迟刷新复现首条";
        input.dispatchEvent(new Event("input", {bubbles:true}));
        document.getElementById("kal-agenda-add").requestSubmit();
      })()`);
      await cdp.waitFor(`document.getElementById("kal-agenda-input").value === "" && !document.getElementById("kal-agenda-input").disabled`, "首次成功清空且刷新仍等待");
      await cdp.evaluate(`(() => {const input=document.getElementById("kal-agenda-input");input.focus();})()`);
      await cdp.send("Input.insertText", {text:"刷新期间的新草稿"});
      await cdp.waitFor(`Array.from(document.querySelectorAll(".kal-agenda-text")).some(n=>n.textContent==="延迟刷新复现首条")`, "延迟读取完成");
      const retained = await cdp.evaluate(`document.getElementById("kal-agenda-input").value`);
      record("P0-delay", "延迟刷新保留下一条草稿", retained === "刷新期间的新草稿", JSON.stringify(retained));
    } catch (err) { record("P0-delay", "延迟刷新保留下一条草稿", false, err.message); }
    await cdp.evaluate(`(() => {window.__KAL_TEST__.setReadDelay(0);window.__KAL_TEST__.setRequireConfirm(true);})()`);

    // =========================================================================
    // 测试 2：新增表单连续 submit 只一次写请求、pending 显式点击 confirm 后保存
    // =========================================================================
    try {
      const submitSnap = await cdp.evaluate(`(() => {
        window.__KAL_TEST__.clearCalls();
        window.__KAL_TEST__.setWriteDelay(40);
        const input = document.getElementById("kal-agenda-input");
        const form = document.getElementById("kal-agenda-add");
        input.value = "DOM验证新增普通任务";
        form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
        form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
        return { busyDisabled: input.disabled };
      })()`);

      const pendingState = await cdp.waitFor(
        `(() => {
          const box = document.getElementById("kal-pending-box");
          const confirmBtn = box?.querySelector(".kal-pending-btn.is-confirm");
          if (!box || box.hidden || !confirmBtn) return null;
          const form = document.getElementById("kal-agenda-add");
          form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
          const createCalls = window.__KAL_TEST__.getCalls("item_create");
          const listTexts = Array.from(document.querySelectorAll("#kal-agenda-list .kal-agenda-text")).map(n => n.textContent);
          return {
            createCallCount: createCalls.length,
            inListBeforeConfirm: listTexts.includes("DOM验证新增普通任务"),
            summaryText: box.querySelector(".kal-pending-summary")?.textContent || "",
          };
        })()`,
        "测试2: 进入 pending_confirmation 待确认框",
      );

      await cdp.evaluate(`(() => {
        window.__KAL_TEST__.setWriteDelay(0);
        document.querySelector("#kal-pending-box .kal-pending-btn.is-confirm").click();
      })()`);

      const afterConfirm = await cdp.waitFor(
        `(() => {
          const box = document.getElementById("kal-pending-box");
          const listTexts = Array.from(document.querySelectorAll("#kal-agenda-list .kal-agenda-text")).map(n => n.textContent);
          if (!box.hidden || !listTexts.includes("DOM验证新增普通任务")) return null;
          return {
            createCallCount: window.__KAL_TEST__.getCalls("item_create").length,
            confirmCalls: window.__KAL_TEST__.getCalls("item_confirm"),
            inputCleared: document.getElementById("kal-agenda-input").value === "",
          };
        })()`,
        "测试2: 点击确认保存后落盘渲染",
      );

      const ok =
        submitSnap.busyDisabled === true &&
        pendingState.createCallCount === 1 &&
        pendingState.inListBeforeConfirm === false &&
        afterConfirm.createCallCount === 1 &&
        afterConfirm.confirmCalls.length === 1 &&
        afterConfirm.confirmCalls[0].args?.accept === true &&
        afterConfirm.inputCleared === true;
      record(
        2,
        "新增表单连续submit只一次写请求、pending显式点击confirm后保存",
        ok,
        `item_create=${afterConfirm.createCallCount}, beforeConfirmInDOM=${pendingState.inListBeforeConfirm}, confirmed=true`,
      );
    } catch (err) {
      record(2, "新增表单连续submit只一次写请求、pending显式点击confirm后保存", false, err.message);
    }

    // =========================================================================
    // 测试 3：双击编辑 Enter+blur 只一次 item_update 且 expected 包含 revision/calendarId/remoteId
    // =========================================================================
    try {
      await cdp.evaluate(`(() => {
        window.__KAL_TEST__.clearCalls();
        const items = Array.from(document.querySelectorAll("#kal-agenda-list li"));
        const targetLi = items.find(li => li.querySelector(".kal-agenda-text")?.textContent === "DOM验证新增普通任务");
        if (!targetLi) throw new Error("未找到待编辑的任务项");
        const txt = targetLi.querySelector(".kal-agenda-text");
        txt.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        const editInput = targetLi.querySelector("input.kal-agenda-edit");
        if (!editInput) throw new Error("双击后未生成 input.kal-agenda-edit");
        editInput.value = "DOM验证已编辑任务";
        editInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        editInput.dispatchEvent(new FocusEvent("blur"));
      })()`);

      const updatePending = await cdp.waitFor(
        `(() => {
          const box = document.getElementById("kal-pending-box");
          const confirmBtn = box?.querySelector(".kal-pending-btn.is-confirm");
          if (!box || box.hidden || !confirmBtn) return null;
          const updCalls = window.__KAL_TEST__.getCalls("item_update");
          return {
            updateCount: updCalls.length,
            firstCall: updCalls[0] || null,
          };
        })()`,
        "测试3: 双击编辑触发 pending_confirmation",
      );

      await cdp.evaluate(`(() => {
        document.querySelector("#kal-pending-box .kal-pending-btn.is-confirm").click();
      })()`);

      const afterEdit = await cdp.waitFor(
        `(() => {
          const texts = Array.from(document.querySelectorAll("#kal-agenda-list .kal-agenda-text")).map(n => n.textContent);
          if (!texts.includes("DOM验证已编辑任务")) return null;
          return {
            updateCount: window.__KAL_TEST__.getCalls("item_update").length,
            texts,
          };
        })()`,
        "测试3: 确认后更新标题渲染",
      );

      const exp = updatePending.firstCall?.args?.expected;
      const hasExpectedFields =
        Boolean(exp) &&
        typeof exp.revision === "string" && exp.revision.length > 0 &&
        typeof exp.calendarId === "string" && exp.calendarId.length > 0 &&
        typeof exp.remoteId === "string" && exp.remoteId.length > 0;
      const ok =
        updatePending.updateCount === 1 &&
        afterEdit.updateCount === 1 &&
        hasExpectedFields;
      record(
        3,
        "双击编辑Enter+blur只一次item_update且expected含revision/calendarId/remoteId",
        ok,
        `item_update=${afterEdit.updateCount}, calendarId=${exp?.calendarId}, remoteId=${exp?.remoteId}, revision=${exp?.revision}`,
      );
    } catch (err) {
      record(3, "双击编辑Enter+blur只一次item_update且expected含revision/calendarId/remoteId", false, err.message);
    }

    // =========================================================================
    // 测试 4：普通任务完成（点击可切换圆点 -> pending 确认 -> li.is-done）
    // =========================================================================
    try {
      await cdp.evaluate(`(() => {
        window.__KAL_TEST__.clearCalls();
        const items = Array.from(document.querySelectorAll("#kal-agenda-list li"));
        const targetLi = items.find(li => li.querySelector(".kal-agenda-text")?.textContent === "DOM验证已编辑任务");
        if (!targetLi) throw new Error("未找到待切换完成态的普通任务");
        const dot = targetLi.querySelector(".kal-agenda-dot.is-toggleable");
        if (!dot) throw new Error("普通任务缺少 .kal-agenda-dot.is-toggleable");
        dot.click();
      })()`);

      await cdp.waitFor(
        `(() => {
          const box = document.getElementById("kal-pending-box");
          return box && !box.hidden && window.__KAL_TEST__.getCalls("item_toggle_done").length === 1;
        })()`,
        "测试4: item_toggle_done 进入待确认",
      );

      await cdp.evaluate(`(() => {
        document.querySelector("#kal-pending-box .kal-pending-btn.is-confirm").click();
      })()`);

      const toggleRes = await cdp.waitFor(
        `(() => {
          const items = Array.from(document.querySelectorAll("#kal-agenda-list li"));
          const targetLi = items.find(li => li.querySelector(".kal-agenda-text")?.textContent === "DOM验证已编辑任务");
          if (!targetLi || !targetLi.classList.contains("is-done")) return null;
          const toggleCalls = window.__KAL_TEST__.getCalls("item_toggle_done");
          return {
            isDone: targetLi.classList.contains("is-done"),
            toggleCount: toggleCalls.length,
            doneArg: toggleCalls[0]?.args?.done,
          };
        })()`,
        "测试4: 确认后普通任务标记为 is-done",
      );

      const ok = toggleRes.isDone === true && toggleRes.toggleCount === 1 && toggleRes.doneArg === true;
      record(
        4,
        "普通任务完成状态切换",
        ok,
        `isDone=${toggleRes.isDone}, item_toggle_done=${toggleRes.toggleCount}`,
      );
    } catch (err) {
      record(4, "普通任务完成状态切换", false, err.message);
    }

    // =========================================================================
    // 测试 5：内联删除取消 + 确认取消 + 确认保存
    // =========================================================================
    try {
      const step5a = await cdp.evaluate(`(() => {
        window.__KAL_TEST__.clearCalls();
        const items = Array.from(document.querySelectorAll("#kal-agenda-list li"));
        const targetLi = items.find(li => li.querySelector(".kal-agenda-text")?.textContent === "DOM验证已编辑任务");
        if (!targetLi) throw new Error("未找到待删除任务");
        const delBtn = targetLi.querySelector("button.kal-agenda-action");
        delBtn.click();
        const inlineGroup = targetLi.querySelector(".kal-agenda-confirm");
        if (!inlineGroup) throw new Error("点击删除未出现内联确认组");
        const inlineCancel = inlineGroup.querySelector(".kal-agenda-confirm-btn:not(.is-danger)");
        inlineCancel.click();
        return {
          deleteCallsAfterInlineCancel: window.__KAL_TEST__.getCalls("item_delete").length,
          actionRestored: Boolean(targetLi.querySelector("button.kal-agenda-action")),
        };
      })()`);

      await cdp.evaluate(`(() => {
        const items = Array.from(document.querySelectorAll("#kal-agenda-list li"));
        const targetLi = items.find(li => li.querySelector(".kal-agenda-text")?.textContent === "DOM验证已编辑任务");
        targetLi.querySelector("button.kal-agenda-action").click();
        targetLi.querySelector(".kal-agenda-confirm .kal-agenda-confirm-btn.is-danger").click();
      })()`);

      await cdp.waitFor(
        `(() => {
          const box = document.getElementById("kal-pending-box");
          return box && !box.hidden && window.__KAL_TEST__.getCalls("item_delete").length === 1;
        })()`,
        "测试5b: item_delete 进入待确认框",
      );

      await cdp.evaluate(`(() => {
        document.querySelector("#kal-pending-box .kal-pending-btn:not(.is-confirm)").click();
      })()`);

      const step5b = await cdp.waitFor(
        `(() => {
          const box = document.getElementById("kal-pending-box");
          if (!box.hidden) return null;
          const items = Array.from(document.querySelectorAll("#kal-agenda-list li"));
          const targetLi = items.find(li => li.querySelector(".kal-agenda-text")?.textContent === "DOM验证已编辑任务");
          if (!targetLi || !targetLi.querySelector("button.kal-agenda-action")) return null;
          const confirmCalls = window.__KAL_TEST__.getCalls("item_confirm");
          return {
            stillExists: true,
            confirmAcceptArg: confirmCalls[confirmCalls.length - 1]?.args?.accept,
          };
        })()`,
        "测试5b: 取消待确认后任务保留且删除按钮恢复",
      );

      await cdp.evaluate(`(() => {
        window.__KAL_TEST__.clearCalls();
        const items = Array.from(document.querySelectorAll("#kal-agenda-list li"));
        const targetLi = items.find(li => li.querySelector(".kal-agenda-text")?.textContent === "DOM验证已编辑任务");
        targetLi.querySelector("button.kal-agenda-action").click();
        targetLi.querySelector(".kal-agenda-confirm .kal-agenda-confirm-btn.is-danger").click();
      })()`);

      await cdp.waitFor(
        `(() => {
          const box = document.getElementById("kal-pending-box");
          return box && !box.hidden && window.__KAL_TEST__.getCalls("item_delete").length === 1;
        })()`,
        "测试5c: 再次发起 item_delete 进入待确认框",
      );

      await cdp.evaluate(`(() => {
        document.querySelector("#kal-pending-box .kal-pending-btn.is-confirm").click();
      })()`);

      const step5c = await cdp.waitFor(
        `(() => {
          const box = document.getElementById("kal-pending-box");
          const texts = Array.from(document.querySelectorAll("#kal-agenda-list .kal-agenda-text")).map(n => n.textContent);
          if (!box.hidden || texts.includes("DOM验证已编辑任务")) return null;
          const confirmCalls = window.__KAL_TEST__.getCalls("item_confirm");
          return {
            removed: !texts.includes("DOM验证已编辑任务"),
            confirmAcceptArg: confirmCalls[confirmCalls.length - 1]?.args?.accept,
          };
        })()`,
        "测试5c: 确认保存后任务从 DOM 移除",
      );

      const ok =
        step5a.deleteCallsAfterInlineCancel === 0 &&
        step5a.actionRestored === true &&
        step5b.stillExists === true &&
        step5b.confirmAcceptArg === false &&
        step5c.removed === true &&
        step5c.confirmAcceptArg === true;
      record(
        5,
        "内联删除取消+确认取消+确认保存",
        ok,
        `inlineCancelCalls=${step5a.deleteCallsAfterInlineCancel}, pendingCancelKept=${step5b.stillExists}, finalRemoved=${step5c.removed}`,
      );
    } catch (err) {
      record(5, "内联删除取消+确认取消+确认保存", false, err.message);
    }

    // =========================================================================
    // 测试 6：搜索中文并点击跳日期
    // =========================================================================
    try {
      const curSelected = await cdp.evaluate(
        `document.querySelector("#kal-grid .kal-cell.is-selected")?.dataset?.key || ""`,
      );
      const query = curSelected.endsWith("-26") ? "牙医复诊" : "倒计时卡片";

      await cdp.evaluate(`((q) => {
        window.__KAL_TEST__.clearCalls();
        document.getElementById("kal-search-btn").click();
        const input = document.getElementById("kal-search-input");
        input.value = q;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      })(${JSON.stringify(query)})`);

      const searchHit = await cdp.waitFor(
        `(() => {
          const itemEl = document.querySelector("#kal-search-list .kal-search-item");
          if (!itemEl) return null;
          return {
            date: itemEl.querySelector(".kal-search-item-date")?.textContent || "",
            title: itemEl.querySelector(".kal-search-item-title")?.textContent || "",
            searchCalls: window.__KAL_TEST__.getCalls("search_events"),
          };
        })()`,
        "测试6: 中文搜索结果列表渲染",
      );

      await cdp.evaluate(`(() => {
        document.querySelector("#kal-search-list .kal-search-item").click();
      })()`);

      const jumpState = await cdp.waitFor(
        `((expectedDate, expectedQuery) => {
          const popoverHidden = document.getElementById("kal-search-popover")?.hidden === true;
          const selKey = document.querySelector("#kal-grid .kal-cell.is-selected")?.dataset?.key || "";
          const agendaTexts = Array.from(document.querySelectorAll("#kal-agenda-list .kal-agenda-text")).map(n => n.textContent);
          if (!popoverHidden || selKey !== expectedDate || !agendaTexts.some(t => t.includes(expectedQuery))) return null;
          return { popoverHidden, selKey, agendaTexts };
        })(${JSON.stringify(searchHit.date)}, ${JSON.stringify(query)})`,
        "测试6: 点击搜索结果跳转到目标日期",
      );

      const ok =
        searchHit.searchCalls.some(c => c.args?.query === query) &&
        jumpState.popoverHidden === true &&
        jumpState.selKey === searchHit.date &&
        jumpState.selKey !== curSelected;
      record(
        6,
        "搜索中文并点击跳日期",
        ok,
        `query="${query}", jumped=${curSelected}->${jumpState.selKey}`,
      );
    } catch (err) {
      record(6, "搜索中文并点击跳日期", false, err.message);
    }

    // =========================================================================
    // 测试 7：跨月邻格完整显示（给 mock 提前加邻月任务然后点 refresh）
    // =========================================================================
    try {
      const neighborSetup = await cdp.evaluate(`(async () => {
        const otherCells = Array.from(document.querySelectorAll("#kal-grid .kal-cell.is-other-month"));
        if (!otherCells.length) throw new Error("当前 42 格未找到非本月邻格");
        const targetKey = otherCells[0].dataset.key;
        await window.__KAL_TEST__.seedDirectItem(targetKey, "跨月邻格验证事项", "08:15");
        document.getElementById("kal-refresh").click();
        return { targetKey, otherCount: otherCells.length };
      })()`);

      const neighborRendered = await cdp.waitFor(
        `((key) => {
          const cell = Array.from(document.querySelectorAll("#kal-grid .kal-cell.is-other-month")).find(c => c.dataset.key === key);
          if (!cell) return null;
          const taskTexts = Array.from(cell.querySelectorAll(".kal-task")).map(n => n.textContent);
          if (!taskTexts.includes("跨月邻格验证事项")) return null;
          return { key, taskTexts };
        })(${JSON.stringify(neighborSetup.targetKey)})`,
        "测试7: 刷新后跨月邻格显示新增任务",
      );

      const ok = neighborRendered.taskTexts.includes("跨月邻格验证事项");
      record(
        7,
        "跨月邻格完整显示（提前注入邻月任务并点refresh）",
        ok,
        `neighborKey=${neighborRendered.key}, tasks=${JSON.stringify(neighborRendered.taskTexts)}`,
      );
    } catch (err) {
      record(7, "跨月邻格完整显示（提前注入邻月任务并点refresh）", false, err.message);
    }

    // =========================================================================
    // 测试 8：中文 IME 合成态不触发快捷键
    // =========================================================================
    try {
      const imeCheck = await cdp.evaluate(`(() => {
        const beforeMonth = document.getElementById("kal-month-label").textContent;
        const beforeSelected = document.querySelector("#kal-grid .kal-cell.is-selected")?.dataset?.key || "";
        const dispatchImeKey = (target, key, extra = {}) => {
          const ev = new KeyboardEvent("keydown", {
            key,
            isComposing: true,
            keyCode: 229,
            bubbles: true,
            cancelable: true,
            ...extra,
          });
          target.dispatchEvent(ev);
        };

        dispatchImeKey(window, "ArrowLeft");
        dispatchImeKey(window, "ArrowRight");
        dispatchImeKey(window, "t");
        dispatchImeKey(window, "f", { ctrlKey: true });

        const afterMonth = document.getElementById("kal-month-label").textContent;
        const afterSelected = document.querySelector("#kal-grid .kal-cell.is-selected")?.dataset?.key || "";
        const searchStillHidden = document.getElementById("kal-search-popover").hidden === true;

        document.getElementById("kal-search-btn").click();
        window.__KAL_TEST__.clearCalls();
        const sInput = document.getElementById("kal-search-input");
        sInput.value = "合成中词条";
        sInput.dispatchEvent(new InputEvent("input", { isComposing: true, bubbles: true }));
        dispatchImeKey(sInput, "Escape");
        dispatchImeKey(sInput, "Enter");
        const searchOpenDuringIme = document.getElementById("kal-search-popover").hidden === false;
        const searchCallsDuringIme = window.__KAL_TEST__.getCalls("search_events").length;
        document.getElementById("kal-search-close").click();

        return {
          monthUnchanged: beforeMonth === afterMonth,
          selectedUnchanged: beforeSelected === afterSelected,
          searchStillHidden,
          searchOpenDuringIme,
          searchCallsDuringIme,
        };
      })()`);

      const ok =
        imeCheck.monthUnchanged &&
        imeCheck.selectedUnchanged &&
        imeCheck.searchStillHidden &&
        imeCheck.searchOpenDuringIme &&
        imeCheck.searchCallsDuringIme === 0;
      record(
        8,
        "合成事件守卫不触发快捷键与误搜（非原生IME）",
        ok,
        `monthUnchanged=${imeCheck.monthUnchanged}, searchHidden=${imeCheck.searchStillHidden}, imeSearchCalls=${imeCheck.searchCallsDuringIme}`,
      );
    } catch (err) {
      record(8, "合成事件守卫不触发快捷键与误搜（非原生IME）", false, err.message);
    }

    // =========================================================================
    // 测试 9：写失败保留输入、不自动重试（且错误提示与日志脱敏）
    // =========================================================================
    try {
      await cdp.evaluate(`(() => {
        window.__KAL_TEST__.clearCalls();
        window.__KAL_TEST__.setFailNextWrite("写入服务拒绝 sys_aimcp_token=super_secret_token_val_123456");
        const input = document.getElementById("kal-agenda-input");
        const form = document.getElementById("kal-agenda-add");
        input.value = "写失败需保留的安排";
        form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      })()`);

      const failState = await cdp.waitFor(
        `(() => {
          const statusEl = document.getElementById("kal-write-status");
          const input = document.getElementById("kal-agenda-input");
          if (!statusEl.classList.contains("is-error") || input.disabled) return null;
          return {
            preservedValue: input.value,
            statusText: statusEl.textContent || "",
            createCalls: window.__KAL_TEST__.getCalls("item_create").length,
          };
        })()`,
        "测试9: 写失败后显示错误并恢复输入框可用",
      );

      await sleep(180);
      const createCallsAfterWait = await cdp.evaluate(
        `window.__KAL_TEST__.getCalls("item_create").length`,
      );

      const ok =
        failState.preservedValue === "写失败需保留的安排" &&
        failState.createCalls === 1 &&
        createCallsAfterWait === 1 &&
        !failState.statusText.includes("super_secret_token_val_123456");
      record(
        9,
        "写失败保留输入、不自动重试且脱敏",
        ok,
        `input="${failState.preservedValue}", calls=${createCallsAfterWait}, status="${failState.statusText}"`,
      );
    } catch (err) {
      record(9, "写失败保留输入、不自动重试且脱敏", false, err.message);
    }

    // =========================================================================
    // 测试 10：只读状态禁新增但仍能搜索/设置（模拟 writeStatus.available false）
    // =========================================================================
    try {
      await cdp.evaluate(`(() => {
        window.__KAL_TEST__.clearCalls();
        window.__KAL_TEST__.setWriteStatusOverride({
          available: false,
          canCreate: false,
          canCreateEvent: false,
          label: "当前日历处于只读模式",
        });
        document.getElementById("kal-refresh").click();
      })()`);

      const roState = await cdp.waitFor(
        `(() => {
          const input = document.getElementById("kal-agenda-input");
          const btn = document.querySelector("#kal-agenda-add button[type='submit']");
          const dots = Array.from(document.querySelectorAll("#kal-agenda-list .kal-agenda-dot"));
          if (!input.disabled || !btn.disabled || !dots.length) return null;
          return {
            inputDisabled: input.disabled,
            btnDisabled: btn.disabled,
            placeholder: input.placeholder,
            allDotsReadonly: dots.every(d => d.classList.contains("is-readonly") && !d.classList.contains("is-toggleable")),
            deleteBtnCount: document.querySelectorAll("#kal-agenda-list .kal-agenda-action").length,
          };
        })()`,
        "测试10: 只读状态下禁用输入与单项写操作控件",
      );

      await cdp.evaluate(`(() => {
        document.getElementById("kal-search-btn").click();
        const sInput = document.getElementById("kal-search-input");
        sInput.value = "晨会";
        sInput.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);

      const roSearchAndSettings = await cdp.waitFor(
        `(() => {
          const hits = document.querySelectorAll("#kal-search-list .kal-search-item").length;
          if (hits < 1) return null;
          document.getElementById("kal-search-close").click();
          document.getElementById("kal-settings").click();
          const panelOpen = document.body.classList.contains("kal-panel-open");
          document.querySelector(".kal-panel [data-act='close']")?.click();
          return { hits, panelOpen };
        })()`,
        "测试10: 只读状态下搜索与打开设置面板正常",
      );

      const ok =
        roState.inputDisabled === true &&
        roState.btnDisabled === true &&
        roState.allDotsReadonly === true &&
        roState.deleteBtnCount === 0 &&
        roSearchAndSettings.hits >= 1 &&
        roSearchAndSettings.panelOpen === true;
      record(
        10,
        "只读状态禁新增但仍能搜索/设置",
        ok,
        `inputDisabled=${roState.inputDisabled}, dotsReadonly=${roState.allDotsReadonly}, searchHits=${roSearchAndSettings.hits}, settingsOpen=${roSearchAndSettings.panelOpen}`,
      );
    } catch (err) {
      record(10, "只读状态禁新增但仍能搜索/设置", false, err.message);
    }

    // =========================================================================
    // 测试 11：模拟 read failure 仍可开设置且不伪装 Mock
    // =========================================================================
    try {
      await cdp.evaluate(`(() => {
        window.__KAL_TEST__.clearCalls();
        window.__KAL_TEST__.setReadFailure("模拟数据库读取失败");
        document.getElementById("kal-refresh").click();
      })()`);

      const rfState = await cdp.waitFor(
        `(() => {
          const emptyLi = document.querySelector("#kal-agenda-list li.is-empty");
          const statusEl = document.getElementById("kal-write-status");
          if (!emptyLi || !emptyLi.textContent.includes("暂时无法读取日历数据")) return null;
          document.getElementById("kal-settings").click();
          const panelOpen = document.body.classList.contains("kal-panel-open");
          const isDebugBg = document.body.classList.contains("kal-debug-bg");
          const sourceTag = document.getElementById("kal-source-tag")?.textContent || "";
          const gridTaskCount = document.querySelectorAll("#kal-grid .kal-task").length;
          return {
            emptyText: emptyLi.textContent,
            statusError: statusEl.classList.contains("is-error"),
            statusText: statusEl.textContent || "",
            panelOpen,
            isDebugBg,
            sourceTag,
            gridTaskCount,
          };
        })()`,
        "测试11: 读取失败提示明确、不回落 Mock 且可打开设置",
      );

      const ok =
        rfState.statusError === true &&
        rfState.panelOpen === true &&
        rfState.isDebugBg === false &&
        rfState.sourceTag !== "演示数据" &&
        rfState.gridTaskCount === 0;
      record(
        11,
        "模拟read failure仍可开设置且不伪装Mock",
        ok,
        `statusError=${rfState.statusError}, gridTasks=${rfState.gridTaskCount}, sourceTag="${rfState.sourceTag}", settingsOpen=${rfState.panelOpen}`,
      );
    } catch (err) {
      record(11, "模拟read failure仍可开设置且不伪装Mock", false, err.message);
    }

    // 本机工具在宿主只读/读取失败时仍可独立工作。
    try {
      await cdp.evaluate(`(() => {
        document.querySelector(".kal-panel [data-act='close']")?.click();
        const input = document.getElementById("kal-countdown-title");
        input.closest(".kal-countdown-editor").open = true;
        input.value = "界面验收倒计时";
        document.getElementById("kal-countdown-date").value = "2026-12-31";
        document.getElementById("kal-countdown-form").requestSubmit();
      })()`);
      await cdp.waitFor(`document.querySelector(".kal-countdown-title")?.textContent === "界面验收倒计时"`, "倒计时保存后出现卡片");
      await cdp.evaluate(`document.getElementById("kal-refresh").click()`);
      const persisted = await cdp.waitFor(`(() => {
        const card = document.querySelector(".kal-countdown-card");
        const calls = window.__KAL_TEST__.getCalls("settings_set");
        if (!card || !calls.length) return null;
        return { title: card.querySelector(".kal-countdown-title").textContent,
          local: calls.some(c => c.args?.patch?.productivity?.countdowns?.length === 1),
          readonly: document.getElementById("kal-agenda-input").disabled };
      })()`, "刷新后本机倒计时仍存在");
      record(12, "只读模式本机倒计时保存与重载", persisted.title === "界面验收倒计时" && persisted.local && persisted.readonly, JSON.stringify(persisted));
    } catch (err) { record(12, "只读模式本机倒计时保存与重载", false, err.message); }

    try {
      await cdp.evaluate(`(() => {
        window.__KAL_TEST__.failNextSettings();
        document.querySelector(".kal-countdown-remove").click();
      })()`);
      const failed = await cdp.waitFor(`document.getElementById("kal-productivity-status").textContent.includes("保存失败")`, "删除保存失败显示错误");
      const retained = await cdp.evaluate(`document.querySelectorAll(".kal-countdown-card").length === 1`);
      await cdp.evaluate(`document.querySelector(".kal-countdown-remove").click()`);
      await cdp.waitFor(`document.querySelectorAll(".kal-countdown-card").length === 0`, "再次删除成功后移除卡片");
      record(13, "倒计时写失败保留原卡片并可重试", failed && retained, "失败保留，成功删除");
    } catch (err) { record(13, "倒计时写失败保留原卡片并可重试", false, err.message); }

    try {
      await cdp.evaluate(`(() => { window.__KAL_TEST__.clearCalls(); document.getElementById("kal-notes").open = true; })()`);
      await cdp.waitFor(`document.querySelector(".kal-note-entry") !== null`, "跨日期便签出现在列表");
      const lazy = await cdp.evaluate(`window.__KAL_TEST__.getCalls("note_get").length === 0`);
      await cdp.evaluate(`document.querySelector(".kal-note-entry").open = true`);
      const detail = await cdp.waitFor(`(() => {
        const body = document.querySelector(".kal-note-content");
        if (!body?.textContent.includes("<img")) return null;
        return { title: document.querySelector(".kal-note-title").textContent,
          safe: !body.querySelector("img"), text: body.textContent,
          calls: window.__KAL_TEST__.getCalls("note_get").length };
      })()`, "便签展开读取并安全显示正文");
      record(14, "便签跨日期发现、按需读取与正文转义", lazy && detail.safe && detail.calls === 1 && detail.title === "跨日期便签", JSON.stringify(detail));
    } catch (err) { record(14, "便签跨日期发现、按需读取与正文转义", false, err.message); }

    try {
      await cdp.evaluate(`(() => {
        document.getElementById("kal-settings").click();
        document.querySelector(".kal-desktop-settings").open = true;
        window.__KAL_TEST__.setDesktopConflict(true);
        document.getElementById("kal-global-hotkey").click();
      })()`);
      const conflict = await cdp.waitFor(`document.querySelector(".kal-desktop-settings [role=status]").textContent.includes("占用")`, "热键冲突提示可见");
      await cdp.evaluate(`(() => { window.__KAL_TEST__.setDesktopConflict(false); document.querySelector(".kal-desktop-settings button").click(); })()`);
      const registered = await cdp.waitFor(`document.querySelector(".kal-desktop-settings [role=status]").textContent.includes("已启用")`, "热键重试成功");
      await cdp.evaluate(`document.getElementById("kal-global-hotkey").click()`);
      const disabled = await cdp.waitFor(`!document.getElementById("kal-global-hotkey").checked && document.querySelector(".kal-desktop-settings [role=status]").textContent.includes("未启用")`, "热键可关闭");
      record(15, "热键显式开关、冲突提示与重试", conflict && registered && disabled, "冲突/重试/关闭均正确");
    } catch (err) { record(15, "热键显式开关、冲突提示与重试", false, err.message); }

    // P0 regression: real CDP input and coordinate clicks; synthetic IME checks are labelled separately.
    try {
      await cdp.evaluate(`(() => {window.__KAL_TEST__.setWriteStatusOverride(null);window.__KAL_TEST__.setReadFailure(null);document.querySelector(".kal-panel [data-act=close]")?.click();document.getElementById("kal-refresh").click();})()`);
      await cdp.waitFor(`!document.getElementById("kal-agenda-input").disabled`, "恢复可写模拟状态");
      const keys = await cdp.evaluate(`Array.from(document.querySelectorAll(".kal-cell")).slice(10,12).map(c=>c.dataset.key)`);
      await cdp.evaluate(`document.querySelector('[data-key="${keys[0]}"]').click()`);
      await cdp.waitFor(`document.getElementById("kal-agenda-input").getAttribute("aria-label").includes("${keys[0]}")`, "切换草稿日期A");
      await cdp.evaluate(`document.getElementById("kal-agenda-input").focus()`);
      await cdp.send("Input.insertText", {text:"日期A草稿"});
      await cdp.evaluate(`document.querySelector('[data-key="${keys[1]}"]').click()`);
      await cdp.waitFor(`document.getElementById("kal-agenda-input").value === ""`, "日期B独立空草稿");
      await cdp.evaluate(`document.getElementById("kal-agenda-input").focus()`);
      await cdp.send("Input.insertText", {text:"日期B草稿"});
      await cdp.evaluate(`document.querySelector('[data-key="${keys[0]}"]').click()`);
      await cdp.waitFor(`document.getElementById("kal-agenda-input").value === "日期A草稿"`, "切回日期A恢复草稿");
      record("P0-days", "切日保留各自内存草稿", true, "CDP Input.insertText");
    } catch (err) { record("P0-days", "切日保留各自内存草稿", false, err.message); }

    try {
      const dates=await cdp.evaluate(`(()=>{const a=document.querySelector(".kal-cell.is-selected").dataset.key;const b=Array.from(document.querySelectorAll(".kal-cell")).map(n=>n.dataset.key).find(k=>k>a);return {a,b};})()`);
      await cdp.evaluate(`(()=>{window.__KAL_TEST__.clearCalls();window.__KAL_TEST__.setRequireConfirm(false);window.__KAL_TEST__.setWriteDelay(100);window.__KAL_TEST__.setReadDelay(150);const i=document.getElementById("kal-agenda-input");i.value="跨日提交A";i.dispatchEvent(new Event("input",{bubbles:true}));document.getElementById("kal-agenda-add").requestSubmit();document.querySelector('[data-key="${dates.b}"]').click();})()`);
      await cdp.waitFor(`!document.getElementById("kal-agenda-input").disabled`, "旧提交完成写入可继续输入");
      await cdp.evaluate(`(()=>{const i=document.getElementById("kal-agenda-input");i.value="日期B后来草稿";i.dispatchEvent(new Event("input",{bubbles:true}));i.focus();})()`);
      await cdp.send("Input.insertText",{text:"继续"});
      await cdp.waitFor(`Array.from(document.querySelectorAll(".kal-cell .kal-task")).some(n=>n.textContent==="跨日提交A")`, "旧提交刷新完成");
      const returned=await cdp.evaluate(`({value:document.getElementById("kal-agenda-input").value,selected:document.querySelector(".kal-cell.is-selected").dataset.key,date:window.__KAL_TEST__.getCalls("item_create")[0].args.date})`);
      record("P0-old-date", "旧提交按来源日期落入且不覆盖新日期草稿", returned.selected===dates.b && returned.date===dates.a && returned.value.includes("日期B后来草稿") && returned.value.includes("继续"), JSON.stringify(returned));
      await cdp.evaluate(`(()=>{window.__KAL_TEST__.setRequireConfirm(true);window.__KAL_TEST__.setWriteDelay(0);window.__KAL_TEST__.setReadDelay(0);})()`);
    } catch(err){record("P0-old-date","旧提交跨日草稿隔离",false,err.message);}

    try {
      const key = await cdp.evaluate(`document.querySelector(".kal-cell.is-selected").dataset.key`);
      await cdp.evaluate(`(async()=>{await window.__KAL_TEST__.seedDirectItem("${key}","编辑草稿验收");document.getElementById("kal-refresh").click();})()`);
      await cdp.waitFor(`Array.from(document.querySelectorAll(".kal-agenda-text")).some(n=>n.textContent==="编辑草稿验收")`, "编辑测试项就绪");
      await cdp.evaluate(`(()=>{window.__KAL_TEST__.clearCalls();const t=Array.from(document.querySelectorAll(".kal-agenda-text")).find(n=>n.textContent==="编辑草稿验收");t.focus();})()`);
      await cdp.send("Input.dispatchKeyEvent", {type:"keyDown",key:"F2",code:"F2",windowsVirtualKeyCode:113});
      await cdp.send("Input.dispatchKeyEvent", {type:"keyUp",key:"F2",code:"F2",windowsVirtualKeyCode:113});
      await cdp.send("Input.insertText", {text:"未提交编辑草稿"});
      await cdp.send("Input.dispatchKeyEvent", {type:"keyDown",key:"f",code:"KeyF",modifiers:2,windowsVirtualKeyCode:70});
      await cdp.send("Input.dispatchKeyEvent", {type:"keyUp",key:"f",code:"KeyF",modifiers:2,windowsVirtualKeyCode:70});
      await cdp.waitFor(`!document.getElementById("kal-search-popover").hidden`, "Ctrl+F打开全日期搜索");
      await cdp.send("Input.dispatchKeyEvent", {type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
      await cdp.send("Input.dispatchKeyEvent", {type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
      const focus = await cdp.evaluate(`({text:document.activeElement.value,edit:document.activeElement.classList.contains("kal-agenda-edit"),writes:window.__KAL_TEST__.getCalls("item_update").length})`);
      await cdp.evaluate(`document.getElementById("kal-refresh").click()`);
      await cdp.waitFor(`document.querySelector(".kal-agenda-edit")?.value==="未提交编辑草稿"`, "刷新恢复内联草稿");
      record("P0-edit", "键盘编辑/Ctrl+F恢复焦点/blur与刷新保留草稿", focus.edit && focus.text==="未提交编辑草稿" && focus.writes===0, JSON.stringify(focus));
      await cdp.evaluate(`(()=>{const i=document.querySelector(".kal-agenda-edit");i.focus();i.value="";i.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));document.getElementById("kal-search-btn").focus();})()`);
      const validation = await cdp.evaluate(`document.activeElement.id==="kal-search-btn" && document.querySelector(".kal-agenda-edit").getAttribute("aria-invalid")==="true" && window.__KAL_TEST__.getCalls("item_update").length===0`);
      record("P0-invalid", "空内容校验不抢焦点", validation);
      await cdp.evaluate(`document.querySelector(".kal-agenda-edit-actions button:last-child").click()`);
    } catch (err) { record("P0-edit", "编辑草稿与焦点", false, err.message); }

    try {
      const guarded = await cdp.evaluate(`(() => {
        window.__KAL_TEST__.clearCalls();
        const quick=document.getElementById("kal-agenda-input");
        quick.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true}));
        quick.value="合成中的任务";
        document.getElementById("kal-agenda-add").dispatchEvent(new SubmitEvent("submit",{bubbles:true,cancelable:true}));
        quick.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true}));
        const text=Array.from(document.querySelectorAll(".kal-agenda-text")).find(n=>n.textContent==="编辑草稿验收");
        text.dispatchEvent(new MouseEvent("dblclick",{bubbles:true}));
        const edit=document.querySelector(".kal-agenda-edit");
        edit.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true}));edit.value="合成编辑";
        edit.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));
        edit.dispatchEvent(new FocusEvent("blur"));
        edit.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));
        const retained=Boolean(edit.isConnected);
        edit.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true}));
        edit.dispatchEvent(new KeyboardEvent("keyup",{key:"Enter",bubbles:true}));
        document.querySelector(".kal-agenda-edit-actions button:last-child").click();
        const countdown=document.getElementById("kal-countdown-title");countdown.value="合成倒计时";
        countdown.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true}));
        document.getElementById("kal-countdown-form").dispatchEvent(new SubmitEvent("submit",{bubbles:true,cancelable:true}));
        countdown.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true}));
        return {retained,creates:window.__KAL_TEST__.getCalls("item_create").length,updates:window.__KAL_TEST__.getCalls("item_update").length,settings:window.__KAL_TEST__.getCalls("settings_set").length};
      })()`);
      record("P0-composition", "合成事件守卫：新增/内联/倒计时（非Windows原生IME）", guarded.retained && !guarded.creates && !guarded.updates && !guarded.settings, JSON.stringify(guarded));
    } catch (err) { record("P0-composition", "合成事件守卫", false, err.message); }

    try {
      const rect = await cdp.evaluate(`(()=>{const b=document.querySelector("button.kal-agenda-dot");b.scrollIntoView({block:"center"});const r=b.getBoundingClientRect();const t=b.parentElement.querySelector(".kal-agenda-text").getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,overlap:r.right>t.left,tag:b.tagName,pressed:b.getAttribute("aria-pressed")};})()`);
      let hits=true;
      for (const [dx,dy] of [[rect.w/2,rect.h/2],[1,rect.h/2],[rect.w-1,rect.h/2],[rect.w/2,1],[rect.w/2,rect.h-1]]) {
        const hit=await cdp.evaluate(`document.elementFromPoint(${rect.x+dx},${rect.y+dy})?.matches("button.kal-agenda-dot")`);hits &&= hit;
      }
      await cdp.evaluate(`window.__KAL_TEST__.clearCalls()`);
      await cdp.send("Input.dispatchMouseEvent",{type:"mousePressed",x:rect.x+1,y:rect.y+rect.h/2,button:"left",clickCount:1});
      await cdp.send("Input.dispatchMouseEvent",{type:"mouseReleased",x:rect.x+1,y:rect.y+rect.h/2,button:"left",clickCount:1});
      await cdp.waitFor(`window.__KAL_TEST__.getCalls("item_toggle_done").length===1`, "实际坐标热区边缘只触发一次完成");
      record("P0-target", "完成按钮28px热区/五点命中/坐标边缘点击", hits && rect.w>=28 && rect.h>=28 && !rect.overlap && rect.tag==="BUTTON" && ["true","false"].includes(rect.pressed), JSON.stringify(rect));
      await cdp.waitFor(`!document.getElementById("kal-pending-box").hidden`, "待确认");
      await cdp.evaluate(`document.querySelector("#kal-pending-box .kal-pending-btn:not(.is-confirm)").click()`);
    } catch (err) { record("P0-target", "实际坐标热区", false, err.message); }

    try {
      await cdp.evaluate(`(()=>{document.getElementById("kal-settings").click();window.__KAL_TEST__.clearCalls();})()`);
      await cdp.waitFor(`document.querySelectorAll('.kal-theme-card[data-builtin="true"]').length===6`, "五套内置与默认色卡");
      const before=await cdp.evaluate(`(()=>{const s=getComputedStyle(document.documentElement);return {bg:s.getPropertyValue("--kal-bg"),font:s.getPropertyValue("--kal-font-family"),width:s.getPropertyValue("--kal-font-stretch"),scale:s.getPropertyValue("--kal-ui-scale")};})()`);
      await cdp.evaluate(`document.querySelector('[data-theme-id="builtin-starport-paper"]').click()`);
      await cdp.waitFor(`getComputedStyle(document.documentElement).getPropertyValue("--kal-bg").trim()==="251 246 236"`, "浅色卡预览");
      const preview=await cdp.evaluate(`(()=>{const s=getComputedStyle(document.documentElement);return {font:s.getPropertyValue("--kal-font-family"),width:s.getPropertyValue("--kal-font-stretch"),scale:s.getPropertyValue("--kal-ui-scale"),commits:window.__KAL_TEST__.getCalls("theme_commit").length,activates:window.__KAL_TEST__.getCalls("theme_activate").length};})()`);
      await cdp.evaluate(`document.querySelector('.kal-panel [data-act="close"]').click()`);
      const restored=await cdp.evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--kal-bg")`);
      record("P1-preview", "五套色卡只预览/保留排版缩放/关闭恢复快照", preview.font===before.font && preview.width===before.width && preview.scale===before.scale && !preview.commits && !preview.activates && restored===before.bg, JSON.stringify(preview));

      await cdp.evaluate(`document.getElementById("kal-settings").click()`);
      await cdp.waitFor(`document.querySelector('[data-theme-id="builtin-mocha"]')`, "主题面板重新打开");
      await cdp.evaluate(`(()=>{window.__KAL_TEST__.setThemeLoadDelay("builtin-starport-paper",180);document.querySelector('[data-theme-id="builtin-starport-paper"]').click();document.querySelector('[data-theme-id="builtin-deep-ocean"]').click();})()`);
      await cdp.waitFor(`getComputedStyle(document.documentElement).getPropertyValue("--kal-bg").trim()==="7 20 40"`, "后来选择优先");
      await new Promise(r=>setTimeout(r,230));
      const stale=await cdp.evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--kal-bg").trim()==="7 20 40"`);
      await cdp.evaluate(`(()=>{document.querySelector('[data-theme-id="builtin-starport-paper"]').click();document.querySelector('.kal-panel [data-act="close"]').click();})()`);
      await new Promise(r=>setTimeout(r,230));
      const closed=await cdp.evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--kal-bg")`);
      record("P1-stale", "过期载入不覆盖新选择或关闭快照", stale && closed===before.bg);

      await cdp.evaluate(`(()=>{window.__KAL_TEST__.setThemeLoadDelay("builtin-starport-paper",0);document.getElementById("kal-settings").click();})()`);
      await cdp.waitFor(`document.querySelector('[data-theme-id="builtin-mocha"]')`, "保存测试色卡");
      await cdp.evaluate(`document.querySelector('[data-theme-id="builtin-mocha"]').click()`);
      await cdp.waitFor(`getComputedStyle(document.documentElement).getPropertyValue("--kal-bg").trim()==="30 30 46"`, "摩卡预览");
      await cdp.evaluate(`(()=>{document.querySelector('[data-t="copy"]').click();window.__KAL_TEST__.failNextThemeCommit();document.querySelector('.kal-panel [data-act="save"]').click();})()`);
      await cdp.waitFor(`document.getElementById("kal-report").textContent.includes("保存失败")`, "模拟提交失败保留草稿");
      const failedDraft=await cdp.evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--kal-bg").trim()==="30 30 46"`);
      await cdp.evaluate(`document.querySelector('.kal-panel [data-act="save"]').click()`);
      await cdp.waitFor(`document.getElementById("kal-report").textContent.includes("已保存并应用")`, "单次事务成功");
      await cdp.evaluate(`document.querySelector('.kal-panel [data-act="close"]').click()`);
      const afterSave=await cdp.evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--kal-bg").trim()==="30 30 46"`);
      record("P1-save", "复制编辑/失败保留草稿/保存后关闭保留新快照", failedDraft && afterSave);

      await cdp.evaluate(`document.getElementById("kal-settings").click()`);
      await cdp.waitFor(`document.querySelector('[data-theme-id="builtin-rose-dawn"]')`, "导出草稿预览");
      await cdp.evaluate(`document.querySelector('[data-theme-id="builtin-rose-dawn"]').click()`);
      await cdp.waitFor(`getComputedStyle(document.documentElement).getPropertyValue("--kal-bg").trim()==="250 244 237"`, "晨纸预览");
      await cdp.evaluate(`(()=>{window.__KAL_TEST__.clearCalls();window.__KAL_TEST__.setSavePath("isolated-draft.json");document.querySelector('[data-t="export"]').click();})()`);
      await cdp.waitFor(`window.__KAL_TEST__.getCalls("theme_export_draft").length===1`, "导出草稿IPC");
      const exported=await cdp.evaluate(`({calls:window.__KAL_TEST__.getCalls().map(c=>c.cmd),theme:window.__KAL_TEST__.getCalls("theme_export_draft")[0].args.theme})`);
      await cdp.evaluate(`document.querySelector('.kal-panel [data-act="close"]').click()`);
      const noActivation=await cdp.evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--kal-bg").trim()==="30 30 46"`);
      record("P1-export", "导出当前草稿不隐式保存激活", exported.calls.includes("theme_export_draft") && !exported.calls.some(c=>["theme_save","theme_activate","theme_commit"].includes(c)) && exported.theme.color.bg==="#FAF4ED" && noActivation);
    } catch (err) { record("P1-themes", "主题预览与事务", false, err.message); }

    try {
      const report=await cdp.evaluate(`(async()=>{
        const {applyTheme}=await import("/src/theme.js");
        const {createBridge}=await import("/src/bridge.js");const bridge=await createBridge();const original=await bridge.themeActive();
        const themes=(await bridge.themeList()).filter(t=>t.builtin&&t.id.startsWith("builtin-"));
        const probe=document.createElement("div");probe.className="kal-agenda-list";
        probe.innerHTML='<li class="is-done"><span class="kal-agenda-text">已完成</span></li><div class="kal-write-status is-error">错误</div><div class="kal-cell is-selected">选中</div><button class="kal-agenda-confirm-btn is-danger">删除</button>';
        probe.querySelectorAll("*").forEach(n=>{n.style.transition="none";});
        document.body.append(probe);const rows=[];
        const triplet=hex=>hex.slice(1).match(/../g).map(s=>parseInt(s,16)).join(", ");
        for(const row of themes){const t=await bridge.themeLoad(row.id);applyTheme(t);const text=getComputedStyle(probe.querySelector(".kal-agenda-text"));const error=getComputedStyle(probe.querySelector(".is-error"));const selected=getComputedStyle(probe.querySelector(".is-selected"));const danger=getComputedStyle(probe.querySelector("button"));
          rows.push({id:t.id,valid:text.color==='rgb('+triplet(t.color.done)+')'&&text.textDecorationLine.includes("line-through")&&getComputedStyle(probe.querySelector("li")).opacity==="1"&&error.color==='rgb('+triplet(t.color.danger)+')'&&selected.backgroundColor==='rgb('+triplet(t.color.selectedBg)+')'&&danger.color==='rgb('+triplet(t.color.dangerFg)+')'});
        }
        applyTheme(original);probe.remove();return rows;
      })()`);
      record("P1-roles", "五套配色的完成/错误/选中/危险状态实际CSS消费", report.length===5&&report.every(r=>r.valid), JSON.stringify(report));
    }catch(err){record("P1-roles","语义状态CSS消费",false,err.message);}

    try {
      const current=await cdp.evaluate(`document.querySelector(".kal-cell.is-selected").dataset.key`);
      await cdp.evaluate(`(()=>{window.__KAL_TEST__.clearCalls();document.querySelector('[data-key="${current}"]').click();})()`);
      await cdp.waitFor(`window.__KAL_TEST__.getCalls("day_events").length===1`, "同月选日单独day读取");
      const calls=await cdp.evaluate(`window.__KAL_TEST__.getCalls().map(c=>c.cmd)`);
      record("P2-day", "同月选日即时反馈且day读取新鲜数据", !calls.includes("range_events")&&!calls.includes("month_events")&&calls.includes("day_events"), JSON.stringify(calls));
    }catch(err){record("P2-day","同月day读取",false,err.message);}

    try {
      const dates=await cdp.evaluate(`Array.from(document.querySelectorAll(".kal-cell:not(.is-other-month)")).slice(10,12).map(n=>n.dataset.key)`);
      await cdp.evaluate(`(async()=>{await window.__KAL_TEST__.seedDirectItem("${dates[0]}","较早日迟到结果");await window.__KAL_TEST__.seedDirectItem("${dates[1]}","当前日新鲜结果");window.__KAL_TEST__.clearCalls();window.__KAL_TEST__.setDayDelay("${dates[0]}",180);document.querySelector('[data-key="${dates[0]}"]').click();document.querySelector('[data-key="${dates[1]}"]').click();})()`);
      const immediate=await cdp.evaluate(`document.querySelector(".kal-cell.is-selected").dataset.key==="${dates[1]}"`);
      await cdp.waitFor(`Array.from(document.querySelectorAll(".kal-agenda-text")).some(n=>n.textContent==="当前日新鲜结果")`, "当前日立即显示新鲜查询");
      await cdp.waitFor(`window.__KAL_TEST__.dayActivity()===0`, "旧日延迟查询结束");
      const final=await cdp.evaluate(`({selected:document.querySelector(".kal-cell.is-selected").dataset.key,titles:Array.from(document.querySelectorAll(".kal-agenda-text")).map(n=>n.textContent),ranges:window.__KAL_TEST__.getCalls("range_events").length})`);
      record("P2-day-stale", "切日即时选中/旧日返回不覆盖当前日", immediate&&final.selected===dates[1]&&final.titles.includes("当前日新鲜结果")&&!final.titles.includes("较早日迟到结果")&&final.ranges===0, JSON.stringify(final));
    }catch(err){record("P2-day-stale","迟到day响应守卫",false,err.message);}

    try {
      await cdp.evaluate(`(()=>{window.__KAL_TEST__.clearCalls();window.__KAL_TEST__.setSearchDelay(450);document.getElementById("kal-search-btn").click();const i=document.getElementById("kal-search-input");i.value="晨会";i.dispatchEvent(new Event("input",{bubbles:true}));})()`);
      await cdp.waitFor(`window.__KAL_TEST__.getCalls("search_events").some(c=>c.args.query==="晨会")`, "首个搜索请求在飞");
      await cdp.evaluate(`(()=>{const i=document.getElementById("kal-search-input");i.value="GPU";i.dispatchEvent(new Event("input",{bubbles:true}));})()`);
      await new Promise(resolve=>setTimeout(resolve,140));
      await cdp.evaluate(`(()=>{const i=document.getElementById("kal-search-input");i.value="倒计时卡片";i.dispatchEvent(new Event("input",{bubbles:true}));})()`);
      await cdp.waitFor(`Array.from(document.querySelectorAll(".kal-search-item-title")).some(n=>n.textContent.includes("倒计时卡片"))`, "最终词等待前一个完成后执行");
      const bounded=await cdp.evaluate(`({queries:window.__KAL_TEST__.getCalls("search_events").map(c=>c.args.query),activity:window.__KAL_TEST__.searchActivity(),titles:Array.from(document.querySelectorAll(".kal-search-item-title")).map(n=>n.textContent)})`);
      record("P2-search-bound", "搜索110ms防抖/最多一个在飞/只执行最新等待词", bounded.activity.max===1&&JSON.stringify(bounded.queries)===JSON.stringify(["晨会","倒计时卡片"])&&bounded.titles.every(t=>t.includes("倒计时卡片")), JSON.stringify(bounded));

      await cdp.evaluate(`(()=>{window.__KAL_TEST__.clearCalls();const i=document.getElementById("kal-search-input");i.value="晨会";i.dispatchEvent(new Event("input",{bubbles:true}));})()`);
      await cdp.waitFor(`window.__KAL_TEST__.searchActivity().active===1`, "关闭前在飞请求");
      await cdp.evaluate(`(()=>{const i=document.getElementById("kal-search-input");i.value="不应执行关闭词";i.dispatchEvent(new Event("input",{bubbles:true}));document.getElementById("kal-search-close").click();})()`);
      await cdp.waitFor(`window.__KAL_TEST__.searchActivity().active===0`, "关闭后等待旧请求自然结束");
      const closed=await cdp.evaluate(`document.getElementById("kal-search-popover").hidden&&document.querySelectorAll(".kal-search-item").length===0&&window.__KAL_TEST__.getCalls("search_events").length===1`);
      await cdp.evaluate(`(()=>{document.getElementById("kal-search-btn").click();const i=document.getElementById("kal-search-input");i.value="晨会";i.dispatchEvent(new Event("input",{bubbles:true}));})()`);
      await cdp.waitFor(`window.__KAL_TEST__.searchActivity().active===1`, "清空前在飞请求");
      await cdp.evaluate(`(()=>{const i=document.getElementById("kal-search-input");i.value="";i.dispatchEvent(new Event("input",{bubbles:true}));})()`);
      await cdp.waitFor(`window.__KAL_TEST__.searchActivity().active===0`, "清空后旧请求结束");
      const empty=await cdp.evaluate(`document.querySelectorAll(".kal-search-item").length===0`);
      await cdp.evaluate(`(()=>{const i=document.getElementById("kal-search-input");i.value="合成前等待词";i.dispatchEvent(new Event("input",{bubbles:true}));i.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true}));})()`);
      await new Promise(resolve=>setTimeout(resolve,140));
      const composing=await cdp.evaluate(`window.__KAL_TEST__.searchActivity().active===0&&document.querySelectorAll(".kal-search-item").length===0&&!window.__KAL_TEST__.getCalls("search_events").some(c=>c.args.query==="合成前等待词")`);
      await cdp.evaluate(`(()=>{const i=document.getElementById("kal-search-input");i.value="";i.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true}));document.getElementById("kal-search-close").click();window.__KAL_TEST__.setSearchDelay(0);})()`);
      record("P2-search-cancel", "关闭/清空/合成开始撤销排队且旧响应不回显", closed&&empty&&composing, JSON.stringify({closed,empty,composing}));
    }catch(err){record("P2-search","有界搜索与取消",false,err.message);}

    try {
      const customRes = await cdp.evaluate(`(() => {
        const lunarYear = document.getElementById("kal-lunar-year")?.textContent || "";
        // 1. Test quick glass transparent toggle
        const glassBtn = document.getElementById("kal-quick-glass");
        glassBtn.click();
        const rootStyle = getComputedStyle(document.documentElement);
        const alphaTransparent = rootStyle.getPropertyValue("--kal-bg-alpha").trim();
        const shadowTransparent = rootStyle.getPropertyValue("--kal-text-shadow").trim();
        glassBtn.click();
        const alphaRestored = rootStyle.getPropertyValue("--kal-bg-alpha").trim();

        // 2. Test year-month quick jumper popover
        document.getElementById("kal-title-trigger").click();
        const ymOpen = document.getElementById("kal-ym-popover")?.hidden === false;
        const monthBtns = document.querySelectorAll("#kal-ym-popover .kal-ym-month");
        if (monthBtns.length === 12) monthBtns[4].click(); // 5月
        const ymClosedAfterPick = document.getElementById("kal-ym-popover")?.hidden === true;
        const monthLabelAfterPick = document.getElementById("kal-month-label")?.textContent || "";
        document.getElementById("kal-today").click();

        // 3. Test panel style recipes, artistic backdrop, and font presets
        document.getElementById("kal-settings").click();
        document.querySelector('[data-recipe-id="grid"]')?.click();
        const isGridTable = document.body.classList.contains("kal-grid-table");
        document.querySelector('[data-art-id="cyber-grid"]')?.click();
        const hasBackdrop = document.body.classList.contains("kal-has-backdrop");
        const artPreset = document.body.dataset.backdropPreset;
        document.querySelector('[data-font-preset="editorial-song"]')?.click();
        const serifFont = rootStyle.getPropertyValue("--kal-font-family").trim();
        document.querySelector('.kal-panel [data-act="close"]')?.click();

        return {
          lunarYear,
          alphaTransparent,
          hasTextShadow: shadowTransparent.includes("rgba"),
          alphaRestored,
          ymOpen,
          ymClosedAfterPick,
          monthLabelAfterPick,
          isGridTable,
          hasBackdrop,
          artPreset,
          isSerif: serifFont.includes("Source Han Serif") || serifFont.includes("SimSun"),
        };
      })()`);
      const ok =
        customRes.lunarYear.includes("年") &&
        customRes.alphaTransparent === "0" &&
        customRes.hasTextShadow === true &&
        customRes.alphaRestored === "1" &&
        customRes.ymOpen === true &&
        customRes.ymClosedAfterPick === true &&
        customRes.monthLabelAfterPick === "5 月" &&
        customRes.isGridTable === true &&
        customRes.hasBackdrop === true &&
        customRes.artPreset === "cyber-grid" &&
        customRes.isSerif === true;
      record("P2-custom-render", "全透明底切换/艺术壁纸画布/字体预设/线框模式/年月快跳", ok, JSON.stringify(customRes));
    } catch (err) {
      record("P2-custom-render", "全透明底切换/艺术壁纸画布/字体预设/线框模式/年月快跳", false, err.message);
    }

    // =========================================================================
    // [P3-essence] 法定节假日「休/班」角标、周次徽章、黄历宜忌、双击日格速记、一键防窥与编号列表
    // =========================================================================
    try {
      const essenceRes = await cdp.evaluate(`(() => {
        // 1. Check statutory holiday rest ("休") on 2026-10-01 and makeup workday ("班") on 2026-10-10
        const cellOct01 = document.querySelector('.kal-cell[data-key="2026-10-01"]');
        const cellOct10 = document.querySelector('.kal-cell[data-key="2026-10-10"]');
        const restBadge = cellOct01?.querySelector('.kal-cell-badge.is-rest')?.textContent?.trim() || "";
        const workBadge = cellOct10?.querySelector('.kal-cell-badge.is-work')?.textContent?.trim() || "";
        const isWorkMakeup = cellOct10?.classList.contains("is-work-makeup") === true;

        // 2. Check week number badge & Almanac Yi/Ji box
        const weekBadge = document.getElementById("kal-week-badge")?.textContent?.trim() || "";
        const yijiBox = document.querySelector("#kal-agenda-sub .kal-yiji-box");
        const hasYi = Boolean(yijiBox?.querySelector(".kal-yiji-pill.is-yi")?.textContent?.includes("宜"));
        const hasJi = Boolean(yijiBox?.querySelector(".kal-yiji-pill.is-ji")?.textContent?.includes("忌"));

        // 3. Double-click cell to select date and open direct in-cell editor + pulse
        cellOct01?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        const activeEl = document.activeElement;
        const inputFocused = Boolean(
          activeEl?.classList?.contains("kal-cell-inline-input") ||
          activeEl?.id === "kal-agenda-input"
        );
        const hasPulse = document.getElementById("kal-agenda-input")?.classList.contains("is-quick-pulse") === true;
        if (activeEl?.classList?.contains("kal-cell-inline-input")) {
          activeEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        }

        // 4. Privacy mask toggle
        const privBtn = document.getElementById("kal-privacy-btn");
        privBtn?.click();
        const privacyOn = document.body.classList.contains("kal-privacy-mode") && privBtn?.getAttribute("aria-pressed") === "true";
        privBtn?.click();
        const privacyOff = !document.body.classList.contains("kal-privacy-mode");

        // 5. Search filter chips exist
        const filterChips = Array.from(document.querySelectorAll("#kal-search-filters .kal-filter-chip")).map(b => b.dataset.filter);

        return {
          restBadge,
          workBadge,
          isWorkMakeup,
          weekBadge,
          hasYi,
          hasJi,
          inputFocused,
          hasPulse,
          privacyOn,
          privacyOff,
          filterChips,
        };
      })()`);
      const ok =
        essenceRes.restBadge === "休" &&
        essenceRes.workBadge === "班" &&
        essenceRes.isWorkMakeup === true &&
        essenceRes.weekBadge.startsWith("第 ") &&
        essenceRes.hasYi === true &&
        essenceRes.hasJi === true &&
        essenceRes.inputFocused === true &&
        essenceRes.hasPulse === true &&
        essenceRes.privacyOn === true &&
        essenceRes.privacyOff === true &&
        JSON.stringify(essenceRes.filterChips) === JSON.stringify(["all", "todo", "done"]);
      record("P3-essence", "休/班法定角标/周次徽章/黄历宜忌/双击日格速记/防窥遮罩/搜索完成态筛选", ok, JSON.stringify(essenceRes));
    } catch (err) {
      record("P3-essence", "休/班法定角标/周次徽章/黄历宜忌/双击日格速记/防窥遮罩/搜索完成态筛选", false, err.message);
    }

    // =========================================================================
    // [P4-elaya-opensource] Elaya 动效与图标系统、黄历纳音冲煞方位、周视图切换、ICS 导出与 holiday-cn 节假日配置
    // =========================================================================
    try {
      const p4Res = await cdp.evaluate(`(async () => {
        const rootStyle = getComputedStyle(document.documentElement);
        const easeOut = rootStyle.getPropertyValue("--kal-ease-out").trim();
        const nestedRadius = rootStyle.getPropertyValue("--kal-radius-nested").trim();
        const hasHeaderSvg = document.querySelectorAll(".kal-header svg.kal-icon-svg").length >= 5;

        // 1. Check 6tail/lunar-javascript inspired almanac detail line
        const detailText = document.querySelector("#kal-agenda-sub .kal-yiji-detail")?.textContent?.trim() || "";
        const hasAlmanacDetail = detailText.includes("冲") && detailText.includes("喜神") && detailText.includes("财神");

        // 2. Check Week View toggle (WeekToDo / DayPilot style)
        const viewBtn = document.getElementById("kal-view-toggle");
        viewBtn?.click();
        const isWeekView = document.body.classList.contains("kal-view-week") && viewBtn?.getAttribute("aria-pressed") === "true";
        const totalCells = document.querySelectorAll("#kal-grid .kal-cell").length;
        const currentWeekCells = document.querySelectorAll("#kal-grid .kal-cell.is-current-week").length;
        viewBtn?.click();
        const restoredMonthView = !document.body.classList.contains("kal-view-week");

        // 3. Check RFC 5545 iCalendar (.ics) export
        const icsBtn = document.getElementById("kal-agenda-ics");
        icsBtn?.click();
        await new Promise(r => setTimeout(r, 80));
        const icsOut = String(window.__KAL_LAST_ICS__ || "");
        const icsValid = icsOut.startsWith("BEGIN:VCALENDAR") && icsOut.includes("END:VCALENDAR");

        // 4. Check NateScarlet/holiday-cn customizer UI
        const sampleBtn = document.getElementById("kal-holiday-sample");
        const saveBtn = document.getElementById("kal-holiday-save");
        const resetBtn = document.getElementById("kal-holiday-reset");
        sampleBtn?.click();
        const sampleJson = document.getElementById("kal-holiday-json")?.value || "";
        saveBtn?.click();
        await new Promise(r => setTimeout(r, 80));
        const saveStatus = document.getElementById("kal-holiday-status")?.textContent || "";
        resetBtn?.click();
        await new Promise(r => setTimeout(r, 80));
        const resetStatus = document.getElementById("kal-holiday-status")?.textContent || "";

        return {
          hasMotionToken: easeOut.includes("cubic-bezier"),
          hasNestedRadius: nestedRadius.length > 0,
          hasHeaderSvg,
          hasAlmanacDetail,
          isWeekView,
          totalCells,
          currentWeekCells,
          restoredMonthView,
          icsValid,
          hasHolidaySample: sampleJson.includes("isOffDay"),
          holidaySaved: saveStatus.includes("已生效"),
          holidayReset: resetStatus.includes("已恢复内置"),
        };
      })()`);
      const ok =
        p4Res.hasMotionToken === true &&
        p4Res.hasNestedRadius === true &&
        p4Res.hasHeaderSvg === true &&
        p4Res.hasAlmanacDetail === true &&
        p4Res.isWeekView === true &&
        (p4Res.totalCells === 35 || p4Res.totalCells === 42) &&
        p4Res.currentWeekCells === 7 &&
        p4Res.restoredMonthView === true &&
        p4Res.icsValid === true &&
        p4Res.hasHolidaySample === true &&
        p4Res.holidaySaved === true &&
        p4Res.holidayReset === true;
      record("P4-elaya-opensource", "Elaya动效与SVG图标/黄历纳音冲煞吉神/周视图看板/ICS导出/holiday-cn配置", ok, JSON.stringify(p4Res));
    } catch (err) {
      record("P4-elaya-opensource", "Elaya动效与SVG图标/黄历纳音冲煞吉神/周视图看板/ICS导出/holiday-cn配置", false, err.message);
    }

    // ---------------------------------------------------------
    // P5: 星港素纸默认主题 / 日历内容自动换行与排版预设 / 横向满幅 PDF & Markdown 日历导出
    // ---------------------------------------------------------
    try {
      const p5Res = await cdp.evaluate(`(async () => {
        // Re-select builtin-starport-paper (since P1-save committed mocha earlier in the session)
        const paperThemeBtn = document.querySelector('[data-theme-id="builtin-starport-paper"]');
        paperThemeBtn?.click();
        await new Promise(r => setTimeout(r, 80));

        const rootStyle = getComputedStyle(document.documentElement);
        const bgToken = rootStyle.getPropertyValue("--kal-bg").trim();
        const isLightMode = document.body.classList.contains("kal-mode-light");

        // 1. Check default task auto-wrapping in calendar cells
        const firstTask = document.querySelector(".kal-task");
        const taskStyle = firstTask ? getComputedStyle(firstTask) : null;
        const defaultWrap = taskStyle ? taskStyle.whiteSpace : "";

        // 2. Test Content & Wrapping Presets in Settings Panel
        const clamp2Btn = document.querySelector('#kal-content-preset-grid [data-content-preset="clamp-2"]');
        const singleBtn = document.querySelector('#kal-content-preset-grid [data-content-preset="compact-single"]');
        const standardBtn = document.querySelector('#kal-content-preset-grid [data-content-preset="standard-wrap"]');
        clamp2Btn?.click();
        await new Promise(r => setTimeout(r, 60));
        const hasClamp2Class = document.body.classList.contains("kal-task-clamp2");
        singleBtn?.click();
        await new Promise(r => setTimeout(r, 60));
        const hasNowrapClass = document.body.classList.contains("kal-task-nowrap");
        standardBtn?.click();
        await new Promise(r => setTimeout(r, 60));
        const restoredAutoWrap = !document.body.classList.contains("kal-task-clamp2") && !document.body.classList.contains("kal-task-nowrap");

        // 3. Test Export Calendar Popover (.pdf landscape full-bleed & .md)
        const exportBtn = document.getElementById("kal-export-btn");
        exportBtn?.click();
        await new Promise(r => setTimeout(r, 60));
        const popOpen = !document.getElementById("kal-export-popover")?.hidden;
        const activeOrient = document.querySelector("#kal-export-orient .is-active")?.dataset.orient || "";
        const activePaper = document.querySelector("#kal-export-paper .is-active")?.dataset.paper || "";

        document.getElementById("kal-export-md")?.click();
        await new Promise(r => setTimeout(r, 80));
        const mdOut = String(window.__KAL_LAST_EXPORT_MD__ || "");
        const mdValid = mdOut.includes("## 一、月度日历网格") && mdOut.includes("| 周一 | 周二 |");

        document.getElementById("kal-export-pdf")?.click();
        await new Promise(r => setTimeout(r, 80));
        const htmlOut = String(window.__KAL_LAST_EXPORT_HTML__ || "");
        const pdfValid = htmlOut.includes("size: A4 landscape;") && htmlOut.includes("margin: 6mm;") && htmlOut.includes("width: 100vw;");

        document.getElementById("kal-export-close")?.click();
        await new Promise(r => setTimeout(r, 40));
        const popClosed = Boolean(document.getElementById("kal-export-popover")?.hidden);

        return {
          bgToken,
          isLightMode,
          defaultWrap,
          hasClamp2Class,
          hasNowrapClass,
          restoredAutoWrap,
          popOpen,
          activeOrient,
          activePaper,
          mdValid,
          pdfValid,
          popClosed,
        };
      })()`);
      const ok =
        p5Res.bgToken === "251 246 236" &&
        p5Res.isLightMode === true &&
        p5Res.defaultWrap === "pre-wrap" &&
        p5Res.hasClamp2Class === true &&
        p5Res.hasNowrapClass === true &&
        p5Res.restoredAutoWrap === true &&
        p5Res.popOpen === true &&
        p5Res.activeOrient === "landscape" &&
        p5Res.activePaper === "A4" &&
        p5Res.mdValid === true &&
        p5Res.pdfValid === true &&
        p5Res.popClosed === true;
      record("P5-paper-wrap-export", "星港素纸默认主题/日历内容自动换行与排版预设/A4横向满幅PDF与Markdown导出", ok, JSON.stringify(p5Res));
    } catch (err) {
      record("P5-paper-wrap-export", "星港素纸默认主题/日历内容自动换行与排版预设/A4横向满幅PDF与Markdown导出", false, err.message);
    }

    // ---------------------------------------------------------
    // P6: 2026 路线图全量升级（NLP 自然语言实时胶囊 / 单日底色标记 / 顺延改期与撤销 / 窗口锁定 / 便签 CRUD）
    // ---------------------------------------------------------
    try {
      const p6Res = await cdp.evaluate(`(async () => {
        window.__KAL_TEST__.setRequireConfirm(false);

        // 1. Test NLP Live Preview Pills in #kal-agenda-input
        const input = document.getElementById("kal-agenda-input");
        const preview = document.getElementById("kal-nlp-preview");
        input.value = "明天下午3点半 核心架构升级评审 !高 #架构";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise(r => setTimeout(r, 40));
        const nlpPreviewVisible = Boolean(preview && !preview.hidden);
        const nlpPillsText = preview ? preview.textContent : "";

        // Submit the NLP quick entry
        document.getElementById("kal-agenda-add").requestSubmit();
        await new Promise(r => setTimeout(r, 120));

        // 2. Test Single-Day Cell Background Highlight Color
        const emeraldDot = document.querySelector('#kal-cell-color-bar .kal-color-swatch-btn[data-color-id="emerald"]');
        emeraldDot?.click();
        await new Promise(r => setTimeout(r, 80));
        const selectedCell = document.querySelector("#kal-grid .kal-cell.is-selected");
        const hasCellHighlight = Boolean(selectedCell && selectedCell.dataset.bgcolor === "emerald");

        // 3. Test Postpone (+1天) and Undo button
        const postponeBtn = document.querySelector("#kal-agenda-list .kal-agenda-postpone");
        postponeBtn?.click();
        await new Promise(r => setTimeout(r, 120));
        const moveCalls = window.__KAL_TEST__.getCalls("item_move");
        const undoBtn = document.getElementById("kal-undo-btn");
        const undoEnabledAfterMove = Boolean(undoBtn && !undoBtn.hidden);

        // 4. Test Window Lock button toggle
        const lockBtn = document.getElementById("kal-lock-btn");
        lockBtn?.click();
        await new Promise(r => setTimeout(r, 60));
        const isLockedBody = document.body.classList.contains("kal-window-locked");
        lockBtn?.click();
        await new Promise(r => setTimeout(r, 60));
        const isUnlockedBody = !document.body.classList.contains("kal-window-locked");

        // 5. Test Notes CRUD in #kal-notes
        const notesDetails = document.getElementById("kal-notes");
        if (notesDetails && !notesDetails.open) {
          notesDetails.open = true;
          notesDetails.dispatchEvent(new Event("toggle"));
          await new Promise(r => setTimeout(r, 80));
        }
        const noteTitle = document.getElementById("kal-note-title-input");
        const noteBody = document.getElementById("kal-note-content-input");
        const noteForm = document.getElementById("kal-note-form");
        if (noteTitle && noteBody && noteForm) {
          noteTitle.value = "路线图测试便签";
          noteBody.value = "支持新建、保存与删除便签";
          noteForm.requestSubmit();
        }
        await new Promise(r => setTimeout(r, 100));
        const noteSaveCalls = window.__KAL_TEST__.getCalls("note_save");

        window.__KAL_TEST__.setRequireConfirm(true);
        return {
          nlpPreviewVisible,
          hasTimePill: nlpPillsText.includes("15:30"),
          hasPriorityPill: nlpPillsText.includes("高优"),
          hasTagPill: nlpPillsText.includes("#架构"),
          hasCellHighlight,
          moveCallCount: moveCalls.length,
          undoEnabledAfterMove,
          isLockedBody,
          isUnlockedBody,
          noteSaved: noteSaveCalls.length >= 1,
        };
      })()`);
      const ok =
        p6Res.nlpPreviewVisible === true &&
        p6Res.hasTimePill === true &&
        p6Res.hasPriorityPill === true &&
        p6Res.hasTagPill === true &&
        p6Res.hasCellHighlight === true &&
        p6Res.moveCallCount >= 1 &&
        p6Res.undoEnabledAfterMove === true &&
        p6Res.isLockedBody === true &&
        p6Res.isUnlockedBody === true &&
        p6Res.noteSaved === true;
      record("P6-roadmap-all", "NLP中文速记胶囊/单日底色高亮/一键顺延与撤销/窗口锁定/便签CRUD", ok, JSON.stringify(p6Res));
    } catch (err) {
      record("P6-roadmap-all", "NLP中文速记胶囊/单日底色高亮/一键顺延与撤销/窗口锁定/便签CRUD", false, err.message);
    }

    // =========================================================================
    // P7：默认无时间安排 + 可选手动时间面板 + 外观/语言/减少动画/强调色/操作日志历史
    // =========================================================================
    try {
      const p7Res = await cdp.evaluate(`(async () => {
        window.__KAL_TEST__.setRequireConfirm(false);
        window.__KAL_TEST__.clearCalls();

        // 1. Toggle manual time bar & add a timed arrangement manually
        const toggleBtn = document.getElementById("kal-time-toggle-btn");
        const metaBox = document.getElementById("kal-agenda-add-meta");
        const timeInput = document.getElementById("kal-agenda-time-input");
        const input = document.getElementById("kal-agenda-input");
        const form = document.getElementById("kal-agenda-add");
        toggleBtn.click();
        const metaOpened = !metaBox.hidden;
        timeInput.value = "14:30";
        timeInput.dispatchEvent(new Event("input", { bubbles: true }));
        input.value = "手动指定时间评审";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        form.requestSubmit();
        await new Promise(r => setTimeout(r, 120));
        const createCalls = window.__KAL_TEST__.getCalls("item_create");
        const manualTimeSaved = createCalls.some(c => c.args?.title === "手动指定时间评审" && c.args?.time === "14:30");
        const timeResetAfterSave = timeInput.value === "";

        // 2. Open Settings Workbench & test Language, Reduced Motion, Accent Swatch & Operation Logs
        document.getElementById("kal-settings").click();
        const langEnBtn = document.querySelector('#kal-lang-seg [data-lang="en"]');
        langEnBtn?.click();
        const langApplied = document.documentElement.lang === "en" && document.getElementById("kal-today")?.textContent === "Today";
        document.querySelector('#kal-lang-seg [data-lang="zh-CN"]')?.click();

        const motionToggle = document.getElementById("kal-reduced-motion-toggle");
        motionToggle?.click();
        const motionClassOn = document.body.classList.contains("kal-reduced-motion");
        motionToggle?.click();
        const motionClassOff = !document.body.classList.contains("kal-reduced-motion");

        const claySwatch = document.querySelector('#kal-accent-swatches [data-accent-id="claude-clay"]');
        claySwatch?.click();
        const accentPreviewed = getComputedStyle(document.documentElement).getPropertyValue("--kal-accent").trim() === "217 119 87";

        const logCount = document.querySelectorAll("#kal-log-list .kal-log-item").length;
        document.getElementById("kal-log-export")?.click();
        await new Promise(r => setTimeout(r, 60));
        const exportedLog = window.__KAL_LAST_LOG_EXPORT__ || "";

        document.querySelector('.kal-panel [data-act="close"]')?.click();
        window.__KAL_TEST__.setRequireConfirm(true);
        return {
          metaOpened,
          manualTimeSaved,
          timeResetAfterSave,
          langApplied,
          motionClassOn,
          motionClassOff,
          accentPreviewed,
          logCount,
          hasExportedLog: exportedLog.includes("手动指定时间评审") && exportedLog.includes("切换主题强调色"),
        };
      })()`);
      const ok =
        p7Res.metaOpened === true &&
        p7Res.manualTimeSaved === true &&
        p7Res.timeResetAfterSave === true &&
        p7Res.langApplied === true &&
        p7Res.motionClassOn === true &&
        p7Res.motionClassOff === true &&
        p7Res.accentPreviewed === true &&
        p7Res.logCount >= 3 &&
        p7Res.hasExportedLog === true;
      record("P7-composer-and-workbench", "无时间默认+手动时间栏+多语言/减少动画/强调色快选/操作日志与历史", ok, JSON.stringify(p7Res));
    } catch (err) {
      record("P7-composer-and-workbench", "无时间默认+手动时间栏+多语言/减少动画/强调色快选/操作日志与历史", false, err.message);
    }

    // =========================================================================
    // P8：左侧日历双击直接内联编辑 + 右侧列表直编 + v0.1.0 版本号与检查更新
    // =========================================================================
    try {
      const p8Res = await cdp.evaluate(`(async () => {
        window.__KAL_TEST__.setRequireConfirm(false);
        window.__KAL_TEST__.clearCalls();

        // 1. Verify v0.1.0 version badge in header and settings
        const headerVer = document.getElementById("kal-app-version")?.textContent?.trim() || "";
        const panelVer = document.getElementById("kal-panel-version")?.textContent?.trim() || "";

        // 2. Double-click a cell on the left calendar grid to open direct in-cell editor and save
        const cellOct15 = document.querySelector('.kal-cell[data-key="2026-10-15"]');
        cellOct15?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        const cellInput = cellOct15?.querySelector(".kal-cell-inline-input");
        const cellEditorOpened = Boolean(cellInput);
        if (cellInput) {
          cellInput.value = "左格双击直接添加事项";
          cellInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        }
        await new Promise(r => setTimeout(r, 120));

        // 3. Click right-side direct add trigger (#kal-agenda-inline-trigger) to add directly in list
        const rightTrigger = document.getElementById("kal-agenda-inline-trigger");
        rightTrigger?.click();
        const rightInlineInput = document.querySelector("#kal-agenda-list .kal-agenda-inline-new");
        const rightEditorOpened = Boolean(rightInlineInput);
        if (rightInlineInput) {
          rightInlineInput.value = "右侧列表直接添加事项";
          rightInlineInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        }
        await new Promise(r => setTimeout(r, 120));

        const createCalls = window.__KAL_TEST__.getCalls("item_create");
        const leftSaved = createCalls.some(c => c.args?.date === "2026-10-15" && c.args?.title === "左格双击直接添加事项" && c.args?.time === "");
        const rightSaved = createCalls.some(c => c.args?.date === "2026-10-15" && c.args?.title === "右侧列表直接添加事项" && c.args?.time === "");

        // 4. Open Settings & test Check for Updates (v0.1.0)
        document.getElementById("kal-settings")?.click();
        const checkBtn = document.getElementById("kal-check-update-btn");
        const changelogBtn = document.getElementById("kal-changelog-btn");
        changelogBtn?.click();
        const changelogOpened = !document.getElementById("kal-changelog-box")?.hidden;
        checkBtn?.click();
        await new Promise(r => setTimeout(r, 180));
        const updateStatus = document.getElementById("kal-update-status")?.textContent?.trim() || "";
        const lastCheck = window.__KAL_LAST_UPDATE_CHECK__ || null;
        document.querySelector('.kal-panel [data-act="close"]')?.click();

        window.__KAL_TEST__.setRequireConfirm(true);
        return {
          headerVer,
          panelVer,
          cellEditorOpened,
          rightEditorOpened,
          leftSaved,
          rightSaved,
          changelogOpened,
          updateUpToDate: Boolean(lastCheck?.upToDate && updateStatus.includes("v0.1.1")),
        };
      })()`);
      const ok =
        p8Res.headerVer === "v0.1.1" &&
        p8Res.panelVer === "v0.1.1" &&
        p8Res.cellEditorOpened === true &&
        p8Res.rightEditorOpened === true &&
        p8Res.leftSaved === true &&
        p8Res.rightSaved === true &&
        p8Res.changelogOpened === true &&
        p8Res.updateUpToDate === true;
      record("P8-direct-cell-edit-and-updater", "左格双击直编+右侧列表直编+v0.1.1版本标识与检查更新", ok, JSON.stringify(p8Res));
    } catch (err) {
      record("P8-direct-cell-edit-and-updater", "左格双击直编+右侧列表直编+v0.1.1版本标识与检查更新", false, err.message);
    }

    // =========================================================================
    // P9：纯净无多余占位提示 + 桌面左侧固定模式 + 居中模态设置弹窗 + 开机自启动
    // =========================================================================
    try {
      const p9Res = await cdp.evaluate(`(async () => {
        window.__KAL_TEST__.clearCalls();

        // 1. Verify cell inline input has NO noisy placeholder text (Image 1 fix)
        const cellOct20 = document.querySelector('.kal-cell[data-key="2026-10-20"]');
        cellOct20?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        const cellInput = cellOct20?.querySelector(".kal-cell-inline-input");
        const cellPlaceholder = cellInput ? cellInput.placeholder : "MISSING";
        if (cellInput) {
          cellInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        }

        // 2. Verify agenda input & inline trigger have concise text (Image 2 fix)
        const agendaPlaceholder = document.getElementById("kal-agenda-input")?.placeholder || "";
        const inlineTriggerText = document.getElementById("kal-agenda-inline-trigger")?.textContent?.trim() || "";

        // 3. Verify Centered Modal Settings Dialog & Autostart + Desktop Docking (Image 2 & Image 3 & Req 4)
        document.getElementById("kal-settings")?.click();
        const panelEl = document.querySelector(".kal-panel");
        const rect = panelEl?.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const isCenteredModal = Boolean(
          rect &&
          rect.width >= 500 &&
          Math.abs((rect.left + rect.right) / 2 - vw / 2) < 24 &&
          Math.abs((rect.top + rect.bottom) / 2 - vh / 2) < 24
        );

        // Advanced drawer collapsed by default so UI is clean
        const advDrawer = document.querySelector(".kal-advanced-drawer");
        const advCollapsedByDefault = Boolean(advDrawer && !advDrawer.open);

        // Toggle Autostart in Settings
        const autostartToggle = document.getElementById("kal-autostart-toggle");
        autostartToggle?.click();
        await new Promise(r => setTimeout(r, 60));
        const autostartCalls = window.__KAL_TEST__.getCalls("autostart_set");
        const autostartOn = autostartCalls.some(c => c.args?.enabled === true) && Boolean(autostartToggle?.checked);

        // Click Desktop Dock position preset card ("left-desktop")
        const leftDockCard = document.querySelector('.kal-dock-pos-card[data-dock-pos="left-desktop"]');
        leftDockCard?.click();
        await new Promise(r => setTimeout(r, 60));
        const dockCalls = window.__KAL_TEST__.getCalls("desktop_apply_dock");
        const dockedLeft = dockCalls.some(c => c.args?.opts?.docked === true && c.args?.opts?.position === "left-desktop") &&
          document.body.classList.contains("kal-window-locked");

        // Unlock back to default movable window
        document.getElementById("kal-dock-toggle")?.click();
        await new Promise(r => setTimeout(r, 60));
        const unlockedDefault = !document.body.classList.contains("kal-window-locked");

        document.querySelector('.kal-panel [data-act="close"]')?.click();
        return {
          cellPlaceholder,
          agendaPlaceholder,
          inlineTriggerText,
          isCenteredModal,
          advCollapsedByDefault,
          autostartOn,
          dockedLeft,
          unlockedDefault,
        };
      })()`);
      const ok =
        p9Res.cellPlaceholder === "" &&
        p9Res.agendaPlaceholder === "添加安排" &&
        p9Res.inlineTriggerText === "+ 添加安排" &&
        p9Res.isCenteredModal === true &&
        p9Res.advCollapsedByDefault === true &&
        p9Res.autostartOn === true &&
        p9Res.dockedLeft === true &&
        p9Res.unlockedDefault === true;
      record("P9-clean-ui-dock-modal-autostart", "无冗余提示/桌面左侧固定与多屏适配/居中设置弹窗与预设模板/开机自启动", ok, JSON.stringify(p9Res));
    } catch (err) {
      record("P9-clean-ui-dock-modal-autostart", "无冗余提示/桌面左侧固定与多屏适配/居中设置弹窗与预设模板/开机自启动", false, err.message);
    }

    // =========================================================================
    // [P10-ux-and-visual-polish] 双栏设置弹窗、预设高亮同步、防削字排版、闲置半透减淡与键盘选日导航
    // =========================================================================
    try {
      const p10Res = await cdp.evaluate(`(async () => {
        document.getElementById("kal-settings")?.click();
        await new Promise(r => setTimeout(r, 80));

        // 1. Two-column workbench layout + SVG icons in left nav rail
        const mainBox = document.querySelector(".kal-panel-main");
        const tabsRail = document.querySelector(".kal-panel-tabs");
        const hasTwoColumn = Boolean(mainBox && tabsRail && getComputedStyle(mainBox).display === "flex");
        const tabSvgCount = document.querySelectorAll(".kal-panel-tab svg").length;

        // 2. Active state (.is-on) synchronization on style recipe, content preset, and font preset
        const dirtyBadge = document.getElementById("kal-panel-dirty");
        const dirtyHiddenOnOpen = Boolean(dirtyBadge && dirtyBadge.hidden === true);

        const paperRecipeBtn = document.querySelector('#kal-recipe-grid [data-recipe-id="paper"]');
        paperRecipeBtn?.click();
        const recipeIsOn = Boolean(paperRecipeBtn?.classList.contains("is-on"));
        const dirtyShownAfterPreview = Boolean(dirtyBadge && dirtyBadge.hidden === false);

        const detailPresetBtn = document.querySelector('#kal-content-preset-grid [data-content-preset="large-comfort"]');
        detailPresetBtn?.click();
        const contentPresetIsOn = Boolean(detailPresetBtn?.classList.contains("is-on"));

        const fontPresetBtn = document.querySelector('[data-font-preset="literary-kai"]');
        fontPresetBtn?.click();
        const fontPresetIsOn = Boolean(fontPresetBtn?.classList.contains("is-on"));

        // Reset restores clean state and hides dirty badge
        document.querySelector('.kal-panel [data-act="reset"]')?.click();
        const dirtyHiddenAfterReset = Boolean(dirtyBadge && dirtyBadge.hidden === true);

        // 3. Dock Idle Fade toggle
        const fadeToggle = document.getElementById("kal-dock-fade-toggle");
        fadeToggle?.click();
        await new Promise(r => setTimeout(r, 40));
        const idleFadeOn = document.body.classList.contains("kal-dock-idle-fade");
        fadeToggle?.click();
        await new Promise(r => setTimeout(r, 40));
        const idleFadeOff = !document.body.classList.contains("kal-dock-idle-fade");

        document.querySelector('.kal-panel [data-act="close"]')?.click();

        // 4. Today pill badge vs Selected cell
        const todayNum = document.querySelector(".kal-cell.is-today .kal-daynum");
        const todayRadius = todayNum ? getComputedStyle(todayNum).borderRadius : "";

        // 5. Keyboard ArrowDown (+7 days) & ArrowUp (-7 days) navigation
        document.querySelector('.kal-cell[data-key="2026-10-10"]')?.click();
        const beforeKey = document.querySelector(".kal-cell.is-selected")?.dataset?.key || "";
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        const afterDownKey = document.querySelector(".kal-cell.is-selected")?.dataset?.key || "";
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
        const afterUpKey = document.querySelector(".kal-cell.is-selected")?.dataset?.key || "";

        return {
          hasTwoColumn,
          tabSvgCount,
          dirtyHiddenOnOpen,
          recipeIsOn,
          dirtyShownAfterPreview,
          contentPresetIsOn,
          fontPresetIsOn,
          dirtyHiddenAfterReset,
          idleFadeOn,
          idleFadeOff,
          hasTodayPill: todayRadius.includes("999"),
          beforeKey,
          afterDownKey,
          afterUpKey,
        };
      })()`);
      const ok =
        p10Res.hasTwoColumn === true &&
        p10Res.tabSvgCount === 6 &&
        p10Res.dirtyHiddenOnOpen === true &&
        p10Res.recipeIsOn === true &&
        p10Res.dirtyShownAfterPreview === true &&
        p10Res.contentPresetIsOn === true &&
        p10Res.fontPresetIsOn === true &&
        p10Res.dirtyHiddenAfterReset === true &&
        p10Res.idleFadeOn === true &&
        p10Res.idleFadeOff === true &&
        p10Res.hasTodayPill === true &&
        p10Res.beforeKey === "2026-10-10" &&
        p10Res.afterDownKey === "2026-10-17" &&
        p10Res.afterUpKey === "2026-10-10";
      record("P10-ux-and-visual-polish", "双栏设置弹窗/预设高亮同步/待保存提示/闲置半透减淡/今日胶囊与键盘周向选日", ok, JSON.stringify(p10Res));
    } catch (err) {
      record("P10-ux-and-visual-polish", "双栏设置弹窗/预设高亮同步/待保存提示/闲置半透减淡/今日胶囊与键盘周向选日", false, err.message);
    }

    // =========================================================================
    // [P11-restore-defaults-quickglass-wallpaper-monitors]
    // 1. 预设主题/窗口质感/排版/字体/背景壁纸/高级微调均可一键或二次点击还原默认状态
    // 2. 顶栏「透明底」按钮再次点击精确还原最初实底状态
    // 3. 壁纸式常驻背景透明度（不随鼠标移出变透明）与闲置半透默认关闭
    // 4. 移除「全部设置」分类标签，按需直接点击 6 大分类
    // 5. 横竖屏多显示器尺寸/方向/分辨率适配与竖屏上下半区固定预设
    // =========================================================================
    try {
      const p11Res = await cdp.evaluate(`(async () => {
        // 1. Ensure factory default state first
        document.getElementById("kal-settings")?.click();
        await new Promise(r => setTimeout(r, 60));
        const noAllTab = document.querySelector('.kal-panel-tab[data-tab="all"]') === null;
        const defaultTabIsGeneral = document.querySelector('.kal-panel-tab.is-on')?.dataset?.tab === "general";

        document.querySelector('.kal-panel [data-act="factory-reset"]')?.click();
        await new Promise(r => setTimeout(r, 80));
        const initialAlpha = getComputedStyle(document.documentElement).getPropertyValue("--kal-bg-alpha").trim();

        // 2. Test Quick Glass button (#kal-quick-glass): click once -> 0, click again -> restores initial 1!
        document.querySelector('.kal-panel [data-act="close"]')?.click();
        const qgBtn = document.getElementById("kal-quick-glass");
        qgBtn?.click();
        await new Promise(r => setTimeout(r, 80));
        const qgAlphaOn = getComputedStyle(document.documentElement).getPropertyValue("--kal-bg-alpha").trim();
        const qgActive = Boolean(qgBtn?.classList.contains("is-active"));
        qgBtn?.click();
        await new Promise(r => setTimeout(r, 80));
        const qgAlphaRestored = getComputedStyle(document.documentElement).getPropertyValue("--kal-bg-alpha").trim();
        const qgRestoredInactive = !qgBtn?.classList.contains("is-active");

        // 3. Test each section's restore-to-default in Settings
        document.getElementById("kal-settings")?.click();
        await new Promise(r => setTimeout(r, 60));

        // 3a. Style recipe: click frosted -> click frosted again (or reset-sec="recipe") -> restores paper default
        document.querySelector('.kal-panel-tab[data-tab="style"]')?.click();
        const frostedCard = document.querySelector('#kal-recipe-grid [data-recipe-id="frosted"]');
        const paperCard = document.querySelector('#kal-recipe-grid [data-recipe-id="paper"]');
        frostedCard?.click();
        const frostedOn = Boolean(frostedCard?.classList.contains("is-on"));
        frostedCard?.click(); // clicking active card toggles back to default paper!
        const paperRestoredByToggle = Boolean(paperCard?.classList.contains("is-on"));

        // 3b. Content preset: click compact-single -> click section reset -> restores standard-wrap
        document.querySelector('.kal-panel-tab[data-tab="type"]')?.click();
        const compactCard = document.querySelector('#kal-content-preset-grid [data-content-preset="compact-single"]');
        const stdCard = document.querySelector('#kal-content-preset-grid [data-content-preset="standard-wrap"]');
        compactCard?.click();
        document.querySelector('[data-reset-sec="content"]')?.click();
        const contentRestored = Boolean(stdCard?.classList.contains("is-on"));

        // 3c. Font preset: click geek-mono -> click section reset -> restores default-ui
        const monoChip = document.querySelector('[data-font-preset="geek-mono"]');
        const defFontChip = document.querySelector('[data-font-preset="default-ui"]');
        monoChip?.click();
        document.querySelector('[data-reset-sec="font"]')?.click();
        const fontRestored = Boolean(defFontChip?.classList.contains("is-on"));

        // 3d. Art backdrop: click aurora -> click aurora again -> restores clear-bg ("none")
        document.querySelector('.kal-panel-tab[data-tab="backdrop"]')?.click();
        const auroraCard = document.querySelector('#kal-art-grid [data-art-id="aurora"]');
        const clearBgChip = document.querySelector('[data-wp="clear-bg"]');
        auroraCard?.click();
        const auroraOn = document.body.classList.contains("kal-has-backdrop");
        auroraCard?.click();
        const backdropRestored = !document.body.classList.contains("kal-has-backdrop") && Boolean(clearBgChip?.classList.contains("is-on"));

        // 4. Test Wallpaper Steady Transparency (#kal-dock-alpha-seg) & idleFade default off
        document.querySelector('.kal-panel-tab[data-tab="general"]')?.click();
        const idleFadeDefaultOff = !document.body.classList.contains("kal-dock-idle-fade");
        const alpha65Btn = document.querySelector('#kal-dock-alpha-seg [data-wall-alpha="0.65"]');
        alpha65Btn?.click();
        await new Promise(r => setTimeout(r, 80));
        const steadyAlpha65 = getComputedStyle(document.documentElement).getPropertyValue("--kal-bg-alpha").trim();
        const alpha100Btn = document.querySelector('#kal-dock-alpha-seg [data-wall-alpha="1"]');
        alpha100Btn?.click();
        await new Promise(r => setTimeout(r, 80));
        const steadyAlpha100 = getComputedStyle(document.documentElement).getPropertyValue("--kal-bg-alpha").trim();

        // 5. Test Monitor Orientation & Multi-Monitor options + top-desktop portrait dock preset
        const monSelect = document.getElementById("kal-dock-monitor-select");
        const monOptionsText = monSelect ? [...monSelect.options].map(o => o.textContent).join(" | ") : "";
        const hasLandscapeAndPortraitMonitors = monOptionsText.includes("[横屏]") && monOptionsText.includes("[竖屏]");
        const hasTopBottomPresets = Boolean(
          document.querySelector('.kal-dock-pos-card[data-dock-pos="top-desktop"]') &&
          document.querySelector('.kal-dock-pos-card[data-dock-pos="bottom-desktop"]')
        );

        document.querySelector('.kal-panel [data-act="close"]')?.click();
        return {
          noAllTab,
          defaultTabIsGeneral,
          initialAlpha,
          qgAlphaOn,
          qgActive,
          qgAlphaRestored,
          qgRestoredInactive,
          frostedOn,
          paperRestoredByToggle,
          contentRestored,
          fontRestored,
          auroraOn,
          backdropRestored,
          idleFadeDefaultOff,
          steadyAlpha65,
          steadyAlpha100,
          hasLandscapeAndPortraitMonitors,
          hasTopBottomPresets,
        };
      })()`);
      const ok =
        p11Res.noAllTab === true &&
        p11Res.defaultTabIsGeneral === true &&
        p11Res.initialAlpha === "1" &&
        p11Res.qgAlphaOn === "0" &&
        p11Res.qgActive === true &&
        p11Res.qgAlphaRestored === "1" &&
        p11Res.qgRestoredInactive === true &&
        p11Res.frostedOn === true &&
        p11Res.paperRestoredByToggle === true &&
        p11Res.contentRestored === true &&
        p11Res.fontRestored === true &&
        p11Res.auroraOn === true &&
        p11Res.backdropRestored === true &&
        p11Res.idleFadeDefaultOff === true &&
        p11Res.steadyAlpha65 === "0.65" &&
        p11Res.steadyAlpha100 === "1" &&
        p11Res.hasLandscapeAndPortraitMonitors === true &&
        p11Res.hasTopBottomPresets === true;
      record("P11-restore-defaults-quickglass-wallpaper-monitors", "设置全项恢复默认/透明底一键还原初始态/壁纸常驻透明度/移除全部设置/多屏横竖屏适配", ok, JSON.stringify(p11Res));
    } catch (err) {
      record("P11-restore-defaults-quickglass-wallpaper-monitors", "设置全项恢复默认/透明底一键还原初始态/壁纸常驻透明度/移除全部设置/多屏横竖屏适配", false, err.message);
    }

    // =========================================================================
    // [P12-audit-polish] Phase 12 全方位体验与视觉优化回归：
    // 1. 顶栏周次徽章在回到今天或切换月份时立即按选中日期计算（非月初第1天）
    // 2. 顶栏「防窥」「透明底」按钮显示文字标签 + 窗口最小化/隐藏托盘控制按钮
    // 3. 解除被 CSS 屏蔽的 4 项功能：单日底色标记栏、导出弹层「导出 .ics」、日格条数角标、黄历宜忌开关
    // 4. 「排版与字体」内置系统/私有字体下拉选择器并与字体搜索实时联动
    // 5. 「高级微调」拨杆开关右对齐 + 右栏生产力区无横向滚动条
    // =========================================================================
    try {
      const p12Res = await cdp.evaluate(`(async () => {
        const { getWeekOfYear } = await import("/src/lunar.js");
        const { fromKey } = await import("/src/calendar.js");

        // 1. Click "今天" and verify #kal-week-badge matches the selected date's week of year
        document.getElementById("kal-today")?.click();
        await new Promise(r => setTimeout(r, 80));
        const selectedKey = document.querySelector(".kal-cell.is-selected")?.dataset?.key || "";
        const expectedWeek = selectedKey ? \`第 \${getWeekOfYear(fromKey(selectedKey))} 周\` : "";
        const actualWeekBadge = document.getElementById("kal-week-badge")?.textContent?.trim() || "";
        const weekBadgeAccurate = Boolean(expectedWeek && actualWeekBadge === expectedWeek);

        // 2. Verify header button text labels & window controls visibility
        const privacyLabelVisible = getComputedStyle(document.querySelector("#kal-privacy-btn span")).display !== "none";
        const quickGlassLabelVisible = getComputedStyle(document.querySelector("#kal-quick-glass span")).display !== "none";
        const winControlsPresent = Boolean(document.getElementById("kal-win-min") && document.getElementById("kal-win-close"));

        // 3. Verify unblocked features: #kal-cell-color-bar & #kal-export-ics-btn & #kal-holiday-section
        const timeToggle = document.getElementById("kal-time-toggle-btn");
        if (document.getElementById("kal-agenda-add-meta")?.hidden) timeToggle?.click();
        const colorBarVisible = getComputedStyle(document.getElementById("kal-cell-color-bar")).display !== "none";
        if (!document.getElementById("kal-agenda-add-meta")?.hidden) timeToggle?.click();

        document.getElementById("kal-export-btn")?.click();
        const exportIcsBtnPresent = Boolean(document.getElementById("kal-export-ics-btn"));
        document.getElementById("kal-export-close")?.click();

        const holidaySecVisible = getComputedStyle(document.getElementById("kal-holiday-section")).display !== "none";
        const prodOverflowX = getComputedStyle(document.getElementById("kal-productivity")).overflowX;

        // 4. Open Settings -> "排版与字体" -> verify system/local font selects exist inside fontSec
        document.getElementById("kal-settings")?.click();
        await new Promise(r => setTimeout(r, 60));
        document.querySelector('.kal-panel-tab[data-tab="type"]')?.click();
        const typeFontSelects = document.querySelectorAll('.kal-sec[data-cat="type"] select').length;

        // 5. Switch to "高级微调" -> verify switch right-alignment & showCellCount / showYiJi toggles
        document.querySelector('.kal-panel-tab[data-tab="color"]')?.click();
        const rowJustify = getComputedStyle(document.querySelector('.kal-advanced-drawer .kal-row')).justifyContent;
        document.querySelector('.kal-panel [data-act="close"]')?.click();

        return {
          selectedKey,
          expectedWeek,
          actualWeekBadge,
          weekBadgeAccurate,
          privacyLabelVisible,
          quickGlassLabelVisible,
          winControlsPresent,
          colorBarVisible,
          exportIcsBtnPresent,
          holidaySecVisible,
          prodOverflowX,
          typeFontSelects,
          rowJustify,
        };
      })()`);
      const ok =
        p12Res.weekBadgeAccurate === true &&
        p12Res.privacyLabelVisible === true &&
        p12Res.quickGlassLabelVisible === true &&
        p12Res.winControlsPresent === true &&
        p12Res.colorBarVisible === true &&
        p12Res.exportIcsBtnPresent === true &&
        p12Res.holidaySecVisible === true &&
        p12Res.prodOverflowX === "hidden" &&
        p12Res.typeFontSelects >= 2 &&
        p12Res.rowJustify === "space-between";
      record("P12-audit-polish", "周次计算修复/顶栏文字与窗口控制/解锁底色标记与ICS导出/字体搜索选择器同页联动/高级微调对齐", ok, JSON.stringify(p12Res));
    } catch (err) {
      record("P12-audit-polish", "周次计算修复/顶栏文字与窗口控制/解锁底色标记与ICS导出/字体搜索选择器同页联动/高级微调对齐", false, err.message);
    }

    // =========================================================================
    // [P13-v011-ux-and-sidebar-toggle] v0.1.1 专项验收：
    // 1. 设置中心「显示右侧展示栏」开关（默认仅展示日历，按需开启/关闭右侧展示栏）
    // 2. 右侧栏圆圈 (.kal-agenda-dot) 与右侧文本 (.kal-agenda-text) 首行垂直居中对齐
    // 3. 日历单元格多任务 (.is-multi-tasks / .is-crowded) 自动换行，不再把第2/3条强制单行截断为 "..."
    // 4. 隐藏右侧栏无用顶栏按钮组 (.kal-agenda-head-right) 与底栏抽屉 (#kal-productivity)，新增「近期安排」(#kal-upcoming-section)
    // 5. 左格双击已有安排清空回车可直接删除（纯日历模式闭环）
    // =========================================================================
    try {
      const p13Res = await cdp.evaluate(`(async () => {
        window.__KAL_TEST__.setRequireConfirm(false);
        // Ensure right sidebar is currently visible to test its layout & alignment
        const sidebarToggle = document.getElementById("kal-agenda-sidebar-toggle");
        if (sidebarToggle && !sidebarToggle.checked) {
          sidebarToggle.click();
          await new Promise(r => setTimeout(r, 80));
        }
        const sidebarVisibleWhenChecked = !document.body.classList.contains("kal-agenda-hidden") &&
          getComputedStyle(document.getElementById("kal-agenda")).display !== "none";

        // 1. Seed 3 long tasks on 2026-10-22 to verify cell auto-wrapping & circle alignment
        await window.__KAL_TEST__.seedDirectItem("2026-10-22", "国家奖学金公示复核与材料归档提交", "");
        await window.__KAL_TEST__.seedDirectItem("2026-10-22", "提交自强之星材料给辅导员审核", "");
        await window.__KAL_TEST__.seedDirectItem("2026-10-22", "新生完成实验室安全准入考试与培训", "");
        document.getElementById("kal-refresh")?.click();
        await new Promise(r => setTimeout(r, 120));
        document.querySelector('.kal-cell[data-key="2026-10-22"]')?.click();
        await new Promise(r => setTimeout(r, 80));

        // Check Issue 2: 2nd and 3rd tasks inside .kal-cell.is-multi-tasks.is-crowded allow full multi-line wrapping with NO 2-line limit and NO ellipsis
        const cell22 = document.querySelector('.kal-cell[data-key="2026-10-22"]');
        const cellTasks = Array.from(cell22?.querySelectorAll(".kal-task") || []);
        const allTasksWrap = cellTasks.length >= 3 && cellTasks.every(t => {
          const cs = getComputedStyle(t);
          return cs.whiteSpace === "pre-wrap" && cs.webkitLineClamp === "none" && cs.overflow === "visible";
        });
        const octCellCount = document.querySelectorAll("#kal-grid .kal-cell").length;
        const octIsFiveRows = octCellCount === 35;
        const taskFontSizePx = cellTasks[0] ? parseFloat(getComputedStyle(cellTasks[0]).fontSize) : 0;

        // Check duplicate Starport theme cards: open Settings -> refresh library -> verify 0 non-builtin Starport cards
        document.getElementById("kal-settings")?.click();
        await new Promise(r => setTimeout(r, 80));
        const dupStarportCards = Array.from(document.querySelectorAll('#kal-theme-list .kal-theme-card[data-builtin="false"]'))
          .filter(c => (c.querySelector("span")?.textContent || "").includes("星港素纸") && !(c.querySelector("span")?.textContent || "").includes("副本"));
        const noDuplicateStarportCards = dupStarportCards.length === 0;
        document.querySelector('.kal-panel [data-act="close"]')?.click();

        // Check Issue 1: .kal-agenda-dot and .kal-agenda-text first-line vertical center alignment
        const firstLi = document.querySelector("#kal-agenda-list li:not(.is-empty)");
        const dotEl = firstLi?.querySelector(".kal-agenda-dot");
        const txtEl = firstLi?.querySelector(".kal-agenda-text");
        const dotRect = dotEl?.getBoundingClientRect();
        const txtRect = txtEl?.getBoundingClientRect();
        const txtLineH = parseFloat(getComputedStyle(txtEl).lineHeight) || 20;
        const dotCenterY = dotRect ? (dotRect.top + dotRect.height / 2) : 0;
        const txtFirstLineCenterY = txtRect ? (txtRect.top + txtLineH / 2) : 999;
        const circleAligned = Math.abs(dotCenterY - txtFirstLineCenterY) <= 2.5;

        // Check Issue 3 & 4: unused header buttons & bottom drawers hidden, upcoming section rendered
        const headRightHidden = getComputedStyle(document.querySelector(".kal-agenda-head-right")).display === "none";
        const productivityHidden = getComputedStyle(document.getElementById("kal-productivity")).display === "none";
        const upcomingVisible = getComputedStyle(document.getElementById("kal-upcoming-section")).display !== "none";
        const upcomingItemCount = document.querySelectorAll("#kal-upcoming-list li").length;
        const relBadgeText = document.getElementById("kal-agenda-rel-badge")?.textContent?.trim() || "";

        // Check Supplemental Requirement: toggle sidebar off -> calendar-only mode
        sidebarToggle?.click();
        await new Promise(r => setTimeout(r, 80));
        const sidebarHiddenWhenUnchecked = document.body.classList.contains("kal-agenda-hidden") &&
          getComputedStyle(document.getElementById("kal-agenda")).display === "none";

        // Check in-cell empty Enter delete while in calendar-only mode
        const liveCell22 = document.querySelector('.kal-cell[data-key="2026-10-22"]');
        const targetTaskEl = Array.from(liveCell22?.querySelectorAll(".kal-task") || []).find(n => n.textContent === "国家奖学金公示复核与材料归档提交");
        targetTaskEl?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        const editInput = liveCell22?.querySelector(".kal-cell-inline-input.is-edit");
        let deletedViaEmptyEnter = false;
        if (editInput) {
          editInput.value = "";
          editInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
          await new Promise(r => setTimeout(r, 140));
          const remaining = Array.from(document.querySelectorAll('.kal-cell[data-key="2026-10-22"] .kal-task')).map(n => n.textContent);
          deletedViaEmptyEnter = !remaining.includes("国家奖学金公示复核与材料归档提交");
        }

        window.__KAL_TEST__.setRequireConfirm(true);
        return {
          sidebarVisibleWhenChecked,
          sidebarHiddenWhenUnchecked,
          allTasksWrap,
          circleAligned,
          dotCenterDiff: Math.abs(dotCenterY - txtFirstLineCenterY),
          headRightHidden,
          productivityHidden,
          upcomingVisible,
          upcomingItemCount,
          hasRelBadge: relBadgeText.length > 0,
          deletedViaEmptyEnter,
          noDuplicateStarportCards,
          octIsFiveRows,
          taskFontSizePx,
        };
      })()`);
      const ok =
        p13Res.sidebarVisibleWhenChecked === true &&
        p13Res.sidebarHiddenWhenUnchecked === true &&
        p13Res.allTasksWrap === true &&
        p13Res.circleAligned === true &&
        p13Res.headRightHidden === true &&
        p13Res.productivityHidden === true &&
        p13Res.upcomingVisible === true &&
        p13Res.upcomingItemCount >= 1 &&
        p13Res.hasRelBadge === true &&
        p13Res.deletedViaEmptyEnter === true &&
        p13Res.noDuplicateStarportCards === true &&
        p13Res.octIsFiveRows === true &&
        p13Res.taskFontSizePx >= 12.5;
      record("P13-v011-ux-and-sidebar-toggle", "默认仅日历与右侧栏开关/圆圈与文字垂直对齐/多任务自动换行/精简顶底栏与近期安排/左格清空回车删除", ok, JSON.stringify(p13Res));
    } catch (err) {
      record("P13-v011-ux-and-sidebar-toggle", "默认仅日历与右侧栏开关/圆圈与文字垂直对齐/多任务自动换行/精简顶底栏与近期安排/左格清空回车删除", false, err.message);
    }

    // 全程调用日志脱敏二次核对
    const allCallsStr = JSON.stringify(await cdp.evaluate(`window.__KAL_TEST__.getCalls()`));
    if (allCallsStr.includes("super_secret_token_val_123456")) {
      record("guard", "IPC调用日志不含真实凭证", false, "日志中检出未脱敏凭证");
    }
  } finally {
    if (cdp) {
      try {
        await cdp.send("Browser.close", {}, 3000);
      } catch { /* ignore */ }
      cdp.close();
    }
    if (edgeProc && edgeProc.exitCode === null) {
      await Promise.race([
        new Promise(resolve => edgeProc.once("exit", resolve)),
        sleep(2000),
      ]);
    }
    await new Promise(resolve => httpServer.close(resolve));
    try {
      await fs.rm(userDataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  console.log(`\n[ui-check 汇总] 共 ${results.length} 项：通过 ${passCount} / 失败 ${failCount}`);
  process.exit(failCount === 0 ? 0 : 1);
}

run().catch(err => {
  console.error("[ui-check 致命错误]", err);
  process.exit(1);
});

