const { app, BrowserWindow, BrowserView, ipcMain, session, dialog, shell } = require("electron");
const path = require("path");

app.setName("AI Hub");
const fs = require("fs");
const https = require("https");
const http = require("http");
const os = require("os");
const yauzl = require("yauzl");

let win;
let views = {};
let activeTab = null;
let topBarHeight = 60;
let proxyConfig = null;
let tabState = {};
let popupWindows = new Set();

const tabs = {
  "ChatGPT":    "https://chat.openai.com/",
  "Claude":     "https://claude.ai/",
  "Gemini":     "https://gemini.google.com/",
  "DeepSeek":   "https://chat.deepseek.com/",
  "Qwen":       "https://chat.qwenlm.ai/",
  "Perplexity": "https://www.perplexity.ai/",
  "Mistral":    "https://chat.mistral.ai/",
  "Kimi":       "https://www.kimi.com/",
  "Grok":       "https://grok.com/"
};

function getAllSessions() {
  return Object.keys(tabs).map(name => session.fromPartition(`persist:${name}`));
}

function buildViewPreferences(name) {
  return {
    partition: `persist:${name}`,
    contextIsolation: true,
    nodeIntegration: false,
  };
}

function getExtensionsApi(targetSession) {
  return targetSession.extensions ?? targetSession;
}

async function applyProxyToAll(config) {
  await Promise.all(getAllSessions().map(s => s.setProxy(config)));
}

function rememberTabUrl(name, url) {
  if (!name || !url || url === "about:blank") return;
  tabState[name] = { url };
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
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  win.loadFile("index.html");
  views = {};
  activeTab = null;
  tabState = {};
  popupWindows = new Set();

  win.on("resize", () => {
    if (activeTab && isViewUsable(views[activeTab])) resizeView(views[activeTab]);
  });
}

function isViewUsable(view) {
  return !!(view && view.webContents && !view.webContents.isDestroyed());
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

function isServiceUrlForTab(name, url) {
  try {
    const tabOrigin = getTabOrigin(name);
    if (!tabOrigin) return false;
    return new URL(url).origin === tabOrigin;
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

    try {
      win.removeBrowserView(view);
    } catch {}

    try {
      view.webContents.removeAllListeners();
      view.webContents.close({ waitForBeforeUnload: false });
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
    win.removeBrowserView(view);
  } catch {}

  try {
    view.webContents.removeAllListeners();
    view.webContents.close({ waitForBeforeUnload: false });
  } catch {}

  delete views[name];
  if (activeTab === name) activeTab = null;
}

async function resetTabSession(name) {
  const targetSession = session.fromPartition(`persist:${name}`);

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
      const targetSession = session.fromPartition(`persist:${tabName}`);
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

  popup.loadURL(url);
}

function createTab(name, url = getTabUrl(name)) {
  const view = new BrowserView({
    webPreferences: buildViewPreferences(name)
  });
  views[name] = view;
  win.setBrowserView(view);
  resizeView(view);

  view.webContents.once("destroyed", () => {
    if (views[name] === view) delete views[name];
    if (activeTab === name) activeTab = null;
  });

  if (proxyConfig) {
    session.fromPartition(`persist:${name}`).setProxy(proxyConfig);
  }

  attachReloadShortcuts(view.webContents);

  view.webContents.on("did-start-loading", () => {
    win.webContents.send("tab-progress", name, "start");
  });
  view.webContents.on("did-navigate", (_event, navigatedUrl) => {
    rememberTabUrl(name, navigatedUrl);
  });
  view.webContents.on("did-navigate-in-page", (_event, navigatedUrl) => {
    rememberTabUrl(name, navigatedUrl);
  });
  view.webContents.on("dom-ready", () => {
    win.webContents.send("tab-progress", name, "dom");
  });
  view.webContents.on("did-finish-load", () => {
    win.webContents.send("tab-progress", name, "finish");
  });
  view.webContents.on("did-fail-load", (_e, code) => {
    // -3 = ERR_ABORTED (SPA navigation or user-initiated cancel) — ignore
    if (code !== -3) win.webContents.send("tab-progress", name, "fail");
  });

  view.webContents.loadURL(url);

  view.webContents.setWindowOpenHandler(({ url: u }) => {
    if (name === "Claude") {
      rememberTabUrl(name, u);
      view.webContents.loadURL(u);
      return { action: "deny" };
    }

    openPopupWindow(name, u);
    return { action: "deny" };
  });

  activeTab = name;
}

function switchTab(name) {
  if (!isViewUsable(views[name])) {
    delete views[name];
    createTab(name);
  } else {
    win.setBrowserView(views[name]);
    resizeView(views[name]);
    try {
      rememberTabUrl(name, views[name].webContents.getURL());
    } catch {}
    activeTab = name;
  }
  win.webContents.send("tab-active", name);
}

function resizeView(view) {
  const [width, height] = win.getContentSize();
  view.setBounds({ x: 0, y: topBarHeight, width, height: height - topBarHeight });
  view.setAutoResize({ width: true, height: true });
}

// ── IPC ─────────────────────────────────────────────────────────────────────

ipcMain.on("switch-tab", (_event, tabName) => switchTab(tabName));

ipcMain.on("set-topbar-height", (_event, h) => {
  topBarHeight = h;
  if (activeTab && isViewUsable(views[activeTab])) resizeView(views[activeTab]);
});

ipcMain.handle("set-proxy", async (_event, config) => {
  proxyConfig = config;
  await applyProxyToAll(config);
  return { success: true };
});

ipcMain.handle("clear-proxy", async () => {
  proxyConfig = null;
  await applyProxyToAll({ proxyRules: "" });
  return { success: true };
});

ipcMain.on("reload-active-tab", (_event, ignoreCache) => {
  reloadActiveTab(Boolean(ignoreCache));
});

ipcMain.handle("reset-tab-session", async (_event, tabName) => {
  try {
    if (!tabs[tabName]) throw new Error("Unknown tab");
    await resetTabSession(tabName);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("pick-extension", async () => {
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

ipcMain.handle("install-extension", async (_event, extensionId) => {
  try {
    return await withRebuiltViews(() => installExtensionById(extensionId));
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("list-extensions", async () => {
  return loadRegistry();
});

ipcMain.handle("toggle-extension", async (_event, extensionId, enabled) => {
  try {
    const extensions = await withRebuiltViews(() => setExtensionEnabled(extensionId, enabled));
    return { success: true, extensions };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("uninstall-extension", async (_event, extensionId) => {
  try {
    const extensions = await withRebuiltViews(() => uninstallExtension(extensionId));
    return { success: true, extensions };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.on("open-external", (_event, url) => shell.openExternal(url));

// ── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Strip Electron/Node identifiers from the user-agent so that Google OAuth
  // and other services that block embedded WebView sign-ins work correctly.
  const rawUA = app.userAgentFallback;
  app.userAgentFallback = rawUA
    .replace(/\s*Electron\/\S+/, "")
    .replace(/\s*ai-hub\/\S+/, "");

  createWindow();

  const iconPath = path.join(__dirname, "assets", "icon.png");
  if (process.platform === "darwin" && fs.existsSync(iconPath) && app.dock) {
    app.dock.setIcon(iconPath);
  }

  await loadPersistedExtensions();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
