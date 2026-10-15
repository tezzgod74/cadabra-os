# Cadabra OS 0.9.7 (public beta)

An AI assistant for Windows that can see your screen and act on it, safely. Press **Ctrl + ~** anywhere (or say **"Cadabra, …"**), ask about what's on screen or tell it what to do, and watch it work with a ghost cursor. **Esc** stops everything.

This is the first public **beta**. It's used day to day by its developers, but several services and setups haven't been tested yet: see [Help us test](HELP_WANTED_TESTING.md).

## What's in it

- **Summon anywhere** with a shortcut you choose (or the wake word), and start typing straight away.
- **Sees and acts:** reads the screen (UI Automation and screenshots), points with gold rings, and clicks, types and scrolls in your real apps with a visible ghost cursor.
- **Opens things:** apps and games (Start menu, Store, Steam, Epic, GOG and launcher shortcuts), web pages (including spoken addresses), and read-only diagnostics in a visible terminal.
- **Bring your own AI:** Claude (through Anthropic's Claude Code app: your Claude subscription, an API key, Bedrock or Vertex), OpenAI through the Codex CLI, Google Gemini through the Gemini CLI, GitHub Copilot, or an offline Demo mode. Each runs with only Cadabra's tools.
- **Safety first:** a code-enforced safety gate with confirmation cards written from the real action, three autonomy levels, hard blocks for password managers and Windows security prompts, and an honesty check on what Cadabra says it did.
- **Local voice:** wake word, speech recognition and natural British and American voices run on your PC. Choose the assistant's name and voice.
- **Everyday helpers:** the time, weather, "lock my PC", spoken greetings, read-only Gmail, and optional web search.
- **WhatsApp:** chat with your assistant from your phone through WhatsApp's Agent Platform (regional beta), with one-time codes for anything risky.
- **Skills:** teach Cadabra your own routines in plain English (`Documents\Cadabra\Skills`). Nothing in a skill is ever run, and a skill can't switch off a safety check.
- **Announcements:** "make an announcement: dinner is ready", or "Announcement: …" from WhatsApp, is spoken on the PC word for word, even while it's locked.

Full history: [CHANGELOG.md](../CHANGELOG.md).

## Requirements

- **Windows 11 x64.** Windows 10 22H2 and ARM64 Windows aren't tested yet.
- **Download:** the installer is about **127 MB**. Optional voice downloads on first use: about **100 MB** for speech recognition and about **350 MB** for the natural voices (about **450 MB** in total).
- **An AI account** (or use the offline Demo mode):
  - **Claude:** the free Claude Code app (Cadabra can install it), plus a Claude plan or an Anthropic API key.
  - **OpenAI:** the Codex CLI.
  - **Google:** the Gemini CLI.
  - **GitHub Copilot:** the Copilot CLI.
- A microphone if you want voice.

## Installing

1. Download `CadabraOS-Setup-0.9.7.exe` from this release.
2. Optional, to check the download: in PowerShell, run `Get-FileHash .\CadabraOS-Setup-0.9.7.exe` and compare with the checksum below.
3. Run it. **The installer isn't code-signed yet**, so Windows SmartScreen shows "Windows protected your PC": choose **More info → Run anyway**. Some antivirus tools may also be cautious, because Cadabra uses a keyboard hook and input injection to act on your screen.
4. It installs for your user only (no administrator prompt), and a short setup opens.

```
SHA-256: 0F8987AED3C23FE16294066F0BDFFD6691E1D3E96647384E53D5F7C1FF35D467
```

## Known limitations

- **Not tested yet** (no accounts or hardware to try them): OpenAI Codex, Gemini, GitHub Copilot, Claude via Bedrock or Vertex, Claude with an API key on a real account (including web search), Gmail app passwords, the Southern cloud voices, WhatsApp outside the developers' region, Windows 10, ARM64, non-US keyboards and input methods, screen readers, and real announcement audio routing and ducking. [Help us test](HELP_WANTED_TESTING.md).
- **Web search with a Claude API key** runs Claude Code without its `--bare` mode so that Cadabra can check every search. Every other lock stays on. Each page Claude reads also sends its domain to Anthropic for Claude Code's own safety check.
- Apps with poor accessibility support (some games, custom-drawn apps) are harder to read and act in.
- Windows running as administrator can be looked at but not controlled.
- Keyboard/mouse sharing tools can send Cadabra's typing to another PC. Cadabra detects the common ones and tells you.
- Voice is English only. During an announcement the wake word is muted, so use Esc (or "stop" in WhatsApp) to stop it.
- Prompt injection can't be fully prevented. The safety gate makes sure it can't lead to a risky action without your OK.

## Privacy, in short

- Your requests, and the screen content needed to answer them, go to **the AI provider you chose**. Nothing goes to the Cadabra project: there's no server, telemetry or account.
- The wake word, speech recognition and natural voices run **on your PC**. Weather lookups send only the city name. Gmail data comes from Google only when you ask. WhatsApp agent chats are **not end-to-end encrypted** (Meta's agent service keeps them for up to 30 days). The Southern voices send the reply text to OpenAI.
- Keys and tokens are encrypted with Windows (DPAPI). Logs never contain what you type, email contents, keys or tokens. **Export diagnostics…** removes names, addresses and window titles too, but read it before sharing.

## Reporting problems

- **Bugs:** open an issue with the bug template and attach tray → **Export diagnostics…** (read it first; never paste keys or codes).
- **Security problems:** report them privately, not in a public issue: see [SECURITY.md](../SECURITY.md).

## Uninstalling cleanly

1. Tray icon → **Quit Cadabra**.
2. Windows **Settings → Apps → Installed apps → Cadabra OS → Uninstall**.
3. Delete `%APPDATA%\Cadabra OS` (settings, logs and about 450 MB of voice models).
4. Your skills in `Documents\Cadabra\Skills` are kept: delete that folder too if you don't want them.
5. The AI apps you installed (Claude Code, Codex, Gemini CLI, Copilot CLI) stay installed and signed in; remove them separately if you like. If you connected Gmail with your own Google key, you can also remove the access at myaccount.google.com/permissions.
