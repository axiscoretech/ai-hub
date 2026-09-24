<div align="center">

<img src="assets/icon.png" width="120" alt="AI Hub icon" />

# AI Hub

**All your AI assistants in one place.**

ChatGPT · Claude · Gemini · DeepSeek · Grok · Perplexity · Mistral · Qwen · Kimi · OpenClaw

[![Release](https://img.shields.io/github/v/release/axiscoretech/ai-hub?style=flat-square&color=7c6aff)](https://github.com/axiscoretech/ai-hub/releases/latest)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey?style=flat-square)](https://github.com/axiscoretech/ai-hub/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

</div>

---

![AI Hub Compare board](assets/screenshot.png)

---

A macOS and Windows app that keeps ChatGPT, Claude, Gemini, DeepSeek, Grok, Perplexity, Mistral, Qwen, Kimi, and a local [OpenClaw](https://openclaw.ai) gateway in one native window. Each service has its own session. Logins persist, tabs stay live, and the chats stay out of your browser.

---

## Features

- **Separate from your browser** — AI chats get their own dock icon and window
- **Isolated sessions** — stay logged in to every service at once, and switch when a free tier runs out without signing in again
- **Live tabs** — switching services does not reload the page
- **Compare** — assign one piece of work to several services, copy the text, and jump back to the right chat
- **WireGuard** — route hub tabs through a WireGuard config when a service is blocked in your region. This does not change the rest of your Mac or PC
- **Theme** — dark, light, or match the system
- **OpenClaw** — a tab for a local OpenClaw gateway, if you have one installed

The app opens the real websites. It does not sell credits, and it does not type into those sites for you.

---

## The window

The service names are tabs. The buttons on the right are icons:

| Icon | Action |
|------|--------|
| Circular arrow | Reload the current page (`Cmd/Ctrl+R`) |
| Circular arrow with a dot | Reload ignoring cache (`Cmd/Ctrl+Shift+R`) |
| Moon, sun, or display | Theme. Click to cycle dark, light, and system |
| Two columns | Compare (`Cmd/Ctrl+Shift+B`) |
| Flag | WireGuard. After a connection finds its exit country, the flag becomes that country's flag |

`Escape` leaves Compare and returns to the current chat.

---

## Compare

![Compare board with two tasks](assets/screenshot.png)

Compare is a board in the shell, not a second account system.

1. Click the two-column icon, or press `Cmd/Ctrl+Shift+B`.
2. Enter a title and the text you want to paste into the chats.
3. Tick the services you want on the task, then choose **Add task**.
4. **Copy** puts the text on the clipboard. Paste it into the chat yourself.
5. **Open** switches to that service. A queued assignment becomes **Doing**. If you already opened that chat from this task, AI Hub returns to the saved page.
6. Set the status yourself: **Queued**, **Doing**, **Ready**, or **Done**.

An amber dot means the background tab's title changed while that assignment was **Doing**. It is a nudge to look, not proof that the answer is finished. Opening the assignment, or changing its status, clears the dot.

You can keep up to 50 tasks. Delete a task from its card. Removing the last service on a task is refused, so a task always points at somewhere.

---

## WireGuard

![WireGuard panel](assets/screenshot-wireguard.png)

1. Click the flag.
2. Choose **Import .conf** and pick one or more WireGuard config files.
3. Choose **Connect** on the config you want. **Switch location** moves the hub tabs to another imported config.
4. **Disconnect** returns those tabs to a direct connection.

Only AI Hub's service tabs use the tunnel. The rest of the system network stays as it is. The first time you connect, the app can download `wireproxy` if it is not already installed (`brew install wireproxy` installs it yourself). When the exit location is known, the flag icon shows that country.

---

## OpenClaw

OpenClaw is the local personal assistant previously called Clawd, Clawdbot, and Moltbot. AI Hub does not install it for you.

If the gateway is already running, the OpenClaw tab opens its dashboard. If it is missing or stopped, the tab explains the official install command and can start a gateway that is already installed. Pairing stays on that machine.

---

## Quick Start

### macOS

1. Download the latest release from [**Releases**](https://github.com/axiscoretech/ai-hub/releases/latest)
2. Open the `.dmg`
3. Drag **AI Hub.app** into `/Applications`
4. Launch the app

On first launch, macOS may block the app because it was downloaded outside the App Store. Open **System Settings → Privacy & Security**, scroll to the security section at the bottom, and click **Open Anyway** next to AI Hub (or confirm when prompted). You only need to do this once.

If macOS says the app is damaged, run:

```bash
xattr -cr /Applications/AI\ Hub.app
```

Then launch it again.

### Windows

1. Download `AI-Hub-x.x.x-Setup.exe` from [**Releases**](https://github.com/axiscoretech/ai-hub/releases/latest)
2. Run the installer
3. Launch **AI Hub** from the Start Menu or Desktop shortcut

---

## Install

### macOS — Direct Download _(recommended for now)_

Download the right file for your Mac from [**Releases**](https://github.com/axiscoretech/ai-hub/releases/latest):

| Mac | File |
|-----|------|
| Apple Silicon (M1 / M2 / M3 / M4) | `AI-Hub-x.x.x-arm64.dmg` |
| Intel Mac | `AI-Hub-x.x.x.dmg` |

Open the DMG and drag **AI Hub.app** into `/Applications`.

When installing from Releases (not Homebrew), macOS Gatekeeper may refuse to open the app on first launch. Go to **System Settings → Privacy & Security** and use **Open Anyway** for AI Hub at the bottom of the page. Alternatively, right-click **AI Hub.app** in `/Applications` and choose **Open** — then confirm in the dialog.

If macOS reports that the app is damaged, clear the quarantine flag once and relaunch:

```bash
xattr -cr /Applications/AI\ Hub.app
```

### macOS — Homebrew

```bash
brew tap axiscoretech/tap
brew install --cask ai-hub
```

Homebrew handles Gatekeeper for you — you usually do not need to allow the app manually in System Settings.

Direct DMG install is currently the safest option while signed notarized releases are still being finalized.

### Windows — Direct Download

Download `AI-Hub-x.x.x-Setup.exe` from [**Releases**](https://github.com/axiscoretech/ai-hub/releases/latest) and run the installer.

| Windows | File |
|---------|------|
| 64-bit (x64) | `AI-Hub-x.x.x-Setup.exe` |

---

## Supported services

| | Service | URL |
|---|---------|-----|
| | ChatGPT | [chatgpt.com](https://chatgpt.com) |
| | Claude | [claude.ai](https://claude.ai) |
| | Gemini | [gemini.google.com](https://gemini.google.com) |
| | DeepSeek | [chat.deepseek.com](https://chat.deepseek.com) |
| | Grok | [grok.com](https://grok.com) |
| | Perplexity | [perplexity.ai](https://www.perplexity.ai) |
| | Mistral | [chat.mistral.ai](https://chat.mistral.ai) |
| | Qwen | [chat.qwenlm.ai](https://chat.qwenlm.ai) |
| | Kimi | [kimi.com](https://www.kimi.com) |
| | OpenClaw | local gateway, usually `127.0.0.1:18789` |

ChatGPT may still pass through `chat.openai.com` before it lands on `chatgpt.com`. Both stay inside the ChatGPT tab.

---

## Run from source

```bash
git clone https://github.com/axiscoretech/ai-hub
cd ai-hub
npm install
npm start
```

Requires [Node.js](https://nodejs.org) 18+ and [npm](https://npmjs.com).

```bash
npm test   # task board checks, no Electron window
```

---

## For Developers

## Build

```bash
npm run dist        # macOS ARM64 + x64 DMG → dist/
npm run dist:arm    # Apple Silicon only
npm run dist:x64    # Intel Mac only
npm run dist:win    # Windows x64 NSIS installer → dist/
npm run open-app    # unpacked macOS app in dist/mac, then open it
```

## Maintainers

Apple code signing and notarization setup lives in [`docs/signing.md`](docs/signing.md).
Once Apple Developer access is available, add the required GitHub Actions secrets and future releases will be signed automatically.

---

<div align="center">

Made with ☕ · [axiscoretech](https://github.com/axiscoretech)

</div>
