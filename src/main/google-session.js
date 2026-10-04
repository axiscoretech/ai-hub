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
  loginUrlFor,
  signInNavigation,
  googleCookieSet,
  oauthHref,
  chooseGoogleTarget,
  LIST_GOOGLE_TARGETS_SCRIPT,
  isGoogleAccountUrl,
  authLanded,
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

  async function googleCookies(fromSession) {
    const lists = await Promise.all([
      fromSession.cookies.get({}).catch(() => []),
      fromSession.cookies.get({ url: "https://accounts.google.com/" }).catch(() => []),
      fromSession.cookies.get({ url: "https://www.google.com/" }).catch(() => []),
      fromSession.cookies.get({ url: "https://mail.google.com/" }).catch(() => []),
    ]);
    const seen = new Set();
    const cookies = [];
    for (const list of lists) {
      for (const cookie of list || []) {
        const key = `${cookie.name}|${cookie.domain}|${cookie.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        cookies.push(cookie);
      }
    }
    return cookies;
  }

  async function copyGoogleCookies(fromSession, toSession) {
    const cookies = await googleCookies(fromSession);
    for (const cookie of cookies) {
      const payload = googleCookieSet(cookie);
      if (!payload) continue;
      try {
        await toSession.cookies.set(payload);
      } catch {
        if (!payload.domain) continue;
        const hostOnly = { ...payload };
        delete hostOnly.domain;
        try { await toSession.cookies.set(hostOnly); } catch {}
      }
    }
    try { await toSession.cookies.flushStore(); } catch {}
  }

  function contentsAlive(view) {
    try {
      return Boolean(view && view.webContents && !view.webContents.isDestroyed());
    } catch {
      return false;
    }
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function stopGoogleClick(name) {
    const job = googleClickJobs.get(name);
    if (!job) return;
    job.cancel = true;
    googleClickJobs.delete(name);
  }

  function safeUrl(view) {
    try { return view.webContents.getURL() || ""; } catch { return ""; }
  }

  async function trustedClick(view, x, y) {
    const contents = view.webContents;
    const factor = typeof contents.getZoomFactor === "function" ? contents.getZoomFactor() : 1;
    const zoom = factor > 0 ? factor : 1;
    const point = { x: Math.round(x * zoom), y: Math.round(y * zoom) };
    try { if (getWin() && !getWin().isDestroyed()) getWin().focus(); } catch {}
    try { contents.focus(); } catch {}
    // element.click() is untrusted, and these sites ignore it. A real mouse
    // event is what starts Continue with Google, including inside an iframe.
    const send = (type, extra) => contents.sendInputEvent({ type, x: point.x, y: point.y, ...extra });
    send("mouseMove", { movementX: 0, movementY: 0 });
    send("mouseDown", { button: "left", clickCount: 1 });
    send("mouseUp", { button: "left", clickCount: 1 });
  }

  async function readTargets(view) {
    try {
      return await view.webContents.executeJavaScript(LIST_GOOGLE_TARGETS_SCRIPT, true);
    } catch {
      return null;
    }
  }

  function mainFrameLoading(view) {
    try {
      if (typeof view.webContents.isLoadingMainFrame === "function") return view.webContents.isLoadingMainFrame();
      return view.webContents.isLoading();
    } catch {
      return false;
    }
  }

  async function waitForNavigation(view, startLoad) {
    if (!contentsAlive(view)) return;
    await new Promise((resolve) => {
      let settled = false;
      let sawStart = false;
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { view.webContents.removeListener("did-start-navigation", onStart); } catch {}
        try { view.webContents.removeListener("did-finish-load", onFinish); } catch {}
        try { view.webContents.removeListener("did-fail-load", onFail); } catch {}
        resolve(undefined);
      };
      const onStart = (event, _url, isInPlace, isMainFrameArg) => {
        const main = event && typeof event.isMainFrame === "boolean" ? event.isMainFrame : isMainFrameArg;
        const same = event && typeof event.isSameDocument === "boolean" ? event.isSameDocument : isInPlace;
        if (main === false || same === true) return;
        sawStart = true;
      };
      const onFinish = () => { if (sawStart) finish(); };
      const onFail = () => { if (sawStart) finish(); };
      try {
        view.webContents.on("did-start-navigation", onStart);
        view.webContents.on("did-finish-load", onFinish);
        view.webContents.on("did-fail-load", onFail);
      } catch {
        finish();
        return;
      }
      try { startLoad(); } catch { finish(); return; }
      timer = setTimeout(finish, 15000);
    });
  }

  async function ensureLaidOut(view, name) {
    const present = options.presentService;
    const started = Date.now();
    while (Date.now() - started < 1500) {
      let bounds = null;
      try { bounds = view.getBounds(); } catch {}
      if (bounds && bounds.width >= 200 && bounds.height >= 200) {
        try {
          await view.webContents.executeJavaScript(
            "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))",
            true,
          );
        } catch {}
        return;
      }
      if (typeof present === "function") {
        try { await present(name); } catch {}
      }
      await wait(80);
    }
  }

  /**
   * @returns {Promise<"done" | "form" | "timeout" | "cancelled" | "gone">}
   */
  function armGoogleClick(view, name, clickOptions = {}) {
    if (!view || !view.webContents || !name) return Promise.resolve(/** @type {"gone"} */ ("gone"));
    stopGoogleClick(name);
    const email = typeof clickOptions.email === "string" ? clickOptions.email : "";
    const origin = typeof clickOptions.origin === "string" ? clickOptions.origin : safeUrl(view);
    /** @type {{ cancel: boolean }} */
    const job = { cancel: false };
    googleClickJobs.set(name, job);
    const done = (async () => {
      const deadline = Date.now() + 32000;
      let clicks = 0;
      let idle = 0;
      let visitedGoogle = isGoogleAccountUrl(safeUrl(view));
      let openedDialog = false;
      while (Date.now() < deadline && clicks < 7) {
        if (job.cancel) return "cancelled";
        if (!contentsAlive(view)) return "gone";
        if (mainFrameLoading(view)) {
          await wait(200);
          continue;
        }
        await ensureLaidOut(view, name);
        if (job.cancel) return "cancelled";
        const url = safeUrl(view);
        if (isGoogleAccountUrl(url)) visitedGoogle = true;
        const scan = await readTargets(view);
        if (job.cancel) return "cancelled";
        const choice = chooseGoogleTarget(scan, email);
        const settled = authLanded(name, url) && !isGoogleAccountUrl(url);
        if (choice.action === "form") return "form";
        if (choice.action === "none") {
          idle += 1;
          const login = loginUrlFor(name);
          const onLogin = Boolean(login) && pageKey(login) === pageKey(url);
          // Home pages that are also the login URL still need time to draw
          // Sign in. A chat that left that URL, or came back from Google, is done.
          if (visitedGoogle && settled && idle >= 3) return "done";
          if (!onLogin && settled && idle >= 4) return "done";
          if (idle >= 24) return "timeout";
          await wait(400);
          continue;
        }
        idle = 0;
        if (choice.action === "open" && openedDialog) {
          await wait(400);
          continue;
        }
        const href = choice.action === "google" ? oauthHref(choice.href) : "";
        const before = url;
        clicks += 1;
        if (choice.action === "open") openedDialog = true;
        if (href) {
          const pending = view.webContents.loadURL(href);
          if (pending && typeof pending.catch === "function") pending.catch(() => {});
        } else {
          try { await trustedClick(view, choice.x, choice.y); } catch {}
        }
        const pause = Date.now() + (href ? 1200 : 1600);
        while (Date.now() < pause) {
          if (job.cancel) return "cancelled";
          if (!contentsAlive(view)) return "gone";
          if (safeUrl(view) !== before) break;
          await wait(200);
        }
      }
      if (!contentsAlive(view)) return "gone";
      return authLanded(name, safeUrl(view)) && (visitedGoogle || pageKey(safeUrl(view)) !== pageKey(origin)) ? "done" : "timeout";
    })().finally(() => {
      if (googleClickJobs.get(name) === job) googleClickJobs.delete(name);
    });
    return done;
  }

  async function openServiceForGoogle(name, email) {
    const shell = getWin();
    if (shell && !shell.isDestroyed()) shell.webContents.send("google-focus-page");
    const tabUrl = getTabs()[name] || "";
    let existing = getViews()[name];
    let current = "";
    if (isViewUsable(existing)) {
      try { current = existing.webContents.getURL() || ""; } catch {}
    }
    const plan = signInNavigation(name, current, tabUrl, email);
    if (!plan.url) return "done";
    if (typeof options.presentService === "function") {
      try { await options.presentService(name); } catch {}
      existing = getViews()[name];
    }
    const origin = current;
    if (!isViewUsable(existing)) {
      const background = Boolean(getActiveTab() && getActiveTab() !== name);
      createTab(name, plan.url, { background });
      existing = getViews()[name];
      if (!isViewUsable(existing)) return "gone";
      await ensureLaidOut(existing, name);
      return armGoogleClick(existing, name, { email, origin });
    }
    await ensureLaidOut(existing, name);
    if (plan.load) {
      try { await existing.webContents.loadURL(plan.url); } catch {}
    } else if (plan.reload) {
      await waitForNavigation(existing, () => {
        if (typeof existing.webContents.reloadIgnoringCache === "function") existing.webContents.reloadIgnoringCache();
        else existing.webContents.reload();
      });
    }
    const loadingDeadline = Date.now() + 8000;
    while (contentsAlive(existing) && mainFrameLoading(existing) && Date.now() < loadingDeadline) {
      await wait(200);
    }
    if (!contentsAlive(existing)) return "gone";
    return armGoogleClick(existing, name, { email, origin });
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
    const cookies = await googleCookies(source);
    if (!hasGoogleSession(cookies)) {
      openGoogleChooser(GOOGLE_PARTITION);
      return publishGoogle();
    }
    const book = readGoogleBook();
    const email = book.email || "";
    const shared = googleProfiles(book).filter((profile) => profile.shared);
    for (const profile of shared) {
      const partition = services.partitionFor(profile.serviceId, profile.accountId);
      if (!partition) continue;
      const target = session.fromPartition(partition);
      await clearGoogleCookies(target);
      await copyGoogleCookies(source, target);
    }
    const activeName = getActiveTab();
    const visible = shared.filter((profile) => (
      services.activeAccountId(profile.serviceId) === profile.accountId
      && !(typeof services.hidden === "function" && services.hidden(profile.serviceId))
    ));
    visible.sort((a, b) => Number(b.serviceId === activeName) - Number(a.serviceId === activeName));
    let needsUser = "";
    for (const profile of visible) {
      // The chat's own session is created only after Continue with Google.
      // Cookie copy alone leaves every service logged out.
      const result = await openServiceForGoogle(profile.serviceId, email);
      if (result === "form") needsUser = profile.serviceId;
    }
    if (typeof options.presentService === "function") {
      const back = needsUser || activeName;
      if (back) {
        try { await options.presentService(back); } catch {}
      }
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
    const cookies = await googleCookies(source);
    if (hasGoogleSession(cookies)) {
      const partition = services.partitionFor(target.serviceId, target.accountId);
      const sessionTarget = session.fromPartition(partition);
      await clearGoogleCookies(sessionTarget);
      await copyGoogleCookies(source, sessionTarget);
      if (services.activeAccountId(target.serviceId) === target.accountId) {
        await openServiceForGoogle(target.serviceId, book.email || "");
      }
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
