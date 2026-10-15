# Contributing to Cadabra OS

Thanks for helping! Cadabra OS is a Windows desktop agent that sees the screen and acts on it, so correctness and safety matter more than speed. This guide covers setting up, testing and getting a change merged.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE). Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup (Windows 11)

You need:

- **Windows 11 x64.** The helper uses Win32 APIs, so Cadabra doesn't build or run on macOS or Linux.
- **Node.js 24** (see `.nvmrc`; `package.json` requires `>=24`).
- **Rust stable** with the MSVC toolchain (`rustup default stable-x86_64-pc-windows-msvc`), plus the **Visual Studio Build Tools** "Desktop development with C++" workload, which Rust needs to link on Windows.
- Git.

```powershell
git clone <your fork>
cd CadabraOS
npm ci                 # installs dependencies exactly as locked
npm run build:native   # builds native/cadabra-helper (release)
npm start              # builds the JS and runs the real app
```

`npm start` runs the real app with the tray, keyboard hook and panel. For UI work without hooks or AI accounts, use `npm run demo` (a fake desktop with buttons for every state) or `npm run demo:live` (real windows, offline Demo backend, no hook). Demo and test modes use a separate data folder, `%APPDATA%\Cadabra OS (demo)`, so they never touch your real settings.

## Commands

| Command | What it does |
|---|---|
| `npm run typecheck` | TypeScript check. |
| `npm run lint` | ESLint over `src` and `test`. |
| `npm test` | Vitest unit tests. |
| `npm run test:native` | Rust unit tests for the helper. |
| `npm run build:js` | Builds main, preload and renderers into `out/`. |
| `npm run build` | Builds the helper and the JS. |
| `npm run screenshots` | Re-renders `docs/screenshots/NN-*.png` from the demo stage. |
| `npm run smoke:helper` | Drives the helper against its own throwaway test window (real input; don't touch the PC while it runs). |
| `npm run dist` | Builds everything and the NSIS installer `dist/CadabraOS-Setup-<version>.exe`. |

See [docs/TESTING.md](docs/TESTING.md) for the opt-in integration tests and the hands-on checklist.

### Release builds

`npm run build:native` (and so `npm run dist`) builds the helper through `scripts/build-helper.mjs`, which remaps your home folder, `CARGO_HOME`, `RUSTUP_HOME` and the repository path (`--remap-path-prefix`, computed from the environment at build time) so the shipped `cadabra-helper.exe` doesn't contain local paths or your user name. Official releases should still be built in CI on a clean runner, not on a personal machine. If you change the build, check the exe for your home path before publishing it.

## How the pieces fit

- **`native/cadabra-helper`** (Rust): global hooks, UI Automation, capture and SendInput. The app starts it as a child process and talks newline-delimited JSON-RPC over stdin/stdout (`src/main/helper.ts`).
- **`src/main`** (Electron main): the summon flow, conversations, tool host, safety gate, AI providers, voice, email and WhatsApp.
- **`src/renderer`**: the panel, overlays, hidden mic window and demo stage. Renderers are sandboxed and only see `src/preload/bridge.ts`.
- **`src/shared`**: pure TypeScript shared by everything. Most rules (safety, intents, spoken text, domains) live here and are unit-tested directly.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the full picture, including a request's path from the shortcut to the helper.

## Testing rules

These keep the test suite safe to run on a developer's own PC and in CI:

- **Never inject input into real apps in tests.** Use fake helpers (see `makeHost` patterns in `test/`). The only things that may receive real input are windows the test itself creates, such as the helper's own test window in `npm run smoke:helper`.
- **No network in unit tests.** Use fake servers on 127.0.0.1 and inject resolvers (for example `ToolHost.resolveHost`) instead of real DNS. Never call real AI, Google, OpenAI, Open-Meteo or WhatsApp endpoints from `npm test`.
- **No real microphone or speakers.** Voice tests use Chromium's fake microphone (`--voicetest=<file.wav>`) or WAV files, and TTS tests write WAVs without playing them.
- **Never lock the workstation, change system settings or launch apps** from unit tests.
- **Anything that needs local files** (downloaded models, test clips, a built helper) must be an opt-in integration test that skips cleanly when they're missing (`describe.skipIf(...)`). CI only has the repository.
- Don't commit secrets, real account names, email addresses, phone numbers or screenshots of your own desktop. Fixtures must be synthetic.

## The safety gate: where the rules live and the bar for changing them

| What | Where |
|---|---|
| Action classification, risky keywords, denylist, autonomy levels and "Always allow" | `src/shared/safety.ts` |
| The gate itself (decisions, confirm cards, budgets, per-channel stop) | `src/main/safety-gate.ts` |
| Terminal allowlist and argument checks | `src/shared/terminal.ts` |
| Web search and fetch guard | `src/shared/web-guard.ts` |
| Address parsing and look-alike checks | `src/shared/domains.ts`, `src/shared/spoken-url.ts` |
| Which tools back which claims (honesty check) | `src/main/claims.ts` |
| Target lookups before every action | `src/main/tools.ts`, `src/main/composition.ts` |

Changes here need more than a green build:

1. **Explain the threat.** The PR description says what could go wrong (prompt injection, a wrong target, a lost Esc, a leaked secret) and why the change is still safe.
2. **Tests for both directions.** Add a test showing that the intended action is allowed and one showing that a nearby dangerous action is still confirmed or blocked.
3. **Loosening needs review.** Anything that removes a confirm card, widens an allowlist, makes something grantable or changes the defaults must be approved by a maintainer, and is called out in `CHANGELOG.md`.
4. **Fail closed.** If a lookup can fail, the action is refused, not guessed.
5. **Never let the model write the card.** Confirm cards are built from real arguments by the gate.

Security problems go through private reporting, not issues or PRs: see [SECURITY.md](SECURITY.md).

## Commits and pull requests

- Branch from `main` and keep each PR focused on one change.
- Write commit subjects in the imperative mood ("Add …", "Fix …"), around 70 characters, with a body explaining the why when it isn't obvious.
- Before opening a PR, run `npm run typecheck`, `npm run lint`, `npm test` and, if you touched the helper, `npm run test:native`.
- Update docs and screenshots (`npm run screenshots`) when you change user-facing behaviour or UI, and add a line to `CHANGELOG.md` under "Unreleased".
- Fill in the PR template, including the safety-impact section.
- CI (`.github/workflows/ci.yml`) must pass.

## Reporting bugs and requesting features

Use the issue templates. For bugs, attach **Export diagnostics…** from the tray, but **review the file before posting it**: it is redacted, but text from other apps can still appear in it.
