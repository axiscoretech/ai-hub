const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const {
  isGoogleHost,
  hasGoogleSession,
  findEmail,
  loginUrlFor,
  targetsForApply,
  sharedProfiles,
  signInNavigation,
  googleClickAction,
  googleSignInLabel,
  googleCookieSet,
  oauthHref,
  chooseGoogleTarget,
  LIST_GOOGLE_TARGETS_SCRIPT,
  authLanded,
  CLICK_GOOGLE_SCRIPT,
} = require("../out/main/google");

test("google hosts are recognized and other sites are not", () => {
  assert.equal(isGoogleHost(".google.com"), true);
  assert.equal(isGoogleHost("accounts.google.com"), true);
  assert.equal(isGoogleHost(".youtube.com"), true);
  assert.equal(isGoogleHost("chatgpt.com"), false);
  assert.equal(isGoogleHost("notgoogle.com"), false);
});

test("a session needs a real Google auth cookie", () => {
  assert.equal(hasGoogleSession([
    { domain: ".google.com", name: "SID", value: "abc" },
  ]), true);
  assert.equal(hasGoogleSession([
    { domain: "chatgpt.com", name: "SID", value: "abc" },
  ]), false);
  assert.equal(hasGoogleSession([
    { domain: ".google.com", name: "SID", value: "" },
  ]), false);
});

test("email is taken from page text", () => {
  assert.equal(findEmail("Signed in as Ada@Example.com today"), "Ada@Example.com");
  assert.equal(findEmail("no address here"), "");
});

test("apply-all skips OpenClaw and per-tab overrides", () => {
  const services = ["ChatGPT", "Claude", "Gemini", "OpenClaw"];
  assert.deepEqual(targetsForApply(services, { Claude: true }), ["ChatGPT", "Gemini"]);
  assert.equal(loginUrlFor("ChatGPT").includes("chatgpt.com"), true);
  assert.equal(loginUrlFor("OpenClaw"), "");
});

test("shared sign-in opens each service login instead of the logged-out home page", () => {
  const chatgpt = signInNavigation("ChatGPT", "https://chatgpt.com/c/123", "https://chat.openai.com/");
  assert.equal(chatgpt.url, "https://chatgpt.com/auth/login");
  assert.equal(chatgpt.googleClick, true);
  assert.equal(chatgpt.load, true);
  assert.equal(chatgpt.reload, false);

  const waiting = signInNavigation("Claude", "https://claude.ai/login", "https://claude.ai/");
  assert.equal(waiting.googleClick, true);
  assert.equal(waiting.load, false);
  assert.equal(waiting.reload, true);

  const geminiChat = signInNavigation("Gemini", "https://gemini.google.com/app/abc", "https://gemini.google.com/", "Ada@Example.com");
  assert.equal(geminiChat.load, true);
  assert.equal(geminiChat.reload, false);
  assert.match(geminiChat.url, /^https:\/\/accounts\.google\.com\/AccountChooser\?/);
  assert.match(geminiChat.url, /continue=https%3A%2F%2Fgemini\.google\.com%2F/);
  assert.match(geminiChat.url, /Email=Ada%40Example\.com/);
  assert.equal(signInNavigation("OpenClaw", "http://127.0.0.1:18789/", "http://127.0.0.1:18789/").url, "");
  assert.equal(authLanded("ChatGPT", "https://chatgpt.com/"), true);
  assert.equal(authLanded("ChatGPT", "https://chatgpt.com/auth/login"), false);
  assert.equal(authLanded("Gemini", "https://accounts.google.com/AccountChooser"), false);
  assert.equal(authLanded("Gemini", "https://gemini.google.com/app"), true);
});

test("google cookies keep their host and same-site rules", () => {
  const domainCookie = googleCookieSet({
    domain: ".google.com",
    name: "__Secure-1PSID",
    value: "abc",
    path: "/",
    secure: true,
    httpOnly: true,
    hostOnly: false,
    sameSite: "no_restriction",
    expirationDate: 2_000_000_000,
  });
  assert.equal(domainCookie.domain, "google.com");
  assert.equal(domainCookie.url, "https://google.com/");
  assert.equal(domainCookie.sameSite, "no_restriction");
  assert.equal(domainCookie.secure, true);

  const hostCookie = googleCookieSet({
    domain: "accounts.google.com",
    name: "__Host-1PLSID",
    value: "def",
    path: "/",
    secure: true,
    httpOnly: true,
    hostOnly: true,
  });
  assert.equal(hostCookie.domain, undefined);
  assert.equal(hostCookie.url, "https://accounts.google.com/");
  assert.equal(hostCookie.secure, true);
  assert.equal(googleCookieSet({ domain: "chatgpt.com", name: "SID", value: "x" }), null);
  assert.equal(googleCookieSet({ domain: ".google.com", name: "SID", value: "" }), null);
});

test("shared sign-in chooses the google control, then the shared account", () => {
  assert.equal(oauthHref("https://accounts.google.com/o/oauth2/v2/auth?client_id=1"), "https://accounts.google.com/o/oauth2/v2/auth?client_id=1");
  assert.equal(oauthHref("https://chatgpt.com/auth/login"), "");

  const login = chooseGoogleTarget({
    host: "chatgpt.com",
    targets: [
      { tag: "button", text: "Sign in", x: 10, y: 10, w: 80, h: 30 },
      { tag: "a", text: "Continue with Google", href: "https://accounts.google.com/o/oauth2/v2/auth", x: 40, y: 80, w: 200, h: 40 },
      { tag: "iframe", text: "Sign in with Google", src: "https://accounts.google.com/gsi/button", x: 40, y: 140, w: 180, h: 40 },
    ],
  }, "");
  assert.equal(login.action, "google");
  assert.equal(login.href, "https://accounts.google.com/o/oauth2/v2/auth");

  const account = chooseGoogleTarget({
    host: "accounts.google.com",
    targets: [
      { tag: "div", text: "Other", identifier: "other@example.com", x: 20, y: 40, w: 240, h: 48 },
      { tag: "div", text: "Ada", identifier: "ada@example.com", x: 20, y: 100, w: 240, h: 48 },
    ],
  }, "Ada@Example.com");
  assert.equal(account.action, "account");
  assert.equal(account.y, 100);

  const ambiguous = chooseGoogleTarget({
    host: "accounts.google.com",
    targets: [
      { tag: "div", text: "One", identifier: "one@example.com", x: 1, y: 1, w: 40, h: 40 },
      { tag: "div", text: "Two", identifier: "two@example.com", x: 1, y: 50, w: 40, h: 40 },
    ],
  }, "");
  assert.equal(ambiguous.action, "form");

  const only = chooseGoogleTarget({
    host: "accounts.google.com",
    form: false,
    targets: [
      { tag: "div", text: "Ada", identifier: "ada@example.com", x: 12, y: 24, w: 200, h: 40 },
    ],
  }, "");
  assert.equal(only.action, "account");

  const consent = chooseGoogleTarget({
    host: "accounts.google.com",
    targets: [{ tag: "button", text: "Continue", x: 30, y: 60, w: 120, h: 36 }],
  }, "");
  assert.equal(consent.action, "consent");

  const password = chooseGoogleTarget({
    host: "accounts.google.com",
    form: true,
    targets: [{ tag: "button", text: "Next", x: 30, y: 60, w: 120, h: 36 }],
  }, "");
  assert.equal(password.action, "form");

  const opener = chooseGoogleTarget({
    host: "chat.qwen.ai",
    targets: [{ tag: "button", text: "Sign in", x: 8, y: 12, w: 70, h: 28 }],
  }, "");
  assert.equal(opener.action, "open");
});

test("the page scan finds a visible google button and skips a hidden one", () => {
  function element(item) {
    return {
      tagName: item.tag || "BUTTON",
      innerText: item.text || "",
      disabled: false,
      hidden: Boolean(item.hidden),
      id: item.id || "",
      href: item.href || "",
      shadowRoot: item.shadow || null,
      getAttribute(name) {
        return item[name] || null;
      },
      getBoundingClientRect() {
        return item.rect || { left: 10, top: 20, width: 180, height: 40, right: 190, bottom: 60 };
      },
      querySelectorAll(selector) {
        const nodes = item.children || [];
        if (selector === "*") return nodes;
        return nodes.filter((node) => node.matches);
      },
    };
  }
  const button = element({ text: "Continue with Google", href: "https://accounts.google.com/o/oauth2/v2/auth" });
  button.matches = true;
  const hidden = element({
    text: "Continue with Google",
    hidden: true,
    rect: { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 },
  });
  const document = {
    querySelectorAll(selector) {
      if (selector === "*") return [button, hidden];
      return [button, hidden];
    },
  };
  const result = vm.runInNewContext(LIST_GOOGLE_TARGETS_SCRIPT, {
    document,
    location: { hostname: "chatgpt.com" },
    getComputedStyle() { return { display: "block", visibility: "visible", opacity: "1" }; },
    innerWidth: 800,
    innerHeight: 600,
  });
  assert.equal(result.host, "chatgpt.com");
  assert.equal(result.form, false);
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].text, "Continue with Google");
  assert.equal(result.targets[0].x, 100);
  assert.equal(result.targets[0].y, 40);
});

test("the Google button click waits on the account chooser and stops after login", () => {
  assert.equal(googleClickAction("about:blank", "ChatGPT"), "wait");
  assert.equal(googleClickAction("https://accounts.google.com/o/oauth2/v2/auth", "ChatGPT"), "wait");
  assert.equal(googleClickAction("https://chatgpt.com/auth/login?next=/", "ChatGPT"), "click");
  assert.equal(googleClickAction("https://claude.ai/login", "Claude"), "click");
  assert.equal(googleClickAction("https://chat.deepseek.com/sign_in", "DeepSeek"), "click");
  assert.equal(googleClickAction("https://chatgpt.com/c/123", "ChatGPT"), "stop");
  assert.equal(googleClickAction("https://chat.qwen.ai/", "Qwen"), "click");
});

test("only a Google sign-in control is clicked", () => {
  assert.equal(googleSignInLabel("Continue with Google"), true);
  assert.equal(googleSignInLabel("Sign in with Google"), true);
  assert.equal(googleSignInLabel("Войти через Google"), true);
  assert.equal(googleSignInLabel("Google"), true);
  assert.equal(googleSignInLabel("Search Google"), false);
  assert.equal(googleSignInLabel("Learn more about Google"), false);
  assert.equal(googleSignInLabel(""), false);

  function press(elements) {
    const clicked = [];
    const window = {};
    const document = {
      querySelectorAll() {
        return elements.map((item) => ({
          innerText: item.text || "",
          disabled: Boolean(item.disabled),
          hidden: Boolean(item.hidden),
          getAttribute(name) {
            return item[name] || null;
          },
          click() { clicked.push(item.text || item["aria-label"] || ""); },
        }));
      },
    };
    const result = vm.runInNewContext(CLICK_GOOGLE_SCRIPT, { window, document });
    return { result, clicked };
  }

  const missed = press([{ text: "Email" }, { text: "Search Google" }]);
  assert.equal(missed.result, false);
  assert.deepEqual(missed.clicked, []);

  const ready = press([
    { text: "Search Google" },
    { text: "Continue with Google" },
    { text: "Log in with Google" },
  ]);
  assert.equal(ready.result, true);
  assert.deepEqual(ready.clicked, ["Continue with Google"]);

  const labeled = press([{ text: "", "aria-label": "Sign in with Google" }]);
  assert.equal(labeled.result, true);
  assert.deepEqual(labeled.clicked, ["Sign in with Google"]);

  const hidden = press([{ text: "Continue with Google", hidden: true }, { text: "Google", "aria-label": "Continue with Google" }]);
  assert.deepEqual(hidden.clicked, ["Google"]);
});

test("a shared Google account covers chosen profiles only", () => {
  const profiles = [
    { serviceId: "Claude", accountId: "default" },
    { serviceId: "Claude", accountId: "work" },
    { serviceId: "Gemini", accountId: "default" },
    { serviceId: "OpenClaw", accountId: "default" },
  ];
  assert.deepEqual(sharedProfiles(profiles, {}).map((item) => item.accountId + "@" + item.serviceId), [
    "default@Claude",
    "default@Gemini",
  ]);
  assert.deepEqual(sharedProfiles(profiles, { overrides: { Claude: true } }).map((item) => item.serviceId), ["Gemini"]);
  assert.deepEqual(sharedProfiles(profiles, { shared: { Claude: ["work"] } }).map((item) => item.accountId), ["work"]);
});
