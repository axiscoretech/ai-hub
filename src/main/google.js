const GOOGLE_PARTITION = "persist:aihub-google";
const ACCOUNT_URL = "https://accounts.google.com/AccountChooser?continue=https://myaccount.google.com/&flowName=GlifWebSignIn";
const SESSION_COOKIE = /^(?:SID|HSID|SSID|APISID|SAPISID|LSID|__Secure-1PSID|__Secure-3PSID|__Secure-1PAPISID|__Secure-3PAPISID)$/i;

const LOGIN_URLS = {
  ChatGPT: "https://chatgpt.com/auth/login",
  Claude: "https://claude.ai/login",
  Gemini: "https://gemini.google.com/",
  DeepSeek: "https://chat.deepseek.com/sign_in",
  Qwen: "https://chat.qwen.ai/",
  Perplexity: "https://www.perplexity.ai/",
  Mistral: "https://chat.mistral.ai/",
  Kimi: "https://www.kimi.com/",
  Grok: "https://grok.com/",
};

function isGoogleHost(domain) {
  const host = String(domain || "").replace(/^\./, "").toLowerCase();
  if (!host) return false;
  return host === "google.com" || host.endsWith(".google.com")
    || host === "youtube.com" || host.endsWith(".youtube.com")
    || host === "googleusercontent.com" || host.endsWith(".googleusercontent.com")
    || host === "gstatic.com" || host.endsWith(".gstatic.com");
}

function hasGoogleSession(cookies) {
  return (cookies || []).some((cookie) =>
    cookie
    && cookie.value
    && isGoogleHost(cookie.domain)
    && SESSION_COOKIE.test(cookie.name || "")
  );
}

function findEmail(text) {
  const match = String(text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].slice(0, 120) : "";
}

function loginUrlFor(service) {
  return LOGIN_URLS[service] || "";
}

function targetsForApply(services, overrides) {
  const skipped = overrides && typeof overrides === "object" ? overrides : {};
  return (services || []).filter((name) => name && name !== "OpenClaw" && !skipped[name]);
}

function sharedProfiles(profiles, book) {
  const rows = Array.isArray(profiles) ? profiles : [];
  const shared = book && book.shared && typeof book.shared === "object" ? book.shared : null;
  const overrides = book && book.overrides && typeof book.overrides === "object" ? book.overrides : null;
  return rows.filter((profile) => {
    if (!profile || !profile.serviceId || profile.serviceId === "OpenClaw") return false;
    if (shared) {
      const members = shared[profile.serviceId];
      return Array.isArray(members) && members.includes(profile.accountId);
    }
    if (overrides && overrides[profile.serviceId]) return false;
    return !profile.accountId || profile.accountId === "default";
  });
}

function pageKey(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.origin}${path === "/" ? "/" : path}`;
  } catch {
    return "";
  }
}

function signInNavigation(service, currentUrl, tabUrl) {
  const none = { url: "", googleClick: false, load: false, reload: false };
  if (!service || service === "OpenClaw") return none;
  const login = loginUrlFor(service);
  const url = login || tabUrl || "";
  if (!url) return none;
  const googleClick = service !== "Gemini";
  const same = pageKey(currentUrl) !== "" && pageKey(currentUrl) === pageKey(url);
  return {
    url,
    googleClick,
    load: !same,
    reload: same && !googleClick,
  };
}

function googleClickAction(url, service) {
  const current = String(url || "");
  if (!current || current === "about:blank" || current.startsWith("about:")) return "wait";
  let host = "";
  let path = "/";
  try {
    const parsed = new URL(current);
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname || "/";
  } catch {
    return "wait";
  }
  if (
    host === "accounts.google.com"
    || host.endsWith(".accounts.google.com")
    || host === "myaccount.google.com"
    || host === "accounts.youtube.com"
  ) return "wait";
  const login = loginUrlFor(service);
  if (login && pageKey(login) === pageKey(current)) return "click";
  if (/\/(?:auth|oauth|login|sign[-_]?in|signin)(?:\/|$)/i.test(path)) return "click";
  if (!login) return "click";
  return "stop";
}

const GOOGLE_SIGN_IN_NAME = String.raw`google`;
const GOOGLE_SIGN_IN_HINT = String.raw`continue|sign\s?-?in|log\s?-?in|login|with|войти|вход|使用|通过|через`;

function googleSignInLabel(text) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (!flat || flat.length > 80) return false;
  if (!new RegExp(GOOGLE_SIGN_IN_NAME, "i").test(flat)) return false;
  if (new RegExp(`^${GOOGLE_SIGN_IN_NAME}$`, "i").test(flat)) return true;
  return new RegExp(GOOGLE_SIGN_IN_HINT, "i").test(flat);
}

const CLICK_GOOGLE_SCRIPT = `(() => {
  if (window.__aihubGoogleClicked) return true;
  const nodes = document.querySelectorAll("button, a, [role='button'], [role='link']");
  for (const el of nodes) {
    if (!el || el.disabled || el.hidden || el.getAttribute("aria-disabled") === "true" || el.getAttribute("aria-hidden") === "true") continue;
    const text = ((el.innerText || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || "")).replace(/\\s+/g, " ").trim();
    if (!text || text.length > 80 || !/${GOOGLE_SIGN_IN_NAME}/i.test(text)) continue;
    if (!/^${GOOGLE_SIGN_IN_NAME}$/i.test(text) && !/${GOOGLE_SIGN_IN_HINT}/i.test(text)) continue;
    window.__aihubGoogleClicked = true;
    el.click();
    return true;
  }
  return false;
})()`;

module.exports = {
  GOOGLE_PARTITION,
  ACCOUNT_URL,
  isGoogleHost,
  hasGoogleSession,
  findEmail,
  loginUrlFor,
  targetsForApply,
  sharedProfiles,
  pageKey,
  signInNavigation,
  googleClickAction,
  googleSignInLabel,
  CLICK_GOOGLE_SCRIPT,
};
