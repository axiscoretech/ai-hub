const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");

// Talk to the openclaw CLI only. Do not read or write ~/.openclaw state.
const DEFAULT_PORT = 18789;
const DEFAULT_OPENCLAW_URL = "http://127.0.0.1:18789/";
const INSTALL_URL = "https://openclaw.ai/install.sh";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const controlPorts = new Set([DEFAULT_PORT]);
let chain = Promise.resolve();

function enqueue(task) {
  const run = chain.then(task, task);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

function isLoopbackHost(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");
  return LOOPBACK_HOSTS.has(host);
}

function notePort(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) return false;
  controlPorts.add(value);
  return true;
}

function parseLoopbackHttp(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!isLoopbackHost(parsed.hostname)) return null;
  if (!parsed.port) return null;
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return parsed;
}

function isOpenClawControlUrl(url) {
  const parsed = parseLoopbackHttp(url);
  return Boolean(parsed && controlPorts.has(Number(parsed.port)));
}

function toPublicUrl(url) {
  const parsed = parseLoopbackHttp(url);
  if (!parsed) return DEFAULT_OPENCLAW_URL;
  parsed.hash = "";
  parsed.search = "";
  parsed.username = "";
  parsed.password = "";
  const pathName = parsed.pathname || "/";
  return parsed.origin + (pathName === "/" ? "/" : pathName);
}

function controlUrlWithToken(cleanUrl, token) {
  const parsed = parseLoopbackHttp(cleanUrl);
  const secret = typeof token === "string" ? token.trim().replace(/^["']|["']$/g, "") : "";
  if (!parsed || !secret || /\s/.test(secret) || secret === "null" || secret === "undefined") return null;
  notePort(parsed.port);
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = `token=${encodeURIComponent(secret)}`;
  return parsed.href;
}

function redact(text) {
  return String(text || "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/(https?:\/\/[^\s"'<>]+)#\S+/g, "$1")
    .replace(/([?&](?:token|password|secret|bootstrapToken)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/((?:token|password|secret|bootstrap)[=:]\s*)(\S+)/gi, "$1[redacted]")
    .trim()
    .slice(-4000);
}

function parseJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // CLI logs can precede the JSON object.
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function candidateDirs() {
  const home = os.homedir();
  const fromPath = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extras = [
    path.join(home, ".local", "bin"),
    path.join(home, ".openclaw", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
  const seen = new Set();
  const dirs = [];
  for (const dir of [...fromPath, ...extras]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs;
}

function isExecutable(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size <= 0) return false;
    if (process.platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOpenclaw() {
  const names = process.platform === "win32"
    ? ["openclaw.cmd", "openclaw.exe", "openclaw"]
    : ["openclaw"];
  for (const dir of candidateDirs()) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function runOpenclaw(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;
    const env = {
      ...process.env,
      // Embedding docs: never let a Gateway child treat Electron as Node.
      OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
    };
    for (const key of Object.keys(env)) {
      if (key.startsWith("ELECTRON_") || key === "ATOM_SHELL_INTERNAL_RUN_AS_NODE") delete env[key];
    }
    try {
      child = spawn(bin, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: err.message || "Could not start openclaw", timedOut: false });
      return;
    }

    const cap = (current, chunk) => (current + chunk.toString("utf8")).slice(-16000);
    child.stdout.on("data", (chunk) => { stdout = cap(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = cap(stderr, chunk); });

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };

    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      finish({
        code: null,
        stdout,
        stderr: `${stderr}\nTimed out waiting for openclaw ${args.join(" ")}`.trim(),
        timedOut: true,
      });
    }, timeoutMs);

    child.once("error", (err) => {
      finish({ code: null, stdout, stderr: err.message || "openclaw failed", timedOut: false });
    });
    child.once("close", (code) => {
      finish({ code, stdout, stderr, timedOut: false });
    });
  });
}

function probeControlUrl(url) {
  const parsed = parseLoopbackHttp(url);
  if (!parsed) return Promise.resolve(false);
  const lib = parsed.protocol === "https:" ? https : http;
  let hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (hostname === "localhost") hostname = "127.0.0.1";
  const options = {
    method: "GET",
    hostname,
    port: Number(parsed.port),
    path: parsed.pathname || "/",
    timeout: 2500,
    headers: { Accept: "text/html", "User-Agent": "ai-hub" },
  };
  if (parsed.protocol === "https:") options.rejectUnauthorized = false;
  return new Promise((resolve) => {
    const req = lib.request(options, (res) => {
      res.resume();
      const code = res.statusCode || 0;
      resolve(code >= 100 && code < 600);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function rememberPortsFromStatus(data) {
  if (!data || typeof data !== "object") return;
  notePort(data.gateway && data.gateway.port);
  notePort(data.port && data.port.port);
  const links = data.gateway && data.gateway.controlUiLinks;
  if (links && typeof links.httpUrl === "string") rememberControlUrl(links.httpUrl);
}

function controlUrlFromStatus(data) {
  const links = data && data.gateway && data.gateway.controlUiLinks;
  if (links && typeof links.httpUrl === "string") {
    const clean = rememberControlUrl(links.httpUrl);
    if (clean) return clean;
  }
  const port = Number((data && data.gateway && data.gateway.port) || (data && data.port && data.port.port));
  if (!notePort(port)) return DEFAULT_OPENCLAW_URL;
  const wsUrl = links && typeof links.wsUrl === "string" ? links.wsUrl : "";
  const protocol = wsUrl.startsWith("wss:") ? "https:" : "http:";
  return `${protocol}//127.0.0.1:${port}/`;
}

function serviceInstalled(data) {
  const service = data && data.service;
  if (!service || typeof service !== "object") return false;
  if (service.loaded === true || service.installed === true) return true;
  const source = service.command && service.command.sourcePath;
  if (typeof source === "string" && source.trim()) return true;
  const runtime = String((service.runtime && (service.runtime.status || service.runtime.state)) || "").toLowerCase();
  return runtime === "running" || runtime === "active" || runtime === "stopped" || runtime === "inactive";
}

function emptyStatus(overrides) {
  return {
    installed: false,
    serviceInstalled: false,
    gatewayUp: false,
    phase: "not-installed",
    url: DEFAULT_OPENCLAW_URL,
    port: DEFAULT_PORT,
    error: null,
    ...overrides,
  };
}

async function collectStatus(bin) {
  if (!bin) return emptyStatus();

  let result = await runOpenclaw(bin, ["gateway", "status", "--json", "--no-probe", "--timeout", "5000"], 20000);
  const unrecognized = /does not recognize option ["']--no-probe["']|unknown option ['"]?--no-probe/i
    .test(`${result.stderr}\n${result.stdout}`);
  if (unrecognized) {
    result = await runOpenclaw(bin, ["gateway", "status", "--json", "--timeout", "8000"], 20000);
  }

  const data = parseJsonObject(result.stdout) || parseJsonObject(result.stderr);
  rememberPortsFromStatus(data);
  const url = data ? controlUrlFromStatus(data) : DEFAULT_OPENCLAW_URL;
  const gatewayUp = await probeControlUrl(url);
  const installedService = serviceInstalled(data);
  let port = DEFAULT_PORT;
  try { port = Number(new URL(url).port) || DEFAULT_PORT; } catch {}

  let failure = null;
  if (!gatewayUp) {
    const stderr = redact(result.stderr);
    const stdout = data ? "" : redact(result.stdout);
    failure = stderr || stdout || null;
  }

  return {
    installed: true,
    serviceInstalled: installedService,
    gatewayUp,
    phase: gatewayUp ? "running" : "stopped",
    url,
    port,
    error: failure || null,
  };
}

function probeGateway(url) {
  return probeControlUrl(url || DEFAULT_OPENCLAW_URL);
}

function inspectOpenClaw() {
  return enqueue(async () => collectStatus(findOpenclaw()));
}

function openClawUpdateStatus() {
  return enqueue(async () => {
    const bin = findOpenclaw();
    if (!bin) return { available: false, version: "" };
    const result = await runOpenclaw(bin, ["update", "status", "--json", "--timeout", "20"], 25000);
    const data = parseJsonObject(result.stdout);
    const availability = data && data.availability;
    return {
      available: Boolean(availability && availability.available),
      version: availability && availability.latestVersion ? String(availability.latestVersion) : "",
    };
  });
}

function updateOpenClaw() {
  return enqueue(async () => {
    const bin = findOpenclaw();
    if (!bin) return { success: false, error: "OpenClaw is not installed." };
    const result = await runOpenclaw(bin, ["update", "--yes", "--json", "--timeout", "600"], 620000);
    const data = parseJsonObject(result.stdout);
    if (result.code !== 0 || (data && data.ok === false)) {
      return { success: false, error: "OpenClaw could not be updated." };
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await probeControlUrl(DEFAULT_OPENCLAW_URL)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { success: true, error: null };
  });
}

function downloadInstaller(url, dest, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { "User-Agent": "AI-Hub" } }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error("redirect"));
          return;
        }
        downloadInstaller(new URL(response.headers.location, url).href, dest, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error("status"));
        return;
      }
      const file = fs.createWriteStream(dest, { mode: 0o600 });
      response.pipe(file);
      file.on("error", reject);
      file.on("finish", () => file.close(() => resolve()));
    });
    request.on("error", reject);
  });
}

function installOpenClaw() {
  return enqueue(async () => {
    if (findOpenclaw()) return { success: true, error: null };
    const dest = path.join(os.tmpdir(), `ai-hub-openclaw-install-${process.pid}.sh`);
    try {
      await downloadInstaller(INSTALL_URL, dest, 3);
      const result = await runOpenclaw("/bin/bash", [dest], 600000);
      if (result.code !== 0 || !findOpenclaw()) {
        return { success: false, error: "OpenClaw could not be installed." };
      }
      return { success: true, error: null };
    } catch {
      return { success: false, error: "OpenClaw could not be installed." };
    } finally {
      fs.unlink(dest, () => {});
    }
  });
}

function startOpenClawGateway() {
  return enqueue(async () => {
    const bin = findOpenclaw();
    if (!bin) {
      return { status: emptyStatus(), error: null, log: "" };
    }

    const before = await collectStatus(bin);
    if (before.gatewayUp) {
      return { status: before, error: null, log: "" };
    }

    const args = before.serviceInstalled ? ["gateway", "start"] : ["gateway", "install"];
    const started = await runOpenclaw(bin, args, 90000);
    const startedText = `${started.stdout}\n${started.stderr}`;

    if (args[1] === "start" && started.code !== 0 && /gateway install|not installed|no managed service/i.test(startedText)) {
      await runOpenclaw(bin, ["gateway", "install"], 90000);
    }

    const url = before.url || DEFAULT_OPENCLAW_URL;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (await probeControlUrl(url)) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    const status = await collectStatus(bin);
    status.error = status.gatewayUp ? null : "OpenClaw did not start.";
    return {
      status,
      error: status.error,
      log: "",
    };
  });
}

function unrecognizedJsonFlag(result) {
  return /does not recognize option ["']--json["']|unknown option ['"]?--json/i
    .test(`${result.stderr}\n${result.stdout}`);
}

function firstHttpUrl(text) {
  const match = String(text || "").match(/https?:\/\/[^\s"'<>]+/);
  return match ? match[0].replace(/[),.;]+$/, "") : "";
}

function clipboardApi() {
  try {
    return require("electron").clipboard;
  } catch {
    return null;
  }
}

function rememberControlUrl(url) {
  const parsed = parseLoopbackHttp(url);
  if (!parsed) return null;
  notePort(parsed.port);
  return toPublicUrl(parsed.href);
}

function readPasteboard() {
  // OpenClaw copies with the system pasteboard (pbcopy). Electron's clipboard
  // often still has the previous value, so the first read must come from pbpaste.
  if (process.platform === "darwin") {
    try {
      return require("child_process").execFileSync("pbpaste", { encoding: "utf8", timeout: 2000 });
    } catch {}
  }
  const clipboard = clipboardApi();
  try { return clipboard ? String(clipboard.readText() || "") : ""; } catch { return ""; }
}

function readClipboard() {
  return readPasteboard();
}

function waitForTokenPaste(previous) {
  return new Promise((resolve) => {
    let left = 15;
    const tick = () => {
      const pasted = readPasteboard();
      if (pasted && pasted !== previous && pasted.includes("#token=")) {
        resolve(pasted);
        return;
      }
      left -= 1;
      if (left <= 0) {
        resolve(pasted);
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

function writeClipboard(text) {
  const clipboard = clipboardApi();
  try { if (clipboard) clipboard.writeText(text); } catch {}
  if (process.platform === "darwin") {
    try { require("child_process").execFileSync("pbcopy", { input: text }); } catch {}
  }
}

async function dashboardFromNoOpen(bin) {
  const previous = readPasteboard();
  const result = await runOpenclaw(bin, ["dashboard", "--no-open"], 35000);
  const pasted = await waitForTokenPaste(previous);
  if (previous !== pasted) writeClipboard(previous);

  if (result.code !== 0) {
    return {
      url: null,
      cleanUrl: null,
      error: redact(result.stderr || result.stdout || "openclaw dashboard --no-open failed"),
    };
  }

  const printed = firstHttpUrl(result.stdout);
  const announced = /copied to clipboard|token-authenticated url/i.test(`${result.stdout}\n${result.stderr}`);
  const pastedUrl = firstHttpUrl(pasted);
  const pastedTokenUrl = pastedUrl && pastedUrl.includes("#token=") && isOpenClawControlUrl(pastedUrl) ? pastedUrl : "";
  const clipUrl = pastedTokenUrl && (announced || pasted !== previous) ? pastedTokenUrl : "";
  const candidate = clipUrl || printed;
  const clean = candidate ? rememberControlUrl(candidate) : null;
  if (!candidate || !clean || !isOpenClawControlUrl(candidate)) {
    return {
      url: null,
      cleanUrl: null,
      error: "OpenClaw did not return a local dashboard URL.",
    };
  }

  return {
    url: clipUrl || candidate,
    cleanUrl: clean,
    error: clipUrl ? null : "Opened the dashboard without a one-time pairing link. Try Open dashboard again.",
  };
}

async function dashboardTarget(bin) {
  const copied = await dashboardFromNoOpen(bin);
  if (copied && copied.url && copied.url.includes("#token=") && isOpenClawControlUrl(copied.url)) {
    return { ...copied, authed: true };
  }

  const status = await collectStatus(bin);
  const clean = status && status.url ? status.url : DEFAULT_OPENCLAW_URL;
  return {
    url: null,
    cleanUrl: clean,
    authed: false,
    error: "OpenClaw did not give this window a way to open its page.",
  };
}

function openClawDashboard() {
  return enqueue(async () => {
    const bin = findOpenclaw();
    if (!bin) {
      return { url: null, cleanUrl: DEFAULT_OPENCLAW_URL, error: "OpenClaw is not installed." };
    }
    return dashboardTarget(bin);
  });
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_OPENCLAW_URL,
  probeGateway,
  findOpenclaw,
  inspectOpenClaw,
  startOpenClawGateway,
  openClawDashboard,
  openClawUpdateStatus,
  updateOpenClaw,
  installOpenClaw,
  isOpenClawControlUrl,
  notePort,
  rememberControlUrl,
  controlUrlWithToken,
  toPublicUrl,
};
