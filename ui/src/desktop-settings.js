import { sanitizeUserMessage } from "./write-state.js";

export function mountDesktopSettings({ mount, bridge }) {
  const section = document.createElement("details");
  section.className = "kal-sec kal-desktop-settings kal-tools-section";
  section.dataset.cat = "general";
  section.open = true;

  const heading = document.createElement("summary");
  heading.className = "kal-sec-title kal-desktop-summary";
  heading.textContent = "全局快捷键";

  const card = document.createElement("div");
  card.className = "kal-card-group";

  const row = document.createElement("div");
  row.className = "kal-row kal-row-rich";

  const meta = document.createElement("div");
  meta.className = "kal-row-meta";
  const label = document.createElement("label");
  label.setAttribute("for", "kal-global-hotkey");
  label.textContent = "启用全局呼出 Win+Alt+C";
  const status = document.createElement("small");
  status.className = "kal-row-desc kal-tools-status";
  status.setAttribute("role", "status");
  meta.append(label, status);

  const ctl = document.createElement("div");
  ctl.className = "kal-row-ctl kal-row-ctl-end";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = "kal-global-hotkey";
  input.className = "kal-switch";
  input.setAttribute("aria-label", "启用全局呼出 Win+Alt+C");
  const retry = document.createElement("button");
  retry.className = "kal-btn kal-btn-ghost";
  retry.textContent = "重试注册";
  retry.type = "button";
  retry.hidden = true;
  ctl.append(retry, input);

  row.append(meta, ctl);
  card.append(row);
  section.append(heading, card);

  const generalSec = mount.querySelector("#kal-general-sec");
  if (generalSec && generalSec.nextSibling) {
    mount.insertBefore(section, generalSec.nextSibling);
  } else {
    mount.append(section);
  }

  function show(result) {
    input.checked = !!result.enabled;
    status.textContent = result.error ? sanitizeUserMessage(result.error) :
      result.registered ? `${result.shortcut} 已启用` : "全局快捷键未启用";
    status.classList.toggle("is-error", !!result.error);
    retry.hidden = !result.enabled || !!result.registered;
  }
  async function update(enabled) {
    input.disabled = true;
    retry.disabled = true;
    try { show(await bridge.desktopSetHotkey(enabled)); }
    catch (err) {
      status.textContent = sanitizeUserMessage(err?.message || String(err));
      status.classList.add("is-error");
      try { show(await bridge.desktopStatus()); } catch { /* 保留操作错误 */ }
    } finally { input.disabled = false; retry.disabled = false; }
  }
  input.addEventListener("change", () => update(input.checked));
  retry.addEventListener("click", () => update(true));
  input.disabled = true;
  if (bridge.kind !== "shell") {
    status.textContent = "随时按下快捷键快速呼出或隐藏日历窗口";
  } else {
    bridge.desktopStatus().then(show).catch(err => {
      status.textContent = sanitizeUserMessage(err?.message || String(err));
    }).finally(() => { input.disabled = false; });
  }
}
