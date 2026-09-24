#!/bin/bash
# Install the latest AI Hub release into /Applications and open it.
# macOS only. Clears the download quarantine flag so Gatekeeper does not
# ask you to allow the app by hand.
set -euo pipefail

REPO="axiscoretech/ai-hub"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer is for macOS."
  echo "On Windows, download AI-Hub-Setup-….exe from:"
  echo "https://github.com/${REPO}/releases/latest"
  exit 1
fi

case "$(uname -m)" in
  arm64) arch="arm64" ;;
  x86_64) arch="x64" ;;
  *)
    echo "This Mac architecture is not supported: $(uname -m)"
    exit 1
    ;;
esac

echo "Looking up the latest AI Hub release…"
url="$(python3 - "$arch" << 'PY'
import json, sys, urllib.request
arch = sys.argv[1]
req = urllib.request.Request(
    "https://api.github.com/repos/axiscoretech/ai-hub/releases/latest",
    headers={"Accept": "application/vnd.github+json", "User-Agent": "ai-hub-install"},
)
with urllib.request.urlopen(req) as response:
    release = json.load(response)
for asset in release.get("assets", []):
    name = asset.get("name", "")
    if arch == "arm64" and name.endswith("-arm64-mac.zip"):
        print(asset["browser_download_url"])
        break
    if arch == "x64" and name.endswith("-mac.zip") and "arm64" not in name:
        print(asset["browser_download_url"])
        break
else:
    sys.stderr.write("The latest release has no macOS build for this Mac.\n")
    sys.exit(1)
PY
)"

work="$(mktemp -d)"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

echo "Downloading…"
curl -fL --retry 3 -o "$work/AI-Hub.zip" "$url"
echo "Unpacking…"
ditto -x -k "$work/AI-Hub.zip" "$work/unpacked"

app="$(find "$work/unpacked" -name "AI Hub.app" -maxdepth 3 -print -quit)"
if [[ -z "$app" ]]; then
  echo "The download did not contain AI Hub.app"
  exit 1
fi

if pgrep -f "/Applications/AI Hub.app/Contents/MacOS/AI Hub" >/dev/null 2>&1; then
  osascript -e 'tell application "AI Hub" to quit' >/dev/null 2>&1 || true
  sleep 1
fi

dest="/Applications/AI Hub.app"
echo "Installing to ${dest}"
rm -rf "$dest"
ditto "$app" "$dest"
xattr -cr "$dest"
open "$dest"
echo "AI Hub is in Applications and open."
