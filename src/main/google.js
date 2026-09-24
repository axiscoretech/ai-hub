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

const CLICK_GOOGLE_SCRIPT = `(() => {
  const nodes = [...document.querySelectorAll("button, a, [role='button']")];
  const target = nodes.find((el) => {
    const text = ((el.innerText || "") + " " + (el.getAttribute("aria-label") || "")).replace(/\\s+/g, " ").trim();
    return /google/i.test(text) && text.length < 80;
  });
  if (!target) return false;
  target.click();
  return true;
})()`;

module.exports = {
  GOOGLE_PARTITION,
  ACCOUNT_URL,
  isGoogleHost,
  hasGoogleSession,
  findEmail,
  loginUrlFor,
  targetsForApply,
  CLICK_GOOGLE_SCRIPT,
};
