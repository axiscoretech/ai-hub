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
  CLICK_GOOGLE_SCRIPT,
  pageKey,
  signInNavigation,
  googleClickAction,
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

  const googleClickJobs = new Map();
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

  function contentsAlive(view) {
    try {
      return Boolean(view && view.webContents && !view.webContents.isDestroyed());
    } catch {
      return false;
    }
  }

  function stopGoogleClick(name) {
    const job = googleClickJobs.get(name);
    if (!job) return;
    clearTimeout(job.timer);
    try {
      if (contentsAlive(job.view)) job.view.webContents.removeListener("did-finish-load", job.onLoad);
    } catch {}
    googleClickJobs.delete(name);
  }

  function armGoogleClick(view, name, options = {}) {
    if (!view || !view.webContents || !name) return;
    stopGoogleClick(name);
    const waitForLoad = options.waitForLoad !== false;
    const started = Date.now();
    let clickFrom = 0;
    let originUrl = "";
    try { originUrl = view.webContents.getURL() || ""; } catch {}
    /** @type {{ view: any, timer: ReturnType<typeof setTimeout> | undefined, onLoad: () => void, again: boolean }} */
    const job = { view, timer: undefined, onLoad: () => {}, again: false };
    let running = false;
    const schedule = (delay) => {
      if (!googleClickJobs.has(name)) return;
      clearTimeout(job.timer);
      job.timer = setTimeout(attempt, delay);
    };
    const attempt = () => {
      if (!googleClickJobs.has(name)) return;
      clearTimeout(job.timer);
      job.timer = undefined;
      if (running) {
        job.again = true;
        return;
      }
      if (!contentsAlive(view)) {
        stopGoogleClick(name);
        return;
      }
      let current = "";
      try { current = view.webContents.getURL() || ""; } catch { return; }
      const action = googleClickAction(current, name);
      const stillOnOrigin = waitForLoad && pageKey(current) === pageKey(originUrl);
      const onLogin = action === "click" && !stillOnOrigin;
      if (onLogin && !clickFrom) clickFrom = Date.now();
      const clickTimedOut = Boolean(clickFrom) && action !== "wait" && Date.now() - clickFrom > 12000;
      if (Date.now() - started > 30000 || clickTimedOut || (action === "stop" && !stillOnOrigin)) {
        stopGoogleClick(name);
        return;
      }
      if (!onLogin) {
        schedule(400);
        return;
      }
      running = true;
      // userGesture has to be set on each attempt. A click from a page timer
      // is not a user gesture, so the site's Google popup would be blocked.
      view.webContents.executeJavaScript(CLICK_GOOGLE_SCRIPT, true).then((clicked) => {
        running = false;
        if (!googleClickJobs.has(name)) return;
        if (clicked) {
          stopGoogleClick(name);
          return;
        }
        if (job.again) {
          job.again = false;
          attempt();
          return;
        }
        schedule(400);
      }).catch(() => {
        running = false;
        if (!googleClickJobs.has(name) || !contentsAlive(view)) {
          stopGoogleClick(name);
          return;
        }
        schedule(400);
      });
    };
    job.onLoad = () => attempt();
    googleClickJobs.set(name, job);
    try { view.webContents.on("did-finish-load", job.onLoad); } catch {}
    if (!waitForLoad) attempt();
  }

  function openServiceForGoogle(name) {
    const tabUrl = getTabs()[name] || "";
    const existing = getViews()[name];
    let current = "";
    if (isViewUsable(existing)) {
      try { current = existing.webContents.getURL() || ""; } catch {}
    }
    const plan = signInNavigation(name, current, tabUrl);
    if (!plan.url) return;
    const background = Boolean(getActiveTab() && getActiveTab() !== name);
    if (!isViewUsable(existing)) {
      createTab(name, plan.url, { background, googleClick: plan.googleClick });
      return;
    }
    if (plan.googleClick) armGoogleClick(existing, name, { waitForLoad: plan.load });
    if (plan.load) existing.webContents.loadURL(plan.url);
    else if (plan.reload) {
      if (typeof existing.webContents.reloadIgnoringCache === "function") existing.webContents.reloadIgnoringCache();
      else existing.webContents.reload();
    }
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
    popup.show();
    popup.focus();
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
      // Copied Google cookies do not create the chat's own session. Open the
      // sign-in page and continue with Google; Gemini itself reads the cookies.
      if (services.activeAccountId(profile.serviceId) === profile.accountId) openServiceForGoogle(profile.serviceId);
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
      if (services.activeAccountId(target.serviceId) === target.accountId) openServiceForGoogle(target.serviceId);
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
