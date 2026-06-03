# Linux system-scope service: correct paths + install handoff — design

**Status:** approved 2026-06-02. Found during the v0.1.30-beta.39 Fedora smoke (Smoke 6). Pre-existing (system-scope install never ran end-to-end before); not a beta.39 regression.

## Problem

Installing the **system-scope** systemd service on Linux produces a service that *runs* but is mis-pathed:

- Its `config.json` / state lands in **`/tmp/WsScrcpyWeb`** — ephemeral (tmpfs, wiped on reboot), so the service forgets its config every boot.
- It runs `node`/`adb` from the **installing user's home** (`/home/<u>/.local/share/WsScrcpyWeb/dependencies`) — fragile + a root-executing-user-writable-binary surface, and a violation of Local-Dependencies-Only (deps must live in the app's own folder).
- The browser shows the **local WelcomeModal** in system mode (the install writes `installMode` to the *user's* config, but the service reads `/tmp`).
- After install the **browser doesn't hand off** — it stays on the user's old port while the service binds a different one, so the app looks dead.

## Root cause (code-confirmed)

Two env vars the install gets wrong, plus one skipped step:

1. `ServiceApi.ts:304-306` builds the unit env as `{ DEPS_PATH: cfg.dependenciesPath }` **unconditionally** — `cfg.dependenciesPath` is the installing user's deps. → deps-from-home.
2. That env block sets **no `DATA_ROOT`**. The root systemd service has no `HOME`, so `common/src/config.rs:48` `data_root_for_linux` hits its last-resort arm `None => /tmp/WsScrcpyWeb`; the launcher bridges that to node. → config-in-`/tmp`.
3. The system service's config is **never seeded**, so `installMode`/`firstRunComplete`/`webPort` are defaults → WelcomeModal + a port mismatch that breaks `classifyInstallPoll` (`SettingsModal.ts:42`), whose `navigate`/`reconnect` signals both assume one shared config + the same port.

## Design

Layout decision: **everything under `/opt/ws-scrcpy-web`** (single self-contained tree), SELinux-correct via a *targeted* fcontext.

### This pass (the bigger part)

1. **Layout + SELinux.** AppImage + deps → `/opt/ws-scrcpy-web/{WsScrcpyWeb.AppImage, dependencies/}` (`bin_t`, exec). State → `/opt/ws-scrcpy-web/data/{config.json, logs/}` with a **more-specific** fcontext rule `/opt/ws-scrcpy-web/data(/.*)? -> var_lib_t` (beats the general `…(/.*)? -> bin_t`, so the data dir is writable). `restorecon -R /opt/ws-scrcpy-web` applies both after staging.
2. **Deps copied to `/opt` at install** (Local-Dependencies-Only compliant). Extend the existing `/opt` AppImage staging to also copy the user's `dependencies/` → `/opt/ws-scrcpy-web/dependencies`, then `restorecon` (`bin_t`). Deterministic; labeled before the service starts. Edge: if the user's deps are incomplete, the service's dep-manager backfills on first run.
3. **Scope-aware unit env + config seed** (the core). For **system** scope: `envVars = { DATA_ROOT: '/opt/ws-scrcpy-web/data', DEPS_PATH: '/opt/ws-scrcpy-web/dependencies' }` (user scope unchanged). Seed `/opt/ws-scrcpy-web/data/config.json` at install with `{ installMode:'system-service', firstRunComplete:true, webPort:<the user's current port> }`. → persistent config, no `/tmp`, no WelcomeModal, survives reboot.
4. **Install handoff falls out of #3.** Seeding `webPort` = the user's current port → the service binds the **same** port the user is on; when the local instance exits, the existing `reconnect` path (`classifyInstallPoll` → reload current URL) just works. No new discovery code.
6. **Defense.** Change `config.rs:48` `None => /tmp/WsScrcpyWeb` to fail loudly (return an error / explicit non-ephemeral default) so no future no-`DATA_ROOT` context silently lands in `/tmp` again.
7. **Bookmark clobber (bug #35).** Remove the eager constructor `bookmarkDismissedForPort` PATCH from `WelcomeModal.ts:44-48` + `ServiceFirstRunModal.ts:44-48` — redundant with `index.ts` modal gating + the completion-path stamp; it was clobbering "reset welcome and bookmark prompts".

### Fast follow (separate, after the above lands)

5. **Uninstall handoff.** Make the root teardown best-effort relaunch the user's local AppImage **into the originating user's graphical session** (recorded `local-appimage` marker + the user's `DISPLAY`/`XDG_RUNTIME_DIR`), then reuse the user-scope uninstall poll to navigate. Graceful fallback to today's "relaunch manually" guidance when headless / no session. Deferred because of the root→user-session OS edge cases.

## Files (anticipated)

- `src/server/api/ServiceApi.ts` — scope-aware `envVars`; seed system `config.json`; trigger deps copy + restorecon for system scope.
- `src/server/service/SystemdClient.ts` — the `/opt/ws-scrcpy-web/data -> var_lib_t` fcontext rule alongside the existing `bin_t` rule; staging of deps.
- `common/src/config.rs` — `data_root_for_linux` `/tmp` last-resort hardening.
- `src/app/client/WelcomeModal.ts`, `src/app/client/ServiceFirstRunModal.ts` — drop the eager bookmark stamp.
- Tests alongside each.

## Testing

- **Unit (TDD, failing-test-first):** scope-aware `envVars` (system → `/opt` paths; user unchanged); system `config.json` seed shape (incl. `webPort` = caller's port); the fcontext/`restorecon` command builders (data dir → `var_lib_t`); `data_root_for_linux` no-HOME behavior (no silent `/tmp`); the bookmark fix (reset clears `bookmarkDismissedForPort`, survives the reload).
- **Runtime verification:** re-run **Smoke 6 + Smoke 7** on Fedora (SELinux enforcing) — the authoritative proof: `/opt/ws-scrcpy-web/data` config persists across reboot, deps run from `/opt`, no WelcomeModal, install hand-off lands on the same port, zero AVC.

## Non-goals

- The uninstall handoff (#5) — fast follow.
- Changing user-scope or Windows behavior — the fix is system-scope-Linux-branched.
