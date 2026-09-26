import { handle } from "./ipc-bind";
const { app, BrowserWindow, WebContentsView, Menu, ipcMain, session, dialog, shell, Notification, globalShortcut, clipboard } = require("electron");
const path = require("path");

if (process.platform === "darwin") {
  // An ad-hoc signature makes macOS ask for the login password twice: once for
  // Chromium's cookie keychain item and again for this app. Site sessions stay
  // in the app's own files, so startup does not touch the login keychain.
  app.commandLine.appendSwitch("use-mock-keychain");
}

if (process.env.AI_HUB_USER_DATA) {
  app.setPath("userData", process.env.AI_HUB_USER_DATA);
}

app.setName("AI Hub");
const fs = require("fs");
const { createWireguard } = require("./wireguard");
const { createProxyRouting } = require("./proxy-routing");
const { createTasks } = require("./tasks");
const { createServices } = require("./services");
const { streamEnded } = require("./stream-end");
const { GOOGLE_PARTITION } = require("./google");
const {
  inspectOpenClaw,
  startOpenClawGateway,
  openClawDashboard,
  openClawUpdateStatus,
  updateOpenClaw,
  installOpenClaw,
  probeGateway,
  isOpenClawControlUrl,
  DEFAULT_OPENCLAW_URL,
} = require("./openclaw");
const { createNavigation } = require("./navigation");
const { createExtensions } = require("./extensions");
const { createUpdates } = require("./updates");
const { createTheme } = require("./theme");
const { createGoogleSession } = require("./google-session");
const { createOpenClawView } = require("./openclaw-view");
const { createCompare } = require("./compare");
const { registerMainIpc } = require("./ipc-handlers");

let win;
let views: Record<string, any> = {};
let activeTab: string | null = null;
let topBarHeight = 60;
let tabState = {};
let popupWindows = new Set<any>();
let openclawSnapshot: any = null;
let openclawAuthedUrl = "";
let openclawAuthPromise = null;
let openclawPresentPromise = null;
const OPENCLAW_TAB = "OpenClaw";

const services = createServices({
  getUserDataPath: () => app.getPath("userData"),
  openclawUrl: DEFAULT_OPENCLAW_URL,
  broadcast: (status) => {
    if (win && !win.isDestroyed()) win.webContents.send("services-status", status);
  },
});

const tabs = new Proxy({}, {
  get(_target, name) {
    if (typeof name !== "string") return undefined;
    return services.url(name) || undefined;
  },
  has(_target, name) {
    return typeof name === "string" && services.known(name);
  },
  ownKeys() {
    return services.ids();
  },
  getOwnPropertyDescriptor(_target, name) {
    if (typeof name !== "string" || !services.known(name)) return undefined;
    return { configurable: true, enumerable: true, value: services.url(name) };
  },
});

const {
  isServiceUrlForTab,
  shouldOpenInSystemBrowser,
  isAuthPopupUrl,
  isOpenerPopupUrl,
  openInSystemBrowser,
  attachExternalLinkGuard,
} = createNavigation({
  tabUrl: (name) => tabs[name],
  isOpenClawControlUrl,
  openExternal: (url) => shell.openExternal(url),
});

function getAllSessions() {
  return services.accounts().map((account) => session.fromPartition(account.partition));
}

function buildViewPreferences(name) {
  return {
    partition: partitionForTab(name),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: true,
  };
}

const proxy = createProxyRouting({
  accounts: () => services.accounts(),
});
const {
  applyHubProxy,
  clearHubProxy,
  applyDroppedHubProxy,
  configureAccountProxy,
  shouldKeepConnections,
  applyWebRTCPolicy,
  applyWebRTCPolicyToContents,
  proxyForRoute,
} = proxy;

const wireguard = createWireguard({
  getUserDataPath: () => app.getPath("userData"),
  getDialogParent: () => (win && !win.isDestroyed() ? win : null),
  lookupPartition: "persist:ChatGPT",
  applyProxy: applyHubProxy,
  clearProxy: clearHubProxy,
  applyDroppedProxy: applyDroppedHubProxy,
  broadcast: (status) => {
    if (win && !win.isDestroyed()) win.webContents.send("wg-status", status);
  },
});

const tasks = createTasks({
  getUserDataPath: () => app.getPath("userData"),
  isKnownService: (name) => Object.prototype.hasOwnProperty.call(tabs, name),
  isServiceUrl: (name, url) => isServiceUrlForTab(name, url),
  listServices: () => Object.keys(tabs),
  accountFor: (name) => services.activeAccountId(name),
  broadcast: (status) => {
    if (win && !win.isDestroyed()) win.webContents.send("tasks-status", status);
  },
});

function stripFragment(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.username = "";
    parsed.password = "";
    return parsed.href;
  } catch {
    return url;
  }
}

function rememberTabUrl(name, url) {
  if (!name || !url || url === "about:blank") return;
  if (shouldOpenInSystemBrowser(name, url)) return;
  if (isAuthPopupUrl(url) && !isServiceUrlForTab(name, url)) return;
  tabState[name] = { url };
  void tasks.noteUrl(name, url);
}

const parkedViews = new Map<string, any>();
const hookedPartitions = new Set();
let compareOpen = false;
let compareSlots: any[] = [];
let compareFocus = null;
let compareTaskId = null;
let registeredHotkey = "";

function partitionForTab(name) {
  return services.partitionFor(name) || `persist:${name}`;
}

function accountKey(name) {
  return `${name}\n${services.activeAccountId(name) || "default"}`;
}

function parkView(name) {
  const view = views[name];
  if (!view) return;
  const key = view.accountKey || accountKey(name);
  try { detachPageView(view); } catch {}
  parkedViews.set(key, view);
  delete views[name];
}

function takeAccountView(name) {
  const key = accountKey(name);
  if (views[name] && views[name].accountKey === key && isViewUsable(views[name])) return views[name];
  if (views[name]) parkView(name);
  const parked = parkedViews.get(key);
  if (parked && isViewUsable(parked)) {
    parkedViews.delete(key);
    views[name] = parked;
    return parked;
  }
  return null;
}

function notifyReply(name) {
  if (!Notification.isSupported()) return;
  const note = new Notification({
    title: "AI Hub",
    body: `${name} has a reply on a task that is still Doing.`,
  });
  note.on("click", () => {
    if (!win || win.isDestroyed()) return;
    win.show();
    switchTab(name);
  });
  note.show();
}

function hookPartition(partition, name) {
  if (!partition || hookedPartitions.has(partition)) return;
  hookedPartitions.add(partition);
  const target = session.fromPartition(partition);
  const languages = services.spellcheckLanguages();
  if (languages.length) {
    try { target.setSpellCheckerLanguages(languages); } catch {}
  }
  target.on("will-download", (_event, item) => {
    const parent = win && !win.isDestroyed() ? win : undefined;
    const filePath = dialog.showSaveDialogSync(parent, { defaultPath: item.getFilename() });
    if (!filePath) {
      item.cancel();
      return;
    }
    item.setSavePath(filePath);
  });
  target.webRequest.onCompleted({ urls: ["https://*/*", "http://*/*"] }, (details) => {
    if (!streamEnded(name, details)) return;
    if (!shouldNoteTaskActivity(name)) return;
    void tasks.noteActivity(name, services.activeAccountId(name)).then((result) => {
      if (result && result.noted) notifyReply(name);
    });
  });
}

function applySpellcheck() {
  const languages = services.spellcheckLanguages();
  if (!languages.length) return;
  for (const account of services.accounts()) {
    try { session.fromPartition(account.partition).setSpellCheckerLanguages(languages); } catch {}
  }
}

function changeZoom(name, delta, absolute?) {
  const current = services.zoom(name) || 1;
  const next = absolute == null ? current + delta : absolute;
  void services.setZoom(name, next).then((status) => {
    const row = status && status.services && status.services.find((item) => item.id === name);
    const zoom = row ? row.zoom : next;
    if (isViewUsable(views[name])) {
      try { views[name].webContents.setZoomFactor(zoom); } catch {}
    }
  }).catch(() => {});
}

function attachViewChrome(webContents, name) {
  webContents.on("before-input-event", (event, input) => {
    if (!input || input.type !== "keyDown" || input.isAutoRepeat) return;
    const mod = input.control || input.meta;
    if (!mod || input.alt) return;
    const key = String(input.key || "").toLowerCase();
    if (key === "f") {
      event.preventDefault();
      if (win && !win.isDestroyed()) win.webContents.send("find-open");
      return;
    }
    if (key === "=" || key === "+") {
      event.preventDefault();
      changeZoom(name, 0.1);
    } else if (key === "-" || key === "_") {
      event.preventDefault();
      changeZoom(name, -0.1);
    } else if (key === "0") {
      event.preventDefault();
      changeZoom(name, 0, 1);
    }
  });
}

const {
  layoutCompare,
  closeCompare,
  startCompare,
  insertCompareText,
  registerHotkey,
} = createCompare({
  window: () => win,
  views: () => views,
  tabs: () => tabs,
  getActiveTab: () => activeTab,
  getTopBarHeight: () => topBarHeight,
  getCompareOpen: () => compareOpen,
  setCompareOpen: (value) => { compareOpen = value; },
  getCompareSlots: () => compareSlots,
  setCompareSlots: (value) => { compareSlots = value; },
  getCompareFocus: () => compareFocus,
  setCompareFocus: (value) => { compareFocus = value; },
  getCompareTaskId: () => compareTaskId,
  setCompareTaskId: (value) => { compareTaskId = value; },
  getHotkey: () => registeredHotkey,
  setHotkey: (value) => { registeredHotkey = value; },
  tasks,
  services,
  isViewUsable,
  isBoardWorkspace,
  takeAccountView,
  createTab,
  showPageView,
  hideOtherPageViews,
  detachPageView,
  switchTab,
  acceptedServiceUrl,
});

// ── Window ──────────────────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 20 },
    acceptFirstMouse: true,
    backgroundColor: themeColor(),
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    }
  });

  views = {};
  activeTab = null;
  tabState = {};
  popupWindows = new Set();

  attachBoardShortcut(win.webContents);
  ignoreUnloadBlock(win.webContents);
  win.webContents.on("did-finish-load", () => {
    void startTunnelThenChats();
    void loadOpenClawAuth();
  });
  win.loadFile(path.join(__dirname, "../renderer/index.html"));
  win.webContents.on("did-finish-load", () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send("services-status", services.list());
  });

  win.on("resize", () => {
    if (compareOpen) {
      layoutCompare();
      return;
    }
    if (isBoardWorkspace()) return;
    if (activeTab && isViewUsable(views[activeTab])) resizeView(views[activeTab]);
  });
  win.on("close", (event) => {
    if (forceExitStarted) return;
    event.preventDefault();
    forceExit();
  });
}

function clearPageTopDeadZone(webContents) {
  if (!webContents || webContents.__pageGap) return;
  webContents.__pageGap = true;
  // macOS drops clicks in the top 60px of the page view. Move the site down
  // so its header buttons land in the area that actually receives clicks.
  const script = `(() => {
    const apply = () => {
      const root = document.documentElement;
      if (!root || root.dataset.aiHubGap === "1") return;
      root.dataset.aiHubGap = "1";
      root.style.setProperty("position", "relative", "important");
      root.style.setProperty("top", "56px", "important");
      root.style.setProperty("height", "calc(100% - 56px)", "important");
      root.style.setProperty("box-sizing", "border-box", "important");
    };
    apply();
    if (!window.__aiHubGapWatch) {
      window.__aiHubGapWatch = new MutationObserver(apply);
      window.__aiHubGapWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
    }
  })()`;
  const run = () => {
    if (!webContents.isDestroyed()) webContents.executeJavaScript(script).catch(() => {});
  };
  webContents.on("dom-ready", run);
  run();
}

function isViewUsable(view) {
  return !!(view && view.webContents && !view.webContents.isDestroyed());
}

function detachPageView(view) {
  if (!win || win.isDestroyed() || !view) return;
  try { win.contentView.removeChildView(view); } catch {}
}

function showPageView(view, options: any = {}) {
  if (!win || win.isDestroyed() || !isViewUsable(view)) return;
  if (!options.keepOthers) hideOtherPageViews(view);
  const children = win.contentView.children || [];
  if (!children.includes(view)) {
    try { win.contentView.addChildView(view); } catch {}
  }
  resizeView(view);
}

function hideOtherPageViews(keep) {
  const skip = new Set();
  if (keep) skip.add(keep);
  for (const view of Object.values(views)) {
    if (view && !skip.has(view)) detachPageView(view);
  }
  for (const view of parkedViews.values()) {
    if (view && !skip.has(view)) detachPageView(view);
  }
  for (const slot of compareSlots) {
    if (slot && slot.view && !skip.has(slot.view)) detachPageView(slot.view);
  }
}

const {
  themeColor,
  paintViewTheme,
  attachGuestTheme,
  applyContentTheme,
  applyGuestColorScheme,
} = createTheme({
  window: () => win,
  views: () => views,
  parkedViews: () => parkedViews,
  compareSlots: () => compareSlots,
  isViewUsable,
});

function getTabUrl(name) {
  return tabState[name]?.url || tabs[name];
}

function destroyAllViews() {
  for (const popup of popupWindows) {
    try { popup.close(); } catch {}
  }
  popupWindows.clear();

  if (!win || win.isDestroyed()) {
    views = {};
    activeTab = null;
    return;
  }

  for (const [name, view] of Object.entries(views)) {
    if (!isViewUsable(view)) continue;

    try {
      rememberTabUrl(name, view.webContents.getURL());
    } catch {}

    try { detachPageView(view); } catch {}

    try {
      view.webContents.removeAllListeners();
      if (typeof view.webContents.destroy === "function") view.webContents.destroy();
      else view.webContents.close({ waitForBeforeUnload: false });
    } catch {}
  }

  views = {};
  activeTab = null;
}

function destroyTabView(name) {
  const view = views[name];
  if (!isViewUsable(view)) {
    delete views[name];
    if (activeTab === name) activeTab = null;
    return;
  }

  try {
    rememberTabUrl(name, view.webContents.getURL());
  } catch {}

  try {
    detachPageView(view);
  } catch {}

    try {
      view.webContents.removeAllListeners();
      if (typeof view.webContents.destroy === "function") view.webContents.destroy();
      else view.webContents.close({ waitForBeforeUnload: false });
    } catch {}

    delete views[name];
  if (activeTab === name) activeTab = null;
}

async function resetTabSession(name) {
  const targetSession = session.fromPartition(partitionForTab(name));

  destroyTabView(name);

  try { await targetSession.clearCache(); } catch {}
  try { await targetSession.clearStorageData(); } catch {}
  try {
    const cookies = await targetSession.cookies.get({});
    await Promise.all(cookies.map(cookie =>
      targetSession.cookies.remove(
        `${cookie.secure ? "https" : "http"}://${cookie.domain.replace(/^\./, "")}${cookie.path}`,
        cookie.name
      )
    ));
  } catch {}
  try { await targetSession.flushStorageData?.(); } catch {}

  delete tabState[name];
  await tasks.clearUrlsForService(name);
  if (isBoardWorkspace()) await tasks.setWorkspace("chat");

  if (win && !win.isDestroyed()) {
    createTab(name, tabs[name]);
    win.webContents.send("tab-active", name);
  }
}

async function withRebuiltViews(action) {
  const previouslyActiveTab = activeTab;
  destroyAllViews();

  const result = await action();

  const tabToRestore = previouslyActiveTab && tabs[previouslyActiveTab]
    ? previouslyActiveTab
    : Object.keys(tabs)[0];

  if (win && !win.isDestroyed() && tabToRestore) {
    switchTab(tabToRestore);
    if (isBoardWorkspace()) detachView(activeTab);
  }

  return result;
}

function reloadActiveTab(ignoreCache = false) {
  const view = activeTab ? views[activeTab] : null;
  if (!isViewUsable(view)) return;

  if (ignoreCache) view.webContents.reloadIgnoringCache();
  else view.webContents.reload();
}

function reloadWebContents(webContents, ignoreCache = false) {
  if (!webContents || webContents.isDestroyed()) return;
  if (ignoreCache) webContents.reloadIgnoringCache();
  else webContents.reload();
}

function attachReloadShortcuts(webContents, reloadHandler = reloadActiveTab) {
  webContents.on("before-input-event", (event, input) => {
    const isReloadKey = input.key.toLowerCase() === "r" && (input.control || input.meta);
    if (!isReloadKey) return;

    event.preventDefault();
    reloadHandler(Boolean(input.shift));
  });
}

function openPopupWindow(tabName, url) {
  const popup = new BrowserWindow({
    width: 520,
    height: 760,
    parent: win,
    modal: false,
    autoHideMenuBar: true,
    titleBarStyle: "default",
    backgroundColor: themeColor(),
    webPreferences: buildViewPreferences(tabName),
  });

  let handedOffToMainView = false;

  popupWindows.add(popup);
  popup.on("closed", () => {
    popupWindows.delete(popup);
    if (activeTab === tabName && !handedOffToMainView) reloadActiveTab(false);
  });

  attachReloadShortcuts(popup.webContents, (ignoreCache) => reloadWebContents(popup.webContents, ignoreCache));
  const finishAuthHandoff = async (navigatedUrl) => {
    if (handedOffToMainView) return;
    if (!isServiceUrlForTab(tabName, navigatedUrl)) return;

    handedOffToMainView = true;
    rememberTabUrl(tabName, navigatedUrl);

    try {
      const targetSession = session.fromPartition(partitionForTab(tabName));
      await targetSession.cookies.flushStore?.();
      await targetSession.flushStorageData?.();
    } catch {}

    if (activeTab === tabName) {
      destroyTabView(tabName);
      createTab(tabName, navigatedUrl);
      win.webContents.send("tab-active", tabName);
    }

    if (!popup.isDestroyed()) {
      setTimeout(() => {
        if (!popup.isDestroyed()) popup.close();
      }, 250);
    }
  };

  popup.webContents.on("did-navigate", (_event, navigatedUrl) => {
    void finishAuthHandoff(navigatedUrl);
  });
  popup.webContents.on("did-navigate-in-page", (_event, navigatedUrl) => {
    void finishAuthHandoff(navigatedUrl);
  });
  popup.webContents.on("did-finish-load", () => {
    const currentUrl = popup.webContents.getURL();
    void finishAuthHandoff(currentUrl);
  });

  attachExternalLinkGuard(popup.webContents, tabName);
  applyWebRTCPolicyToContents(popup.webContents, services.route(tabName));
  popup.loadURL(url);
}

function createTab(name, url = getTabUrl(name), options: any = {}) {
  const view = new WebContentsView({
    webPreferences: buildViewPreferences(name)
  });
  views[name] = view;
  view.accountKey = accountKey(name);
  paintViewTheme(view);
  clearPageTopDeadZone(view.webContents);
  attachGuestTheme(view.webContents);
  void applyGuestColorScheme(view.webContents);
  // Board mode keeps the view in `views` but must not put it back on the window.
  // setBrowserView here used to run before the detach, so a throw from loadURL
  // left the page covering the board.
  const showNow = !isBoardWorkspace() && !options.background;
  if (showNow) showPageView(view);

  view.webContents.once("destroyed", () => {
    if (views[name] === view) delete views[name];
    if (activeTab === name) activeTab = null;
  });

  hookPartition(partitionForTab(name), name);
  const targetSession = session.fromPartition(partitionForTab(name));
  try { view.webContents.setZoomFactor(services.zoom(name) || 1); } catch {}
  applyWebRTCPolicyToContents(view.webContents, services.route(name));
  const proxyReady = targetSession.setProxy(proxyForRoute(services.route(name))).catch(() => {});

  attachReloadShortcuts(view.webContents);
  attachBoardShortcut(view.webContents);
  attachViewChrome(view.webContents, name);
  ignoreUnloadBlock(view.webContents);
  let titleNotedAt = 0;
  view.webContents.on("page-title-updated", () => {
    if (!shouldNoteTaskActivity(name)) return;
    const now = Date.now();
    if (now - titleNotedAt < 8000) return;
    titleNotedAt = now;
    void tasks.noteActivity(name, services.activeAccountId(name)).then((result) => {
      if (result && result.noted) notifyReply(name);
    });
  });

  // Cross-document main-frame loads only. Subframe and same-document
  // navigations must not start the spinner. did-finish-load ends it when the
  // main document is ready; did-stop-loading is only a backup.
  let mainFrameLoading = false;

  view.webContents.on("did-start-navigation", (event, details, isInPlace, isMainFrameArg) => {
    const nav = details && typeof details === "object" && typeof details.isMainFrame === "boolean"
      ? details
      : (event && typeof event === "object" && typeof event.isMainFrame === "boolean" ? event : null);
    const isMainFrame = nav ? nav.isMainFrame : isMainFrameArg;
    const isSameDocument = nav
      ? Boolean(nav.isSameDocument || nav.isInPlace)
      : Boolean(isInPlace);
    if (!isMainFrame || isSameDocument) return;
    // OpenClaw keeps navigating inside the already open page. Those loads must
    // not leave the spinner next to its name running.
    if (name === OPENCLAW_TAB && view.openclawBootstrapped) return;
    mainFrameLoading = true;
    win.webContents.send("tab-progress", name, "start");
  });
  view.webContents.on("did-navigate", (_event, navigatedUrl) => {
    rememberTabUrl(name, name === OPENCLAW_TAB ? stripFragment(navigatedUrl) : navigatedUrl);
  });
  view.webContents.on("did-navigate-in-page", (_event, navigatedUrl) => {
    rememberTabUrl(name, name === OPENCLAW_TAB ? stripFragment(navigatedUrl) : navigatedUrl);
  });
  view.webContents.on("did-finish-load", () => {
    if (name === OPENCLAW_TAB) view.openclawLoadPending = false;
    if (!mainFrameLoading && name !== OPENCLAW_TAB) return;
    mainFrameLoading = false;
    win.webContents.send("tab-progress", name, "finish");
  });
  view.webContents.on("did-stop-loading", () => {
    if (name === OPENCLAW_TAB) view.openclawLoadPending = false;
    if (!mainFrameLoading && name !== OPENCLAW_TAB) return;
    mainFrameLoading = false;
    win.webContents.send("tab-progress", name, "finish");
  });
  view.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    // -3 = ERR_ABORTED (redirect, superseded navigation, or user cancel) — ignore.
    // Subframe failures must not finish or restart the tab indicator.
    if (!isMainFrame || errorCode === -3) return;
    mainFrameLoading = false;
    win.webContents.send("tab-progress", name, "fail");
    if (name === OPENCLAW_TAB && !view.openclawRetried) {
      view.openclawRetried = true;
      view.openclawLoadPending = false;
      const retryUrl = openclawAuthedUrl || url;
      void session.fromPartition(partitionForTab(name)).setProxy({ mode: "direct" }).catch(() => {}).then(() => {
        if (!isViewUsable(view) || activeTab !== OPENCLAW_TAB) return;
        view.openclawLoadPending = true;
        view.webContents.loadURL(retryUrl);
      });
      return;
    }
    if (name === OPENCLAW_TAB) {
      view.openclawBootstrapped = false;
      hideOpenClawView();
      openclawSnapshot = {
        ...(openclawSnapshot || {}),
        installed: openclawSnapshot ? openclawSnapshot.installed : true,
        gatewayUp: false,
        phase: "stopped",
        url: openclawSnapshot?.url || tabs[OPENCLAW_TAB],
        error: errorDescription || "OpenClaw Gateway is not reachable",
      };
      if (win && !win.isDestroyed()) {
        win.webContents.send("openclaw-down", {
          error: errorDescription || "OpenClaw Gateway is not reachable",
          url: openclawSnapshot.url,
        });
      }
    }
  });

  try { view.webContents.setUserAgent(app.userAgentFallback); } catch {}

  view.webContents.setWindowOpenHandler(({ url: u }) => {
    if (isOpenerPopupUrl(name, u)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          parent: win,
          width: 520,
          height: 760,
          autoHideMenuBar: true,
          backgroundColor: themeColor(),
          webPreferences: buildViewPreferences(name),
        },
      };
    }

    if (shouldOpenInSystemBrowser(name, u)) {
      openInSystemBrowser(u);
      return { action: "deny" };
    }

    openPopupWindow(name, u);
    return { action: "deny" };
  });

  attachExternalLinkGuard(view.webContents, name);
  if (options.googleClick) armGoogleClick(view, name);
  if (!options.background) activeTab = name;
  if (name === OPENCLAW_TAB) view.openclawLoadPending = true;
  // The first navigation has to wait until the proxy is applied. Otherwise a
  // localhost page can be sent through the tunnel and fail, then succeed on
  // the next click once the direct route is in place.
  void proxyReady.then(() => {
    if (!isViewUsable(view)) return;
    applyWebRTCPolicyToContents(view.webContents, services.route(name));
    view.webContents.loadURL(url);
  });
}

function detachView(name) {
  const view = views[name];
  if (!win || win.isDestroyed() || !isViewUsable(view)) return;
  try { detachPageView(view); } catch {}
}

const {
  hideOpenClawView,
  ensureOpenClawView,
  loadOpenClawAuth,
  presentOpenClawPage,
  notifyOpenClawPage,
  applyOpenClawSnapshot,
} = createOpenClawView({
  window: () => win,
  views: () => views,
  getActiveTab: () => activeTab,
  setActiveTab: (value) => { activeTab = value; },
  getSnapshot: () => openclawSnapshot,
  setSnapshot: (value) => { openclawSnapshot = value; },
  getAuthedUrl: () => openclawAuthedUrl,
  setAuthedUrl: (value) => { openclawAuthedUrl = value; },
  getAuthPromise: () => openclawAuthPromise,
  setAuthPromise: (value) => { openclawAuthPromise = value; },
  getPresentPromise: () => openclawPresentPromise,
  setPresentPromise: (value) => { openclawPresentPromise = value; },
  tabs: () => tabs,
  createTab,
  isViewUsable,
  isBoardWorkspace,
  showPageView,
  detachView,
  partitionForTab,
  tasks,
  openClawTab: OPENCLAW_TAB,
});

function switchTab(name) {
  if (!tabs[name]) return;
  if (compareOpen) closeCompare({ restore: false });
  takeAccountView(name);
  const board = isBoardWorkspace();
  if (name === OPENCLAW_TAB) {
    activeTab = name;
    if (board) {
      hideOpenClawView();
    } else if (views[OPENCLAW_TAB] && views[OPENCLAW_TAB].openclawBootstrapped) {
      ensureOpenClawView(openclawAuthedUrl || tabs[OPENCLAW_TAB], false);
    } else {
      void presentOpenClawPage().then((ready) => notifyOpenClawPage(ready));
    }
    win.webContents.send("tab-active", name);
    return;
  }

  if (!isViewUsable(views[name])) {
    delete views[name];
    createTab(name);
  } else if (board) {
    activeTab = name;
  } else {
    showPageView(views[name]);
    try {
      rememberTabUrl(name, views[name].webContents.getURL());
    } catch {}
    activeTab = name;
  }
  win.webContents.send("tab-active", name);
}

function resizeView(view) {
  if (!win || win.isDestroyed() || !view) return;
  const [width, height] = win.getContentSize();
  const bounds = {
    x: 0,
    y: topBarHeight,
    width,
    height: Math.max(0, height - topBarHeight),
  };
  let current: any = null;
  try { current = view.getBounds(); } catch {}
  if (current
    && current.x === bounds.x
    && current.y === bounds.y
    && current.width === bounds.width
    && current.height === bounds.height) return;
  view.setBounds(bounds);
}

function isBoardWorkspace() {
  try {
    return tasks.list().workspace === "board";
  } catch {
    return false;
  }
}

function isViewAttached(view) {
  if (!win || win.isDestroyed() || !isViewUsable(view)) return false;
  try {
    return (win.contentView.children || []).includes(view);
  } catch {
    return false;
  }
}

function shouldNoteTaskActivity(name) {
  if (isBoardWorkspace()) return true;
  if (activeTab !== name) return true;
  return !isViewAttached(views[name]);
}

function applyWorkspaceView(status) {
  if (!win || win.isDestroyed()) return;
  const mode = status && status.workspace === "board" ? "board" : "chat";
  if (mode === "board") {
    if (compareOpen) closeCompare({ restore: false });
    if (activeTab) detachView(activeTab);
    return;
  }
  // OpenClaw often has no attached view when the Gateway is down. That is
  // still the current tab: the shell shows its own panel. Do not replace it
  // with the last chat service just because the view is missing.
  if (activeTab === OPENCLAW_TAB) {
    switchTab(OPENCLAW_TAB);
    return;
  }
  if (!activeTab || !tabs[activeTab] || !isViewUsable(views[activeTab])) {
    const name = status && status.lastService && tabs[status.lastService]
      ? status.lastService
      : "ChatGPT";
    switchTab(name);
    return;
  }
  showPageView(views[activeTab]);
  win.webContents.send("tab-active", activeTab);
}

function acceptedServiceUrl(service, url) {
  if (typeof url !== "string" || !url) return null;
  return isServiceUrlForTab(service, url) ? url : null;
}

function showTaskService(status) {
  if (!win || win.isDestroyed() || !status || !status.capture) return;
  if (isBoardWorkspace()) return;
  const service = status.capture.service;
  if (!tabs[service]) return;
  if (status.capture.accountId) services.useAccount(service, status.capture.accountId);
  takeAccountView(service);
  // OpenClaw must open through the Gateway snapshot, never a stored task URL.
  if (service === OPENCLAW_TAB) {
    switchTab(OPENCLAW_TAB);
    return;
  }
  const task = (status.tasks || []).find((item) => item.id === status.capture.taskId);
  const found = task && (task.assignments || []).find((item) => item.service === service);
  const saved = acceptedServiceUrl(service, found && found.url);
  if (!isViewUsable(views[service])) {
    delete views[service];
    const fallback = acceptedServiceUrl(service, getTabUrl(service)) || tabs[service];
    createTab(service, saved || fallback);
  } else {
    const view = views[service];
    showPageView(view);
    activeTab = service;
    if (saved) {
      let current = "";
      try { current = view.webContents.getURL(); } catch {}
      if (saved !== current) view.webContents.loadURL(saved);
    }
  }
  if (win && !win.isDestroyed()) win.webContents.send("tab-active", service);
}

let tunnelGateStarted = false;
let tunnelGateSettled = false;

function sendTunnelGate(active, name?) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send("tunnel-gate", { active: Boolean(active), name: name || "" });
}

function bootTasksWorkspace() {
  if (!tunnelGateSettled || !win || win.isDestroyed()) return;
  applyWorkspaceView(tasks.list());
}

async function startTunnelThenChats() {
  if (tunnelGateStarted) return;
  tunnelGateStarted = true;
  const saved = wireguard.savedTunnel();
  if (!saved) {
    tunnelGateSettled = true;
    bootTasksWorkspace();
    return;
  }
  sendTunnelGate(true, saved.name);
  try {
    await wireguard.restore();
  } catch {}
  if (tunnelGateSettled) return;
  tunnelGateSettled = true;
  sendTunnelGate(false);
  bootTasksWorkspace();
}

async function cancelTunnelStartup() {
  if (!tunnelGateSettled) tunnelGateSettled = true;
  const result = await wireguard.cancelAutoConnect();
  sendTunnelGate(false);
  bootTasksWorkspace();
  return result;
}

let boardShortcutAt = 0;

function isBoardShortcut(input) {
  if (!input || input.type !== "keyDown") return false;
  const key = String(input.key || "").toLowerCase();
  const code = input.code || "";
  if (key !== "b" && code !== "KeyB") return false;
  if (!input.shift || input.alt) return false;
  return Boolean(input.control || input.meta);
}

function attachBoardShortcut(webContents) {
  if (!webContents) return;
  webContents.on("before-input-event", (event, input) => {
    if (!isBoardShortcut(input)) return;
    // Repeats must be swallowed too. Otherwise a held key reaches the shell
    // document and toggles the board on every repeat.
    event.preventDefault();
    if (input.isAutoRepeat) return;
    const now = Date.now();
    if (now - boardShortcutAt < 250) return;
    boardShortcutAt = now;
    void toggleWorkspace();
  });
}

async function toggleWorkspace() {
  const next = isBoardWorkspace() ? "chat" : "board";
  return commitWorkspace(next);
}

async function commitWorkspace(workspace) {
  const before = tasks.list().revision;
  const result = await tasks.setWorkspace(workspace);
  if (result && result.success && result.status && result.status.revision !== before) {
    applyWorkspaceView(result.status);
  }
  return result;
}

async function handleSwitchTab(tabName) {
  if (!tabs[tabName]) return;
  if (isBoardWorkspace()) {
    const result = await tasks.setWorkspace("chat");
    if (!result || !result.success) return;
  }
  switchTab(tabName);
}

function taskIpcError(err) {
  let status = null;
  try { status = tasks.status(); } catch {}
  return {
    success: false,
    error: err && err.message ? err.message : "Couldn't update tasks",
    status,
  };
}

const {
  armGoogleClick,
  isolateUnsharedProfiles,
  profileSawSite,
  closeWindow: closeGoogleWindow,
} = createGoogleSession({
  window: () => win,
  views: () => views,
  activeTab: () => activeTab,
  tabs: () => tabs,
  services,
  createTab,
  isViewUsable,
  proxy,
  applyWebRTCPolicy,
  applyWebRTCPolicyToContents,
  themeColor,
  openClawTab: OPENCLAW_TAB,
});

// ── IPC ─────────────────────────────────────────────────────────────────────

registerMainIpc({
  get win() { return win; },
  get views() { return views; },
  get activeTab() { return activeTab; },
  get compareOpen() { return compareOpen; },
  get topBarHeight() { return topBarHeight; },
  set topBarHeight(value) { topBarHeight = value; },
  tabs,
  services,
  tasks,
  wireguard,
  shell,
  OPENCLAW_TAB,
  switchTab,
  handleSwitchTab,
  layoutCompare,
  isBoardWorkspace,
  isViewUsable,
  resizeView,
  applyHubProxy,
  clearHubProxy,
  registerHotkey,
  applySpellcheck,
  profileSawSite,
  configureAccountProxy,
  shouldKeepConnections,
  reloadActiveTab,
  resetTabSession,
  cancelTunnelStartup,
  showTaskService,
  commitWorkspace,
  toggleWorkspace,
  taskIpcError,
});

const updates = createUpdates({
  window: () => (win && !win.isDestroyed() ? win : null),
});

const extensions = createExtensions({
  getAllSessions,
  withRebuiltViews,
  window: () => (win && !win.isDestroyed() ? win : null),
});

// ── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Strip Electron/Node identifiers from the user-agent so that Google OAuth
  // and other services that block embedded WebView sign-ins work correctly.
  const rawUA = app.userAgentFallback;
  const browserUserAgent = rawUA
    .replace(/\s*Electron\/\S+/, "")
    .replace(/\s*ai-hub\/\S+/, "");
  app.userAgentFallback = browserUserAgent;
  for (const tabSession of getAllSessions()) {
    tabSession.setUserAgent(browserUserAgent);
  }
  try { session.fromPartition(GOOGLE_PARTITION).setUserAgent(browserUserAgent); } catch {}

  createWindow();
  registerHotkey();
  updates.setupUpdates();
  void isolateUnsharedProfiles();

  const iconPath = path.join(__dirname, "../../assets/icon.png");
  if (process.platform === "darwin" && fs.existsSync(iconPath) && app.dock) {
    app.dock.setIcon(iconPath);
  }

  await extensions.loadPersistedExtensions();
});

app.on("browser-window-created", (_event, window) => {
  if (!window || window.webContents.isDestroyed()) return;
  const apply = () => {
    if (!window || window.isDestroyed() || window === win) return;
    try {
      const url = window.webContents.getURL() || "";
      if (url.startsWith("devtools://")) return;
    } catch {}
    try { window.setBackgroundColor(themeColor()); } catch {}
    void applyGuestColorScheme(window.webContents);
  };
  window.webContents.on("did-finish-load", apply);
});

function ignoreUnloadBlock(webContents) {
  if (!webContents) return;
  webContents.on("will-prevent-unload", (event) => {
    event.preventDefault();
  });
}

let forceExitStarted = false;

function forceExit() {
  if (forceExitStarted) return;
  forceExitStarted = true;
  try {
    try { if (registeredHotkey) globalShortcut.unregister(registeredHotkey); } catch {}
    for (const view of parkedViews.values()) {
      try { view.webContents.destroy(); } catch {}
    }
    parkedViews.clear();
    try { wireguard.kill(); } catch {}
    for (const popup of popupWindows) {
      try { popup.destroy(); } catch {}
    }
    popupWindows.clear();
    for (const view of Object.values(views)) {
      try {
        detachPageView(view);
      } catch {}
      try { view.webContents.destroy(); } catch {}
    }
    views = {};
    activeTab = null;
    closeGoogleWindow();
    for (const window of BrowserWindow.getAllWindows()) {
      try { window.destroy(); } catch {}
    }
  } finally {
    try { app.exit(0); } catch {}
    process.kill(process.pid, "SIGKILL");
  }
}

app.on("window-all-closed", () => {
  forceExit();
});

app.on("before-quit", (event) => {
  if (forceExitStarted) return;
  event.preventDefault();
  forceExit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

if (process.env.AI_HUB_TEST === "1") {
  global.__aiHubTest = { shouldOpenInSystemBrowser };
}
