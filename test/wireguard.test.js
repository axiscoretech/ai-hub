const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createWireguard,
  buildBlackholePac,
  assertWireproxyArchive,
  wireproxyDownloadUrls,
  wireproxyAssetName,
} = require("../out/main/wireguard");

const SAMPLE = `[Interface]
PrivateKey = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=
Address = 10.0.0.2/32

[Peer]
PublicKey = bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb=
Endpoint = 203.0.113.10:51820
AllowedIPs = 0.0.0.0/0
`;

function xorCipher() {
  const key = 0x5a;
  return {
    available() { return true; },
    encrypt(text) {
      const body = Buffer.from(String(text), "utf8");
      for (let i = 0; i < body.length; i += 1) body[i] ^= key;
      return body;
    },
    decrypt(buffer) {
      const body = Buffer.from(buffer);
      for (let i = 0; i < body.length; i += 1) body[i] ^= key;
      return body.toString("utf8");
    },
  };
}

function fakeBinary(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "wireproxy");
  const body = Buffer.alloc(128);
  body.writeUInt32BE(0xFEEDFACF, 0);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return dir;
}

function makeApi(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-hub-wg-"));
  const calls = { apply: 0, clear: 0, dropped: 0 };
  const api = createWireguard({
    getUserDataPath: () => dir,
    applyProxy: async () => { calls.apply += 1; },
    clearProxy: async () => { calls.clear += 1; },
    applyDroppedProxy: async () => { calls.dropped += 1; },
    cipher: extra.cipher || xorCipher(),
    lookupExitLocation: async () => null,
    platform: "darwin",
    arch: "arm64",
    envPath: extra.envPath || "",
    spawn: extra.spawn,
    getFreePort: extra.getFreePort,
    waitForLocalPort: extra.waitForLocalPort,
  });
  return {
    dir,
    api,
    calls,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("imported configs are stored encrypted", async () => {
  const ctx = makeApi();
  try {
    const saved = await ctx.api.addConfigText("home.conf", SAMPLE);
    assert.equal(saved.success, true);
    const folder = path.join(ctx.dir, "wireguard");
    const names = fs.readdirSync(folder);
    assert.equal(names.some((name) => name.endsWith(".conf")), false);
    const encName = names.find((name) => name.endsWith(".conf.enc"));
    assert.ok(encName);
    const stored = fs.readFileSync(path.join(folder, encName));
    assert.equal(stored.includes(Buffer.from("PrivateKey")), false);
    assert.equal(stored.includes(Buffer.from("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=")), false);
  } finally {
    ctx.cleanup();
  }
});

test("plaintext configs are encrypted on load and run files are removed", () => {
  const ctx = makeApi();
  try {
    const id = crypto.randomUUID();
    const folder = path.join(ctx.dir, "wireguard");
    fs.mkdirSync(folder, { mode: 0o700 });
    fs.writeFileSync(path.join(folder, `${id}.conf`), SAMPLE, { mode: 0o600 });
    fs.writeFileSync(path.join(folder, `run-${id}.conf`), SAMPLE, { mode: 0o600 });
    fs.writeFileSync(path.join(folder, "profiles.json"), JSON.stringify({
      configs: [{
        id,
        name: "Home",
        filename: "home.conf",
        endpointHost: "203.0.113.10",
      }],
      connectedId: id,
    }));
    const status = ctx.api.list();
    assert.equal(status.savedId, id);
    assert.equal(fs.existsSync(path.join(folder, `${id}.conf`)), false);
    assert.equal(fs.existsSync(path.join(folder, `run-${id}.conf`)), false);
    const stored = fs.readFileSync(path.join(folder, `${id}.conf.enc`));
    assert.equal(stored.includes(Buffer.from("PrivateKey")), false);
  } finally {
    ctx.cleanup();
  }
});

test("import is refused when encryption is unavailable", async () => {
  const ctx = makeApi({
    cipher: {
      available() { return false; },
      encrypt() { throw new Error("no"); },
      decrypt() { throw new Error("no"); },
    },
  });
  try {
    await assert.rejects(
      () => ctx.api.addConfigText("home.conf", SAMPLE),
      /Encryption is not available/,
    );
    const folder = path.join(ctx.dir, "wireguard");
    if (fs.existsSync(folder)) {
      const names = fs.readdirSync(folder);
      assert.equal(names.some((name) => name.endsWith(".conf") || name.endsWith(".conf.enc")), false);
    }
  } finally {
    ctx.cleanup();
  }
});

test("a dead wireproxy blackholes the proxy and deletes the run file", async () => {
  const bin = fakeBinary(path.join(os.tmpdir(), `ai-hub-wp-${process.pid}`));
  let proc = null;
  const ctx = makeApi({
    envPath: bin,
    spawn() {
      proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.exitCode = null;
      proc.kill = () => {
        if (proc.exitCode !== null) return;
        proc.exitCode = 0;
        proc.emit("exit", 0);
      };
      return proc;
    },
    getFreePort: async () => 9,
    waitForLocalPort: async () => {},
  });
  try {
    const saved = await ctx.api.addConfigText("home.conf", SAMPLE);
    const status = await ctx.api.connect(saved.id);
    assert.equal(status.phase, "connected");
    const runFile = path.join(ctx.dir, "wireguard", `run-${saved.id}.conf`);
    assert.equal(fs.existsSync(runFile), true);
    assert.match(fs.readFileSync(runFile, "utf8"), /PrivateKey/);
    proc.exitCode = 1;
    proc.emit("exit", 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const dropped = ctx.api.status();
    assert.equal(dropped.phase, "dropped");
    assert.equal(dropped.savedId, saved.id);
    assert.equal(dropped.connectedId, null);
    assert.equal(ctx.calls.dropped, 1);
    assert.equal(ctx.calls.clear, 0);
    assert.equal(fs.existsSync(runFile), false);
    const gone = await ctx.api.disconnect();
    assert.equal(gone.status.phase, "disconnected");
    assert.equal(gone.status.savedId, null);
    assert.equal(ctx.calls.clear, 1);
  } finally {
    ctx.cleanup();
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("wireproxy downloads are pinned and hash-checked", () => {
  const urls = wireproxyDownloadUrls("darwin", "arm64");
  assert.equal(urls.length, 2);
  assert.equal(urls.every((url) => url.includes("/download/v1.1.3/")), true);
  assert.equal(urls.some((url) => url.includes("/latest/")), false);
  assert.equal(wireproxyAssetName("linux", "x64"), "wireproxy_linux_amd64.tar.gz");
  assert.equal(wireproxyAssetName("linux", "arm64"), "wireproxy_linux_arm64.tar.gz");
  assert.throws(
    () => assertWireproxyArchive("wireproxy_darwin_arm64.tar.gz", Buffer.from("not-the-archive")),
    /hash did not match/,
  );
  const pac = buildBlackholePac();
  assert.match(pac, /SOCKS5 127\.0\.0\.1:1/);
  assert.doesNotMatch(pac, /return 'DIRECT';\s*\}$/);
});
