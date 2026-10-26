import assert from "node:assert/strict";
import { countdownLabel, dateOrdinal, normalizeCountdowns, makeCountdown, createCountdownStore } from "./src/productivity-data.js";

assert.equal(countdownLabel("2026-03-09", "2026-03-08"), "还有 1 天");
assert.equal(countdownLabel("2026-11-02", "2026-11-01"), "还有 1 天");
assert.equal(countdownLabel("2028-03-01", "2028-02-28"), "还有 2 天");
assert.equal(countdownLabel("2026-10-15", "2026-10-15"), "就是今天");
assert.equal(countdownLabel("2026-10-14", "2026-10-15"), "已过 1 天");
assert.throws(() => dateOrdinal("2026-02-29"));
assert.throws(() => dateOrdinal("2026-13-01"));
assert.throws(() => dateOrdinal("0000-01-01"));
assert.throws(() => makeCountdown(" ", "2026-10-15"));
const initial = makeCountdown("重要日期", "2026-12-31");
assert.equal(normalizeCountdowns([initial, { ...initial }, { id: "x", title: "错误", date: "2026-02-30" }]).length, 1);

let failSave = false;
let saved;
const store = createCountdownStore({
  settingsGet: async () => ({ productivity: { countdowns: [initial] } }),
  settingsSet: async patch => { if (failSave) throw new Error("模拟磁盘写入失败"); saved = patch; },
});
await assert.rejects(store.save([]), /尚未读入/);
await store.load();
failSave = true;
await assert.rejects(store.save([]), /写入失败/);
assert.equal(store.items.length, 1, "写失败必须保留已有卡片");
failSave = false;
await store.save([]);
assert.deepEqual(saved, { productivity: { countdowns: [] } });
assert.equal(store.items.length, 0);
const copy = store.items;
copy.push(initial);
assert.equal(store.items.length, 0, "调用方不能改变保存状态");
console.log("productivity-selftest: 16 assertions passed");
