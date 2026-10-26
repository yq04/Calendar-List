// A bounded search queue: one transport request and only the newest waiting query.
// Cancellation invalidates responses, since Tauri invoke itself cannot be aborted here.
export function createSearchScheduler({ search, onResult, onError, delayMs = 110 }) {
  let generation = 0, active = false, pending = null, timer = null;
  function cancel() {
    generation++;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending?.resolve("cancelled");
    pending = null;
  }
  async function pump() {
    if (active || !pending?.ready) return;
    const entry = pending;
    pending = null;
    active = true;
    let outcome = "cancelled";
    try {
      const result = await search(entry.query);
      if (entry.generation === generation) {
        onResult(result, entry.query, entry.context);
        outcome = "completed";
      }
    } catch (error) {
      if (entry.generation === generation) {
        onError?.(error, entry.query, entry.context);
        outcome = "error";
      }
    } finally {
      active = false;
      entry.resolve(outcome);
      pump();
    }
  }
  return {
    cancel,
    schedule(query, context) {
      cancel();
      return new Promise(resolve => {
        const entry = { query, context, resolve, generation, ready: false };
        pending = entry;
        timer = setTimeout(() => {
          timer = null;
          if (pending !== entry) return;
          entry.ready = true;
          pump();
        }, delayMs);
      });
    },
  };
}
