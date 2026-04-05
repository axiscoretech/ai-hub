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

## Install

### Homebrew _(recommended)_

```bash
brew tap axiscoretech/tap
brew install --cask ai-hub
```

### Download DMG

Go to [**Releases**](https://github.com/axiscoretech/ai-hub/releases/latest) and pick the right file for your Mac:

| Mac | File |
|-----|------|
| Apple Silicon (M1 / M2 / M3 / M4) | `AI-Hub-x.x.x-arm64.dmg` |
| Intel | `AI-Hub-x.x.x.dmg` |

Open the DMG and drag **AI Hub.app** into `/Applications`.

> **"App is damaged" warning?**
> macOS Gatekeeper blocks unsigned apps. Run this once in Terminal and relaunch:
> ```bash
> xattr -cr /Applications/AI\ Hub.app
> ```

---

## Features

- **Live tabs** — each service runs in its own isolated browser view, no reloads on switch
- **Persistent sessions** — stay logged in across restarts, each service has its own cookies
- **Native macOS feel** — hidden title bar, traffic light buttons, window drag
- **Lightweight** — no Electron bloat in your way, just a thin shell around the web apps

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

## Build

```bash
npm run dist        # ARM64 + x64 DMG → dist/
npm run dist:arm    # Apple Silicon only
npm run dist:x64    # Intel only
```

---

<div align="center">

Made with ☕ · [axiscoretech](https://github.com/axiscoretech)

</div>
