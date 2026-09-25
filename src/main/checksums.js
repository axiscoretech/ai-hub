const path = require("path");

function checksumFor(sumsText, fileName) {
  const base = path.basename(String(fileName || ""));
  if (!base || base === "." || base === "..") return "";
  for (const line of String(sumsText || "").split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(\S+)$/i.exec(line.trim());
    if (!match) continue;
    if (path.basename(match[2]) === base) return match[1].toLowerCase();
  }
  return "";
}

module.exports = { checksumFor };
