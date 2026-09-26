const test = require("node:test");
const assert = require("node:assert/strict");
const { createNavigation } = require("../out/main/navigation");
const { isOpenClawControlUrl } = require("../out/main/openclaw");

const URLS = {
  ChatGPT: "https://chatgpt.com",
  Claude: "https://claude.ai",
  Gemini: "https://gemini.google.com",
  Qwen: "https://chat.qwen.ai",
  OpenClaw: "http://127.0.0.1:18789",
};

function nav() {
  return createNavigation({
    tabUrl: (name) => URLS[name],
    isOpenClawControlUrl,
    openExternal: () => {},
  });
}

test("a service page stays in the tab and a foreign site leaves it", () => {
  const { shouldOpenInSystemBrowser, isServiceUrlForTab } = nav();
  assert.equal(shouldOpenInSystemBrowser("Claude", "https://claude.ai/new"), false);
  assert.equal(shouldOpenInSystemBrowser("Claude", "https://example.com/phish"), true);
  assert.equal(isServiceUrlForTab("ChatGPT", "https://chat.openai.com/"), true);
  assert.equal(isServiceUrlForTab("ChatGPT", "https://chatgpt.com/c/1"), true);
  assert.equal(isServiceUrlForTab("Qwen", "https://chat.qwenlm.ai/"), true);
});

test("identity providers stay in the app and a generic login path does not", () => {
  const { shouldOpenInSystemBrowser, isOpenerPopupUrl, isAuthPopupUrl } = nav();
  assert.equal(shouldOpenInSystemBrowser("Claude", "https://accounts.google.com/signin"), false);
  assert.equal(shouldOpenInSystemBrowser("ChatGPT", "https://auth.openai.com/authorize"), false);
  assert.equal(isOpenerPopupUrl("Claude", "https://accounts.google.com/o/oauth2/v2/auth"), true);
  assert.equal(isOpenerPopupUrl("Claude", "https://example.com/login"), false);
  assert.equal(isAuthPopupUrl("https://login.microsoftonline.com/common"), true);
  assert.equal(shouldOpenInSystemBrowser("Claude", "mailto:hi@example.com"), false);
});

test("OpenClaw control urls stay in the tab across loopback hosts", () => {
  const { isServiceUrlForTab } = nav();
  assert.equal(isServiceUrlForTab("OpenClaw", "http://localhost:18789/"), true);
  assert.equal(isServiceUrlForTab("OpenClaw", "http://127.0.0.1:18789/chat"), true);
  assert.equal(isServiceUrlForTab("OpenClaw", "https://example.com/"), false);
});

test("repeated external opens are collapsed", () => {
  const opened = [];
  const { openInSystemBrowser } = createNavigation({
    tabUrl: (name) => URLS[name],
    isOpenClawControlUrl,
    openExternal: (url) => opened.push(url),
  });
  openInSystemBrowser("https://example.com/a");
  openInSystemBrowser("https://example.com/a");
  openInSystemBrowser("https://example.com/b");
  assert.deepEqual(opened, ["https://example.com/a", "https://example.com/b"]);
});
