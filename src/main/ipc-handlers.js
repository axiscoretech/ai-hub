const { BrowserWindow, Menu, ipcMain } = require("electron");
const { handle } = require("./ipc-bind");

function registerMainIpc(live) {
  ipcMain.on("switch-tab", (_event, tabName) => {
    void live.handleSwitchTab(tabName);
  });

  ipcMain.on("show-account-menu", (event) => {
    const serviceId = live.activeTab;
    if (!serviceId || serviceId === live.OPENCLAW_TAB || !live.win || live.win.isDestroyed()) return;
    const service = live.services.list().live.services.find((item) => item.id === serviceId);
    if (!service || !service.accounts.length) return;
    const menu = Menu.buildFromTemplate([
      ...service.accounts.map((account) => ({
        label: account.label || "Account",
        type: "radio",
        checked: account.id === service.activeAccountId,
        click: () => {
          void live.services.setActiveAccount(serviceId, account.id).then(() => {
            if (live.tabs[serviceId]) live.switchTab(serviceId);
          });
        },
      })),
      { type: "separator" },
      {
        label: "Add account",
        click: () => event.sender.send("account-add"),
      },
    ]);
    const parent = BrowserWindow.fromWebContents(event.sender) || live.win;
    menu.popup({ window: parent });
  });

  handle("services-list", () => live.services.list());

  handle("services-set-route", async (_event, payload) => {
    try {
      const id = payload && payload.id;
      const accountId = (payload && payload.accountId) || live.services.activeAccountId(id);
      const next = payload && payload.route === "direct" ? "direct" : "tunnel";
      if (live.services.route(id, accountId) !== next && !(payload && payload.confirm)) {
        if (await live.profileSawSite(id, accountId)) {
          return { success: false, needsConfirm: true, status: live.services.list() };
        }
      }
      const status = await live.services.setRoute(id, next, accountId);
      const account = live.services.accounts().find((item) => item.serviceId === id && item.accountId === accountId);
      if (account) {
        const target = await live.configureAccountProxy(account);
        if (!live.shouldKeepConnections(account.partition)) await target.closeAllConnections().catch(() => {});
      }
      return { success: true, status };
    }
    catch (err) { return { success: false, error: err.message, status: live.services.list() }; }
  });

  handle("services-set-hidden", async (_event, payload) => {
    try { return { success: true, status: await live.services.setHidden(payload && payload.id, payload && payload.hidden) }; }
    catch (err) { return { success: false, error: err.message, status: live.services.list() }; }
  });

  handle("services-reorder", async (_event, ids) => {
    try { return { success: true, status: await live.services.reorder(ids) }; }
    catch (err) { return { success: false, error: err.message, status: live.services.list() }; }
  });

  handle("services-add-account", async (_event, payload) => {
    try {
      const status = await live.services.addAccount(payload && payload.id, payload && payload.label);
      const id = payload && payload.id;
      if (id && live.tabs[id]) live.switchTab(id);
      return { success: true, status };
    } catch (err) {
      return { success: false, error: err.message, status: live.services.list() };
    }
  });

  handle("services-set-account", async (_event, payload) => {
    try {
      const status = await live.services.setActiveAccount(payload && payload.id, payload && payload.accountId);
      const id = payload && payload.id;
      if (id && live.tabs[id]) live.switchTab(id);
      return { success: true, status };
    } catch (err) {
      return { success: false, error: err.message, status: live.services.list() };
    }
  });

  handle("services-set-label", async (_event, payload) => {
    try {
      return { success: true, status: await live.services.setAccountLabel(payload && payload.id, payload && payload.accountId, payload && payload.label) };
    } catch (err) {
      return { success: false, error: err.message, status: live.services.list() };
    }
  });

  handle("services-remove-account", async (_event, payload) => {
    try { return { success: true, status: await live.services.removeAccount(payload && payload.id, payload && payload.accountId) }; }
    catch (err) { return { success: false, error: err.message, status: live.services.list() }; }
  });

  handle("services-add-custom", async (_event, payload) => {
    try { return { success: true, status: await live.services.addCustom(payload && payload.name, payload && payload.url) }; }
    catch (err) { return { success: false, error: err.message, status: live.services.list() }; }
  });

  handle("services-remove-custom", async (_event, id) => {
    try { return { success: true, status: await live.services.removeCustom(id) }; }
    catch (err) { return { success: false, error: err.message, status: live.services.list() }; }
  });

  handle("services-set-hotkey", async (_event, hotkey) => {
    try {
      const status = await live.services.setHotkey(hotkey);
      live.registerHotkey();
      return { success: true, status };
    } catch (err) {
      return { success: false, error: err.message, status: live.services.list() };
    }
  });

  handle("services-set-spellcheck", async (_event, languages) => {
    try {
      const status = await live.services.setSpellcheckLanguages(languages);
      live.applySpellcheck();
      return { success: true, status };
    } catch (err) {
      return { success: false, error: err.message, status: live.services.list() };
    }
  });

  handle("find-in-page", (_event, text, findNext) => {
    const view = live.activeTab && live.views[live.activeTab];
    if (!live.isViewUsable(view) || !text) return { success: false };
    view.webContents.findInPage(String(text), { forward: true, findNext: Boolean(findNext) });
    return { success: true };
  });

  handle("find-stop", () => {
    const view = live.activeTab && live.views[live.activeTab];
    if (live.isViewUsable(view)) view.webContents.stopFindInPage("clearSelection");
    return { success: true };
  });


  ipcMain.on("move-window-by", (_event, dx, dy) => {
    if (!live.win || live.win.isDestroyed()) return;
    const x = Number(dx);
    const y = Number(dy);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const [left, top] = live.win.getPosition();
    live.win.setPosition(Math.round(left + x), Math.round(top + y));
  });

  ipcMain.on("set-topbar-height", (_event, h) => {
    const next = Number(h);
    if (!Number.isFinite(next) || next < 0 || next > 4000) return;
    live.topBarHeight = next;
    if (live.compareOpen) {
      live.layoutCompare();
      return;
    }
    if (live.isBoardWorkspace()) return;
    if (live.activeTab && live.isViewUsable(live.views[live.activeTab])) live.resizeView(live.views[live.activeTab]);
  });

  handle("set-proxy", async (_event, config) => {
    await live.wireguard.stopForExternalProxy();
    await live.applyHubProxy(config);
    return { success: true };
  });

  handle("clear-proxy", async () => {
    await live.wireguard.stopForExternalProxy();
    await live.clearHubProxy();
    return { success: true };
  });

  handle("wg-list", () => live.wireguard.list());

  handle("wg-import", () => live.wireguard.importConfigs());

  handle("wg-remove", async (_event, id) => {
    try {
      return await live.wireguard.remove(id);
    } catch (err) {
      return { success: false, error: err.message, status: live.wireguard.status() };
    }
  });

  handle("wg-connect", async (_event, id) => {
    try {
      const status = await live.wireguard.connect(id);
      return { success: true, status };
    } catch (err) {
      return { success: false, error: err.message, status: live.wireguard.status() };
    }
  });

  handle("tunnel-cancel", () => live.cancelTunnelStartup());

  handle("wg-disconnect", async () => {
    try {
      return await live.wireguard.disconnect();
    } catch (err) {
      return { success: false, error: err.message, status: live.wireguard.status() };
    }
  });

  ipcMain.on("reload-active-tab", (_event, ignoreCache) => {
    live.reloadActiveTab(Boolean(ignoreCache));
  });

  handle("reset-tab-session", async (_event, tabName) => {
    try {
      if (!live.tabs[tabName]) throw new Error("Unknown tab");
      await live.resetTabSession(tabName);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.on("open-external", (_event, url) => live.shell.openExternal(url));

  handle("tasks-list", () => {
    try {
      return live.tasks.list();
    } catch (err) {
      return live.taskIpcError(err);
    }
  });

  handle("tasks-create", async (_event, payload) => {
    try { return await live.tasks.create(payload); } catch (err) { return live.taskIpcError(err); }
  });

  handle("tasks-update", async (_event, payload) => {
    try { return await live.tasks.update(payload); } catch (err) { return live.taskIpcError(err); }
  });

  handle("tasks-delete", async (_event, id) => {
    try { return await live.tasks.delete(id); } catch (err) { return live.taskIpcError(err); }
  });

  handle("tasks-set-status", async (_event, payload) => {
    try { return await live.tasks.setStatus(payload); } catch (err) { return live.taskIpcError(err); }
  });

  handle("tasks-add-assignment", async (_event, payload) => {
    try { return await live.tasks.addAssignment(payload); } catch (err) { return live.taskIpcError(err); }
  });

  handle("tasks-remove-assignment", async (_event, payload) => {
    try { return await live.tasks.removeAssignment(payload); } catch (err) { return live.taskIpcError(err); }
  });

  handle("tasks-open", async (_event, payload) => {
    try {
      const result = await live.tasks.open(payload);
      if (result && result.success) live.showTaskService(result.status);
      return result;
    } catch (err) {
      return live.taskIpcError(err);
    }
  });

  handle("tasks-set-workspace", async (_event, workspace) => {
    try {
      return await live.commitWorkspace(workspace);
    } catch (err) {
      return live.taskIpcError(err);
    }
  });

  handle("tasks-toggle-workspace", async () => {
    try {
      return await live.toggleWorkspace();
    } catch (err) {
      return live.taskIpcError(err);
    }
  });

  handle("tasks-clear-capture", async () => {
    try { return await live.tasks.clearCapture(); } catch (err) { return live.taskIpcError(err); }
  });

}

module.exports = { registerMainIpc };
