# Security policy

Cadabra OS can see your screen and act on your PC, so we take security reports seriously.

## Reporting a vulnerability

**Please don't open a public issue for security problems.**

Report them privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**, which opens a private GitHub security advisory. Please include:

- what you found and why it matters (for example, a way for screen text, a web page, an email or a WhatsApp message to make Cadabra act without a confirm card);
- steps to reproduce, with the version (shown at the bottom of the tray menu and in **Export diagnostics…**);
- any proof-of-concept. Use test accounts and your own machines only.

We aim to acknowledge reports within a week and will keep you updated while we work on a fix. We're happy to credit you in the release notes unless you'd rather stay anonymous.

## Supported versions

Cadabra OS is pre-1.0. Only the latest release gets security fixes.

## Scope

In scope:

- bypasses of the safety gate (an action that should need a confirm card runs without one, or a blocked target is acted on);
- prompt injection that leads to actions, data leaving the PC, or false claims of what was done;
- leaks of keys, tokens, email content or typed text into logs, diagnostics or AI requests;
- weaknesses in the local MCP endpoint, the IPC bridge, the WhatsApp pairing and confirmation codes, or the Gmail integration.

Out of scope:

- vulnerabilities in the third-party CLIs, SDKs or services Cadabra drives (report those to the vendor);
- attacks that already need full control of the user's Windows account;
- the "Don't ask" autonomy level doing what it says.

How the safety model works is described in [docs/SECURITY.md](docs/SECURITY.md).
