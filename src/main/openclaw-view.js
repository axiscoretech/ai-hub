const { session } = require("electron");
const { handle } = require("./ipc-bind");
const {
  inspectOpenClaw,
  startOpenClawGateway,
  openClawDashboard,
  openClawUpdateStatus,
  updateOpenClaw,
  installOpenClaw,
  probeGateway,
} = require("./openclaw");

function createOpenClawView(options = {}) {
  const state = {
    get win() { return options.window(); },
    get views() { return options.views(); },
    get activeTab() { return options.getActiveTab(); },
    set activeTab(value) { options.setActiveTab(value); },
    get openclawSnapshot() { return options.getSnapshot(); },
    set openclawSnapshot(value) { options.setSnapshot(value); },
    get openclawAuthedUrl() { return options.getAuthedUrl(); },
    set openclawAuthedUrl(value) { options.setAuthedUrl(value); },
    get openclawAuthPromise() { return options.getAuthPromise(); },
    set openclawAuthPromise(value) { options.setAuthPromise(value); },
    get openclawPresentPromise() { return options.getPresentPromise(); },
    set openclawPresentPromise(value) { options.setPresentPromise(value); },
    get tabs() { return options.tabs(); },
  };
  const createTab = options.createTab;
  const isViewUsable = options.isViewUsable || (() => false);
  const isBoardWorkspace = options.isBoardWorkspace || (() => false);
  const showPageView = options.showPageView || (() => {});
  const detachView = options.detachView || (() => {});
  const partitionForTab = options.partitionForTab || ((name) => `persist:${name}`);
  const tasks = options.tasks;
  const OPENCLAW_TAB = options.openClawTab || "OpenClaw";

  function hideOpenClawView() {
    detachView(OPENCLAW_TAB);
  }

  function openClawUrlHasToken(url) {
    try {
      return new URL(url).hash.includes("token=");
    } catch {
      return false;
    }
  }

  function ensureOpenClawView(targetUrl, forceLoad) {
    if (!state.win || state.win.isDestroyed()) return;
    const url = targetUrl || state.tabs[OPENCLAW_TAB];
    if (!isViewUsable(state.views[OPENCLAW_TAB])) {
      createTab(OPENCLAW_TAB, url);
      if (state.views[OPENCLAW_TAB]) {
        if (openClawUrlHasToken(url)) state.views[OPENCLAW_TAB].openclawBootstrapped = true;
        concealOpenClawChrome(state.views[OPENCLAW_TAB].webContents);
      }
      return;
    }

    const view = state.views[OPENCLAW_TAB];
    state.activeTab = OPENCLAW_TAB;
    if (!isBoardWorkspace()) showPageView(view);

    let current = "";
    try { current = view.webContents.getURL(); } catch {}
    let needsLoad = Boolean(forceLoad) || !current || current === "about:blank" || current.startsWith("chrome-error://");
    if (!needsLoad && openClawUrlHasToken(url) && !openClawUrlHasToken(current) && !view.openclawBootstrapped) {
      needsLoad = true;
    }
    if (!needsLoad && !forceLoad) {
      try {
        needsLoad = new URL(current).origin !== new URL(url).origin;
      } catch {
        needsLoad = true;
      }
    }
    if (needsLoad) {
      if (view.openclawLoadPending) {
        concealOpenClawChrome(view.webContents);
        return;
      }
      view.openclawLoadPending = true;
      void session.fromPartition(partitionForTab(OPENCLAW_TAB)).setProxy({ mode: "direct" }).catch(() => {}).then(() => {
        if (!isViewUsable(view)) return;
        if (openClawUrlHasToken(url)) view.openclawBootstrapped = true;
        view.webContents.loadURL(url);
        concealOpenClawChrome(view.webContents);
      });
      return;
    }
    concealOpenClawChrome(view.webContents);
  }

  function concealOpenClawChrome(webContents) {
    if (!webContents || webContents.isDestroyed()) return;
    const hideBanner = () => {
      if (webContents.isDestroyed()) return;
      webContents.insertCSS("openclaw-update-banner,.update-banner{display:none !important}").catch(() => {});
      webContents.executeJavaScript(`(() => {
        const hide = () => {
          document.querySelectorAll("openclaw-update-banner, .update-banner").forEach((node) => {
            node.style.setProperty("display", "none", "important");
          });
        };
        hide();
        if (!window.__aiHubHideOpenClawUpdate) {
          window.__aiHubHideOpenClawUpdate = new MutationObserver(hide);
          window.__aiHubHideOpenClawUpdate.observe(document.documentElement, { childList: true, subtree: true });
        }
      })()`, true).catch(() => {});
    };
    hideBanner();
    if (webContents.openclawBannerHook) return;
    webContents.openclawBannerHook = true;
    webContents.on("did-finish-load", hideBanner);
    webContents.on("dom-ready", hideBanner);
  }

  function cacheOpenClawAuth(url) {
    if (openClawUrlHasToken(url)) state.openclawAuthedUrl = url;
  }

  function loadOpenClawAuth() {
    if (state.openclawAuthedUrl) return Promise.resolve(state.openclawAuthedUrl);
    if (!state.openclawAuthPromise) {
      state.openclawAuthPromise = openClawDashboard().then((page) => {
        state.openclawAuthPromise = null;
        if (page && page.authed && openClawUrlHasToken(page.url)) {
          state.openclawAuthedUrl = page.url;
          return state.openclawAuthedUrl;
        }
        return "";
      }, () => {
        state.openclawAuthPromise = null;
        return "";
      });
    }
    return state.openclawAuthPromise;
  }

  function presentOpenClawPage() {
    if (state.openclawPresentPromise) return state.openclawPresentPromise;
    state.openclawPresentPromise = presentOpenClawPageOnce().finally(() => {
      state.openclawPresentPromise = null;
    });
    return state.openclawPresentPromise;
  }

  async function presentOpenClawPageOnce() {
    if (!state.win || state.win.isDestroyed() || state.activeTab !== OPENCLAW_TAB || isBoardWorkspace()) {
      hideOpenClawView();
      return false;
    }
    const existing = state.views[OPENCLAW_TAB];
    if (isViewUsable(existing) && existing.openclawBootstrapped) {
      ensureOpenClawView(state.openclawAuthedUrl || state.tabs[OPENCLAW_TAB], false);
      return true;
    }
    const url = state.openclawAuthedUrl || await loadOpenClawAuth();
    if (state.activeTab !== OPENCLAW_TAB || isBoardWorkspace()) return false;
    if (!url) {
      hideOpenClawView();
      return false;
    }
    cacheOpenClawAuth(url);
    ensureOpenClawView(url, true);
    return true;
  }

  function notifyOpenClawPage(ready) {
    if (state.win && !state.win.isDestroyed()) state.win.webContents.send("openclaw-page", { ready: Boolean(ready) });
  }

  function applyOpenClawSnapshot(status) {
    state.openclawSnapshot = status;
    if (!state.win || state.win.isDestroyed() || state.activeTab !== OPENCLAW_TAB) return status;
    if (isBoardWorkspace()) {
      hideOpenClawView();
      return status;
    }
    const view = state.views[OPENCLAW_TAB];
    const opening = Boolean(state.openclawPresentPromise) || Boolean(view && view.openclawBootstrapped);
    if ((!status || !status.gatewayUp) && !opening) hideOpenClawView();
    return status;
  }

  handle("openclaw-probe", async () => {
    const url = state.openclawSnapshot && state.openclawSnapshot.url;
    const up = await probeGateway(url);
    return { gatewayUp: Boolean(up) };
  });

  handle("openclaw-status", async () => {
    const status = await inspectOpenClaw();
    applyOpenClawSnapshot(status);
    if (status && status.gatewayUp && state.activeTab === OPENCLAW_TAB && !isBoardWorkspace()) {
      status.pageReady = await presentOpenClawPage();
      if (!status.pageReady) {
        status.error = "OpenClaw is running, but this window could not open its page. Check again.";
      }
    }
    return status;
  });

  handle("openclaw-start", async () => {
    const result = await startOpenClawGateway();
    applyOpenClawSnapshot(result.status);
    if (result.status && result.status.gatewayUp && state.activeTab === OPENCLAW_TAB) {
      const opened = await presentOpenClawPage();
      if (result.status) result.status.pageReady = opened;
    }
    return {
      success: Boolean(result.status && result.status.gatewayUp),
      error: null,
      status: result.status,
    };
  });

  handle("openclaw-install", async () => {
    const installed = await installOpenClaw();
    if (!installed || !installed.success) {
      return { success: false, error: (installed && installed.error) || "OpenClaw could not be installed." };
    }
    const result = await startOpenClawGateway();
    applyOpenClawSnapshot(result.status);
    if (result.status && result.status.gatewayUp && state.activeTab === OPENCLAW_TAB) {
      const opened = await presentOpenClawPage();
      if (result.status) result.status.pageReady = opened;
    }
    return {
      success: Boolean(result.status && result.status.gatewayUp),
      error: result.status && result.status.gatewayUp ? null : "OpenClaw is installed, but it did not start.",
      status: result.status,
    };
  });

  handle("openclaw-update-status", () => openClawUpdateStatus());

  handle("openclaw-update", async () => {
    const result = await updateOpenClaw();
    if (result && result.success && state.activeTab === OPENCLAW_TAB) {
      const view = state.views[OPENCLAW_TAB];
      if (view) view.openclawBootstrapped = false;
      const opened = await presentOpenClawPage();
      return { success: opened, error: opened ? null : "OpenClaw updated, but the page did not reopen." };
    }
    return { success: false, error: (result && result.error) || "OpenClaw could not be updated." };
  });

  handle("openclaw-dashboard", async () => {
    const result = await openClawDashboard();
    if (!result.url) {
      return { success: false, error: result.error || "No dashboard URL", url: result.cleanUrl || null };
    }
    if (isBoardWorkspace()) await tasks.setWorkspace("chat");
    const wasActive = state.activeTab === OPENCLAW_TAB;
    state.activeTab = OPENCLAW_TAB;
    ensureOpenClawView(result.url, true);
    state.openclawSnapshot = {
      ...(state.openclawSnapshot || {}),
      installed: true,
      gatewayUp: true,
      phase: "running",
      url: result.cleanUrl || state.openclawSnapshot?.url || state.tabs[OPENCLAW_TAB],
      error: null,
    };
    if (!wasActive && state.win && !state.win.isDestroyed()) state.win.webContents.send("tab-active", OPENCLAW_TAB);
    return { success: true, error: result.error || null, url: result.cleanUrl || null };
  });

  return {
    hideOpenClawView,
    ensureOpenClawView,
    loadOpenClawAuth,
    presentOpenClawPage,
    notifyOpenClawPage,
    applyOpenClawSnapshot,
  };
}

module.exports = { createOpenClawView };
