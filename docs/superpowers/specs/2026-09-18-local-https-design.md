# Local HTTPS — design

**Date:** 2026-09-18
**Status:** approved 2026-09-18; open questions resolved. Ready for implementation planning.
**Origin:** issue #691, and the secure-context wall every LAN user hits

---

## The problem

Streaming needs a **secure context**. The browser exposes `VideoDecoder` (WebCodecs) only on
`https://`, `http://localhost` or `http://127.0.0.1`. So `http://<lan-ip>:8000` lists devices and plays
nothing, which is the single most common way this app disappoints someone.

Today the only remedies are "browse on the serving machine" or "put a TLS reverse proxy in front of it".
The second is correct and completely out of reach for the audience that just wants to watch their phone
from the sofa.

**The server already speaks HTTPS.** `HttpServer.start()` reads a `servers` array and calls
`https.createServer(serverItem.options, …)`; `Config.parseServerItem` already accepts `certPath` /
`keyPath`. Nothing in this design adds TLS support. What is missing is **getting a certificate and
getting it trusted**, and a UI for both.

---

## What we are building

A **Settings → Server → Local HTTPS** panel that:

1. Generates a locally-trusted certificate with a vendored `mkcert`, for an **IP address** or a
   **hostname** the user picks.
2. Starts an HTTPS listener alongside the existing HTTP one.
3. Offers the **CA root certificate** for download, with per-OS instructions for trusting it.
4. Lets the user narrow plain HTTP afterwards — off, or redirecting — always reversibly.

### Explicitly out of scope

- Public CAs, ACME, Let's Encrypt, DNS challenges.
- Automatic trust installation on client machines. We hand over a file and instructions; the user
  installs it. Installing a root CA is a serious act and must stay a deliberate one.
- Replacing the reverse-proxy path. A domain + real CA remains the right answer for anything beyond a
  home LAN, and `allowedHosts` keeps serving it.

---

## Measured facts this design rests on

Two things were measured rather than assumed, because the design changes shape if either is wrong.

**1. A click-through cert warning IS a secure context.** Chrome 151, self-signed cert with an IP SAN,
served on a LAN IP (deliberately not loopback, which is a secure context on its own and would have
faked a pass), user path Advanced → Proceed:

| | `http://192.168.86.3:8899` (control) | `https://192.168.86.3:8898` (subject) |
|---|---|---|
| `isSecureContext` | false | **true** |
| `VideoDecoder` | absent | **present** |
| H.264 `isConfigSupported` | — | **true** |
| Opus `isConfigSupported` | — | **true** |

Playwright refused the bad certificate rather than bypassing it, so this is the real interstitial path
and not `ignoreHTTPSErrors`. `isConfigSupported` was checked because a decoder that exists but cannot
configure would pass a `typeof` check.

**Consequence:** trusting the CA is an *ergonomic* improvement, not a functional gate. A user who never
installs it can still stream by clicking through. This is what makes the "HTTPS only" mode safe to offer.

**2. `mkcert -install` is not needed on the server.** `-install` writes the CA into the *local* trust
store. The server only has to *serve* a certificate; the **clients** are what must trust the CA.
Generating a leaf certificate works without `-install` (it warns and proceeds). **So no elevation is
required on the server**, which removes the UAC / service-account problem entirely.

---

## Components

### 1. Vendored `mkcert` (dependency manager)

**Source: `bilbospocketses/mkcert`, release `v1.4.4-bt.2` — our own hardened fork, not upstream.**
Public, 8 assets (7 platform binaries + `SHA256SUMS.txt`), with **sigstore build-provenance
attestation**. Asset names are predictable: `mkcert-v1.4.4-bt.2-windows-amd64.exe`,
`mkcert-v1.4.4-bt.2-linux-amd64`, and so on.

Per Local-Dependencies-Only, it resolves from `dependencies/mkcert/<version>/mkcert(.exe)` and
**never** from PATH. It joins adb, scrcpy-server, node and node-pty in the existing dependency manager:
same fetch-on-demand, same version pin, same Settings → Dependencies row.

**Verify the attestation on fetch, not just the checksum.** `gh attestation verify` was measured to
exit 0 on a real asset and 1 on an unattested file, so provenance is checkable rather than claimed. A
checksum proves the bytes match the manifest we downloaded from the same place; attestation proves which
workflow built them. For a binary that mints trust material this is worth the extra step, and it is the
reason the fork is public at all — **GitHub refuses build-provenance attestation on user-owned private
repositories**, so attested artefacts and a private repo were mutually exclusive.

**Why a fork rather than upstream v1.4.4:** upstream has been dormant since 2024-08. The fork carries
five stale dependency bumps, a Go floor of 1.26.0, **28 tests where upstream has none**, and fixes for
four findings from a full code review — including `F3`, an argument-controlled path escape that wrote
outside the working directory and still exited 0.

A single static binary. **Measured from the `FiloSottile/mkcert` v1.4.4 release assets, 2026-09-18:**

| Platform | Size |
|---|---|
| windows-amd64 | 4.6 MB |
| windows-arm64 | 4.4 MB |
| linux-amd64 | 4.5 MB |
| linux-arm64 | 4.4 MB |
| darwin-amd64 | 5.0 MB |
| darwin-arm64 | 4.9 MB |

One per install, fetched **on first use** rather than at install time, so a user who never enables HTTPS
never downloads it. Negligible beside platform-tools and scrcpy-server.

**Version caveat, stated because it should be a decision and not a surprise: v1.4.4 was released in 2022
and upstream has been dormant since.** It is a stable, self-contained tool with no network surface and a
small job, so dormancy is not disqualifying — but it will not receive security updates, and pinning it
means accepting that. Its only inputs are a subject string we validate and a `CAROOT` path we control.
If that trade is unacceptable, the alternative is generating the CA and leaf in-process with `node:crypto`
and dropping the binary entirely — more code, one fewer dependency, and no vendoring problem.

### 2. `CertService` (server)

One module owning certificate lifecycle. Public surface:

| Method | Does |
|---|---|
| `getState()` | `{ status, subject, kind, notAfter, caRootPath }` — what exists now |
| `generate({ kind, value })` | Runs mkcert for an IP or hostname; writes leaf + key to the data root |
| `caRootPem()` | Reads the CA root for download |
| `revoke()` | Deletes the leaf + key; leaves the CA alone |

**Storage: the data root, not the install directory.** `<dataRoot>/tls/` for the leaf and key. This is
what makes the container case work — a `docker rm` must not destroy a CA that every client on the LAN
has already trusted — and it means an app update cannot discard it either.

**⚠ `CAROOT` CANNOT simply be `<dataRoot>/tls/ca` on Windows, and this is a hard blocker for the naive
version of this design.** The Windows data root is `C:\ProgramData\WsScrcpyWeb`, and its ACL was measured
2026-09-18:

```
BUILTIN\Users   ReadAndExecute, Synchronize   (inherited)
BUILTIN\Users   Write                         (inherited)
```

**`BUILTIN\Users` is every local account on the machine.** Combined with the finding above — mkcert's
`0400` sets only the read-only attribute on Windows and no ACL — a `CAROOT` there means **the CA private
key is readable by any user on the box.** Whoever reads it can mint a certificate for any name and have
it trusted by every machine on which that CA was installed. That is a meaningfully worse outcome than the
plain-HTTP problem this feature exists to solve.

Resolution, and it must be decided before implementation rather than discovered:

- **Windows:** `CAROOT` goes in a **per-user** location (`%LOCALAPPDATA%\WsScrcpyWeb\tls\ca`), *or*
  `<dataRoot>/tls/ca` is created with an explicit restrictive ACL that breaks inheritance and grants only
  the service account plus Administrators. The per-user path is simpler and harder to get wrong; the
  explicit-ACL path is the only option if the server runs as a service under a different account than the
  user clicking the button.
- **POSIX:** `<dataRoot>/tls/ca` at `0700` is fine; the mode does what it says.
- **Container:** fine as-is — `/data` is not shared with other users, which is the whole point of the
  container boundary.

**The leaf key has the same exposure** and needs the same treatment; it is less catastrophic (one name,
expires in 822 days) but there is no reason to leave it readable.

This is the one place where the container case is *safer* than the desktop case, which is the opposite of
the usual direction and is why it was nearly missed.

**File permissions — and the Windows reality, which is not what you would assume.** mkcert writes the CA
key `0400`. On POSIX that means what it says. **On Windows it means almost nothing:** Go maps the file
mode to the read-only *attribute* and sets no ACL at all. Measured in the fork review, 2026-09-18, the
generated `rootCA-key.pem` grants the interactive user `FullControl` by inheritance from its parent
directory.

**So confidentiality of the CA key on Windows comes from the DIRECTORY, not the file mode.** `CAROOT`
must be a **per-user** directory whose inherited ACL is already restrictive — never a shared or
world-readable one, and never a path like `C:\ProgramData\...` that grants broad access by default. The
leaf key we write ourselves gets the same treatment: an explicit restrictive ACL on Windows rather than
a `0600` we assume is doing something.

Neither key ever leaves the machine and neither is ever served.

### 2b. How ws-scrcpy-web must invoke mkcert

Four requirements from the fork's item-1 review (2026-09-18). **Two are load-bearing and two are now
defence in depth**, because the fork fixed its half — and the distinction matters, since it tells a
future reader which ones they must not drop.

| Requirement | Status | Why |
|---|---|---|
| Pass `-cert-file` / `-key-file` as **absolute paths** | **LOAD-BEARING** | Leaf output defaults to the **process cwd**, not `CAROOT`. Consumer-side by nature — the fork cannot fix where we tell it to write. A spawned process inherits whatever cwd it was given. |
| Point `CAROOT` at a **per-user** directory | **LOAD-BEARING** | `0400` on the CA key is a no-op for confidentiality on Windows (above). Also consumer-side: the directory is our choice, and its ACL is the only real control. |
| Validate the host/IP argument **before** spawning | defence in depth | `F3` — a URL-shaped argument escaped cwd and still exited 0. **Fixed in the fork** (PR #2). We validate anyway, for the reasons in §6; it is no longer the only thing standing between argv and an arbitrary write. |
| Set `TRUST_STORES=none` in the spawn environment | defence in depth | `F5` — a stray `JAVA_HOME` made every run exec `keytool` and die on its failure. **Fixed in the fork** (PR #2). Setting it costs nothing and removes a host-environment dependency entirely. |

**Do not let the two "defence in depth" rows decay into "optional".** They are belt-and-braces *only
while we vendor our own fork*. If this ever falls back to an upstream binary, both revert to
load-bearing immediately, and `F3` in particular is an arbitrary-write primitive gated solely by our
validation.

The fork's todo item 4 holds the same table as the producer-side contract, so the two repos agree.

### 2c. Flags the fork added that this design should use

`v1.4.4-bt.2` adopts three flags from upstream's open backlog that upstream never merged. All three are
directly useful here and two change decisions made earlier in this spec.

**`-name-constraints` — use it, and it materially shrinks the CAROOT blast radius.** It constrains what
names the CA is permitted to vouch for, so a stolen CA key can no longer mint a certificate for
`yourbank.com` — only for the names we constrained it to. Given §2's finding that the CA key's
confidentiality on Windows rests entirely on directory ACLs, this is the difference between "a local
user can impersonate anything" and "a local user can impersonate the LAN address they could already
reach".

**Use the fork's implementation, not upstream's PR #657, and understand why.** X.509 applies name
constraints **per name type**: constraining DNS names leaves IP addresses *entirely unconstrained*.
Upstream's PR sets `PermittedDNSDomains` alone — measured, a CA constrained that way still happily signs
`8.8.8.8`. **Our subject is usually a LAN IP**, so DNS-only constraints would be pure theatre for this
feature's main path. The fork sets `PermittedIPRanges` too, marks the extension critical, and warns when
only one name type is covered — because a half-constrained CA is more dangerous than an unconstrained
one: it looks protected.

**`-ca-name` — use it.** The CA appears in the user's OS trust store under a name they will read when
deciding whether to keep trusting it, and possibly years later when wondering what it is. "ws-scrcpy-web
local CA (`<hostname>`)" is a better answer than mkcert's generic default.

**`-days` — available, and the 30-day renewal warning stands.** The fork keeps the default unchanged at
~2y3m (deliberately; upstream's PR moved it to 810 days, which is a behaviour change a flag does not need
to make). We do not need to shorten it — but the flag exists if a shorter, auto-renewed lifetime is ever
wanted, and the decision to warn rather than silently regenerate is unaffected.

### 3. HTTPS listener wiring

`Config.servers` gains a second entry when a certificate exists:

```jsonc
[
  { "secure": false, "port": 8000 },
  { "secure": true,  "port": 8443,
    "options": { "certPath": "<dataRoot>/tls/cert.pem", "keyPath": "<dataRoot>/tls/key.pem" } }
]
```

This is existing machinery — `parseServerItem` already reads `certPath`/`keyPath`. Enabling HTTPS is a
config write plus a restart, not new server code.

**Restart:** enabling, regenerating or revoking a certificate requires a listener restart. This reuses
the existing service-restart path; the UI states plainly that the server will restart and that in-flight
streams will drop.

### 4. Port model

Two independent ports with independent defaults. **Changing one never moves the other.**

| | Default | Notes |
|---|---|---|
| HTTP | `8000` (or whatever `webPort` already is) | unchanged by this feature |
| HTTPS | `8443` | stays 8443 until explicitly set, even if HTTP is 80 |

Setting HTTP to `80` does **not** imply HTTPS `443`. The user sets 443 explicitly or not at all.

**Sub-1024 warning:** on Linux and macOS a non-root process cannot bind below 1024, so the server would
fail to start. The port field warns inline when a value under 1024 is entered on those platforms; in a
container it is fine, because published ports are mapped. This is a warning, not a block — a user who
knows they have `CAP_NET_BIND_SERVICE` or a mapped container should not be stopped.

### 5. HTTP exposure mode (the radio)

Three states, freely interchangeable in any direction:

| Mode | Behaviour |
|---|---|
| **Both open** *(default)* | HTTP and HTTPS both serve everyone. No action needed; this is what you get if you never touch the setting. |
| **HTTPS only** | HTTP refuses non-loopback callers. **Loopback keeps working.** |
| **Redirect to HTTPS** | HTTP 302s non-loopback callers to the HTTPS origin. **Loopback is exempt and is not redirected.** |

**The loopback exemption is the load-bearing detail.** Both narrowed modes would otherwise remove the
only way to reach Settings when the certificate goes bad — expired, IP moved under DHCP, CAROOT wiped by
a container recreate — turning a GUI click into "hand-edit config.json and restart". The exemption also
preserves `/api/whoami` for the Control Menu integration (todo item 15), which probes over loopback HTTP
and would otherwise break the instant someone picked HTTPS-only.

The setting is stored as `httpExposure: "open" | "httpsOnly" | "redirect"` in the database with the
other app settings, and is reversible to `open` from either narrowed state.

### 6. Certificate subject: IP or hostname

A radio with two fields, because the trade-off is real and the user owns it:

- **This machine's IP** *(recommended, prefilled)* — e.g. `192.168.86.3`. One click, nothing else to
  configure, **no hosts-file editing anywhere**. Breaks if DHCP moves the server.
- **A hostname I choose** — e.g. `devices.lan`. Survives an IP change; costs a hosts-file entry (or a
  local DNS record) on **every** client that will connect.

The IP field is prefilled with this machine's LAN address. **The helper for this does not exist yet and
must be written** — `network/SubnetDetector.detectSubnet()` is the closest thing (gateway first, then
interfaces) but it answers "what subnet should I scan", not "which of my addresses should a client dial",
and the interface-ranking described in the technical guide §ranking is about the *device's* interfaces,
not the host's.

Picking well is not cosmetic: this machine currently has **nine** IPv4 addresses, including a VirtualBox
host-only adapter, two 169.254 link-locals, a WSL vSwitch, a Docker vSwitch and two VPN adapters. Only
one of them (`192.168.86.3`) is reachable from a phone on the LAN, and a prefill that guesses wrong
issues a certificate nobody can use. Rules: RFC1918 only, exclude CGNAT (100.64/10 — shared by Tailscale
and carriers), exclude link-local, prefer the interface holding the default route. The user can always
override, and the field shows every candidate rather than only the winner.

Both paths produce a certificate; only the hostname path needs the name-resolution guide.

### 7. CA download and trust instructions

A **download CA certificate** button serving `<dataRoot>/tls/ca/rootCA.pem`, plus a per-OS accordion:
Windows (`certutil -addstore -user Root`), macOS (Keychain Access → System → Always Trust), Linux
(`/usr/local/share/ca-certificates` + `update-ca-certificates`), Android, iOS. Firefox gets its own note
because it keeps a private trust store and ignores the OS one.

**The endpoint is admin-gated**, like every other admin route. Handing out a root CA is precisely the
shape of a malware delivery step, and while this CA is only dangerous to someone who installs it, an
unauthenticated download endpoint for one is not a thing this app should have. It is also rate-limited
and logs each download, because a root CA leaving the machine is worth a log line.

---

## UI notifications — where each known mistake gets made

Every notice below exists because someone can reasonably go wrong at exactly that point. Copy is
lowercase per the app's motif.

| # | Where | When | Says |
|---|---|---|---|
| 1 | Device card / stream area | Insecure origin, no cert configured | Existing secure-context notice, **extended** with a link into Settings → Local HTTPS instead of only naming the loopback URL |
| 2 | Settings → Server, `allowedHosts` field | Always, inline | `allowedHosts` takes domain names only; raw IPs already pass, and it does not affect streaming |
| 3 | Local HTTPS panel | Cert exists, browser is on an untrusted-CA origin | you are connected over https but this browser does not trust the certificate — install the CA below to remove the warning. **streaming already works** |
| 4 | Local HTTPS panel | Cert subject is an IP that no longer matches any local interface | this certificate names `<ip>`, which is no longer an address of this machine — DHCP has probably moved it. regenerate, or switch to a hostname |
| 5 | Port field | Value < 1024 on Linux/macOS | ports below 1024 need elevated privileges on this platform; the server may fail to start |
| 6 | Exposure radio, on selecting a narrowed mode | Before confirm | plain http will stop answering other machines. **this machine keeps working over localhost**, so you cannot lock yourself out |
| 7 | Exposure radio, on selecting a narrowed mode | Before confirm | the server will restart and any active streams will drop |
| 8 | Hostname path, after generate | Cert is for a hostname | this name must resolve on every machine that connects — add it to their hosts file or your local DNS. `<guide>` |

Notice **3** matters most and is the least obvious: a user who sees a browser warning will assume
something is broken and stop. It must say, at that exact moment, that streaming already works and the CA
is only there to silence the warning. That is the measured fact from above, surfaced where it changes
behaviour.

---

## Data flow

```
Settings → Local HTTPS → [generate]
  → POST /api/tls/generate { kind: "ip"|"hostname", value }
      → validate value (reuse isConnectAddress shapes; reject wildcards, reject public IPs)
      → ensure dependencies/mkcert present (fetch if not)
      → CAROOT=<dataRoot>/tls/ca  mkcert -cert-file … -key-file … <value>
      → write config: servers += { secure:true, port, certPath, keyPath }
      → respond { status, subject, notAfter }
  → UI prompts restart → service restart → HTTPS listener up

Settings → Local HTTPS → [download CA]
  → GET /api/tls/ca-root  (requireAdmin, rate-limited, logged)
      → Content-Disposition: attachment; filename="ws-scrcpy-web-local-ca.pem"
```

---

## Error handling

| Failure | Behaviour |
|---|---|
| mkcert download fails | Panel reports it; no partial state written; retry button |
| mkcert exits non-zero | stderr surfaced verbatim in the panel; nothing written to config |
| Cert/key unreadable at boot | **HTTPS listener is skipped, HTTP still starts**, and the panel says why. The app must never fail to boot because of an optional certificate |
| Port already in use | Startup reports the port and keeps HTTP alive |
| CAROOT missing but leaf present | Panel offers regenerate; existing leaf keeps serving until then |

The pattern throughout: **a broken certificate degrades to "remote streaming stopped", never to "the app
is gone"**. That is also why loopback HTTP is never withdrawn.

---

## Testing

**Unit** — `CertService` state machine against a stubbed mkcert; `httpExposure` decision function
(`(mode, isLoopback) → serve | refuse | redirect`) exhaustively, since it is the lockout-critical logic;
port-model defaults, including that setting HTTP to 80 leaves HTTPS at 8443; subject validation.

**Integration** — generate against a **real vendored mkcert** into a temp data root, assert the leaf
parses and carries the expected SAN, assert the emitted `servers` config is what `parseServerItem`
accepts.

**E2E (Playwright)** — the gap that matters, and the one no unit test can close: stand the server up with
a generated cert on a **non-loopback** origin and assert `isSecureContext` and
`VideoDecoder.isConfigSupported` in a real browser. jsdom applies no stylesheet and has no WebCodecs; a
green unit suite proves nothing here. The measurement above is the manual version of this test and
should become the automated one.

**Smoke rows** — new rows for: generate-for-IP then stream from another machine; install the CA and
confirm the warning disappears; each exposure mode including that loopback still answers; and the
DHCP-moved-IP notice.

---

## Resolved decisions

**1. Renewal — warn at 30 days, never regenerate silently.** mkcert leaf certs default to ~2 years
3 months. The panel shows a notice from 30 days out and the existing dependency-alert badge is *not*
reused for it — that badge means "a bundled tool has an update" and overloading it with "your TLS is
expiring" makes both vaguer. Regeneration stays a button the user presses. Silent changes to TLS
material are a bad habit to build, and an unexpected new leaf looks exactly like an attack to anyone
checking fingerprints.

**2. Enabling HTTPS auto-adds the subject to `allowedHosts`, and says so.** A hostname subject *needs*
the entry or every request is refused as a possible DNS-rebinding attempt — a failure that surfaces as a
connection refusal and reads as a TLS problem, which is the worst possible mis-signal. The panel states
the edit plainly ("added `devices.lan` to allowedHosts so the server will answer to that name") rather
than mutating config behind the user's back.

For an **IP subject this is a no-op**, because raw IPs already pass the host check — and the code must
*skip* the write rather than append a redundant entry. Appending it would recreate exactly the confusion
issue #691 was about: a user later reading `allowedHosts: ["192.168.86.3"]` would reasonably conclude
that IPs belong there and that the entry is what grants access.

**3. Container CAROOT on a bind mount — assumed workable, validation required before build.** The
expectation is that it works. It is still a **task in the implementation plan, not an assumption**:
stand the published image up with a host bind mount, generate, and confirm `tls/ca` is written and
survives `docker rm` + recreate. The failure mode if it does not — a CA regenerated on every container
recreate, silently invalidating the trust every client installed — is bad enough to be worth ten minutes
of proof. Check both a named volume and a host bind mount, since their ownership semantics differ.
