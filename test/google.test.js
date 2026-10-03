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

  const geminiHome = signInNavigation("Gemini", "https://gemini.google.com/", "https://gemini.google.com/");
  assert.equal(geminiHome.googleClick, false);
  assert.equal(geminiHome.reload, true);
  assert.equal(geminiHome.load, false);

  const geminiChat = signInNavigation("Gemini", "https://gemini.google.com/app/abc", "https://gemini.google.com/");
  assert.equal(geminiChat.load, true);
  assert.equal(geminiChat.reload, false);
  assert.equal(signInNavigation("OpenClaw", "http://127.0.0.1:18789/", "http://127.0.0.1:18789/").url, "");
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
