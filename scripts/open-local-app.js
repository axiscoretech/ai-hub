#!/usr/bin/env node

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..");
const appPath = path.join(rootDir, "dist", "mac", "AI Hub.app");

function run(command, args) {
  execFileSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
  });
}

run("npm", ["exec", "electron-builder", "--", "--mac", "--dir"]);

if (!fs.existsSync(appPath)) {
  console.error(`Built app not found: ${appPath}`);
  process.exit(1);
}

run("open", [appPath]);
