# Changelog

All notable changes to Cadabra OS are listed here. The project follows [Semantic Versioning](https://semver.org/); before 1.0, minor versions may include breaking changes.

## Unreleased

## 0.9.0 — first public-ready preview

The first version prepared for other people to download, build and contribute to.

**Summon and act**
- Press **Ctrl + ~** (or your own key or mouse combination) anywhere, or say **"Cadabra, …"**, and a frosted-glass panel opens at the cursor. Keystrokes typed during the animation land in the panel.
- Cadabra sees the screen through UI Automation and screenshots, points with gold rings, and clicks, types and scrolls in real apps with a ghost cursor. **Esc** stops everything.
- Opens installed apps and games (Start menu, Store, Steam, Epic, GOG), web pages (including spoken addresses such as "tv dot youtube dot com"), and runs read-only diagnostics such as `nslookup` in a visible terminal.
- Multi-step tasks (for example directions in Google Maps) run without needless questions. An honesty check makes sure Cadabra only claims what it actually did.

**AI backends**
- Claude (your own Claude Code sign-in, an Anthropic API key, Amazon Bedrock or Google Vertex AI), OpenAI via the Codex CLI, Google Gemini via the Gemini CLI, GitHub Copilot, and an offline Demo backend. Switch provider and model from the panel, the tray or by voice.
- Every backend runs isolated, with only Cadabra's tools. Sign-in always happens in the vendor's own CLI and login page.
- Optional read-only web search and fetch through your chosen AI, behind a guard that refuses private data.

**Safety**
- A code-enforced safety gate with confirm cards rendered from the real arguments, a terminal allowlist, a denylist for password managers and Windows security prompts, per-run budgets, and stop-on-Esc down to the keystroke.
- Three autonomy levels (ask for risky actions, ask for every action, don't ask) with revocable "Always allow" grants for ordinary actions.
- Screen text, web pages, emails and messages are treated as untrusted data.

**Voice**
- Local wake word, voice activity detection and speech-to-text (sherpa-onnx with Parakeet). Nothing leaves the PC for voice input.
- Natural local voices (Kokoro v1.0, British and American) that start speaking on the first sentence, plus optional cloud voices with your own OpenAI key.
- Choose the assistant's name, which becomes the wake word. Follow-ups without the wake word, natural conversation endings, barge-in, push-to-talk, and automatic recovery from microphone changes.
- Short spoken greetings on sign-in, unlock and return, which stay quiet during calls, full-screen apps, media, Focus mode and quiet hours.

**Everyday helpers**
- Local answers for time, date and small talk; weather from Open-Meteo; "lock my PC".
- Read-only Gmail: your own Google OAuth client (recommended) or an app password.
- Chat with Cadabra from your phone through the WhatsApp Agent Platform: owner-only pairing, one-time confirmation codes for risky actions, remote stop, voice notes, pictures and on-request screenshots.

**Project**
- MIT licence, third-party notices shipped in the installer, contributor guide, code of conduct, security policy, issue and PR templates, and CI on Windows (typecheck, lint, unit tests, Rust tests and release build).
