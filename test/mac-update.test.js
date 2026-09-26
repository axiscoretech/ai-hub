const test = require("node:test");
const assert = require("node:assert/strict");
const { macUpdateScript } = require("../out/main/mac-update");

test("the unsigned Mac update waits for this process, then replaces the app", () => {
  const script = macUpdateScript({
    pid: 42,
    zipPath: "/tmp/AI-Hub-1.5.0-mac.zip",
    appPath: "/Applications/AI Hub.app",
    scriptPath: "/tmp/ai-hub-update.sh",
  });
  assert.match(script, /while kill -0 42/);
  assert.match(script, /ditto -x -k '\/tmp\/AI-Hub-1\.5\.0-mac\.zip'/);
  assert.match(script, /ditto "\$app" '\/Applications\/AI Hub\.app'/);
  assert.match(script, /xattr -cr '\/Applications\/AI Hub\.app'/);
  assert.match(script, /open '\/Applications\/AI Hub\.app'/);
  assert.doesNotThrow(() => macUpdateScript({
    pid: 1,
    zipPath: "/tmp/it's fine.zip",
    appPath: "/Applications/AI Hub.app",
  }));
  assert.throws(() => macUpdateScript({
    pid: 1,
    zipPath: "/tmp/update.zip\nrm -rf /",
    appPath: "/Applications/AI Hub.app",
  }));
});
