# Machine-wide `/opt` install for Linux (PerMachine parity) — design

**Status:** approved (brainstorm) 2026-06-05. Design-first; implementation via a follow-on plan. **Linux-only.** Folds the beta.41 uninstall fast-follow (todo item 44 (a) + (b)) into this initiative.

**Supersedes:** the §5 capture-at-install relaunch sketch in `docs/specs/2026-06-02-system-scope-service-paths-fix-design.md`.

## Problem / goal

On Linux the app runs as a bare AppImage from the user's home; only the system-scope service stages a copy to `/opt`. This diverges from Windows, where Velopack installs a machine-wide (PerMachine) binary and — crucially — **"it doesn't matter who uninstalls the system service; the local user picks back up,"** via active-session discovery (`WTSEnumerateSessionsW`) + a per-user tray.

**Goal:** bring that PerMachine parity to Linux — a shared machine-wide binary in `/opt`, and an uninstall→relaunch that puts the app back in front of **whoever is at the desk now** — while keeping SELinux integrity and avoiding forced elevation in the common case.

## Non-goals

- **Windows is untouched** — it is already PerMachine.
- Not changing the per-user data model for local / user-scope runs beyond the binary's location (deps/config/logs stay in `~/.local`).
- Not introducing world-writable trees (the `setfacl` route was evaluated and rejected — see Decisions).

## Locked decisions (2026-06-05 brainstorm)

1. **FHS layout.** Binary → `/opt/ws-scrcpy-web/` (`bin_t`); system-service variable state → `/var/opt/ws-scrcpy-web/` (`var_lib_t`); per-user deps + config + logs → `~/.local/share/ws-scrcpy-web/` (XDG).
2. **Model A — privileged updates, no world-writable trees.** Elevation is the *exception*: a pkexec prompt appears only when a *non-root* context writes `/opt` (the one-time machine-wide install; app-binary updates in machine-wide-but-no-service mode). In system-service mode the already-root service writes directly — **no prompt** (Windows parity; = item 39, shipped beta.38). Dep updates in user-run modes hit `~/.local` and never elevate. **Rejected `setfacl`/world-writable** (the `icacls` analog): SELinux types trump POSIX ACLs on enforcing Fedora; "Authenticated Users" has no Linux twin (only `other`/world or a managed group); all-users-writable + root-service-exec = local privilege escalation — the very thing the `bin_t`/`var_lib_t` labels prevent.
3. **Trigger = auto on first launch.** The home AppImage is a bootstrapper. Decline = run-in-place + remember (per-user; no re-nag). System-scope service install is **gated** on machine-wide install (greyed button + modal).
4. **Deps + state follow the run context, not the binary.** As-user runs (local, user-scope service) → `~/.local` (no elevation). Root system service → its own `/opt` deps + `/var/opt` state (the beta.40 escalation fix forbids root exec'ing a user's home binaries).
5. **Uninstall→relaunch = `loginctl` active-session discovery + `systemd-run --uid`** (Windows parity) — resolved *fresh at uninstall*, not capture-at-install. Manual-guidance fallback when headless.
6. **Migration = uninstall→reinstall on upgrade** for existing system-scope installs (carry `webPort`/`installMode`); local/home users get only the first-run prompt; user-scope stays home.
7. **Folded fix (a):** the teardown `semanage fcontext -d`'s **both** the `/opt` `bin_t` and `/var/opt` `var_lib_t` rules (the beta.40 regression: install added a second rule the teardown never removed).
8. **Single-instance + service-aware launch (per-user) — added 2026-06-05.** The shared `/opt` binary + the system-wide Start-Menu `.desktop` require a **per-user single-instance guard** (`flock` on `$XDG_RUNTIME_DIR/ws-scrcpy-web.lock`; today's `single_instance.rs` Linux path is a no-op stub) so a user can't double-launch their user-mode instance (from `/opt` or home), while different users each get one. And a local launch **defers to an active system service** (opens its URL, no second server) — the "menu no-op in service mode". Launch order: service-active → per-user-instance → `/opt`-exec → run-in-place.

---

## Section 1 — Filesystem layout + SELinux

Three trees, split by **ownership / run-context**:

```
# ALWAYS present once machine-wide-installed (root-owned, static):
/opt/ws-scrcpy-web/
└── WsScrcpyWeb.AppImage           bin_t   ← the shared binary (the Windows-parity relaunch target)
    + /usr/share/applications/ws-scrcpy-web.desktop   (menu entry for all users; Exec=/opt/.../AppImage)

# ADDED only when a SYSTEM-scope service is installed (root-owned):
/opt/ws-scrcpy-web/
├── ws-scrcpy-web-launcher.exe     bin_t   ← staged teardown helper (init_t may exec it)
└── dependencies/                  bin_t   ← the service's OWN node/adb/scrcpy-server
/var/opt/ws-scrcpy-web/            var_lib_t ← the service's variable state
├── config.json
└── logs/

# PER-USER, every interactive run (local mode + user-scope service), user-owned:
~/.local/share/ws-scrcpy-web/       (XDG_DATA_HOME — the existing local dataRoot)
├── config.json
├── dependencies/                          ← node/adb/scrcpy-server  (no-elevation updates)
├── logs/
└── control/                               (markers)
```

**SELinux** (Fedora enforcing; applied by the elevated install/relocate step — mirrors the beta.40 machinery):

- `/opt/ws-scrcpy-web(/.*)?` → **`bin_t`** — persistent `semanage fcontext -a` + `restorecon` (`chcon` fallback on minimal images). Lets `init_t` (the root service) exec the AppImage + deps; ordinary users can exec `bin_t` too, so machine-wide-no-service local runs work.
- `/var/opt/ws-scrcpy-web(/.*)?` → **`var_lib_t`** — the more-specific writable rule for the service's config + logs.
- **Uninstall teardown** `semanage fcontext -d`'s **both** rules (folded fix (a) — now `/opt/...` **and** `/var/opt/...`, replacing the old `/opt/...` + `/opt/.../data`), then `rm -rf` both root trees + `daemon-reload`. **`~/.local` is never touched.**

**Invariant:** `bin_t` is never writable by non-root (SELinux + ownership) — this is what makes "all users run it, only root changes it" safe, and why the `setfacl` world-writable route was rejected.

---

## Section 2 — Install / bootstrap + elevation flows

**The bootstrapper** (home AppImage, every launch, running as the user):

```
/opt binary present?
├─ yes, /opt ver ≥ mine → exec /opt   (hand off + exit. Post-install the normal launch is the
│                                       .desktop menu entry → runs /opt directly, skipping this)
├─ yes, mine is newer   → offer "update the system-wide install" → [pkexec] → exec /opt
└─ no:
     decline-marker set?  (~/.local/share/ws-scrcpy-web/control/system-install-declined)
     ├─ yes → run in place from ~/.local        (NO prompt — the "remember" path)
     └─ no  → prompt "install system-wide for all users?"
                accept  → [pkexec] machine-wide install → exec /opt
                decline → write decline-marker → run in place
```

**Two distinct elevated operations** (each one pkexec from the user's app — or *zero* prompts when the root service drives it):

1. **Machine-wide install** (first-launch accept) — *just the binary*: `cp home.AppImage → /opt/ws-scrcpy-web/WsScrcpyWeb.AppImage` (0755) · `semanage bin_t` + `restorecon` · drop `/usr/share/applications/ws-scrcpy-web.desktop`. **Deps are NOT copied** — local runs use per-user `~/.local` deps.
2. **System-service install** (the gated button, later) — adds the service's bits *on top*: `cp ~/.local/dependencies → /opt/.../dependencies` (bin_t) · seed `/var/opt/.../config.json` + the `var_lib_t` rule · install + `enable --now` the unit. (This is beta.40's `buildSystemInstallScript`, retargeted: binary's already in `/opt` via the gate; state → `/var/opt`, not `/opt/.../data`.)

**Update elevation matrix:**

| Action | Context | Prompt? |
|---|---|---|
| One-time machine-wide **install** (relocate binary → `/opt`) | user's local app (not yet root) | pkexec ×1 |
| **App-binary** update, machine-wide-but-**no-service** | user writing root-owned `/opt` | pkexec (app updates are infrequent) |
| **Any** update in **system-service** mode | the root service does it | **none** ← Windows parity (item 39) |
| **Dep** update in any user-run mode | `~/.local` (user owns it) | **none** |

**Error handling / edges:**

- **pkexec declined, or headless / no-polkit** → can't write `/opt` → fall back to run-in-place from `~/.local` + log; a first-run decline writes the remember-marker (no re-nag).
- **`.desktop` drop is best-effort** — its failure doesn't fail the install (bootstrapper still works).
- **Service-install gating:** the service-scope **system** radio selected while not machine-wide → install-service button **greyed** + a small **modal**: *"system service install requires installing system-wide for all users first."* User-scope service stays available in both modes (home or `/opt` ExecStart).

---

## Section 3 — `loginctl` uninstall→relaunch (Windows parity)

**Scope:** only the system-service path (a declined / in-place user has no service). When the system service is uninstalled — **by anyone, even a different admin** — the app should reappear for whoever's currently at the desk. Windows uses `WTSEnumerateSessionsW` + a per-user tray; Linux has no tray, so the **root teardown does the discovery + spawn itself.**

**Mechanism** (inside the existing root `systemd-run --system` teardown helper):

1. **Discover the active desktop user** via `loginctl` (the `WTSEnumerateSessionsW` analog, resolved by absolute path per Local-Deps):
   - `loginctl list-sessions` → the session with `Active=yes`, `Type=x11|wayland`, `Seat=seat0`.
   - `loginctl show-session <id> -p User -p Display` → `uid`, `DISPLAY`; derive `XDG_RUNTIME_DIR=/run/user/<uid>`.
   - **Core output is *which user* (`uid`)** — "who's at the desk now," not who installed (the parity point).
2. **Relaunch the shared `/opt` binary as that user:**
   ```
   systemd-run --uid=<uid> --setenv=XDG_RUNTIME_DIR=/run/user/<uid> [--setenv=DISPLAY=<d>] \
               --collect /opt/ws-scrcpy-web/WsScrcpyWeb.AppImage
   ```
   `--uid` drops root → the target user; `--collect` = an independent transient unit that outlives the teardown helper (same survival logic as today's user-scope relaunch). Target = the **shared `/opt` binary** (user-agnostic) — *this* is what the machine-wide binary buys us. The relaunched instance runs local mode against that user's own `~/.local` deps.
3. **Reconnect — no new browser code.** The relaunched local server binds the same port (config seeded with the user's port, as today), so the browser already open on the old port hits the existing `classifyInstallPoll`/reload and lands on it. (The app is a server the user views in a browser, so "relaunch" = rebind the port; the open browser reconnects itself.)
4. **Fallback:** no active graphical session (headless / SSH-only) → **don't** relaunch; log + keep the "relaunch manually" guidance. Parity with Windows' `handoff-no-target`.

**Code seams** (the pure/testable parts, mirroring existing builders):

- `relaunch_target(System, …)` stops returning `None` — System now resolves the `/opt` target **when** `loginctl` finds an active graphical session.
- New pure helper `parse_active_graphical_session(loginctl_output) → Option<SessionCtx{uid, display, xdg_runtime_dir}>` — TDD-unit-tested (active / inactive / no-graphical).
- New pure builder `system_relaunch_command(ctx, appimage) → Vec<String>` — TDD-unit-tested (uid / setenv / collect / target shape).
- The `run()` exec seam wires discover→build→spawn (Fedora-smoke-verified — the runtime-survival point, like today's `>>> VERIFY ON FEDORA` marker). **Folded fix (a) rides here:** teardown `-d`'s both the `/opt` `bin_t` and `/var/opt` `var_lib_t` rules.

**Security note:** `systemd-run --uid` is the privilege-*dropping* direction (root → user) — safe; the session context is discovered **fresh at uninstall**, never stale-captured.

---

## Section 4 — Migration

Three existing populations; only one needs real work:

- **Local / home-run users** → *no data migration.* Next launch, the bootstrapper sees no `/opt` → the first-run *"install system-wide?"* prompt (accept = relocate, decline = run-in-place + remember). Their `~/.local` is untouched.
- **User-scope service installs** → *stay home-based.* ExecStart retargets to `/opt` only if/when they later go machine-wide. No forced migration.
- **System-scope service installs (beta.40)** → **uninstall→reinstall on upgrade (Approach B).** On detecting the old `/opt/ws-scrcpy-web/data` layout, run the existing uninstall, then a fresh install at the new layout, carrying over `webPort`/`installMode`. Reuses the install/uninstall paths (simplest code); the beta install base is tiny (test VMs) so disruption is minimal. Risk accepted: any un-carried config customization is lost — so the carry-over list (`webPort`, `installMode`, and any other load-bearing config keys) must be explicit.

---

## Components / build order (for the implementation plan)

1. **Layout + SELinux relabel** — extend the beta.40 builders: a binary-only machine-wide install vs the service-install (deps + `/var/opt` state); add the `/var/opt` `var_lib_t` rule; teardown removes **both** rules (fix a).
2. **Bootstrapper + first-launch install** — the launch decision; relocate-to-`/opt` elevated op; `.desktop` drop; the per-user decline-marker.
3. **Service-install gating UX** — the machine-wide prerequisite check; greyed button + modal.
4. **Privileged update path** — pkexec wrap for the machine-wide-no-service app-binary update; service-mode self-update unchanged (= item 39).
5. **`loginctl` uninstall→relaunch** — discovery parser + `system_relaunch_command` builder + `run()` wiring; folds fix (a).
6. **Migration** — detect old layout → uninstall→reinstall on upgrade, carry config.

## Testing

- **Unit (cross, TDD):** SELinux command builders (the `/var/opt` rule + the both-rules teardown `-d`); the bootstrapper decision logic; `loginctl`-parse (active / inactive / no-graphical); `system_relaunch_command` argv; the migration detect→command-list + the config carry-over.
- **Runtime (Fedora VM, SELinux enforcing):** first-launch install (accept / decline / headless); machine-wide-no-service app update (one pkexec); system-service install (gated) + self-update (no prompt); **uninstall→relaunch by the same user AND by a different admin** → app reappears in the active desktop session, browser reconnects same-port; headless → manual fallback, no orphan; `ls -Z` labels; `semanage fcontext -l | grep ws-scrcpy-web` empty after uninstall (fix a). Migration: upgrade a beta.40 system install → reinstalled at the new layout, config carried.

## Files (anticipated)

- `src/server/service/SystemdClient.ts` — split machine-wide-install (binary-only) vs service-install (deps + `/var/opt` + unit); the `/var/opt` rule; `.desktop` drop.
- `src/server/api/ServiceApi.ts` — bootstrap/relocate trigger; the machine-wide gate for system-service install; migration detect.
- `launcher/src/linux_service.rs` — `relaunch_target(System)` via loginctl; new `parse_active_graphical_session` + `system_relaunch_command`; teardown both-rules `-d` (fix a); `/var/opt` paths.
- `launcher/src/linux_apply.rs` / `src/server/UpdateService.ts` — pkexec wrap for the machine-wide-no-service app update.
- `common/src/config.rs` — `/var/opt` data root for system scope; XDG for user.
- Service/settings UI (`src/app/client/…`) — greyed install-service button + modal when not machine-wide; the first-launch "install system-wide?" prompt modal.
- Tests alongside each.

## Risks / open questions (carry into the plan)

- **Wayland vs X11** session env in `loginctl` discovery — `DISPLAY` may be absent on Wayland; `uid` + `XDG_RUNTIME_DIR` are the load-bearing bits (the app is a server, so the GUI env is mostly for completeness / any browser-open behavior).
- **`.desktop` + menu-cache** refresh across desktop environments (best-effort; may need `update-desktop-database`).
- **pkexec / polkit availability detection** + the headless fallback path (must never hang waiting on a prompt that can't appear).
- **Config carry-over list** for migration (B) must be explicit so nothing load-bearing is lost on reinstall.
- **Machine-wide-no-service app updates**: consider surfacing "install the system service for prompt-free updates" as guidance, since those are the only routine repeat-prompt case.
