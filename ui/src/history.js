import { buildExpectedSnapshot, matchesExpectedSnapshot } from "./write-state.js";

function snapshot(item) {
  return item && typeof item.id === "string" && item.id && typeof item.revision === "string"
    ? buildExpectedSnapshot(item) : null;
}

// Only server-returned snapshots establish identity; titles and times are never lookup keys.
export function createSnapshotHistoryEntry(bridge, operation, result, label) {
  if (typeof result?.historyToken === "string" && result.historyToken && typeof bridge.itemHistoryApply === "function") {
    const token = result.historyToken;
    return {
      label,
      undo: () => bridge.itemHistoryApply(token, "undo"),
      redo: () => bridge.itemHistoryApply(token, "redo"),
    };
  }
  const before = snapshot(result?.before), after = snapshot(result?.after);
  if (!before || !after) return null;
  let current = after;
  const apply = target => {
    if (operation === "update") return bridge.itemUpdate(current.id, current.date, target.title, { ...current });
    if (operation === "toggle") return bridge.itemToggleDone(current.id, current.date, target.done, { ...current });
    if (operation === "move") return bridge.itemMove(current.id, current.date, target.date, { ...current });
    throw new Error("此操作暂不支持撤销");
  };
  return {
    label,
    undo: () => apply(before),
    redo: () => apply(after),
    accept(result) {
      const next = snapshot(result?.after);
      if (!next) throw new Error("保存结果缺少事项快照，请刷新后重试");
      current = next;
    },
    rebase(item) {
      const next = snapshot(item);
      if (next && matchesExpectedSnapshot({ ...current, revision: next.revision }, next)) current = next;
    },
  };
}

export function createHistoryController(undoStack, redoStack, limit = 20) {
  let active = null;
  return {
    clear() { undoStack.length = redoStack.length = 0; },
    push(entry) {
      if (active || !entry || typeof entry.undo !== "function") return false;
      undoStack.push(entry);
      if (undoStack.length > limit) undoStack.shift();
      redoStack.length = 0;
      return true;
    },
    begin(direction) {
      if (active) return null;
      const source = direction === "undo" ? undoStack : redoStack;
      const destination = direction === "undo" ? redoStack : undoStack;
      const entry = source[source.length - 1];
      if (!entry || typeof entry[direction] !== "function") return null;
      const step = {
        entry,
        apply: () => entry[direction](),
        cancel() { if (active === step) active = null; },
        confirm(result) {
          if (active !== step || source[source.length - 1] !== entry) return false;
          try { entry.accept?.(result); }
          catch (err) { active = null; throw err; }
          source.pop();
          if (typeof entry[direction === "undo" ? "redo" : "undo"] === "function") destination.push(entry);
          for (const action of [...undoStack, ...redoStack]) action.rebase?.(result?.after);
          active = null;
          return true;
        },
      };
      active = step;
      return step;
    },
  };
}
