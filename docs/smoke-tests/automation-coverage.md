# Automation coverage register

Per-row automation status for `smoke-test.md`. **Seeded by P3 task 5; the full
127-row triage lands in task 16.** Until then this file holds only the container
findings task 5 was required to record rather than fix silently.

Companion to `smoke-test.md`, not a replacement: that document remains the
canonical list of rows and their steps.

---

## Module 20 — container (Docker) behaviour

New module. Modules run 1–19 with 17 a deliberate tombstone, so 20 is the next
free number.

### Gated in task 5 (SP4 E4)

| # | Affordance | Container behaviour | Status |
|---|---|---|---|
| 20.1 | Settings → Service | replaced by *"service install not applicable — this instance runs in a container."* | automated (`settingsModal.dockerGating.test.ts`; container smoke in task 11) |
| 20.2 | Settings → Updates | replaced by *"update via `docker pull jchapz30/ws-scrcpy-web:latest`."* | automated (same) |
| 20.3 | libfuse2 banner | **nothing to hide — the gate no longer exists** | n/a, see below |

**20.3 is satisfied by deletion, not by gating.** SP4 decision 4 requires the
libfuse2 banner hidden in Docker, but the libfuse2 first-run gate was removed
end-to-end in an earlier release — `isLibfuse2Installed` / `ensureLibfuse2`
(`SystemdClient.ts`), the `/api/updates/install-libfuse2` endpoint, the
`libfuse2Installed` status field, **and the Settings prompt in
`SettingsModal.ts`** (see CHANGELOG, "Removed the libfuse2 first-run gate").
`grep -ri libfuse src/` returns nothing today. The requirement is moot rather
than outstanding, and is recorded here so a future reader does not go looking
for a gate to implement.

### Findings — surfaced by task 5 step 3, deliberately NOT fixed there

Task 5's grep for host-assuming affordances surfaced three more, all in the
**Server** section, which task 5 does not gate. Recorded rather than fixed,
because gating the Server section is a scoped decision and not part of SP4
decision 4's locked list.

| # | Affordance | In a container | Assessment |
|---|---|---|---|
| 20.4 | **"install for all users"** — the Settings → Server *row* | POSTs `/api/service/install-system-wide`, which runs `pkexec`, relocates to `/opt` and re-execs | **Finding, still open.** A container has no polkit and relocating inside the image is meaningless; the row is Linux-gated but not container-gated. Needs a decision: hide it in Docker, or leave it and let it fail loudly. |
| 20.7 | **the same offer as a first-run modal** (`SystemWideInstallModal`) | opened on first load of every container and, being a `<dialog>`, swallowed the clicks meant for the page beneath it | **FIXED.** `offerMachineWide` now requires `status.docker !== true`. It could not be left to the decline marker, which is per-data-root: a fresh volume has none. Asserted by `docker-gating.spec.ts`. |

**20.7 is why the container suite exists.** It is Linux-only, so it cannot appear on a Windows dev box; and because the modal is loaded by a dynamic `import()`, a fast machine can land the next click before it renders. It therefore **passed locally and failed only in CI** — the same trap `playwright.config.ts` already documents for this exact modal in the fast tier. The fix is a gate rather than a marker precisely so it stops being a race.
| 20.5 | **"uninstall ws-scrcpy-web"** | tears down a service/install that does not exist here | **Finding.** The container equivalent is `docker rm`. Same decision as 20.4. |
| 20.6 | **"stop server & exit"** | graceful shutdown — `adb kill-server`, service release, exit 0 | **Correct in a container, and load-bearing.** This is exactly what smoke row 12.1 asserts against `docker stop` (SIGTERM reaching node *through* `start.sh` via `tini -g`). Must NOT be gated. |

20.4 and 20.5 are the two rows a container-aware Server section would cover. They
are listed as one decision because they share a cause: both are install-lifecycle
affordances whose lifecycle the container owns instead.

---

## Module 18 — auth subsystem (opt-in login)

All twelve rows are automated by `tests/e2e/auth.spec.ts` (P3 task 10) as one
serial state machine: 18.2 secures the admin account and turns login on, rows
18.3–18.10 run against the locked server, 18.11 returns it to open mode, and
18.12 restarts a server of its own. Each row was designed with an inverted
assertion and an app mutation it must catch; `tests/e2e/README.md` records the
harness facts the file relies on (the per-run database wipe, `retries: 0`, the
return-to-open-mode `afterAll`, the never-retry-a-login rule).

| # | Row | Status |
|---|---|---|
| 18.1 | default open mode | automated |
| 18.2 | secure the admin account | automated — the farewell text is recorded by an observer and read back from the login page, because the client reloads in the same synchronous run |
| 18.3 | login | automated — the row's "dependencies" is the page-level panel, not a Settings section; the spec asserts the five section headings and the admin-only rows |
| 18.4 | brute-force lockout + generic error | automated — the enumeration half is byte-identical bodies plus identical UI text; timing blinding is covered by the unit tests, not end to end |
| 18.5 | admin clears a lockout | automated |
| 18.6 | manage users + last-admin guard | automated |
| 18.7 | non-admin authz (UI + server) | automated — the row's "401/403" is exactly `403 {"error":"forbidden"}` for an authenticated non-admin; 401 is only ever the no-session case |
| 18.8 | change own password | automated |
| 18.9 | logout | automated — proves the session row is deleted server-side, not just the cookie |
| 18.10 | WebSocket streams gated | automated — same context before and after login, so only the session cookie differs |
| 18.11 | return to open mode | automated |
| 18.12 | sessions survive restart | automated on a spec-owned server (port 8124), never the shared one |

### Findings — surfaced by task 10, deliberately NOT fixed there

| # | Finding | Assessment |
|---|---|---|
| 18.13 | **The client and the server disagree about when the first-user lockdown applies.** `UsersModal` shows the "Secure the admin account" block whenever `me().authEnabled` is false; the server takes the lockdown branch only while no enabled admin has a password. After 18.11 (login disabled, admin still passworded) the client offers "Secure & add user", the server answers the normal-create `201 {id}`, and the client announces "Login is now required. Reloading…" into an app that is still open. | **Finding, open.** The spec asserts neither behaviour. Fix direction: key the client on the same fact as the server (expose it on `/api/auth/me`, or have the server refuse the admin fields when it will ignore them). |
| 18.14 | **Live WebSocket connections survive logout and disable.** Deleting the session row refuses NEW connections (4401, proven by 18.9/18.10) but nothing tears down sockets the SPA opened while the session was valid. | **Finding, open.** Decide: revoke live sockets when their session is deleted (logout, disable, delete), or document that a stream outlives its login. Not asserted either way. |
| 18.15 | **`/login-assets/` is allow-listed in `AuthGate` but nothing serves it**, and there is no `/login` route (the login page is served inline). | **Code-quality finding.** A dead allow-list entry is a standing invitation to serve something unauthenticated by accident; remove it or give it a purpose. |

---

## Modules 9, 10, 12 and row 1.9 — server surface, dependencies, lifecycle

Ten rows, automated by `tests/e2e/server-surface.spec.ts`, `lifecycle.spec.ts`
and `dependencies-panel.spec.ts` (P3 task 11). Anything that stops or restarts
a server, needs a boot-time config key, reads the server's log, or needs locked
mode runs on a spec-owned server; the two rows that need a host the fast tier
cannot be (`1.9`, `9.5`) are `@docker` and bring up their own compose stacks
from `tests/docker/` (see `tests/e2e/README.md`).

| # | Row | Status |
|---|---|---|
| 1.9 | first-run bootstrap banner + Retry | automated, container tier — the stack boots with no working resolver, so every download fails at once; Retry after the resolver is restored clears the banner |
| 9.4 | Dependencies panel | automated: the table, check-for-updates and the admin gate. **Not** the per-dependency update and the restart after it: the `update` button renders only for `update-available`, which an up-to-date install cannot offer deterministically, and there is no standalone restart control (only `Restart Now` after a restart-requiring update) |
| 9.5 | shell unavailable shows a reason | automated, container tier — the API half (`{"shell":false,"shellReason":"no-seed-package"}`), with the full image as the `{"shell":true}` contrast. The per-device shell link's tooltip needs a tracked device: device tier |
| 10.1 | service status API | automated |
| 10.3 | logs clean | automated for the server's own `ws-scrcpy-web.log`: the teardown line on stop, and zero `ERROR`/`Error:` lines outside an allow-list whose one entry (the missing node-pty seed, finding 10.9) applies only on a tree that really lacks the seed. `launcher.log` belongs to the Linux launcher and stays manual |
| 10.4 | per-instance token / reload on restart | automated on a spec-owned server |
| 10.5 | 404 + security headers | automated — see finding 10.7 for the row's wording |
| 10.6 | `allowedHosts` | automated — the listed host served, an unlisted one refused, defaults intact, on a spec-owned server seeded with the key |
| 12.1 | clean exit + adb teardown | automated for the bare server (the UI path: confirm, the stopped notice, exit 0, no `.restart` marker, the teardown lines in order). The container half is 20.6 / 20.12 |
| 12.4 | `DATA_ROOT` honoured | automated for the Node side — and see finding 12.5 for what "same root" actually rests on |

### Findings — surfaced by task 11, deliberately NOT fixed there

| # | Finding | Assessment |
|---|---|---|
| 12.5 | **The log file and the dependencies folder are keyed on `DEPS_PATH`, not `DATA_ROOT`.** A bare `node dist/index.js` with only `DATA_ROOT` set puts `config.json` and the store under it but logs to the repo root and, on Linux, hydrates into `<repo>/dependencies`. Row 12.4's "Node side and launcher agree" holds only because the Rust launcher sets both variables; Windows ignores `DATA_ROOT` entirely. | **Finding, open.** Fix direction: derive the dependencies default from the resolved data root on every platform, so `DATA_ROOT` alone means what the row says. The e2e configs now set `DEPS_PATH` explicitly (this PR), which also stops the fast tier's server logging into the repo root. |
| 20.14 | **In the container there is no server log at all.** `start.sh` exports `DEPS_PATH=/app/dependencies` (a symlink to `/data/dependencies`), so the log path resolves to `/app/logs/ws-scrcpy-web.log` — and `/app` is root-owned while the app runs as uid 1000, so the directory is never created and every write no-ops (measured 2026-09-03: no `/app/logs`, no `/data/logs`, `docker logs` carries only `start.sh`'s own lines, because the console echo is TTY-only). SP4 §13 ("config + logs survive") and smoke row 20.11 assume a log on the volume. | **Finding, open — worse than "not on the volume".** Same root cause as 12.5; until the log follows the data root, the container is unloggable and 12.1's container half (20.6/20.12) cannot be automated. |
| 20.16 | **adb aborted on every invocation inside the container.** The entrypoint's step-down kept the root shim's `HOME=/root`; adb creates `$HOME/.android` on every run, `adb --version` included, and aborts with a core dump when it cannot (`Cannot mkdir '/root/.android'`). The server's version probe swallowed the abort into `installedVersion: null`, so the first-run banner named adb as failed to download on every boot of the shipped image, the Dependencies panel showed it as not installed, and no device could have connected. Nothing in the container tier had asked; row 20.9 was marked as proven by `up --wait`, which only proves the loopback health probe. | **FIXED in the task 11 PR** (`docker/entrypoint.sh` exports a volume-backed `HOME=/data/home` before `setpriv`, so the adb key pair also survives `docker rm`, and owns that directory on **every** boot — a volume from an earlier image is already owned by the app user, so the one-time recursive chown skips it and a root-owned `/data/home` would reproduce the abort; the guard caught exactly that on a stale volume), and now guarded: `docker-gating.spec.ts` asserts every dependency, adb's real version included, is installed on a fresh volume. Found by row 1.9's Retry never clearing the banner. |
| 20.15 | **The restart marker is written where the Docker launcher never looks.** Node writes `<dataRoot>/.restart` (`/data/.restart`); `start.sh` checks `$DEPS_PATH/.restart`. Restart still works because it keys on exit code 75, so this is dead plumbing rather than a broken restart. | **Code-quality finding.** Pick one path. |
| 10.7 | **An unknown `/api/*` path answers with the SPA shell when navigated to as a document.** The static fallback keys on `Accept: text/html` plus an extensionless path, and `/api/no-such-route` is extensionless; a JSON caller gets the 404 the row describes, a browser address bar gets 200 and the shell. | **Finding, open.** Exclude `/api/` from the SPA fallback. The spec asserts the JSON case only. |
| 10.8 | **API JSON responses and the request gate's 403 carry no `X-Content-Type-Options` / `X-Frame-Options`.** Static responses, the login page and its 401 do. | **Finding, open.** Apply `securityHeaders()` in the gate's rejection and in the JSON handlers' common `writeHead`. |
| 9.6 | **The Dependencies panel is not hidden from a user-role account.** It renders its heading and table for everyone and, on the 403, shows `Failed to load dependencies` — the row's "doesn't see it" is the panel failing, not being gated. | **Finding, open.** Gate the panel's mount on the same role the API uses, or accept the failure row as the design and reword the smoke row. |
| 9.7 | **`retry-install` replies before the retried install has finished.** The response can be `{"success":false,"stillMissing":["adb"],"errors":{}}` for a retry that completes ten seconds later; the banner's own poll is what actually clears it. | **Finding, open.** Either await the install or document the reply as "started", and let the client key off the poll only. |
| 10.9 | **The node-pty resolver reports the seed's absence at ERROR level.** A checkout that has not run `npm run stage-seed` (CI's `npm ci` + build tree) logs `[NodePtyResolver] ERROR no seed node-pty package found; cannot resolve` at every boot, for a condition the app itself treats as a capability, not a fault (`/api/capabilities` answers `shellReason: 'no-seed-package'`, row 9.5). The Linux CI run of 10.3 caught it; the spec now tolerates that one line only while the seed really is absent from the tree. | **Finding, open.** Log it at WARN, once, next to the capability it already reports, and 10.3's allow-list goes back to empty. |
