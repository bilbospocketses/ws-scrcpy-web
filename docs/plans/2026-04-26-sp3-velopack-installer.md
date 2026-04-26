# SP3 Implementation Plan — Velopack Installer & Auto-Update

> **Companion spec:** `docs/specs/2026-04-26-sp3-velopack-installer.md`
> **Initial release version:** v0.1.0

**Goal:** Ship a code-signed Windows MSI installer for ws-scrcpy-web with auto-update, optional service mode, tray-icon shutdown, and channel-based update flow.

**Architecture:** Rust launcher replaces `start.cmd` for installed users (hidden console + tray + Velopack hooks). Node server runs unchanged underneath. Velopack JS SDK in server for update API. Servy for Windows service mode. Microsoft Trusted Signing for code signing.

**Tech Stack:** Rust (launcher + tray crates, Cargo workspace), TypeScript / Node 24 (server, Velopack JS SDK), Velopack 0.0.x, Servy (pinned), GitHub Actions, MS Trusted Signing.

---

## Phase summary

| Phase | Scope | Effort |
|---|---|---|
| **P1 — Foundation** | Cargo workspace, version-bump script, stage-publish script, basic Rust launcher (hidden console + Node spawn + exit-75 supervisor; no hooks/tray yet) | ~1 session |
| **P2 — Hooks + lifecycle** | Velopack hook arg dispatch in launcher, `config.json` schema + read/write/migrate (Node + Rust), first-run welcome modal, port collision detection | ~1 session |
| **P3 — Service mode** | Servy bundling (`fetch-servy.mjs`), Settings page service install/uninstall buttons, runtime service detection | ~1 session |
| **P4 — Tray icon** | Non-service tray (in launcher), service-mode tray helper crate, exit confirmation modal, login auto-start registration | ~1 session |
| **P5 — Update flow** | Velopack JS SDK integration, update API endpoints, Settings (channel, GH owner), header "Update Available" button | ~1 session |
| **P6 — Packaging + CI** | `vpk pack` GitHub Actions workflow, Trusted Signing wiring, version-sync CI assertion, `extract-changelog.mjs`, `test-update-flow.ps1`, first `v0.1.0-pre.0` build | ~1 session |
| **P7 — Validation + release** | Hyper-V manual checklist run, fix-forward iterations, cut `v0.1.0` stable | ~½–1 session depending on findings |

**Total: ~6–7 focused work sessions.** Matches sizing pre-read estimate of 1.5–2x SP2+SP2b.

---

## P1 — Foundation

**Goal:** Cargo workspace ready; Rust launcher boots, hides console, spawns Node, supervises exit-75. No Velopack integration yet, no tray, no hooks.

### Files

| File | Action | Responsibility |
|---|---|---|
| `Cargo.toml` (root) | Create | Workspace manifest; `members = ["launcher", "tray"]`; shared `workspace.package.version`, deps for `windows`, `tray-icon` |
| `launcher/Cargo.toml` | Create | `[package] name = "ws-scrcpy-web-launcher"`; bin target; `package.version.workspace = true` |
| `launcher/src/main.rs` | Create | Entry — hide console, parse argv, spawn Node, supervise exit-75 / `.restart` marker loop |
| `launcher/src/spawn.rs` | Create | Resolve Node path (DEPS_PATH env → seed/ fallback), spawn child process |
| `launcher/src/supervisor.rs` | Create | Exit-75 + `.restart` loop logic |
| `launcher/build.rs` | Create | Sets Windows subsystem to `windows` (no console) for release builds |
| `tray/Cargo.toml` | Create | `[package] name = "ws-scrcpy-web-tray"`; bin target |
| `tray/src/main.rs` | Create | Stub for now (filled in P4) |
| `scripts/bump-version.mjs` | Create | Updates `package.json` + `Cargo.toml` workspace version + `CHANGELOG.md` `[Unreleased]` → `[<ver>]` |
| `scripts/stage-publish.mjs` | Create | Assembles `publish/` from `target/release/` + `dist/` + `node_modules/` + `seed/` |
| `scripts/assert-version-sync.mjs` | Create | 3-way version check (package.json ↔ Cargo.toml ↔ CLI arg) |
| `package.json` | Modify | Add scripts: `package:stage`, `version:bump`, `version:check` |
| `.gitignore` | Modify | Add `target/`, `publish/`, `Releases/` |
| `CHANGELOG.md` | Modify | Add `[Unreleased]` block if not present |

### Tasks

- [ ] **T1.1: Cargo workspace setup**
  - Create root `Cargo.toml` with workspace + shared `[workspace.package]` (version = "0.0.0", license, repository, etc.)
  - Create `launcher/Cargo.toml` and `tray/Cargo.toml` with `package.version.workspace = true`
  - Verify `cargo build --workspace` runs cleanly (empty mains)

- [ ] **T1.2: Hidden console subsystem**
  - `launcher/build.rs`: set `cargo:rustc-link-arg=/SUBSYSTEM:WINDOWS` and `/ENTRY:mainCRTStartup` for release builds (debug builds keep console for dev)
  - Verify built `ws-scrcpy-web-launcher.exe` opens with no console window

- [ ] **T1.3: Node spawn**
  - `spawn.rs`: resolve Node path via `DEPS_PATH/node/node.exe` → `seed/node/node.exe` → fail
  - `Command::new(node_path).arg("dist/server/main.js").creation_flags(CREATE_NO_WINDOW).spawn()`
  - Use `windows::Win32::System::Threading` for `CREATE_NO_WINDOW` flag

- [ ] **T1.4: Supervisor loop**
  - `supervisor.rs`: wait for child, on exit code 75 OR presence of `.restart` marker → respawn; otherwise exit with child's code
  - Honors `Ctrl+C` to terminate child cleanly (set up signal handler)

- [ ] **T1.5: bump-version.mjs**
  - Argv: `<new-version>` (semver-validated)
  - Updates package.json, Cargo.toml workspace version, CHANGELOG.md (move `[Unreleased]` → `[<ver>] - YYYY-MM-DD`, add fresh `[Unreleased]` placeholder)
  - Vitest tests cover version-string validation and CHANGELOG transformation

- [ ] **T1.6: stage-publish.mjs**
  - Copies `target/release/ws-scrcpy-web-launcher.exe` + `target/release/ws-scrcpy-web-tray.exe` → `publish/`
  - Copies `dist/` → `publish/dist/`
  - Runs `npm ci --omit=dev --prefix publish` (production deps in publish/)
  - Copies `seed/` → `publish/seed/`
  - Copies `start.cmd` (legacy for dev mode) → `publish/`
  - Copies `servy-cli.exe` if `dependencies/servy-cli.exe` exists (P3 hooks this in via fetch-servy)

- [ ] **T1.7: assert-version-sync.mjs**
  - Reads package.json, parses Cargo.toml workspace version, takes tag arg
  - Strips `v` prefix from tag for comparison
  - Exits 0 if all match, 1 with diff message otherwise

### Acceptance criteria

- ✅ `cargo build --release --workspace` succeeds, produces both binaries
- ✅ Running `target/release/ws-scrcpy-web-launcher.exe` from a folder containing `dist/` and resolvable Node spawns the server (we can use existing dev `dist/` for this)
- ✅ Server exits with code 75 → launcher restarts it
- ✅ Server creates `.restart` file → launcher restarts it
- ✅ `npm run version:bump 0.1.0-test` updates all three files in lockstep
- ✅ `npm run version:check 0.1.0-test` passes after bump

---

## P2 — Hooks & lifecycle

**Goal:** Velopack hook dispatch wired in Rust launcher. `config.json` schema implemented in both Rust (read-only for hook decisions) and Node (read/write). First-run welcome modal in web UI. Port collision detection.

### Files

| File | Action | Responsibility |
|---|---|---|
| `launcher/src/hooks.rs` | Create | Detect `--veloapp-install` / `--veloapp-updated` / `--veloapp-uninstall` argv; dispatch to Node entry with same flags OR handle inline |
| `launcher/src/config.rs` | Create | Read-only config.json parser (Rust); used to detect service mode for hook decisions |
| `launcher/Cargo.toml` | Modify | Add `serde`, `serde_json` deps |
| `src/server/Config.ts` | Create | Singleton; reads/writes `<installRoot>/config.json`; schema validation; migration logic |
| `src/server/__tests__/Config.test.ts` | Create | Vitest coverage |
| `src/server/PortPicker.ts` | Create | `findAvailablePort(start, end)`; returns first free port in range or null |
| `src/server/__tests__/PortPicker.test.ts` | Create | Vitest coverage |
| `src/server/main.ts` | Modify | Call `VelopackApp.build().run()` first; load config; port collision detect; pass `firstRunComplete` flag to client |
| `src/server/api/ConfigApi.ts` | Create | `GET /api/config`, `PATCH /api/config` |
| `src/app/client/WelcomeModal.ts` | Create | First-run modal component (uses Modal base class per `project_dialog_migration.md`) |
| `src/app/client/AndroidPowerTools.ts` | Modify | Mount WelcomeModal if `firstRunComplete === false` |

### Tasks

- [ ] **T2.1: Rust config.rs reader**
  - Parse `config.json` from install root with `serde_json`
  - Struct fields per spec; defaults for missing fields
  - Used by launcher to determine service-mode (for `--veloapp-updated` decision: skip restart if not service)

- [ ] **T2.2: Rust hooks.rs**
  - Detect `--veloapp-install`: write skeleton config.json if absent, exit 0
  - Detect `--veloapp-updated`: if `installMode` ends in `-service`, shell out to `current\servy-cli.exe restart WsScrcpyWeb`, exit 0
  - Detect `--veloapp-uninstall`: if service, `servy stop` + `servy uninstall`; preserve user data; exit 0
  - Hooks return BEFORE `VelopackApp.build().run()` is called — Velopack doesn't need that round-trip during hook invocations

- [ ] **T2.3: Node Config singleton**
  - Read on first access, cache in memory
  - `get<K>(key)`, `set<K>(key, value)`, `getAll()`
  - Schema-validate on load (zod or hand-rolled); on validation failure, log + use defaults
  - Sync writes via `fs.writeFileSync` (config changes are infrequent)
  - Migration: if file exists with old schema, transform to new schema, rewrite

- [ ] **T2.4: PortPicker**
  - `findAvailablePort(start = 8000, end = 8099)` → tries `net.createServer().listen(port)`; first success returns port; all-failed returns null
  - Tests cover all-busy, first-busy, all-free cases

- [ ] **T2.5: Server main.ts integration**
  - First line: `VelopackApp.build().run()`
  - Load Config; if `webPort` busy, run findAvailablePort, save back to config, set `portWasAutoShifted = true` flag
  - HTTP server binds to actualPort
  - WS message broadcasts `firstRunComplete`, `portWasAutoShifted`, `webPort` to connected clients

- [ ] **T2.6: ConfigApi**
  - `GET /api/config` returns full config
  - `PATCH /api/config` accepts partial updates; saves; broadcasts change to clients
  - Special handling: `webPort` change → server restart needed (respond with 200 + restart-required flag)
  - Special handling: `channel` or `githubOwner` change → re-init UpdateManager (P5)

- [ ] **T2.7: WelcomeModal component**
  - Extends Modal base (per `project_dialog_migration.md`)
  - Two modes: with/without auto-shift notice (driven by `portWasAutoShifted` flag)
  - "Yes, install service" button → POST to `/api/service/install` (stub for now, real handler in P3)
  - "No, run on demand" button → PATCH `/api/config` `{ installMode: <user|system>, firstRunComplete: true }`
  - Closes on success
  - Mounted in AndroidPowerTools on app load if `firstRunComplete === false`

### Acceptance criteria

- ✅ Launching server when `config.json` is absent triggers `--veloapp-install` simulation OR launcher creates one (decide which path; clean defaults either way)
- ✅ Welcome modal appears on first run, dismisses correctly, never reappears after `firstRunComplete=true`
- ✅ Port 8000 occupied → server starts on 8001, modal shows the auto-shift notice
- ✅ vitest passes for Config + PortPicker
- ✅ Cargo tests pass for hooks.rs argv parsing + config.rs read

---

## P3 — Service mode

**Goal:** Servy bundled. "Install as Service" / "Uninstall Service" buttons functional. Service registration detects install scope correctly.

### Files

| File | Action | Responsibility |
|---|---|---|
| `scripts/fetch-servy.mjs` | Create | Downloads pinned `servy-cli.exe` from Servy GitHub release into `publish/servy-cli.exe` |
| `scripts/stage-publish.mjs` | Modify | Run fetch-servy.mjs as part of staging |
| `src/server/ServyClient.ts` | Create | Wrapper around `servy-cli.exe` invocations; install / uninstall / status / restart |
| `src/server/__tests__/ServyClient.test.ts` | Create | Mocked execFile tests |
| `src/server/InstallScope.ts` | Create | `detectInstallScope()` based on installRoot vs `%LocalAppData%` |
| `src/server/api/ServiceApi.ts` | Create | `POST /api/service/install`, `POST /api/service/uninstall`, `GET /api/service/status` |
| `src/app/client/SettingsModal.ts` | Create | Settings modal scaffold; populate Service section |
| `src/app/client/components/SettingsHeader.ts` | Create | Gear icon in header that opens SettingsModal |

### Tasks

- [ ] **T3.1: fetch-servy.mjs**
  - Hardcode pinned Servy version
  - Downloads from `https://github.com/aelassas/servy/releases/download/v<version>/servy-cli.exe`
  - Verifies SHA256 against pinned hash
  - Places at `publish/servy-cli.exe`
  - Logs version + path

- [ ] **T3.2: ServyClient**
  - `install({ name, displayName, description, binPath, account, startType, maxRestartAttempts, envVars, logPath })` → spawns `servy-cli.exe install --...`
  - `uninstall(name)`, `status(name)`, `restart(name)`, `stop(name)`
  - All sync via execFileSync (operations are quick); throw on non-zero exit; capture stderr
  - Path resolves to `<currentDir>/servy-cli.exe` (the bundled one)

- [ ] **T3.3: InstallScope**
  - Reads `process.execPath` parent dir
  - Returns `'user'` if path begins with `%LocalAppData%` (case-insensitive), else `'system'`
  - Tests with mocked env vars

- [ ] **T3.4: ServiceApi handlers**
  - `POST /api/service/install`: detects scope → builds Servy params → calls ServyClient.install → updates config.installMode → returns 200
  - `POST /api/service/uninstall`: calls ServyClient.stop + uninstall → reverts config.installMode (drop the `-service` suffix) → returns 200
  - `GET /api/service/status`: ServyClient.status → returns running / stopped / not-installed

- [ ] **T3.5: SettingsModal scaffold**
  - Modal with tabs/sections (per spec): Server, Updates (stub), Service, App (stub)
  - Service section populates from `/api/service/status`
  - Install/Uninstall buttons wire to API

- [ ] **T3.6: SettingsHeader**
  - Gear icon in the top-right header next to theme toggle
  - Click opens SettingsModal

- [ ] **T3.7: Welcome modal "Install as Service" wiring (back-fill from P2)**
  - Replaces the P2 stub with real call to `/api/service/install`

### Acceptance criteria

- ✅ Built MSI's `current/` contains `servy-cli.exe` (pinned version, SHA verified)
- ✅ Settings → Install as Service registers the service; visible in `services.msc` under "ws-scrcpy-web"
- ✅ Settings → Uninstall Service removes it cleanly
- ✅ PerUser install registers service under current user account; PerMachine under LocalSystem
- ✅ ServyClient tests pass; InstallScope tests pass

---

## P4 — Tray icon

**Goal:** Single-purpose tray icon in both modes. Confirm-exit modal on click. Service-mode helper auto-starts at login.

### Files

| File | Action | Responsibility |
|---|---|---|
| `tray/Cargo.toml` | Modify | Add `tray-icon` crate, `windows` crate (Win32 APIs) |
| `tray/src/main.rs` | Replace stub | Tray helper for service mode: shows icon, click → confirm dialog → `POST /api/server/shutdown` to localhost:webPort, exits |
| `launcher/src/tray.rs` | Create | Tray for non-service mode, runs in launcher's main thread |
| `launcher/src/main.rs` | Modify | Initialize tray.rs if non-service mode (read config); skip if service mode |
| `launcher/src/config.rs` | Modify | Expose installMode for tray init decision |
| `src/server/ServyClient.ts` | Modify | Add login-Run-key registration: writes `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\WsScrcpyWebTray` on service install; removes on uninstall |
| `assets/tray-icon.ico` | Create | 16x16 / 32x32 ICO file (use existing app icon if present) |

### Tasks

- [ ] **T4.1: Tray icon asset**
  - Use existing `src/style/favicon.ico` or generate from logo SVG
  - Embed in both launcher and tray binaries via `include_bytes!`

- [ ] **T4.2: launcher/src/tray.rs (non-service mode)**
  - Initialize on launcher startup if config.installMode does NOT end in `-service`
  - tray-icon crate + winit event loop on a dedicated thread
  - Click handler: show MessageBox via Win32 (`MessageBoxW` with MB_YESNO + "Exit ws-scrcpy-web?")
  - On Yes: send shutdown signal to launcher's supervisor → terminate child → exit
  - On No: do nothing

- [ ] **T4.3: tray/src/main.rs (service mode helper)**
  - Standalone process; auto-started by Run-key entry at user login
  - Same tray-icon + winit event loop pattern
  - Click handler shows same modal
  - On Yes: HTTP POST to `http://localhost:<webPort>/api/server/shutdown` (read webPort from config.json) — server handles graceful service shutdown internally
  - On No: do nothing

- [ ] **T4.4: Run-key registration**
  - On service install (ServyClient): write `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\WsScrcpyWebTray` = `<installRoot>\current\ws-scrcpy-web-tray.exe`
  - On service uninstall: delete the value
  - Also: spawn the tray helper immediately on install (so user doesn't need to re-login to see it)

- [ ] **T4.5: Confirm modal styling**
  - For non-service mode (launcher process): native Win32 MessageBox is acceptable (not in browser context)
  - For service mode (helper process): also Win32 MessageBox (helper has no browser surface)
  - In-app Stop Server & Exit (browser context) uses styled HTML modal — separate flow per UI section D in spec

### Acceptance criteria

- ✅ Non-service install: tray icon visible; click shows confirm; Yes → server stops + launcher exits
- ✅ Service install: tray helper auto-starts at next login (and immediately on Install as Service); icon visible; click → confirm → service stops via API
- ✅ Service uninstall removes Run-key entry; tray helper exits gracefully on next reboot OR can be killed manually
- ✅ Cargo tests pass for tray click → exit signal logic

---

## P5 — Update flow

**Goal:** Velopack JS SDK integrated. Update API endpoints functional. Settings exposes channel + GH owner. Header "Update Available" button visible when update is ready.

### Files

| File | Action | Responsibility |
|---|---|---|
| `package.json` | Modify | Add `velopack` dependency |
| `src/server/UpdateService.ts` | Create | Wraps Velopack `UpdateManager`; handles channel switching + feed URL construction |
| `src/server/__tests__/UpdateService.test.ts` | Create | Test feed URL building, channel switching |
| `src/server/api/UpdatesApi.ts` | Create | `/api/updates/status`, `/check`, `/apply`, `/config` |
| `src/server/main.ts` | Modify | Background timer for periodic update checks |
| `src/app/client/UpdateButton.ts` | Create | Header "Update Available" button component |
| `src/app/client/SettingsModal.ts` | Modify | Wire Updates section: auto-update toggle, interval, channel, GH owner, manual check button |
| `src/style/header.css` | Modify | Position UpdateButton |

### Tasks

- [ ] **T5.1: UpdateService**
  - Constructor reads config.channel + config.githubOwner; builds feed URL
  - Methods: `checkForUpdates()`, `downloadUpdate(updateInfo)`, `applyUpdateAndRestart()`, `getStatus()`
  - Handles `VELOPACK_FEED_URL` env override
  - Re-init when channel or owner changes

- [ ] **T5.2: UpdatesApi**
  - `GET /api/updates/status` → `{ available, currentVersion, latestVersion, downloaded, autoUpdate, channel, isInstalled }`
  - `POST /api/updates/check` → triggers UpdateService.checkForUpdates, returns updated status
  - `POST /api/updates/apply` → calls UpdateService.applyUpdateAndRestart; server exits 0
  - `PATCH /api/updates/config` → updates autoUpdate / channel / githubOwner / interval; re-inits UpdateService if needed

- [ ] **T5.3: Background timer**
  - Server-side `setInterval(checkForUpdates, intervalMinutes * 60 * 1000)`
  - Also fires once on startup
  - Timer recreated when `updateCheckIntervalMinutes` changes
  - Skip entirely when `isInstalled() === false`

- [ ] **T5.4: UpdateButton**
  - Listens for status updates via WebSocket OR polls `/api/updates/status`
  - States per spec (idle / checking / downloading / ready / error)
  - "Apply update vX.Y.Z" click → `POST /api/updates/apply`

- [ ] **T5.5: SettingsModal Updates section**
  - Auto-apply checkbox (binds to `config.autoUpdate`)
  - Interval input (number, min 5, max 1440)
  - Channel radios (`stable` | `beta`); change → toast "Channel switched. Click 'Check now' to fetch from <channel> feed"
  - GH owner text input (default `bilbospocketses`); change → toast "Feed URL updated"
  - Manual "Check for updates now" button

### Acceptance criteria

- ✅ `UpdateManager.isInstalled()` correctly returns true/false based on context
- ✅ Update check against an empty feed returns "no updates"
- ✅ Update check against a populated feed returns `available: true` with version
- ✅ Apply → server exits with code 0 → if running standalone, Velopack swap succeeds → relaunch
- ✅ Channel switch in Settings → next check pulls from `releases.beta.json`
- ✅ vitest covers UpdateService URL construction + channel switching

---

## P6 — Packaging + CI

**Goal:** GitHub Actions workflow produces signed MSI on tag push. Local update flow test script working. First test build (`v0.1.0-pre.0`) cut and validated.

### Files

| File | Action | Responsibility |
|---|---|---|
| `.github/workflows/release.yml` | Create | Tag-triggered build / sign / release workflow |
| `.github/workflows/ci.yml` | Modify | Add cargo test + clippy + version-sync check on PR |
| `scripts/extract-changelog.mjs` | Create | Pulls section from CHANGELOG for given version |
| `scripts/test-update-flow.ps1` | Create | Local v1→v2 update flow validation |
| `RELEASE_NOTES.md` | Create | Auto-generated per release; checked-in template |
| `signing-metadata.json` | Reference only | Format documentation; actual file injected from secret in CI |
| `docs/RELEASING.md` | Create | Lightweight runbook for cutting releases |
| `package.json` | Modify | Scripts: `package:pack`, `test:update-flow` |

### Tasks

- [ ] **T6.1: extract-changelog.mjs**
  - Argv: `<version>` (e.g., `0.1.0` or `v0.1.0`)
  - Parses `CHANGELOG.md`; extracts the `[<version>]` section through next `[X.Y.Z]` header or EOF
  - Writes to stdout (or specified file via `--out`)

- [ ] **T6.2: test-update-flow.ps1**
  - Builds v0.1.0 → extracts portable zip to sandbox dir
  - Bumps to v0.1.1 → builds → places into local feed dir
  - Sets `VELOPACK_FEED_URL=file:///<feed>` and runs sandbox app
  - User manually triggers Check Now in browser, verifies update applies
  - Final assertion: extracted dir's `current/sq.version` shows v0.1.1

- [ ] **T6.3: GitHub Actions release.yml**
  - Triggers on tag `v*`
  - Steps as in spec § Packaging & CI
  - Uses `secrets.AZURE_TRUSTED_SIGNING_METADATA` for signing
  - Channel detection via tag suffix (`-beta` → beta, else stable)
  - Drops Setup.exe; uploads MSI + portable zip + nupkg + RELEASES + per-channel JSON

- [ ] **T6.4: CI ci.yml updates**
  - Add `cargo test --workspace` + `cargo clippy --workspace -- -D warnings` jobs
  - Add `npm run version:check $(git describe --tags --exact-match 2>/dev/null || echo "0.0.0")` (skip if not on tag)

- [ ] **T6.5: RELEASING.md**
  - Cutting a stable release procedure
  - Cutting a beta release procedure
  - Rollback procedure

- [ ] **T6.6: First test build**
  - Run locally: `npm run version:bump 0.1.0-pre.0` → `npm run package:pack`
  - Verify produced MSI installs on Hyper-V VM
  - Verify smoke (server starts, home page loads on default port)
  - Don't push tag yet — this is a dry run

### Acceptance criteria

- ✅ Local `npm run package:pack` produces signed MSI (or unsigned if no metadata; CI version is signed)
- ✅ MSI installs on Hyper-V; first-run modal appears; service can be installed/uninstalled
- ✅ `npm run test:update-flow` succeeds end-to-end
- ✅ CI workflow file passes a dry run (manual trigger via gh workflow run)

---

## P7 — Validation + release

**Goal:** Run the manual checklist on Hyper-V; fix anything that surfaces; cut `v0.1.0` stable.

### Tasks

- [ ] **T7.1: Provision Hyper-V VM**
  - Clean Windows install
  - Snapshot before testing for fast reset

- [ ] **T7.2: Run manual checklist (12 steps from spec § Testing & validation)**
  - Document any failures inline
  - Snapshot rollback between PerUser and PerMachine tests

- [ ] **T7.3: Fix-forward iterations**
  - Each fix: bump patch version (e.g., `v0.1.0-pre.1`, `-pre.2`, ...)
  - Re-run failed checklist sections
  - Don't promote to `v0.1.0` until all 12 steps pass

- [ ] **T7.4: Cut v0.1.0 stable**
  - `npm run version:bump 0.1.0`
  - Update CHANGELOG (if not already done by bump-version)
  - Commit + push to main
  - Tag `v0.1.0` + push
  - Watch CI workflow complete
  - Verify GH Release shows MSI + portable zip + feed files
  - Run condensed smoke test on Hyper-V against the published MSI (sanity check that signed CI build matches local)

- [ ] **T7.5: Announce**
  - README badge updates (versioned download link)
  - Existing dev-mode users see the new release on their next Check Now
  - Update `MEMORY.md` index to reflect v0.1.0 ship

- [ ] **T7.6: Capture follow-ups**
  - `todo_ws_scrcpy_web.md` updated: SP3 marked shipped; new items captured (notification style migration, single-instance detection, Linux Velopack, automated post-release smoke)

### Acceptance criteria

- ✅ All 12 manual checklist steps pass against the v0.1.0 MSI on Hyper-V
- ✅ GH Release v0.1.0 published with all expected artifacts
- ✅ Auto-update test: install v0.1.0-pre.0 → wait for v0.1.0 detection → apply → version updates correctly

---

## Cross-phase risks

- **Velopack version churn** — pin to specific `velopack` npm version + `vpk` CLI version to avoid surprise breaking changes. Bump deliberately.
- **Trusted Signing onboarding lag** — MS approval can take days. Apply early in P1 if not already done; fall back to unsigned for P6 dry run if cert not yet ready.
- **Servy edge cases** — service registration on locked-down corporate Windows may hit GPO restrictions. Manual checklist catches; document in README.
- **Rust toolchain in CI** — adds ~3 min to CI runs. Cache `~/.cargo` between jobs.
- **Hyper-V VM reset cost** — test cycles take ~2 min per snapshot restore. Plan checklist runs in batches.

---

## Testing strategy summary

| Layer | When | What |
|---|---|---|
| Cargo tests | Every PR | Argv parsing, supervisor logic, config read |
| Vitest | Every PR | Config singleton, PortPicker, ServyClient (mocked), UpdateService URL construction |
| Smoke build | Every PR | `cargo build --release` + `npm run build` (no pack) |
| Local update flow | Manual via `test-update-flow.ps1` | Pre-release validation |
| Manual checklist | Pre-release | 12-step Hyper-V validation gating tag push |

---

## After v0.1.0 ships

Items captured in `todo_ws_scrcpy_web.md` for v0.x cycles:

- Single-instance detection (avoid two listeners on different ports)
- Notification style migration (toasts, native confirms → styled modals)
- Linux Velopack installer (.deb / .rpm / AppImage)
- Automated post-release smoke test in CI (clean Windows runner)
- MSI Group Policy templates (if enterprise demand surfaces)

These do not gate v0.1.0 ship.
