const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { _electron: electron } = require("playwright");

// The page itself is a separate view and is not in this window screenshot,
// so the old clip was only the toolbar plus an empty loading band.
// The README uses assets/screenshot.png instead.
async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "ai-hub-gif-"));
  const frames = fs.mkdtempSync(path.join(os.tmpdir(), "ai-hub-frames-"));
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, AI_HUB_USER_DATA: userData, AI_HUB_TEST: "1" },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".tab", { timeout: 15000 });
    const names = ["ChatGPT", "Claude", "Gemini", "DeepSeek", "ChatGPT"];
    let index = 0;
    for (const name of names) {
      await page.locator(`.tab[data-name="${name}"]`).click();
      await page.waitForTimeout(400);
      for (let hold = 0; hold < 4; hold += 1) {
        const file = path.join(frames, `frame-${String(index).padStart(2, "0")}.png`);
        await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 1100, height: 220 } });
        index += 1;
        await page.waitForTimeout(100);
      }
    }
    const out = path.join(__dirname, "..", "assets", "tab-switch.gif");
    execFileSync("ffmpeg", [
      "-y",
      "-framerate", "2",
      "-i", path.join(frames, "frame-%02d.png"),
      "-vf", "fps=2,scale=880:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
      out,
    ], { stdio: "inherit" });
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(frames, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
