# Architecture

Cadabra OS has three parts:

- an **Electron app** (TypeScript) for the UI, conversations, AI backends, the safety gate and voice;
- a small **Rust helper** (`cadabra-helper.exe`) for everything that needs Win32: global hooks, UI Automation, screen capture and input injection;
- the **AI backends**: the official CLIs and SDKs from Anthropic, OpenAI, Google and GitHub. They run as separate processes and only see Cadabra's own tools.

```
     summon shortcut (default Ctrl+~) / Esc / Ctrl+Win (push-to-talk)
                         │  WH_KEYBOARD_LL (+ WH_MOUSE_LL only for a mouse binding);
                         │  own thread, re-installed every 30 s
┌────────────────────────▼─────────────────────────┐
│ native/cadabra-helper.exe  (Rust, PerMonitorV2)  │  stdin/stdout NDJSON-RPC
│ hooks + set_binding · caret · UIA tree · capture │  coordinates = PHYSICAL px
│ concurrent lanes (inline/uia/input/capture/ctl)  │  cancel flag checked between
│ SendInput click/type/keys/scroll · invoke/value  │  keystrokes (Esc / cancel RPC)
│ foreground · list/close windows · DWM styling    │
│ session events (lock/unlock) · audio sessions    │
└────────────────────────▲─────────────────────────┘
                         │ HelperClient (src/main/helper.ts)
┌────────────────────────┴───────────────────────────────────────────────────────┐
│ Electron main (src/main)                                                        │
│  app.ts ─── summon flow, tray, settings IPC, Esc kill switch, wiring            │
│  conversation.ts ─── voice/typed conversation state machine (Electron-free)     │
│  tools.ts ─── the tool host: see_screen read_ui highlight click type_text       │
│               press_keys scroll launch_app run_in_terminal open_url lock_pc …   │
│  safety-gate.ts ─── every action passes here (rules in src/shared/safety.ts,    │
│                     src/shared/terminal.ts, src/shared/web-guard.ts)            │
│  claims.ts ─── honesty check: which tools back which first-person claims       │
│  providers/ ─── claude.ts, claude-cli.ts, codex.ts, gemini.ts, copilot.ts, demo │
│  mcp-http.ts ─── the same tools as Streamable-HTTP MCP on 127.0.0.1 + token     │
│  voice/ ─── sherpa-engine.ts → utilityProcess voice-engine.ts (KWS+VAD+ASR),    │
│             Kokoro TTS worker, optional OpenAI cloud voices                     │
│  greeter.ts, media-watch.ts, mic-usage.ts ─── spoken greetings and when to stay │
│                                               quiet                             │
│  email/ ─── read-only Gmail (own OAuth client, or IMAP app password)            │
│  whatsapp/ ─── WhatsApp Agent Platform client and remote bridge                 │
│  apps/ ─── app index (Start menu, Desktop, Store, Steam, Epic, GOG, App Paths)  │
│  settings-store.ts ─── settings.json + secrets.json (safeStorage / DPAPI)       │
└──────┬──────────────────────┬───────────────────────┬──────────────────────────┘
       │ IPC (contextIsolation, sandbox, single preload src/preload/bridge.ts)
┌──────▼───────┐   ┌──────────▼──────────────┐   ┌────▼─────────────────────────┐
│ panel window │   │ overlay windows (one per │   │ hidden mic window            │
│ acrylic chat,│   │ display): transparent,   │   │ getUserMedia → AudioWorklet  │
│ model picker,│   │ click-through, top-most: │   │ @16 kHz → MessagePort → voice│
│ settings,    │   │ ripple, scan, rings,     │   │ utilityProcess; TTS playback │
│ onboarding   │   │ ghost cursor, pills      │   │                              │
└──────────────┘   └──────────────────────────┘   └──────────────────────────────┘
```

## Source layout

| Path | What lives there |
|---|---|
| `src/main/` | Electron main process. `index.ts` parses flags and starts `CadabraApp` (`app.ts`). |
| `src/main/composition.ts` | Builds the helper-backed dependency objects that the app and the tests share. If you add a dependency to the tool host, wire it here so the installed app and the tests use the same code. |
| `src/preload/bridge.ts` | The one preload script. It exposes a narrow, typed API to the renderers. |
| `src/renderer/panel/` | The chat panel, settings, onboarding, account cards and autonomy settings. |
| `src/renderer/overlay/` | Full-screen, click-through overlays: highlight rings, ghost cursor, status pills. |
| `src/renderer/mic/` | Hidden window that owns the microphone stream. |
| `src/renderer/demo/` | The visual preview stage (`npm run demo`, `npm run screenshots`). |
| `src/shared/` | Pure TypeScript shared by main, renderers and tests: settings schema, safety rules, intents, small talk, spoken-text normalisation, domain parsing, voices. Most unit tests target this folder. |
| `native/cadabra-helper/` | The Rust helper. `main.rs` (RPC dispatch and lanes), `hook.rs` (keyboard and mouse hooks), `uia.rs` (UI Automation), `capture.rs`, `input.rs` and `keys.rs` (SendInput), `session.rs` (lock/unlock, presence, audio sessions), `win.rs` (windows and DWM), `testwin.rs` (a throwaway test window for smoke tests). |
| `resources/models/` | Wake-word and VAD models shipped in the installer. |
| `scripts/` | Build and dev scripts: Electron launcher, icon generator, helper smoke test, voice samples, wake-word matrix, live-readiness harness. |
| `test/` | Vitest unit tests plus opt-in integration tests (`*.integration.test.ts`). |

## The helper protocol

The app starts `cadabra-helper.exe` and talks to it over stdin/stdout with newline-delimited JSON-RPC. Requests run on separate "lanes" (inline, UIA, input, capture, control), so a slow UI Automation query never blocks an Esc or a cancel. Input calls check a per-run cancel epoch between keystrokes: Esc sets the flag inside the helper itself, so typing stops within a keystroke or two even if the main process is busy.

If the helper exits, `HelperClient` restarts it and re-applies its state (shortcut binding, armed hooks). See `test/helper-restart.test.ts`.

## Coordinate spaces

See `src/shared/coords.ts`.

- **Physical pixels**: the helper, UI Automation, capture and clicks.
- **DIPs**: Electron windows. Convert with `screen.screenToDipPoint` / `screenToDipRect`.
- **Image pixels**: the screenshots the model sees, mapped as `physical = rect.origin + img × scale`.
- **Overlay-local**: DIPs minus the display origin.

The model clicks by **UI Automation element id** (preferred) or by **screenshot pixel**. Before every coordinate click, the helper reports which window and element are really under that point, and the safety checks run again on that element.

## A request, end to end

1. The keyboard hook sees the summon shortcut, or the voice engine hears the wake word. The panel opens at the cursor and keystrokes typed during the animation are buffered into the input box.
2. `conversation.ts` decides whether the request is local or goes to the AI:
   - local fast paths (`src/shared/smalltalk.ts`, `src/shared/intents.ts`): time, greetings, "open Spotify", settings changes, weather, lock;
   - everything else goes to the selected provider with a per-request system prompt. Screen text is wrapped in a `<screen-NONCE>` tag and marked as data.
3. The provider calls Cadabra's tools, in-process or over the local MCP endpoint. Each call goes through `ToolHost` (`tools.ts`), which:
   - checks that the call belongs to the current run (stale calls from a stopped session are refused);
   - looks up the real target (focused element, window, elevation, input state). If a required lookup fails, the action is refused rather than guessed;
   - asks the **safety gate** for a decision.
4. The gate classifies the action (`src/shared/safety.ts`) and the current autonomy level (ask for risky actions / ask for every action / don't ask) and returns *allow*, *confirm* or *block*. For *confirm*, the gate renders the card itself from the real arguments; the model never writes it.
5. The helper performs the action. The overlay shows the ghost cursor and rings. Esc at any point cancels the run.
6. The reply streams back. Speech starts on the first complete sentence. Before a reply is shown or spoken, the honesty check (`claims.ts`) compares first-person claims ("I sent…", "I typed…") with the tools that actually succeeded in this run. Unbacked claims are corrected.

## Providers

Each backend gets only Cadabra's tools. Built-in shell, file and web tools are off unless noted.

| Provider | How it runs | Isolation |
|---|---|---|
| Claude (subscription) | The user's own installed, unmodified `claude` CLI in stream-JSON mode (`providers/claude-cli.ts`). | `--tools ""`, `--strict-mcp-config` with only Cadabra's MCP server, `--setting-sources ""`, `--permission-mode dontAsk`, no session persistence, `ANTHROPIC_API_KEY` removed from its environment. |
| Claude (API key, Bedrock, Vertex) | Claude Agent SDK, one process per chat (`providers/claude.ts`). | `tools: []`, `allowedTools: mcp__cadabra__*`, private empty config folder, all OAuth variables scrubbed, refuses to run unless the runtime reports API-key auth. Per-chat budget cap. |
| OpenAI | `codex app-server` over JSON-RPC (`providers/codex.ts`). | Private `CODEX_HOME`, read-only sandbox, approval policy `never`, shell features off, file and command approvals declined. |
| Gemini | `gemini --acp` (`providers/gemini.ts`). | Private empty workspace, built-in shell/file tools excluded, only Cadabra's MCP server; `fs/*` and `terminal/*` requests refused. |
| GitHub Copilot | Copilot SDK (`providers/copilot.ts`). | `availableTools: ['custom:*']`; other permission requests rejected. |
| Demo | Offline canned answers (`providers/demo.ts`). | — |

Optional read-only web search and fetch use each backend's own web tools. `src/shared/web-guard.ts` checks every call first.

## Voice

All wake-word and speech recognition runs locally in an Electron `utilityProcess` (`voice/voice-engine.ts`) using sherpa-onnx:

- **Wake word**: a 3.3M-parameter zipformer keyword spotter. The keyword line for the assistant's name is built from the model's own token scores (`src/shared/kws-tokens.ts`), with a few alternative token paths and near-word decoys.
- **VAD**: Silero VAD with a rolling 4 s pre-roll, so "<name>, what's this error?" works in one breath.
- **Speech-to-text**: Parakeet TDT-CTC 110M int8, downloaded on first use and checked against a pinned SHA-256. A second, fuzzy check confirms that the transcript starts with the name.
- **Text-to-speech**: Kokoro-82M v1.0 in a worker (`voice/tts-worker.ts`), with sentence-level streaming and cadence shaping (`voice/tts-shape.ts`). The Windows voices are the fallback. Optional cloud voices use the user's own OpenAI key.
- **Health**: `voice/health.ts` watches the capture and restarts it with backoff after device changes.

`greeter.ts` speaks short greetings on sign-in, unlock and return from idle. It stays quiet during calls (`mic-usage.ts`), with media playing (`media-watch.ts`), in full-screen apps, in Focus mode, when muted and during quiet hours.

## WhatsApp bridge

`whatsapp/client.ts` is a small client for the WhatsApp Agent Platform API. It long-polls `/updates` and follows the platform's documented retry rules. `whatsapp/bridge.ts`:

- pairs one owner chat with a one-time code shown on the PC, then ignores every other sender;
- turns each message into a run on its own channel, with its own stop, budget and confirmation routing;
- sends risky-action confirmations to the chat with one-time numeric codes;
- transcribes voice notes locally, downloads media only from the pinned media host, and deletes uploaded screenshots after sending;
- shows a pill on the PC while it acts. Esc at the PC or "stop" in the chat cancels the run.

## Data on disk

Everything lives in `%APPDATA%\Cadabra OS\`:

| File or folder | Contents |
|---|---|
| `settings.json` | Settings (no secrets). |
| `secrets.json` | API keys and tokens, encrypted with Electron `safeStorage` (Windows DPAPI). |
| `logs\cadabra.log` | Redacted log: no typed text, email content, keys or tokens. **Export diagnostics…** applies extra redaction (names, addresses, window titles). |
| `models\` | Downloaded speech and voice models. |
| `codex-home\`, `agent-work\` | Private working folders for the backends. |

Demo, self-test and test modes use `%APPDATA%\Cadabra OS (demo)` (or `(e2e)`), so they never touch real settings.
