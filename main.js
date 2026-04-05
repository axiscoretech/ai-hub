const { app, BrowserWindow, BrowserView, ipcMain, session, dialog, shell } = require("electron");
const path = require("path");

app.setName("AI Hub");
const fs = require("fs");
const https = require("https");
const http = require("http");
const os = require("os");
const { execFile } = require("child_process");

let win;
let views = {};
let activeTab = null;
let topBarHeight = 60;
let proxyConfig = null;

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

async function applyProxyToAll(config) {
  await Promise.all(getAllSessions().map(s => s.setProxy(config)));
}

// ── Extension registry ──────────────────────────────────────────────────────

function getRegistryFile() {
  return path.join(app.getPath("userData"), "extensions-registry.json");
}

function loadRegistry() {
  try { return JSON.parse(fs.readFileSync(getRegistryFile(), "utf8")); }
  catch { return []; }
}

function saveRegistry(paths) {
  fs.writeFileSync(getRegistryFile(), JSON.stringify(paths, null, 2));
}

async function loadPersistedExtensions() {
  for (const extPath of loadRegistry()) {
    if (!fs.existsSync(extPath)) continue;
    for (const s of getAllSessions()) {
      try { await s.loadExtension(extPath, { allowFileAccess: true }); }
      catch {} // already loaded or incompatible
    }
  }
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
  const url = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=49.0&acceptformat=crx3&x=id%3D${extensionId}%26uc`;
  const tmpCrx = path.join(os.tmpdir(), `aihub-${extensionId}.crx`);
  const tmpZip = path.join(os.tmpdir(), `aihub-${extensionId}.zip`);
  const extDir = path.join(app.getPath("userData"), "extensions", extensionId);

  await downloadFile(url, tmpCrx);

  const crxBuf = fs.readFileSync(tmpCrx);
  const zipBuf = extractZipFromCrx(crxBuf);
  fs.writeFileSync(tmpZip, zipBuf);

  fs.mkdirSync(extDir, { recursive: true });
  await new Promise((resolve, reject) => {
    execFile("unzip", ["-o", tmpZip, "-d", extDir], (err) => {
      err ? reject(err) : resolve();
    });
  });

  for (const s of getAllSessions()) {
    await s.loadExtension(extDir, { allowFileAccess: true });
  }

  const registry = loadRegistry();
  if (!registry.includes(extDir)) {
    registry.push(extDir);
    saveRegistry(registry);
  }

  try { fs.unlinkSync(tmpCrx); } catch {}
  try { fs.unlinkSync(tmpZip); } catch {}

  return { success: true, path: extDir };
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

  win.on("resize", () => {
    if (activeTab && views[activeTab]) resizeView(views[activeTab]);
  });
}

function createTab(name, url) {
  const view = new BrowserView({
    webPreferences: {
      partition: `persist:${name}`,
      contextIsolation: true,
      nodeIntegration: false,
    }
  });
  views[name] = view;
  win.setBrowserView(view);
  resizeView(view);

  if (proxyConfig) {
    session.fromPartition(`persist:${name}`).setProxy(proxyConfig);
  }

  view.webContents.on("did-start-loading", () => {
    win.webContents.send("tab-progress", name, "start");
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
    view.webContents.loadURL(u);
    return { action: "deny" };
  });

  activeTab = name;
}

function switchTab(name) {
  if (!views[name]) {
    createTab(name, tabs[name]);
  } else {
    win.setBrowserView(views[name]);
    resizeView(views[name]);
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
  if (activeTab && views[activeTab]) resizeView(views[activeTab]);
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

ipcMain.handle("pick-extension", async () => {
  const result = await dialog.showOpenDialog(win, {
    title: "Select unpacked Chrome extension folder",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const extPath = result.filePaths[0];
  try {
    for (const s of getAllSessions()) {
      await s.loadExtension(extPath, { allowFileAccess: true });
    }
    const registry = loadRegistry();
    if (!registry.includes(extPath)) { registry.push(extPath); saveRegistry(registry); }
    return { success: true, path: extPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("install-extension", async (_event, extensionId) => {
  try {
    return await installExtensionById(extensionId);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.on("open-external", (_event, url) => shell.openExternal(url));

// ── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
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
