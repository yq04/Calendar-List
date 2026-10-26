// Run against an explicitly started debug Kal with fixture DB and isolated APPDATA.
// Uses real Tauri IPC/FontFace/Win32 hotkeys; never calls DesktopCal write commands.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const port = process.env.KAL_CDP_PORT || "9345";
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(t => t.type === "page" && t.webSocketDebuggerUrl);
assert.ok(target, "需要运行带调试端口的 Kal");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const waiting = new Map();
ws.onmessage = e => {
  const response = JSON.parse(e.data);
  const entry = waiting.get(response.id);
  if (!entry) return;
  clearTimeout(entry.timer);
  waiting.delete(response.id);
  if (response.error) entry.reject(new Error(response.error.message));
  else entry.resolve(response.result);
};
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method} timeout`)); }, 15000);
    waiting.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const response = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result?.value;
}
async function waitFor(expression) {
  for (let n = 0; n < 40; n++) {
    const result = await evaluate(expression);
    if (result) return result;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`条件未满足: ${expression}`);
}
const nativeCode = `import ctypes,json,sys
u=ctypes.windll.user32
u.GetForegroundWindow.restype=ctypes.c_void_p
u.GetWindowLongPtrW.argtypes=[ctypes.c_void_p,ctypes.c_int]
u.GetWindowLongPtrW.restype=ctypes.c_ssize_t
h=int(sys.argv[2])
if sys.argv[1]=='hotkey':
 for k in (0x5b,0x12,0x43): u.keybd_event(k,0,0,0)
 for k in (0x43,0x12,0x5b): u.keybd_event(k,0,2,0)
print(json.dumps({'foreground':u.GetForegroundWindow(),'topmost':bool(u.GetWindowLongPtrW(h,-20)&8)}))`;
function native(action, hwnd) {
  return JSON.parse(execFileSync("python", ["-c", nativeCode, action, String(hwnd)], { encoding: "utf8", windowsHide: true }));
}

const results = [];
let enabledByTest = false;
try {
  const baseline = await evaluate(`(async()=>{
    const invoke=window.__TAURI__.core.invoke;
    const info=await invoke("app_info");
    const write=await invoke("calendar_write_status");
    const fonts=await invoke("local_fonts_list");
    const desktop=await invoke("desktop_status");
    return {info,write,fonts,desktop,cells:document.querySelectorAll(".kal-cell").length,
      count:document.querySelectorAll(".kal-countdown-card").length,hit:await invoke("hit_test_self")};
  })()`);
  assert.ok(baseline.info.dbPath.replaceAll("\\", "/").endsWith("/_fixture/calendar.db"), "必须使用 fixture");
  assert.ok(baseline.info.appDir.includes("runtime-"), "必须隔离 APPDATA");
  assert.equal(baseline.write.available, false);
  assert.equal(baseline.cells, 42);
  assert.equal(baseline.count, 1);
  assert.equal(baseline.desktop.enabled, false);
  results.push("fixture/隔离配置/42格/本地倒计时/只读隔离通过");

  const note = await evaluate(`(async()=>{
    document.getElementById("kal-notes").open=true;
    const p=await window.__TAURI__.core.invoke("notes_list",{offset:0});
    return p.notes.length ? window.__TAURI__.core.invoke("note_get",{id:p.notes[0].id}):null;
  })()`);
  assert.ok(note?.content);
  await waitFor(`document.querySelector(".kal-note-entry") !== null`);
  await evaluate(`document.querySelector(".kal-note-entry").open=true`);
  await waitFor(`document.querySelector(".kal-note-content")?.textContent !== "正在读取…"`);
  results.push("真实 SQLite 便签分页/正文及界面展开通过");

  assert.ok(baseline.fonts.fonts.length, "隔离 fonts 目录需要一个测试字体");
  const font = baseline.fonts.fonts[0];
  await evaluate(`document.getElementById("kal-settings").click()`);
  await waitFor(`Array.from(document.querySelectorAll(".kal-panel select")).some(s=>Array.from(s.options).some(o=>o.value===${JSON.stringify(`"${font.family}"`)}))`);
  await evaluate(`(()=>{const s=Array.from(document.querySelectorAll(".kal-panel select")).find(s=>Array.from(s.options).some(o=>o.value===${JSON.stringify(`"${font.family}"`)}));s.value=${JSON.stringify(`"${font.family}"`)};s.dispatchEvent(new Event("change",{bubbles:true}));})()`);
  await waitFor(`Array.from(document.fonts).some(f=>f.family===${JSON.stringify(font.family)} && f.status==="loaded")`);
  const savedTheme = await evaluate(`(async()=>{
    const invoke=window.__TAURI__.core.invoke;
    const t=await invoke("theme_active");
    t.id="native-check-font";t.name="字体与桌面能力验收";
    t.type.familyUi=${JSON.stringify(`"${font.family}", "Segoe UI", sans-serif`)};
    t.type.stretch=110;
    return invoke("theme_commit",{theme:t});
  })()`);
  assert.equal(savedTheme.type.stretch, 110);
  await call("Page.reload");
  await waitFor(`document.querySelectorAll(".kal-cell").length===42 && Array.from(document.fonts).some(f=>f.family===${JSON.stringify(font.family)} && f.status==="loaded")`);
  assert.equal(await evaluate(`getComputedStyle(document.body).fontStretch`), "110%");
  results.push("真实字体文件/FontFace/保存主题/页面重载恢复及字宽通过");

  const hwnd = parseInt(baseline.hit.match(/self=0x([0-9A-F]+)/i)[1], 16);
  const enabled = await evaluate(`window.__TAURI__.core.invoke("desktop_set_hotkey",{enabled:true})`);
  enabledByTest = enabled.enabled;
  assert.equal(enabled.registered, true, enabled.error || "热键应注册成功");
  native("hotkey", hwnd);
  let raised;
  for (let n = 0; n < 20; n++) {
    await new Promise(r => setTimeout(r, 100));
    raised = native("probe", hwnd);
    if (raised.topmost && raised.foreground === hwnd) break;
  }
  assert.equal(raised.topmost, true, "热键应临时置顶");
  assert.equal(raised.foreground, hwnd, "热键应将键盘焦点交给 Kal");
  await evaluate(`window.__TAURI__.window.getCurrentWindow().hide()`);
  for (let n = 0; n < 20 && native("probe", hwnd).topmost; n++) await new Promise(r => setTimeout(r, 100));
  assert.equal(native("probe", hwnd).topmost, false, "隐藏导致失焦时应清除临时置顶");
  const duplicate = spawn(path.resolve(process.env.KAL_NATIVE_EXE || "src-tauri/target/debug/kal.exe"), [], {
    env: { ...process.env, APPDATA: path.dirname(baseline.info.appDir), KAL_DB_PATH: baseline.info.dbPath, KAL_DEBUG_PORT: "9346" },
    windowsHide: true, stdio: "ignore",
  });
  const duplicateCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { duplicate.kill(); reject(new Error("重复启动未及时退出")); }, 5000);
    duplicate.once("error", err => { clearTimeout(timer); reject(err); });
    duplicate.once("exit", code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(duplicateCode, 0);
  for (let n = 0; n < 20 && !native("probe", hwnd).topmost; n++) await new Promise(r => setTimeout(r, 100));
  assert.equal(native("probe", hwnd).topmost, true, "重复启动应唤醒已有实例");
  assert.equal(await evaluate(`window.__TAURI__.window.getCurrentWindow().isVisible()`), true);
  results.push("真实失焦清除置顶/重复启动退出并唤醒隐藏的已有窗口通过");
  native("hotkey", hwnd);
  let lowered;
  for (let n = 0; n < 20; n++) {
    await new Promise(r => setTimeout(r, 100));
    lowered = native("probe", hwnd);
    if (!lowered.topmost) break;
  }
  assert.equal(lowered.topmost, false, "再次热键应恢复桌面");
  const off = await evaluate(`window.__TAURI__.core.invoke("desktop_set_hotkey",{enabled:false})`);
  assert.equal(off.registered, false);
  enabledByTest = false;
  results.push("真实 RegisterHotKey/键盘呼出前置/再次按键沉底/注销通过");

  // Native coordinate input on the actual WebView; no DOM .click() for this action.
  await evaluate(`document.querySelector(".kal-panel [data-act=close]")?.click()`);
  const settingsRect = await evaluate(`(()=>{const r=document.getElementById("kal-settings").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await call("Input.dispatchMouseEvent", {type:"mousePressed",...settingsRect,button:"left",clickCount:1});
  await call("Input.dispatchMouseEvent", {type:"mouseReleased",...settingsRect,button:"left",clickCount:1});
  await waitFor(`document.body.classList.contains("kal-panel-open")`);
  const metrics=await evaluate(`({dpr:devicePixelRatio,scale:getComputedStyle(document.documentElement).getPropertyValue("--kal-ui-scale"),viewport:[innerWidth,innerHeight],stretch:getComputedStyle(document.body).fontStretch})`);
  results.push({check:"真实WebView坐标打开设置",metrics});

  if(process.env.KAL_NATIVE_THEMES==="1") {
    const themes=await evaluate(`window.__TAURI__.core.invoke("theme_list")`);
    assert.equal(themes.filter(t=>t.builtin && t.id.startsWith("builtin-")).length,5);
    const activeBefore=await evaluate(`window.__TAURI__.core.invoke("theme_active")`);
    await evaluate(`document.querySelector('[data-theme-id="builtin-starport-paper"]').click()`);
    await waitFor(`getComputedStyle(document.documentElement).getPropertyValue("--kal-bg").trim()==="251 246 236"`);
    assert.equal((await evaluate(`window.__TAURI__.core.invoke("theme_active")`)).id,activeBefore.id);
    await evaluate(`document.querySelector('.kal-panel [data-act="close"]').click()`);
    assert.equal(await evaluate(`getComputedStyle(document.body).fontStretch`),"110%");
    await evaluate(`document.getElementById("kal-settings").click()`);
    await waitFor(`document.querySelector('[data-theme-id="builtin-mocha"]')!==null`);
    await evaluate(`document.querySelector('[data-theme-id="builtin-mocha"]').click()`);
    await waitFor(`getComputedStyle(document.documentElement).getPropertyValue("--kal-bg").trim()==="30 30 46"`);
    await evaluate(`document.querySelector('.kal-panel [data-act="save"]').click()`);
    await waitFor(`document.getElementById("kal-report").textContent.includes("已保存并应用")`);
    const activeAfter=await evaluate(`window.__TAURI__.core.invoke("theme_active")`);
    assert.ok(activeAfter.id.startsWith("user-"));assert.equal(activeAfter.color.bg,"#1E1E2E");
    assert.equal(activeAfter.type.stretch,110);
    await call("Page.reload");
    await waitFor(`getComputedStyle(document.documentElement).getPropertyValue("--kal-bg").trim()==="30 30 46" && document.querySelectorAll(".kal-cell").length===42`);
    results.push("真实主题库/只预览不激活/关闭撤销/提交与重载保留字体通过");
  }
  results.push("Windows原生微软拼音候选输入未由自动化替代：需人工实际输入验收；CDP insertText/合成事件不计入此项");

  const screenshots = path.resolve("docs/screenshots");
  await fs.mkdir(screenshots, { recursive: true });
  await evaluate(`(()=>{document.querySelector(".kal-panel [data-act=close]")?.click();document.getElementById("kal-notes").open=true;})()`);
  await waitFor(`document.querySelector(".kal-note-entry") !== null`);
  await evaluate(`document.querySelector(".kal-note-entry").open=true`);
  await waitFor(`document.querySelector(".kal-note-content")?.textContent !== "正在读取…"`);
  const screenshot = await call("Page.captureScreenshot", { format: "png" });
  const screenshotPath = path.join(screenshots, `desktop_productivity_${Date.now()}.png`);
  await fs.writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
  console.log(JSON.stringify({ passed: results, hwnd, screenshot: screenshotPath }, null, 2));
} finally {
  if (enabledByTest) await evaluate(`window.__TAURI__.core.invoke("desktop_set_hotkey",{enabled:false})`).catch(() => {});
  ws.close();
}
