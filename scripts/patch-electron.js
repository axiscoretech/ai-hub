#!/usr/bin/env node
// Patches the Electron dev bundle to show "AI Hub" instead of "Electron"
// in macOS menu bar and dock. Runs automatically after `npm install`.

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const dist   = path.join(__dirname, "..", "node_modules", "electron", "dist");
const appDir = path.join(dist, "Electron.app");
const plist  = path.join(appDir, "Contents", "Info.plist");
const pathTxt = path.join(__dirname, "..", "node_modules", "electron", "path.txt");

// 1. Ensure path.txt has no trailing newline (can break electron binary resolution)
if (fs.existsSync(pathTxt)) {
  const current = fs.readFileSync(pathTxt, "utf-8").trim();
  fs.writeFileSync(pathTxt, current); // no trailing newline
}

// 2. Patch CFBundleName + CFBundleDisplayName → "AI Hub"
if (fs.existsSync(plist)) {
  try {
    execSync(`/usr/libexec/PlistBuddy -c "Set :CFBundleName 'AI Hub'" "${plist}"`);
    execSync(`/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName 'AI Hub'" "${plist}"`);
    console.log("✓ Patched Info.plist (CFBundleName, CFBundleDisplayName → AI Hub)");
  } catch (e) {
    console.warn("⚠ Could not patch Info.plist:", e.message);
  }
} else {
  console.warn("⚠ Electron.app not found at", appDir);
}
