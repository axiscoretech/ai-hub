const fs = require("fs");
const path = require("path");

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dest = path.join(to, name);
    if (fs.statSync(src).isDirectory()) copyDir(src, dest);
    else copy(src, dest);
  }
}

copy("src/renderer/index.html", "out/renderer/index.html");
copy("src/renderer/board.css", "out/renderer/board.css");
copy("src/renderer/google-ui.css", "out/renderer/google-ui.css");
copy("src/main/wireproxy-checksums.json", "out/main/wireproxy-checksums.json");
copyDir("assets/services", "out/renderer/icons");
