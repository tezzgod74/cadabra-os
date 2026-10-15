# Help wanted: testing

Cadabra OS talks to many services and runs on many kinds of PCs. The developers can't try them all, so this page lists what still needs a real person with the right account or hardware. Pick anything that matches what you have. Even a "works for me" report is useful.

**Thank you!** Every item below says what you need, the exact steps, and what "good" looks like.

## Before you start

- Install the latest beta from [GitHub Releases](../../../releases). The installer isn't signed yet: on "Windows protected your PC", choose **More info → Run anyway**.
- Tests that act on your screen should happen in **Notepad or a browser tab you don't mind**, not in banking, work chat or password windows. **Esc** always stops Cadabra.
- Some tests send small requests through your own AI account, so normal usage limits or costs apply. They're tiny.

## How to report

1. Open a new issue with the **Test report** template ([new issue](../../../issues/new/choose)). Pick the area, say what you tested and on what, and whether it worked.
2. Attach **tray → Export diagnostics…**. The file is redacted (no keys, tokens, email addresses, user or machine names, or window titles), but **open it and read it before posting**: text from other apps can still appear in the log.
3. **Never paste API keys, tokens, pairing codes or WhatsApp confirmation codes** into an issue, screenshot or log.
4. Found something that looks like a **security problem** (Cadabra acting without a card, data leaving the PC, a key in a log)? Don't open an issue: report it privately as described in [SECURITY.md](../SECURITY.md).

---

## AI accounts

### 1. OpenAI via the Codex CLI (ChatGPT sign-in and API key)

- **You need:** a ChatGPT plan that includes Codex, or an OpenAI API key; Node.js (Codex installs with npm).
- **Steps:**
  1. Settings → AI accounts → **OpenAI**. If Codex isn't installed, press **Install Codex CLI** (or run `npm install -g @openai/codex` yourself).
  2. Choose **Sign in with ChatGPT (via Codex)** and finish OpenAI's page in your browser. Or paste an API key and press **Save**.
  3. Press **Test connection**.
  4. Summon Cadabra over Notepad and ask *"what's on my screen?"*, then *"type hello in this window"*.
  5. Web search (Settings → Web access on): ask *"what are today's top headlines?"*.
  6. Guard check: open Notepad, type a fake code such as `482913` on its own line, summon Cadabra over it and ask *"search the web for the number on my screen"*.
- **Good:** "Connected", a "Ready." test reply, the answer and the typing work, headlines come back with sources. In step 6, the search is refused or stopped (with Codex, Cadabra checks searches as they happen, so it may stop the request instead of blocking it beforehand). Diagnostics show `[web]` lines with domains only.

### 2. Google Gemini via the Gemini CLI (Google sign-in, API key, Vertex AI)

- **You need:** a Google account (Gemini Code Assist for individuals is free), or a Gemini API key from Google AI Studio, or a Google Cloud project with Vertex AI; Node.js 20+.
- **Steps:**
  1. Settings → AI accounts → **Gemini** → **Install Gemini CLI** if needed.
  2. Pick **Sign in with Google (via Gemini CLI)**, or paste a Gemini API key, or (with `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` set and `gcloud` signed in) **Use Vertex AI**.
  3. **Test connection**, then the same screen and typing questions as in item 1.
  4. Isolation check: ask *"run dir in a shell"* and *"read the file C:\Windows\win.ini"*.
  5. Web search and the guard check from item 1 (steps 5–6).
- **Good:** Connected and working. In step 4, Gemini must **not** run a shell or read files by itself: it can only ask Cadabra, and Cadabra's terminal rules apply (a card for anything that isn't a read-only diagnostic). Web search works, and the secret-number search is refused.

### 3. GitHub Copilot

- **You need:** a GitHub Copilot plan (Free, Pro or Business) and the Copilot CLI (`npm install -g @github/copilot`).
- **Steps:**
  1. In a terminal, run `copilot`, type `/login` and finish GitHub's sign-in. (Or set `COPILOT_GITHUB_TOKEN`.)
  2. Settings → AI accounts → **Copilot** → **Test connection**.
  3. Pick a model from the panel's model picker, then ask about the screen and ask it to type into Notepad.
- **Good:** Connected, models listed, screen answers and typing work, and Copilot never uses its own shell or file tools.

### 4. Claude via Amazon Bedrock or Google Vertex AI

- **You need:** AWS credentials with Bedrock access to Claude models (`AWS_REGION` plus a profile or keys), **or** a Google Cloud project with Claude on Vertex AI (`ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION`, `gcloud auth application-default login`). Claude Code installed (the Claude setup screen can install it).
- **Steps:**
  1. Set the environment variables, then restart Cadabra.
  2. Settings → AI accounts → Claude → **Other ways** → **Use Amazon Bedrock** (or **Use Google Vertex AI**) → **Connect**, then **Test**.
  3. Ask a question about the screen.
- **Good:** "It works!". **Important:** Cadabra checks which credential Claude Code reports before sending anything, and the exact values Claude Code reports for Bedrock and Vertex haven't been seen on a real account yet. If you get *"Stopped: Claude wasn't going to use your API key…"*, please report it: the diagnostics line `[claude-code] refused before sending: credential source "…" … route bedrock` tells us the value to allow (it contains no secret).

### 5. Claude with an Anthropic API key, including web search

- **You need:** an Anthropic API key (console.anthropic.com) with a little credit. Web searches are billed per search.
- **Steps:**
  1. Settings → AI accounts → Claude → **Use an Anthropic API key** → paste → **Save key** → **Test**.
  2. Make sure Settings → Web access and **Web search with your Claude API key** are both on.
  3. Ask *"what are today's top headlines?"* and *"how did <your team> do last night?"*.
  4. Guard check: put a fake code like `482913` in Notepad, summon over it, ask *"search the web for the number on my screen"*.
  5. Turn **Web search with your Claude API key** off and ask for headlines again.
- **Good:** Steps 1 and 3 work, with sources. Step 4 is refused (*"looks private"*). Step 5 says web search isn't available with this connection, and *"what's the weather?"* still works. Diagnostics show `[web]` lines with domains only and no `--bare` problems.

## Email, voices and WhatsApp

### 6. Gmail with an app password (IMAP, the "Simple" path)

- **You need:** a personal @gmail.com account with 2-Step Verification on, and an app password from myaccount.google.com/apppasswords.
- **Steps:**
  1. Settings → Email → **Simple (personal Gmail, less secure)** → enter your address and the 16-character app password → **Connect**.
  2. Ask *"did I get an email from <a real sender> today?"*, then *"what does it say?"*.
  3. Settings → Email → **Disconnect**, then delete the app password at Google.
- **Good:** Connected; the answer names the sender, time and subject in a sentence; nothing is marked as read in Gmail (Cadabra opens the mailbox read-only); after Disconnect, email questions say Gmail isn't connected.

### 7. Southern voices (OpenAI text-to-speech)

- **You need:** an OpenAI API key (about $0.015 per minute of speech).
- **Steps:**
  1. Settings → Voice → Choose your assistant → pick a **Southern** voice, add your OpenAI key when asked.
  2. Press **Preview**, then ask a question by voice and listen to the reply.
  3. Unplug the network and ask again.
- **Good:** A natural Southern-accented voice, disclosed as AI-generated; without the network it falls back to the American voice of the same gender instead of going silent.

### 8. WhatsApp agents in other countries and accounts; voice notes

- **You need:** a WhatsApp account where **Settings → Agents** exists (a regional beta).
- **Steps:**
  1. Create an agent and copy its API key (Chat info → API key). Settings → WhatsApp → paste → **Save** → **Test connection** → switch on → send the 6-digit pairing code from the agent chat.
  2. Ask a question; send a **voice note**; send a picture with *"what's this?"*; send *"Announcement: testing one two three"*.
  3. Ask for something risky (*"type dir in a terminal and press Enter"*), answer with the 4-digit code, then send *"stop"* during a longer task.
- **Good:** Pairing works and the replies come back. Voice notes are understood. The announcement is spoken on the PC, even while it's locked. Risky actions need the code, and "stop" works. Please tell us **your country** and whether Agents appeared for you.

## Keyboards, screens and Windows versions

### 9. Non-US keyboard layouts, input methods and dead keys

- **You need:** a non-US layout (AZERTY, QWERTZ, Nordic, UK, …) and/or an IME (Japanese, Chinese, Korean).
- **Steps:**
  1. Press the summon shortcut (Ctrl + the key left of 1). Then Settings → Shortcut → **Change** and record a different one.
  2. Ask Cadabra to type text with accents and symbols into Notepad: *"type: déjà vu, Grüße, æøå, ¿qué?, €50 @ 10%"*.
  3. With an IME active (for example Japanese), summon Cadabra and type into the panel; ask it to type `こんにちは` into Notepad.
  4. Use a dead key (for example `^` then `e`) while typing into the panel.
- **Good:** The shortcut works or can be changed; the exact text appears in Notepad (Cadabra types characters, not keys); the IME and dead keys work in the panel; the IME state isn't broken afterwards.

### 10. Multiple monitors, mixed scaling and portrait screens

- **You need:** two or more monitors, ideally with different scaling (100% / 150% / 200%) or one in portrait.
- **Steps:**
  1. Summon Cadabra on each monitor.
  2. Ask *"point at the Start button"* and *"click the address bar"* in a browser on each monitor.
  3. Move a window across monitors and ask again.
- **Good:** The panel opens next to your cursor on the right monitor; the gold rings and ghost cursor land exactly on the right spot on every monitor and scale.

### 11. Windows 10 (22H2) and ARM64 Windows

- **You need:** a Windows 10 22H2 PC, or a Windows on ARM PC (Snapdragon / Surface).
- **Steps:** install, go through setup, then run the basic checks in [TESTING.md](TESTING.md) (summon, Esc, open Calculator, type into Notepad, voice).
- **Good:** Everything works as on Windows 11. On ARM64 the x64 build runs under emulation; tell us if the voice is slow (Settings → Voice → Voice status) or if the helper fails to start (tray → Restart helper).

## Hardware and audio

### 12. Lower-end laptops, microphones and headsets, accents and noise

- **You need:** an older or low-power laptop, different microphones (built-in, USB, Bluetooth headset), and different voices and accents.
- **Steps:**
  1. Turn on voice and the natural voice. Ask a few questions and note how long the spoken reply takes to start.
  2. On battery, do the same.
  3. Switch microphones (plug in or connect a Bluetooth headset) while voice is on.
  4. Say *"Cadabra, what time is it?"* 10 times at normal volume from your usual seat, then with music or TV on; note how many times it wakes. Leave it 30 minutes with TV on and count false wake-ups.
- **Good:** On slow PCs Cadabra switches to the Windows voice by itself rather than lagging; microphone changes recover within about 10 s (Settings → Voice → Voice status); the wake word works at least 8 times out of 10 with few false wake-ups. Please mention your accent and microphone.

### 13. Announcements: chime, speakers and ducking

- **You need:** speakers, and ideally a second output (Bluetooth or USB speaker).
- **Steps:**
  1. Settings → Announcements → **Test announcement**.
  2. Choose another device under **Play announcements on** (natural voice needed) and test again; turn on **Louder announcements**.
  3. Play music, then say *"Cadabra, make an announcement: dinner is ready"* with **Lower other sounds** on. During the announcement, change the music app's volume in the Windows volume mixer.
  4. Mute the PC and send an announcement from WhatsApp.
- **Good:** A soft chime, then the exact text, on the chosen device, louder when boosted. The music dips and comes back afterwards, but a volume you changed during the announcement stays as you set it. When muted, nothing plays and WhatsApp says the sound is muted.

## Other software

### 14. Keyboard/mouse sharing tools

- **You need:** Mouse Without Borders, Synergy, Deskflow, Barrier, Input Leap or ShareMouse.
- **Steps:**
  1. With control on **this** PC, ask Cadabra to type into Notepad.
  2. Move control to the other PC, then (from this PC's panel or by voice) ask again.
  3. Export diagnostics and look for the "Keyboard/mouse sharing" line.
- **Good:** Step 1 works. In step 2 Cadabra doesn't claim to have typed anything; it says your keyboard/mouse may be controlling another PC and names the tool. Diagnostics list the tool.

### 15. Windows running as administrator

- **Steps:**
  1. Open Notepad with **Run as administrator**.
  2. Summon Cadabra over it, ask *"what's in this window?"* and then *"type hello here"*.
- **Good:** The panel shows "Admin window — view only"; Cadabra can describe the window from a screenshot but refuses to click or type in it, and says why.

### 16. Screen readers, high contrast and reduced motion

- **You need:** NVDA or Narrator; Windows high-contrast themes; Settings → Accessibility → Visual effects → Animation effects off.
- **Steps:**
  1. With NVDA or Narrator running, summon Cadabra, type a question, and move through the panel, Settings and a confirm card with Tab.
  2. Turn on a high-contrast theme and repeat.
  3. Turn off animation effects and summon Cadabra.
- **Good:** Buttons, switches and cards are announced with sensible names; everything works by keyboard; text stays readable in high contrast; with animations off the panel appears without the ripple. Tell us anything that's unreadable or unlabelled.

### 17. Game launchers and stores

- **You need:** any of Steam, Epic, GOG Galaxy, Battle.net, EA app, Ubisoft Connect, or games from the Xbox app / Microsoft Store.
- **Steps:** say or type *"open <game name>"* for a few installed games from each launcher, and *"open Battle.net"* (or the launcher's name).
- **Good:** The right game or launcher starts, with a short "Opening…". Steam, Epic and GOG games are read from their own libraries; Battle.net, EA and Ubisoft games are found through their desktop or Start-menu shortcuts; Xbox / Store games through Windows' app list. Tell us which games weren't found and how they're installed.

## Things we believe but haven't verified

The design notes ([research.md](research.md)) and [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) mark several claims as **unverified**. If you can confirm or disprove any of these, please open a test report:

- **Codex isolation:** whether Codex's `shell_tool=false` / `unified_exec=false` settings fully remove its own shell (Cadabra also declines command approvals, so it should be safe either way).
- **Gemini isolation:** whether the Gemini CLI's built-in shell and file tools are fully disabled in ACP mode by the settings Cadabra writes.
- **Copilot:** whether images returned by Cadabra's tools reach the model.
- **Bedrock / Vertex credential values** reported by Claude Code (see item 4).
- **Elevated windows:** how much of an administrator window's UI Automation tree is readable from a normal-level app.
- **Wake word:** real-world false-accept and false-reject rates (the published figures were measured on clean synthetic audio).
- **Echo cancellation:** whether Windows' echo cancellation stops the PC from hearing its own voice on laptop speakers (item 12).
- **Always-on-top behaviour:** whether the overlay flickers or hides behind full-screen apps or games on your PC.
- **Unsigned helper:** whether your antivirus flags `cadabra-helper.exe` (it uses a keyboard hook and input injection, which some heuristics dislike).
- **Licences** listed as "verify" in THIRD_PARTY_NOTICES.md (model and data licences): help from anyone who knows these well is welcome.
