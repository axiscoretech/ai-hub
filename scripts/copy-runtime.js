const fs = require("fs");
const path = require("path");

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

copy("src/renderer/index.html", "out/renderer/index.html");
copy("src/renderer/board.css", "out/renderer/board.css");
copy("src/renderer/google-ui.css", "out/renderer/google-ui.css");
copy("src/main/wireproxy-checksums.json", "out/main/wireproxy-checksums.json");
