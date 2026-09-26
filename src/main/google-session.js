// @ts-check
const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, session } = require("electron");
const { handle } = require("./ipc-bind");
const {
  GOOGLE_PARTITION,
  ACCOUNT_URL,
  isGoogleHost,
  hasGoogleSession,
  findEmail,
  loginUrlFor,
  CLICK_GOOGLE_SCRIPT,
} = require("./google");

function createGoogleSession(options = {}) {
  const getWin = options.window || (() => null);
  const getViews = options.views || (() => ({}));
  const getActiveTab = options.activeTab || (() => null);
  const getTabs = options.tabs || (() => ({}));
  const services = options.services;
  const createTab = options.createTab;
  const isViewUsable = options.isViewUsable || (() => false);
  const proxy = options.proxy;
  const applyWebRTCPolicy = options.applyWebRTCPolicy || (() => {});
  const applyWebRTCPolicyToContents = options.applyWebRTCPolicyToContents || (() => {});
  const themeColor = options.themeColor || (() => "#1e1e1e");
  const OPENCLAW_TAB = options.openClawTab || "OpenClaw";

  const googleClicks = new Set();
  let googleWindow = null;

  function googleAccountsFile() {
    return path.join(app.getPath("userData"), "google-accounts.json");
  }

  function defaultSharedMap() {
    const shared = {};
    for (const account of services.accounts()) {
      if (account.serviceId === OPENCLAW_TAB || account.accountId !== "default") continue;
      if (!shared[account.serviceId]) shared[account.serviceId] = [];
      shared[account.serviceId].push(account.accountId);
    }
    return shared;
  }

  function cleanSharedMap(value) {
    const shared = {};
    if (!value || typeof value !== "object") return shared;
    for (const [serviceId, list] of Object.entries(value)) {
      if (typeof serviceId !== "string" || serviceId === OPENCLAW_TAB || !Array.isArray(list)) continue;
      const ids = list.filter((id) => typeof id === "string" && id.length > 0 && id.length < 80);
      if (ids.length) shared[serviceId] = [...new Set(ids)];
    }
    return shared;
  }

  function readGoogleBook() {
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(googleAccountsFile(), "utf8")); } catch { raw = null; }
    const email = raw && typeof raw.email === "string" ? raw.email.slice(0, 120) : "";
    if (!raw) return { email: "", shared: defaultSharedMap(), isolated: false, exists: false };
    if (raw.shared && typeof raw.shared === "object") {
      return { email, shared: cleanSharedMap(raw.shared), isolated: raw.isolated === true, exists: true };
    }
    const overrides = raw.overrides && typeof raw.overrides === "object" ? raw.overrides : {};
    const shared = {};
    for (const account of services.accounts()) {
      if (account.serviceId === OPENCLAW_TAB || account.accountId !== "default") continue;
      if (overrides[account.serviceId]) continue;
      if (!shared[account.serviceId]) shared[account.serviceId] = [];
      shared[account.serviceId].push(account.accountId);
    }
    return { email, shared, isolated: false, exists: true };
  }

  function writeGoogleBook(book) {
    const dest = googleAccountsFile();
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const body = {
      email: typeof book.email === "string" ? book.email.slice(0, 120) : "",
      shared: cleanSharedMap(book.shared),
      isolated: book.isolated === true,
    };
    fs.writeFileSync(dest, JSON.stringify(body, null, 2), { mode: 0o600 });
  }

  function profileIsShared(book, serviceId, accountId) {
    const members = book.shared && book.shared[serviceId];
    return Array.isArray(members) && members.includes(accountId);
  }

  function googleProfiles(book) {
    const profiles = [];
    for (const service of services.list().services) {
      if (service.id === OPENCLAW_TAB) continue;
      for (const account of service.accounts) {
        profiles.push({
          serviceId: service.id,
          accountId: account.id,
          serviceName: service.name,
          label: account.label,
          shared: profileIsShared(book, service.id, account.id),
        });
      }
    }
    return profiles;
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
      profiles: googleProfiles(book),
    };
  }

  function sendGoogle(status) {
    if (getWin() && !getWin().isDestroyed()) getWin().webContents.send("google-status", status);
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

  function openServiceForGoogle(name, options = {}) {
    const url = options.home ? (getTabs()[name] || loginUrlFor(name)) : (loginUrlFor(name) || getTabs()[name]);
    const background = Boolean(getActiveTab() && getActiveTab() !== name);
    const googleClick = !options.home && name !== "Gemini";
    if (!isViewUsable(getViews()[name])) {
      createTab(name, url, { background, googleClick });
      return;
    }
    const view = getViews()[name];
    if (googleClick) armGoogleClick(view, name);
    let current = "";
    try { current = view.webContents.getURL(); } catch {}
    if (current !== url) view.webContents.loadURL(url);
    else if (googleClick) view.webContents.executeJavaScript(CLICK_GOOGLE_SCRIPT, true).catch(() => {});
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
    if (proxy.current()) {
      applyWebRTCPolicy(targetSession, "tunnel");
      targetSession.setProxy(proxy.current()).catch(() => {});
    }
    if (googleWindow && !googleWindow.isDestroyed()) {
      googleWindow.close();
    }
    const popup = new BrowserWindow({
      width: 520,
      height: 760,
      parent: getWin(),
      autoHideMenuBar: true,
      title: "Google",
      backgroundColor: themeColor(),
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    googleWindow = popup;
    const googlePopup = /** @type {any} */ (popup);
    googlePopup.sharedGoogle = partition === GOOGLE_PARTITION;
    if (proxy.current()) applyWebRTCPolicyToContents(popup.webContents, "tunnel");
    const note = () => {
      const follow = googlePopup.sharedGoogle ? rememberGoogleEmail(popup.webContents) : Promise.resolve();
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
    for (const profile of googleProfiles(book)) {
      if (!profile.shared) continue;
      const partition = services.partitionFor(profile.serviceId, profile.accountId);
      if (!partition) continue;
      const target = session.fromPartition(partition);
      await clearGoogleCookies(target);
      await copyGoogleCookies(source, target);
      if (services.activeAccountId(profile.serviceId) === profile.accountId) openServiceForGoogle(profile.serviceId, { home: true });
    }
    return publishGoogle();
  }

  async function isolateUnsharedProfiles() {
    const book = readGoogleBook();
    if (book.isolated) return;
    if (book.exists) {
      for (const account of services.accounts()) {
        if (account.serviceId === OPENCLAW_TAB) continue;
        if (profileIsShared(book, account.serviceId, account.accountId)) continue;
        await clearGoogleCookies(session.fromPartition(account.partition));
      }
    }
    writeGoogleBook({ email: book.email, shared: book.shared, isolated: true });
  }

  function googleMembershipTarget(payload) {
    const serviceId = typeof payload === "string" ? payload : payload && (payload.serviceId || payload.id);
    const accountId = typeof payload === "string" ? "default" : (payload && payload.accountId) || "default";
    if (!serviceId || serviceId === OPENCLAW_TAB || !services.known(serviceId)) return null;
    if (!services.partitionFor(serviceId, accountId)) return null;
    return { serviceId, accountId };
  }

  function siteHosts(pageUrl) {
    let host = "";
    try { host = new URL(pageUrl).hostname.toLowerCase(); } catch { return []; }
    const extra = host === "chat.openai.com" || host === "chatgpt.com" ? ["chatgpt.com", "chat.openai.com", "openai.com"] : [];
    return [...new Set([host, ...extra])];
  }

  async function profileSawSite(serviceId, accountId) {
    const hosts = siteHosts(services.url(serviceId));
    const partition = services.partitionFor(serviceId, accountId);
    if (!hosts.length || !partition) return false;
    let cookies = [];
    try { cookies = await session.fromPartition(partition).cookies.get({}); } catch { return false; }
    return cookies.some((cookie) => {
      if (!cookie || !cookie.value) return false;
      const domain = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
      if (!domain.includes(".")) return false;
      return hosts.some((host) => host === domain || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`));
    });
  }

  handle("google-status", () => googleSnapshot());

  handle("google-sign-in", async () => {
    openGoogleChooser(GOOGLE_PARTITION);
    return googleSnapshot();
  });

  handle("google-apply-all", () => applySharedGoogle());

  handle("google-use-shared", async (_event, payload) => {
    const target = googleMembershipTarget(payload);
    if (!target) return googleSnapshot();
    const book = readGoogleBook();
    const members = new Set(book.shared[target.serviceId] || []);
    members.add(target.accountId);
    book.shared[target.serviceId] = [...members];
    book.isolated = true;
    writeGoogleBook(book);
    const source = googleSession();
    const cookies = await source.cookies.get({});
    if (hasGoogleSession(cookies)) {
      const partition = services.partitionFor(target.serviceId, target.accountId);
      const sessionTarget = session.fromPartition(partition);
      await clearGoogleCookies(sessionTarget);
      await copyGoogleCookies(source, sessionTarget);
      if (services.activeAccountId(target.serviceId) === target.accountId) openServiceForGoogle(target.serviceId, { home: true });
    }
    return publishGoogle();
  });

  handle("google-use-other", async (_event, payload) => {
    const target = googleMembershipTarget(payload);
    if (!target) return googleSnapshot();
    const book = readGoogleBook();
    book.shared[target.serviceId] = (book.shared[target.serviceId] || []).filter((id) => id !== target.accountId);
    book.isolated = true;
    writeGoogleBook(book);
    const partition = services.partitionFor(target.serviceId, target.accountId);
    await clearGoogleCookies(session.fromPartition(partition));
    openGoogleChooser(partition);
    return publishGoogle();
  });

  function closeWindow() {
    try {
      if (googleWindow && !googleWindow.isDestroyed()) googleWindow.destroy();
    } catch {}
    googleWindow = null;
  }

  return {
    armGoogleClick,
    isolateUnsharedProfiles,
    profileSawSite,
    closeWindow,
  };
}

module.exports = { createGoogleSession };
