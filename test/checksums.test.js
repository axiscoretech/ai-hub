const test = require("node:test");
const assert = require("node:assert/strict");
const { checksumFor } = require("../out/main/checksums");

test("a release checksum matches the downloaded file name", () => {
  const sums = [
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  AI-Hub-1.4.0.dmg",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  AI-Hub-1.4.0-mac.zip",
  ].join("\n");
  assert.equal(checksumFor(sums, "/tmp/AI-Hub-1.4.0-mac.zip"), "b".repeat(64));
  assert.equal(checksumFor(sums, "missing.dmg"), "");
  assert.equal(checksumFor("not a checksum", "AI-Hub-1.4.0.dmg"), "");
});
