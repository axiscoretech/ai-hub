#!/usr/bin/env node

const { app, session } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const http = require("http");
const { execFile } = require("child_process");

const EXTENSIONS = [
  {
    id: "hnmpcagpplmpfojmgmnngilcnanddlhb",
    name: "Windscribe",
  },
  {
    id: "omghfjlpggmjjaagoclmmobgdodcjboh",
    name: "Browsec VPN",
  },
];

function downloadFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error("Too many redirects"));

    const mod = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);

    const req = mod.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlink(dest, () => {});
        downloadFile(res.headers.location, dest, redirects + 1).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    });

    req.on("error", (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

function extractZipFromCrx(buffer) {
  if (buffer.slice(0, 4).toString("ascii") === "Cr24") {
    const headerLen = buffer.readUInt32LE(8);
    return buffer.slice(12 + headerLen);
  }
  return buffer;
}

async function unzip(zipPath, outputDir) {
  return new Promise((resolve, reject) => {
    execFile("unzip", ["-o", zipPath, "-d", outputDir], (err) => {
      err ? reject(err) : resolve();
    });
  });
}

async function verifyExtension(targetSession, extension) {
  const crxUrl = `https://clients2.google.com/service/update2/crx?response=redirect&os=mac&arch=x64&os_arch=x86_64&prod=chromecrx&prodchannel=stable&prodversion=138.0.7204.169&acceptformat=crx2,crx3&x=id%3D${extension.id}%26installsource%3Dondemand%26uc`;
  const crxPath = path.join(os.tmpdir(), `verify-${extension.id}.crx`);
  const zipPath = path.join(os.tmpdir(), `verify-${extension.id}.zip`);
  const outDir = path.join(os.tmpdir(), `verify-${extension.id}`);

  fs.rmSync(outDir, { recursive: true, force: true });

  await downloadFile(crxUrl, crxPath);
  const crxBuffer = fs.readFileSync(crxPath);
  fs.writeFileSync(zipPath, extractZipFromCrx(crxBuffer));
  await unzip(zipPath, outDir);

  const api = targetSession.extensions ?? targetSession;
  const loaded = await api.loadExtension(outDir, { allowFileAccess: true });
  const loadedIds = api.getAllExtensions().map((item) => item.id);

  if (!loadedIds.includes(loaded.id)) {
    throw new Error(`Loaded extension ${extension.name} was not found in session`);
  }

  api.removeExtension(loaded.id);
  const afterUnload = api.getAllExtensions().map((item) => item.id);

  if (afterUnload.includes(loaded.id)) {
    throw new Error(`Extension ${extension.name} did not unload cleanly`);
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  try { fs.unlinkSync(crxPath); } catch {}
  try { fs.unlinkSync(zipPath); } catch {}

  return {
    id: loaded.id,
    name: loaded.name,
    version: loaded.version,
  };
}

app.whenReady().then(async () => {
  const verifySession = session.fromPartition("persist:verify-extensions");

  try {
    for (const extension of EXTENSIONS) {
      const result = await verifyExtension(verifySession, extension);
      console.log(`OK ${extension.name}: ${result.id} v${result.version}`);
    }
    app.exit(0);
  } catch (error) {
    console.error("Verification failed:", error.message);
    app.exit(1);
  }
});
