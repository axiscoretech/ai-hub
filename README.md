# AI Hub

Десктопное приложение для macOS — ChatGPT, Claude, Gemini, DeepSeek, Qwen, Perplexity, Mistral, Kimi, Grok и HuggingChat в одном окне.

---

## Установка

### Способ 1 — Homebrew

```bash
brew tap axiscoretech/tap
brew install --cask ai-hub
```

### Способ 2 — Скачать DMG

Перейди на страницу [Releases](https://github.com/axiscoretech/ai-hub/releases/latest) и скачай нужный файл:

| Твой Mac | Файл для скачивания |
|---|---|
| Apple Silicon (M1 / M2 / M3 / M4) | `AI-Hub-x.x.x-arm64.dmg` |
| Intel | `AI-Hub-x.x.x.dmg` |

Открой DMG и перетащи **AI Hub.app** в папку `/Applications`.

> **Если macOS пишет «приложение повреждено»** — это ограничение Gatekeeper для неподписанных приложений. Запусти в Терминале:
> ```bash
> xattr -cr /Applications/AI\ Hub.app
> ```
> После этого приложение откроется нормально.

---

## Поддерживаемые сервисы

| Сервис | Адрес |
|---|---|
| ChatGPT | chat.openai.com |
| Claude | claude.ai |
| Gemini | gemini.google.com |
| DeepSeek | chat.deepseek.com |
| Qwen | chat.qwenlm.ai |
| Perplexity | perplexity.ai |
| Mistral | chat.mistral.ai |
| Kimi | kimi.com |
| Grok | grok.com |
| HuggingChat | huggingface.co/chat |

---

## Запуск из исходников

```bash
git clone https://github.com/axiscoretech/ai-hub
cd ai-hub
npm install
npm start
```
