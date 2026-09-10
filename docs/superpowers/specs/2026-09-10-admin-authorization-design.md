# Admin authorization — proof of operator, not proof of reachability

**Date:** 2026-09-10
**Status:** Design approved by the user 2026-09-10; not yet implemented.
**Closes:** todo item 81 (all three of its options — see *How this collapses item 81*).
**Cross-repo:** requires a `qa-harness` change to land **first**. See *Sequencing*.

---

## 1. The problem

`requireAdmin` (`src/server/auth/requireAdmin.ts:7`) is the only gate on the admin API. In **open
mode** — the default, no sign-in configured — it resolves to the *implicit admin* and passes for a
request with no user at all. The project's own unit test states this outright:

```ts
// src/server/__tests__/adminAuthorization.test.ts:63-64
expect(requireAdmin({ user: { id: 1 } } as unknown as IncomingMessage, res)).toBe(true);
expect(requireAdmin({} as unknown as IncomingMessage, res)).toBe(true);   // <- no user, still admin
```

Four independent facts stack into a reachable hole:

| Fact | Where |
|---|---|
| `server.listen(port)` binds **all** interfaces | `services/HttpServer.ts` |
| `isHostAllowed` accepts **any IP literal** | `security/originGuard.ts` |
| `isRequestAllowed` skips its comparison entirely when `Origin` is absent — and a non-browser client controls that | `security/originGuard.ts` |
| The instance token is set on **any** GET/HEAD of an extensionless non-`/api` path, with no authentication | `security/instanceToken.ts` |

So: any host on the LAN fetches `/`, is handed `ws_scrcpy_token`, and reaches the admin API —
`UsersApi`, `ConfigApi` PATCH, `ServerShutdownApi`, `ServiceApi`, `DependencyApi`, `UpdatesApi`, and
`AuthApi`'s enable/disable.

**The token is a wristband, not an ID.** Its legitimate job is distinguishing "a browser that loaded
our page" from "a script probing the port." It was never an authenticator, and
`security/cookiePolicy.ts` already says so in its doc comment. Item 81 exists because parts of the
app treat it as one.

### What is already mitigated

- **Embed consent** — `EmbedRequestApi.requireLocalAdmin` (`api/EmbedRequestApi.ts:188`) is loopback
  **and** admin. This is the pattern the rest of this design generalises.
- **Docs (item 81 option (c), shipped beta.102, PR #609)** — `SECURITY.md` and TECHNICAL_GUIDE §24
  state the posture plainly. The docs no longer overpromise. **The code is unchanged.**

---

## 2. The finding that reshapes the fix

The obvious fix — "apply `requireLocalAdmin` to the rest of the admin API" — **has already been tried
on one endpoint and walked back.** `api/ServerShutdownApi.ts:105-108` records it in the code:

> *"This is not 'loopback only'. Requiring loopback outright broke the Settings button inside a
> container, where the browser reaches the server through the Docker gateway and so is never on
> loopback — caught by row 20.6 in CI, which is exactly what that row is for."*

This is not an edge case. **In a container, nobody is ever on loopback.** The Docker image is a
first-class deployment (todo item 2 — the next full release after `0.1.30` final). A blanket loopback
guard would mean, for every Docker user:

1. No admin, and
2. no way to press the "allow remote admin" button — because that button is itself loopback-gated, and
3. no way to enable sign-in either, because `POST /api/auth/enable` (`api/AuthApi.ts:133`) is
   `requireAdmin`-gated too.

That is a **bootstrap deadlock**, and it is the single most important constraint on this design.

---

## 3. The design

### 3.1 The rule

> **Admin requires proof that the caller is the operator.** That proof is **loopback** (the caller is
> on the machine) **or a signed-in admin session** (the caller proved who they are). With neither,
> admin is refused — unless the operator has explicitly opted out.

Reframing from *loopback* to *proof of operator* is what makes the container case coherent rather
than deadlocked. Loopback identifies a human on a desktop install; in a container it identifies
nothing, so there the proof has to be a sign-in. The opt-out exists for the trusted-LAN and
automation cases.

### 3.2 The guard

New shared helper, **`src/server/auth/requireOperator.ts`**, promoted from
`EmbedRequestApi.requireLocalAdmin`. It sits beside the `requireAdmin` it wraps rather than in
`security/`: `security/loopback.ts` is a network *primitive*, this is an authorization *policy*, and
`auth/requireAdmin.ts` already imports `../Config` so the import direction is established.

```ts
export function requireOperator(req: IncomingMessage, res: ServerResponse): boolean {
    if (!isLoopback(req.socket?.remoteAddress ?? '')) {
        const db = Config.getInstance().db;
        // A signed-in admin is proof of operator from anywhere. `requireAdmin`
        // below still decides whether THIS user is an admin.
        const proven = isAuthEnabled(db) ? hasAuthenticatedUser(req) : allowRemoteAdmin();
        if (!proven) {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'admin actions are limited to this machine' }));
            return false;
        }
    }
    return requireAdmin(req, res);
}
```

`isLoopback` (`security/loopback.ts:15`) already exists, is already shared by `WhoamiApi`,
`EmbedRequestApi` and `ServerShutdownApi`, unwraps `::ffff:` IPv4-mapped addresses and treats the
whole `127/8` block as loopback. It is tested (`security/loopback.test.ts`). **Nothing new is needed
for the primitive** — only for the policy on top of it.

`requireAdmin` still runs last and unchanged, so a signed-in **non**-admin is refused everywhere,
exactly as today.

### 3.3 The opt-out

```
allowRemoteAdmin() = process.env.WS_SCRCPY_ALLOW_REMOTE_ADMIN === '1'
                  || effectiveAppConfig().allowRemoteAdmin === true
```

- **Env var wins and is first-class.** A container or headless install has nobody at a browser on
  loopback, so the env var is the only path that does not require `docker exec`. `qa-harness` uses
  it. Precedent: `WS_SCRCPY_DOCKER` is read exactly this way at `Config.ts:598`.
- **Config key** `allowRemoteAdmin?: boolean` joins `AppConfig` (`Config.ts:49` area), its
  `validateField` case (`Config.ts:271` switch), and the `composeAppConfig` merge (`Config.ts:316`
  block). It is **not** a `TRIO_KEYS` member (`Config.ts:354`) — it does not participate in the
  first-run trio.
- **The config key is set through the card, and that PATCH is itself operator-gated.** The button is
  therefore inert for a remote caller even if the client-side variant is forged.

### 3.4 Where it applies

| Route | File | Change |
|---|---|---|
| `POST/DELETE /api/users…` | `api/UsersApi.ts:23` | `requireAdmin` → `requireOperator` |
| `PATCH /api/config` | `api/ConfigApi.ts:31` | `requireAdmin` → `requireOperator` |
| `/api/service/*` | `api/ServiceApi.ts:188` | `requireAdmin` → `requireOperator` |
| `/api/dependencies/*` | `api/DependencyApi.ts:16` | `requireAdmin` → `requireOperator` |
| `/api/updates/*` | `api/UpdatesApi.ts:46` | `requireAdmin` → `requireOperator` |
| `POST /api/auth/enable` · `disable` | `api/AuthApi.ts:134,145` | `requireAdmin` → `requireOperator` |
| `POST /api/server/shutdown` | `api/ServerShutdownApi.ts:129` | **see below** |

**`GET /api/config` is NOT gated.** It is the launcher's own readiness probe, deliberately exempt
from the instance token, and `qa-harness` uses it as `ReadyPath` (`config/linux.psd1:81`) as does the
image's own `HEALTHCHECK`. It stays open, and gains the `adminScope` field in §3.5.

**`ServerShutdownApi` keeps its bespoke ladder** rather than adopting `requireOperator` wholesale.
Its off-box branch (token required → 403; signed-in required in locked mode → 401) is load-bearing
for the cookieless tray helper, and row 20.6 exists to catch a regression there. The one change: its
open-mode off-box path additionally consults `allowRemoteAdmin()`. Its long doc comment
(`ServerShutdownApi.ts:38-62`) is updated in the same edit so the file keeps explaining itself.

### 3.5 Telling the client which state it is in

`GET /api/config` gains one field alongside the existing `runtime` block (`api/ConfigApi.ts:23`,
`Config.getFirstRunStatus()`):

```ts
runtime.adminScope: 'local' | 'remote' | 'authenticated'
```

- `'local'` — open mode, no opt-out, caller is **not** on loopback → admin refused, show the remote
  card
- `'remote'` — open mode, opt-out active → admin allowed, show a persistent warning strip
- `'authenticated'` — `authEnabled` is on → normal auth rules, **no card at all**

The server computes this per-request; a browser cannot reliably determine its own source address, so
this must come from the server. `GET /api/config` is token-exempt, so the card renders even before
the instance token lands.

### 3.6 The card

New `src/app/client/AdminScopeBanner.ts`, following `FirstRunBanner` (`src/app/client/FirstRunBanner.ts`)
— a container `div`, `static create()`, `getElement()`, `destroy()`, and the same refresh-on-poll shape.

**On the machine itself (`adminScope: 'local'`, caller on loopback):**

> **Admin actions are limited to this machine.**
> No sign-in is configured, so anyone on your network can reach this server. Admin actions — users,
> configuration, shutdown — are restricted to this machine as a result.
>
> **[Set up sign-in]** · [Allow remote admin without sign-in]

**From anywhere else (`adminScope: 'local'`, caller off-box):**

> **Admin actions are disabled for remote clients.**
> This server has no sign-in configured. To manage it, open this page on the machine running the
> server — or set `WS_SCRCPY_ALLOW_REMOTE_ADMIN=1`.

**No button on the remote view.** The card is informational to everyone and actionable only from
loopback. Rendering it remotely tells an attacker the posture — which is fine: `SECURITY.md` already
states it publicly, and obscurity here buys nothing but confused users.

`[Set up sign-in]` opens the existing auth setup path (`POST /api/auth/enable`). It is deliberately
listed first and marked recommended: for almost every real user, *turn on sign-in* is the right
answer, and the card should be a funnel toward it rather than a switch that defeats the guard.

### 3.7 The confirmation modal

`[Allow remote admin without sign-in]` opens a red-text warning built on the existing
`ConfirmModal` / `AdminConfirmModal` static-`confirm(): Promise<boolean>` shape:

> **⚠ This makes anyone on your network an administrator.**
> With no sign-in configured, allowing remote admin means **any device that can reach this server**
> can create and delete users, change configuration, and shut the server down. Nothing is protected
> by a password.
> Only do this on a network you fully control.
>
> **[Set up sign-in instead]** *(recommended)* · [I understand — allow remote admin]

The recommended button takes initial focus; the risky one does not.

⚠️ **Reuse the base class correctly.** `Modal`'s constructor already appends to `document.body` and
calls `showModal()`. Calling either again throws `InvalidStateError`, which rejects the promise and
silently breaks the buttons while leaving the dialog visible — a real production bug diagnosed
2026-05-21 and documented at `AdminConfirmModal.ts:25-41`. The test stub is now spec-realistic; keep
it that way.

### 3.8 Dismissal

The card is dismissible per user. Its flag joins `resetPromptSettingsPayload()`
(`src/app/client/SettingsModal.ts:123`) — **and its test at `SettingsModal.test.ts:175` asserts the
exact object, so both change together.** Without that registration, "don't show again" is one-way and
Reset Prompts cannot bring it back; that trap is already documented for `PortChangeModal`.

Dismissal hides the card only. The Settings page shows the live `adminScope` regardless, so the state
is always discoverable.

---

## 4. How this collapses item 81

Item 81 offered three options. This design is not a fourth — it is all three, correctly ordered:

- **(c) document it** — already shipped (beta.102, #609); this design keeps those docs true.
- **(a) loopback-guard the admin API** — the default behaviour, generalised past the naive version
  that `ServerShutdownApi` had to walk back.
- **(b) require a real authenticated session** — what the card actively pushes users toward, and the
  only path that works in a container. Reached by consent rather than by force.

**Item 81 closes when this ships.**

---

## 5. Sequencing — qa-harness goes first

`qa-harness` drives the Linux suite from a **sibling container** across a per-run Docker network
(`compose/wssw-linux.yml`), and its Windows Playwright specs drive the guest from the driver
container. Neither is on loopback. Two rows break the moment this guard lands:

- **Row 18.7** (**in qa-harness**: `qa-harness/docs/superpowers/plans/2026-09-01-p3-wssw-linux-suite.md:1326`) POSTs `/api/users`
  via `page.evaluate` to prove a **non-admin** gets 401/403. Under a blanket guard the **admin** gets
  403 too, so the row stops distinguishing the two and would pass against a server with no
  authorization at all.
- **`stopexit.spec.ts:152`** asserts `POST /api/server/shutdown` → 200 from the page.

`qa-harness` has already met this exact failure class once and wrote it up — **in qa-harness**:
`qa-harness/docs/traps.md:1294`, *"`/api/embed-request` 403s continuously when the app is driven from
another host."*

**Order of landing:**

1. **`qa-harness` first.** Set `WS_SCRCPY_ALLOW_REMOTE_ADMIN=1` in `compose/wssw-linux.yml` and the
   Windows guest environment. **This is a no-op until ws-scrcpy-web reads the variable**, so it is
   safe to land at any time and carries zero risk of breaking a run.
2. **ws-scrcpy-web second**, once (1) is merged.

Landing them the other way round turns the harness red on its next run.

### Smoke register

**Row 20.6** ("Settings stop-server button works inside a container") is the row
`ServerShutdownApi`'s comment names, and it is affected. `docs/smoke-tests/` is **off limits** —
todo task 28 will rewrite the register and its row markers — so this goes to `qa-harness` as a relay
**request**, exactly as item 126 did. Do not edit the register here.

---

## 6. Testing

Per guarded route, four cases:

| Case | Expected |
|---|---|
| Caller on loopback, open mode | allowed |
| Caller off-box, open mode, no opt-out | **403** |
| Caller off-box, open mode, `WS_SCRCPY_ALLOW_REMOTE_ADMIN=1` | allowed |
| Caller off-box, `authEnabled`, signed-in admin | allowed (loopback irrelevant) |

Plus:

- Signed-in **non**-admin is refused from loopback and from off-box — `requireAdmin` still last.
- `GET /api/config` answers **200 with no token from off-box** in every one of the above. A
  regression here breaks the launcher probe, the image `HEALTHCHECK` and the harness `ReadyPath`
  simultaneously.
- `adminScope` returns each of its three values under the matching conditions.
- `resetPromptSettingsPayload()` includes the new flag (update the existing exact-object assertion).
- `ConfirmModal` reuse does not double-`showModal()`.

Existing suites to update rather than duplicate: `__tests__/adminAuthorization.test.ts`,
`__tests__/usersApi.test.ts`, `__tests__/ServerShutdownApi.test.ts`,
`__tests__/configApi.redirectPort.test.ts`, `app/client/__tests__/SettingsModal.test.ts`.

---

## 7. Open questions

**Q1 — Should the Docker image default `authEnabled` to on?**
In a container loopback identifies nothing, so sign-in is the only honest proof of operator. Turning
auth on by default (with a forced first-run password) would be the strongest posture and would make
the container case need no opt-out at all.

**Not decided here, and deliberately out of scope** — it changes the Docker first-run story, which
belongs to **todo item 2**. This design works either way: without it, the documented container paths
are `WS_SCRCPY_ALLOW_REMOTE_ADMIN=1` in compose, or a one-time
`docker exec <c> curl -X POST http://127.0.0.1:8000/api/auth/enable …` to turn sign-in on from
inside. Carry Q1 to item 2.

**Q2 — Should an unclaimed server be claimable remotely?**
Considered and **rejected**. A "first writer sets the password" bootstrap would let a Docker user
enable sign-in remotely without `docker exec` — but it adds a race an attacker can win, and locking
the owner out of their own server is a worse failure than the one being fixed. The env var and
`docker exec` already solve the case without new attack surface.

---

## 8. Non-goals

- **Not touching the startup UI.** The Welcome/first-run flow is well designed and stays as it is;
  the card is additive.
- **Not changing the instance token.** Its job (browser-vs-script) is legitimate and unchanged. This
  design stops *other* code treating it as an authenticator.
- **Not narrowing `isHostAllowed` or the `Origin` handling.** Real, related, and separate — the
  Origin/Host match is the CSRF layer per `security/cookiePolicy.ts`, and it is not what this fixes.
- **Not editing `docs/smoke-tests/`.** See §5.

---

## 9. Estimate

| | |
|---|---|
| `qa-harness` (lands first) | 1–2 h |
| ws-scrcpy-web server guard + config + `adminScope` | 3–4 h |
| Card + modal + dismissal wiring | 2–3 h |
| Docs (README Access control, `SECURITY.md`, TECHNICAL_GUIDE §24) + CHANGELOG | 1 h |
| Tests | 2 h |

**8–10 h in ws-scrcpy-web**, one `release:beta` PR, one beta cut.
