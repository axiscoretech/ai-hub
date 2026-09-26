function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function macUpdateScript({ pid, zipPath, appPath, scriptPath }) {
  const processId = Number(pid);
  if (!Number.isInteger(processId) || processId <= 0) throw new Error("Invalid process");
  for (const filePath of [zipPath, appPath, scriptPath].filter(Boolean)) {
    if (typeof filePath !== "string" || !filePath.startsWith("/") || /[\r\n]/.test(filePath)) {
      throw new Error("Invalid update path");
    }
  }
  if (!appPath.endsWith(".app")) throw new Error("Invalid app path");
  return [
    "#!/bin/bash",
    "set -euo pipefail",
    `while kill -0 ${processId} 2>/dev/null; do sleep 0.2; done`,
    "tmp=$(mktemp -d)",
    `ditto -x -k ${shellQuote(zipPath)} "$tmp"`,
    'app=$(find "$tmp" -maxdepth 3 -name "*.app" -print -quit)',
    'test -n "$app"',
    `rm -rf ${shellQuote(appPath)}`,
    `ditto "$app" ${shellQuote(appPath)}`,
    `xattr -cr ${shellQuote(appPath)}`,
    `open ${shellQuote(appPath)}`,
    'rm -rf "$tmp"',
    scriptPath ? `rm -f ${shellQuote(scriptPath)}` : "",
    "",
  ].filter(Boolean).join("\n");
}

module.exports = { macUpdateScript };
