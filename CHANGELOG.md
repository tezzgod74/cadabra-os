# Changelog

All notable changes to Cadabra OS are listed here. The project follows [Semantic Versioning](https://semver.org/); before 1.0, minor versions may include breaking changes.

## Unreleased

## 0.9.10

0.9.9 was never released publicly; this fixes an issue found in its pre-release review.

- **Fixed (safety): deleting Cadabra's folders could follow a junction.** Under the Node version inside Electron 44, a recursive delete follows NTFS junctions, so a junction placed inside one of Cadabra's private folders could have made *Clear chat history* (or a model update, or terminal clean-up) delete files outside them. Every recursive delete in Cadabra now walks the tree itself: a symbolic link or junction is removed as a link and never entered, and each folder's real path must be inside Cadabra's data folder (or be the exact `cadabra-term-*` temp folder), checked again right before its contents are removed. New tests build real junctions and symlinks in temporary folders and run under both system Node and Electron's own Node (`npm run test:electron-node`, also in CI).
- **Startup clean-up no longer removes history in the default mode.** With *Keep chat history: Until I clear it*, startup only removes leftover temp files older than a day (terminal output, per-session MCP/prompt/hook files, screenshots handed to Codex), never Codex, Gemini or Claude Code sessions or test reports. The *Clear when Cadabra closes* and *Clear after 1 hour of inactivity* modes still finish a missed clear.
- The clear-history note now says that GitHub Copilot keeps its sessions in your own `~/.copilot` folder, which Cadabra doesn't clear.

## 0.9.9

- **Clear chat history:** a 🗑 button in the panel, Settings → Privacy, the tray, or say *"clear my history"* / *"delete our conversation"* / *"forget this conversation"* (also from WhatsApp). It always asks first (a card at the PC, a spoken yes/no by voice, a one-time code in WhatsApp). It clears the panel and both conversation contexts (PC and WhatsApp), stops the AI sessions so they start fresh, and deletes Cadabra's own session and temp files (backend working files, Codex/Gemini/Claude Code session history in Cadabra's private folders, terminal output, test reports). It keeps settings, skills, grants, keys and WhatsApp pairing, and never touches your own `~/.claude`, `~/.codex` or `~/.gemini`. Copies elsewhere (your phone's chat, your AI provider's retention) are explained, not hidden.
- **Keep chat history** (Settings → Privacy): until I clear it (default), clear when Cadabra closes, or clear after 1 hour of inactivity. Orphaned temp files older than a day are always removed at startup.
- Fixed: Claude Code's per-session files (including a short-lived local access token) were left behind in `agent-work` when Cadabra quit; the Claude backend is now shut down properly.

## 0.9.8

- **Fixed: WhatsApp requests failing while you're away.** With the display off (and, on some PCs, the monitor dropped from the desktop entirely), screenshots and screen reading failed at once and were logged only as "error". Cadabra now wakes the display for a WhatsApp request (resetting the display timer plus one zero-distance mouse nudge), waits up to 3 s for it, and keeps it on until the request is done.
- **Locked PCs:** detected properly (session lock state plus which desktop has input). A locked PC is never unlocked; WhatsApp gets a clear answer, and announcements still work.
- **New settings (Settings → WhatsApp):** *Wake the display for WhatsApp requests* (on) and *Keep this PC awake while remote access is on* (off; prevents sleep, uses more power).
- **Diagnostics:** failing tools now log a reason (`desktop-locked`, `capture-failed:display-off`, `capture-failed:no-display`, `no-foreground-window`, `helper-error`).
- A display being woken no longer counts as "you're back" for greetings during a WhatsApp request.
- Docs: "Using Cadabra while you're away" in the README.

## 0.9.7

- **Skills, safer identity:** a skill's on/off state now belongs to its folder, not the name inside SKILL.md. A newly appearing folder never inherits another skill's state; two folders with the same name in the same place are both blocked (Settings says why) until one is renamed; and your own skill replaces a built-in one only when yours is switched on.
- **Skills, links:** symbolic links, junctions and hard-linked files in skill folders are never read.
- **Skills, reference files:** extra files are treated as information, not instructions; an address that only appears in one asks before opening. Settings → View shows them.
- **Skills:** "New skill from template" opens Notepad by its full Windows path.
- **Announcements:** overlapping announcements no longer lose each other's crash-recovery records; when sound comes back up, an app whose volume you changed during the announcement keeps your change; and the wake word returns to exactly the state it was in before.

## 0.9.6 — Announcements

- **Announcements:** "Cadabra, make an announcement: dinner is ready" (or "announce that…") at the PC, or "Announcement: …" / "Announce: …" / 📢 from WhatsApp, says the text out loud on the PC, word for word, without going to the AI. Works while the PC is locked and when spoken replies are off (the Windows voice speaks if the natural voice isn't installed). WhatsApp replies "📢 Announced on your PC" or says why not (for example, muted sound).
- **Settings → Announcements:** chime first (on), say it 1–3 times, louder playback, which speaker to play on (natural voice), lower other apps' sound while announcing (on; restored afterwards, even after a crash), respect quiet hours (off), and a Test button.
- **Safety:** only the paired WhatsApp owner; 500 characters and 6 per minute at most; the wake word is muted while announcing; Esc or "stop" cuts it short; logs never contain the text. The AI's new `announce` tool asks first unless the user asked for an announcement in that request.

## 0.9.5 — Skills

- **Skills:** teach Cadabra your own routines in plain English. A skill is a folder with a `SKILL.md` (name, when to use it, example phrases, optional voice style and expected tools) plus optional small text files. Say an example phrase and Cadabra follows your steps, by voice, in the panel or from WhatsApp. Every AI backend gets `list_skills` and `use_skill`; the context lists only names and descriptions.
- **Where:** your skills live in `Documents\Cadabra\Skills` (created on first run with a README and the template; never touched by updates). Built-in examples (`morning-briefing`, `work-setup`, `quick-note`) and a fully commented template ship in the install folder (`resources\skills`). Your skill wins over a built-in one with the same name. Folders are watched, so changes apply without a restart.
- **Settings → Skills** (also tray → Skills…, or "create a new skill called …"): turn skills on or off, see problems in plain words, read a skill's instructions, open your skills folder, create a new skill from the template (opens in Notepad), reload.
- **Safety:** new skills found on disk start switched off. Skills are instructions only: nothing is ever run, only text files are read, sizes are capped, and a skill can't change autonomy, permissions or safety checks (every action still goes through the gate). Only skill names are logged. Guide: docs/SKILLS.md; trust model: docs/SECURITY.md.

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
