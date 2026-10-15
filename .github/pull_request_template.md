## What and why

<!-- What does this change, and why? Link the issue if there is one. -->

## Safety impact

<!-- Does this change what Cadabra can act on, what needs a confirm card, what is sent off the PC, or what is logged?
     If it touches src/shared/safety.ts, src/main/safety-gate.ts, src/shared/terminal.ts, src/shared/web-guard.ts,
     src/shared/domains.ts or src/main/claims.ts, explain the threat and why the change is still safe (see CONTRIBUTING.md). -->

- [ ] No safety impact
- [ ] Safety impact, explained above, with tests for both the allowed and the still-confirmed/blocked case

## Checklist

- [ ] `npm run typecheck`, `npm run lint` and `npm test` pass
- [ ] `npm run test:native` passes (if the helper changed)
- [ ] New or changed behaviour has tests; tests use no network, real input, real microphone or local-only files
- [ ] Docs updated (README, docs/, CHANGELOG.md "Unreleased"), and screenshots re-rendered if the UI changed
- [ ] No secrets, personal data or screenshots of a real desktop in the diff
