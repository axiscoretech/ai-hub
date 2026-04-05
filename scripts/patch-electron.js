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

// 2. Patch CFBundleName + CFBundleDisplayName + CFBundleExecutable → "AI Hub"
if (fs.existsSync(plist)) {
  try {
    execSync(`/usr/libexec/PlistBuddy -c "Set :CFBundleName 'AI Hub'" "${plist}"`);
    execSync(`/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName 'AI Hub'" "${plist}"`);
    execSync(`/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier 'com.aihub.desktop'" "${plist}"`);
    execSync(`/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable 'AI Hub'" "${plist}"`);
    console.log("✓ Patched Info.plist");
  } catch (e) {
    console.warn("⚠ Could not patch Info.plist:", e.message);
  }
}

// 3. Copy Electron binary as "AI Hub" (dock uses process/executable name as fallback)
const macosDir = path.join(appDir, "Contents", "MacOS");
const origBin  = path.join(macosDir, "Electron");
const newBin   = path.join(macosDir, "AI Hub");
if (fs.existsSync(origBin) && !fs.existsSync(newBin)) {
  fs.copyFileSync(origBin, newBin);
  fs.chmodSync(newBin, 0o755);
  console.log("✓ Copied binary as 'AI Hub'");
}

// 4. Update path.txt to point at the renamed binary
if (fs.existsSync(newBin)) {
  fs.writeFileSync(pathTxt, "Electron.app/Contents/MacOS/AI Hub");
  console.log("✓ Updated path.txt → AI Hub binary");
}
