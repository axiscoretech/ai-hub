const fs = require("fs");
const path = require("path");

const pkg = require("../package.json");
const log = fs.readFileSync(path.join(__dirname, "..", "CHANGELOG.md"), "utf8");

function section(version) {
  const lines = log.split("\n");
  const start = lines.findIndex((line) => (
    line === `## ${version}` || line.startsWith(`## ${version} `)
  ));
  if (start === -1) return null;
  const name = lines[start].slice(`## ${version}`.length).trim();
  let end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  if (end === -1) end = lines.length;
  return {
    name,
    body: lines.slice(start + 1, end).join("\n").trim(),
  };
}

const found = section(pkg.version) || section("Unreleased");
if (!found || !found.body) {
  console.error("CHANGELOG.md has no notes for this version.");
  process.exit(1);
}
if (process.argv[2] === "--title") {
  process.stdout.write(found.name ? `${pkg.version} ${found.name}\n` : `${pkg.version}\n`);
} else {
  process.stdout.write(`${found.body}\n`);
}
