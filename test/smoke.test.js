const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { _electron: electron } = require("playwright");

test("the app starts, isolates partitions, and blocks outside navigation", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "ai-hub-smoke-"));
  const launchArgs = ["."];
  if (process.env.CI) launchArgs.unshift("--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage");
  const app = await electron.launch({
    args: launchArgs,
    env: {
      ...process.env,
      AI_HUB_USER_DATA: userData,
      AI_HUB_TEST: "1",
      ELECTRON_DISABLE_SANDBOX: "1",
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
    await window.locator('.tab[data-name="ChatGPT"]').click();
    await window.waitForSelector("#account-switch:not([hidden])");
    await window.evaluate(() => {
      document.body.dataset.theme = "light";
      document.documentElement.dataset.theme = "light";
    });
    const ui = await window.evaluate(() => {
      const menu = document.getElementById("account-menu");
      const update = document.getElementById("hub-update");
      const menuColor = getComputedStyle(menu).color;
      const bar = document.getElementById("update-bar");
      bar.hidden = false;
      const download = document.getElementById("update-action");
      const downloadColor = getComputedStyle(download).color;
      bar.hidden = true;
      return {
        menuLabel: menu.getAttribute("aria-label"),
        menuText: menu.textContent,
        menuColor,
        downloadColor,
        updateHidden: update.hidden,
        hasSelect: Boolean(document.getElementById("account-select")),
      };
    });
    assert.equal(ui.menuLabel, "Account");
    assert.equal(ui.menuText, "Default");
    assert.equal(ui.updateHidden, true);
    assert.equal(ui.hasSelect, false);
    assert.equal(ui.menuColor, "rgb(17, 24, 39)");
    assert.equal(ui.downloadColor, "rgb(17, 24, 39)");

    const google = window.locator("#google-btn");
    await google.waitFor();
    if (!(await window.locator("#google-panel.open").count())) await google.click();
    await window.locator("#google-panel.open").waitFor();
    assert.equal(await window.locator("#google-signin").isEnabled(), true);

    const deadline = Date.now() + 4000;
    let overlay = { topBar: 0, windowHeight: 1, page: null };
    while (Date.now() < deadline) {
      overlay = await app.evaluate(({ BrowserWindow }) => {
        const api = global.__aiHubTest;
        const win = BrowserWindow.getAllWindows()[0];
        const [, height] = win.getContentSize();
        return {
          topBar: api.getTopBarHeight(),
          windowHeight: height,
          page: api.getPageViewBounds(),
        };
      });
      if (overlay.topBar >= overlay.windowHeight - 2) break;
      if (overlay.page && overlay.page.height === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(
      overlay.topBar >= overlay.windowHeight - 2,
      `Google panel should cover the page view (top bar ${overlay.topBar}, window ${overlay.windowHeight})`,
    );
    if (overlay.page) assert.equal(overlay.page.height, 0);
    await google.click();
    await window.locator("#google-panel").waitFor({ state: "hidden" });
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
