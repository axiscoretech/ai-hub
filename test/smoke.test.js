const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { _electron: electron } = require("playwright");

test("the app starts, isolates partitions, and blocks outside navigation", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "ai-hub-smoke-"));
  const app = await electron.launch({
    args: ["."],
    env: {
      ...process.env,
      AI_HUB_USER_DATA: userData,
      AI_HUB_TEST: "1",
    },
  });
  try {
    const window = await app.firstWindow();
    assert.ok(await window.title());
    const isolated = await app.evaluate(async ({ session }) => {
      const claude = session.fromPartition("persist:Claude");
      await claude.cookies.set({
        url: "https://claude.ai/",
        name: "hub_test",
        value: "claude-only",
      });
      const seen = await session.fromPartition("persist:ChatGPT").cookies.get({ name: "hub_test" });
      return seen.length;
    });
    assert.equal(isolated, 0);
    const policy = await app.evaluate(() => {
      const api = global.__aiHubTest;
      return {
        outside: api.shouldOpenInSystemBrowser("Claude", "https://example.com/phish"),
        inside: api.shouldOpenInSystemBrowser("Claude", "https://claude.ai/new"),
      };
    });
    assert.equal(policy.outside, true);
    assert.equal(policy.inside, false);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
