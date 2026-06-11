# beta.61 — Linux system-service fixes (fcontext + uninstall teardown) design

**Status:** approved (brainstorm) 2026-06-11. **Linux-only.** Two independent, runtime-confirmed bugs found during the beta.60 Fedora smoke (#9 system-scope pass), plus the two robustness gaps they exposed.

**Scope (user pick, 2026-06-11): Complete** — both root-cause fixes + launcher-resilience + UI-honesty.

**Tech:** TS server (vitest + `tsc`), Rust launcher (`cross`), frontend. `git -C "C:/Users/jscha/source/repos/ws-scrcpy-web"`; branch `beta61-linux-service-fixes`; no push until gates green.

---

## Evidence (beta.60, Fedora VM, captured `D:\OneDrive\20260611-144431-9-2.2-selinux-usr_t\` + live journal)

- **2.2:** `/var/opt/ws-scrcpy-web` dir + config.json + control + logs all `usr_t` (expected `var_lib_t`). **2.3:** only the `/opt` bin_t fcontext rule exists; the `/var/opt` var_lib_t rule is **absent**. `/opt/ws-scrcpy-web/dependencies` is **`data_home_t`** (not bin_t). **10-avc:** no denials.
- **Uninstall journal:** `wsscrcpy-teardown-*.service` (the `systemd-run --system` transient unit) **core-dumps** — `ws-scrcpy-web-launcher.exe panicked at common/src/config.rs:53: data_root_for_linux: none of DATA_ROOT, XDG_DATA_HOME, or HOME is set` → `status=6/ABRT`. The **install** handoff in the same journal spawns with `--setenv=DATA_ROOT=/var/opt/ws-scrcpy-web`; the teardown spawn does not.

---

## Bug 1 — fcontext labeling never applies `var_lib_t` (the gate, #9 2.2/2.3)

### Root cause
`buildSystemInstallScript` (`src/server/service/SystemdClient.ts:365`) labels via a single fragile chain:

```
( ( (semanage -a bin_t /opt || semanage -m bin_t /opt) && (semanage -a var_lib_t /var/opt || semanage -m var_lib_t /var/opt) && restorecon -Rv /opt && restorecon -Rv /var/opt ) || chcon -t bin_t <AppImage> || true )
```

A system install is gated machine-wide-first, so the `/opt` bin_t rule **always pre-exists** → `semanage fcontext -a` fails "already defined", and `semanage fcontext -m -t bin_t` **also fails** on the unchanged rule. The leading `( -a || -m )` therefore returns non-zero, the `&&` chain short-circuits, and the var_lib_t add + **both** restorecons never run. Proof: deps stayed `data_home_t` (would be bin_t if `restorecon /opt` had run), the var_lib_t rule is absent, and `/var/opt` is `usr_t`. beta.58's `-a || -m` "fix" was insufficient because `-m`-to-an-unchanged-type also fails.

### Fix — robust by construction (no chain to short-circuit)
The `/opt` bin_t labeling is **not this script's job** — the machine-wide install already created the rule and ran restorecon. So:

- **Drop the bin_t `-a || -m` re-add step entirely.**
- Emit the labeling as **independent, individually non-fatal** steps (not an `&&` chain):
  1. `semanage fcontext -a -t var_lib_t '/var/opt/ws-scrcpy-web(/.*)?' || semanage fcontext -m -t var_lib_t '/var/opt/ws-scrcpy-web(/.*)?' || true`
  2. `restorecon -Rv /opt/ws-scrcpy-web || true`  *(relabels the freshly-copied deps `data_home_t → bin_t` — fixes that mislabel)*
  3. `restorecon -Rv /var/opt/ws-scrcpy-web || true`  *(applies var_lib_t)*
- **Remove the `chcon` fallback** — it masked the failure and only ever relabeled one file.

On a clean install the var_lib_t `-a` succeeds (rule absent → added); on a re-install the `-m` covers it; `|| true` guarantees no step can short-circuit the others. The seed config (`/var/opt/.../config.json`) is still written *before* the restorecons, so it picks up `var_lib_t`.

### Same pattern elsewhere (migration-audit)
`buildMachineWideInstallScript` (~:434) and `buildSystemMigrationScript` (~:587) carry the same `-a || -m`-in-an-`&&`-chain shape. Apply the same independence fix (grep `semanage fcontext` across `SystemdClient.ts` during impl to confirm the full set).

---

## Bug 2 — system-service uninstall is a no-op (#9 5.1), three parts

### 2a — the crash (makes uninstall actually work)
`handleUninstall` (`src/server/api/ServiceApi.ts:687-690`), system-scope path, builds the teardown spawn **without** `--setenv=DATA_ROOT`:

```
systemd-run --system --collect --unit=wsscrcpy-teardown-<ts> /opt/.../ws-scrcpy-web-launcher.exe --linux-service-teardown --scope system --unit WsScrcpyWeb
```

A `systemd-run --system` transient unit inherits no HOME/XDG either, so the launcher panics at startup. **Fix:** add `--setenv=DATA_ROOT=${SYSTEM_STATE_DIR}` (`/var/opt/ws-scrcpy-web`) to the system-scope `runArgs`, mirroring the install handoff.

### 2b — launcher resilience (defense-in-depth)
`launcher/src/main.rs:76` calls the panicking `common::config::data_root_from_env()` solely to copy-truncate-rotate `service.log` (a best-effort convenience, from the beta.59 10 MB rotation). That makes *any* subcommand spawned without DATA_ROOT (e.g. the teardown) crash before its real work. **Fix:** add `common::config::try_data_root_from_env() -> Option<PathBuf>` (the non-panicking sibling that returns `None` instead of hitting the `data_root_for_linux` panic) and use it for the best-effort rotation at main.rs:76. The hard panic in `data_root_for_linux` stays for the supervisor path, where a persistent data root is genuinely mandatory.

### 2c — UI honesty
`ServiceApi` returns `{ok:true, status:'shutting-down'}` immediately after spawning the teardown (fire-and-forget), so the UI shows "service removed, restart for local mode" even when the teardown core-dumps. **Fix:** mirror the existing install-poll pattern — keep returning `shutting-down`, but the frontend polls `/api/service/status` until the service is actually gone (`getInstalledScope` → null / `status` not running), with a timeout that surfaces a real failure instead of the false "removed."

---

## Testing strategy (why beta.58 shipped green-but-broken)

beta.58's test only asserted the generated script *string* contained `-a || -m` — it never exercised the runtime, so it could not catch `-m` failing on an unchanged rule. beta.61 tests target **behavior**, not strings:

- **fcontext (vitest):** assert the builder emits the var_lib_t add **and both** restorecons as **independent steps** with **no `&&` chain and no `chcon` fallback** — so a single `semanage` failure is structurally unable to skip the rest. Repeat the assertion for all three builders. *(Stretch, if cheap on Linux CI: execute the generated step list against injected stub `semanage`/`restorecon` tools that simulate "already defined", and assert the var_lib_t rule + restorecons still ran.)*
- **teardown DATA_ROOT (vitest):** assert the system-scope teardown spawn arg-vector contains `--setenv=DATA_ROOT=/var/opt/ws-scrcpy-web` (mirror the existing install-handoff spawn test).
- **launcher resilience (cross test):** `try_data_root_from_env()` returns `None` (does not panic) when DATA_ROOT/XDG_DATA_HOME/HOME are all unset; still returns `Some` when any is set. The existing `data_root_for_linux_panics_…` test stays (the hard-fail contract is unchanged where it matters).
- **UI honesty (vitest):** the uninstall-poll classifier resolves "service gone" → success and "still present after timeout" → surfaced failure.

All TDD (RED → GREEN). Full gates: `tsc --noEmit` 0 · vitest · `cross test` · `cross clippy -D warnings` · webpack.

---

## Components / files

- `src/server/service/SystemdClient.ts` — fcontext rework in `buildSystemInstallScript` (+ `buildMachineWideInstallScript`, `buildSystemMigrationScript`).
- `src/server/api/ServiceApi.ts` — `--setenv=DATA_ROOT` in the system-scope teardown spawn; the uninstall success path waits-on / signals poll instead of immediate success (coordinate with frontend).
- `common/src/config.rs` — new `try_data_root_from_env()`.
- `launcher/src/main.rs` — use `try_data_root_from_env()` for the service.log rotation at :76.
- `src/app/...` (frontend) — uninstall reconnect/verify poll (reuse the install-poll affordance).

## Exit criteria (Fedora, runtime — the re-smoke)

Re-run #9 on beta.61 from a clean slate: system-service install → **2.2** `/var/opt` = `var_lib_t`, **2.3** both the `/opt` bin_t and `/var/opt` var_lib_t rules present, deps now `bin_t`, **zero AVC**; **5.1** uninstall **actually removes** the service (unit gone, `/opt`+`/var/opt` gone, app relaunches local same-port) and the UI only reports success once it's truly gone; **5.4** fcontext rules empty after uninstall. Then continue #9 → the rest of the smoke.

## Out of scope (tracked in `todo_ws_scrcpy_web.md`, fix later)

- **Cold-start-via-`.desktop` opens no browser tab** until a 2nd click — auto-open-browser is gated `firstRunComplete === false` (`openBrowser.ts`), so a cold start past first-run boots the server without a tab; the 2nd click opens it via the defer path.
- **Smoke-doc nit:** row 5.8 "pgrep clean" wording is misleading (a relaunch leaves the local instance + its pre-warmed adb daemon; the adb daemon is reaped at 12.1).
- **`capture-logs.sh` polish:** grabs whole-history journal instead of `-b` (so old crash-loop noise leaks in) and omits the system service's complete `ws-scrcpy-web.log`.
