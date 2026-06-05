# Machine-wide `/opt` Install — Phases 2 & 3 design (consolidated)

**Status:** approved (brainstorm) 2026-06-05. **Linux-only.** Refines §3 (relaunch) and §4 (migration) of the umbrella spec `docs/specs/2026-06-05-machine-wide-opt-install-design.md` with the per-phase detail brainstormed after Phase 1 shipped (code-complete on branch `path2-machine-wide-install`). One spec, two phase sections; one plan to follow, likewise sectioned.

**Tech:** Rust launcher (`cross`), TS server (vitest), frontend. `git -C "C:/Users/jscha/source/repos/ws-scrcpy-web"`; no push.

---

## Phase 2 — `loginctl` uninstall→relaunch

**Goal:** After a **system-scope** service uninstall — by anyone — the app reappears for **whoever is at the desk**, on the **exact URL their browser is already on**, with a clear "relaunching…" wait and never a "where did it go?" dead end. Headless → graceful manual fallback.

### Key decision: relaunch is "run **as the user**", not "into the graphical session"

The relaunched instance is a **Node server** the browser reconnects to — it draws no GUI, and auto-open-browser only fires on first-run (`openBrowser.ts`, gated `firstRunComplete === false`), which is not our case. So we do **not** need `DISPLAY`/`XDG_RUNTIME_DIR`. We need it to run **as the active user with `HOME` set**, so it resolves its own dataRoot to `~/.local/share/WsScrcpyWeb` (the user's config + deps — exactly Phase 1's "deps+state follow the run context").

### Discovery (`loginctl`)
The root teardown (already running in its `systemd-run --system` transient unit) finds the active desktop user:
- `loginctl list-sessions --no-legend` → session IDs (first column).
- For each: `loginctl show-session <id> -p Active -p Type -p User -p Display` → pick the first **`Active=yes`** + **`Type=x11|wayland`** (a real graphical seat — the person physically there). Yields **uid** (and we resolve **home** via `getent passwd <uid>`, field 6).
- `loginctl` (+ `getent`) resolved by absolute path (Local-Deps), pure parsers unit-tested.

### Relaunch
```
systemd-run --uid=<uid> --setenv=HOME=<home> --setenv=WS_SCRCPY_WEB_PORT=<servicePort> \
            --collect /opt/ws-scrcpy-web/WsScrcpyWeb.AppImage
```
- `--uid` drops root → the user; `--setenv=HOME` is **mandatory** — without it `data_root_for_linux` *panics* (the beta.40 "never `/tmp`" guard), so a missing HOME is a hard crash, not silent drift.
- `--collect` = an independent transient unit that outlives the teardown helper.
- **No `DISPLAY`/`XDG_RUNTIME_DIR`.**

### Reliable reconnect (the "always works, never lost")
- **Bind the *service's* port.** The teardown reads `webPort` from the `/var/opt` service config and passes it as a one-shot override `WS_SCRCPY_WEB_PORT=<port>`. The relaunched app binds **that exact port** — which is **free** (the service just released it on stop) — so the browser lands on the precise URL it's already on. The app persists the bound port via the existing PortPicker write-back, so it's stable afterward too.
- **Cover the gap with the existing reconnect poll.** Between service-stop and app-bind the browser sees a few seconds of refused connections; the frontend is already polling the same URL (`classifyInstallPoll` — the install hand-off + user-scope uninstall path: *"this page will reconnect shortly"*). It reloads the instant the port answers.
- **Show the wait, system-scope too.** Surface that *"…reconnect shortly"* affordance for the system-scope uninstall (it already exists for user-scope) so the worst case is a brief, explained wait.

### Fallback
No active graphical session (headless / SSH-only) → don't relaunch; log + keep the existing "relaunch manually" guidance (no browser to strand).

### New mechanism: `WS_SCRCPY_WEB_PORT` override
The server's webPort resolution checks `WS_SCRCPY_WEB_PORT` first (force this exact port), else config `webPort`, else default. Set **only** by the Phase 2 relaunch; persisted via the normal write-back.

### Components / testable seams
- Pure (cross-unit-tested): `parse_session_ids`, `session_ctx_from_show` (Active+graphical → `SessionCtx{uid, home?, display?}`), `system_relaunch_command(systemd_run, ctx, appimage, web_port)`.
- Imperative (Fedora-verified): `discover_active_graphical_session()` (runs loginctl/getent), the `run()` System-scope relaunch branch (User scope unchanged).
- TS: `WS_SCRCPY_WEB_PORT` honored in webPort resolution (vitest). Frontend: system-scope reconnect affordance.

### Exit criteria (Fedora, runtime)
System service installed → uninstall **(a) as the same user** and **(b) via pkexec as a different admin** → app reappears in the **active desktop user's** session, browser reconnects **same-port** with a visible wait; **headless** uninstall → no relaunch, manual fallback, no orphan; `ls -Z`/AVC clean.

---

## Phase 3 — updates + migration

**Goal:** machine-wide `/opt` installs update cleanly; existing beta.40 system installs migrate to the new layout without anyone getting silently stranded.

### 3a — Migration of existing beta.40 system installs (**detect + one-click reinstall**)
- **Detect** the old layout: `DATA_ROOT=/opt/ws-scrcpy-web/data` (old unit env) and/or `/opt/ws-scrcpy-web/data` present.
- **Surface a clear in-app notice** (not a silent break): *"the system service must be reinstalled for the new layout"* + a **[reinstall now]** action.
- On confirm, run the **existing uninstall→reinstall** at the new layout, **carrying** `webPort` + `installMode` (+ any other persisted service config). Reuses the install/uninstall paths; no in-place data shuffle.
- Rationale: tiny, user-controlled beta base; "uninstall→reinstall" (umbrella decision 6) with a confirmed, visible trigger.

### 3b — Machine-wide-no-service app update (`pkexec` the swap only)
The user runs `/opt` locally (no service); a Velopack update must write the root-owned `/opt`.
- **`pkexec` *only* the file swap** — reuse Phase 1's machine-wide-install elevated step: `cp` staged AppImage → `/opt/.../WsScrcpyWeb.AppImage`, re-label `bin_t` + `restorecon`, bump `/opt/VERSION`. **One prompt.**
- **Relaunch in the user's context** — the `pkexec` covers *only* the swap; after it, the user-context process re-execs the new `/opt` (as the user, **never root**). Browser reconnects (same port, local config).
- **Unchanged:** run-in-place home installs update with zero elevation (existing `linux_apply`); system-service installs self-update prompt-free (item 39).

### 3c — Bootstrapper version-compare + offer-update
Phase 1's bootstrapper just execs `/opt` if present. Phase 3 makes it version-aware so a manually-downloaded newer AppImage isn't silently ignored:
- The launcher reads `/opt/VERSION` and its own `CARGO_PKG_VERSION`, semver-compares.
- **home ≤ /opt** → exec `/opt` (normal).
- **home > /opt** → run the **home** AppImage in place (the newer one) and flag it for the app, which **offers** *"update the system-wide install to vX? [update]"* → POST → the **3b** `pkexec` swap using the home AppImage as source. Next launch execs the updated `/opt`.
- Reuses 3b's swap; the offer lives in the frontend (the launcher can't draw UI).

### Components / testable seams
- Rust (cross-unit): semver compare helper; the bootstrapper decision extended (`exec /opt` vs `run home + flag`).
- TS (vitest): the machine-wide-no-service update path → pkexec swap builder (reuse `buildMachineWideInstallScript`); the migration-detect + reinstall endpoint; the version-newer status flag + offer endpoint.
- Frontend: the migration notice + [reinstall now]; the "update the system-wide install" offer.
- Imperative/Fedora-verified: the actual pkexec swap + user-context relaunch.

### Exit criteria (Fedora, runtime)
Machine-wide-no-service `/opt` install → in-app update → **one** pkexec → `/opt` swaps + relabels, app relaunches as the user, browser reconnects. Run a newer home AppImage over an older `/opt` → offered the update → accept → `/opt` updated. Upgrade a **beta.40** system install → migration notice → [reinstall now] → service reinstalled at `/var/opt`, config carried, zero AVC.

---

## Cross-cutting
- **Linux-only** (Windows is already PerMachine).
- Phase 2 depends only on Phase 1's `/opt` layout (shipped). Phase 3's update + version-compare depend on Phase 1's `buildMachineWideInstallScript` + `/opt/VERSION` (shipped).
- Build order for the plan: **Phase 2** (relaunch) is independent and smaller → first; **Phase 3** (migration + update + version-compare) second.

## Open risks (carry into the plan)
- `systemd-run --uid` + `--setenv=HOME` actually yielding `~/.local` dataRoot resolution — the load-bearing runtime assumption; verify first on Fedora.
- The `WS_SCRCPY_WEB_PORT` override must force the exact (free) port, not auto-shift away from it.
- Migration carry-over list must be explicit (webPort, installMode, + audit other persisted service-config keys) so nothing load-bearing is lost on reinstall.
- semver compare must handle the project's `X.Y.Z-beta.N` tags correctly (pre-release ordering).
