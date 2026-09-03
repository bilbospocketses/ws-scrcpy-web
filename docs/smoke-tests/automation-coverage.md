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
| 20.2 | Settings → Updates | replaced by *"update via `docker pull bilbospocketses/ws-scrcpy-web:latest`."* | automated (same) |
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
