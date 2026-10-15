# Security model

Cadabra lets an AI model see your screen and drive your mouse and keyboard. This page explains what protects you when it does. To report a vulnerability, see [SECURITY.md](../SECURITY.md): use a private GitHub security advisory, not a public issue.

## Principles

1. **Code decides, not the model.** Whether an action runs, needs a confirm card or is blocked is decided by the safety gate (`src/main/safety-gate.ts`) from the action's real arguments and the real target under the cursor. The model's own description of an action is never trusted.
2. **Everything on screen is data.** Screen text, window titles, the UI tree, terminal output, web pages, emails and WhatsApp messages reach the model as untrusted data, wrapped in per-request nonce tags. Instructions found in them aren't followed.
3. **Esc always works.** The physical Esc key (seen by the helper's own keyboard hook, ignoring injected keys) cancels the run, even mid-keystroke.
4. **No silent claims.** Cadabra only says it did something if a tool that does that thing succeeded in this run (`src/main/claims.ts`).

## The safety gate

Every tool call from every backend goes through `ToolHost` (`src/main/tools.ts`) and then the gate.

- **Bound to the request.** Each tool call must belong to the current run. Calls from a stopped or replaced backend session are refused. A per-run cancel epoch travels into the helper, so an Esc between two steps can't be lost.
- **Real target, every time.** Before acting, the tool host asks the helper for the focused element, the window, its process and elevation, and the input state. If a required lookup fails, the action is refused rather than guessed. Coordinate clicks re-check what is really under the point.
- **Confirm cards are written by the gate.** The card shows the exact command, keys, text or address in a monospace block, the target window and the reason. The model's note, if any, is labelled as such. "Not now" has focus, "Allow" is disabled for a moment, and an unanswered card counts as "no" after 90 seconds. Each approval covers exactly one action.
- **Blocked outright:** password managers, Windows credential and UAC prompts, the sign-in screen. Cadabra won't screenshot, read or act there.
- **Always confirmed, at every autonomy level except "Don't ask":** typing or pressing Enter in anything that runs commands (terminals, IDE terminal panes, the Explorer address bar, Start/Windows search, Run, Task Manager's "Create new task"); Win-key chords, Ctrl+Shift+Esc and Ctrl+Alt+Del; send, submit, delete, buy, pay and transfer actions; anything in banking, trading, payment or checkout windows; sign-in and payment buttons; text copied from the screen; addresses that came from the screen, the web or an email.
- **Elevated windows** (running as administrator) are detected and not controlled.
- **Budget:** each run has a maximum number of actions.

The rules live in `src/shared/safety.ts` (classification and denylist), `src/shared/terminal.ts` (terminal allowlist), `src/shared/web-guard.ts` (web calls) and `src/shared/domains.ts` (address handling). The panel can't change security-relevant settings, and safety lists always come from the built-in defaults.

### Autonomy levels

Settings → Safety → *When I act on your screen*:

| Level | Behaviour |
|---|---|
| Ask only for risky actions (default) | Ordinary clicks and typing in ordinary apps just happen; everything listed above asks. |
| Ask before every action | Every click, keystroke and scroll shows a card. Ordinary actions can be granted "Always allow" per app or site; grants are listed and revocable in Settings. Risky actions are never grantable. |
| Don't ask | No cards. Blocked targets stay blocked and Esc still works. A one-time reminder is shown. |

WhatsApp requests have their own autonomy setting (Settings → WhatsApp).

## Terminal commands

The backends get no raw shell. `run_in_terminal` opens a visible terminal and runs one command:

- read-only diagnostics (nslookup, ping, tracert, ipconfig, whoami, hostname, systeminfo, Get-Date, dir, Get-Process, Test-NetConnection and similar) run straight away, each with argument checks;
- pipes, redirection, chaining, shell metacharacters, UNC and device paths, `..`, wildcards, leading dashes and non-ASCII look-alikes are rejected;
- a host name or IP that isn't in the user's own words needs a confirm;
- anything else needs a confirm showing the exact command. Nothing runs elevated.

## Backends and accounts

- Each backend runs with only Cadabra's tools (see [ARCHITECTURE.md](ARCHITECTURE.md#providers)). Built-in shell, file and network tools are switched off, and private, empty config folders keep the user's own CLI configuration, MCP servers and instructions out.
- Cadabra signs in only through each vendor's own, unmodified CLI and login page. It never implements vendor OAuth itself, never reads or copies CLI credential files and never spoofs client identity.
- In API-key mode, Cadabra refuses to start without a saved key, scrubs alternative auth variables from the runtime's environment and stops if the runtime reports any other auth method.
- The local MCP endpoint listens on 127.0.0.1 only and requires a per-session bearer token.

## Secrets and logs

- API keys and tokens are stored in `secrets.json`, encrypted with Electron `safeStorage` (Windows DPAPI). They are never logged or sent to the renderer.
- Logs never contain typed text, email content, keys or tokens. Web calls are logged by domain only.
- **Export diagnostics…** also removes email addresses, user and machine names, the display name and window titles. Text from other apps can still appear, so users should read the file before sharing it.
- Cadabra's own windows use content protection, so they never appear in screenshots.

## Web, email and WhatsApp

- **Web:** every web search and fetch is checked first. Anything that looks private (codes, card numbers, keys) is refused, and screen text in a search or address needs a confirm. Pages are treated as data.
- **Email:** Gmail access is read-only (`gmail.readonly`, or IMAP opened with EXAMINE). Links are stripped. After an email has been read in a run, every action in that run needs a confirm. Disconnect revokes the token at Google.
- **WhatsApp:** one paired owner chat only; other senders are ignored. Risky actions are confirmed in the chat with one-time numeric codes ("yes" alone doesn't count). Messages older than 10 minutes aren't acted on. Media is downloaded only from the pinned media host, redirects are refused, and uploaded screenshots are deleted after sending. A pill on the PC shows when a remote request is running, and Esc at the PC or "stop" in the chat cancels it. WhatsApp agent chats are **not end-to-end encrypted**; the setup screen says so.

## Known limits

- The confirm card is only as good as the target detection. Apps with poor UI Automation support can hide what a field really is; Cadabra then falls back to the window and process.
- Prompt injection can't be fully prevented. The gate's job is to make sure injected instructions can't cause a risky action without your approval.
- The installer is not code-signed yet.
- "Don't ask" means what it says. Use it only if you accept that.
