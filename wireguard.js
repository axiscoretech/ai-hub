const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const { spawn } = require("child_process");

const INSTALL_HINT = "brew install wireproxy";
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;
const LOOKUP_URL = "https://ipwho.is/";

function isId(value) {
  return typeof value === "string" && ID_RE.test(value);
}

function displayNameFromFilename(filename) {
  const baseName = path.basename(String(filename || ""));
  const withoutExt = baseName.replace(/\.[^.]+$/, "");
  const name = withoutExt.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return name || "WireGuard";
}

function endpointHost(endpoint) {
  const value = String(endpoint || "").trim();
  if (!value) return "";
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 1 ? value.slice(1, end) : "";
  }
  const colon = value.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(value.slice(colon + 1))) return value.slice(0, colon);
  return value;
}

function parseWireguardConf(text) {
  const source = String(text || "").replace(/^\uFEFF/, "");
  let section = "";
  let hasPrivateKey = false;
  let hasPublicKey = false;
  let endpoint = "";

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = line.match(/^\[([^[\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase();
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim().replace(/\s+[#;].*$/, "").trim();
    if (section === "interface" && key === "privatekey" && value) hasPrivateKey = true;
    if (section === "peer" && key === "publickey" && value) hasPublicKey = true;
    if (section === "peer" && key === "endpoint" && value && !endpoint) endpoint = value;
  }

  const host = endpointHost(endpoint);
  if (!hasPrivateKey || !hasPublicKey || !host) {
    return {
      ok: false,
      error: "Not a WireGuard config (need Interface PrivateKey, Peer PublicKey, and Peer Endpoint).",
    };
  }
  return { ok: true, endpointHost: host };
}

function redactSecrets(text) {
  return String(text)
    .replace(/(PrivateKey\s*=\s*)(\S+)/gi, "$1[redacted]")
    .replace(/(PresharedKey\s*=\s*)(\S+)/gi, "$1[redacted]")
    .replace(/\b[A-Za-z0-9+/]{43}=/g, "[redacted]");
}

function buildWireproxyIni(wgConfigName, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid local proxy port");
  }
  if (!/^[\w.-]+\.conf$/.test(wgConfigName)) {
    throw new Error("Invalid WireGuard config name");
  }
  // Keys match wireproxy's README: WGConfig imports a WireGuard conf,
  // and [Socks5] BindAddress is the local proxy. Localhost only.
  return [
    `WGConfig = ${wgConfigName}`,
    "",
    "[Socks5]",
    `BindAddress = 127.0.0.1:${port}`,
    "",
  ].join("\n");
}

function buildSocksPac(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid local proxy port");
  }
  // Chromium PAC token "SOCKS5 host:port" makes the proxy resolve DNS.
  return [
    "function FindProxyForURL(url, host) {",
    "  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return 'DIRECT';",
    `  return 'SOCKS5 127.0.0.1:${port}';`,
    "}",
    "",
  ].join("\n");
}

function buildProxyConfig(port) {
  // Electron 38 ProxyConfig (electron.d.ts): mode "pac_script" and pacScript
  // as the PAC file URL. A data: URL is that URL, inlined.
  const pacScript = "data:application/x-ns-proxy-autoconfig;base64,"
    + Buffer.from(buildSocksPac(port), "utf8").toString("base64");
  return { mode: "pac_script", pacScript };
}

function safeCountryCode(value) {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

function formatExitLocation(data) {
  if (!data || typeof data !== "object" || data.success === false) return null;
  const city = typeof data.city === "string" ? data.city.trim() : "";
  const country = typeof data.country === "string" ? data.country.trim() : "";
  const label = [city, country].filter(Boolean).join(", ");
  if (!label) return null;
  return {
    label: label.replace(/[\0\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80),
    countryCode: safeCountryCode(data.country_code),
  };
}

function wireproxyAssetName(platformName, archName) {
  if (platformName === "darwin" && archName === "arm64") return "wireproxy_darwin_arm64.tar.gz";
  if (platformName === "darwin" && archName === "x64") return "wireproxy_darwin_amd64.tar.gz";
  if (platformName === "win32" && archName === "x64") return "wireproxy_windows_amd64.tar.gz";
  return null;
}

function wireproxyDownloadUrls(platformName, archName) {
  const asset = wireproxyAssetName(platformName, archName);
  if (!asset) return [];
  return [
    `https://github.com/pufferffish/wireproxy/releases/latest/download/${asset}`,
    `https://github.com/windtf/wireproxy/releases/latest/download/${asset}`,
  ];
}

function isPlausibleExecutable(buffer, platformName) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 64) return false;
  if (buffer[0] === 0x3c) return false;
  if (platformName === "win32") return buffer[0] === 0x4d && buffer[1] === 0x5a;
  const magic = buffer.readUInt32BE(0);
  return magic === 0xFEEDFACE
    || magic === 0xFEEDFACF
    || magic === 0xCEFAEDFE
    || magic === 0xCFFAEDFE
    || magic === 0xCAFEBABE
    || magic === 0xBEBAFECA;
}

function cstr(buffer, start, length) {
  const slice = buffer.subarray(start, start + length);
  const zero = slice.indexOf(0);
  return slice.subarray(0, zero === -1 ? slice.length : zero).toString("utf8");
}

function extractTarGz(buffer) {
  const tar = zlib.gunzipSync(buffer);
  const files = new Map();
  let offset = 0;
  let longName = "";

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = parseInt(cstr(header, 124, 12).trim(), 8);
    if (!Number.isFinite(size) || size < 0) break;
    const typeflag = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    let name = cstr(header, 0, 100);
    const prefix = cstr(header, 345, 155);
    if (prefix && typeflag !== "L") name = `${prefix}/${name}`;
    if (longName) {
      name = longName;
      longName = "";
    }
    offset += 512;
    const data = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (typeflag === "L") {
      longName = data.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (typeflag === "0") {
      const copy = Buffer.from(data);
      files.set(name, copy);
      const base = name.split("/").pop();
      if (base && !files.has(base)) files.set(base, copy);
    }
  }

  return files;
}

function safeFilename(name) {
  const base = path.basename(String(name || "")).replace(/[\0\r\n]/g, "");
  if (!base || base === "." || base === "..") return "";
  return base.slice(0, 180);
}

function safeLabel(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\0\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

function safeHost(value) {
  if (typeof value !== "string") return "";
  const host = value.trim();
  if (!host || /[\s/#?\\]/.test(host) || host.length > 253) return "";
  return host;
}

function installError(detail) {
  const extra = detail ? ` (${detail})` : "";
  return new Error(`Couldn't download wireproxy${extra}. Install it with: ${INSTALL_HINT}`);
}

function downloadBuffer(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error("Invalid download URL"));
      return;
    }
    const lib = parsed.protocol === "http:" ? http : https;
    const req = lib.get(url, {
      headers: {
        "User-Agent": "ai-hub",
        Accept: "application/octet-stream",
      },
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error("Too many redirects"));
          return;
        }
        const next = new URL(res.headers.location, url).href;
        downloadBuffer(next, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`download failed (${status})`));
        return;
      }
      const chunks = [];
      let received = 0;
      res.on("data", (chunk) => {
        received += chunk.length;
        if (received > MAX_DOWNLOAD_BYTES) {
          req.destroy(new Error("download is too large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(60000, () => req.destroy(new Error("download timed out")));
    req.on("error", reject);
  });
}

function getFreePort() {
  const net = require("net");
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function waitForLocalPort(port, readFailure) {
  const net = require("net");
  const deadline = Date.now() + 15000;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const failure = readFailure();
      if (failure) {
        reject(new Error(failure));
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("wireproxy did not open a local proxy in time"));
        return;
      }
      const socket = net.connect({ host: "127.0.0.1", port });
      const timer = setTimeout(() => socket.destroy(), 400);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.end();
        resolve();
      });
      socket.once("error", () => {
        clearTimeout(timer);
        setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

function createWireguard(options) {
  const getUserDataPath = options.getUserDataPath;
  const applyProxy = options.applyProxy;
  const clearProxy = options.clearProxy;
  const broadcast = options.broadcast || (() => {});
  const getDialogParent = options.getDialogParent || (() => null);
  const lookupPartition = options.lookupPartition || "persist:ChatGPT";
  const spawnProcess = options.spawn || spawn;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const lookupExit = options.lookupExitLocation || ((partition) => lookupExitLocation(partition));

  let profiles = [];
  let connectedId = null;
  let persistedConnectedId = null;
  let pendingId = null;
  let phase = "disconnected";
  let lastError = null;
  let revision = 0;
  let activeChild = null;
  let loaded = false;
  let quitting = false;
  let chain = Promise.resolve();

  function wireguardDir() {
    return path.join(getUserDataPath(), "wireguard");
  }

  function binDir() {
    return path.join(getUserDataPath(), "bin");
  }

  function profilesFile() {
    return path.join(wireguardDir(), "profiles.json");
  }

  function iniFile() {
    return path.join(wireguardDir(), "wireproxy.ini");
  }

  function confFile(id) {
    return path.join(wireguardDir(), `${id}.conf`);
  }

  function binaryFile() {
    return path.join(binDir(), platform === "win32" ? "wireproxy.exe" : "wireproxy");
  }

  function ensureDirs() {
    fs.mkdirSync(wireguardDir(), { recursive: true, mode: 0o700 });
    fs.mkdirSync(binDir(), { recursive: true, mode: 0o700 });
  }

  function chmodPrivate(file) {
    if (platform === "win32") return;
    try { fs.chmodSync(file, 0o600); } catch {}
  }

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(profilesFile(), "utf8"));
      const configs = Array.isArray(raw.configs) ? raw.configs : [];
      profiles = configs.map(normalizeProfile).filter(Boolean);
      persistedConnectedId = isId(raw.connectedId) ? raw.connectedId : null;
      if (persistedConnectedId && !profiles.some((entry) => entry.id === persistedConnectedId)) {
        persistedConnectedId = null;
      }
    } catch {
      profiles = [];
      persistedConnectedId = null;
    }
  }

  function save() {
    ensureDirs();
    const body = JSON.stringify({
      configs: profiles.map((entry) => ({
        id: entry.id,
        name: entry.name,
        filename: entry.filename,
        endpointHost: entry.endpointHost,
        location: entry.location || null,
        countryCode: entry.countryCode || null,
      })),
      connectedId: persistedConnectedId,
    }, null, 2);
    const dest = profilesFile();
    const tmp = `${dest}.tmp`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    chmodPrivate(tmp);
    fs.renameSync(tmp, dest);
    chmodPrivate(dest);
  }

  function snapshot() {
    const active = profiles.find((entry) => entry.id === connectedId) || null;
    const pending = profiles.find((entry) => entry.id === pendingId) || null;
    const shown = active || pending;
    return {
      revision,
      configs: profiles.map((entry) => ({
        id: entry.id,
        name: entry.name,
        filename: entry.filename,
        endpointHost: entry.endpointHost,
        location: entry.location || null,
        countryCode: entry.countryCode || null,
      })),
      connectedId,
      pendingId,
      label: shown ? shown.name : null,
      location: active ? (active.location || null) : null,
      countryCode: active ? (active.countryCode || null) : null,
      error: lastError,
      phase,
    };
  }

  function publish() {
    revision += 1;
    const status = snapshot();
    try { broadcast(status); } catch {}
    return status;
  }

  function enqueue(task) {
    const run = chain.then(task, task);
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  function findOnPath() {
    const pathValue = options.envPath !== undefined ? options.envPath : (process.env.PATH || "");
    const dirs = String(pathValue).split(path.delimiter).filter(Boolean);
    const names = platform === "win32" ? ["wireproxy.exe", "wireproxy"] : ["wireproxy"];
    for (const dir of dirs) {
      for (const name of names) {
        const candidate = path.join(dir, name);
        try {
          const stat = fs.statSync(candidate);
          if (!stat.isFile() || stat.size <= 0) continue;
          if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        } catch {}
      }
    }
    return null;
  }

  function isUsableBinaryFile(file) {
    let fd = null;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size < 64) return false;
      fd = fs.openSync(file, "r");
      const magic = Buffer.alloc(4);
      const read = fs.readSync(fd, magic, 0, 4, 0);
      fs.closeSync(fd);
      fd = null;
      if (read < 2) return false;
      const padded = Buffer.alloc(64);
      magic.copy(padded, 0, 0, read);
      return isPlausibleExecutable(padded, platform);
    } catch {
      if (fd != null) {
        try { fs.closeSync(fd); } catch {}
      }
      return false;
    }
  }

  function pickBinary(files) {
    const wanted = platform === "win32" ? "wireproxy.exe" : "wireproxy";
    if (files.has(wanted)) return files.get(wanted);
    for (const [name, data] of files) {
      if (String(name).split("/").pop().toLowerCase() === wanted) return data;
    }
    return null;
  }

  async function downloadOfficialBinary(dest) {
    const urls = wireproxyDownloadUrls(platform, arch);
    if (!urls.length) {
      throw installError(`no official build for ${platform} ${arch}`);
    }
    let failure = null;
    for (const url of urls) {
      try {
        const archive = await downloadBuffer(url);
        if (!archive.length) throw new Error("download was empty");
        const files = extractTarGz(archive);
        const binary = pickBinary(files);
        if (!binary || !isPlausibleExecutable(binary, platform)) {
          throw new Error("downloaded file is not a wireproxy executable");
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const tmp = `${dest}.download`;
        fs.writeFileSync(tmp, binary, { mode: 0o755 });
        if (platform !== "win32") fs.chmodSync(tmp, 0o755);
        const written = fs.statSync(tmp);
        if (!written.isFile() || written.size <= 0 || !isUsableBinaryFile(tmp)) {
          try { fs.unlinkSync(tmp); } catch {}
          throw new Error("downloaded file is not a wireproxy executable");
        }
        fs.renameSync(tmp, dest);
        if (platform !== "win32") fs.chmodSync(dest, 0o755);
        return;
      } catch (err) {
        failure = err;
      }
    }
    throw installError(failure && failure.message ? failure.message : "download failed");
  }

  async function resolveBinary() {
    const onPath = findOnPath();
    if (onPath) return onPath;
    const local = binaryFile();
    if (isUsableBinaryFile(local)) return local;
    await downloadOfficialBinary(local);
    if (!isUsableBinaryFile(local)) throw installError("downloaded file was empty");
    return local;
  }

  function haltProcess() {
    return new Promise((resolve) => {
      const proc = activeChild;
      activeChild = null;
      if (!proc || proc.exitCode !== null) {
        resolve();
        return;
      }
      let settled = false;
      let killTimer = null;
      let doneTimer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        clearTimeout(doneTimer);
        resolve();
      };
      proc.once("exit", finish);
      try {
        proc.kill("SIGTERM");
      } catch {
        finish();
        return;
      }
      if (settled) return;
      killTimer = setTimeout(() => {
        try {
          if (proc.exitCode === null) proc.kill("SIGKILL");
        } catch {}
      }, 800);
      doneTimer = setTimeout(finish, 1500);
      if (typeof killTimer.unref === "function") killTimer.unref();
      if (typeof doneTimer.unref === "function") doneTimer.unref();
    });
  }

  function exitText(code, stderr) {
    const tail = stderr ? redactSecrets(stderr).trim() : "";
    const base = `WireGuard proxy exited unexpectedly${code == null ? "" : ` (code ${code})`}`;
    if (!tail) return base;
    const line = tail.split(/\r?\n/).filter(Boolean).slice(-1)[0];
    return `${base}. ${line}`.slice(0, 400);
  }

  function watchProcess(proc, stderrRef) {
    proc.stdout?.on("data", () => {});
    proc.stderr?.on("data", (chunk) => {
      stderrRef.text = redactSecrets(`${stderrRef.text}${chunk.toString("utf8")}`).slice(-1500);
    });
    proc.once("error", (err) => {
      stderrRef.failure = err.message;
    });
    proc.on("exit", (code) => {
      if (quitting || activeChild !== proc) return;
      if (phase === "connecting") {
        stderrRef.failure = stderrRef.failure || exitText(code, stderrRef.text);
        return;
      }
      activeChild = null;
      connectedId = null;
      pendingId = null;
      persistedConnectedId = null;
      phase = "error";
      lastError = exitText(code, stderrRef.text);
      save();
      Promise.resolve()
        .then(() => clearProxy())
        .catch(() => {})
        .then(() => publish());
    });
  }

  async function failConnect(err, keepSaved) {
    await haltProcess();
    connectedId = null;
    pendingId = null;
    if (!keepSaved) persistedConnectedId = null;
    phase = "error";
    lastError = redactSecrets(err && err.message ? err.message : "Couldn't connect WireGuard");
    save();
    try { await clearProxy(); } catch {}
    publish();
    throw new Error(lastError);
  }

  async function refreshLocation(id) {
    try {
      const place = await lookupExit(lookupPartition);
      if (!place || !place.label || connectedId !== id || phase !== "connected") return;
      const entry = profiles.find((item) => item.id === id);
      if (!entry) return;
      entry.location = place.label;
      entry.countryCode = place.countryCode || null;
      save();
      publish();
    } catch {
      // Keep the filename label when the exit lookup fails.
    }
  }

  async function connectInner(id, flags = {}) {
    const keepSaved = Boolean(flags.keepSavedOnFailure);
    load();
    if (quitting) throw new Error("App is quitting");
    const entry = isId(id) ? profiles.find((item) => item.id === id) : null;
    if (!entry) return failConnect(new Error("Unknown WireGuard config"), keepSaved);
    if (!fs.existsSync(confFile(id))) {
      return failConnect(new Error("Saved WireGuard config file is missing"), keepSaved);
    }
    if (connectedId === id && activeChild && activeChild.exitCode === null && phase === "connected") {
      return snapshot();
    }

    lastError = null;
    pendingId = id;
    phase = "connecting";
    publish();

    let binary;
    try {
      binary = await resolveBinary();
    } catch (err) {
      if (connectedId && activeChild && activeChild.exitCode === null) {
        pendingId = null;
        phase = "connected";
        lastError = redactSecrets(err && err.message ? err.message : "Couldn't connect WireGuard");
        publish();
        throw new Error(lastError);
      }
      return failConnect(err, keepSaved);
    }

    await haltProcess();
    if (quitting) throw new Error("App is quitting");

    const port = await getFreePort();
    ensureDirs();
    const iniBody = buildWireproxyIni(`${id}.conf`, port);
    fs.writeFileSync(iniFile(), iniBody, { mode: 0o600 });
    chmodPrivate(iniFile());

    const stderrRef = { text: "", failure: null };
    let proc;
    try {
      proc = spawnProcess(binary, ["-c", iniFile()], {
        cwd: wireguardDir(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      return failConnect(err, keepSaved);
    }

    activeChild = proc;
    watchProcess(proc, stderrRef);

    try {
      await waitForLocalPort(port, () => {
        if (stderrRef.failure) return stderrRef.failure;
        if (proc.exitCode !== null) return exitText(proc.exitCode, stderrRef.text);
        return null;
      });
    } catch (err) {
      return failConnect(err, keepSaved);
    }

    if (quitting || proc.exitCode !== null || stderrRef.failure || activeChild !== proc) {
      const message = stderrRef.failure
        || (proc.exitCode !== null ? exitText(proc.exitCode, stderrRef.text) : "App is quitting");
      return failConnect(new Error(message), keepSaved);
    }

    try {
      await applyProxy(buildProxyConfig(port));
    } catch (err) {
      return failConnect(err, keepSaved);
    }

    if (proc.exitCode !== null || activeChild !== proc) {
      return failConnect(new Error(stderrRef.failure || exitText(proc.exitCode, stderrRef.text)), keepSaved);
    }

    connectedId = id;
    pendingId = null;
    persistedConnectedId = id;
    phase = "connected";
    lastError = null;
    save();

    const status = publish();
    void refreshLocation(id);
    return status;
  }

  function addConfigFile(filePath) {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 65536) {
      throw new Error("Config file is empty or too large");
    }
    const text = fs.readFileSync(filePath);
    if (text.includes(0)) throw new Error("Config file is not a text WireGuard config");
    const parsed = parseWireguardConf(text.toString("utf8"));
    if (!parsed.ok) throw new Error(parsed.error);
    const id = crypto.randomUUID();
    const filename = safeFilename(path.basename(filePath)) || "wireguard.conf";
    ensureDirs();
    const dest = confFile(id);
    fs.writeFileSync(dest, text, { mode: 0o600 });
    chmodPrivate(dest);
    profiles.push({
      id,
      name: displayNameFromFilename(filename),
      filename,
      endpointHost: parsed.endpointHost,
      location: null,
      countryCode: null,
    });
  }

  async function importConfigs() {
    return enqueue(async () => {
      load();
      const { dialog } = require("electron");
      const dialogOptions = {
        title: "Import WireGuard configs",
        filters: [{ name: "WireGuard config", extensions: ["conf"] }],
        properties: ["openFile", "multiSelections"],
      };
      let parent = null;
      try { parent = getDialogParent(); } catch { parent = null; }
      const result = parent && !parent.isDestroyed?.()
        ? await dialog.showOpenDialog(parent, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      if (result.canceled || !result.filePaths?.length) {
        return { success: false, canceled: true, imported: 0, error: null, status: snapshot() };
      }

      const failures = [];
      let imported = 0;
      for (const filePath of result.filePaths) {
        try {
          addConfigFile(filePath);
          imported += 1;
        } catch (err) {
          failures.push(`${safeFilename(filePath) || "config"}: ${err.message}`);
        }
      }
      if (imported) save();
      const error = failures.length ? failures.join(" ") : null;
      const status = imported ? publish() : snapshot();
      return {
        success: imported > 0,
        canceled: false,
        imported,
        error,
        status,
      };
    });
  }

  async function remove(id) {
    return enqueue(async () => {
      load();
      if (!isId(id) || !profiles.some((entry) => entry.id === id)) {
        throw new Error("Unknown WireGuard config");
      }
      if (connectedId === id || pendingId === id || persistedConnectedId === id) {
        await haltProcess();
        connectedId = null;
        pendingId = null;
        persistedConnectedId = null;
        phase = "disconnected";
        lastError = null;
        try { await clearProxy(); } catch {}
      }
      profiles = profiles.filter((entry) => entry.id !== id);
      try { fs.unlinkSync(confFile(id)); } catch {}
      save();
      return { success: true, error: null, status: publish() };
    });
  }

  function connect(id) {
    return enqueue(() => connectInner(id));
  }

  function disconnect() {
    return enqueue(async () => {
      load();
      await haltProcess();
      connectedId = null;
      pendingId = null;
      persistedConnectedId = null;
      phase = "disconnected";
      lastError = null;
      save();
      await clearProxy();
      return { success: true, error: null, status: publish() };
    });
  }

  function stopForExternalProxy() {
    return enqueue(async () => {
      load();
      await haltProcess();
      const wasActive = Boolean(connectedId || pendingId || persistedConnectedId || phase === "connecting" || phase === "connected");
      connectedId = null;
      pendingId = null;
      if (persistedConnectedId) {
        persistedConnectedId = null;
        save();
      } else if (wasActive) {
        save();
      }
      if (!wasActive) return;
      phase = "disconnected";
      lastError = null;
      publish();
    });
  }

  function restore() {
    return enqueue(async () => {
      load();
      const id = persistedConnectedId;
      if (!id) {
        publish();
        return snapshot();
      }
      try {
        return await connectInner(id, { keepSavedOnFailure: true });
      } catch {
        return snapshot();
      }
    });
  }

  function kill() {
    quitting = true;
    const proc = activeChild;
    activeChild = null;
    if (proc && proc.exitCode === null) {
      try { proc.kill("SIGKILL"); } catch {}
    }
  }

  return {
    list() {
      load();
      return snapshot();
    },
    status() {
      load();
      return snapshot();
    },
    importConfigs,
    remove,
    connect,
    disconnect,
    stopForExternalProxy,
    restore,
    kill,
  };
}

async function lookupExitLocation(partition) {
  const { session } = require("electron");
  const targetSession = session.fromPartition(partition);
  const response = await targetSession.fetch(LOOKUP_URL, {
    signal: AbortSignal.timeout(8000),
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("Location lookup failed");
  const data = await response.json();
  return formatExitLocation(data);
}

function normalizeProfile(entry) {
  if (!entry || !isId(entry.id)) return null;
  const filename = safeFilename(entry.filename);
  const endpoint = safeHost(entry.endpointHost);
  if (!filename || !endpoint) return null;
  return {
    id: entry.id,
    name: safeLabel(entry.name) || displayNameFromFilename(filename),
    filename,
    endpointHost: endpoint,
    location: safeLabel(entry.location) || null,
    countryCode: safeCountryCode(entry.countryCode),
  };
}

module.exports = {
  createWireguard,
  displayNameFromFilename,
  parseWireguardConf,
  endpointHost,
  buildWireproxyIni,
  buildSocksPac,
  buildProxyConfig,
  redactSecrets,
  extractTarGz,
  isPlausibleExecutable,
  wireproxyAssetName,
  wireproxyDownloadUrls,
  formatExitLocation,
  safeCountryCode,
};
