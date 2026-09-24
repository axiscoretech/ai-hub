const fs = require("fs");
const path = require("path");

const pkg = require("../package.json");
const log = fs.readFileSync(path.join(__dirname, "..", "CHANGELOG.md"), "utf8");

function section(heading) {
  const start = log.indexOf(heading);
  if (start === -1) return "";
  const rest = log.slice(start + heading.length);
  const next = rest.search(/\n## /);
  const body = (next === -1 ? rest : rest.slice(0, next)).trim();
  return body;
}

const notes = section(`## ${pkg.version}`) || section("## Unreleased");
if (!notes) {
  console.error("CHANGELOG.md has no notes for this version.");
  process.exit(1);
}
process.stdout.write(`${notes}\n`);
