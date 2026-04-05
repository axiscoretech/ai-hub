# AI Hub

Desktop app for macOS that brings ChatGPT, Claude, Gemini, DeepSeek, Qwen, Perplexity, Mistral, Kimi, Grok and HuggingChat into one window with live tabs.

---

## Install

### Via Homebrew (recommended)

```bash
brew tap axiscoretech/tap
brew install --cask ai-hub
```

### Download DMG

Go to [Releases](https://github.com/axiscoretech/ai-hub/releases) and download:

| Mac                 | File                              |
|---------------------|-----------------------------------|
| Apple Silicon (M1+) | `AI Hub-x.x.x-arm64.dmg`         |
| Intel               | `AI Hub-x.x.x.dmg`               |

Open the DMG, drag **AI Hub.app** to `/Applications`.

> **First launch:** if macOS shows "damaged" warning, run:
> ```bash
> xattr -cr /Applications/AI\ Hub.app
> ```

---

## Run from source

```bash
git clone https://github.com/axiscoretech/ai-hub
cd ai-hub
npm install
npm start
```

## Build locally

```bash
npm run dist        # ARM64 + x64 DMG → dist/
npm run dist:arm    # ARM64 only
npm run dist:x64    # Intel only
```

---

## Release a new version

```bash
# 1. bump version in package.json
# 2. commit & tag
git add package.json
git commit -m "chore: bump version to 1.1.0"
git tag v1.1.0
git push origin main --tags
```

GitHub Actions автоматически соберёт DMG для обеих архитектур и опубликует релиз.

После релиза обнови SHA256 в `homebrew/ai-hub.rb`:

```bash
# ARM64
shasum -a 256 "AI Hub-1.1.0-arm64.dmg"

# Intel
shasum -a 256 "AI Hub-1.1.0.dmg"
```

---

## Supported services

| Service      | URL                            |
|--------------|--------------------------------|
| ChatGPT      | chat.openai.com                |
| Claude       | claude.ai                      |
| Gemini       | gemini.google.com              |
| DeepSeek     | chat.deepseek.com              |
| Qwen         | chat.qwenlm.ai                 |
| Perplexity   | perplexity.ai                  |
| Mistral      | chat.mistral.ai                |
| Kimi         | kimi.com                       |
| Grok         | grok.com                       |
| HuggingChat  | huggingface.co/chat            |
