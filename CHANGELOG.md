# Changelog

All notable changes to Cadabra OS are listed here. The project follows [Semantic Versioning](https://semver.org/); before 1.0, minor versions may include breaking changes.

## Unreleased

## 0.9.4

- **Fixed: a stale status line in the PC panel after a WhatsApp request.** Progress captions from a WhatsApp run (for example "Checking the note was saved") were written into the PC panel's status/HUD and never cleared, so every later summon showed them. Captions are now per channel: WhatsApp runs update only the on-screen WhatsApp pill, PC runs only the panel. Every run end clears its own caption (even if the panel was hidden when it was set), an idle summon starts with no status, and any status or caption from an older run is ignored.
- **Web guard deadline:** Cadabra's web check for Claude Code always answers with an explicit allow or deny within 100 seconds (Claude Code waits up to 120), so Claude Code's own pre-approved documentation hosts can never be fetched just because Cadabra didn't answer. (Deny rules for those hosts were tested and not added: they would also block pages the user approved.)
- **Privacy note:** with Claude, each web page it fetches also sends that page's domain to Anthropic for Claude Code's own safety check. README, SECURITY.md and Settings → Web access now say so.

## 0.9.3

- **Web search with your Claude API key:** a new switch, in Settings → Web access and in the Claude setup's Connect step, on by default. With it on, Claude with an API key (or Bedrock / Vertex) can search and read the web, and Cadabra checks every search first. Anthropic bills web searches per search. To make Cadabra's check possible, Claude Code runs without `--bare` in this case; everything else stays locked: a private empty settings folder, no other credentials in its environment, only Cadabra's tools plus web search and fetch, no user or project settings, memory files, plugins, MCP servers or hooks, an empty working folder, and the "is it really your API key?" check before anything is sent. With the switch off, nothing changes from 0.9.2.

## 0.9.2

- **Web search and Claude API keys:** Claude Code's `--bare` mode (used for API key, Bedrock and Vertex) turns off hooks and its web tools, so Cadabra's web guard couldn't check searches there. Those routes no longer offer web search at all; Settings → Web access says so, and Claude tells you plainly if you ask for current news. Web search keeps working with the Claude subscription, Codex, Gemini and Copilot; weather works everywhere.
- **API-key route:** also removes other providers' credentials (Foundry, Bedrock bearer tokens, Vertex project settings) and every other `ANTHROPIC_*` setting from Claude Code's environment.
- Wording: Claude Code is free to install; using Claude needs a Claude plan or an API key.

## 0.9.1 — Claude through your own Claude Code

- **No Anthropic SDK in the installer any more.** Both Claude modes (your subscription, or an API key; also Bedrock and Vertex) now run through your own, separately installed Claude Code app. The proprietary `@anthropic-ai/claude-agent-sdk` package was removed.
- **API-key mode keeps every safeguard:** Claude Code runs in `--bare` mode with only Cadabra's tools, a private empty settings folder, OAuth variables removed and the key given only to that process. Before anything is sent, Claude Code must report that it is using your API key, or the request stops; each turn is checked again.
- **Friendly Claude setup:** a three-step screen (get the Claude Code app, connect your account, test) with a one-click installer, plain-language errors, step-by-step manual instructions with copy buttons, and links to Anthropic's install and API-key pages.

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
