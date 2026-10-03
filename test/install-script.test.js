const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const installSh = path.join(__dirname, "..", "install.sh");

function printZipUrl(arch, json) {
  return execFileSync("bash", [installSh, "--print-zip-url", arch], {
    encoding: "utf8",
    input: json,
  }).trim();
}

const fixture = JSON.stringify({
  assets: [
    {
      name: "AI-Hub-1.42.0-mac.zip",
      browser_download_url:
        "https://github.com/axiscoretech/ai-hub/releases/download/v1.42.0/AI-Hub-1.42.0-mac.zip",
    },
    {
      name: "AI-Hub-1.42.0-mac.zip.blockmap",
      browser_download_url:
        "https://github.com/axiscoretech/ai-hub/releases/download/v1.42.0/AI-Hub-1.42.0-mac.zip.blockmap",
    },
    {
      name: "AI-Hub-1.42.0-arm64-mac.zip",
      browser_download_url:
        "https://github.com/axiscoretech/ai-hub/releases/download/v1.42.0/AI-Hub-1.42.0-arm64-mac.zip",
    },
    {
      name: "AI-Hub-1.42.0-arm64-mac.zip.blockmap",
      browser_download_url:
        "https://github.com/axiscoretech/ai-hub/releases/download/v1.42.0/AI-Hub-1.42.0-arm64-mac.zip.blockmap",
    },
  ],
});

test("the installer does not call python3, git, or clang", () => {
  const script = fs.readFileSync(installSh, "utf8");
  const commands = script.replace(/^[ \t]*#.*$/gm, "");
  assert.doesNotMatch(commands, /\bpython3\b/);
  assert.doesNotMatch(commands, /\bgit\b/);
  assert.doesNotMatch(commands, /\bclang\b/);
});

test("the installer picks the Intel zip from a GitHub release", () => {
  assert.equal(
    printZipUrl("x64", fixture),
    "https://github.com/axiscoretech/ai-hub/releases/download/v1.42.0/AI-Hub-1.42.0-mac.zip",
  );
});

test("the installer picks the Apple Silicon zip from a GitHub release", () => {
  assert.equal(
    printZipUrl("arm64", fixture),
    "https://github.com/axiscoretech/ai-hub/releases/download/v1.42.0/AI-Hub-1.42.0-arm64-mac.zip",
  );
});

test("the installer fails when the release has no matching zip", () => {
  assert.throws(
    () => printZipUrl("arm64", JSON.stringify({ assets: [] })),
    /no macOS build/,
  );
});

test("blockmap files are not treated as the app zip", () => {
  assert.throws(
    () =>
      printZipUrl(
        "arm64",
        JSON.stringify({
          assets: [
            {
              name: "AI-Hub-1.42.0-arm64-mac.zip.blockmap",
              browser_download_url:
                "https://github.com/axiscoretech/ai-hub/releases/download/v1.42.0/AI-Hub-1.42.0-arm64-mac.zip.blockmap",
            },
          ],
        }),
      ),
    /no macOS build/,
  );
});
