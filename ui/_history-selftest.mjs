import assert from "node:assert/strict";
import { createMockSource } from "./src/mock.js";
import { buildExpectedSnapshot } from "./src/write-state.js";
import { createHistoryController, createSnapshotHistoryEntry } from "./src/history.js";

const bridge = createMockSource();
const date = "2090-01-03", target = "2090-01-04";
const undo = [], redo = [], history = createHistoryController(undo, redo);
const record = (kind, result) => history.push(createSnapshotHistoryEntry(bridge, kind, result, kind));
const run = async direction => {
  const step = history.begin(direction);
  assert.ok(step);
  try { const result = await step.apply(); step.confirm(result); return result; }
  catch (err) { step.cancel(); throw err; }
};

const original = (await bridge.itemCreate(date, "same title", "")).after;
const other = (await bridge.itemCreate(target, "same title", "")).after;
await assert.rejects(() => bridge.itemUpdate(original.id, date, "wrong", null), /快照/);
await assert.rejects(() => bridge.itemToggleDone(original.id, date, true, null), /快照/);
await assert.rejects(() => bridge.itemMove(original.id, date, target, null), /快照/);

let result = await bridge.itemUpdate(original.id, date, "edited", buildExpectedSnapshot(original));
record("update", result);
result = await bridge.itemToggleDone(result.after.id, date, true, result.after);
record("toggle", result);
await run("undo");
await run("undo");
assert.deepEqual((await bridge.dayEvents(date))[0], original);
await run("redo");
await run("redo");
assert.equal((await bridge.dayEvents(date))[0].done, true);

const completed = (await bridge.dayEvents(date))[0];
result = await bridge.itemDelete(completed.id, date, completed);
record("delete", result);
await run("undo");
assert.deepEqual((await bridge.dayEvents(date))[0], completed);
await run("redo");
assert.equal((await bridge.dayEvents(date)).length, 0);
await run("undo");

const moving = (await bridge.dayEvents(date))[0];
result = await bridge.itemMove(moving.id, date, target, moving);
record("move", result);
await run("undo");
assert.deepEqual((await bridge.dayEvents(target)).find(item => item.id === other.id), other);
assert.equal((await bridge.dayEvents(date))[0].id, moving.id);
await run("redo");
assert.equal((await bridge.dayEvents(target)).find(item => item.id === moving.id).done, true);

bridge._touchItemForTest(moving.id, { title: "external change" });
const lengths = [undo.length, redo.length];
await assert.rejects(() => run("undo"), /变化/);
assert.deepEqual([undo.length, redo.length], lengths);
assert.equal((await bridge.dayEvents(target)).find(item => item.id === moving.id).title, "external change");

const blocking = history.begin("undo");
assert.ok(blocking);
assert.equal(history.begin("undo"), null);
assert.equal(history.begin("redo"), null);
blocking.cancel();
assert.deepEqual([undo.length, redo.length], lengths);

// Live adapters without history tokens still require exact snapshots after each confirmed write.
const live = { ...bridge, itemHistoryApply: undefined };
const task = (await bridge.itemCreate("2090-02-01", "live", "")).after;
result = await bridge.itemUpdate(task.id, task.date, "changed", task);
const entry = createSnapshotHistoryEntry(live, "update", { before: task, after: result.after }, "live edit");
const undone = await entry.undo(); entry.accept(undone);
const redone = await entry.redo(); entry.accept(redone);
assert.equal(redone.after.title, "changed");
assert.equal(createSnapshotHistoryEntry(live, "delete", { before: task, after: null }, "delete"), null);

// Pending writes do not enter history before confirmation, and cancellation preserves stack ownership.
const pendingBridge = createMockSource({ requireConfirm: true });
const pending = await pendingBridge.itemCreate("2090-03-01", "pending", "");
assert.equal(pending.status, "pending_confirmation");
assert.equal(createSnapshotHistoryEntry(pendingBridge, "create", pending, "pending"), null);
const saved = await pendingBridge.itemConfirm(pending.pendingId, true);
assert.ok(saved.after && saved.historyToken);
assert.equal((await pendingBridge.itemHistoryApply(saved.historyToken, "undo")).after, null);
await assert.rejects(() => pendingBridge.itemHistoryApply(saved.historyToken, "undo"));
await pendingBridge.itemHistoryApply(saved.historyToken, "redo");

const importBridge = createMockSource();
const batch = [
  { date: "2091-01-01", title: "same", uid: "uid-1" },
  { date: "2091-01-01", title: "same", uid: "uid-2" },
  { date: "2091-01-01", title: "repeat", done: true },
  { date: "2091-01-01", title: "repeat", done: true },
];
assert.equal((await importBridge.calendarImportItems(batch)).imported, 4);
const repeat = await importBridge.calendarImportItems(batch);
assert.equal(repeat.imported, 0);
assert.equal(repeat.skipped, 4);
assert.ok(repeat.warnings.length);
assert.equal((await importBridge.calendarImportItems([{ ...batch[0], title: "changed" }])).skipped, 1);
assert.equal((await importBridge.calendarImportItems([{ ...batch[0], source: "other" }])).imported, 1);
await assert.rejects(() => importBridge.calendarImportItems([
  { date: "2091-02-01", title: "must roll back", uid: "new" },
  { date: "2091-02-30", title: "invalid" },
]));
assert.equal((await importBridge.dayEvents("2091-02-01")).length, 0);

console.log("PASS history/import: strict snapshots, chained edit/toggle, exact delete/move identity, failure retention, concurrency, pending writes, import identity and atomic validation");
