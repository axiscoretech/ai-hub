#!/bin/bash
# Install the latest AI Hub release into /Applications and open it.
# macOS only. A notarized app opens as it is. Quarantine is cleared only
# when the signature is not accepted.
#
# Do not call python3, git, or clang here. On a Mac without Xcode Command
# Line Tools those binaries are stubs that pop the developer-tools dialog
# and then exit.
set -euo pipefail

REPO="axiscoretech/ai-hub"

# Read GitHub latest-release JSON on stdin or as $2 and print the zip URL.
pick_mac_zip_url() {
  local arch="$1"
  local json="$2"
  local matches candidate

  matches="$(printf '%s' "$json" | grep -oE 'https://[^"]+-mac\.zip"' || true)"
  while IFS= read -r candidate; do
    candidate="${candidate%\"}"
    [[ -z "$candidate" ]] && continue
    if [[ "$arch" == "arm64" ]]; then
      if [[ "$candidate" == *-arm64-mac.zip ]]; then
        printf '%s' "$candidate"
        return 0
      fi
    else
      if [[ "$candidate" != *arm64* ]]; then
        printf '%s' "$candidate"
        return 0
      fi
    fi
  done <<< "$matches"
  return 1
}

if [[ "${1:-}" == "--print-zip-url" ]]; then
  arch="${2:-}"
  json="$(cat)"
  if [[ "$arch" != "arm64" && "$arch" != "x64" ]]; then
    echo "Unknown architecture: ${arch}" >&2
    exit 1
  fi
  if ! url="$(pick_mac_zip_url "$arch" "$json")"; then
    echo "The latest release has no macOS build for this Mac." >&2
    exit 1
  fi
  printf '%s\n' "$url"
  exit 0
fi

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
json="$(curl -fsSL --retry 3 \
  -H "Accept: application/vnd.github+json" \
  -H "User-Agent: ai-hub-install" \
  "https://api.github.com/repos/${REPO}/releases/latest")"
if ! url="$(pick_mac_zip_url "$arch" "$json")"; then
  echo "The latest release has no macOS build for this Mac."
  echo "Download a DMG from https://github.com/${REPO}/releases/latest"
  exit 1
fi

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
if ! spctl --assess --type execute "$dest" >/dev/null 2>&1; then
  echo "This build is not notarized. Clearing the quarantine flag so it can open."
  xattr -cr "$dest"
fi
open "$dest"
echo "AI Hub is in Applications and open."
