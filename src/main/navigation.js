// Host, OAuth, and popup rules for service tabs.
// A link stays in the app when it is the service itself or an identity provider.
// Everything else opens in the system browser.

const OPENCLAW_TAB = "OpenClaw";
const CHATGPT_HOSTS = new Set(["chat.openai.com", "chatgpt.com", "www.chatgpt.com"]);
const QWEN_HOSTS = ["qwen.ai", "qwenlm.ai", "qwenlm.io", "qwenchat.com"];

function createNavigation(options = {}) {
  const tabUrl = options.tabUrl || (() => undefined);
  const isOpenClawControlUrl = options.isOpenClawControlUrl || (() => false);
  const openExternal = options.openExternal || (() => {});
  const externalOpenRecent = new Map();

  function getTabOrigin(name) {
    try {
      return new URL(tabUrl(name)).origin;
    } catch {
      return null;
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

  function inAppHostsForTab(tabName) {
    const hosts = [];
    try {
      hosts.push(new URL(tabUrl(tabName)).hostname);
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
      serviceDomain = registrableDomain(new URL(tabUrl(tabName)).hostname);
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
    const previous = externalOpenRecent.get(url);
    if (previous && now - previous < 750) return;
    externalOpenRecent.set(url, now);

    try {
      const pending = openExternal(url);
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

  return {
    isServiceUrlForTab,
    shouldOpenInSystemBrowser,
    isAuthPopupUrl,
    isOpenerPopupUrl,
    openInSystemBrowser,
    attachExternalLinkGuard,
    hostnameMatches,
    registrableDomain,
  };
}

module.exports = { createNavigation };
