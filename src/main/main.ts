import { handle } from "./ipc-bind";
const { app, BrowserWindow, WebContentsView, ipcMain, session, webContents, dialog, shell, nativeTheme, Notification, globalShortcut, clipboard } = require("electron");
const path = require("path");

if (process.env.AI_HUB_USER_DATA) {
  app.setPath("userData", process.env.AI_HUB_USER_DATA);
}

app.setName("AI Hub");
const fs = require("fs");
const https = require("https");
const http = require("http");
const os = require("os");
const yauzl = require("yauzl");
const { createWireguard, buildBlackholeProxyConfig, webrtcIpHandlingPolicy } = require("./wireguard");
const { createTasks } = require("./tasks");
const { createServices } = require("./services");
const { streamEnded } = require("./stream-end");
const {
  GOOGLE_PARTITION,
  ACCOUNT_URL,
  isGoogleHost,
  hasGoogleSession,
  findEmail,
  loginUrlFor,
  targetsForApply,
  CLICK_GOOGLE_SCRIPT,
} = require("./google");
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

let win;
let views: Record<string, any> = {};
let activeTab = null;
let topBarHeight = 60;
let proxyConfig = null;
let tabState = {};
let popupWindows = new Set<any>();
let openclawSnapshot = null;
let openclawAuthedUrl = "";
let openclawAuthPromise = null;
let openclawPresentPromise = null;
let contentTheme = "dark";

// Tab pages live in BrowserViews, outside the shell document. Point Chromium's
// prefers-color-scheme at the hub theme before any of those pages load.
nativeTheme.themeSource = contentTheme;

const THEME_COLORS = {
  dark: "#1e1e1e",
  light: "#f3f5f9",
};

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

function getAllSessions() {
  return services.accounts().map((account) => session.fromPartition(account.partition));
}

function buildViewPreferences(name) {
  return {
    partition: partitionForTab(name),
    contextIsolation: true,
    nodeIntegration: false,
    spellcheck: true,
  };
}

function getExtensionsApi(targetSession) {
  return targetSession.extensions ?? targetSession;
}

let tunnelProxy = null;
let hubProxyPhase = "direct";

function proxyForRoute(route) {
  if (route === "direct") return { mode: "direct" };
  if (hubProxyPhase === "dropped") return buildBlackholeProxyConfig();
  if (hubProxyPhase === "tunnel" && tunnelProxy) return tunnelProxy;
  return { mode: "direct" };
}

function applyWebRTCPolicyToContents(contents, route) {
  if (!contents || contents.isDestroyed()) return;
  if (typeof contents.setWebRTCIPHandlingPolicy !== "function") return;
  contents.setWebRTCIPHandlingPolicy(webrtcIpHandlingPolicy(route, hubProxyPhase));
}

function applyWebRTCPolicy(targetSession, route) {
  for (const contents of webContents.getAllWebContents()) {
    try {
      if (contents.isDestroyed() || contents.session !== targetSession) continue;
      applyWebRTCPolicyToContents(contents, route);
    } catch {}
  }
}

async function configureAccountProxy(account) {
  const target = session.fromPartition(account.partition);
  applyWebRTCPolicy(target, account.route);
  await target.setProxy(proxyForRoute(account.route));
  return target;
}

function shouldKeepConnections(partition) {
  return partition === "persist:OpenClaw" || partition.startsWith("persist:OpenClaw:");
}

async function applyRoutedProxy() {
  const accounts = services.accounts();
  const targets = await Promise.all(accounts.map((account) => configureAccountProxy(account)));
  await Promise.all(accounts.map((account, index) => {
    if (shouldKeepConnections(account.partition)) return undefined;
    return targets[index].closeAllConnections().catch(() => {});
  }));
}

async function applyHubProxy(config) {
  tunnelProxy = config;
  hubProxyPhase = "tunnel";
  proxyConfig = config;
  await applyRoutedProxy();
}

async function clearHubProxy() {
  tunnelProxy = null;
  hubProxyPhase = "direct";
  proxyConfig = null;
  await applyRoutedProxy();
}

async function applyDroppedHubProxy() {
  hubProxyPhase = "dropped";
  proxyConfig = buildBlackholeProxyConfig();
  await applyRoutedProxy();
}

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
let compareSlots = [];
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

function layoutCompare() {
  if (!compareOpen || !win || win.isDestroyed()) return;
  const [width, height] = win.getContentSize();
  const count = compareSlots.length || 1;
  const col = Math.floor(width / count);
  compareSlots.forEach((slot, index) => {
    if (!isViewUsable(slot.view)) return;
    try { showPageView(slot.view, { keepOthers: true }); } catch {}
    try {
      slot.view.setBounds({
        x: index * col,
        y: topBarHeight,
        width: index === count - 1 ? width - index * col : col,
        height: Math.max(0, height - topBarHeight),
      });
    } catch {}
  });
}

function closeCompare(options: any = {}) {
  if (!compareOpen && !compareSlots.length) return;
  compareOpen = false;
  compareFocus = null;
  compareTaskId = null;
  for (const slot of compareSlots) {
    try { detachPageView(slot.view); } catch {}
  }
  compareSlots = [];
  if (win && !win.isDestroyed()) win.webContents.send("compare-status", { open: false });
  if (options.restore !== false && activeTab && tabs[activeTab]) switchTab(activeTab);
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
  for (const slot of compareSlots) {
    try { detachPageView(slot.view); } catch {}
  }
  compareSlots = [];
  compareTaskId = task.id;
  for (const assignment of picks) {
    services.useAccount(assignment.service, assignment.accountId || "default");
    takeAccountView(assignment.service);
    if (!isViewUsable(views[assignment.service])) {
      const saved = acceptedServiceUrl(assignment.service, assignment.url);
      createTab(assignment.service, saved || tabs[assignment.service], { background: true });
    }
    const view = views[assignment.service];
    if (!isViewUsable(view)) continue;
    if (!view.compareFocusHooked) {
      view.compareFocusHooked = true;
      view.webContents.on("focus", () => { compareFocus = view.webContents; });
    }
    compareSlots.push({ service: assignment.service, view });
  }
  if (win && !win.isDestroyed()) {
    try { hideOtherPageViews(null); } catch {}
  }
  compareOpen = compareSlots.length >= 2;
  if (!compareOpen) return { success: false, error: "Couldn't open those services" };
  layoutCompare();
  if (win && !win.isDestroyed()) {
    win.webContents.send("compare-status", { open: true, title: task.title, taskId: task.id });
  }
  return { success: true };
}

function insertCompareText() {
  const status = tasks.list();
  const task = (status.tasks || []).find((item) => item.id === compareTaskId);
  if (!task) return { success: false, error: "Unknown task" };
  const text = task.prompt || task.title || "";
  const contents = compareFocus && !compareFocus.isDestroyed()
    ? compareFocus
    : (compareSlots[0] && isViewUsable(compareSlots[0].view) ? compareSlots[0].view.webContents : null);
  if (!contents || contents.isDestroyed()) return { success: false, error: "Click a chat first" };
  try {
    contents.focus();
    contents.insertText(text);
  } catch (err) {
    return { success: false, error: err.message };
  }
  return { success: true };
}

function registerHotkey() {
  if (registeredHotkey) {
    try { globalShortcut.unregister(registeredHotkey); } catch {}
    registeredHotkey = "";
  }
  const accel = services.hotkey();
  if (!accel) return;
  const ok = globalShortcut.register(accel, () => {
    if (!win || win.isDestroyed()) return;
    const text = clipboard.readText();
    win.show();
    win.focus();
    const name = activeTab && tabs[activeTab] ? activeTab : "ChatGPT";
    switchTab(name);
    const view = views[name];
    if (!text || !isViewUsable(view)) return;
    try {
      view.webContents.focus();
      view.webContents.insertText(text);
    } catch {}
  });
  if (ok) registeredHotkey = accel;
}

let autoUpdater = null;

function setupUpdates() {
  if (!app.isPackaged) return;
  try {
    autoUpdater = require("electron-updater").autoUpdater;
  } catch {
    autoUpdater = null;
    return;
  }
  autoUpdater.autoDownload = false;
  autoUpdater.on("update-available", (info) => {
    if (win && !win.isDestroyed()) win.webContents.send("update-available", { version: info && info.version });
  });
  autoUpdater.on("update-downloaded", () => {
    if (win && !win.isDestroyed()) win.webContents.send("update-downloaded");
  });
  autoUpdater.on("error", () => {});
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 4 * 60 * 60 * 1000);
}

// ── Extension registry ──────────────────────────────────────────────────────

function getRegistryFile() {
  return path.join(app.getPath("userData"), "extensions-registry.json");
}

function normalizeRegistryEntry(entry) {
  const inferredStoreId = entry.storeId
    ?? (entry.source === "store" && entry.path ? path.basename(entry.path) : null);

  if (typeof entry === "string") {
    return {
      id: null,
      storeId: null,
      name: path.basename(entry),
      path: entry,
      enabled: true,
      source: "manual",
    };
  }

  return {
    id: entry.id ?? null,
    storeId: inferredStoreId,
    name: entry.name ?? path.basename(entry.path ?? "Extension"),
    path: entry.path,
    enabled: entry.enabled !== false,
    source: entry.source ?? "manual",
  };
}

function loadRegistry() {
  try {
    return JSON.parse(fs.readFileSync(getRegistryFile(), "utf8"))
      .map(normalizeRegistryEntry)
      .filter(entry => entry.path);
  }
  catch { return []; }
}

function saveRegistry(entries) {
  fs.writeFileSync(getRegistryFile(), JSON.stringify(entries.map(normalizeRegistryEntry), null, 2));
}

function getManifestName(extPath) {
  try {
    const manifestPath = path.join(extPath, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return manifest.name || path.basename(extPath);
  } catch {
    return path.basename(extPath);
  }
}

async function loadExtensionIntoAllSessions(extPath) {
  let loadedExtension = null;

  for (const targetSession of getAllSessions()) {
    const api = getExtensionsApi(targetSession);
    const extension = await api.loadExtension(extPath, { allowFileAccess: true });
    if (!loadedExtension) loadedExtension = extension;
  }

  return loadedExtension;
}

async function removeExtensionFromAllSessions(extensionId) {
  for (const targetSession of getAllSessions()) {
    const api = getExtensionsApi(targetSession);
    const loaded = api.getAllExtensions?.().some(extension => extension.id === extensionId);
    if (loaded) api.removeExtension(extensionId);
  }
}

function upsertRegistryEntry(nextEntry) {
  const registry = loadRegistry();
  const existingIndex = registry.findIndex(entry =>
    (nextEntry.storeId && entry.storeId === nextEntry.storeId) ||
    (nextEntry.id && entry.id === nextEntry.id) ||
    entry.path === nextEntry.path
  );

  if (existingIndex >= 0) {
    registry[existingIndex] = { ...registry[existingIndex], ...nextEntry };
  } else {
    registry.push(normalizeRegistryEntry(nextEntry));
  }

  saveRegistry(registry);
  return registry;
}

function findRegistryEntry(registry, lookupId) {
  return registry.find(entry =>
    entry.storeId === lookupId ||
    entry.id === lookupId ||
    entry.path === lookupId
  );
}

async function setExtensionEnabled(extensionLookupId, enabled) {
  const registry = loadRegistry();
  const targetEntry = findRegistryEntry(registry, extensionLookupId);

  if (!targetEntry) {
    throw new Error("Extension not found in registry");
  }

  if (!fs.existsSync(targetEntry.path)) {
    throw new Error("Extension files are missing");
  }

  if (enabled) {
    // Keep only one active extension at a time to avoid proxy conflicts.
    for (const entry of registry) {
      if (entry.id && entry.id !== targetEntry.id && entry.enabled) {
        await removeExtensionFromAllSessions(entry.id);
        entry.enabled = false;
      }
    }

    const loaded = await loadExtensionIntoAllSessions(targetEntry.path);
    targetEntry.id = loaded.id || targetEntry.id;
    targetEntry.name = loaded.name || targetEntry.name;
    targetEntry.enabled = true;
  } else {
    if (targetEntry.id) await removeExtensionFromAllSessions(targetEntry.id);
    targetEntry.enabled = false;
  }

  saveRegistry(registry);
  return registry;
}

async function uninstallExtension(extensionLookupId) {
  const registry = loadRegistry();
  const targetEntry = findRegistryEntry(registry, extensionLookupId);

  if (!targetEntry) {
    throw new Error("Extension not found in registry");
  }

  if (targetEntry.id) {
    await removeExtensionFromAllSessions(targetEntry.id);
  }

  if (targetEntry.path && fs.existsSync(targetEntry.path)) {
    fs.rmSync(targetEntry.path, { recursive: true, force: true });
  }

  const nextRegistry = registry.filter(entry => entry !== targetEntry);
  saveRegistry(nextRegistry);
  return nextRegistry;
}

async function loadPersistedExtensions() {
  const registry = loadRegistry();

  for (const entry of registry) {
    if (!entry.enabled || !fs.existsSync(entry.path)) continue;

    try {
      const loaded = await loadExtensionIntoAllSessions(entry.path);
      entry.id = loaded.id || entry.id;
      entry.name = loaded.name || entry.name;
    } catch {
      entry.enabled = false;
    }
  }

  saveRegistry(registry);
}

// ── CRX download & install ──────────────────────────────────────────────────

function downloadFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error("Too many redirects"));
    const mod = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);
    const req = mod.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlink(dest, () => {});
        downloadFile(res.headers.location, dest, redirects + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    });
    req.on("error", (err) => { fs.unlink(dest, () => {}); reject(err); });
  });
}

function extractZipFromCrx(buf) {
  if (buf.slice(0, 4).toString("ascii") === "Cr24") {
    const headerLen = buf.readUInt32LE(8);
    return buf.slice(12 + headerLen);
  }
  return buf; // already raw ZIP
}

async function installExtensionById(extensionId) {
  const url = `https://clients2.google.com/service/update2/crx?response=redirect&os=mac&arch=x64&os_arch=x86_64&prod=chromecrx&prodchannel=stable&prodversion=138.0.7204.169&acceptformat=crx2,crx3&x=id%3D${extensionId}%26installsource%3Dondemand%26uc`;
  const tmpCrx = path.join(os.tmpdir(), `aihub-${extensionId}.crx`);
  const tmpZip = path.join(os.tmpdir(), `aihub-${extensionId}.zip`);
  const extDir = path.join(app.getPath("userData"), "extensions", extensionId);

  await downloadFile(url, tmpCrx);

  const crxBuf = fs.readFileSync(tmpCrx);
  const zipBuf = extractZipFromCrx(crxBuf);
  fs.writeFileSync(tmpZip, zipBuf);

  fs.mkdirSync(extDir, { recursive: true });
  await new Promise((resolve, reject) => {
    yauzl.open(tmpZip, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        const destPath = path.join(extDir, entry.fileName);
        if (/\/$/.test(entry.fileName)) {
          fs.mkdirSync(destPath, { recursive: true });
          zipfile.readEntry();
        } else {
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          zipfile.openReadStream(entry, (streamErr, readStream) => {
            if (streamErr) return reject(streamErr);
            const writeStream = fs.createWriteStream(destPath);
            readStream.pipe(writeStream);
            writeStream.on("finish", () => zipfile.readEntry());
            writeStream.on("error", reject);
          });
        }
      });
      zipfile.on("end", resolve);
      zipfile.on("error", reject);
    });
  });

  const registry = loadRegistry();
  for (const entry of registry) {
    if (entry.id && entry.id !== extensionId && entry.enabled) {
      await removeExtensionFromAllSessions(entry.id);
      entry.enabled = false;
    }
  }

  const loaded = await loadExtensionIntoAllSessions(extDir);
  const nextRegistry = upsertRegistryEntry({
    id: loaded.id || extensionId,
    storeId: extensionId,
    name: loaded.name || getManifestName(extDir),
    path: extDir,
    enabled: true,
    source: "store",
  });

  for (const entry of nextRegistry) {
    if (entry.id && entry.id !== (loaded.id || extensionId)) entry.enabled = false;
  }
  saveRegistry(nextRegistry);

  try { fs.unlinkSync(tmpCrx); } catch {}
  try { fs.unlinkSync(tmpZip); } catch {}

  return {
    success: true,
    path: extDir,
    id: loaded.id || extensionId,
    name: loaded.name || getManifestName(extDir),
  };
}

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

function normalizeTheme(theme) {
  if (theme === "light" || theme === "dark" || theme === "system") return theme;
  return "dark";
}

function resolvedContentTheme() {
  if (contentTheme === "system") return nativeTheme.shouldUseDarkColors ? "dark" : "light";
  return contentTheme === "light" ? "light" : "dark";
}

function themeColor() {
  return THEME_COLORS[resolvedContentTheme()];
}

function guestThemeScript() {
  const theme = resolvedContentTheme();
  return `(() => {
    const theme = ${JSON.stringify(theme)};
    const dark = theme === "dark";
    const root = document.documentElement;
    if (!root) return;
    root.style.colorScheme = theme;

    const syncEl = (el) => {
      if (!el || !el.classList) return;
      if (el.classList.contains("dark") || el.classList.contains("light")) {
        el.classList.toggle("dark", dark);
        el.classList.toggle("light", !dark);
      }
      if (el.classList.contains("theme-dark") || el.classList.contains("theme-light")) {
        el.classList.toggle("theme-dark", dark);
        el.classList.toggle("theme-light", !dark);
      }
      for (const attr of ["data-theme", "data-bs-theme", "data-color-mode", "data-mode"]) {
        const value = el.getAttribute(attr);
        if (value === "light" || value === "dark") el.setAttribute(attr, theme);
      }
    };

    syncEl(root);
    syncEl(document.body);
  })()`;
}

function isHubWebContents(webContents) {
  return !!(win && !win.isDestroyed() && webContents && webContents === win.webContents);
}

const insertedThemeCss = new WeakMap();

function syncGuestColorScheme(webContents) {
  if (!webContents || webContents.isDestroyed() || isHubWebContents(webContents)) return;
  try {
    const result = webContents.executeJavaScript(guestThemeScript());
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {}
}

async function applyGuestColorScheme(webContents) {
  if (!webContents || webContents.isDestroyed() || isHubWebContents(webContents)) return;
  const scheme = resolvedContentTheme();
  try {
    const previous = insertedThemeCss.get(webContents);
    if (previous) await webContents.removeInsertedCSS(previous);
    const key = await webContents.insertCSS(
      `html { color-scheme: ${scheme} !important; }`,
      { cssOrigin: "user" },
    );
    insertedThemeCss.set(webContents, key);
  } catch {}
  try {
    const dbg = webContents.debugger;
    if (!dbg.isAttached()) dbg.attach("1.3");
    await dbg.sendCommand("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: scheme }],
    });
  } catch {}
  syncGuestColorScheme(webContents);
}

function eachGuestView(visit) {
  const seen = new Set();
  const take = (view) => {
    if (!isViewUsable(view) || seen.has(view)) return;
    seen.add(view);
    visit(view);
  };
  for (const view of Object.values(views)) take(view);
  for (const view of parkedViews.values()) take(view);
  for (const slot of compareSlots) take(slot.view);
}

function paintViewTheme(view) {
  if (!view) return;
  try { view.setBackgroundColor(themeColor()); } catch {}
}

function applyContentTheme(theme) {
  contentTheme = normalizeTheme(theme);
  if (nativeTheme.themeSource !== contentTheme) nativeTheme.themeSource = contentTheme;
  const color = themeColor();

  if (win && !win.isDestroyed()) {
    try { win.setBackgroundColor(color); } catch {}
  }

  eachGuestView((view) => {
    paintViewTheme(view);
    void applyGuestColorScheme(view.webContents);
  });

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window || window.isDestroyed() || window === win) continue;
    try {
      const url = window.webContents.getURL() || "";
      if (url.startsWith("devtools://")) continue;
    } catch {}
    try { window.setBackgroundColor(color); } catch {}
    void applyGuestColorScheme(window.webContents);
  }
}

nativeTheme.on("updated", () => {
  if (contentTheme !== "system") return;
  applyContentTheme("system");
});

function attachGuestTheme(webContents) {
  if (!webContents) return;
  webContents.on("did-finish-load", () => {
    void applyGuestColorScheme(webContents);
  });
}

function getTabUrl(name) {
  return tabState[name]?.url || tabs[name];
}

function getTabOrigin(name) {
  try {
    return new URL(tabs[name]).origin;
  } catch {
    return null;
  }
}

// chat.openai.com is the configured ChatGPT URL; the app now lives on chatgpt.com.
const CHATGPT_HOSTS = new Set(["chat.openai.com", "chatgpt.com", "www.chatgpt.com"]);
// chat.qwenlm.ai permanently redirects to chat.qwen.ai. The page also treats
// these registrable domains as its own hosts.
const QWEN_HOSTS = ["qwen.ai", "qwenlm.ai", "qwenlm.io", "qwenchat.com"];

function isServiceUrlForTab(name, url) {
  try {
    // 127.0.0.1 and localhost are different origins, and a custom Gateway port
    // is not the default tab origin. Keep those Control UI navigations in-app.
    if (name === OPENCLAW_TAB && isOpenClawControlUrl(url)) return true;
    const tabOrigin = getTabOrigin(name);
    if (!tabOrigin) return false;
    const target = new URL(url);
    if (target.origin === tabOrigin) return true;
    const tabHost = new URL(tabOrigin).hostname;
    if (target.protocol !== "https:" && target.protocol !== "http:") return false;
    if (name === "Qwen" && QWEN_HOSTS.some((host) => hostnameMatches(target.hostname, host))) return true;
    if (target.protocol !== "https:") return false;
    return CHATGPT_HOSTS.has(tabHost) && CHATGPT_HOSTS.has(target.hostname);
  } catch {
    return false;
  }
}

function hostnameMatches(hostname, expected) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  const base = String(expected || "").toLowerCase().replace(/\.$/, "");
  if (!host || !base) return false;
  if (host === base || host.endsWith(`.${base}`)) return true;
  const hostApex = host.replace(/^www\./, "");
  const baseApex = base.replace(/^www\./, "");
  return hostApex === baseApex || hostApex.endsWith(`.${baseApex}`);
}

function registrableDomain(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return host;
  return parts.slice(-2).join(".");
}

function inAppHostsForTab(tabName) {
  const hosts = [];
  try {
    hosts.push(new URL(tabs[tabName]).hostname);
  } catch {}
  if (tabName === "ChatGPT") hosts.push("chat.openai.com", "chatgpt.com");
  if (tabName === "Claude") hosts.push("claude.ai");
  if (tabName === "Gemini") hosts.push("gemini.google.com");
  if (tabName === "Qwen") hosts.push(...QWEN_HOSTS);
  return hosts;
}

function isKnownInAppHost(tabName, hostname) {
  return inAppHostsForTab(tabName).some((host) => hostnameMatches(hostname, host));
}

function isAccountsGoogleHost(host) {
  if (host === "accounts.google.com" || host.endsWith(".accounts.google.com")) return true;
  return /^accounts\.google\.(?:[a-z]{2,3}|[a-z]{2}\.[a-z]{2}|com\.[a-z]{2})$/.test(host);
}

function isServiceOauthUrl(tabName, host, path) {
  const authPath = /\/(?:oauth2?|signin|sign-in|authorize|authorise)(?:\/|$)/.test(path);
  if (authPath && isKnownInAppHost(tabName, host)) return true;

  let serviceDomain = "";
  try {
    serviceDomain = registrableDomain(new URL(tabs[tabName]).hostname);
  } catch {
    return false;
  }
  if (!serviceDomain || serviceDomain === "google.com" || serviceDomain === "youtube.com") return false;
  if (registrableDomain(host) !== serviceDomain) return false;
  if (authPath) return true;
  return /^(?:login|auth|signin|accounts|oauth|sso)\./.test(host);
}

function isLikelyIdpHost(tabName, host) {
  if (isKnownInAppHost(tabName, host)) return true;
  if (/^(?:login|auth|signin|accounts|oauth|sso)\./.test(host)) return true;
  return host === "google.com"
    || host.endsWith(".google.com")
    || host.endsWith(".youtube.com")
    || host.endsWith(".apple.com")
    || host.endsWith(".microsoftonline.com")
    || host.endsWith(".live.com")
    || host.endsWith(".microsoft.com")
    || host.endsWith(".openai.com")
    || host.endsWith(".googleapis.com");
}

function isAuthOrIdpUrl(tabName, parsed) {
  const host = String(parsed.hostname || "").toLowerCase().replace(/\.$/, "");
  const path = String(parsed.pathname || "/").toLowerCase();

  if (isAccountsGoogleHost(host)) return true;

  const authHosts = [
    "accounts.youtube.com",
    "appleid.apple.com",
    "login.microsoftonline.com",
    "login.live.com",
    "login.microsoft.com",
    "auth.openai.com",
    "oauth2.googleapis.com",
  ];
  if (authHosts.some((authHost) => hostnameMatches(host, authHost))) return true;
  if (path.includes("gsi/select")) return true;
  if ((host === "google.com" || host.endsWith(".google.com")) && path.includes("/o/oauth2")) return true;
  if (isServiceOauthUrl(tabName, host, path)) return true;

  try {
    if (typeof isAuthPopupUrl === "function" && isAuthPopupUrl(parsed.href)) {
      const genericPath = /\/(?:oauth2?|authorize|signin|sign-in|login)(?:\/|$)/.test(path);
      if (!genericPath || isLikelyIdpHost(tabName, host)) return true;
    }
  } catch {
    return true;
  }

  return false;
}

function shouldOpenInSystemBrowser(tabName, url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (isServiceUrlForTab(tabName, url)) return false;
    if (isKnownInAppHost(tabName, parsed.hostname)) return false;
    if (isAuthOrIdpUrl(tabName, parsed)) return false;
    return true;
  } catch {
    return false;
  }
}

const externalOpenRecent = new Map();

function openInSystemBrowser(url) {
  const now = Date.now();
  const previous = externalOpenRecent.get(url);
  if (previous && now - previous < 750) return;
  externalOpenRecent.set(url, now);

  try {
    const pending = shell.openExternal(url);
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  } catch {}
}

function attachExternalLinkGuard(webContents, tabName) {
  if (!webContents || typeof webContents.on !== "function") return;

  // will-navigate is the main-frame event. will-frame-navigate fires for that same
  // click as well, so a second listener would open the system browser twice.
  // window.open is handled by setWindowOpenHandler, not this event.
  webContents.on("will-navigate", (details, url, _isInPlace, isMainFrameArg) => {
    const targetUrl = typeof details?.url === "string" && details.url ? details.url : url;
    const isMainFrame = typeof details?.isMainFrame === "boolean"
      ? details.isMainFrame
      : typeof isMainFrameArg === "boolean"
        ? isMainFrameArg
        : true;
    if (!isMainFrame || !shouldOpenInSystemBrowser(tabName, targetUrl)) return;
    details.preventDefault();
    openInSystemBrowser(targetUrl);
  });
}

function isAuthPopupUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  const googleHost = host === "google.com" || host.endsWith(".google.com");

  if (host === "accounts.google.com" || host.startsWith("accounts.google.")) return true;
  if (host === "accounts.youtube.com" || host === "oauth2.googleapis.com") return true;
  if (googleHost && /\/(o\/oauth2|oauth|gsi|signin|servicelogin|accountchooser)(\/|$)/.test(path)) return true;

  if (host === "appleid.apple.com" || host.endsWith(".appleid.apple.com")) return true;
  if (host === "login.microsoftonline.com" || host.startsWith("login.microsoftonline.")) return true;
  if (host === "login.live.com" || host.endsWith(".login.live.com")) return true;
  if (host === "login.microsoft.com" || host === "auth.openai.com") return true;

  if ((host === "claude.ai" || host.endsWith(".claude.ai")) &&
      /\/(auth|oauth|callback|login|signin|sign-in)(\/|$)/.test(path)) {
    return true;
  }

  if (/^(login|auth|signin|accounts|oauth|sso)\./.test(host)) return true;
  if (/\/(oauth2?|authorize|signin|sign-in|login)(\/|$)/.test(path)) return true;
  return false;
}

function isOpenerPopupUrl(tabName, url) {
  if (url === "about:blank" || url === "about:blank/") return true;
  if (isServiceUrlForTab(tabName, url)) return true;
  // Same auth/IdP gate as main-frame clicks. A generic /login path on an
  // ordinary host is not an identity provider, so it must fall through to
  // the system browser instead of becoming an in-app allow-popup.
  try {
    return isAuthOrIdpUrl(tabName, new URL(url));
  } catch {
    return false;
  }
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
  const view = views[activeTab];
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
  if (!win || win.isDestroyed()) return;
  const url = targetUrl || tabs[OPENCLAW_TAB];
  if (!isViewUsable(views[OPENCLAW_TAB])) {
    createTab(OPENCLAW_TAB, url);
    if (views[OPENCLAW_TAB]) {
      if (openClawUrlHasToken(url)) views[OPENCLAW_TAB].openclawBootstrapped = true;
      concealOpenClawChrome(views[OPENCLAW_TAB].webContents);
    }
    return;
  }

  const view = views[OPENCLAW_TAB];
  activeTab = OPENCLAW_TAB;
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
  if (openClawUrlHasToken(url)) openclawAuthedUrl = url;
}

function loadOpenClawAuth() {
  if (openclawAuthedUrl) return Promise.resolve(openclawAuthedUrl);
  if (!openclawAuthPromise) {
    openclawAuthPromise = openClawDashboard().then((page) => {
      openclawAuthPromise = null;
      if (page && page.authed && openClawUrlHasToken(page.url)) {
        openclawAuthedUrl = page.url;
        return openclawAuthedUrl;
      }
      return "";
    }, () => {
      openclawAuthPromise = null;
      return "";
    });
  }
  return openclawAuthPromise;
}

function presentOpenClawPage() {
  if (openclawPresentPromise) return openclawPresentPromise;
  openclawPresentPromise = presentOpenClawPageOnce().finally(() => {
    openclawPresentPromise = null;
  });
  return openclawPresentPromise;
}

async function presentOpenClawPageOnce() {
  if (!win || win.isDestroyed() || activeTab !== OPENCLAW_TAB || isBoardWorkspace()) {
    hideOpenClawView();
    return false;
  }
  const existing = views[OPENCLAW_TAB];
  if (isViewUsable(existing) && existing.openclawBootstrapped) {
    ensureOpenClawView(openclawAuthedUrl || tabs[OPENCLAW_TAB], false);
    return true;
  }
  const url = openclawAuthedUrl || await loadOpenClawAuth();
  if (activeTab !== OPENCLAW_TAB || isBoardWorkspace()) return false;
  if (!url) {
    hideOpenClawView();
    return false;
  }
  cacheOpenClawAuth(url);
  ensureOpenClawView(url, true);
  return true;
}

function notifyOpenClawPage(ready) {
  if (win && !win.isDestroyed()) win.webContents.send("openclaw-page", { ready: Boolean(ready) });
}

function applyOpenClawSnapshot(status) {
  openclawSnapshot = status;
  if (!win || win.isDestroyed() || activeTab !== OPENCLAW_TAB) return status;
  if (isBoardWorkspace()) {
    hideOpenClawView();
    return status;
  }
  const view = views[OPENCLAW_TAB];
  const opening = Boolean(openclawPresentPromise) || Boolean(view && view.openclawBootstrapped);
  if ((!status || !status.gatewayUp) && !opening) hideOpenClawView();
  return status;
}

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
  let current = null;
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

// ── Shared Google account ───────────────────────────────────────────────────

const googleClicks = new Set();
let googleWindow = null;

function googleAccountsFile() {
  return path.join(app.getPath("userData"), "google-accounts.json");
}

function readGoogleBook() {
  try {
    const raw = JSON.parse(fs.readFileSync(googleAccountsFile(), "utf8"));
    const overrides = raw && raw.overrides && typeof raw.overrides === "object" ? raw.overrides : {};
    const clean = {};
    for (const [name, value] of Object.entries(overrides)) {
      if (tabs[name] && name !== OPENCLAW_TAB && value) clean[name] = true;
    }
    return {
      email: typeof raw.email === "string" ? raw.email.slice(0, 120) : "",
      overrides: clean,
    };
  } catch {
    return { email: "", overrides: {} };
  }
}

function writeGoogleBook(book) {
  const dest = googleAccountsFile();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(book, null, 2));
}

function googleSession() {
  return session.fromPartition(GOOGLE_PARTITION);
}

async function googleSnapshot() {
  const book = readGoogleBook();
  let cookies = [];
  try { cookies = await googleSession().cookies.get({}); } catch {}
  return {
    signedIn: hasGoogleSession(cookies),
    email: book.email || "",
    services: Object.keys(tabs),
    overrides: book.overrides,
  };
}

function sendGoogle(status) {
  if (win && !win.isDestroyed()) win.webContents.send("google-status", status);
}

async function publishGoogle() {
  const status = await googleSnapshot();
  sendGoogle(status);
  return status;
}

function cookieUrl(cookie) {
  const host = String(cookie.domain || "").replace(/^\./, "");
  return `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`;
}

async function clearGoogleCookies(targetSession) {
  const cookies = await targetSession.cookies.get({});
  await Promise.all(cookies.filter((cookie) => isGoogleHost(cookie.domain)).map((cookie) => (
    targetSession.cookies.remove(cookieUrl(cookie), cookie.name).catch(() => {})
  )));
}

async function copyGoogleCookies(fromSession, toSession) {
  const cookies = await fromSession.cookies.get({});
  for (const cookie of cookies) {
    if (!isGoogleHost(cookie.domain) || !cookie.name || !cookie.value) continue;
    const payload: any = {
      url: cookieUrl(cookie),
      name: cookie.name,
      value: cookie.value,
      path: cookie.path || "/",
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
    };
    if (String(cookie.domain || "").startsWith(".")) payload.domain = cookie.domain;
    if (cookie.expirationDate) payload.expirationDate = cookie.expirationDate;
    if (cookie.sameSite && cookie.sameSite !== "unspecified") payload.sameSite = cookie.sameSite;
    try { await toSession.cookies.set(payload); } catch {}
  }
}

function armGoogleClick(view, name) {
  if (!view || !view.webContents) return;
  googleClicks.add(name);
  const onLoad = () => {
    if (!googleClicks.has(name)) {
      view.webContents.removeListener("did-finish-load", onLoad);
      return;
    }
    const current = view.webContents.getURL() || "";
    if (/accounts\.google\.com|myaccount\.google\.com/.test(current)) return;
    view.webContents.executeJavaScript(CLICK_GOOGLE_SCRIPT, true).catch(() => {});
    googleClicks.delete(name);
    view.webContents.removeListener("did-finish-load", onLoad);
  };
  view.webContents.on("did-finish-load", onLoad);
}

function openServiceForGoogle(name) {
  const url = loginUrlFor(name) || tabs[name];
  const background = Boolean(activeTab && activeTab !== name);
  if (!isViewUsable(views[name])) {
    createTab(name, url, { background, googleClick: name !== "Gemini" });
    return;
  }
  const view = views[name];
  if (name !== "Gemini") armGoogleClick(view, name);
  let current = "";
  try { current = view.webContents.getURL(); } catch {}
  if (current !== url) view.webContents.loadURL(url);
  else if (name !== "Gemini") view.webContents.executeJavaScript(CLICK_GOOGLE_SCRIPT, true).catch(() => {});
}

async function rememberGoogleEmail(page) {
  if (!page || page.isDestroyed()) return;
  let text = "";
  try { text = await page.executeJavaScript("document.body ? document.body.innerText.slice(0, 4000) : ''", true); } catch {}
  const email = findEmail(text);
  if (!email) return;
  const book = readGoogleBook();
  book.email = email;
  writeGoogleBook(book);
}

function openGoogleChooser(partition) {
  const targetSession = session.fromPartition(partition);
  try { targetSession.setUserAgent(app.userAgentFallback); } catch {}
  if (proxyConfig) {
    applyWebRTCPolicy(targetSession, "tunnel");
    targetSession.setProxy(proxyConfig).catch(() => {});
  }
  if (googleWindow && !googleWindow.isDestroyed()) {
    googleWindow.close();
  }
  const popup = new BrowserWindow({
    width: 520,
    height: 760,
    parent: win,
    autoHideMenuBar: true,
    title: "Google",
    backgroundColor: themeColor(),
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  googleWindow = popup;
  popup.sharedGoogle = partition === GOOGLE_PARTITION;
  if (proxyConfig) applyWebRTCPolicyToContents(popup.webContents, "tunnel");
  const note = () => {
    const follow = popup.sharedGoogle ? rememberGoogleEmail(popup.webContents) : Promise.resolve();
    void follow.then(() => publishGoogle());
  };
  popup.webContents.on("did-navigate", (_event, url) => {
    if (/myaccount\.google\.com/.test(url || "")) note();
  });
  popup.on("closed", () => {
    if (googleWindow === popup) googleWindow = null;
    void publishGoogle();
  });
  popup.loadURL(ACCOUNT_URL);
  return popup;
}

async function applySharedGoogle() {
  const source = googleSession();
  const cookies = await source.cookies.get({});
  if (!hasGoogleSession(cookies)) {
    openGoogleChooser(GOOGLE_PARTITION);
    return publishGoogle();
  }
  const book = readGoogleBook();
  const names = targetsForApply(Object.keys(tabs), book.overrides);
  for (const name of names) {
    const target = session.fromPartition(partitionForTab(name));
    await clearGoogleCookies(target);
    await copyGoogleCookies(source, target);
    openServiceForGoogle(name);
  }
  return publishGoogle();
}

// ── IPC ─────────────────────────────────────────────────────────────────────

ipcMain.on("switch-tab", (_event, tabName) => {
  void handleSwitchTab(tabName);
});

handle("services-list", () => services.list());

handle("services-set-route", async (_event, payload) => {
  try {
    const status = await services.setRoute(payload && payload.id, payload && payload.route);
    const id = payload && payload.id;
    const accounts = services.accounts().filter((account) => account.serviceId === id);
    const targets = await Promise.all(accounts.map((account) => configureAccountProxy(account)));
    await Promise.all(accounts.map((account, index) => {
      if (shouldKeepConnections(account.partition)) return undefined;
      return targets[index].closeAllConnections().catch(() => {});
    }));
    return { success: true, status };
  }
  catch (err) { return { success: false, error: err.message, status: services.list() }; }
});

handle("services-set-hidden", async (_event, payload) => {
  try { return { success: true, status: await services.setHidden(payload && payload.id, payload && payload.hidden) }; }
  catch (err) { return { success: false, error: err.message, status: services.list() }; }
});

handle("services-reorder", async (_event, ids) => {
  try { return { success: true, status: await services.reorder(ids) }; }
  catch (err) { return { success: false, error: err.message, status: services.list() }; }
});

handle("services-add-account", async (_event, payload) => {
  try {
    const status = await services.addAccount(payload && payload.id, payload && payload.label);
    const id = payload && payload.id;
    if (id && tabs[id]) switchTab(id);
    return { success: true, status };
  } catch (err) {
    return { success: false, error: err.message, status: services.list() };
  }
});

handle("services-set-account", async (_event, payload) => {
  try {
    const status = await services.setActiveAccount(payload && payload.id, payload && payload.accountId);
    const id = payload && payload.id;
    if (id && tabs[id]) switchTab(id);
    return { success: true, status };
  } catch (err) {
    return { success: false, error: err.message, status: services.list() };
  }
});

handle("services-set-label", async (_event, payload) => {
  try {
    return { success: true, status: await services.setAccountLabel(payload && payload.id, payload && payload.accountId, payload && payload.label) };
  } catch (err) {
    return { success: false, error: err.message, status: services.list() };
  }
});

handle("services-remove-account", async (_event, payload) => {
  try { return { success: true, status: await services.removeAccount(payload && payload.id, payload && payload.accountId) }; }
  catch (err) { return { success: false, error: err.message, status: services.list() }; }
});

handle("services-add-custom", async (_event, payload) => {
  try { return { success: true, status: await services.addCustom(payload && payload.name, payload && payload.url) }; }
  catch (err) { return { success: false, error: err.message, status: services.list() }; }
});

handle("services-remove-custom", async (_event, id) => {
  try { return { success: true, status: await services.removeCustom(id) }; }
  catch (err) { return { success: false, error: err.message, status: services.list() }; }
});

handle("services-set-hotkey", async (_event, hotkey) => {
  try {
    const status = await services.setHotkey(hotkey);
    registerHotkey();
    return { success: true, status };
  } catch (err) {
    return { success: false, error: err.message, status: services.list() };
  }
});

handle("services-set-spellcheck", async (_event, languages) => {
  try {
    const status = await services.setSpellcheckLanguages(languages);
    applySpellcheck();
    return { success: true, status };
  } catch (err) {
    return { success: false, error: err.message, status: services.list() };
  }
});

handle("compare-start", async (_event, taskId) => {
  try { return await startCompare(taskId); }
  catch (err) { return { success: false, error: err.message }; }
});

handle("compare-insert", () => insertCompareText());

handle("compare-stop", () => {
  closeCompare({ restore: true });
  return { success: true };
});

handle("find-in-page", (_event, text, findNext) => {
  const view = activeTab && views[activeTab];
  if (!isViewUsable(view) || !text) return { success: false };
  view.webContents.findInPage(String(text), { forward: true, findNext: Boolean(findNext) });
  return { success: true };
});

handle("find-stop", () => {
  const view = activeTab && views[activeTab];
  if (isViewUsable(view)) view.webContents.stopFindInPage("clearSelection");
  return { success: true };
});

handle("update-download", async () => {
  if (!autoUpdater) return { success: false, error: "Updates are available in the installed app" };
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

handle("update-install", () => {
  if (!autoUpdater) return { success: false, error: "Updates are available in the installed app" };
  autoUpdater.quitAndInstall();
  return { success: true };
});

ipcMain.on("set-content-theme", (_event, theme) => {
  applyContentTheme(theme);
});

ipcMain.on("move-window-by", (_event, dx, dy) => {
  if (!win || win.isDestroyed()) return;
  const x = Number(dx);
  const y = Number(dy);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const [left, top] = win.getPosition();
  win.setPosition(Math.round(left + x), Math.round(top + y));
});

ipcMain.on("set-topbar-height", (_event, h) => {
  const next = Number(h);
  if (!Number.isFinite(next) || next < 0 || next > 4000) return;
  topBarHeight = next;
  if (compareOpen) {
    layoutCompare();
    return;
  }
  if (isBoardWorkspace()) return;
  if (activeTab && isViewUsable(views[activeTab])) resizeView(views[activeTab]);
});

handle("set-proxy", async (_event, config) => {
  await wireguard.stopForExternalProxy();
  await applyHubProxy(config);
  return { success: true };
});

handle("clear-proxy", async () => {
  await wireguard.stopForExternalProxy();
  await clearHubProxy();
  return { success: true };
});

handle("wg-list", () => wireguard.list());

handle("wg-import", () => wireguard.importConfigs());

handle("wg-remove", async (_event, id) => {
  try {
    return await wireguard.remove(id);
  } catch (err) {
    return { success: false, error: err.message, status: wireguard.status() };
  }
});

handle("wg-connect", async (_event, id) => {
  try {
    const status = await wireguard.connect(id);
    return { success: true, status };
  } catch (err) {
    return { success: false, error: err.message, status: wireguard.status() };
  }
});

handle("tunnel-cancel", () => cancelTunnelStartup());

handle("wg-disconnect", async () => {
  try {
    return await wireguard.disconnect();
  } catch (err) {
    return { success: false, error: err.message, status: wireguard.status() };
  }
});

handle("openclaw-probe", async () => {
  const url = openclawSnapshot && openclawSnapshot.url;
  const up = await probeGateway(url);
  return { gatewayUp: Boolean(up) };
});

handle("openclaw-status", async () => {
  const status = await inspectOpenClaw();
  applyOpenClawSnapshot(status);
  if (status && status.gatewayUp && activeTab === OPENCLAW_TAB && !isBoardWorkspace()) {
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
  if (result.status && result.status.gatewayUp && activeTab === OPENCLAW_TAB) {
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
  if (result.status && result.status.gatewayUp && activeTab === OPENCLAW_TAB) {
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
  if (result && result.success && activeTab === OPENCLAW_TAB) {
    const view = views[OPENCLAW_TAB];
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
  const wasActive = activeTab === OPENCLAW_TAB;
  activeTab = OPENCLAW_TAB;
  ensureOpenClawView(result.url, true);
  openclawSnapshot = {
    ...(openclawSnapshot || {}),
    installed: true,
    gatewayUp: true,
    phase: "running",
    url: result.cleanUrl || openclawSnapshot?.url || tabs[OPENCLAW_TAB],
    error: null,
  };
  if (!wasActive && win && !win.isDestroyed()) win.webContents.send("tab-active", OPENCLAW_TAB);
  return { success: true, error: result.error || null, url: result.cleanUrl || null };
});

ipcMain.on("reload-active-tab", (_event, ignoreCache) => {
  reloadActiveTab(Boolean(ignoreCache));
});

handle("reset-tab-session", async (_event, tabName) => {
  try {
    if (!tabs[tabName]) throw new Error("Unknown tab");
    await resetTabSession(tabName);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

handle("pick-extension", async () => {
  const result = await dialog.showOpenDialog(win, {
    title: "Select unpacked Chrome extension folder",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const extPath = result.filePaths[0];
  try {
    return await withRebuiltViews(async () => {
      const registry = loadRegistry();
      for (const entry of registry) {
        if (entry.id && entry.enabled) {
          await removeExtensionFromAllSessions(entry.id);
          entry.enabled = false;
        }
      }

      const loaded = await loadExtensionIntoAllSessions(extPath);
      const nextRegistry = upsertRegistryEntry({
        id: loaded.id || null,
        storeId: null,
        name: loaded.name || getManifestName(extPath),
        path: extPath,
        enabled: true,
        source: "manual",
      });

      for (const entry of nextRegistry) {
        if (entry.id && loaded.id && entry.id !== loaded.id) entry.enabled = false;
      }
      saveRegistry(nextRegistry);

      return {
        success: true,
        path: extPath,
        id: loaded.id || null,
        name: loaded.name || getManifestName(extPath),
      };
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
});

handle("install-extension", async (_event, extensionId) => {
  try {
    return await withRebuiltViews(() => installExtensionById(extensionId));
  } catch (err) {
    return { success: false, error: err.message };
  }
});

handle("list-extensions", async () => {
  return loadRegistry();
});

handle("toggle-extension", async (_event, extensionId, enabled) => {
  try {
    const extensions = await withRebuiltViews(() => setExtensionEnabled(extensionId, enabled));
    return { success: true, extensions };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

handle("uninstall-extension", async (_event, extensionId) => {
  try {
    const extensions = await withRebuiltViews(() => uninstallExtension(extensionId));
    return { success: true, extensions };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.on("open-external", (_event, url) => shell.openExternal(url));

handle("tasks-list", () => {
  try {
    return tasks.list();
  } catch (err) {
    return taskIpcError(err);
  }
});

handle("tasks-create", async (_event, payload) => {
  try { return await tasks.create(payload); } catch (err) { return taskIpcError(err); }
});

handle("tasks-update", async (_event, payload) => {
  try { return await tasks.update(payload); } catch (err) { return taskIpcError(err); }
});

handle("tasks-delete", async (_event, id) => {
  try { return await tasks.delete(id); } catch (err) { return taskIpcError(err); }
});

handle("tasks-set-status", async (_event, payload) => {
  try { return await tasks.setStatus(payload); } catch (err) { return taskIpcError(err); }
});

handle("tasks-add-assignment", async (_event, payload) => {
  try { return await tasks.addAssignment(payload); } catch (err) { return taskIpcError(err); }
});

handle("tasks-remove-assignment", async (_event, payload) => {
  try { return await tasks.removeAssignment(payload); } catch (err) { return taskIpcError(err); }
});

handle("tasks-open", async (_event, payload) => {
  try {
    const result = await tasks.open(payload);
    if (result && result.success) showTaskService(result.status);
    return result;
  } catch (err) {
    return taskIpcError(err);
  }
});

handle("tasks-set-workspace", async (_event, workspace) => {
  try {
    return await commitWorkspace(workspace);
  } catch (err) {
    return taskIpcError(err);
  }
});

handle("tasks-toggle-workspace", async () => {
  try {
    return await toggleWorkspace();
  } catch (err) {
    return taskIpcError(err);
  }
});

handle("tasks-clear-capture", async () => {
  try { return await tasks.clearCapture(); } catch (err) { return taskIpcError(err); }
});

handle("google-status", () => googleSnapshot());

handle("google-sign-in", async () => {
  openGoogleChooser(GOOGLE_PARTITION);
  return googleSnapshot();
});

handle("google-apply-all", () => applySharedGoogle());

handle("google-use-shared", async (_event, service) => {
  if (!tabs[service] || service === OPENCLAW_TAB) return googleSnapshot();
  const book = readGoogleBook();
  delete book.overrides[service];
  writeGoogleBook(book);
  const source = googleSession();
  const cookies = await source.cookies.get({});
  if (hasGoogleSession(cookies)) {
    const target = session.fromPartition(partitionForTab(service));
    await clearGoogleCookies(target);
    await copyGoogleCookies(source, target);
    openServiceForGoogle(service);
  }
  return publishGoogle();
});

handle("google-use-other", async (_event, service) => {
  if (!tabs[service] || service === OPENCLAW_TAB) return googleSnapshot();
  const book = readGoogleBook();
  book.overrides[service] = true;
  writeGoogleBook(book);
  const target = session.fromPartition(partitionForTab(service));
  await clearGoogleCookies(target);
  openGoogleChooser(partitionForTab(service));
  return publishGoogle();
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
  setupUpdates();

  const iconPath = path.join(__dirname, "../../assets/icon.png");
  if (process.platform === "darwin" && fs.existsSync(iconPath) && app.dock) {
    app.dock.setIcon(iconPath);
  }

  await loadPersistedExtensions();
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
    try {
      if (googleWindow && !googleWindow.isDestroyed()) googleWindow.destroy();
    } catch {}
    googleWindow = null;
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
