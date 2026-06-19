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

## Access Control Model

ws-scrcpy-web exposes an **unauthenticated** control surface intended for a trusted local or LAN network — anyone who can reach the port can drive connected devices. There is no built-in user login yet. The server does defend that surface against cross-network and cross-site attackers with three layers (see `docs/TECHNICAL_GUIDE.md` §24 for the implementation):

- **Host allowlist** — the `Host` header must be `localhost`, an IP literal, or a configured `allowedHosts` entry. Bare domains are rejected (DNS-rebinding defense).
- **Origin match** — for the API / WebSocket surface, a present `Origin` must be same-origin (CSRF defense).
- **Per-instance token** — a random per-launch `HttpOnly; SameSite=Strict` cookie gates the API and the WebSocket upgrade, so a non-browser client that never loaded the page is refused.

**Serving on a domain / behind a reverse proxy.** Because the default rejects domain `Host` headers, a TLS-terminating reverse proxy on a domain name must be opted in via the server-only `allowedHosts` array in `config.json`:

```json
{ "allowedHosts": ["devices.example.com"] }
```

`allowedHosts` is read only at startup and is **not** exposed or mutable through `/api/config`. The proxy must forward the original `Host` header (not rewrite it to `localhost`), or the Origin check will reject requests. List only domains you control, and leave it empty for local/LAN-only use.

Thanks for helping keep the project safe.
