const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { _electron: electron } = require("playwright");

// Records a short README demo from a profile that is already signed in.
// Pass that profile as the first argument. Frames stay in a temp directory
// unless AI_HUB_DEMO_OUT is set.
const userData = process.argv[2];
if (!userData) {
  console.error("Usage: node scripts/capture-demo.js <userData dir>");
  process.exit(1);
}

const HOSTS = {
  ChatGPT: ["chatgpt.com", "chat.openai.com"],
  Claude: ["claude.ai"],
  Gemini: ["gemini.google.com"],
  DeepSeek: ["chat.deepseek.com", "deepseek.com"],
  Grok: ["grok.com"],
  Perplexity: ["perplexity.ai"],
  Mistral: ["chat.mistral.ai", "mistral.ai"],
  Qwen: ["chat.qwen.ai", "qwen.ai"],
  Kimi: ["kimi.com", "kimi.ai"],
};

const ORDER = ["ChatGPT", "Claude", "Gemini", "DeepSeek", "Grok", "Perplexity", "Mistral", "Qwen", "Kimi"];

function matches(name, host) {
  return (HOSTS[name] || []).some((item) => host === item || host.endsWith(`.${item}`));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listContents(app) {
  return app.evaluate(({ webContents }) => (
    webContents.getAllWebContents().filter((item) => !item.isDestroyed()).map((item) => {
      let host = "";
      let shell = false;
      try {
        const url = new URL(item.getURL());
        host = url.host;
        shell = url.pathname.endsWith("/index.html");
      } catch {}
      return { id: item.id, host, shell, loading: item.isLoading() };
    })
  ));
}

async function probe(app, id) {
  return app.evaluate(async ({ webContents }, targetId) => {
    const contents = webContents.fromId(targetId);
    if (!contents || contents.isDestroyed()) return null;
    const page = await contents.executeJavaScript(`(() => {
      const text = ((document.body && document.body.innerText) || "").slice(0, 5000).toLowerCase();
      const signedInHint = text.includes("new chat") || text.includes("new conversation");
      const loggedOut = !signedInHint && (
        text.includes("sign up for free")
        || (text.includes("log in") && text.includes("sign up"))
      );
      return { host: location.host, ready: document.readyState, loggedOut };
    })()`);
    return { loading: contents.isLoading(), ...page };
  }, id);
}

async function captureContents(app, id, file) {
  const encoded = await app.evaluate(async ({ webContents }, targetId) => {
    const contents = webContents.fromId(targetId);
    const image = await contents.capturePage();
    return image.toPNG().toString("base64");
  }, id);
  fs.writeFileSync(file, Buffer.from(encoded, "base64"));
}

function shellId(contents) {
  const shell = contents.find((item) => item.shell);
  return shell ? shell.id : null;
}

async function waitForGuest(app, name, timeoutMs) {
  const started = Date.now();
  let last = null;
  let lastId = null;
  while (Date.now() - started < timeoutMs) {
    const contents = await listContents(app);
    const hits = contents.filter((item) => matches(name, item.host));
    if (hits.length) {
      lastId = hits[hits.length - 1].id;
      last = await probe(app, lastId);
      if (last && !last.loading && last.ready === "complete") return { id: lastId, ...last };
    }
    await sleep(350);
  }
  return last ? { id: lastId, ...last } : null;
}

function composite(shellFile, guestFile, outFile) {
  const script = `
from PIL import Image
import sys
shell = Image.open(sys.argv[1]).convert("RGBA")
guest = Image.open(sys.argv[2]).convert("RGBA")
if guest.width != shell.width and guest.width:
    height = max(1, round(guest.height * (shell.width / guest.width)))
    guest = guest.resize((shell.width, height), Image.Resampling.LANCZOS)
y = max(0, shell.height - guest.height)
if y + guest.height > shell.height:
    guest = guest.crop((0, guest.height - (shell.height - y), guest.width, guest.height))
frame = shell.copy()
frame.paste(guest, (0, y), guest)
frame.save(sys.argv[3])
`;
  execFileSync("python3", ["-c", script, shellFile, guestFile, outFile], { stdio: "inherit" });
}

async function main() {
  const framesDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-hub-demo-"));
  const out = process.env.AI_HUB_DEMO_OUT || path.join(framesDir, "demo.gif");
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, AI_HUB_USER_DATA: userData },
  });
  const shots = [];
  try {
    const window = await app.firstWindow();
    await window.waitForSelector('.tab[data-name="ChatGPT"]', { timeout: 20000 });
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
      if (win) win.setBounds({ x: 80, y: 60, width: 1180, height: 740 });
    });
    await window.evaluate(() => {
      if (typeof applyTheme === "function") applyTheme("dark");
      if (typeof closeVpnPanel === "function") closeVpnPanel();
    });
    await sleep(400);

    const signedIn = [];
    for (const name of ORDER) {
      const exists = await window.locator(`.tab[data-name="${name}"]`).count();
      if (!exists) continue;
      await window.evaluate((tab) => switchTab(tab), name);
      const guest = await waitForGuest(app, name, 22000);
      const loggedOut = !guest || guest.loggedOut;
      console.log(`${name} ${loggedOut ? "logged-out" : "signed-in"} ${guest ? guest.host : "no-page"}`);
      if (!loggedOut) signedIn.push(name);
      if (signedIn.length >= 4) break;
    }
    if (signedIn.length < 2) throw new Error("Need at least two signed-in services for the demo");

    // AI_HUB_DEMO_FLAGS="PL|Warsaw, Poland>NL|Amsterdam, Netherlands"
    // paints the toolbar flag. Leave it unset to keep whatever the profile shows.
    const flagSteps = String(process.env.AI_HUB_DEMO_FLAGS || "").split(">").map((part) => {
      const [code, label] = part.split("|");
      if (!/^[A-Z]{2}$/.test(code || "")) return null;
      return [label || "WireGuard", code];
    }).filter(Boolean);
    if (flagSteps[0]) {
      await window.evaluate((place) => setProxyStatus(true, place[0], place[1]), flagSteps[0]);
      await sleep(200);
    }

    const sequence = [
      ...signedIn.map((name, index) => ({ name, seconds: index === 0 ? 1.3 : 0.9 })),
      { name: signedIn[0], seconds: 0.9 },
    ];
    if (flagSteps[1]) {
      sequence.push({ name: signedIn[0], seconds: 1.7, country: flagSteps[1] });
    }

    let index = 0;
    for (const step of sequence) {
      if (step.country) {
        await window.evaluate((place) => setProxyStatus(true, place[0], place[1]), step.country);
        await sleep(180);
      }
      await window.evaluate((tab) => switchTab(tab), step.name);
      await sleep(280);
      const contents = await listContents(app);
      const shell = shellId(contents);
      const guestHit = contents.filter((item) => matches(step.name, item.host)).pop();
      if (!shell || !guestHit) throw new Error(`Missing page for ${step.name}`);
      const shellFile = path.join(framesDir, `shell-${index}.png`);
      const guestFile = path.join(framesDir, `guest-${index}.png`);
      const frameFile = path.join(framesDir, `frame-${String(index).padStart(2, "0")}.png`);
      await captureContents(app, shell, shellFile);
      await captureContents(app, guestHit.id, guestFile);
      composite(shellFile, guestFile, frameFile);
      shots.push({ file: frameFile, seconds: step.seconds });
      index += 1;
    }

    const listFile = path.join(framesDir, "frames.txt");
    const lines = [];
    for (const shot of shots) {
      lines.push(`file '${shot.file}'`);
      lines.push(`duration ${shot.seconds}`);
    }
    lines.push(`file '${shots[shots.length - 1].file}'`);
    fs.writeFileSync(listFile, lines.join("\n"));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    execFileSync("ffmpeg", [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listFile,
      "-vf", "scale=1000:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4",
      "-loop", "0",
      out,
    ], { stdio: "inherit" });
    console.log(`gif ${out}`);
    console.log(`frames ${framesDir}`);
  } finally {
    await app.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
