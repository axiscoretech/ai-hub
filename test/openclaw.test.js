const test = require("node:test");
const assert = require("node:assert/strict");
const { controlUrlWithToken, isOfficialInstallerUrl } = require("../out/main/openclaw");

test("a gateway token is attached as a fragment, not a query", () => {
  const url = controlUrlWithToken("http://127.0.0.1:18789/", "local-secret");
  const parsed = new URL(url);
  assert.equal(parsed.origin, "http://127.0.0.1:18789");
  assert.equal(parsed.search, "");
  assert.equal(parsed.hash, "#token=local-secret");
  assert.equal(controlUrlWithToken("http://127.0.0.1:18789/", ""), null);
  assert.equal(controlUrlWithToken("https://example.com/", "local-secret"), null);
});

test("the OpenClaw installer stays on the official site", () => {
  assert.equal(isOfficialInstallerUrl("https://openclaw.ai/install.sh"), true);
  assert.equal(isOfficialInstallerUrl("http://openclaw.ai/install.sh"), false);
  assert.equal(isOfficialInstallerUrl("https://evil.example/install.sh"), false);
  assert.equal(isOfficialInstallerUrl("https://openclaw.ai.evil/install.sh"), false);
});
