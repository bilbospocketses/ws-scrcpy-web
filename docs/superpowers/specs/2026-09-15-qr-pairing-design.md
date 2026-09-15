# Wireless pairing: QR and pairing code — design

**Item 73.** Android 11+ devices cannot be connected at all without pairing, and ws-scrcpy-web has no
pairing capability. Discovery works; connection is structurally impossible. This closes that.

Design decisions taken with the user on 2026-09-15: **both** the QR and the pairing-code flows,
**pair then auto-connect**, UI **inside the existing scan/connect modal**, QR rendered **server-side by
a vendored zero-dependency encoder**.

---

## 1. Why this is needed, restated from evidence

`_adb-tls-connect._tcp` is TLS and accepts only hosts that have **previously paired**. An unpaired host
is refused at the handshake, which surfaces as `failed to connect` — *not* `failed to authenticate`.
That difference is the diagnosis: a legacy `_adb._tcp` 5555 device returns `failed to authenticate` and
sits as `unauthorized`, awaiting the on-device "Allow USB debugging?" prompt. Android 11+ wireless
**never shows that prompt**, which is why the user reports receiving no notification on the phone.

Measured on this network, 2026-09-15, with the app's own bundled adb (37.0.1, `adb pair` present):

```
adb-5C061JEA327610-bo0E0q   _adb-tls-connect._tcp   192.168.86.190:43777
adb-49241HFAG07SUG          _adb._tcp               192.168.86.43:5555
adb-51181HFAG0G1UZ          _adb._tcp               192.168.86.159:5555
```

Two facts to design around:

1. **No `_adb-tls-pairing._tcp` entry is present.** The phone advertises the pairing service **only
   while its pairing screen is open**. The pairing service is transient by nature; the session TTL
   exists to match that, not as arbitrary hygiene. **TTL is 180 s**, carried from #506, which is
   comfortably longer than it takes to walk to a phone and scan, and short enough that an abandoned
   session's secret does not sit in memory for the life of the process.
2. **The ports are ephemeral and unrelated.** Item 73 recorded pairing 41415 / connect 37571 on this
   same device; today its connect port is 43777. Pairing port and connect port are different ports with
   no relationship, so **discovering one tells you nothing about the other**.

---

## 2. Flow

### QR

1. Generate a service name `wsscrcpy-<10 random base32 chars>` and a password (12 chars, `A-Za-z0-9`),
   both from `crypto.randomBytes`.
2. Render a QR of Android's standard payload — `WIFI:T:ADB;S:<name>;P:<password>;;` — to SVG, server-side.
3. The user scans it on the phone (Wireless debugging → Pair device with QR code).
4. The phone begins advertising `_adb-tls-pairing._tcp` **under exactly that service name**.
5. Poll `AdbClient.mdnsServices()` every 1 s. Match on
   `service === '_adb-tls-pairing._tcp' && name === session.serviceName`.
   **Never "any pairing service on the network"** — the name is the correlator, and matching loosely
   would pair against a neighbouring host's session.
6. On match: `adb pair <address>:<port> <password>`.
7. On success: auto-connect (§3).

### Pairing code

Same session machinery, no discovery: the phone displays a 6-digit code **and its own `ip:port`**, the
user enters both, and we go straight to step 6. This is the only flow that can pair a device with no
camera — the GTV Streamer in the user's test inventory has none.

---

## 3. Auto-connect

`adb pair` prints, on success:

```
Successfully paired to 192.168.86.190:41415 [guid=adb-5C061JEA327610-bo0E0q]
```

The guid yields the serial. Look for `_adb-tls-connect._tcp` whose name matches that guid, and
`adb connect` its `address:port`.

**Fallback, in order:** (a) guid match; (b) any `_adb-tls-connect._tcp` advertised by the **same IP** as
the pairing service. Do not fall back to "the only connect service on the network" — with three devices
advertising, that is a coin toss.

Connect is a **separate, fallible step**. A session that pairs and fails to connect reports
`paired-not-connected`, not `failed`: the pairing is durable and must not be presented as lost, or the
user will re-pair a device that is already paired.

---

## 4. Components

| Unit | Responsibility |
|---|---|
| `src/server/pairing/PairingSession.ts` | One session's state machine + secret. No adb, no HTTP, no DOM. |
| `src/server/pairing/PairingService.ts` | Singleton owning the **one** active session; discovery polling; drives adb. |
| `src/server/pairing/qr.ts` | Vendored zero-dep QR encoder → SVG string. |
| `src/server/api/PairingApi.ts` | HTTP surface. |
| `AdbClient.pair()` | New method; **redacting** (§6). |
| `NetworkDiscoveryPanel` | UI, inside the existing scan/connect modal. |

`PairingSession` holds no I/O so its lifecycle is testable as a plain object — expiry, replacement and
cancel are unit tests with a fake clock, not integration tests.

### State machine

```
idle ──start──> awaiting-scan ──service found──> pairing ──ok──> connecting ──ok──> paired
                     │                              │                  │
                     │ TTL                          │ fail             │ fail
                     ▼                              ▼                  ▼
                  expired                         failed        paired-not-connected
```

`awaiting-scan` is skipped entirely by the pairing-code flow.

**One active session at a time.** Starting a new session, cancelling, or expiry makes all prior work
inert — a late mDNS match or a late `adb pair` result belonging to a superseded session is **discarded**,
not applied. Every async continuation re-checks that its session is still the current one before acting.

---

## 5. API

| Method | Route | Body / returns |
|---|---|---|
| `POST` | `/api/devices/pair/qr` | → `{ sessionId, svg, expiresAt }` |
| `POST` | `/api/devices/pair/code` | `{ address, code }` → `{ sessionId }` |
| `GET` | `/api/devices/pair/status?sessionId=` | → `{ state, message?, serial?, address? }` |
| `POST` | `/api/devices/pair/cancel` | `{ sessionId }` |

**The QR endpoint returns rendered SVG, never the payload string.** The password therefore never crosses
the wire as readable JSON and never lands in a request log or devtools network pane. The SVG still
encodes it — anyone who can see the QR can decode it, which is inherent to QR pairing — but the secret
is not *handed out in plaintext to any caller that can reach the endpoint*.

`status` never returns the password or the payload, in any state, including failures.

Gating matches the rest of the device API — admin-scoped, and the routes are registered alongside
`DeviceDiscoveryApi`'s.

---

## 6. The password must not leak into an error

`AdbExecError` builds its message as:

```ts
const argsPreview = args.join(' ');
super(`adb ${kind} (path=${adbPath}, args="${argsPreview}")${detail}`);
```

So a failed `adb pair 192.168.86.190:41415 987530` produces an error string **containing the pairing
password**, which then reaches the log. This is not hypothetical — it is the current behaviour of the
current code, verified while writing this spec.

`AdbClient.pair()` therefore catches **everything** and rethrows a `PairingError` whose message names
the failure kind and nothing else — no args, no password, no cause chain that could carry one. The
generic rethrow happens at the `pair()` boundary so no caller can reintroduce the leak.

**A test asserts the failure message does not contain the password.** That test is the point of this
section; the redaction without it is a comment.

---

## 7. Also in scope

**`AdbHandshakeProbe` learns `STLS`** (harvest item 6 from #506). Android wireless debugging answers
`CNXN` with `STLS` on the secure connect port; the probe does not recognise it today, so a
wireless-debugging endpoint reads as a bare failure. Verified by #506's author on a Samsung S24 Ultra /
Android 16.

---

## 8. Explicitly NOT in scope — the Tailscale port sweep

#506 was declined for it and this design does not revive it:

```
PORT_START = 32_768 ; PORT_END = 61_000   -> 28,232 ports
CONCURRENCY = 1_024                        -> repeating passes
```

`src/server/fdBudget.ts` sets `MAX_SCAN_CONCURRENCY = 512` and `Config.ts` clamps to it, but
`AdbQrPairing.ts` referenced `fdBudget` zero times, so its 1,024 default was never clamped — against a
server sharing a 1024-soft fd limit with the HTTP listener, every WebSocket, adb's sockets, SQLite and
the log. Separately, a continuous 28k-port sweep across a CGNAT range is reconnaissance-shaped traffic
that endpoint security flags.

**Tuning the range does not rescue it.** The observed pairing/connect spread on one device was ~3,800
ports with no relationship between the two, which is the argument for the pairing-code mechanism over a
smarter scan — and is exactly what this design implements.

Their range *is* empirically sound as a bound (both observed ports fell inside 32768–61000); keep that
fact if port logic is ever needed.

---

## 9. Testing

Unit, no device required:

- **Session lifecycle** — expiry at TTL, replacement makes the prior session inert, cancel, and a late
  result belonging to a superseded session is discarded.
- **Exact-name matching** — a `_adb-tls-pairing._tcp` advertised under a *different* name is ignored.
  This is the test that stops us pairing with a neighbour's session.
- **guid parse** — the `[guid=adb-<serial>-xxxx]` form, plus a success line without a guid falling back
  to same-IP.
- **Secret redaction** — a failed pair's error text does not contain the password (§6).
- **QR encoder** — encodes a known payload to a known matrix; the payload string is exactly
  `WIFI:T:ADB;S:<name>;P:<password>;;`.
- **API** — `status` never returns the password in any state.

Device verification, with the user present:

- Pair the **Pixel 10a** by QR, confirm auto-connect, then stream it.
- Pair the **GTV Streamer** by pairing code — it has no camera, so this is the flow that proves the
  second path is not decorative.
- Then rotate, which is item 24's outstanding device test (PR #698), so both are exercised in one pass.

---

## 10. Standing commitment carried from item 73

#506's closing comment invited `@Hiroshimeow` to resubmit **LAN-only, with the Tailscale path dropped**,
and promised a prompt, serious review; the user approved extending that invitation on 2026-09-10. If
such a PR arrives while this work is in flight, **honour the invitation and review it before duplicating
the work**. The design above is deliberately the same shape they proposed, minus the port sweep.
