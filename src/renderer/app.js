/* ─────────────────────────────────────────────────────────── */
/* Messages                                                     */
/* ─────────────────────────────────────────────────────────── */

var msgTimer;
function showMsg(text, type) {
  const el = document.getElementById('p-msg');
  el.textContent = text;
  el.className = type;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => {
    el.className = '';
    el.textContent = '';
    if (panelOpen) requestAnimationFrame(pushBrowserView);
  }, 5000);
  if (panelOpen) requestAnimationFrame(pushBrowserView);
}

function clearMsg() {
  const el = document.getElementById('p-msg');
  el.className = '';
  el.textContent = '';
}

var TAB_ICONS = {
  ChatGPT: "icons/chatgpt.png",
  Claude: "icons/claude.png",
  Gemini: "icons/gemini.svg",
  DeepSeek: "icons/deepseek.png",
  Qwen: "icons/qwen.png",
  Perplexity: "icons/perplexity.png",
  Mistral: "icons/mistral.png",
  Kimi: "icons/kimi.png",
  Grok: "icons/grok.png",
  OpenClaw: "icons/openclaw.png",
};

function letterFor(name) {
  const ch = String(name || "?").trim().charAt(0);
  return ch ? ch.toUpperCase() : "?";
}

function faviconFor(service) {
  if (TAB_ICONS[service.id]) return TAB_ICONS[service.id];
  try {
    const url = new URL(service.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return `${url.origin}/favicon.ico`;
  } catch {
    return "";
  }
}

function serviceMark(service) {
  const mark = document.createElement("span");
  mark.className = "tab-mark";
  const src = faviconFor(service);
  if (!src) {
    mark.classList.add("tab-mark-letter");
    mark.textContent = letterFor(service.name);
    return mark;
  }
  const img = document.createElement("img");
  img.alt = "";
  img.draggable = false;
  img.src = src;
  img.addEventListener("error", () => {
    mark.textContent = letterFor(service.name);
    mark.classList.add("tab-mark-letter");
  });
  mark.appendChild(img);
  return mark;
}
/** @type {{ services: any[], hotkey: string, spellcheckLanguages: string[] }} */
var serviceState = { services: [], hotkey: "", spellcheckLanguages: [] };

function visibleServices() {
  return (serviceState.services || []).filter((item) => !item.hidden);
}

function appendServiceTab(root, service, local) {
  const tab = document.createElement("div");
  tab.className = local ? "tab tab-local" : "tab";
  tab.dataset.name = service.id;
  if (service.id === activeTabName) tab.classList.add("active");
  tab.title = local ? "OpenClaw, on this computer" : service.name;
  const icon = serviceMark(service);
  const label = document.createElement("span");
  label.textContent = service.name;
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  tab.append(icon, label, spinner);
  tab.addEventListener("click", () => switchTab(service.id));
  root.appendChild(tab);
}

function renderServiceTabs() {
  const root = document.getElementById("tabs");
  if (!root) return;
  const visible = visibleServices();
  const remote = visible.filter((service) => service.id !== "OpenClaw");
  const local = visible.filter((service) => service.id === "OpenClaw");
  root.textContent = "";
  remote.forEach((service) => appendServiceTab(root, service, false));
  if (remote.length && local.length) {
    const gap = document.createElement("div");
    gap.className = "tab-gap";
    gap.setAttribute("aria-hidden", "true");
    root.appendChild(gap);
  }
  local.forEach((service) => appendServiceTab(root, service, true));
  renderAccountSwitch();
}

function activeServiceRecord() {
  return (serviceState.services || []).find((item) => item.id === activeTabName) || null;
}

function renderAccountSwitch() {
  const wrap = document.getElementById("account-switch");
  const button = document.getElementById("account-menu");
  const service = activeServiceRecord();
  if (!wrap || !button || !service || service.id === "OpenClaw") {
    if (wrap) wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const current = (service.accounts || []).find((account) => account.id === service.activeAccountId);
  button.textContent = (current && current.label) || "Account";
}

async function setAccountRoute(serviceId, accountId, route) {
  const result = await window.electronAPI.servicesSetRoute({ id: serviceId, accountId: accountId, route: route });
  if (result && result.needsConfirm) {
    const proceed = window.confirm("This account will see a country change.");
    if (!proceed) {
      renderServiceSettings();
      return;
    }
    await window.electronAPI.servicesSetRoute({
      id: serviceId,
      accountId: accountId,
      route: route,
      confirm: true,
    });
  }
}

function renderServiceSettings() {
  const root = document.getElementById("p-services");
  if (!root) return;
  root.textContent = "";
  (serviceState.services || []).forEach((service, index, list) => {
    const accounts = service.id === "OpenClaw" ? [null] : (service.accounts || []);
    accounts.forEach((account, accountIndex) => {
      const row = document.createElement("div");
      row.className = "svc-row";
      if (accountIndex === 0) {
        const shown = document.createElement("input");
        shown.type = "checkbox";
        shown.checked = !service.hidden;
        shown.title = "Show tab";
        shown.addEventListener("change", () => {
          void window.electronAPI.servicesSetHidden({ id: service.id, hidden: !shown.checked });
        });
        row.appendChild(shown);
      }
      const name = document.createElement("span");
      const several = service.accounts && service.accounts.length > 1 && account;
      name.textContent = several ? (service.name + " · " + (account.label || "Account")) : service.name;
      row.appendChild(name);
      if (account) {
        const route = document.createElement("select");
        route.setAttribute("aria-label", name.textContent + " route");
        ["tunnel", "direct"].forEach((value) => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = value === "tunnel" ? "Tunnel" : "Direct";
          option.selected = account.route === value;
          route.appendChild(option);
        });
        route.addEventListener("change", () => {
          void setAccountRoute(service.id, account.id, route.value);
        });
        row.appendChild(route);
      }
      if (accountIndex === 0) {
        const up = document.createElement("button");
        up.type = "button";
        up.textContent = "Up";
        up.disabled = index === 0;
        up.addEventListener("click", () => moveService(index, -1));
        const down = document.createElement("button");
        down.type = "button";
        down.textContent = "Down";
        down.disabled = index === list.length - 1;
        down.addEventListener("click", () => moveService(index, 1));
        row.append(up, down);
        if (!service.builtin) {
          const remove = document.createElement("button");
          remove.type = "button";
          remove.textContent = "Remove";
          remove.addEventListener("click", () => {
            void window.electronAPI.servicesRemoveCustom(service.id);
          });
          row.appendChild(remove);
        }
      }
      root.appendChild(row);
    });
  });
  const hotkey = document.getElementById("hotkey-input");
  if (hotkey && document.activeElement !== hotkey) hotkey.value = serviceState.hotkey || "";
  const spell = document.getElementById("spellcheck-input");
  if (spell && document.activeElement !== spell) {
    spell.value = (serviceState.spellcheckLanguages || []).join(", ");
  }
}

function moveService(index, delta) {
  const ids = (serviceState.services || []).map((item) => item.id);
  const next = index + delta;
  if (next < 0 || next >= ids.length) return;
  const [item] = ids.splice(index, 1);
  ids.splice(next, 0, item);
  void window.electronAPI.servicesReorder(ids);
}

function onServices(status) {
  if (!status || !Array.isArray(status.services)) return;
  serviceState = status;
  renderServiceTabs();
  renderServiceSettings();
  if (panelOpen) requestAnimationFrame(pushBrowserView);
}

function initServices() {
  if (!window.electronAPI || !window.electronAPI.onServices) return;
  window.electronAPI.onServices(onServices);
  window.electronAPI.servicesList().then(onServices).catch(() => {});
  const menu = document.getElementById("account-menu");
  if (menu && window.electronAPI.showAccountMenu) {
    menu.addEventListener("click", () => {
      if (!activeTabName) return;
      window.electronAPI.showAccountMenu();
    });
  }
  if (window.electronAPI.onAccountAdd) {
    window.electronAPI.onAccountAdd(() => {
      if (!activeTabName) return;
      const label = window.prompt("Name this account", "Work");
      if (!label) return;
      void window.electronAPI.servicesAddAccount({ id: activeTabName, label });
    });
  }
  const custom = document.getElementById("custom-add");
  if (custom) {
    custom.addEventListener("click", async () => {
      const name = document.getElementById("custom-name").value;
      const url = document.getElementById("custom-url").value;
      const result = await window.electronAPI.servicesAddCustom({ name, url });
      if (result && result.success) {
        document.getElementById("custom-name").value = "";
        document.getElementById("custom-url").value = "";
      } else if (result && result.error) {
        showMsg(result.error, "err");
      }
    });
  }
  const hotkey = document.getElementById("hotkey-save");
  if (hotkey) {
    hotkey.addEventListener("click", async () => {
      const result = await window.electronAPI.servicesSetHotkey(document.getElementById("hotkey-input").value.trim());
      if (result && result.error) showMsg(result.error, "err");
    });
  }
  const spell = document.getElementById("spellcheck-save");
  if (spell) {
    spell.addEventListener("click", async () => {
      const languages = document.getElementById("spellcheck-input").value.split(",").map((item) => item.trim()).filter(Boolean);
      const result = await window.electronAPI.servicesSetSpellcheck(languages);
      if (result && result.error) showMsg(result.error, "err");
    });
  }
}

function setBar(id, show) {
  const bar = document.getElementById(id);
  if (!bar || bar.hidden === !show) {
    layoutInset();
    return;
  }
  bar.hidden = !show;
  layoutInset();
}

function initFind() {
  const input = document.getElementById("find-input");
  const bar = document.getElementById("find-bar");
  if (!input || !bar || !window.electronAPI.onFindOpen) return;
  window.electronAPI.onFindOpen(() => {
    setBar("find-bar", true);
    input.focus();
    input.select();
  });
  input.addEventListener("input", () => {
    void window.electronAPI.findInPage(input.value, false);
  });
  document.getElementById("find-next").addEventListener("click", () => {
    void window.electronAPI.findInPage(input.value, true);
  });
  document.getElementById("find-close").addEventListener("click", () => {
    setBar("find-bar", false);
    void window.electronAPI.findStop();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void window.electronAPI.findInPage(input.value, true);
    }
    if (event.key === "Escape") {
      setBar("find-bar", false);
      void window.electronAPI.findStop();
    }
  });
}

function initCompare() {
  if (!window.electronAPI.onCompare) return;
  window.electronAPI.onCompare((status) => {
    const title = document.getElementById("compare-title");
    if (title) title.textContent = status && status.title ? status.title : "Compare";
    setBar("compare-bar", Boolean(status && status.open));
  });
  document.getElementById("compare-insert").addEventListener("click", () => {
    void window.electronAPI.compareInsert();
  });
  document.getElementById("compare-close").addEventListener("click", () => {
    void window.electronAPI.compareStop();
  });
}

async function checkOpenClawUpdate() {
  if (!window.electronAPI.openclawUpdateStatus) return;
  const status = await window.electronAPI.openclawUpdateStatus();
  const bar = document.getElementById("oc-update-bar");
  const text = document.getElementById("oc-update-text");
  if (!bar || !text) return;
  if (!status || !status.available || activeTabName !== "OpenClaw") {
    bar.hidden = true;
    layoutInset();
    return;
  }
  text.textContent = "OpenClaw " + (status.version || "") + " is ready.";
  bar.hidden = false;
  layoutInset();
}

async function runOpenClawUpdate() {
  const bar = document.getElementById("oc-update-bar");
  const text = document.getElementById("oc-update-text");
  const action = document.getElementById("oc-update-action");
  if (!bar || !text || !action || !window.electronAPI.openclawUpdate) return;
  const proceed = window.confirm("AI Hub will run: openclaw update --yes --json --timeout 600");
  if (!proceed) return;
  action.disabled = true;
  text.textContent = "Updating OpenClaw…";
  try {
    const result = await window.electronAPI.openclawUpdate();
    if (!result || !result.success) {
      text.textContent = (result && result.error) || "OpenClaw could not be updated.";
      action.disabled = false;
      return;
    }
    bar.hidden = true;
    layoutInset();
  } catch (err) {
    text.textContent = "OpenClaw could not be updated.";
    action.disabled = false;
  }
}

function initUpdates() {
  const action = document.getElementById("hub-update");
  if (!action || !window.electronAPI.onUpdateAvailable) return;
  let installAfterDownload = false;
  const show = (label, mode, disabled) => {
    action.hidden = false;
    action.textContent = label;
    action.dataset.mode = mode;
    action.disabled = Boolean(disabled);
  };
  window.electronAPI.onUpdateAvailable((info) => {
    installAfterDownload = false;
    const version = info && info.version ? " " + info.version : "";
    show("Update AI Hub" + version, "download", false);
  });
  window.electronAPI.onUpdateDownloaded(() => {
    if (installAfterDownload) {
      installAfterDownload = false;
      show("Installing…", "install", true);
      void window.electronAPI.updateInstall();
      return;
    }
    show("Restart to update", "install", false);
  });
  if (window.electronAPI.onUpdateFailed) {
    window.electronAPI.onUpdateFailed(() => {
      installAfterDownload = false;
      show("Update failed", "download", false);
    });
  }
  action.addEventListener("click", () => {
    if (action.dataset.mode === "install") {
      show("Installing…", "install", true);
      void window.electronAPI.updateInstall();
      return;
    }
    installAfterDownload = true;
    show("Downloading…", "download", true);
    void window.electronAPI.updateDownload().then((result) => {
      if (result && result.success) return;
      installAfterDownload = false;
      show("Update failed", "download", false);
    });
  });
}

function initWindowDrag() {
  const toolbar = document.getElementById("toolbar");
  if (!toolbar || !window.electronAPI.moveWindowBy) return;
  let drag = null;
  toolbar.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (target && target.closest && target.closest("button, a, input, select, .tab, #account-switch, #hub-update, #vpn-area")) return;
    drag = { x: event.screenX, y: event.screenY };
  });
  window.addEventListener("mousemove", (event) => {
    if (!drag) return;
    const dx = event.screenX - drag.x;
    const dy = event.screenY - drag.y;
    drag = { x: event.screenX, y: event.screenY };
    window.electronAPI.moveWindowBy(dx, dy);
  });
  window.addEventListener("mouseup", () => { drag = null; });
}

applyTheme(themePreference);
refreshExtensions();
initWireguard();
initServices();
initFind();
initCompare();
initUpdates();
initWindowDrag();
var ocUpdate = document.getElementById("oc-update-action");
if (ocUpdate) ocUpdate.addEventListener("click", () => { void runOpenClawUpdate(); });
layoutInset();

document.getElementById("reload-btn").addEventListener("click", () => reloadPage(false));
document.getElementById("hard-reload-btn").addEventListener("click", () => reloadPage(true));
document.getElementById("theme-btn").addEventListener("click", () => toggleTheme());
document.getElementById("vpn-btn").addEventListener("click", () => toggleVpnPanel());
document.getElementById("oc-install").addEventListener("click", () => { void installOpenClaw(); });
document.getElementById("oc-start").addEventListener("click", () => { void startOpenClaw(); });
document.getElementById("oc-refresh").addEventListener("click", () => refreshOpenClaw());
document.getElementById("vpn-overlay").addEventListener("click", () => closeVpnPanel());
document.getElementById("p-wg-import").addEventListener("click", () => importWireguard());
document.getElementById("p-wg-disconnect").addEventListener("click", () => disconnectWireguard());
