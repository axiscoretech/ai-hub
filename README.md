<div align="center">

<img src="assets/icon.png" width="120" alt="AI Hub icon" />

# AI Hub

**All your AI assistants in one place.**

ChatGPT · Claude · Gemini · DeepSeek · Grok · Perplexity · Mistral · Qwen · Kimi · HuggingChat

[![Release](https://img.shields.io/github/v/release/axiscoretech/ai-hub?style=flat-square&color=7c6aff)](https://github.com/axiscoretech/ai-hub/releases/latest)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey?style=flat-square)](https://github.com/axiscoretech/ai-hub/releases/latest)
[![License](https://img.shields.io/github/license/axiscoretech/ai-hub?style=flat-square)](LICENSE)

</div>

---

## Quick Start

1. Download the latest release from [**Releases**](https://github.com/axiscoretech/ai-hub/releases/latest)
2. Open the `.dmg`
3. Drag **AI Hub.app** into `/Applications`
4. Launch the app

If macOS says the app is damaged, run:

```bash
xattr -cr /Applications/AI\ Hub.app
```

Then launch it again.

---

## Install

### Direct Download _(recommended for now)_

Download the right file for your Mac from [**Releases**](https://github.com/axiscoretech/ai-hub/releases/latest):

| Mac | File |
|-----|------|
| Apple Silicon (M1 / M2 / M3 / M4) | `AI-Hub-x.x.x-arm64.dmg` |
| Intel Mac | `AI-Hub-x.x.x.dmg` |

Open the DMG and drag **AI Hub.app** into `/Applications`.

If macOS reports that the app is damaged, clear the quarantine flag once and relaunch:

```bash
xattr -cr /Applications/AI\ Hub.app
```

### Homebrew

```bash
brew tap axiscoretech/tap
brew install --cask ai-hub
```

Direct DMG install is currently the safest option while signed notarized releases are still being finalized.

---

## Features

- **One app for many AI tools** — keep ChatGPT, Claude, Gemini, DeepSeek, Grok, Perplexity, Qwen, Kimi, Mistral, and HuggingChat together
- **Live tabs** — switch between services without reloading the page
- **Persistent sessions** — stay logged in between launches
- **Native macOS feel** — clean window chrome, traffic light controls, drag-friendly title area

---

## Supported services

| | Service | URL |
|---|---------|-----|
| 🤖 | ChatGPT | [chat.openai.com](https://chat.openai.com) |
| ✨ | Claude | [claude.ai](https://claude.ai) |
| 🌌 | Gemini | [gemini.google.com](https://gemini.google.com) |
| 🧠 | DeepSeek | [chat.deepseek.com](https://chat.deepseek.com) |
| ⚡ | Grok | [grok.com](https://grok.com) |
| 🔎 | Perplexity | [perplexity.ai](https://www.perplexity.ai) |
| 🌬️ | Mistral | [chat.mistral.ai](https://chat.mistral.ai) |
| 🐉 | Qwen | [chat.qwenlm.ai](https://chat.qwenlm.ai) |
| 🌙 | Kimi | [kimi.com](https://www.kimi.com) |
| 🤗 | HuggingChat | [huggingface.co/chat](https://huggingface.co/chat) |

---

## Run from source

```bash
git clone https://github.com/axiscoretech/ai-hub
cd ai-hub
npm install
npm start
```

Requires [Node.js](https://nodejs.org) 18+ and [npm](https://npmjs.com).

---

## For Developers

## Build

```bash
npm run dist        # ARM64 + x64 DMG → dist/
npm run dist:arm    # Apple Silicon only
npm run dist:x64    # Intel only
```

## Maintainers

Apple code signing and notarization setup lives in [`docs/signing.md`](docs/signing.md).
Once Apple Developer access is available, add the required GitHub Actions secrets and future releases will be signed automatically.

---

<div align="center">

Made with ☕ · [axiscoretech](https://github.com/axiscoretech)

</div>
