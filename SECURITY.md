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

ws-scrcpy-web is **open (no login) by default**, intended for a trusted local or LAN network — anyone who can reach the port can drive connected devices. An opt-in login subsystem exists (see smoke Module 18); while it is disabled, the server defends that surface against cross-network and cross-site attackers with the layers below, plus the framing policy in §Framing (see `docs/TECHNICAL_GUIDE.md` §24 for the implementation):

- **Host allowlist** — the `Host` header must be `localhost`, an IP literal, or a configured `allowedHosts` entry. Bare domains are rejected (DNS-rebinding defense).
- **Origin match** — for the API / WebSocket surface, a present `Origin` must be same-origin (CSRF defense).
- **Per-instance token** — a random per-launch `HttpOnly; SameSite=Strict` cookie gates the API and the WebSocket upgrade, so a non-browser client that never loaded the page is refused.

**Serving on a domain / behind a reverse proxy.** Because the default rejects domain `Host` headers, a TLS-terminating reverse proxy on a domain name must be opted in via the server-only `allowedHosts` array in `config.json`:

```json
{ "allowedHosts": ["devices.example.com"] }
```

`allowedHosts` is read only at startup and is **not** exposed or mutable through `/api/config`. The proxy must forward the original `Host` header (not rewrite it to `localhost`), or the Origin check will reject requests. List only domains you control, and leave it empty for local/LAN-only use.

## Framing (clickjacking)

Static responses carry `X-Frame-Options: SAMEORIGIN`, so by default the app can only be embedded in a page on its own origin. A different port is a different origin, so a local tool serving on, say, `http://localhost:5159` cannot iframe the app running on `http://localhost:8000` — the browser blocks it, and Chrome and Edge report that as *"localhost refused to connect"*, which looks like the server is down when it is serving normally.

Allow a specific embedder via the server-only `frameAncestors` array in `config.json`:

```json
{ "frameAncestors": ["http://localhost:5159"] }
```

That adds `Content-Security-Policy: frame-ancestors 'self' http://localhost:5159` alongside the existing header. Both are sent deliberately: a browser that supports CSP `frame-ancestors` must ignore `X-Frame-Options` when both are present, so the allowlist applies in modern browsers while older ones keep the stricter same-origin behaviour. Leave the key out and the headers are unchanged.

### Approving a request instead of editing the file

Another local app can ask for embedding permission rather than making you hand-edit `config.json`. When it does, ws-scrcpy-web shows a prompt naming the app and the origin; approving writes that origin to `frameAncestors` and applies it to the running server immediately, with no restart.

The split between asking and granting is the security design:

- **Asking is unauthenticated, and can do nothing but raise the prompt.** `POST /embed-request` never touches config. It is accepted only from **loopback** — LAN clients are allowed to *use* the app but not to raise a consent prompt on your desktop — only one request is pending at a time, and it expires after five minutes. The asking app may also withdraw its own request (`POST /embed-request/{id}/cancel`, loopback-only), which closes the prompt; that too can only ever retract, never grant, and is refused for a request already decided.
- **Granting is admin-gated, same-origin, and loopback-only.** Only `POST /api/embed-request/decision`, driven by a human clicking Approve in this app's own UI, writes anything — and both it and `GET /api/embed-request` refuse a non-loopback caller. The loopback restriction is load-bearing, not belt-and-braces: in open mode the admin check resolves to the implicit admin, and the per-instance token that gates `/api` is handed to any unauthenticated GET of an extensionless path, so without it a LAN client could mint a token and approve its own request. Consent is given at the machine, not over the network.

A web page cannot even ask. Browsers always send an `Origin` header on `fetch()`, and the Origin check rejects a cross-origin one on every non-GET request, so only a non-browser local caller reaches the request endpoint.

**The risk this cannot remove** is a local program asking for an origin it controls and hoping you click Approve. That is why the prompt shows the requesting origin verbatim and deny is the safe answer: approve only a request you just started yourself, from an app you recognise.

### Revoking

**Settings → Embedding** lists every origin currently allowed to frame the app, each with a **revoke** button (admin, and loopback-only, like approving — it is the same class of decision). Revoking rewrites `frameAncestors` and applies to the running server immediately: the next response carries a policy without that origin, and whatever it was displaying stops working. Without this, approving a request was a one-way door short of hand-editing `config.json`.

**Understand what you are allowing.** Each listed origin may frame the app, which means clickjacking is possible from any page served on that origin — on a shared or multi-user machine, anything able to listen on that port qualifies. Entries must be bare origins (`scheme://host[:port]`, no path); `*` is rejected outright, since allowing every site is exactly what the header exists to prevent. Unlike `allowedHosts`, this key is **not** boot-only: it is read at startup and thereafter changed by an admin approval or revocation (`POST /api/embed-request/decision`, `POST /api/embed-origins/revoke`), each of which applies to the running server immediately and rewrites `config.json`. It remains **not** exposed or mutable through `/api/config`. List only origins you run yourself, and leave it empty unless you actually need the embed.

Thanks for helping keep the project safe.
