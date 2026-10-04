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

function geminiSignInUrl(email) {
  const params = new URLSearchParams({
    continue: "https://gemini.google.com/",
    flowName: "GlifWebSignIn",
  });
  const address = String(email || "").trim();
  if (address.includes("@") && address.length <= 120) params.set("Email", address);
  return `https://accounts.google.com/AccountChooser?${params.toString()}`;
}

function signInNavigation(service, currentUrl, tabUrl, email) {
  const none = { url: "", googleClick: false, load: false, reload: false };
  if (!service || service === "OpenClaw") return none;
  if (service === "Gemini") {
    return { url: geminiSignInUrl(email), googleClick: true, load: true, reload: false };
  }
  const login = loginUrlFor(service);
  const url = login || tabUrl || "";
  if (!url) return none;
  const same = pageKey(currentUrl) !== "" && pageKey(currentUrl) === pageKey(url);
  // Already sitting on the login page still has to reload. Otherwise a second
  // press leaves the logged-out page exactly as it was.
  return { url, googleClick: true, load: !same, reload: same };
}

function isGoogleAccountUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "accounts.google.com"
      || host.endsWith(".accounts.google.com")
      || host === "myaccount.google.com"
      || host === "accounts.youtube.com";
  } catch {
    return false;
  }
}

function authLanded(service, url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname || "/";
  if (isGoogleAccountUrl(url)) return false;
  if (service === "Gemini") return host === "gemini.google.com";
  if (/\/(?:auth|oauth|login|sign[-_]?in|signin)(?:\/|$)/i.test(path)) return false;
  return Boolean(service);
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

function googleCookieSet(cookie) {
  if (!cookie || !cookie.name || cookie.value == null || cookie.value === "") return null;
  if (!isGoogleHost(cookie.domain)) return null;
  const rawDomain = String(cookie.domain || "");
  const host = rawDomain.replace(/^\./, "").toLowerCase();
  if (!host || /[\s/]/.test(host)) return null;
  const path = typeof cookie.path === "string" && cookie.path.startsWith("/") ? cookie.path : "/";
  const hostPrefix = String(cookie.name).startsWith("__Host-");
  const hostOnly = hostPrefix || cookie.hostOnly === true || !rawDomain.startsWith(".");
  const secure = Boolean(cookie.secure)
    || hostPrefix
    || String(cookie.name).startsWith("__Secure-")
    || cookie.sameSite === "no_restriction";
  /** @type {Record<string, any>} */
  const payload = {
    url: `${secure ? "https" : "http"}://${host}${path}`,
    name: String(cookie.name),
    value: String(cookie.value),
    path,
    secure,
    httpOnly: Boolean(cookie.httpOnly),
  };
  if (!hostOnly) payload.domain = host;
  if (typeof cookie.expirationDate === "number" && Number.isFinite(cookie.expirationDate) && cookie.expirationDate > 0) {
    payload.expirationDate = cookie.expirationDate;
  }
  if (cookie.sameSite === "no_restriction" || cookie.sameSite === "lax" || cookie.sameSite === "strict") {
    payload.sameSite = cookie.sameSite;
  }
  return payload;
}

function oauthHref(href) {
  try {
    const parsed = new URL(href);
    if (parsed.protocol !== "https:") return "";
    const host = parsed.hostname.toLowerCase();
    if (
      host === "accounts.google.com"
      || host.endsWith(".accounts.google.com")
      || host === "oauth2.googleapis.com"
      || host === "accounts.youtube.com"
    ) return parsed.href;
    if (host.endsWith(".google.com") && /\/(?:o\/oauth2|signin|accountchooser|gsi)/i.test(parsed.pathname)) {
      return parsed.href;
    }
  } catch {}
  return "";
}

function isLoginOpener(text) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (!flat || flat.length > 24) return false;
  return /^(?:sign[\s-]?in|log[\s-]?in|login|войти|вход|登录|登入)$/i.test(flat);
}

function isConsentLabel(text) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (!flat || flat.length > 24) return false;
  return /^(?:continue|allow|accept|agree|next|yes|продолжить|далее|разрешить|принять|继续|允许|同意)$/i.test(flat);
}

function isGoogleControl(item) {
  if (!item || (item.w || 0) < 8 || (item.h || 0) < 8) return false;
  const provider = String(item.provider || "");
  if (/google/i.test(provider)) return true;
  const blob = `${item.text || ""} ${item.src || ""} ${item.href || ""}`;
  if (item.tag === "iframe") return /accounts\.google\.com|gsi\/|google/i.test(blob);
  if (oauthHref(item.href)) return /google/i.test(blob);
  return googleSignInLabel(item.text);
}

function targetPoint(item) {
  return {
    x: item.x,
    y: item.y,
    href: typeof item.href === "string" ? item.href : "",
  };
}

function chooseGoogleTarget(scan, email) {
  const none = { action: "none", x: 0, y: 0, href: "" };
  const targets = scan && Array.isArray(scan.targets) ? scan.targets : [];
  const host = String(scan && scan.host || "").toLowerCase();
  const onGoogle = host === "accounts.google.com"
    || host.endsWith(".accounts.google.com")
    || host === "myaccount.google.com"
    || host === "accounts.youtube.com";
  const wanted = String(email || "").trim().toLowerCase();
  const usable = targets.filter((item) => item && (item.w || 0) >= 8 && (item.h || 0) >= 8);

  if (onGoogle) {
    const rows = usable.filter((item) => item.identifier || (wanted && String(item.text || "").toLowerCase().includes(wanted)));
    const identified = rows.filter((item) => item.identifier);
    const match = wanted
      ? rows.find((item) => String(item.identifier || "").toLowerCase() === wanted || String(item.text || "").toLowerCase().includes(wanted))
      : null;
    const only = identified.length === 1 ? identified[0] : null;
    const pick = match || only;
    if (pick) return { action: "account", ...targetPoint(pick) };
    if (identified.length > 1) return { action: "form", x: 0, y: 0, href: "" };
    if (scan && scan.form) return { action: "form", x: 0, y: 0, href: "" };
    const consent = usable.find((item) => (item.tag === "button" || item.tag === "a" || item.tag === "div") && isConsentLabel(item.text));
    if (consent) return { action: "consent", ...targetPoint(consent) };
    return none;
  }

  const google = usable.filter(isGoogleControl).sort((a, b) => {
    const score = (item) => {
      let n = (item.w || 0) * (item.h || 0);
      if (oauthHref(item.href)) n += 1000000000;
      if (item.tag === "button" || item.tag === "a") n += 100000;
      if (item.tag === "iframe") n += 10000;
      return n;
    };
    return score(b) - score(a);
  })[0];
  if (google) return { action: "google", ...targetPoint(google) };

  const opener = usable.find((item) => isLoginOpener(item.text) && !/google/i.test(item.text || ""));
  if (opener) return { action: "open", ...targetPoint(opener) };
  return none;
}

const LIST_GOOGLE_TARGETS_SCRIPT = `(() => {
  function norm(value) {
    return String(value || "").replace(/\\s+/g, " ").trim();
  }
  function shown(el) {
    if (!el || el.disabled || el.hidden) return false;
    if (el.getAttribute("aria-disabled") === "true" || el.getAttribute("aria-hidden") === "true") return false;
    let style = null;
    try { style = getComputedStyle(el); } catch (err) { style = null; }
    if (style && (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0)) return false;
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width < 8 || rect.height < 8) return false;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return false;
    return true;
  }
  function walk(root, out, depth) {
    if (!root || !root.querySelectorAll || depth > 3 || out.length > 80) return;
    const nodes = root.querySelectorAll("button, a, [role='button'], [role='link'], iframe, [data-identifier], [data-email], input");
    for (const el of nodes) {
      if (out.length > 80) return;
      out.push(el);
    }
    const all = root.querySelectorAll("*");
    for (const el of all) {
      if (el.shadowRoot) walk(el.shadowRoot, out, depth + 1);
    }
  }
  const nodes = [];
  walk(document, nodes, 0);
  const targets = [];
  let form = false;
  for (const el of nodes) {
    if (!shown(el)) continue;
    const tag = String(el.tagName || "").toLowerCase();
    if (tag === "input") {
      const type = String(el.getAttribute("type") || "text").toLowerCase();
      const name = String(el.getAttribute("name") || "");
      if (type === "email" || type === "password" || type === "tel" || name === "identifier" || el.id === "identifierId") form = true;
      continue;
    }
    const rect = el.getBoundingClientRect();
    const text = norm((el.innerText || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || ""));
    const href = typeof el.href === "string" ? el.href : (el.getAttribute("href") || "");
    targets.push({
      tag,
      text: text.slice(0, 120),
      href: String(href || "").slice(0, 500),
      src: tag === "iframe" ? String(el.getAttribute("src") || "").slice(0, 300) : "",
      provider: String(el.getAttribute("data-provider") || el.getAttribute("data-auth-provider") || "").slice(0, 40),
      identifier: String(el.getAttribute("data-identifier") || el.getAttribute("data-email") || "").slice(0, 120),
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    });
    if (targets.length >= 40) break;
  }
  let host = "";
  try { host = String(location.hostname || ""); } catch (err) { host = ""; }
  return { host, form, targets };
})()`;

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
  geminiSignInUrl,
  isGoogleAccountUrl,
  authLanded,
  googleClickAction,
  googleSignInLabel,
  googleCookieSet,
  oauthHref,
  isLoginOpener,
  isConsentLabel,
  chooseGoogleTarget,
  LIST_GOOGLE_TARGETS_SCRIPT,
  CLICK_GOOGLE_SCRIPT,
};
