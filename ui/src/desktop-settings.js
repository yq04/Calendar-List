import { sanitizeUserMessage } from "./write-state.js";

export function mountDesktopSettings({ mount, bridge }) {
  const section = document.createElement("details");
  section.className = "kal-sec kal-desktop-settings kal-tools-section";
  section.dataset.cat = "general";
  const heading = document.createElement("summary");
  heading.textContent = "桌面快捷操作";
  const label = document.createElement("label");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = "kal-global-hotkey";
  label.append(input, document.createTextNode(" 启用全局呼出 Win+Alt+C"));
  const hint = document.createElement("p");
  hint.textContent = "再次按快捷键或切换到其他窗口后，Kal 回到桌面。重复启动 Kal 也可呼出已有窗口。";
  const status = document.createElement("p");
  status.className = "kal-tools-status";
  status.setAttribute("role", "status");
  const retry = document.createElement("button");
  retry.className = "kal-btn kal-btn-ghost";
  retry.textContent = "重试注册";
  retry.type = "button";
  retry.hidden = true;
  section.append(heading, label, hint, status, retry);
  mount.append(section);

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
    status.textContent = "在 Kal 桌面应用中可启用全局快捷键";
  } else {
    bridge.desktopStatus().then(show).catch(err => {
      status.textContent = sanitizeUserMessage(err?.message || String(err));
    }).finally(() => { input.disabled = false; });
  }
}
