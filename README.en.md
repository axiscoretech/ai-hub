<div align="center">

[Русский](README.md) · **English**

<img src="assets/icon.png" width="120" alt="AI Hub icon" />

# AI Hub

**All your AI chats in one window — on their free plans.**

No API keys. No tokens to buy. Your own WireGuard for the hub tabs only.

ChatGPT · Claude · Gemini · DeepSeek · Grok · Perplexity · Mistral · Qwen · Kimi · OpenClaw

[![Release](https://img.shields.io/github/v/release/axiscoretech/ai-hub?style=flat-square&color=7c6aff)](https://github.com/axiscoretech/ai-hub/releases/latest)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat-square)](https://github.com/axiscoretech/ai-hub/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

</div>

---

![AI Hub switching signed-in tabs](assets/demo.gif)

*Dark theme, signed in. Switching tabs does not reload the page. The flag changes with the WireGuard exit country.*

---

A macOS, Windows, and Linux app that keeps ChatGPT, Claude, Gemini, DeepSeek, Grok, Perplexity, Mistral, Qwen, Kimi, and a local [OpenClaw](https://openclaw.ai) gateway in one native window.

AI Hub opens the real websites, so you use each service the way it is offered to everyone: its free plan, with no API key and no pay-per-token billing. When one service's free limit runs out, switch to the next tab and keep working — every tab is already signed in and still where you left it. Paid accounts work the same way: sign in, and the tab uses your subscription.

## Why AI Hub

- **Free plans first.** Other multi-chat apps ask for API keys and a prepaid balance. AI Hub needs neither — it is the web chat you already use, not a token reseller
- **No tab mess.** One live tab per service, in its own window with its own dock icon, instead of a dozen browser tabs that log out and reload
- **WireGuard for the hub only.** Route the AI tabs through your own WireGuard config when a service is unavailable in your region. Your browser, banking apps, and the rest of the system stay on a direct connection

---

## Features

- **Separate from your browser** — AI chats get their own dock icon and window
- **Live tabs** — switching services does not reload the page. Logins persist between launches
- **Isolated sessions** — stay logged in to every service at once. A service can hold more than one account (say, work and personal), each with its own login and its own tunnel or direct route
- **Compare** — put two or three chats side by side, insert the task text into the focused chat without sending it, and keep the task board
- **WireGuard** — send the hub tabs you choose through a WireGuard config. Other services can stay on a direct connection. This does not change the rest of your Mac, PC, or Linux machine
- **Your own sites** — add an https address when a service is missing from the list. Hide a tab from the flag panel when you do not want it
- **Theme** — dark, light, or match the system
- **OpenClaw** — a tab for a local OpenClaw gateway. Installing or updating it asks first and uses the official source

The app opens the real websites. It does not sell credits, and it does not send a prompt into those sites for you.

---

## Install

### macOS — one command

Latest release, into `/Applications`, then Launchpad. Apple Silicon and Intel are chosen for you.

```bash
curl -fsSL https://raw.githubusercontent.com/axiscoretech/ai-hub/master/install.sh | bash
```

The script installs the latest release into `/Applications` and opens it. A notarized build opens without an extra prompt. If the signature is not accepted, the script clears the quarantine flag once.

If macOS still blocks the app after this script, use the steps under the DMG download below.

Notarization setup for maintainers is in [`docs/signing.md`](docs/signing.md).

### macOS — DMG

1. Download the latest release from [**Releases**](https://github.com/axiscoretech/ai-hub/releases/latest): `AI-Hub-x.x.x-arm64.dmg` for Apple Silicon (M1–M4), `AI-Hub-x.x.x.dmg` for Intel
2. Open the `.dmg`
3. Drag **AI Hub.app** into `/Applications`
4. Launch the app

Before you open the file, compare its SHA-256 with the digest GitHub shows next to that file on the release page. On a Mac: `shasum -a 256 ~/Downloads/AI-Hub-x.x.x.dmg` (Apple Silicon builds are named `AI-Hub-x.x.x-arm64.dmg`). The same hashes are in the `SHA256SUMS` file on that page.

<details>
<summary>macOS says the app can't be opened?</summary>

![Allow AI Hub on macOS](assets/install-macos.gif)

The pictures follow macOS 15 and later. The words on your Mac can differ. Click **Done**, then **System Settings → Privacy & Security**, scroll to **Security**, and choose **Open Anyway**. Confirm, then enter your Mac password. You do this once for each downloaded version.

</details>

### macOS — Homebrew

```bash
brew tap axiscoretech/tap
brew install --cask ai-hub
```

### Windows

1. Download `AI-Hub-x.x.x-Setup.exe` from [**Releases**](https://github.com/axiscoretech/ai-hub/releases/latest)
2. Run the installer
3. Launch **AI Hub** from the Start Menu or Desktop shortcut

Before you run it, compare its SHA-256 with the digest GitHub shows next to that file on the release page. In PowerShell: `Get-FileHash .\AI-Hub-x.x.x-Setup.exe -Algorithm SHA256`.

<details>
<summary>SmartScreen says it protected your PC?</summary>

![Allow AI Hub on Windows](assets/install-windows.gif)

Click **More info**, check that the file name is `AI-Hub-Setup-x.x.x.exe`, then **Run anyway**. The warning is there because the installer is not code-signed yet.

</details>

### Linux

Download the `.AppImage` for your machine from [**Releases**](https://github.com/axiscoretech/ai-hub/releases/latest), mark it executable, and run it. `wireproxy` can be downloaded by the app or installed yourself.

---

## Privacy

AI Hub does not send telemetry. It talks to the sites you open, to GitHub when it downloads `wireproxy`, and to GitHub Releases when it checks for an app update. A downloaded update is offered for install only after its SHA-256 matches the `SHA256SUMS` file published with that release. macOS still asks Gatekeeper to approve an update until the app is notarized.

What stays on this computer, under the app's user data folder (`~/Library/Application Support/AI Hub` on macOS, `%APPDATA%\AI Hub` on Windows, `~/.config/AI Hub` on Linux):

- **Logins.** Each account has its own session partition. The first account of a service is `Partitions/persist:<service>`. Another account is `Partitions/persist:<service>:<account>`. Cookies stay in that partition. On macOS they are not stored in the login keychain, so opening the app does not ask for that password twice. A saved WireGuard tunnel still uses the keychain once, when it reconnects.
- **WireGuard configs.** Imported `.conf` files are encrypted with the operating system key store (Keychain on macOS, DPAPI on Windows, the desktop keyring on Linux) and stored in `wireguard/`. If encryption is not available, AI Hub refuses to save the config. A plaintext copy exists only while that tunnel is running, then it is deleted.
- **Compare tasks.** `tasks.json`.
- **Shared Google account book.** `google-accounts.json` records which profiles share one Google sign-in. Profiles left on their own are not in that group.
- **OpenClaw sign-in.** The dashboard token is not written here. The app runs `openclaw dashboard --no-open`, reads the local URL from the pasteboard (the token is the URL fragment), keeps it in memory for that window, and restores the previous pasteboard text.
- **Extensions.** `extensions/`.

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

![Compare board with two tasks](assets/screenshot-compare.png)

**Principle:** AI Hub does not send a prompt into the sites for you.

Compare is a board in the shell, not a second account system.

1. Click the two-column icon, or press `Cmd/Ctrl+Shift+B`.
2. Enter a title and the text you want to paste into the chats.
3. Tick the services you want on the task, then choose **Add task**.
4. **Copy** puts the text on the clipboard. Paste it into the chat yourself.
5. **Open** switches to that service. A queued assignment becomes **Doing**. If you already opened that chat from this task, AI Hub returns to the saved page.
6. Set the status yourself: **Queued**, **Doing**, **Ready**, or **Done**.

An amber dot means the background tab's title changed while that assignment was **Doing**. It is a nudge to look, not proof that the answer is finished. Opening the assignment, or changing its status, clears the dot.

You can keep up to 50 tasks. Delete a task from its card. Removing the last service on a task is refused, so a task always points at somewhere.

**Insert**, while the chats are side by side, focuses the message box of the chat you clicked and types the task text there. That includes the ProseMirror editors used by Claude and ChatGPT. It does not press Send.

---

## WireGuard

![WireGuard panel](assets/screenshot-wireguard.png)

1. Click the flag.
2. Choose **Import .conf** and pick one or more WireGuard config files.
3. Choose **Connect** on the config you want. **Switch location** moves the tunnel accounts to another imported config.
4. **Disconnect** returns those accounts to a direct connection.

Only accounts set to Tunnel use it. The route is per account, so a work profile and a personal profile of the same service can exit in different countries. The rest of the system network stays as it is. Changing the route of an account that already has a site session warns that the account will see a country change.

Tunnel accounts also block WebRTC UDP that would otherwise skip the proxy and reveal the real address. That block stays on if the tunnel drops and the account is cut off from the network. Accounts set to Direct keep normal WebRTC.

The first time you connect, the app can download `wireproxy` if it is not already installed (`brew install wireproxy` installs it yourself). When the exit location is known, the flag icon shows that country.

In the flag panel, each account has its own **Tunnel** or **Direct** choice. OpenClaw stays on this computer and has no tunnel choice.

---

## Google

The **G** button shares one Google sign-in only with the profiles you mark **Shared**. A profile marked **Own account** keeps a separate Google login. A new extra account starts as its own. **Sign in shared profiles** copies the shared Google session into the profiles in that group and leaves the others alone.

---

## OpenClaw

OpenClaw is the local personal assistant previously called Clawd, Clawdbot, and Moltbot.

If OpenClaw is missing, **Install OpenClaw** asks before it downloads [https://openclaw.ai/install.sh](https://openclaw.ai/install.sh) and runs that script with `/bin/bash`. Nothing else is downloaded as the installer, and a redirect off `openclaw.ai` is refused. **Update** asks before it runs `openclaw update --yes --json --timeout 600` with the OpenClaw already on this computer.

Signing in does not use a password typed into AI Hub. The app runs `openclaw dashboard --no-open`. OpenClaw copies a local dashboard URL to the pasteboard, and the sign-in token is that URL's fragment. AI Hub reads it, opens the page, restores the previous pasteboard text, and keeps the token in memory for the window. It is not written to the app's files.

If the gateway is already running, the OpenClaw tab opens its dashboard. Pairing stays on that machine.

---

## Supported services

| | Service | URL |
|---|---|-----|
| <img src="assets/services/chatgpt.png" width="18" height="18" alt=""> | ChatGPT | [chatgpt.com](https://chatgpt.com) |
| <img src="assets/services/claude.png" width="18" height="18" alt=""> | Claude | [claude.ai](https://claude.ai) |
| <img src="assets/services/gemini.svg" width="18" height="18" alt=""> | Gemini | [gemini.google.com](https://gemini.google.com) |
| <img src="assets/services/deepseek.png" width="18" height="18" alt=""> | DeepSeek | [chat.deepseek.com](https://chat.deepseek.com) |
| <img src="assets/services/grok.png" width="18" height="18" alt=""> | Grok | [grok.com](https://grok.com) |
| <img src="assets/services/perplexity.png" width="18" height="18" alt=""> | Perplexity | [perplexity.ai](https://www.perplexity.ai) |
| <img src="assets/services/mistral.png" width="18" height="18" alt=""> | Mistral | [chat.mistral.ai](https://chat.mistral.ai) |
| <img src="assets/services/qwen.png" width="18" height="18" alt=""> | Qwen | [chat.qwen.ai](https://chat.qwen.ai) |
| <img src="assets/services/kimi.png" width="18" height="18" alt=""> | Kimi | [kimi.com](https://www.kimi.com) |
| <img src="assets/services/openclaw.png" width="18" height="18" alt=""> | OpenClaw | local gateway, usually `127.0.0.1:18789` |

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
npm test   # board, WireGuard, services, and an Electron smoke check
```

---

## For Developers

## Build

```bash
npm run dist        # macOS ARM64 + x64 DMG → dist/
npm run dist:arm    # Apple Silicon only
npm run dist:x64    # Intel Mac only
npm run dist:win    # Windows x64 NSIS installer → dist/
npm run dist:linux  # Linux AppImage → dist/
npm run open-app    # unpacked macOS app in dist/mac, then open it
```

## Maintainers

Apple code signing and notarization setup lives in [`docs/signing.md`](docs/signing.md).
Once Apple Developer access is available, add the required GitHub Actions secrets and future releases will be signed automatically.

---

<div align="center">

Made with ☕ · [axiscoretech](https://github.com/axiscoretech)

</div>
