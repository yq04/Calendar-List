// Memory-only drafts. A response may acknowledge only its immutable submission snapshot.
export function createDraftSessions() {
  const drafts = new Map();
  let serial = 0;
  function get(key, initial = "", metadata = {}) {
    if (!drafts.has(key)) drafts.set(key, { session: ++serial, revision: 0, text: initial, ...metadata });
    return drafts.get(key);
  }
  function update(key, text, initial = "", metadata = {}) {
    const draft = get(key, initial, metadata);
    if (draft.text !== text) { draft.text = text; draft.revision++; }
    return draft;
  }
  return {
    get, update, has: key => drafts.has(key),
    snapshot: key => ({ key, ...get(key) }),
    acknowledge(snapshot) {
      const current = drafts.get(snapshot.key);
      if (!current || current.session !== snapshot.session || current.revision !== snapshot.revision) return false;
      drafts.delete(snapshot.key);
      return true;
    },
    cancel: key => drafts.delete(key),
  };
}

const guards = new WeakMap();
export function bindImeGuard(input) {
  if (guards.has(input)) return guards.get(input);
  const state = { composing: false, confirmationKey: false };
  input.addEventListener("compositionstart", () => { state.composing = true; });
  input.addEventListener("compositionend", () => { state.composing = false; });
  input.addEventListener("keydown", event => {
    if ((state.composing || event.isComposing || event.keyCode === 229) &&
        (event.key === "Enter" || event.keyCode === 229)) state.confirmationKey = true;
  }, true);
  input.addEventListener("keyup", () => { state.confirmationKey = false; });
  input.addEventListener("blur", () => { state.confirmationKey = false; });
  guards.set(input, state);
  return state;
}
export function isImeComposing(event, input = event?.target) {
  const state = guards.get(input);
  return Boolean(event?.isComposing || event?.keyCode === 229 || state?.composing || state?.confirmationKey);
}
