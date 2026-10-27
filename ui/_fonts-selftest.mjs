import assert from "node:assert/strict";
import { createBridge } from "./src/bridge.js";
import { applyTheme, DEFAULT_THEME, toCssValue } from "./src/theme.js";
import { createLocalFonts, localFontId, selectedLocalIds, MAX_LOADED_BYTES } from "./src/local-fonts.js";

let passed = 0;
const test = async (name, run) => { await run(); passed++; console.log(`PASS ${name}`); };
const fontA = { id: "local-61", family: "Kal-local-61", name: "a.ttf", bytes: 4 };
const fontB = { id: "local-62", family: "Kal-local-62", name: "b.woff2", bytes: 4 };
const themeFor = (...fonts) => ({ type: { familyUi: fonts[0] ? `"${fonts[0].family}", sans-serif` : "system-ui", familyNum: fonts[1] ? `"${fonts[1].family}", sans-serif` : "system-ui" } });
function fixture() {
  const calls = [], faces = new Set(), style = new Map();
  let theme = themeFor();
  let data = [fontA, fontB];
  let fail = false;
  let reads = null;
  const doc = { documentElement: { style: { setProperty: (k,v) => style.set(k,v) } }, body: { style: { setProperty: (k,v) => style.set(k,v) }, classList: { toggle() {} } }, fonts: { add: f => faces.add(f), delete: f => faces.delete(f) } };
  class Face { constructor(family, bytes, descriptor) { this.family = family; this.bytes = bytes; this.descriptor = descriptor; } async load() { if (fail) throw new Error("bad font"); return this; } }
  const bridge = { localFontsList: async () => { calls.push("list"); return { fonts: data }; }, localFontRead: async id => { calls.push(id); return { id, bytes: reads || [0,1,2,3] }; } };
  const errors = [];
  const manager = createLocalFonts({ bridge, getTheme: () => theme, doc, FontFaceClass: Face, onError: e => errors.push(e) });
  return { manager, calls, faces, doc, style, errors, setTheme: v => { theme = v; }, setData: v => { data = v; }, setFail: v => { fail = v; }, setBytes: v => { reads = v; } };
}

await test("private family IDs are strict, deduplicated, and reject paths", () => {
  assert.equal(localFontId('"Kal-local-61", sans-serif'), "local-61");
  assert.equal(localFontId('"Kal-local-../a.ttf"'), null);
  assert.deepEqual(selectedLocalIds(themeFor(fontA, fontA)), [fontA.id]);
});
await test("system font themes perform no private file reads", async () => {
  const f = fixture(); await f.manager.sync(); assert.deepEqual(f.calls, []); f.manager.destroy();
});
await test("catalog enumeration does not load fonts; selected font reads once", async () => {
  const f = fixture(); await f.manager.list(); assert.deepEqual(f.calls, ["list"]);
  const t = themeFor(fontA, fontA); await f.manager.sync(t); await f.manager.sync(t);
  assert.deepEqual(f.calls, ["list", fontA.id]); assert.equal(f.faces.size, 1); f.manager.destroy();
});
await test("theme restoration loads both selected faces and unloads unused faces", async () => {
  const f = fixture(); f.setTheme(themeFor(fontA, fontB)); await f.manager.refresh(); assert.equal(f.faces.size, 2);
  await f.manager.sync(themeFor(fontB)); assert.equal(f.faces.size, 1); assert.equal([...f.faces][0].family, fontB.family);
  await f.manager.sync(themeFor()); assert.equal(f.faces.size, 0); f.manager.destroy();
});
await test("refresh re-reads changed selected font and detects removed files", async () => {
  const f = fixture(); f.setTheme(themeFor(fontA)); await f.manager.refresh(); await f.manager.refresh();
  assert.equal(f.calls.filter(c => c === fontA.id).length, 2);
  f.setData([]); await assert.rejects(f.manager.refresh(), /已移除/); assert.equal(f.faces.size, 0); f.manager.destroy();
});
await test("broken font and invalid byte payload produce actionable errors", async () => {
  const f = fixture(); f.setFail(true); await assert.rejects(f.manager.sync(themeFor(fontA)), /文件可能损坏/);
  assert.match(f.manager.error.message, /文件可能损坏/, "启动时加载失败须留给随后创建的设置面板显示");
  f.setFail(false); f.setBytes([-1]); await assert.rejects(f.manager.sync(themeFor(fontA)), /读取结果无效/);
  assert.equal(f.faces.size, 0); await f.manager.sync(themeFor()); assert.equal(f.manager.error, null); f.manager.destroy();
});
await test("stale theme requests never install the previously selected font", async () => {
  const f = fixture(); const older = f.manager.sync(themeFor(fontA)); const newer = f.manager.sync(themeFor(fontB));
  await Promise.all([older,newer]); assert.equal(f.faces.size, 1); assert.equal([...f.faces][0].family, fontB.family);
  assert.equal(f.calls.includes(fontA.id), false); f.manager.destroy();
});
await test("catalog entries over the individual limit cannot be selected", async () => {
  const f = fixture(); f.setData([{ ...fontA, bytes: MAX_LOADED_BYTES }]);
  await assert.rejects(f.manager.sync(themeFor(fontA)), /已移除/); assert.equal(f.calls.includes(fontA.id), false); f.manager.destroy();
});
await test("theme application triggers automatic FontFace restore and legacy width reset", async () => {
  const f = fixture(); applyTheme({ ...themeFor(fontA), type: { ...themeFor(fontA).type, stretch: 125 } }, { doc: f.doc });
  await f.manager.sync(themeFor(fontA)); assert.equal(f.faces.size, 1); assert.equal(f.style.get("font-stretch"), "125%");
  applyTheme(themeFor(), { doc: f.doc }); await f.manager.sync(themeFor()); assert.equal(f.faces.size, 0); assert.equal(f.style.get("font-stretch"), "100%");
  assert.equal(DEFAULT_THEME.type.stretch, 100); assert.equal(toCssValue("stretch", 250), null); f.manager.destroy();
});
await test("Mock supports empty local catalog without accessing actual files", async () => {
  const bridge = await createBridge({ invoke: null }); assert.deepEqual((await bridge.localFontsList()).fonts, []);
  await assert.rejects(bridge.localFontRead(fontA.id), /演示模式/);
});
await test("Shell bridge uses restricted ID IPC calls", async () => {
  const calls = []; const bridge = await createBridge({ invoke: async (cmd,args) => { calls.push([cmd,args]); return {}; } });
  await bridge.localFontsList(); await bridge.localFontRead(fontA.id);
  assert.deepEqual(calls.slice(1), [["local_fonts_list", undefined], ["local_font_read", { id: fontA.id }]]);
});
await test("redundant sync with identical loaded fonts skips catalog re-querying", async () => {
  const f = fixture();
  const t = themeFor(fontA);
  await f.manager.sync(t);
  const callsBefore = f.calls.length;
  // sync again with same font or non-font theme changes
  await f.manager.sync(t);
  assert.equal(f.calls.length, callsBefore, "No additional bridge calls when requested fonts are already loaded");
  f.manager.destroy();
});
await test("destroy releases loaded faces, errors, and catalog state", async () => {
  const f = fixture();
  await f.manager.sync(themeFor(fontA));
  assert.equal(f.faces.size, 1);
  f.manager.destroy();
  assert.equal(f.faces.size, 0);
  assert.equal(f.manager.error, null);
});
console.log(`${passed}/${passed} private font tests passed`);
