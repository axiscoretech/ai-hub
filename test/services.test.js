const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createServices, OPENCLAW_ID } = require("../out/main/services");
const { streamEnded } = require("../out/main/stream-end");

function makeApi() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-hub-services-"));
  const api = createServices({
    getUserDataPath: () => dir,
    openclawUrl: "http://127.0.0.1:18789/",
  });
  return {
    dir,
    api,
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test("a new layout hides OpenClaw and keeps the legacy partition", () => {
  const ctx = makeApi();
  try {
    const status = ctx.api.list();
    const openclaw = status.services.find((item) => item.id === OPENCLAW_ID);
    const claude = status.services.find((item) => item.id === "Claude");
    assert.equal(openclaw.hidden, true);
    assert.equal(claude.hidden, false);
    assert.equal(claude.accounts[0].partition, "persist:Claude");
    assert.equal(claude.route, "tunnel");
  } finally {
    ctx.cleanup();
  }
});

test("extra accounts get their own partition", async () => {
  const ctx = makeApi();
  try {
    const status = await ctx.api.addAccount("Claude", "Work");
    const claude = status.services.find((item) => item.id === "Claude");
    assert.equal(claude.accounts.length, 2);
    const extra = claude.accounts.find((item) => item.label === "Work");
    assert.ok(extra);
    assert.equal(extra.partition, `persist:Claude:${extra.id}`);
    assert.notEqual(extra.partition, "persist:Claude");
    assert.equal(claude.activeAccountId, extra.id);
    const back = await ctx.api.setActiveAccount("Claude", "default");
    assert.equal(back.services.find((item) => item.id === "Claude").activeAccountId, "default");
  } finally {
    ctx.cleanup();
  }
});

test("route, order, custom urls, and visibility persist", async () => {
  const ctx = makeApi();
  try {
    await ctx.api.setRoute("DeepSeek", "direct");
    await ctx.api.setHidden("OpenClaw", false);
    const added = await ctx.api.addCustom("Notebook", "https://notebooklm.google.com/app");
    const custom = added.services.find((item) => item.name === "Notebook");
    assert.ok(custom);
    assert.equal(custom.builtin, false);
    assert.equal(custom.accounts[0].partition, `persist:${custom.id}`);
    await assert.rejects(() => ctx.api.addCustom("Bad", "http://example.com/"), /https/);
    const order = added.services.map((item) => item.id);
    const flipped = [order[1], order[0], ...order.slice(2)];
    const reordered = await ctx.api.reorder(flipped);
    assert.equal(reordered.services[0].id, flipped[0]);
    const again = createServices({
      getUserDataPath: () => ctx.dir,
      openclawUrl: "http://127.0.0.1:18789/",
    });
    const saved = again.list();
    assert.equal(saved.services.find((item) => item.id === "DeepSeek").route, "direct");
    assert.equal(saved.services.find((item) => item.id === "OpenClaw").hidden, false);
    assert.ok(saved.services.some((item) => item.name === "Notebook"));
  } finally {
    ctx.cleanup();
  }
});

test("stream end matches a known completion and ignores page loads", () => {
  assert.equal(streamEnded("Claude", {
    url: "https://claude.ai/api/organizations/org/chat_conversations/chat/completion",
    method: "POST",
    statusCode: 200,
    resourceType: "xhr",
  }), true);
  assert.equal(streamEnded("Claude", {
    url: "https://claude.ai/",
    method: "GET",
    statusCode: 200,
    resourceType: "mainFrame",
  }), false);
  assert.equal(streamEnded("Notebook", {
    url: "https://claude.ai/api/organizations/org/chat_conversations/chat/completion",
    method: "POST",
    statusCode: 200,
  }), false);
});
