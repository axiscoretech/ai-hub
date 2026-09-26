#!/usr/bin/env node

// Opens each built-in service without signing in and checks that the page loads.
// ChatGPT and Claude also have to still expose the composer selector Compare uses.

const { app, BrowserWindow, session } = require("electron");

process.on("uncaughtException", (err) => {
  console.error(err && err.stack ? err.stack : err);
  app.exit(1);
});
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createServices, OPENCLAW_ID } = require("../out/main/services");
const { COMPOSER_SELECTOR } = require("../out/main/compare");

const LOAD_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 8;
const UNSUPPORTED_RE = /unsupported browser|browser is not supported|browser not supported|update your browser|please use a supported browser/i;
const BOT_WALL_RE = /security verification|verify you are human|checking your browser|just a moment|captcha|are you a human/i;
const COMPOSER_SERVICES = new Set(["ChatGPT", "Claude"]);

function browserUserAgent() {
  return app.userAgentFallback
    .replace(/\s*Electron\/\S+/, "")
    .replace(/\s*ai-hub\/\S+/, "");
}

function servicesToCheck() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "ai-hub-smoke-services-"));
  const services = createServices({
    getUserDataPath: () => userData,
    openclawUrl: "http://127.0.0.1:18789/",
  });
  const only = new Set(String(process.env.SMOKE_ONLY || "").split(",").map((item) => item.trim()).filter(Boolean));
  const rows = services.list().services.filter((service) => service.id !== OPENCLAW_ID && (!only.size || only.has(service.id)));
  fs.rmSync(userData, { recursive: true, force: true });
  return rows;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snippet(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 140);
}

async function pageSnapshot(contents) {
  const probe = `(() => {
    const text = document.body ? document.body.innerText.slice(0, 4000) : "";
    const html = document.documentElement ? document.documentElement.outerHTML.length : 0;
    return {
      text,
      title: document.title || "",
      html,
      composer: document.querySelectorAll(${JSON.stringify(COMPOSER_SELECTOR)}).length > 0,
    };
  })()`;
  try {
    return await contents.executeJavaScript(probe, true);
  } catch {
    return { text: "", title: "", html: 0, composer: false };
  }
}

function loadService(window, service) {
  const contents = window.webContents;
  return new Promise((resolve) => {
    let redirects = 0;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      contents.removeListener("did-redirect-navigation", onRedirect);
      contents.removeListener("did-fail-load", onFail);
      contents.removeListener("did-finish-load", onLoad);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, detail: "timed out" }), LOAD_TIMEOUT_MS);
    const onRedirect = () => {
      redirects += 1;
      if (redirects > MAX_REDIRECTS) finish({ ok: false, detail: "too many redirects" });
    };
    const onFail = (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      finish({ ok: false, detail: errorDescription || `load failed (${errorCode})` });
    };
    const onLoad = async () => {
      const wantsComposer = COMPOSER_SERVICES.has(service.id);
      const deadline = Date.now() + 10000;
      let snap = { text: "", title: "", html: 0, composer: false };
      while (!settled && Date.now() < deadline) {
        snap = await pageSnapshot(contents);
        const painted = snap.html > 800 || snap.text.trim().length > 40 || snap.title.trim().length > 0;
        if (painted && (!wantsComposer || snap.composer)) break;
        await delay(500);
      }
      if (settled) return;
      const text = `${snap.title}\n${snap.text}`;
      if (UNSUPPORTED_RE.test(text)) {
        finish({ ok: false, detail: "page says this browser is not supported" });
        return;
      }
      if (snap.html < 200 && snap.text.trim().length < 20) {
        finish({ ok: false, detail: "page stayed blank" });
        return;
      }
      if (BOT_WALL_RE.test(text)) {
        finish({ ok: true, detail: `${contents.getURL()} (bot check, composer not on this page)` });
        return;
      }
      if (wantsComposer && !snap.composer) {
        finish({ ok: false, detail: `composer selector ${COMPOSER_SELECTOR} matched nothing (${snippet(text)})` });
        return;
      }
      finish({ ok: true, detail: contents.getURL() });
    };
    contents.on("did-redirect-navigation", onRedirect);
    contents.on("did-fail-load", onFail);
    contents.on("did-finish-load", onLoad);
    contents.loadURL(service.url).catch((err) => {
      finish({ ok: false, detail: err && err.message ? err.message : "could not open the url" });
    });
  });
}

app.whenReady().then(async () => {
  const userAgent = browserUserAgent();
  const partition = "smoke-services";
  try { session.fromPartition(partition).setUserAgent(userAgent); } catch {}
  const window = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try { window.webContents.setUserAgent(userAgent); } catch {}
  const failures = [];
  try {
    for (const service of servicesToCheck()) {
      const result = await loadService(window, service);
      console.log(`${result.ok ? "ok" : "FAIL"}  ${service.id}  ${result.detail}`);
      if (!result.ok) failures.push(`${service.id}: ${result.detail}`);
    }
  } finally {
    try { window.destroy(); } catch {}
  }
  if (failures.length) {
    console.error(`\n${failures.length} service${failures.length === 1 ? "" : "s"} failed to load.`);
    app.exit(1);
    return;
  }
  console.log("\nAll services loaded.");
  app.exit(0);
}).catch((err) => {
  console.error(err && err.message ? err.message : err);
  app.exit(1);
});
