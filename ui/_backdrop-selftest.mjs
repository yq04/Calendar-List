import assert from "node:assert/strict";
import { createBackdropManager } from "./src/backdrop.js";

let passed = 0;
const test = async (name, run) => {
  await run();
  passed++;
  console.log(`PASS ${name}`);
};

function fixture({ theme = { backdrop: { mode: "none" } }, readDelayMs = 0 } = {}) {
  const calls = [];
  const style = new Map();
  const errors = [];
  let setPropertyCount = 0;
  let currentTheme = theme;
  let customResponse = null;

  const doc = {
    documentElement: {
      style: {
        setProperty: (k, v) => {
          setPropertyCount++;
          style.set(k, v);
        },
        getPropertyValue: (k) => style.get(k) || "",
      },
    },
  };

  const bridge = {
    wallpaperReadImage: async (path) => {
      calls.push(path);
      if (readDelayMs > 0) {
        await new Promise((r) => setTimeout(r, readDelayMs));
      }
      if (customResponse instanceof Error) throw customResponse;
      if (customResponse) return customResponse;
      return {
        path: path || "desktop.jpg",
        dataUrl: `data:image/jpeg;base64,${path ? "CUSTOM_" + path : "DESKTOP"}`,
      };
    },
  };

  const manager = createBackdropManager({
    bridge,
    getTheme: () => currentTheme,
    onError: (err) => errors.push(err),
    doc,
  });

  return {
    manager,
    calls,
    style,
    errors,
    get setPropertyCount() { return setPropertyCount; },
    resetSetPropertyCount: () => { setPropertyCount = 0; },
    setTheme: (t) => { currentTheme = t; },
    setResponse: (r) => { customResponse = r; },
  };
}

await test("none and invalid modes set CSS to none without bridge calls", async () => {
  const f = fixture();
  await f.manager.sync();
  assert.equal(f.calls.length, 0);
  assert.equal(f.style.get("--kal-wallpaper-image"), "none");

  await f.manager.sync({ backdrop: { mode: "art", preset: "aurora" } });
  assert.equal(f.calls.length, 0);
  assert.equal(f.style.get("--kal-wallpaper-image"), "none");

  await f.manager.sync({ backdrop: { mode: "custom" }, wallpaper: "" });
  assert.equal(f.calls.length, 0);
  assert.equal(f.style.get("--kal-wallpaper-image"), "none");
  f.manager.destroy();
});

await test("desktop mode reads wallpaper and applies url to root style", async () => {
  const f = fixture({ theme: { backdrop: { mode: "desktop" } } });
  await f.manager.sync();
  assert.deepEqual(f.calls, [null]);
  assert.equal(f.style.get("--kal-wallpaper-image"), 'url("data:image/jpeg;base64,DESKTOP")');
  f.manager.destroy();
});

await test("custom mode reads custom path and applies url", async () => {
  const f = fixture({ theme: { backdrop: { mode: "custom" }, wallpaper: "D:/pic.png" } });
  await f.manager.sync();
  assert.deepEqual(f.calls, ["D:/pic.png"]);
  assert.equal(f.style.get("--kal-wallpaper-image"), 'url("data:image/jpeg;base64,CUSTOM_D:/pic.png")');
  f.manager.destroy();
});

await test("consecutive sync with same key hits cache and does not repeat bridge read", async () => {
  const f = fixture({ theme: { backdrop: { mode: "desktop" } } });
  await f.manager.sync();
  await f.manager.sync();
  assert.equal(f.calls.length, 1);
  f.manager.destroy();
});

await test("invalidateDesktop removes desktop cache and re-reads", async () => {
  const f = fixture({ theme: { backdrop: { mode: "desktop" } } });
  await f.manager.sync();
  assert.equal(f.calls.length, 1);
  await f.manager.invalidateDesktop();
  assert.equal(f.calls.length, 2);
  f.manager.destroy();
});

await test("stale response is discarded if generation changed before read completes", async () => {
  const f = fixture({ readDelayMs: 40 });
  const p1 = f.manager.sync({ backdrop: { mode: "custom" }, wallpaper: "first.png" });
  const p2 = f.manager.sync({ backdrop: { mode: "none" } });
  await Promise.all([p1, p2]);
  assert.equal(f.style.get("--kal-wallpaper-image"), "none");
  f.manager.destroy();
});

await test("bridge read error sets CSS to none and invokes onError", async () => {
  const f = fixture();
  f.setResponse(new Error("文件读取失败"));
  await f.manager.sync({ backdrop: { mode: "desktop" } });
  assert.equal(f.style.get("--kal-wallpaper-image"), "none");
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0].message, /文件读取失败/);
  f.manager.destroy();
});

await test("concurrent sync requests for same key are deduplicated into single bridge read", async () => {
  const f = fixture({ readDelayMs: 25 });
  const theme = { backdrop: { mode: "custom" }, wallpaper: "heavy.jpg" };
  const p1 = f.manager.sync(theme);
  const p2 = f.manager.sync(theme);
  await Promise.all([p1, p2]);
  assert.equal(f.calls.length, 1, `Expected 1 bridge read but got ${f.calls.length}`);
  assert.equal(f.style.get("--kal-wallpaper-image"), 'url("data:image/jpeg;base64,CUSTOM_heavy.jpg")');
  f.manager.destroy();
});

await test("switching to none or art mode releases cached image memory", async () => {
  const f = fixture();
  const themeDesktop = { backdrop: { mode: "desktop" } };
  await f.manager.sync(themeDesktop);
  assert.equal(f.calls.length, 1);

  // Switch to none
  await f.manager.sync({ backdrop: { mode: "none" } });
  assert.equal(f.style.get("--kal-wallpaper-image"), "none");

  // Switching back to desktop should re-read because memory was released on mode switch
  await f.manager.sync(themeDesktop);
  assert.equal(f.calls.length, 2, "Expected cache to be cleared on mode switch to none");
  f.manager.destroy();
});

await test("redundant sync with already applied image avoids re-writing style property", async () => {
  const f = fixture();
  const themeDesktop = { backdrop: { mode: "desktop" } };
  await f.manager.sync(themeDesktop);
  const count1 = f.setPropertyCount;
  await f.manager.sync(themeDesktop);
  assert.equal(f.setPropertyCount, count1, "Repeated sync with same theme should not re-write DOM style property");
  f.manager.destroy();
});

await test("cache count and byte limits evict oldest entries using LRU", async () => {
  const f = fixture();
  // Load image 1
  await f.manager.sync({ backdrop: { mode: "custom" }, wallpaper: "img1.png" });
  assert.equal(f.calls.length, 1);

  // Load image 2
  await f.manager.sync({ backdrop: { mode: "custom" }, wallpaper: "img2.png" });
  assert.equal(f.calls.length, 2);

  // Hit image 1 again (should hit cache and refresh its LRU position)
  await f.manager.sync({ backdrop: { mode: "custom" }, wallpaper: "img1.png" });
  assert.equal(f.calls.length, 2);

  // Load image 3 (should evict img2 because img1 was recently accessed, and MAX_COUNT is 2)
  await f.manager.sync({ backdrop: { mode: "custom" }, wallpaper: "img3.png" });
  assert.equal(f.calls.length, 3);

  // Accessing img1 should still hit cache
  await f.manager.sync({ backdrop: { mode: "custom" }, wallpaper: "img1.png" });
  assert.equal(f.calls.length, 3, "img1 should still be cached");

  // Accessing img2 should require re-read because it was evicted by LRU
  await f.manager.sync({ backdrop: { mode: "custom" }, wallpaper: "img2.png" });
  assert.equal(f.calls.length, 4, "img2 should have been evicted");
  f.manager.destroy();
});

console.log(`${passed} tests passed`);
