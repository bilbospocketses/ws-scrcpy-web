# Security Policy

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Report security issues privately through GitHub's built-in security advisory flow:

**[Report a vulnerability](https://github.com/bilbospocketses/ws-scrcpy-web/security/advisories/new)**

This opens a private channel between you and the maintainer — no public disclosure until a fix is ready.

## What to Include

When reporting, please provide:

- A clear description of the vulnerability and its impact
- Steps to reproduce (proof-of-concept code, configuration, or network conditions)
- The affected version / commit
- Any mitigations you're aware of

## Response Expectations

- **Acknowledgement:** within **72 hours** of receipt
- **Triage and initial assessment:** within one week
- **Fix and disclosure timeline:** discussed with the reporter on a per-issue basis, depending on severity and complexity

## Supported Versions

Security fixes target the latest release on `main`. Older versions are not maintained.

## Scope

In scope: the Node.js server, the browser client, and any protocol handling (WebSocket multiplexing, ADB proxying, scrcpy protocol layer).

Out of scope:
- Vulnerabilities in upstream dependencies that have not been released against ws-scrcpy-web (report those upstream)
- Issues requiring physical access to a host already running the server
- Self-XSS or similar issues requiring the victim to paste attacker-controlled code into devtools

Thanks for helping keep the project safe.
