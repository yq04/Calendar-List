import { bindImeGuard, isImeComposing } from "./input-session.js";
import { MAX_COUNTDOWNS, countdownLabel, createCountdownStore, localToday, makeCountdown } from "./productivity-data.js";
import { sanitizeUserMessage } from "./write-state.js";

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

export function createProductivity({ mount, bridge }) {
  const store = createCountdownStore(bridge);
  const countdowns = mount.querySelector("#kal-countdowns");
  const form = mount.querySelector("#kal-countdown-form");
  const title = mount.querySelector("#kal-countdown-title");
  const date = mount.querySelector("#kal-countdown-date");
  const status = mount.querySelector("#kal-productivity-status");
  const notes = mount.querySelector("#kal-notes");
  const noteList = mount.querySelector("#kal-note-list");
  const noteStatus = mount.querySelector("#kal-notes-status");
  const more = mount.querySelector("#kal-notes-more");
  const noteRefresh = mount.querySelector("#kal-notes-refresh");
  const noteAddForm = mount.querySelector("#kal-note-form");
  const noteTitleInput = mount.querySelector("#kal-note-title-input");
  const noteContentInput = mount.querySelector("#kal-note-content-input");
  let noteOffset = 0, noteLoaded = false, noteBusy = false;
  let today = localToday();
  date.value = today;
  bindImeGuard(title);
  title.addEventListener("keydown", e => { if (e.key === "Enter" && isImeComposing(e)) e.preventDefault(); });
  if (noteTitleInput) bindImeGuard(noteTitleInput);
  if (noteContentInput) bindImeGuard(noteContentInput);

  function message(text, error = false) {
    status.textContent = text;
    status.classList.toggle("is-error", error);
  }

  function renderCountdowns() {
    countdowns.replaceChildren();
    for (const item of store.items) {
      const card = node("li", "kal-countdown-card");
      const label = node("span", "kal-countdown-title", item.title);
      label.title = `${item.title} · ${item.date}`;
      const days = node("strong", "kal-countdown-days", countdownLabel(item.date, today));
      const remove = node("button", "kal-btn kal-btn-ghost kal-countdown-remove", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", `删除倒计时：${item.title}`);
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          await store.save(store.items.filter(entry => entry.id !== item.id));
          renderCountdowns();
          message("已从本机移除");
          form.querySelector("button[type=submit]").focus();
        } catch (err) {
          message(sanitizeUserMessage(err?.message || String(err)), true);
          remove.disabled = false;
        }
      });
      card.append(label, days, remove);
      countdowns.append(card);
    }
    if (!store.items.length) countdowns.append(node("li", "kal-tools-empty", "为重要日期添加一个倒计时"));
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    const submit = form.querySelector("button[type=submit]");
    if (submit.disabled || isImeComposing(event, title)) return;
    submit.disabled = true;
    try {
      if (store.items.length >= MAX_COUNTDOWNS) throw new Error("最多保存 12 个倒计时，请先移除不再需要的日期");
      await store.save([...store.items, makeCountdown(title.value, date.value)]);
      title.value = "";
      renderCountdowns();
      message("已保存到本机");
      title.focus();
    } catch (err) { message(sanitizeUserMessage(err?.message || String(err)), true); }
    finally { submit.disabled = false; }
  });

  if (noteAddForm && noteTitleInput && noteContentInput) {
    noteAddForm.addEventListener("submit", async event => {
      event.preventDefault();
      if (isImeComposing(event, noteTitleInput) || isImeComposing(event, noteContentInput)) return;
      const submitBtn = noteAddForm.querySelector("button[type=submit]");
      if (submitBtn) submitBtn.disabled = true;
      try {
        const t = noteTitleInput.value.trim();
        const c = noteContentInput.value.trim();
        if (!t) throw new Error("请输入便签标题");
        await bridge.noteSave?.(null, t, c);
        noteTitleInput.value = "";
        noteContentInput.value = "";
        noteStatus.textContent = "已新建便签";
        await refreshNotes(true);
      } catch (err) {
        noteStatus.textContent = sanitizeUserMessage(err?.message || String(err));
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  function appendNote(note) {
    const entry = node("details", "kal-note-entry");
    entry.dataset.noteId = note.id;
    const summary = node("summary", "kal-note-title", note.title || "无标题便签");
    summary.title = note.preview || note.title;
    const body = node("div", "kal-note-content", "正在读取…");
    const meta = node("div", "kal-note-meta", note.modified || note.created || "日期未记录");

    const actions = node("div", "kal-note-actions");
    const copy = node("button", "kal-btn kal-btn-ghost", "复制正文");
    copy.type = "button";
    copy.disabled = true;

    const editBtn = node("button", "kal-btn kal-btn-ghost", "编辑");
    editBtn.type = "button";
    editBtn.disabled = true;

    const delBtn = node("button", "kal-btn kal-btn-ghost kal-note-del", "删除");
    delBtn.type = "button";

    actions.append(copy, editBtn, delBtn);

    let loaded = false, loading = false, rawContent = "";
    async function load() {
      if (loaded || loading || !entry.open) return;
      loading = true;
      try {
        const detail = await bridge.noteGet(note.id);
        rawContent = detail.content || "";
        body.textContent = rawContent || "（空便签）";
        if (detail.truncated) meta.textContent += " · 正文过长，仅显示前 262144 字符";
        copy.disabled = detail.truncated || !rawContent;
        editBtn.disabled = Boolean(detail.truncated) || !bridge.noteSave;
        copy.onclick = async () => {
          try {
            await navigator.clipboard.writeText(rawContent);
            noteStatus.textContent = "正文已复制";
          } catch { noteStatus.textContent = "复制未成功，可选中正文后按 Ctrl+C"; }
        };
        editBtn.onclick = () => {
          if (entry.querySelector(".kal-note-edit-box")) return;
          const editBox = node("div", "kal-note-edit-box");
          const tIn = node("input", "kal-agenda-input");
          tIn.type = "text";
          tIn.value = summary.textContent;
          const cIn = node("textarea", "kal-holiday-textarea");
          cIn.rows = 3;
          cIn.value = rawContent;
          const btnRow = node("div", "kal-holiday-actions");
          const saveB = node("button", "kal-btn kal-btn-ghost", "保存修改");
          saveB.type = "button";
          const cancelB = node("button", "kal-btn kal-btn-ghost", "取消");
          cancelB.type = "button";
          cancelB.onclick = () => editBox.remove();
          saveB.onclick = async () => {
            saveB.disabled = true;
            try {
              const saved = await bridge.noteSave(note.id, tIn.value, cIn.value);
              summary.textContent = saved.title || tIn.value.trim();
              rawContent = cIn.value;
              body.textContent = rawContent || "（空便签）";
              copy.disabled = !rawContent;
              editBox.remove();
              noteStatus.textContent = "便签已更新";
            } catch (err) {
              noteStatus.textContent = sanitizeUserMessage(err?.message || String(err));
              saveB.disabled = false;
            }
          };
          btnRow.append(saveB, cancelB);
          editBox.append(tIn, cIn, btnRow);
          body.after(editBox);
          tIn.focus();
        };
        loaded = true;
      } catch (err) {
        body.textContent = sanitizeUserMessage(err?.message || String(err));
        const retry = node("button", "kal-btn kal-btn-ghost", "重试");
        retry.type = "button";
        retry.onclick = load;
        body.append(retry);
      } finally { loading = false; }
    }

    delBtn.onclick = async () => {
      if (!bridge.noteDelete) return;
      delBtn.disabled = true;
      try {
        await bridge.noteDelete(note.id);
        entry.remove();
        noteOffset = Math.max(0, noteOffset - 1);
        noteStatus.textContent = "便签已删除";
      } catch (err) {
        noteStatus.textContent = sanitizeUserMessage(err?.message || String(err));
        delBtn.disabled = false;
      }
    };

    entry.addEventListener("toggle", load);
    entry.append(summary, meta, body, actions);
    noteList.append(entry);
  }

  async function refreshNotes(reset = true) {
    if (noteBusy) return;
    noteBusy = true;
    more.disabled = true;
    noteRefresh.disabled = true;
    noteStatus.textContent = "正在读取便签…";
    try {
      const page = await bridge.notesList(reset ? 0 : noteOffset);
      if (reset) { noteList.replaceChildren(); noteOffset = 0; }
      for (const note of page.notes) appendNote(note);
      noteOffset += page.notes.length;
      noteLoaded = true;
      more.hidden = !page.hasMore;
      noteStatus.textContent = noteOffset ? `已加载 ${noteOffset} 条便签` : "暂无便签";
    } catch (err) { noteStatus.textContent = sanitizeUserMessage(err?.message || String(err)); }
    finally {
      noteBusy = false;
      more.disabled = false;
      noteRefresh.disabled = false;
    }
  }
  notes.addEventListener("toggle", () => { if (notes.open && !noteLoaded) refreshNotes(); });
  more.addEventListener("click", () => refreshNotes(false));
  noteRefresh.addEventListener("click", () => refreshNotes());

  function updateToday() {
    const next = localToday();
    if (next !== today) { today = next; renderCountdowns(); }
  }
  let midnightTimer;
  function scheduleMidnight() {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    midnightTimer = setTimeout(() => { updateToday(); scheduleMidnight(); }, midnight - now + 50);
  }
  scheduleMidnight();
  document.addEventListener("visibilitychange", updateToday);
  window.addEventListener("focus", updateToday);
  window.addEventListener("pagehide", () => clearInterval(midnightTimer), { once: true });

  return {
    getCountdowns() {
      return Array.isArray(store.items) ? store.items.slice() : [];
    },
    async refresh() {
      try {
        await store.load();
        today = localToday();
        renderCountdowns();
        message("倒计时保存在本机，不参与云同步");
      } catch (err) { message(sanitizeUserMessage(err?.message || String(err)), true); }
      if (notes.open) await refreshNotes();
    },
  };
}
