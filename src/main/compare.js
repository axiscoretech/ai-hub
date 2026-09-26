const { globalShortcut, clipboard } = require("electron");
const { handle } = require("./ipc-bind");

function createCompare(options = {}) {
  const state = {
    get win() { return options.window(); },
    get views() { return options.views(); },
    get tabs() { return options.tabs(); },
    get activeTab() { return options.getActiveTab(); },
    get topBarHeight() { return options.getTopBarHeight(); },
    get compareOpen() { return options.getCompareOpen(); },
    set compareOpen(value) { options.setCompareOpen(value); },
    get compareSlots() { return options.getCompareSlots(); },
    set compareSlots(value) { options.setCompareSlots(value); },
    get compareFocus() { return options.getCompareFocus(); },
    set compareFocus(value) { options.setCompareFocus(value); },
    get compareTaskId() { return options.getCompareTaskId(); },
    set compareTaskId(value) { options.setCompareTaskId(value); },
    get registeredHotkey() { return options.getHotkey(); },
    set registeredHotkey(value) { options.setHotkey(value); },
  };
  const tasks = options.tasks;
  const services = options.services;
  const isViewUsable = options.isViewUsable || (() => false);
  const isBoardWorkspace = options.isBoardWorkspace || (() => false);
  const takeAccountView = options.takeAccountView;
  const createTab = options.createTab;
  const showPageView = options.showPageView || (() => {});
  const hideOtherPageViews = options.hideOtherPageViews || (() => {});
  const detachPageView = options.detachPageView || (() => {});
  const switchTab = options.switchTab;
  const acceptedServiceUrl = options.acceptedServiceUrl || (() => null);

  function layoutCompare() {
    if (!state.compareOpen || !state.win || state.win.isDestroyed()) return;
    const [width, height] = state.win.getContentSize();
    const count = state.compareSlots.length || 1;
    const col = Math.floor(width / count);
    state.compareSlots.forEach((slot, index) => {
      if (!isViewUsable(slot.view)) return;
      try { showPageView(slot.view, { keepOthers: true }); } catch {}
      try {
        slot.view.setBounds({
          x: index * col,
          y: state.topBarHeight,
          width: index === count - 1 ? width - index * col : col,
          height: Math.max(0, height - state.topBarHeight),
        });
      } catch {}
    });
  }

  function closeCompare(options = {}) {
    if (!state.compareOpen && !state.compareSlots.length) return;
    state.compareOpen = false;
    state.compareFocus = null;
    state.compareTaskId = null;
    for (const slot of state.compareSlots) {
      try { detachPageView(slot.view); } catch {}
    }
    state.compareSlots = [];
    if (state.win && !state.win.isDestroyed()) state.win.webContents.send("compare-status", { open: false });
    if (options.restore !== false && state.activeTab && state.tabs[state.activeTab]) switchTab(state.activeTab);
  }

  async function startCompare(taskId) {
    const status = tasks.list();
    const task = (status.tasks || []).find((item) => item.id === taskId);
    if (!task) return { success: false, error: "Unknown task" };
    const picks = (task.assignments || []).slice(0, 3);
    if (picks.length < 2) return { success: false, error: "Choose at least two services" };
    if (isBoardWorkspace()) {
      try { await tasks.setWorkspace("chat"); } catch {}
    }
    for (const slot of state.compareSlots) {
      try { detachPageView(slot.view); } catch {}
    }
    state.compareSlots = [];
    state.compareTaskId = task.id;
    for (const assignment of picks) {
      services.useAccount(assignment.service, assignment.accountId || "default");
      takeAccountView(assignment.service);
      if (!isViewUsable(state.views[assignment.service])) {
        const saved = acceptedServiceUrl(assignment.service, assignment.url);
        createTab(assignment.service, saved || state.tabs[assignment.service], { background: true });
      }
      const view = state.views[assignment.service];
      if (!isViewUsable(view)) continue;
      if (!view.compareFocusHooked) {
        view.compareFocusHooked = true;
        view.webContents.on("focus", () => { state.compareFocus = view.webContents; });
      }
      state.compareSlots.push({ service: assignment.service, view });
    }
    if (state.win && !state.win.isDestroyed()) {
      try { hideOtherPageViews(null); } catch {}
    }
    state.compareOpen = state.compareSlots.length >= 2;
    if (!state.compareOpen) return { success: false, error: "Couldn't open those services" };
    layoutCompare();
    if (state.win && !state.win.isDestroyed()) {
      state.win.webContents.send("compare-status", { open: true, title: task.title, taskId: task.id });
    }
    return { success: true };
  }

  const FOCUS_COMPOSER_SCRIPT = `(() => {
    const nodes = [...document.querySelectorAll("textarea, [contenteditable]")];
    const visible = nodes.filter((el) => {
      if (el.getAttribute("contenteditable") === "false") return false;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 40 && rect.height > 16 && rect.bottom > 0 && rect.top < window.innerHeight;
    });
    if (!visible.length) return false;
    visible.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    visible[0].focus();
    return true;
  })()`;

  async function insertIntoComposer(contents, text) {
    if (!contents || contents.isDestroyed() || !text) return false;
    try { contents.focus(); } catch { return false; }
    let focused = false;
    try { focused = await contents.executeJavaScript(FOCUS_COMPOSER_SCRIPT, true); } catch { focused = false; }
    if (!focused) return false;
    try { contents.insertText(text); } catch { return false; }
    return true;
  }

  async function insertCompareText() {
    const status = tasks.list();
    const task = (status.tasks || []).find((item) => item.id === state.compareTaskId);
    if (!task) return { success: false, error: "Unknown task" };
    const text = task.prompt || task.title || "";
    const contents = state.compareFocus && !state.compareFocus.isDestroyed()
      ? state.compareFocus
      : (state.compareSlots[0] && isViewUsable(state.compareSlots[0].view) ? state.compareSlots[0].view.webContents : null);
    if (!contents || contents.isDestroyed()) return { success: false, error: "Click a chat first" };
    const inserted = await insertIntoComposer(contents, text);
    if (!inserted) return { success: false, error: "Click the message box first" };
    return { success: true };
  }

  function registerHotkey() {
    if (state.registeredHotkey) {
      try { globalShortcut.unregister(state.registeredHotkey); } catch {}
      state.registeredHotkey = "";
    }
    const accel = services.hotkey();
    if (!accel) return;
    const ok = globalShortcut.register(accel, () => {
      if (!state.win || state.win.isDestroyed()) return;
      const text = clipboard.readText();
      state.win.show();
      state.win.focus();
      const name = state.activeTab && state.tabs[state.activeTab] ? state.activeTab : "ChatGPT";
      switchTab(name);
      const view = state.views[name];
      if (!text || !isViewUsable(view)) return;
      void insertIntoComposer(view.webContents, text);
    });
    if (ok) state.registeredHotkey = accel;
  }

  handle("compare-start", async (_event, taskId) => {
    try { return await startCompare(taskId); }
    catch (err) { return { success: false, error: err.message }; }
  });

  handle("compare-insert", () => insertCompareText());

  handle("compare-stop", () => {
    closeCompare({ restore: true });
    return { success: true };
  });

  return {
    layoutCompare,
    closeCompare,
    startCompare,
    insertCompareText,
    registerHotkey,
  };
}

module.exports = { createCompare };
