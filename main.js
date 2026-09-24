const { app, BrowserWindow, BrowserView, ipcMain, session, dialog, shell, nativeTheme } = require("electron");
const path = require("path");

app.setName("AI Hub");
const fs = require("fs");
const https = require("https");
const http = require("http");
const os = require("os");
const yauzl = require("yauzl");
const { createWireguard } = require("./wireguard");
const { createTasks } = require("./tasks");
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
  isOpenClawControlUrl,
  DEFAULT_OPENCLAW_URL,
} = require("./openclaw");

let win;
let views = {};
let activeTab = null;
let topBarHeight = 60;
let proxyConfig = null;
let tabState = {};
let popupWindows = new Set();
let openclawSnapshot = null;
let contentTheme = "dark";

// Tab pages live in BrowserViews, outside the shell document. Point Chromium's
// prefers-color-scheme at the hub theme before any of those pages load.
nativeTheme.themeSource = contentTheme;

const THEME_COLORS = {
  dark: "#1e1e1e",
  light: "#f3f5f9",
};

const OPENCLAW_TAB = "OpenClaw";

const tabs = {
  "ChatGPT":    "https://chat.openai.com/",
  "Claude":     "https://claude.ai/",
  "Gemini":     "https://gemini.google.com/",
  "DeepSeek":   "https://chat.deepseek.com/",
  "Qwen":       "https://chat.qwen.ai/",
  "Perplexity": "https://www.perplexity.ai/",
  "Mistral":    "https://chat.mistral.ai/",
  "Kimi":       "https://www.kimi.com/",
  "Grok":       "https://grok.com/",
  "OpenClaw":   DEFAULT_OPENCLAW_URL,
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

async function closeHubConnections() {
  await Promise.all(getAllSessions().map((targetSession) => targetSession.closeAllConnections().catch(() => {})));
}

async function applyHubProxy(config) {
  proxyConfig = config;
  await applyProxyToAll(config);
  await closeHubConnections();
}

async function clearHubProxy() {
  proxyConfig = null;
  await applyProxyToAll({ proxyRules: "" });
  await closeHubConnections();
}

const wireguard = createWireguard({
  getUserDataPath: () => app.getPath("userData"),
  getDialogParent: () => (win && !win.isDestroyed() ? win : null),
  lookupPartition: "persist:ChatGPT",
  applyProxy: applyHubProxy,
  clearProxy: clearHubProxy,
  broadcast: (status) => {
    if (win && !win.isDestroyed()) win.webContents.send("wg-status", status);
  },
});

const tasks = createTasks({
  getUserDataPath: () => app.getPath("userData"),
  isKnownService: (name) => Object.prototype.hasOwnProperty.call(tabs, name),
  isServiceUrl: (name, url) => isServiceUrlForTab(name, url),
  listServices: () => Object.keys(tabs),
  broadcast: (status) => {
    if (win && !win.isDestroyed()) win.webContents.send("tasks-status", status);
  },
});

function rememberTabUrl(name, url) {
  if (!name || !url || url === "about:blank") return;
  if (shouldOpenInSystemBrowser(name, url)) return;
  if (isAuthPopupUrl(url) && !isServiceUrlForTab(name, url)) return;
  tabState[name] = { url };
  void tasks.noteUrl(name, url);
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
    backgroundColor: themeColor(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
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
    void bootTasksWorkspace();
  });
  win.loadFile("index.html");

  win.on("resize", () => {
    if (isBoardWorkspace()) return;
    if (activeTab && isViewUsable(views[activeTab])) resizeView(views[activeTab]);
  });
  win.on("close", (event) => {
    if (forceExit.started) return;
    event.preventDefault();
    forceExit();
  });
}

function isViewUsable(view) {
  return !!(view && view.webContents && !view.webContents.isDestroyed());
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

function syncGuestColorScheme(webContents) {
  if (!webContents || webContents.isDestroyed() || isHubWebContents(webContents)) return;
  try {
    const result = webContents.executeJavaScript(guestThemeScript());
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {}
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

  for (const view of Object.values(views)) {
    if (!isViewUsable(view)) continue;
    paintViewTheme(view);
    syncGuestColorScheme(view.webContents);
  }

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window || window.isDestroyed() || window === win) continue;
    try {
      const url = window.webContents.getURL() || "";
      if (url.startsWith("devtools://")) continue;
    } catch {}
    try { window.setBackgroundColor(color); } catch {}
    syncGuestColorScheme(window.webContents);
  }
}

nativeTheme.on("updated", () => {
  if (contentTheme !== "system") return;
  applyContentTheme("system");
});

function attachGuestTheme(webContents) {
  if (!webContents) return;
  webContents.on("did-finish-load", () => syncGuestColorScheme(webContents));
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

function openInSystemBrowser(url) {
  const now = Date.now();
  if (!openInSystemBrowser.recent) openInSystemBrowser.recent = new Map();
  const recent = openInSystemBrowser.recent;
  const previous = recent.get(url);
  if (previous && now - previous < 750) return;
  recent.set(url, now);

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

    try {
      win.removeBrowserView(view);
    } catch {}

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
    win.removeBrowserView(view);
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

  attachExternalLinkGuard(popup.webContents, tabName);
  popup.loadURL(url);
}

function createTab(name, url = getTabUrl(name), options = {}) {
  const view = new BrowserView({
    webPreferences: buildViewPreferences(name)
  });
  views[name] = view;
  paintViewTheme(view);
  attachGuestTheme(view.webContents);
  // Board mode keeps the view in `views` but must not put it back on the window.
  // setBrowserView here used to run before the detach, so a throw from loadURL
  // left the page covering the board.
  const showNow = !isBoardWorkspace() && !options.background;
  if (showNow) {
    win.setBrowserView(view);
    resizeView(view);
  }

  view.webContents.once("destroyed", () => {
    if (views[name] === view) delete views[name];
    if (activeTab === name) activeTab = null;
  });

  if (proxyConfig) {
    session.fromPartition(`persist:${name}`).setProxy(proxyConfig);
  }

  attachReloadShortcuts(view.webContents);
  attachBoardShortcut(view.webContents);
  ignoreUnloadBlock(view.webContents);
  let titleNotedAt = 0;
  view.webContents.on("page-title-updated", () => {
    if (!shouldNoteTaskActivity(name)) return;
    const now = Date.now();
    if (now - titleNotedAt < 8000) return;
    titleNotedAt = now;
    void tasks.noteActivity(name);
  });

  // Cross-document main-frame loads only. Subframe and same-document
  // navigations must not start the spinner. did-finish-load ends it when the
  // main document is ready; did-stop-loading is only a backup.
  let mainFrameLoading = false;

  view.webContents.on("did-start-navigation", (details, _url, isInPlace, isMainFrameArg) => {
    const isMainFrame = typeof details?.isMainFrame === "boolean" ? details.isMainFrame : isMainFrameArg;
    const isSameDocument = typeof details?.isSameDocument === "boolean" ? details.isSameDocument : Boolean(isInPlace);
    if (!isMainFrame || isSameDocument) return;
    mainFrameLoading = true;
    win.webContents.send("tab-progress", name, "start");
  });
  view.webContents.on("did-navigate", (_event, navigatedUrl) => {
    rememberTabUrl(name, navigatedUrl);
  });
  view.webContents.on("did-navigate-in-page", (_event, navigatedUrl) => {
    rememberTabUrl(name, navigatedUrl);
  });
  view.webContents.on("did-finish-load", () => {
    if (!mainFrameLoading) return;
    mainFrameLoading = false;
    win.webContents.send("tab-progress", name, "finish");
  });
  view.webContents.on("did-stop-loading", () => {
    if (!mainFrameLoading) return;
    mainFrameLoading = false;
    win.webContents.send("tab-progress", name, "finish");
  });
  view.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    // -3 = ERR_ABORTED (redirect, superseded navigation, or user cancel) — ignore.
    // Subframe failures must not finish or restart the tab indicator.
    if (!isMainFrame || errorCode === -3) return;
    mainFrameLoading = false;
    win.webContents.send("tab-progress", name, "fail");
    if (name === OPENCLAW_TAB) {
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
  view.webContents.loadURL(url);
}

function detachView(name) {
  const view = views[name];
  if (!win || win.isDestroyed() || !isViewUsable(view)) return;
  try { win.removeBrowserView(view); } catch {}
}

function hideOpenClawView() {
  detachView(OPENCLAW_TAB);
}

function ensureOpenClawView(targetUrl, forceLoad) {
  if (!win || win.isDestroyed()) return;
  const url = targetUrl || tabs[OPENCLAW_TAB];
  if (!isViewUsable(views[OPENCLAW_TAB])) {
    createTab(OPENCLAW_TAB, url);
    return;
  }

  const view = views[OPENCLAW_TAB];
  activeTab = OPENCLAW_TAB;
  if (!isBoardWorkspace()) {
    win.setBrowserView(view);
    resizeView(view);
  }

  let current = "";
  try { current = view.webContents.getURL(); } catch {}
  let needsLoad = Boolean(forceLoad) || !current || current === "about:blank" || current.startsWith("chrome-error://");
  if (!needsLoad && !forceLoad) {
    try {
      needsLoad = new URL(current).origin !== new URL(url).origin;
    } catch {
      needsLoad = true;
    }
  }
  if (needsLoad) view.webContents.loadURL(url);
}

function applyOpenClawSnapshot(status) {
  openclawSnapshot = status;
  if (!win || win.isDestroyed() || activeTab !== OPENCLAW_TAB) return status;
  if (isBoardWorkspace()) {
    hideOpenClawView();
    return status;
  }
  if (status && status.gatewayUp) ensureOpenClawView(status.url, false);
  else hideOpenClawView();
  return status;
}

function switchTab(name) {
  if (!tabs[name]) return;
  const board = isBoardWorkspace();
  if (name === OPENCLAW_TAB) {
    activeTab = name;
    if (board) hideOpenClawView();
    else if (openclawSnapshot && openclawSnapshot.gatewayUp) ensureOpenClawView(openclawSnapshot.url, false);
    else hideOpenClawView();
    win.webContents.send("tab-active", name);
    return;
  }

  if (!isViewUsable(views[name])) {
    delete views[name];
    createTab(name);
  } else if (board) {
    activeTab = name;
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
    return win.getBrowserView() === view;
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
  win.setBrowserView(views[activeTab]);
  resizeView(views[activeTab]);
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
    win.setBrowserView(view);
    resizeView(view);
    activeTab = service;
    if (saved) {
      let current = "";
      try { current = view.webContents.getURL(); } catch {}
      if (saved !== current) view.webContents.loadURL(saved);
    }
  }
  if (win && !win.isDestroyed()) win.webContents.send("tab-active", service);
}

function bootTasksWorkspace() {
  if (!win || win.isDestroyed()) return;
  applyWorkspaceView(tasks.list());
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
    const payload = {
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
  if (proxyConfig) targetSession.setProxy(proxyConfig).catch(() => {});
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
    const target = session.fromPartition(`persist:${name}`);
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

ipcMain.on("set-content-theme", (_event, theme) => {
  applyContentTheme(theme);
});

ipcMain.on("set-topbar-height", (_event, h) => {
  const next = Number(h);
  if (!Number.isFinite(next) || next < 0 || next > 4000) return;
  topBarHeight = next;
  if (isBoardWorkspace()) return;
  if (activeTab && isViewUsable(views[activeTab])) resizeView(views[activeTab]);
});

ipcMain.handle("set-proxy", async (_event, config) => {
  await wireguard.stopForExternalProxy();
  await applyHubProxy(config);
  return { success: true };
});

ipcMain.handle("clear-proxy", async () => {
  await wireguard.stopForExternalProxy();
  await clearHubProxy();
  return { success: true };
});

ipcMain.handle("wg-list", () => wireguard.list());

ipcMain.handle("wg-import", () => wireguard.importConfigs());

ipcMain.handle("wg-remove", async (_event, id) => {
  try {
    return await wireguard.remove(id);
  } catch (err) {
    return { success: false, error: err.message, status: wireguard.status() };
  }
});

ipcMain.handle("wg-connect", async (_event, id) => {
  try {
    const status = await wireguard.connect(id);
    return { success: true, status };
  } catch (err) {
    return { success: false, error: err.message, status: wireguard.status() };
  }
});

ipcMain.handle("wg-disconnect", async () => {
  try {
    return await wireguard.disconnect();
  } catch (err) {
    return { success: false, error: err.message, status: wireguard.status() };
  }
});

ipcMain.handle("openclaw-status", async () => {
  const status = await inspectOpenClaw();
  return applyOpenClawSnapshot(status);
});

ipcMain.handle("openclaw-start", async () => {
  const result = await startOpenClawGateway();
  applyOpenClawSnapshot(result.status);
  return {
    success: Boolean(result.status && result.status.gatewayUp),
    error: result.error || null,
    log: result.log || "",
    status: result.status,
  };
});

ipcMain.handle("openclaw-dashboard", async () => {
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

ipcMain.handle("tasks-list", () => {
  try {
    return tasks.list();
  } catch (err) {
    return taskIpcError(err);
  }
});

ipcMain.handle("tasks-create", async (_event, payload) => {
  try { return await tasks.create(payload); } catch (err) { return taskIpcError(err); }
});

ipcMain.handle("tasks-update", async (_event, payload) => {
  try { return await tasks.update(payload); } catch (err) { return taskIpcError(err); }
});

ipcMain.handle("tasks-delete", async (_event, id) => {
  try { return await tasks.delete(id); } catch (err) { return taskIpcError(err); }
});

ipcMain.handle("tasks-set-status", async (_event, payload) => {
  try { return await tasks.setStatus(payload); } catch (err) { return taskIpcError(err); }
});

ipcMain.handle("tasks-add-assignment", async (_event, payload) => {
  try { return await tasks.addAssignment(payload); } catch (err) { return taskIpcError(err); }
});

ipcMain.handle("tasks-remove-assignment", async (_event, payload) => {
  try { return await tasks.removeAssignment(payload); } catch (err) { return taskIpcError(err); }
});

ipcMain.handle("tasks-open", async (_event, payload) => {
  try {
    const result = await tasks.open(payload);
    if (result && result.success) showTaskService(result.status);
    return result;
  } catch (err) {
    return taskIpcError(err);
  }
});

ipcMain.handle("tasks-set-workspace", async (_event, workspace) => {
  try {
    return await commitWorkspace(workspace);
  } catch (err) {
    return taskIpcError(err);
  }
});

ipcMain.handle("tasks-toggle-workspace", async () => {
  try {
    return await toggleWorkspace();
  } catch (err) {
    return taskIpcError(err);
  }
});

ipcMain.handle("tasks-clear-capture", async () => {
  try { return await tasks.clearCapture(); } catch (err) { return taskIpcError(err); }
});

ipcMain.handle("google-status", () => googleSnapshot());

ipcMain.handle("google-sign-in", async () => {
  openGoogleChooser(GOOGLE_PARTITION);
  return googleSnapshot();
});

ipcMain.handle("google-apply-all", () => applySharedGoogle());

ipcMain.handle("google-use-shared", async (_event, service) => {
  if (!tabs[service] || service === OPENCLAW_TAB) return googleSnapshot();
  const book = readGoogleBook();
  delete book.overrides[service];
  writeGoogleBook(book);
  const source = googleSession();
  const cookies = await source.cookies.get({});
  if (hasGoogleSession(cookies)) {
    const target = session.fromPartition(`persist:${service}`);
    await clearGoogleCookies(target);
    await copyGoogleCookies(source, target);
    openServiceForGoogle(service);
  }
  return publishGoogle();
});

ipcMain.handle("google-use-other", async (_event, service) => {
  if (!tabs[service] || service === OPENCLAW_TAB) return googleSnapshot();
  const book = readGoogleBook();
  book.overrides[service] = true;
  writeGoogleBook(book);
  const target = session.fromPartition(`persist:${service}`);
  await clearGoogleCookies(target);
  openGoogleChooser(`persist:${service}`);
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

  const iconPath = path.join(__dirname, "assets", "icon.png");
  if (process.platform === "darwin" && fs.existsSync(iconPath) && app.dock) {
    app.dock.setIcon(iconPath);
  }

  await loadPersistedExtensions();
  try {
    await wireguard.restore();
  } catch {}
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
    syncGuestColorScheme(window.webContents);
  };
  window.webContents.on("did-finish-load", apply);
});

function ignoreUnloadBlock(webContents) {
  if (!webContents) return;
  webContents.on("will-prevent-unload", (event) => {
    event.preventDefault();
  });
}

function forceExit() {
  if (forceExit.started) return;
  forceExit.started = true;
  try {
    try { wireguard.kill(); } catch {}
    for (const popup of popupWindows) {
      try { popup.destroy(); } catch {}
    }
    popupWindows.clear();
    for (const view of Object.values(views)) {
      try {
        if (win && !win.isDestroyed()) win.removeBrowserView(view);
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
  if (forceExit.started) return;
  event.preventDefault();
  forceExit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
