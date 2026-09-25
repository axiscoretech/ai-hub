const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isGoogleHost,
  hasGoogleSession,
  findEmail,
  loginUrlFor,
  targetsForApply,
  sharedProfiles,
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
