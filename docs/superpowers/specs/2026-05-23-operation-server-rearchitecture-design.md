# Operation-server rearchitecture — service uninstall via post-stop.bat + UI takeover

**Status:** Design approved 2026-05-23 via brainstorming session.
**Targets:** v0.1.25-beta.39 through .43 (5-PR ship arc).
**Scope:** Replaces the elevated-launcher chain used by service-uninstall (the chain that dies mid-`servy-cli stop`, diagnosed in §33 of `memory/todo_ws_scrcpy_web.md` beta.38 LATE UPDATE). Generalizes the existing `upgrade-server` machinery (§32 Part 5b/5e/5f) to also serve service-uninstall via the same post-stop.bat + UI takeover pattern. Reuses Servy's LocalSystem token to satisfy admin requirements, eliminating the user-session UAC + elevated-launcher chain entirely. Partially supersedes `2026-04-29-theory-d-uninstall-handoff-design.md` (Theory D handoff stops being used for service-uninstall verb; machinery remains in codebase pending dead-code sweep).

---

## Background

§33 of `memory/todo_ws_scrcpy_web.md` documents the service-uninstall failure on beta.38. Diagnostic logging (added in beta.38 specifically for this triage) proved that the elevated launcher process — spawned in user session 1 with an admin token via `ShellExecuteExW(verb="runas")` — dies mid-`servy-cli stop` after logging `invoking servy-cli stop`, with no subsequent log line. `sc query` post-failure confirms the service IS stopped (so `servy-cli stop` itself succeeded), but `run_capture` never returned to log the result.

Investigation of Servy's `IProcessWrapper.Stop` (at `C:/Users/jscha/source/repos/servy/src/Servy.Service/ProcessManagement/ProcessWrapper.cs`) confirmed that `Stop()` only sends Ctrl+C to the supervised process's console group + `process.Kill()` on the single PID — it does NOT call `StopDescendants` or perform any tree-kill. The mechanism by which the elevated launcher dies remains unproven and is irrelevant to this design — the new architecture routes around it entirely.

**User direction (2026-05-22 LATE):** rather than continue chasing the unknown kill mechanism, reuse the upgrade-server pattern (§32 Parts 5b/5e/5f, already proven across multiple smokes) to take over the UI during service uninstall. Browser sees "Uninstalling service, please wait..." served by the operation-server while Servy + post-stop.bat do the actual uninstall WITHOUT any user-session `ws-scrcpy-web-launcher.exe` processes in an elevated chain. The mystery elevated-launcher death cannot happen if there IS no elevated launcher.

---

## Design

### Core architecture

The existing `upgrade-server` (renamed to `operation-server` per Q6 — see "Naming and rename" below) is extended to serve a second operation: service-uninstall. The post-stop.bat conditional is broadened from a two-state (apply-update / no-op) to a three-state (apply-update / uninstall / no-op) using marker-file discriminators in `<dataRoot>/control/`.

### High-level flow comparison

```
Current (broken) uninstall:                          New (operation-server) uninstall:

[browser] ──POST /api/service/uninstall──>           [browser] ──POST /api/service/uninstall──>
[service-Node (LocalSystem)]                         [service-Node (LocalSystem)]
   ↓ writes uninstall-handoff.json                      ↓ writes uninstall-pending marker
[tray] polls, sees marker                               ↓ returns 200 + redirect to :8000
[tray] spawns local-launcher in session 1               ↓ process.exit(0) (5s delayed)
[browser] redirects to user-session port              [Servy] sees clean exit, fires post-stop.bat
[local-Node] receives uninstall+token                 [post-stop.bat]:
[local-Node] spawns elevated launcher                    1. spawn operation-server (FireAndForget)
   ↓ UAC fires in session 1                                 → binds :8000
[elevated launcher] runs servy-cli stop                     → serves "Uninstalling service..." HTML
   ← DIES HERE (cause unknown)                          2. servy-cli uninstall (LocalSystem; no UAC)
                                                            → Servy.exe deregisters itself from SCM
                                                         3. helper --spawn-user-launcher
                                                            → WTSQueryUserToken + CreateProcessAsUserW
                                                            → fresh launcher in user session 1
                                                         4. exit
                                                      [fresh launcher] boots in user session
                                                         ↓ supervisor writes operation-server-stop marker
                                                         ↓ Node binds (8000 or shifted)
                                                      [operation-server] enters wind-down + probes
                                                         ↓ finds Node on neighbor port, publishes redirect
                                                      [browser] page polling /api/config sees redirect
                                                         → navigates to fresh local-Node
                                                      [user on fresh local-mode UI]
```

### Why this works

- **No elevated launcher in user session.** The process that dies in §33's failure is eliminated from the chain. Root cause becomes irrelevant.
- **LocalSystem suffices for admin.** Servy's `SecurityHelper.EnsureAdministrator()` already passes for LocalSystem. `servy-cli uninstall` runs successfully from `post-stop.bat`'s cmd.exe context (LocalSystem from Servy's parent chain). No UAC prompt fires during uninstall — a UX win over the current flow (current flow shows UAC for both install AND uninstall; new flow shows UAC only for install).
- **Reuses proven pattern.** §32 Parts 5b/5e/5f shipped + smoke-validated the bind-retry + port-probe + wind-down + helper-from-dataRoot pattern for upgrade. operation-server is the same machinery with broader applicability.

---

## Scope decisions (Q1, Q1b, Q8 from §33)

**Q1 — Scope of operation-server reuse:** uninstall only. Install is currently working well and the request-response cycle has no connection gap (local-Node stays alive across the install handoff window). Operation-server's value is filling connection gaps; install doesn't need it.

**Q1b — Install "please wait" page:** visual parity only. A frontend interstitial modal renders "Installing service, please wait..." during the install API call's pending state. local-Node continues to serve the page (no architectural change to install). UX symmetry with the "Updating app" and "Uninstalling service" pages is achieved via consistent copy and visual treatment, not shared HTTP server.

**Q8 — Subsume Theory D handoff for uninstall:** yes, fully. service-Node spawns operation-server directly + exits; no `uninstall-handoff.json` marker, no resume token, no tray-mediated spawn for the uninstall verb. The Theory D code paths become dead for this verb. Cleanup is scheduled as PR #5 (dead-code sweep — see "PR ordering" below).

---

## Naming and rename (Q6)

The existing `upgrade_server.rs` module (and all its identifiers, file paths, CLI flags, on-disk artifacts) is renamed to `operation_server`. This reflects the broader role (background operations with UI takeover) and avoids the misnomer that would accrue if uninstall lived under an "upgrade" naming.

| Dimension | Before | After |
|---|---|---|
| Rust module | `launcher/src/upgrade_server.rs` | `launcher/src/operation_server.rs` |
| Function names | `upgrade_server::handle`, `upgrade_server::spawn_detached_helper`, `upgrade_server::write_stop_marker`, etc. | `operation_server::*` (s/upgrade_server/operation_server/) |
| CLI flag | `--upgrade-server` | `--operation-server` (with `--upgrade-server` as alias for ~2 release cycles for backwards compat with old post-stop.bat files) |
| Helper binary directory | `<dataRoot>/upgrade-server/ws-scrcpy-web-launcher.exe` | `<dataRoot>/operation-server/ws-scrcpy-web-launcher.exe` (dual-write to both for ~2 cycles) |
| Stop marker file | `<dataRoot>/control/upgrade-server-stop` | `<dataRoot>/control/operation-server-stop` (read both during transition) |
| HTML asset | `launcher/assets/upgrade-server-page.html` | `launcher/assets/operation-server-page.html` |
| Wait-page text | "Updating app, please wait..." | Per-operation variant: "Updating app, please wait...", "Uninstalling service, please wait...". Variant selected via query string OR embedded constant — decision deferred to implementation. |

**Backwards compat strategy:** `refresh_helper_binary` (called by supervisor at every startup) writes the launcher copy to BOTH old and new helper-directory paths for ~2 release cycles. The launcher's `--upgrade-server` argv flag continues to dispatch to the renamed `operation_server::handle`. The operation-server's stop-marker reader checks BOTH `operation-server-stop` AND `upgrade-server-stop` filenames. After ~2 cycles (when no live installs reference the old names), the compat code paths are deleted in a follow-up cleanup PR.

---

## Components and responsibilities

### Rust (launcher)

| File | Change | Notes |
|---|---|---|
| `launcher/src/operation_server.rs` | Renamed from `upgrade_server.rs`; existing wind-down + port-probe machinery unchanged | Page-text variant for "Uninstalling..." vs "Updating..."; otherwise same code. |
| `launcher/assets/operation-server-page.html` | Renamed from `upgrade-server-page.html` | Per-operation text variant. |
| `launcher/src/main.rs` | argv dispatch — recognizes both `--operation-server` (new) and `--upgrade-server` (legacy alias) | Both flags route to `operation_server::handle`. |
| `launcher/src/elevated_runner.rs::write_post_stop_bat` | Bat content broadened to three-state conditional | See "post-stop.bat conditional logic" below. New `--spawn-user-launcher` invocation as step 3 of uninstall path. |
| `launcher/src/supervisor.rs::refresh_helper_binary` | Dual-write to both `<dataRoot>/operation-server/` AND `<dataRoot>/upgrade-server/` | Transitional; cleanup PR drops the old. |
| `launcher/src/user_session_spawn.rs` | Existing WTS cross-session spawn — reused | New consumer: `--spawn-user-launcher` subcommand. |
| `launcher/src/main.rs` (new subcommand dispatch) | `--spawn-user-launcher --launcher-path <X>` | Wraps existing `spawn_in_active_user_session` from `user_session_spawn.rs`. |

### Node (TypeScript)

| File | Change | Notes |
|---|---|---|
| `src/server/api/ServiceApi.ts::handleUninstall` | Service+LocalSystem path: write uninstall-pending marker, return 200 + redirectTo, schedule `process.exit(0)` | Replaces the existing `handoffUninstallToUserSession` call for service+LocalSystem context. |
| `src/server/api/ServiceApi.ts::handoffUninstallToUserSession` | Removed (PR #4 activation) | The Theory D dance is no longer needed for uninstall. |
| `src/server/UpdateService.ts::applyUpdate` | No change | Already writes `apply-update-pending` marker, which is the existing discriminator the bat uses. |
| `src/server/Config.ts` | Add `uninstallPendingMarkerPath` getter | Mirrors existing `applyUpdatePendingMarkerPath`. Returns `<dataRoot>/control/uninstall-pending`. |

### Frontend

| File | Change | Notes |
|---|---|---|
| New install/uninstall interstitial component(s) | Render "Installing service, please wait..." and "Uninstalling service, please wait..." modals during pending API state | Pure UI; no new state machine. Existing modal patterns reused. |
| Existing service-install/uninstall click handlers | Wire the new modals — mount on click, dismount on response | Single-file wiring changes. |

### Theory D machinery (deferred cleanup)

In PR #4, `handleUninstall` stops invoking the Theory D handoff path, but the function bodies stay in the codebase as dead code until PR #5 sweeps them. This keeps PR #4's blast radius bounded to "flip the flow" without entangling with the dead-code audit.

| File | Change in PRs #1-#4 | Change in PR #5 |
|---|---|---|
| `src/server/api/ServiceApi.ts::handoffUninstallToUserSession` | Function body stays; `handleUninstall` stops calling it (PR #4) | Function body deleted; unused imports cleaned up |
| `src/server/api/ServiceApi.ts` resume-token consumption (`consumeToken` call inside `handleUninstall`) | Stays callable through the X-Resume-Token header path (in case any in-flight browser sessions still hold a token from pre-PR-#4 installs); harmless when there are no token writers anymore | Deleted if `consumeToken` has no other callers across the codebase; left in place if `issueToken`/`consumeToken` has another consumer |
| `common/src/control_marker.rs` (write/read/delete/poll functions) | Stays in place during PRs #1-#4 | Audited; deleted if tray's `poll_for_handoff` is the only consumer and that's also being deleted |
| Tray `control_marker::poll_for_handoff` (called from tray-supervisor or similar) | Continues polling; will always see `Idle` because no one writes `uninstall-handoff.json` after PR #4 — harmless | Deleted if no other verb uses the marker pattern |

---

## post-stop.bat conditional logic (Q3)

The bat written by `write_post_stop_bat` at install time is broadened from two-state (apply-update / no-op) to three-state (apply-update / uninstall / no-op). All paths use marker-file discriminators in `<dataRoot>/control/`. Apply-update and uninstall are mutually exclusive in normal flows; if both markers exist (would indicate a bug), apply-update fires first and uninstall-pending is preserved for the next cycle.

```bat
@echo off
REM ws-scrcpy-web post-stop handler (operation-server era).
REM Two mutually exclusive operation markers; presence determines path.

if exist "<dataRoot>\control\apply-update-pending" (
    del "<dataRoot>\control\apply-update-pending"
    REM EXISTING upgrade path — unchanged from §32 Part 5e behavior.
    if exist "<helper>" (
        start "" /b "<helper>" --operation-server
    )
    timeout /t 12 /nobreak >nul
    sc start <serviceName>
    exit /b 0
)

if exist "<dataRoot>\control\uninstall-pending" (
    del "<dataRoot>\control\uninstall-pending"
    REM NEW uninstall path.
    if exist "<helper>" (
        start "" /b "<helper>" --operation-server
    )
    REM servy-cli uninstall — synchronous; LocalSystem has admin.
    "<servyPath>" uninstall --name <serviceName>
    REM Spawn fresh user-session launcher via WTS APIs.
    "<helper>" --spawn-user-launcher --launcher-path "<currentLauncherPath>"
    exit /b 0
)

REM Neither marker → user-initiated stop (services.msc, sc stop, etc.). No-op.
exit /b 0
```

**Path interpolations** (baked at install time, identical to existing §32 Part 5e bat):

- `<dataRoot>` → e.g., `C:\ProgramData\WsScrcpyWeb`
- `<helper>` → `<dataRoot>\operation-server\ws-scrcpy-web-launcher.exe` (Velopack-untouchable copy, refreshed every supervisor startup)
- `<servyPath>` → absolute path to `servy-cli.exe` (already passed as `args.servy_path` in `InstallServiceArgs`)
- `<serviceName>` → `WsScrcpyWeb` (per `WS_SCRCPY_SERVICE_NAME`)
- `<currentLauncherPath>` → `<installRoot>\current\ws-scrcpy-web-launcher.exe` (the Velopack-managed live binary; used as the launcher to drop into user session, NOT the dataRoot helper which is for operation-server only)

---

## Marker semantics (Q3 + Q5)

| Marker | Writer | Reader | Purpose | Lifecycle |
|---|---|---|---|---|
| `apply-update-pending` (existing, unchanged) | `UpdateService.applyUpdate` (Node) before `process.exit` | `post-stop.bat` (service mode); launcher supervisor (local mode) | "I just exited because Velopack is applying; please relaunch" | Written → bat (or supervisor) deletes on read → handler proceeds |
| `uninstall-pending` (NEW) | `ServiceApi.handleUninstall` (Node, service+LocalSystem context) before `process.exit` | `post-stop.bat` | "I just exited because user wants to uninstall service; run servy-cli uninstall + spawn user-session launcher" | Written → bat deletes on read → handler proceeds |
| `operation-server-stop` (renamed from `upgrade-server-stop`) | Launcher supervisor at every startup (existing behavior) | Running operation-server | "Old operation-server, please enter wind-down; new launcher is taking the port" | Written every launcher startup; operation-server's serving loop polls for it → wind-down phase |

**Signal for "operation done" (Q5):** the existing `operation-server-stop` marker + port-probe pattern handles operation-completion detection without a new signal. When the fresh user-session launcher boots, its supervisor writes the `operation-server-stop` marker at startup (existing line 142-167 behavior in `supervisor.rs`). The running operation-server sees the marker, enters wind-down, starts its port-probe thread, finds the fresh local-Node on whatever port it bound (8000 or shifted), and publishes the redirect URL via `Arc<Mutex<Option<String>>>` to its connection handlers. Browser's inline JS picks up the redirect on its next `/api/config` poll and navigates.

---

## Cross-session user-session spawn (Q4)

After `servy-cli uninstall` returns, post-stop.bat invokes the launcher binary's new `--spawn-user-launcher` subcommand to spawn a fresh local launcher in the user's active interactive session. The subcommand wraps the existing `user_session_spawn::spawn_in_active_user_session` function (which uses `WTSQueryUserToken` + `CreateProcessAsUserW` against the user resolved via the canonical session resolver — see `common::session` from the §33 beta.36 fix). No new cross-session machinery; just a new argv front door to existing code.

**Subcommand argv shape:**

```
ws-scrcpy-web-launcher.exe --spawn-user-launcher --launcher-path <absolute-path-to-launcher.exe>
```

The launcher-path argument is the Velopack-managed `<installRoot>/current/ws-scrcpy-web-launcher.exe` (NOT the dataRoot helper copy — the dataRoot copy exists for operation-server's image-loading needs; the user-session launcher needs to be the real current-version binary so Velopack's update detection and self-locator work correctly).

---

## Failure modes and recovery

| Failure mode | Symptom | Why it happens | Recovery |
|---|---|---|---|
| operation-server fails to bind :8000 (port held by stranger process) | post-stop.bat continues; user's browser sees ECONNREFUSED briefly until fresh local-Node binds on shifted port | Some unrelated process grabbed 8000 during the window (rare) | Fresh local launcher's Node auto-shifts. Browser refresh hits the new port. Bad UX briefly but uninstall completes. |
| `servy-cli uninstall` fails (non-zero exit) | post-stop.bat continues; spawns fresh user-session launcher anyway; service may still be registered with SCM | Servy bug, file in use, registry weirdness | Fresh local launcher boots in user mode; user lands on local UI; Settings shows residual SCM state. User can retry uninstall from local UI (now follows normal local-mode uninstall path — direct elevated runner without the service-Node-LocalSystem complication). |
| `--spawn-user-launcher` fails (no active interactive session, WTS API error) | post-stop.bat exits; no fresh launcher; operation-server's port-probe finds nothing | User logged out before uninstall click completed, or RDP/Hyper-V session weirdness | After operation-server's 30s max-lifetime, operation-server exits. Browser sits indefinitely on "Uninstalling..." page. User launches manually via Start Menu shortcut. |
| operation-server itself dies mid-flight | Browser → ECONNREFUSED | Bug, OS termination | User refresh after fresh local-Node binds works. Bad UX, recoverable. |
| post-stop.bat hangs (servy-cli uninstall deadlocks) | operation-server alive serving "Uninstalling..."; no fresh launcher spawned | servy-cli bug, SCM deadlock | operation-server times out after 30s; browser sees ECONNREFUSED. User launches manually. |
| Both markers present (apply-update-pending + uninstall-pending — unreachable in normal flow, defensive) | Bat handles apply-update first; uninstall-pending preserved for next cycle | Bug somewhere | Eventual consistency on next clean-exit cycle. |
| Browser closed mid-window | No browser to redirect; operation-server times out + exits; fresh launcher running but UI not open | User chose to close | User opens new tab to localhost:8000; lands on fresh local UI. |

**Key observation:** every failure mode degrades to "user manually launches via Start Menu" — never to "system in broken state requiring repair." The uninstall itself succeeds or fails atomically at the `servy-cli uninstall` step; everything around it is UI polish.

**No failure mode kills the elevated launcher** — because there IS no elevated launcher in the new flow.

---

## Testing strategy

### Rust-side (`cargo test`)

| Test | Location | Coverage |
|---|---|---|
| `operation_server::run` normal serving phase (existing tests renamed + carried over) | `launcher/src/operation_server.rs` | Existing coverage retained; new test for operation-aware page-text variant |
| `write_post_stop_bat` produces three-state conditional | `launcher/src/elevated_runner.rs` | Snapshot the generated bat content; assert all three branches present with correct interpolations |
| Helper-path dual-write (`refresh_helper_binary`) | `launcher/src/operation_server.rs` | Both `<dataRoot>/operation-server/` and `<dataRoot>/upgrade-server/` populated |
| `--operation-server` argv handled; `--upgrade-server` alias still works | `launcher/src/main.rs` | Both flags dispatch to operation_server handler |
| `--spawn-user-launcher` subcommand argv parses correctly | `launcher/src/main.rs` | New subcommand recognized; argv shape validated |
| Marker filename constants | `launcher/src/operation_server.rs` | `STOP_MARKER_FILENAME = "operation-server-stop"`; legacy `upgrade-server-stop` honored at read time |

### Node-side (`npm test` / vitest)

| Test | Location | Coverage |
|---|---|---|
| `handleUninstall` writes uninstall-pending marker in service+LocalSystem context | `src/server/api/__tests__/ServiceApi.test.ts` | Stub LocalSystem detection + isService; assert marker write + 200 response with `redirectTo` |
| `handleUninstall` schedules `process.exit(0)` after 5s | Same file | Stub `process.exit`; assert called once with 0 after 5s timer fires |
| `handleUninstall` skips new flow in local mode | Same file | Stub `isLikelyLocalSystem → false`; assert no marker write, direct uninstall path runs |
| `Config.uninstallPendingMarkerPath` resolves to `<dataRoot>/control/uninstall-pending` | `src/server/__tests__/Config.test.ts` | New getter behaves like existing `applyUpdatePendingMarkerPath` |
| Theory D handoff tests removed (PR #4 / #5) | `src/server/api/__tests__/ServiceApi.test.ts` | Existing `handoffUninstallToUserSession` tests deleted; replaced by new flow tests |

### Frontend tests

| Test | Coverage |
|---|---|
| Install modal mounts during pending state | Click triggers fetch; modal renders while promise pending |
| Install modal dismisses on redirect response | Resolves with `{ok: true, redirectTo: '...'}`; modal dismisses + navigation triggered |
| Uninstall modal — same pattern | Mirror of install modal test |

### Manual smoke (clean Hyper-V VM, end-to-end)

| Step | Expected | Pass criteria |
|---|---|---|
| Fresh Velopack install (new MSI) | Launcher boots; user lands on local-mode UI | Clean ws-scrcpy-web.log; no `--spawn-user-launcher` in launcher.log |
| Settings → Install service (UAC accepts) | Service installs; browser shows "Installing service, please wait..." modal; redirects to service-Node | service.log shows clean install; browser ends on new port; no errors |
| Settings → Uninstall service (the §33 LATE failure case) | Browser shows "Uninstalling service, please wait..."; **no UAC prompt** (LocalSystem path); ~5-9s later browser redirects to fresh local-Node | post-stop.bat ran; servy-cli uninstall succeeded; user-session launcher spawned; operation-server published redirect |
| Reboot + idle 15+ min + uninstall service (the §33 beta.38 idle-aggravation case) | Same as above | The new flow doesn't depend on session resolution at the failure point anyway (Bug B fix from beta.36 retained as defensive layer) |
| Uninstall ×5 in a row | All 5 succeed | The non-determinism from beta.34/.36/.38 was in the Theory D handoff chain which is gone |
| `gh release` includes Windows MSI + portable.zip + Linux AppImage + sigstore attestation | Standard ws-scrcpy-web release gates | Existing CI; no change |
| Vitest baseline maintained or grown | 695/695 → at least 695/695 + new test count | Track exact delta |

**Smoke ordering:** clean VM first for fresh-install path; then upgrade from beta.38 → new beta to validate that existing installs migrate correctly (old `<dataRoot>/upgrade-server/` directory continues to work during the dual-write transitional period; old post-stop.bat keeps referencing `--upgrade-server` which still works via the alias).

---

## Implementation strategy and PR ordering (Q7)

Five PRs, smallest-no-op-by-default first. Each ships as its own beta cut; each independently smoke-able; blast radius bounded; any one easily rolled back.

| PR | Beta | Scope | Behavior change? | Smoke needed? |
|---|---|---|---|---|
| **#1** | beta.39 | Mechanical rename: `upgrade_server.rs` → `operation_server.rs`, all identifiers, `--operation-server` CLI flag (`--upgrade-server` kept as alias), dual-write helper to both `<dataRoot>/operation-server/` and `<dataRoot>/upgrade-server/`, marker filename constant. | None (alias + dual-write means existing installs continue to work). | Light — confirm install + uninstall + upgrade still work via existing flows. |
| **#2** | beta.40 | Launcher-side uninstall capability: extend `write_post_stop_bat` with three-state conditional; add `--spawn-user-launcher` subcommand wrapping `user_session_spawn.rs`; add page-text variant for "Uninstalling service..." in operation-server. **Dormant — no marker writer yet; bat's new uninstall branch never fires.** | None visible. | Cargo tests + verify generated bat content via snapshot test. No live smoke needed (path is dead code in production until PR #4). |
| **#3** | beta.41 | Frontend interstitial modals: "Installing service, please wait..." + "Uninstalling service, please wait..." mounted on click, dismissed on response. | Visible UI change but works on the CURRENT uninstall flow too — modal renders during whatever the API does. | Frontend test + manual VM check that modals appear + dismiss correctly on existing flows. |
| **#4** | beta.42 | Node activation: `Config.uninstallPendingMarkerPath` getter, `handleUninstall` writes the marker + returns redirect + schedules exit, stop calling `handoffUninstallToUserSession` from `handleUninstall` (function body left in place — deletion in PR #5). **This is the user-visible flip — operation-server pattern now active for uninstall.** | User-visible: uninstall now uses operation-server pattern. No more UAC for uninstall. | **Full clean-VM smoke** — the entire §33 LATE UPDATE failure mode is validated here. 5×pre-reboot + 1×post-reboot + 1×post-idle uninstalls. |
| **#5** | beta.43 | Dead-code sweep: delete `handoffUninstallToUserSession` function body + its imports + its resume-token consumption (if `consumeToken` has no other callers). Audit `common/src/control_marker.rs` consumers; delete tray `poll_for_handoff` if nothing else uses it. After ~2 cycles (separate later PR, not in this arc), drop the `--upgrade-server` alias + drop the dataRoot `upgrade-server/` dual-write. | None. | Cargo + vitest unchanged. |

**Each PR squash-merged per CLAUDE.md PR Merge Method rule** (signed via web-flow on the squash commit). Each beta cut is a separate version-bump PR.

---

## Open questions deferred to implementation

These don't block design approval; resolved during the relevant PR's code review.

- **Wait-page text variant selection mechanism:** query string (`?op=uninstall`) vs embedded constant baked at compile/spawn time vs HTTP header. All three viable. Decision punted to PR #2 (where the page variant is added).
- **Whether `--upgrade-server` alias gets a deprecation warning in the launcher.log:** UX/log-noise call. Decision punted to PR #1 (where the alias is added).
- **Exact frontend modal copy + visual treatment for the install/uninstall interstitials:** mirroring upgrade modal's existing copy is the default; finalized in PR #3.

---

## Companion follow-up — `reference_user_service_install_routine.md`

Per §33 deferred memory (broadened 2026-05-22 LATE), after the 5 PRs land + post-merge smoke confirms seamless install/uninstall, write `reference_user_service_install_routine.md` documenting the operation-server pattern as the canonical architecture for ALL future apps offering user/system + service install. ws-scrcpy-web is the canonical implementation; future apps (Control Menu post-service-mode, OAO post-Velopack, tiny11options if service-bound) will consume this pattern. Scope includes: session resolution, handoff markers, Servy `--postStopPath`, elevated runner pattern (for install only post-rearchitecture), state machine, Welcome modal copy / tray text mode-awareness / Settings UX affordances.

---

## References

- `memory/todo_ws_scrcpy_web.md` §33 — diagnostic history, beta.36/.37/.38 ship + LATE UPDATE proving the operation-server rearchitecture necessity
- `docs/superpowers/specs/2026-04-29-theory-d-uninstall-handoff-design.md` — original Theory D handoff design (partially superseded by this spec)
- `docs/superpowers/specs/2026-04-30-service-mode-admin-uac-ux-design.md` — service-mode UAC UX background
- `docs/superpowers/specs/2026-04-30-tray-autostart-machine-wide-design.md` — tray-related context referenced by §32 + §33 work
- `launcher/src/operation_server.rs` (post-rename) — implementation home
- `launcher/src/elevated_runner.rs::write_post_stop_bat` — bat-generation home
- `src/server/api/ServiceApi.ts` — Node-side service install/uninstall API
- `common/src/control_marker.rs` — Theory D machinery (dead-code candidate after PR #5)
- Servy `IProcessWrapper.Stop` at `C:/Users/jscha/source/repos/servy/src/Servy.Service/ProcessManagement/ProcessWrapper.cs` — confirmed `Stop()` does NOT tree-kill (rules out Servy as the elevated-launcher killer; mechanism remains unknown but irrelevant under the new design)
