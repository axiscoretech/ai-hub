const fs = require("fs");

function parseUpdateYml(text) {
  const version = (/^version:\s*(\S+)/m.exec(text) || [])[1] || "";
  const releaseDate = (/^releaseDate:\s*'([^']+)'/m.exec(text) || [])[1] || "";
  const files = [];
  const pattern = /- url: (\S+)\r?\n\s+sha512: (\S+)\r?\n\s+size: (\d+)/g;
  let match = pattern.exec(text);
  while (match) {
    files.push({ url: match[1], sha512: match[2], size: Number(match[3]) });
    match = pattern.exec(text);
  }
  return { version, releaseDate, files };
}

function mergeUpdateYml(parts) {
  const files = [];
  const seen = new Set();
  let version = "";
  let releaseDate = "";
  for (const part of parts) {
    const parsed = typeof part === "string" ? parseUpdateYml(part) : part;
    if (parsed.version) version = parsed.version;
    if (parsed.releaseDate) releaseDate = parsed.releaseDate;
    for (const file of parsed.files || []) {
      if (!file.url || seen.has(file.url)) continue;
      seen.add(file.url);
      files.push(file);
    }
  }
  const zip = files.find((file) => file.url.endsWith("-mac.zip") && !file.url.includes("arm64"))
    || files.find((file) => file.url.endsWith(".zip"));
  if (!version || !zip) throw new Error("Cannot merge Mac update metadata");
  const lines = ["version: " + version, "files:"];
  for (const file of files) {
    lines.push("  - url: " + file.url);
    lines.push("    sha512: " + file.sha512);
    lines.push("    size: " + file.size);
  }
  lines.push("path: " + zip.url);
  lines.push("sha512: " + zip.sha512);
  if (releaseDate) lines.push("releaseDate: '" + releaseDate + "'");
  lines.push("");
  return lines.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("usage: merge-mac-update-yml.js <yml> [yml...] <output>");
    process.exit(1);
  }
  const output = args.pop();
  const parts = args.map((file) => fs.readFileSync(file, "utf8"));
  fs.writeFileSync(output, mergeUpdateYml(parts));
}

module.exports = { parseUpdateYml, mergeUpdateYml };

if (require.main === module) main();
