# Linux Service-Mode beta.31 Fixes — Design

**Date:** 2026-06-01
**Status:** Approved (brainstorm); implementation plan next.
**Goal:** Fix the 7 issues found smoke-testing **v0.1.30-beta.30**'s Linux service-mode (items 32/33) on real Fedora 44 (SELinux enforcing), plus a bookmark-modal global-dismiss enhancement. Ship as **v0.1.30-beta.31**.

**Companion:** follows `2026-06-01-linux-service-mode-fix-and-update-design.md` (Phase 1 = items 32/33, shipped beta.30). Phase 2 (service-mode in-app update apply, todo item 39) stays separate and gated on this smoke passing.

## Smoke results that motivate this (real Fedora 44, SELinux enforcing)
- **Item 33 (system-scope SELinux install): VERIFIED FIXED** — `/opt` staging + `bin_t` + fcontext rule + zero AVC + serves clean.
- **Item 32 user-scope uninstall: WORKS.**
- **Item 32 system-scope uninstall: FAILS** — SELinux AVC: `init_t` denied `execute` on the teardown helper `ws-scrcpy-web-launcher.exe` (labelled `data_home_t` in `~/.local/share/...`). Same SELinux class as item 33, hitting the helper instead of the AppImage.
- **Install handoff** leaves the originating local instance running → multiple concurrent instances (observed THREE) + a false "port discovery timed out".
- **UX:** a user-scope install shows the bookmark modal instead of the service-installed modal; the disabled scope-radios are unreadable.

## Principle 0 — Windows service mode stays byte-for-byte identical
Windows service install/uninstall is verified-working and MUST NOT change behavior. Every fix is either **Linux-platform-gated** or an **additive client change** that leaves the existing Windows path untouched. The existing win32 service tests are the regression fence — they must stay green, unchanged.

---

## The fixes

### 1. systemd `StartLimit*` keys belong in `[Unit]`, not `[Service]`
**Evidence:** journal warns `Unknown key 'StartLimitIntervalSec' in section [Service], ignoring` on every unit load (beta.30 + earlier). systemd requires `StartLimitIntervalSec` + `StartLimitBurst` in `[Unit]` (since v229); ignored in `[Service]` → the restart cap never applies → a failing unit restarts every 5s forever (observed restart-counter 33+).
**Fix:** `SystemdClient.renderUnitFile` (`src/server/service/SystemdClient.ts`) — emit `StartLimitBurst=${maxRestartAttempts}` + `StartLimitIntervalSec=300` in the `[Unit]` block (after `After=network.target`), not `[Service]`.
**Test:** rendered unit places both keys under `[Unit]` (user + system scope).
**Windows:** Linux-only (systemd unit). No Windows impact.

### 2. System-scope uninstall — exec the teardown helper from `/opt` (`bin_t`), elevated
**Evidence:** the system service runs under `init_t`. Its teardown handoff (`systemd-run --system`) execs the helper at `~/.local/share/WsScrcpyWeb/control/operation-server/ws-scrcpy-web-launcher.exe` (labelled `data_home_t`). SELinux denies `init_t` exec of `data_home_t` (AVC confirmed) → teardown never runs → service persists. User scope works because it runs under the unconfined user context (which may exec `data_home_t`).
**Fix (decided: consolidate the helper in `/opt` with the AppImage — no `sh -c`):**
- **Install (system scope):** `buildSystemInstallScript` stages BOTH the AppImage AND a copy of the launcher helper into `/opt/ws-scrcpy-web/`. The existing `/opt/ws-scrcpy-web(/.*)?` → `bin_t` fcontext rule + `restorecon -Rv /opt/ws-scrcpy-web` already labels the helper `bin_t` (no new rule needed — just add the `cp` + `chmod` before the relabel step).
  - **Helper source at install time:** the running AppImage mount (`$APPDIR`). Exact internal path of the launcher binary inside the AppImage to be confirmed during implementation; fall back to the home staged copy (`<dataRoot>/control/operation-server/ws-scrcpy-web-launcher.exe`) if `$APPDIR` is unset (from-source runs). Sourcing from the mount avoids the "never-updated fresh install lacks the home copy" risk.
- **Uninstall (system scope):** the teardown handoff execs `/opt/ws-scrcpy-web/ws-scrcpy-web-launcher.exe` (`bin_t` → `init_t` can exec → no AVC), via `systemd-run --system --collect --unit=wsscrcpy-teardown-<ts>`, run **directly when the serving Node is already root** (`process.getuid?.() === 0` — the system service itself) or **`pkexec`-prefixed when it isn't** (a non-root instance triggering it → polkit prompt, mirroring install). Reuses the existing Rust teardown helper unchanged.
- **User scope:** UNCHANGED — home helper, `systemd-run --user`, includes the local relaunch (verified-green).
**Files:** `SystemdClient.buildSystemInstallScript` (+ stage helper) · `SystemdClient.install` / install path (helper-source resolution) · `ServiceApi.handleUninstall` (system-scope handoff: `/opt` helper path + root-vs-`pkexec` branch).
**Notes:** the teardown's `rm -rf /opt/ws-scrcpy-web` unlinks the running helper — fine on Linux (inode held until process exit). The helper's best-effort adb-reap may log a benign AVC under `init_t` (home `adb` is `data_home_t`); `systemctl stop` already reaps the unit's cgroup adb, so it's moot — optional Rust cleanup, out of scope here.
**No Rust change** — the helper already performs system-scope teardown; it's just exec'd from a `bin_t` path now.
**Test:** the install script includes the helper `cp` into `/opt`; the uninstall handoff builds the `/opt` helper path + the root-vs-`pkexec` branch (unit tests on the argv builders).
**Windows:** Linux-only (system-scope systemd). Windows uninstall path untouched.

### 3. Local instance must exit after a Linux service install (root of bugs 3 + 4)
**Evidence:** `ServiceApi.handleInstall` (~line 367) schedules the local Node to exit 15s after a successful install ("this instance is useless once the service is running") — but the block is gated `if (result.platform === 'win32')`. On Linux it never fires, so the originating local instance lingers; repeated installs/launches accumulate (observed THREE concurrent), and the lingering instance holds the web port.
**Fix:** fire the local-exit on Linux as well (widen the platform condition; the win32 branch/behavior is unchanged — Linux is added).
**Test:** the exit is scheduled after a successful Linux install (mirror the win32 test).
**Windows:** win32 branch byte-identical; Linux added.

### 4. Install discovery handles a same-port handoff (no false timeout)
**Evidence:** the client install poll (`SettingsModal` ~line 977) completes only when `config.json` mtime CHANGES (service bound a different port) → navigate. Under decision A, once the local instance exits (#3) the service typically reclaims the SAME port → no config change → the poll runs its full 60s → false "port discovery timed out" (the handoff actually succeeded; reload works).
**Fix (additive — Windows navigate path untouched):** keep the existing "config mtime changed + `diskWebPort` → navigate to new port" path. ADD: when the local `/api/service/status` becomes unreachable mid-handoff (the local instance exited per #3), the service is taking over the same port — after a short grace, reload the current URL (with a couple of reachability retries) instead of throwing "lost connection." Outcomes: port shifted → navigate (existing); same port → reconnect-reload (new). The reloaded landing page runs the modal tree (#5).
**Decision A:** "service grabs whatever port, client follows" (mirrors Windows; an occasional `+1` only if the local hadn't released the port yet).
**Files:** `SettingsModal` install poll (the catch/timeout branches).
**Test:** the local-unreachable branch triggers a reconnect-reload, not the error.
**Windows:** additive; the win32 navigate-on-mtime path is unchanged.

### 5. Post-install / landing modal routing + bookmark global-dismiss
**Evidence:** a first user-scope install showed the bookmark modal instead of the service-installed (service-mode first-run) modal — the precedence wasn't honored.
**Fix — modal precedence (post-install landing + every page load):** pick at most one modal:
1. **SERVICE mode** (installMode `user-service` or `system-service`) + service-mode modal not dismissed → **SERVICE-MODE modal** (the "service installed" first-run modal; Linux fires it for BOTH user and system scope; persists until dismissed).
2. **LOCAL mode** + welcome modal not dismissed → **WELCOME modal**.
3. Otherwise → **BOOKMARK check**.

The first-run modal (welcome/service) always takes precedence; the bookmark modal is the fallback once the relevant first-run modal is dismissed.

**Fix — bookmark global-dismiss (new):**
- **Bookmark check:** global-dismiss flag set → never show; else this port already dismissed-for-bookmark → skip; else → show the bookmark modal.
- **Bookmark modal UI** gains a second checkbox: existing **"don't show again for this port"** + NEW **"don't show again — ever, even when the port changes"** (global). Checking global **disables/greys out** the per-port checkbox.
- **OK with global checked** → a confirmation dialog (*"You won't see this bookmark helper again, even when the port changes."*) with **[Cancel] [OK]** in the existing beta.29 white-outline modal-button style. OK → set the global flag + close. **Cancel** → return to the bookmark modal with the global box still checked, flag NOT committed.
- **OK with global unchecked** → existing per-port behavior.
**Storage:** new `bookmarkDismissedGlobally: boolean` in `config.json` (beside the existing per-port `bookmarkDismissedForPort`). [SQLite migration is the separate item 37.]
**Reset:** the Settings "reset welcome and bookmark prompts" action now clears ALL FOUR — welcome, service-mode, per-port bookmark, AND global bookmark — and its confirmation copy is updated to say so.
**Files:** the page-load modal-routing entry point (located during planning) · the bookmark modal component · `SettingsModal` reset handler · `Config` (the new flag).
**Test:** the precedence tree (service first-run beats bookmark; local welcome beats bookmark); the global-dismiss gate; reset clears all four.
**Windows:** the modal tree + bookmark logic are cross-platform UI; verify the Windows service-install landing still shows the service modal (Windows installs are always a system service).

### 6. Disabled scope-radio contrast
**Evidence:** `modal.css:626` mutes the whole scope-radio label to `opacity: 0.5` when the service is installed (radios disabled), and the radios have no `accent-color`, so the native selected dot becomes invisible against the grey track.
**Fix:** add `accent-color: #5b9aff` to the scope radios (matching the app's checkboxes/range), and lift the disabled label opacity `0.5 → ~0.65`. The bright accent keeps the selected scope legible even when muted.
**Files:** `src/style/modal.css`.
**Test:** manual visual (no logic test).
**Windows:** cosmetic, cross-platform-safe.

### 7. README service-name drift
**Evidence:** README says the unit is `ws-scrcpy-web.service`; the actual name is `WsScrcpyWeb.service` (`WS_SCRCPY_SERVICE_NAME = 'WsScrcpyWeb'`, `src/common/ServiceEvents.ts`). The "don't move/rename the AppImage" warning is also now scope-specific (system scope runs the `/opt` copy, so moving the home AppImage no longer breaks it).
**Fix:** correct the unit name + scope-qualify the warning in `README.md` (Service Mode section, ~lines 271/272/278). Folds in the item-40 README drift.
**Files:** `README.md`.

---

## Out of scope (explicit)
- **Phase 2 (item 39):** Linux service-mode in-app update apply. Gated on this smoke fully passing.
- **Item 35:** the broader Phase-3 UX (service install/uninstall + end-shell confirm-dialog buttons → white-outline). beta.31 reuses the existing white-outline modal-button style for the new global-dismiss confirmation but does not restyle the other buttons.
- **Items 34/36/37:** the SQLite persistence arc. The new bookmark-global flag lives in `config.json` for now.
- **Rust launcher changes:** none. (The system-scope teardown helper's benign adb-reap AVC + the now-unused-for-system-scope Rust teardown path are noted as optional future cleanup.)

## Testing + verification
- **TDD** per fix where there's logic: unit-key placement (#1); install-script + uninstall-argv builders (#2); install-exit scheduling (#3); discovery reconnect branch (#4); modal precedence + global-dismiss + reset (#5).
- **Windows regression fence:** the existing win32 service tests stay green, unchanged. Full suite (vitest + cross + tsc + webpack + clippy) before cutting.
- **Fedora smoke resume (user-gated):** after beta.31 builds green — re-run system-scope uninstall (expect: teardown fires, no AVC, `/opt` + fcontext gone), confirm a single instance after install (no orphans), confirm the same-port reconnect (no false timeout), confirm the service modal on first install + the bookmark global-dismiss flow + the radio contrast.
