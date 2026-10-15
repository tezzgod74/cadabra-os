# Testing

There are two kinds of testing: the automated suites, which run on any Windows machine and in CI, and a hands-on checklist for what only a person at a real keyboard, microphone and speakers can check.

## Automated tests

| Command | What it runs |
|---|---|
| `npm run typecheck` | TypeScript (`tsc --noEmit`). |
| `npm run lint` | ESLint over `src` and `test`. |
| `npm test` | Vitest unit tests. No network, no microphone, no real input. |
| `npm run test:native` | Rust unit tests for the helper. |
| `npm run smoke:helper` | Exercises the helper (UI Automation, capture, input) against its own throwaway test window. It injects real input, so don't touch the PC while it runs. |

Opt-in integration tests skip themselves unless their environment variables are set:

| Test | Enable with |
|---|---|
| `test/voice*.integration.test.ts`, `test/scenarios.integration.test.ts` | `CADABRA_ASR_DIR=<parakeet folder>` and `CADABRA_WAV_DIR=<folder of test clips>` |
| `test/endpoint.integration.test.ts` | `CADABRA_ASR_DIR` and `CADABRA_ENDPOINT_WAVS` |
| `test/tts.integration.test.ts` | `CADABRA_TTS_DIR=<kokoro-multi-lang-v1_0 folder>` (writes WAVs, never plays them) |
| `test/terminal.integration.test.ts` | `CADABRA_TEST_TERMINAL=1` (opens real PowerShell consoles) |
| `test/models.download.integration.test.ts` | `CADABRA_TEST_DOWNLOAD=1` (downloads the speech model) |
| `test/helper-restart.test.ts` | Runs when `native/cadabra-helper/target/release/cadabra-helper.exe` exists |

Other dev modes (see `README.md` and `CONTRIBUTING.md`): `npm run demo`, `npm run screenshots`, `npm run selftest`, `npm run e2e:live -- --provider <id>`, and `electron . --voicetest=<file.wav>` (plays a WAV through Chromium's fake microphone).

## Hands-on checklist

About 60 minutes for everything; each section stands alone. Close important work first. Cadabra only acts in the window you summon it on, and **Esc always stops it**. Don't point it at banking, password or work-chat windows during testing. If you use a keyboard/mouse sharing tool (Input Director, Mouse Without Borders, Deskflow…), keep control on this PC.

Anything that needs your AI sends a few short requests through the account you connect, so normal usage limits or API costs apply.

### 1. Install

- [ ] Run `CadabraOS-Setup-<version>.exe`. The installer is unsigned, so SmartScreen warns: **More info → Run anyway**.
- [ ] A gold spark appears in the tray, and the setup panel opens by itself. No admin prompt.

### 2. Onboarding

- [ ] Try the shortcut, enter a name, pick and connect an AI, then press **Test** ("Ready."). For Claude, see 2a.
- [ ] Turn on voice and a natural voice; the downloads finish with progress bars.
- [ ] No email addresses are shown anywhere, and each sign-in choice has an honest note.

### 2a. Setting up Claude (fresh PC)

Try this on a PC (or Windows account) without Claude Code.

- [ ] Pick **Claude**. The card shows three steps: *Get the Claude Code app*, *Connect your Claude account*, *Test it*. The words are plain: no "CLI", "PATH" or "binary".
- [ ] **Install Claude Code** shows exactly what will run and waits for **Install**. **Cancel** goes back without running anything.
- [ ] After **Install**, a progress bar runs, and within a couple of minutes step 1 says *Claude Code is installed on this PC*.
- [ ] Unplug the network and try again: the error says the download didn't work, in plain words, and **Install it yourself instead** opens with numbered steps, a **Copy** button and a link to Anthropic's install page. Follow them, then **Check again** finds it.
- [ ] **Subscription:** **Sign in** opens Claude Code's own sign-in window; after you finish, the chip says *Connected*.
- [ ] **API key:** the link opens console.anthropic.com; paste a key and **Save key**; the chip says *Connected*. A wrong or empty key gives a clear message and nothing is sent.
- [ ] **Test** says *It works! Claude answered: "Ready."*
- [ ] Switching between subscription and API key and pressing **Test** again works each time.
- [ ] With an API key and **Web search with your API key** on, ask for today's news: an answer with sources. Turn the switch off and ask again: Claude says it can't search the web; *"what's the weather?"* still works.

### 3. Summon and type immediately

- [ ] With the cursor in Notepad, press **Ctrl + ~** and immediately type `what is this window`, then Enter.
- [ ] Your words land in Cadabra's box, none in Notepad, and the question is sent. **Ctrl + ~** again closes the panel.

### 4. Esc stops everything

- [ ] Ask Cadabra to type a long paragraph into Notepad, and press **Esc** while it types. It stops within a keystroke or two and says "Stopped." Close Notepad without saving.

### 5. Voice

- [ ] **Push-to-talk:** turn on *Push-to-talk only*, hold **Ctrl + Win**, ask the time, release. Pressing and releasing without speaking says it didn't hear anything.
- [ ] **Wake word:** from 2–3 metres, say *"Cadabra, are you there?"* at normal volume. *"Abracadabra"* and a TV in the background should **not** wake it.
- [ ] **Barge-in:** ask for a short story and say *"Cadabra, stop"* mid-reply, once on laptop speakers and once on a headset. It stops at once and never answers its own voice.
- [ ] **Scenario A:** *"Cadabra, are you there? What time is it."* → *"Good morning, <name>. It's 10:21 AM. Anything I can help you with?"* → *"No. Thanks."* → *"Anytime."* and the panel fades.
- [ ] **Scenario B:** *"Cadabra, open a terminal and do an nslookup for 8.8.8.8."* Then, without the wake word: *"I'm not looking at the screen. What's the output?"* → *"8.8.8.8 resolves to dns.google."*
- [ ] **Mic disruption:** switch the Windows default input device and back. Within about 10 s, Settings → Voice → **Voice status** shows a restart and then "listening" again, and the wake word still works.
- [ ] **Idle soak:** 10 minutes with music or TV on: no false wakes, and it still responds afterwards.

### 6. Apps, pages and the confirm card

- [ ] *"Open Calculator"* opens Calculator within a second or two.
- [ ] *"Open YouTube in Chrome"* opens without a card. A link that only appears on your screen, or a look-alike such as `google.evil.com`, shows a card with the **full address** first.
- [ ] In Notepad, type *"close this window"*: a **"Close Notepad?"** card appears. Press **Not now**; nothing happens.
- [ ] By voice: *"run `Get-ChildItem C:\ -Recurse` in a terminal"* shows the exact command on a card. Say *"No."*

### 7. Choose your assistant

- [ ] Settings → Voice → **Choose your assistant**: preview a few voices and pick a name. The new name wakes it and the old one no longer does. Try a custom name and **Test: say "<name>, hello"**.

### 8. Doing things for you

- [ ] *"Open Notepad and type 12345"*: the number appears with no card, and Cadabra only says it typed it if it really did.
- [ ] Try each autonomy level (Settings → Safety): *Ask only for risky actions* (ordinary clicks just happen, a send asks first), *Ask before every action* (every action asks; try **Always allow** and revoke it in Settings), and *Don't ask*. Set it back to the default.
- [ ] Typing *cmd* + Enter into the Explorer address bar shows a card. In VS Code, typing in the editor doesn't ask, but typing in the integrated terminal does.
- [ ] On a sign-in or checkout page, clicking *Continue* or *Sign in* shows a card without an "Always allow" option.

### 9. Conversations, web and weather

- [ ] Say *"Okay, thank you"*, *"perfect"* or *"that's all"* after an answer: the panel fades at once and it stops listening. *"Thanks, and also open the calculator"* must **not** close.
- [ ] Weather: if no city is set, it asks once and remembers. *"Weather tomorrow"* answers in about a second.
- [ ] News and sports: short spoken answers, sources as links in the panel. With **Web access** off in the tray, it says web access is off.
- [ ] With a video playing, a question still works, but follow-ups need the name and the video is never answered.

### 10. Lock and greetings

- [ ] *"Cadabra, lock my PC"* locks like Win+L; while locked, the wake word does nothing.
- [ ] Unlock: a short spoken hello within about a second, with no window. Answer *"haha very funny"* within 4 s and it banters back.
- [ ] Stay away for 20+ minutes, then move the mouse: one hello.
- [ ] During a call (or a test call), with a full-screen video, in Focus mode or with speakers muted: no greeting. During a call, *"lock my PC"* refuses; *"lock my PC anyway"* locks.
- [ ] *"Stop greeting me"* turns greetings off; *"greet me again"* turns them back on.

### 11. Gmail (optional)

- [ ] Settings → Email → **Secure (recommended)**: follow the steps with your own Google Cloud OAuth client and connect.
- [ ] *"Did I get an email from <sender> today?"* gives who, when and what in a sentence. *"What does it say?"* summarises it; a click or type request afterwards asks first.
- [ ] **Disconnect** revokes access: the project disappears from myaccount.google.com/permissions.

### 12. WhatsApp (optional)

- [ ] Settings → WhatsApp: paste your agent's API key, **Save**, **Test connection**, then turn the switch on and pair with the 6-digit code.
- [ ] Ask a question; ask it to open Notepad and type something. The PC shows a pill and the ghost cursor while it works.
- [ ] A risky request asks in the chat with a one-time code; "yes" alone doesn't approve it, and the request expires after 2 minutes.
- [ ] *"stop"* in the chat, or Esc at the PC, stops a running request.
- [ ] Voice notes and pictures work. *"Show me my screen"* sends a screenshot only when asked.
- [ ] With the PC locked, it says so and does nothing.

## Reporting a problem

1. Note the step, what happened and the time.
2. Tray → **Export diagnostics…**. The file has versions, settings and the recent log, with email addresses, keys, tokens, user and machine names, the display name and window titles removed. Text from other apps can still appear, so **open it and review it before posting**.
3. Open an issue with your notes and the file. If something felt unsafe (Cadabra acted somewhere it shouldn't have, or skipped a card for something risky), press Esc, pause Cadabra from the tray and report it privately as described in [SECURITY.md](../SECURITY.md).

## Uninstall

1. Tray → **Quit Cadabra**.
2. Windows Settings → Apps → Installed apps → Cadabra OS → Uninstall.
3. Delete `%APPDATA%\Cadabra OS` (settings, logs and about 450 MB of voice models).
4. The AI CLIs you installed (Claude Code, Codex, Gemini CLI, Copilot) stay installed and signed in; remove them separately if you want.
