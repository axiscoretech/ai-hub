// @ts-check
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const os = require("os");
const { app } = require("electron");
const { handle } = require("./ipc-bind");
const { checksumFor } = require("./checksums");
const { macUpdateScript } = require("./mac-update");

function createUpdates(options = {}) {
  const getWindow = options.window || (() => null);

  let autoUpdater = null;
  let updateReady = false;
  let updateFile = "";

  function releaseChecksumUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" && (
        parsed.hostname === "github.com" || parsed.hostname.endsWith(".githubusercontent.com")
      );
    } catch {
      return false;
    }
  }

  function fetchReleaseText(url, redirectsLeft = 3) {
    return new Promise((resolve, reject) => {
      if (!releaseChecksumUrl(url)) {
        reject(new Error("source"));
        return;
      }
      const request = https.get(url, { headers: { "User-Agent": "AI-Hub", Accept: "application/octet-stream" } }, (response) => {
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirectsLeft <= 0) {
            reject(new Error("redirect"));
            return;
          }
          fetchReleaseText(new URL(response.headers.location, url).href, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error("status"));
          return;
        }
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      request.on("error", reject);
    });
  }

  function sha256File(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      const stream = fs.createReadStream(filePath);
      stream.on("error", reject);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  }

  async function verifyDownloadedUpdate(filePath, version) {
    if (!filePath || !/^\d+\.\d+\.\d+$/.test(String(version || ""))) return false;
    const sums = await fetchReleaseText(`https://github.com/axiscoretech/ai-hub/releases/download/v${version}/SHA256SUMS`);
    const expected = checksumFor(sums, filePath);
    if (!expected) return false;
    return await sha256File(filePath) === expected;
  }

  function setupUpdates() {
    if (!app.isPackaged) return;
    try {
      autoUpdater = require("electron-updater").autoUpdater;
    } catch {
      autoUpdater = null;
      return;
    }
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on("update-available", (info) => {
      if (getWindow() && !getWindow().isDestroyed()) getWindow().webContents.send("update-available", { version: info && info.version });
    });
    autoUpdater.on("update-downloaded", (info) => {
      updateReady = false;
      updateFile = "";
      const file = info && info.downloadedFile;
      const version = info && info.version;
      void verifyDownloadedUpdate(file, version).then((ok) => {
        if (!getWindow() || getWindow().isDestroyed()) return;
        if (!ok) {
          getWindow().webContents.send("update-failed");
          return;
        }
        updateReady = true;
        updateFile = file;
        getWindow().webContents.send("update-downloaded");
      }).catch(() => {
        if (getWindow() && !getWindow().isDestroyed()) getWindow().webContents.send("update-failed");
      });
    });
    autoUpdater.on("error", () => {});
    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 4 * 60 * 60 * 1000);
  }

  handle("update-download", async () => {
    if (!autoUpdater) return { success: false, error: "Updates are available in the installed app" };
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  function macAppBundlePath() {
    return path.resolve(process.execPath, "..", "..", "..");
  }

  function macHasDeveloperId() {
    const { spawnSync } = require("child_process");
    const result = spawnSync("codesign", ["-dvv", macAppBundlePath()], { encoding: "utf8" });
    return /Authority=Developer ID Application:/.test(`${result.stdout || ""}\n${result.stderr || ""}`);
  }

  function installUnsignedMacUpdate() {
    const { spawn } = require("child_process");
    const appPath = macAppBundlePath();
    const scriptPath = path.join(os.tmpdir(), `ai-hub-update-${process.pid}.sh`);
    const script = macUpdateScript({ pid: process.pid, zipPath: updateFile, appPath, scriptPath });
    fs.writeFileSync(scriptPath, script, { mode: 0o700 });
    const child = spawn("/bin/bash", [scriptPath], { detached: true, stdio: "ignore" });
    child.unref();
    app.quit();
  }

  handle("update-install", () => {
    if (!autoUpdater) return { success: false, error: "Updates are available in the installed app" };
    if (!updateReady || !updateFile) return { success: false, error: "The download did not match the published checksum." };
    if (process.platform === "darwin" && !macHasDeveloperId()) {
      installUnsignedMacUpdate();
      return { success: true };
    }
    autoUpdater.quitAndInstall(false, true);
    return { success: true };
  });

  return { setupUpdates };
}

module.exports = { createUpdates };
