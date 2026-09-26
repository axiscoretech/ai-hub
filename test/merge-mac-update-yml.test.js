const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeUpdateYml } = require("../scripts/merge-mac-update-yml");

test("Intel and Apple Silicon stay in one Mac update feed", () => {
  const x64 = [
    "version: 1.6.0",
    "files:",
    "  - url: AI-Hub-1.6.0-mac.zip",
    "    sha512: aaa",
    "    size: 10",
    "path: AI-Hub-1.6.0-mac.zip",
    "sha512: aaa",
    "releaseDate: '2026-09-26T12:43:34.093Z'",
    "",
  ].join("\n");
  const arm = [
    "version: 1.6.0",
    "files:",
    "  - url: AI-Hub-1.6.0-arm64-mac.zip",
    "    sha512: bbb",
    "    size: 20",
    "path: AI-Hub-1.6.0-arm64-mac.zip",
    "sha512: bbb",
    "releaseDate: '2026-09-26T12:43:34.093Z'",
    "",
  ].join("\n");
  const merged = mergeUpdateYml([x64, arm]);
  assert.match(merged, /url: AI-Hub-1\.6\.0-mac\.zip/);
  assert.match(merged, /url: AI-Hub-1\.6\.0-arm64-mac\.zip/);
  assert.match(merged, /^path: AI-Hub-1\.6\.0-mac\.zip$/m);
});
