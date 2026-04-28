# Route A — Program Files migration with ProgramData data root

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move ws-scrcpy-web's Windows install layout from per-user (`%LocalAppData%\WsScrcpyWeb\`) to per-machine, with binaries under `C:\Program Files\WsScrcpyWeb\` and writable runtime state under `C:\ProgramData\WsScrcpyWeb\`. Fix Velopack auto-locate in service mode (the root cause of the v0.1.20 dev-mode UI in service mode), enable seamless local↔service state sharing, and expand the tray menu beyond exit-only.

**Locked-in decisions** (carry these into every task — no silent deviation):

1. **Route A (PerMachine MSI)** — install root is `C:\Program Files\WsScrcpyWeb\`. Setup.exe stays an artifact through v0.1.21; both `--msi --instLocation PerMachine` AND default Setup.exe ship in v0.1.21 so we have a fallback. Drop Setup.exe in v0.1.22 once MSI is validated end-to-end.
2. **Writable state in ProgramData** — `C:\ProgramData\WsScrcpyWeb\` for `config.json`, `dependencies\`, and all logs. ACL grant `Authenticated Users: Modify (OI)(CI)` applied at MSI install time via WiX. Single source of truth shared by all users + service-Node.
3. **Existing v0.1.x users uninstall + reinstall.** No auto-migration shim in v0.1.21; release notes only. Revisit migration UX in v0.1.22 if user-count justifies.

**Tech Stack:** Rust launcher (workspace + tray + common crates), TypeScript (strict) + Vitest server, vpk packaging, WiX 5 (via Velopack `--msi`), GitHub Actions release pipeline, SignPath signing.

---

## Architecture overview

Today there is one root: `<install-root>` resolved by `__dirname`-walk in TS and `current_exe()`-walk in Rust. Velopack-owned files (`Update.exe`, `current/`, `packages/`, `velopack.log`) and our-owned files (`config.json`, `dependencies/*`) all live under it.

After migration there are two roots:

- **`installRoot`** = `C:\Program Files\WsScrcpyWeb\` — Velopack-managed; admin-only writable; the launcher binary, the seed Node, the bundled webpack output, and Velopack's own files live here.
- **`dataRoot`** = `C:\ProgramData\WsScrcpyWeb\` — Our-app-owned; user-writable (via MSI-applied ACL); `config.json`, downloaded dep binaries, and logs live here.

`installRoot` is derived as today (`current_exe` walk in Rust, `__dirname` walk in TS). `dataRoot` is computed as a sibling-style absolute path: `path.join(process.env.PROGRAMDATA ?? 'C:\\ProgramData', 'WsScrcpyWeb')` in TS, `dirs::data_dir()` or env-driven in Rust. Tests inject explicit overrides like today.

The shape carries both modes:

```text
C:\Program Files\WsScrcpyWeb\        <-- installRoot (admin-write only)
├── current\
│   ├── ws-scrcpy-web-launcher.exe
│   ├── ws-scrcpy-web-tray.exe
│   ├── seed\node\node.exe
│   └── dist\index.js + js bundle
├── Update.exe
├── velopack.log
└── packages\

C:\ProgramData\WsScrcpyWeb\          <-- dataRoot (Authenticated Users:Modify (OI)(CI))
├── config.json
└── dependencies\
    ├── node\node.exe                <-- DependencyManager downloads
    ├── adb\adb.exe
    ├── scrcpy-server\scrcpy-server
    ├── node-pty\v<X>\<plat>\
    ├── server.log
    ├── service.log
    └── .restart                     <-- restart marker; supervisor watches it
```

**`DEPS_PATH` env var is the wire that connects them.** Node child processes spawned by the launcher get `DEPS_PATH=C:\ProgramData\WsScrcpyWeb\dependencies` set on their env (currently they get `<install-root>\dependencies` — same idea, different value). All TS code that today calls `Config.dependenciesPath` continues to work; only the resolved value changes.

---

## File map

**New:**

- `wix/wsscrcpyweb.wxs.fragment` — WiX 5 fragment file invoked via `vpk pack --msi-fragment` (or whatever vpk's mechanism turns out to be) that creates `<ProgramData>\WsScrcpyWeb\` with `Authenticated Users:Modify (OI)(CI)` at install time. (If vpk has no fragment-injection point, fall back to Phase-2 first-run bootstrap that auto-creates + ACLs the dir from the launcher running for the first time.)
- `launcher/src/data_paths.rs` — pure resolution module. Computes `data_root` from env (`PROGRAMDATA`) and emits the resolved `dependencies_path`, `config_file_path`, `restart_marker`, `old_node` paths. Mirrors the existing `paths.rs` shape but for the data root.
- `src/server/__tests__/Config.dataRoot.test.ts` — covers the new dataRoot resolution + injection.
- `src/server/__tests__/dependencyManager.dataRoot.test.ts` — covers DEPS_PATH propagation reading from the new path.
- `launcher/src/data_paths.rs` (Rust tests inline `#[cfg(test)] mod tests`).
- `launcher/src/tray_menu.rs` — new context-menu wiring around `common::tray::run`; abstracts the menu items so launcher-tray and helper-tray share code.
- `docs/PROGRAMDATA-MIGRATION.md` — user-facing release-notes-style doc covering uninstall-then-reinstall path for existing v0.1.x users.

**Modified:**

- `.github/workflows/release.yml` — vpk pack invocation gains `--msi --instLocation PerMachine`; new MSI signing + upload steps.
- `Cargo.toml` (workspace) + `package.json` — version → 0.1.21.
- `CHANGELOG.md` — large `[0.1.21]` entry covering install-layout change + tray + UpdateService.
- `src/server/Config.ts` — split `installRoot` / `dataRoot`; `dependenciesPath` and `configFilePath` resolve from `dataRoot`.
- `src/server/DependencyManager.ts` — only changes if it references install root anywhere (the `__dirname` walk in `seed/scrcpy-server` lookup stays anchored to install root).
- `src/server/UpdateService.ts` — pass `VelopackLocatorConfig` to `new UpdateManager(...)` explicitly, computed from the install root. Belt-and-braces — Program Files install should auto-locate fine, but explicit removes the failure mode if something env-related changes.
- `src/server/api/ServiceApi.ts` — keep the v0.1.20 env-var propagation through v0.1.21 (belt-and-braces). Plan to delete in v0.1.22.
- `launcher/src/paths.rs` — keep the `installRoot` derivation; add a sibling helper `Paths::data_root()` returning the ProgramData-based path.
- `launcher/src/spawn.rs` — pass `DEPS_PATH` from `data_paths::dependencies_path()` instead of `paths::dependencies_path()`.
- `launcher/src/supervisor.rs` — read `.restart` marker from `data_paths`.
- `launcher/src/log.rs` — write launcher.log under `dataRoot` instead of `installRoot`.
- `launcher/src/tray.rs` — add menu wiring; "Open in browser" reads `data_paths/config.json` for current `webPort`.
- `tray/src/main.rs` — same menu wiring for the service-mode tray helper.
- `common/src/config.rs` — if `AppConfig::load` reads from `installRoot` today, change to read from `dataRoot`. (Both crates share this module via the workspace.)
- `common/src/tray.rs` — extend the tray-run API to accept a list of menu items + their callbacks. `TrayAction` enum gains variants beyond `ConfirmedExit` / `Cancelled`.
- `scripts/stage-publish.mjs` — confirm the script that assembles `publish/` for vpk doesn't assume install-root-is-data-root anywhere.

**Unchanged:**

- AppImage / Linux pipeline — Linux is unaffected.
- All scrcpy / device tracking / WebSocket code — none of it touches install layout.
- The first-run modals (`WelcomeModal`, `ServiceFirstRunModal`, `PortChangeModal`) — they read `Config` via API; the path change is invisible to them.
- `assets/tray-icon.ico` — same icon.

---

## Phase 1: Two-root path resolution (foundation; no install-layout change yet)

**Why first:** Before the MSI changes, we need code that *can* read writable state from a separate location. Doing this before the packaging change lets us validate path resolution against the existing per-user install (treating `<install-root>\dependencies\` and `<install-root>\config.json` as the dataRoot in the no-migration case) and ship a working v0.1.21-rc that doesn't yet move anything. Then Phase 5 flips the actual install layout.

### Task 1.1: TS-side dataRoot resolution

**Files:** `src/server/Config.ts`, `src/server/__tests__/Config.dataRoot.test.ts`

- [ ] Add a `dataRoot` parameter to `Config` (plumbed via the existing test-injection escape hatch). Default behavior: compute as `path.join(process.env.PROGRAMDATA ?? 'C:\\ProgramData', 'WsScrcpyWeb')` on Windows; on Linux, leave at `path.dirname(process.execPath)`'s grandparent same as installRoot for now (no migration there).
- [ ] Resolve `configFilePath` and `dependenciesPath` from `dataRoot` instead of `installRoot`.
- [ ] Resolve `seed` lookups (e.g., `DependencyManager.promoteSeedScrcpyServer` reads `<install-root>/seed/scrcpy-server`) from `installRoot`. Keep the two cleanly separated.
- [ ] Tests: dataRoot defaults to `<PROGRAMDATA>\WsScrcpyWeb` on win32 with PROGRAMDATA set; falls back to `C:\ProgramData\WsScrcpyWeb` if PROGRAMDATA missing; injection override works.

### Task 1.2: Rust-side dataRoot resolution

**Files:** `launcher/src/data_paths.rs` (new), `launcher/src/paths.rs`, `common/src/config.rs`, `launcher/src/spawn.rs`, `launcher/src/supervisor.rs`, `launcher/src/log.rs`

- [ ] Create `data_paths.rs` modeled on `paths.rs`. Pure resolution: takes optional `PROGRAMDATA` env (and an optional explicit override for tests) and returns `data_root`, `dependencies_path`, `config_file_path`, `restart_marker`, `old_node`. Inline unit tests.
- [ ] Update `spawn::spawn_server` to pass `DEPS_PATH = data_paths::dependencies_path()` to the Node child.
- [ ] Update `supervisor::run` to read the restart marker from `data_paths::restart_marker`.
- [ ] Update `log::*` writes to land in `<data_root>\ws-scrcpy-web-launcher.log` (or wherever they go today, just under dataRoot).
- [ ] Update `common::config::AppConfig::load` to read from `<data_root>\config.json`.

### Task 1.3: Verify split works on existing v0.1.20 install

- [ ] Build a v0.1.21-rc from this branch with the path split active but **no MSI / install-layout change yet**.
- [ ] On a clean Windows VM with v0.1.20 already installed: install v0.1.21-rc as an upgrade. Confirm:
   - `config.json` migrates from `<install-root>\config.json` to `<dataRoot>\config.json` (or simply gets recreated — v0.1.21-rc reads dataRoot, v0.1.20 left config in install-root).
   - `dependencies\node\` etc. move similarly.
- [ ] Either we accept this split-but-existing-install case as "config gets reset" or we add a one-shot first-run shim in v0.1.21-rc that copies `<install-root>\config.json` → `<dataRoot>\config.json` if the latter doesn't exist. Recommend the shim.

---

## Phase 2: VelopackLocator runtime override

**Why before MSI swap:** This makes UpdateService robust regardless of where the install lands. Once we confirm it works for both `%LocalAppData%` (v0.1.20-style) and `Program Files` (v0.1.21-style) installs, we can drop the v0.1.20 env-var propagation in v0.1.22.

### Task 2.1: Build VelopackLocatorConfig from known paths

**Files:** `src/server/UpdateService.ts`, `src/server/__tests__/UpdateService.test.ts`

- [ ] Compute the config from `installRoot`:
   ```ts
   const locator: VelopackLocatorConfig = {
       RootAppDir: this.installRoot,
       UpdateExePath: path.join(this.installRoot, 'Update.exe'),
       PackagesDir: path.join(this.installRoot, 'packages'),
       ManifestPath: path.join(this.installRoot, 'current', 'sq.version'), // verify name on a real install
       CurrentBinaryDir: path.join(this.installRoot, 'current'),
       IsPortable: false,
   };
   ```
- [ ] Pass as 3rd arg to `new UpdateManager(feedUrl, options, locator)`.
- [ ] Verify `ManifestPath` filename — Velopack docs reference `sq.version` historically; v0.1.17 fix moved the marker check to `Update.exe`. Confirm the actual manifest path used by VelopackLocatorConfig matches what Velopack emits at the path. May need to read a packaged install to find out.
- [ ] Tests: factory receives the locator argument; locator paths match expected for an `installRoot` of `C:\Program Files\WsScrcpyWeb\`.

### Task 2.2: Validate against v0.1.20 install (LocalAppData)

- [ ] Drop the WIP v0.1.21-rc onto a v0.1.20 install. Service-mode startup must show `[UpdateService] initialized for vX.Y.Z on stable channel` from the **service-Node** side (not the v0.1.20 warning).
- [ ] If still failing in service mode with locator override: keep the env-var propagation as the workaround, document the failure, and leave option to investigate after Phase 5.

---

## Phase 3: Tray menu expansion

**Why now:** ProgramData shared-config makes a port-aware tray menu trivial — both trays read the same `config.json` and always know the right port. Once the path split lands, this is mostly a UI change.

### Task 3.1: Common tray menu API

**Files:** `common/src/tray.rs`

- [ ] Replace the single-dialog API with a context-menu API. Sketch:
   ```rust
   pub enum TrayMenuItem {
       Action { label: String, on_click: Box<dyn Fn() + Send + Sync> },
       Status { label: String },                 // disabled-text item
       Separator,
   }
   pub enum TrayAction {
       MenuItemClicked(usize),                   // index into the items list
       ConfirmedExit,
       Cancelled,
   }
   pub fn run(icon: &[u8], items: Vec<TrayMenuItem>, exit_dialog: ExitDialogConfig) -> Result<TrayAction>;
   ```
- [ ] Backward-compat: keep a `run_simple(icon, title, exit_msg, exit_detail)` shim that wraps `run` with a single "Exit" item, used by anything not yet migrated.

### Task 3.2: Launcher-tray menu (local mode)

**Files:** `launcher/src/tray.rs`, `launcher/src/tray_menu.rs` (new)

- [ ] Build menu items:
   - **"Open ws-scrcpy-web"** — reads `<dataRoot>\config.json`, opens `http://localhost:<webPort>` via `Command::new("rundll32").args(["url.dll,FileProtocolHandler", url])`.
   - **"Restart server"** — writes `.restart` marker (touches the file the supervisor already watches).
   - **`Status: running on port <X>`** — text-only; updates on tick? Or computed once at tray spawn.
   - **Separator**
   - **"Exit"** — existing dialog confirm path.
- [ ] Tray click (left-click on icon, not menu) defaults to "Open ws-scrcpy-web" — most common action.

### Task 3.3: Service-mode tray helper menu

**Files:** `tray/src/main.rs`

- [ ] Same menu structure as launcher-tray.
- [ ] **"Restart server"** in service mode triggers an HTTP POST to the existing `/api/server/shutdown` endpoint (the supervisor sees Node die and respawns). Or use `.restart` marker if we wire the service supervisor to honor it.
- [ ] **"Exit"** continues to do the existing shutdown POST.

### Task 3.4: Tray icon update indicator (deferred to v0.1.22+)

- [ ] Skip in v0.1.21. Note: when an update is available, ideally the tray icon shows a badge or the menu has "Update available — install now" item. Punt to a later release. Track in TODO.

---

## Phase 4: MSI packaging + ACL setup

**Why this phase, this order:** All the code changes above land first. This phase flips the install-time behavior. Build first → land code → flip artifact → test → release.

### Task 4.1: Add `--msi --instLocation PerMachine` to vpk pack

**Files:** `.github/workflows/release.yml`

- [ ] Update vpk pack step:
   ```yaml
   - name: vpk pack (Setup.exe + MSI)
     shell: pwsh
     run: |
       vpk pack `
         --packId WsScrcpyWeb `
         --packVersion ${{ needs.prepare.outputs.version }} `
         --packDir publish `
         --mainExe ws-scrcpy-web-launcher.exe `
         --packTitle "ws-scrcpy-web" `
         --packAuthors "ws-scrcpy-web contributors" `
         --channel ${{ needs.prepare.outputs.channel }} `
         --icon assets/tray-icon.ico `
         --msi `
         --instLocation PerMachine `
         -o Releases
   ```
- [ ] Verify both `Releases\*-Setup.exe` and `Releases\*.msi` are emitted by vpk after the change. If vpk only emits one when `--msi` is added, run vpk twice (once with, once without).

### Task 4.2: WiX fragment for ProgramData ACL

**Files:** `wix/wsscrcpyweb.wxs.fragment` (new), `.github/workflows/release.yml`

- [ ] Discover vpk's WiX customization mechanism — it may accept a fragment file via a CLI flag, or it may regenerate the WiX from a template that supports custom directives. Consult Velopack docs / repo for the exact knob.
- [ ] If a fragment-injection mechanism exists, write a fragment that:
   - Creates `Directory[@Id='ProgramDataFolder']\WsScrcpyWeb` at install time.
   - Applies a `PermissionEx` (or `<util:PermissionEx>`) granting `Authenticated Users` `Modify, ReadAndExecute, ListDirectory, Delete, ChangePermissions=No, TakeOwnership=No` with `(OI)(CI)` inheritance.
   - Component is permanent (`Permanent="yes"`) and not removed on uninstall — leaves user data intact for reinstall.
- [ ] If vpk does NOT expose a customization point, fall back to a launcher-side first-run bootstrap: on the first launcher start when `<dataRoot>` doesn't exist, create it via `Command::new("icacls")` running unelevated. **Won't work on first install before any user has run the app.** This is why MSI-time ACL is preferred — flag back to user before implementing fallback.

### Task 4.3: Sign + upload MSI artifact

**Files:** `.github/workflows/release.yml`

- [ ] Add MSI to the unsigned artifact upload step.
- [ ] Add a SignPath signing step for MSI (mirror existing Setup.exe signing — same signing-policy-slug should accept MSI; verify with SignPath docs or by trial).
- [ ] Add MSI to the `windows-final` artifact upload `path:`.
- [ ] Update `SHA256SUMS` `find` glob in the publish step to include `*.msi`.

### Task 4.4: Update README + docs

**Files:** `README.md`, `docs/RELEASING.md`, `docs/PROGRAMDATA-MIGRATION.md` (new)

- [ ] README Downloads section: list MSI as primary, Setup.exe as fallback through v0.1.21.
- [ ] PROGRAMDATA-MIGRATION.md: explain to existing v0.1.x users that v0.1.21 changes install layout. They should:
   1. Stop the service if installed (Settings → uninstall, or `sc stop WsScrcpyWeb`).
   2. Uninstall via Settings → Apps → ws-scrcpy-web → Uninstall (this removes the v0.1.20 install root cleanly).
   3. Run the new `WsScrcpyWeb-0.1.21.msi`.
   4. First-run setup flows again — choose install mode, etc.
- [ ] Note the UAC-on-update implication clearly: every update apply will prompt for UAC. This is the cost of system-wide installs and unavoidable with PerMachine.

---

## Phase 5: Migration validation + UAC behavior

### Task 5.1: Fresh-install integration test

- [ ] Clean Windows VM (Hyper-V snapshot, restorable). No prior ws-scrcpy-web install.
- [ ] Install via MSI → UAC prompt fires → install completes silently.
- [ ] Verify `C:\Program Files\WsScrcpyWeb\` contains `current\`, `Update.exe`, `packages\`, `velopack.log`. Verify no `config.json`, no `dependencies\` in install root.
- [ ] Verify `C:\ProgramData\WsScrcpyWeb\` exists with `Authenticated Users:Modify` ACL (`icacls "C:\ProgramData\WsScrcpyWeb"`).
- [ ] Launch app from Start Menu → tray fires → first-run modal appears.
- [ ] First-run setup writes `C:\ProgramData\WsScrcpyWeb\config.json` (verify by inspecting file — should be readable by all users).

### Task 5.2: Service install / redirect test (depends on v0.1.20 fixes still working)

- [ ] From local mode, click "Install service." UAC fires, service installs.
- [ ] Service-Node starts as Local System → reads `C:\ProgramData\WsScrcpyWeb\config.json` (same file Alice wrote) → finds `installMode: 'user-service'`, `firstRunComplete: true`.
- [ ] Service-Node logs to `C:\ProgramData\WsScrcpyWeb\dependencies\server.log` — line `[UpdateService] initialized for v0.1.21 on stable channel` MUST appear (proves Velopack auto-locate works under SYSTEM with Program Files install).
- [ ] Local instance redirects browser to service URL → page renders ServiceFirstRunModal (NOT WelcomeModal — the v0.1.20 race fix continues to hold).

### Task 5.3: Update apply test (UAC every time)

- [ ] With v0.1.21 installed, prepare a v0.1.21.1 release on a test channel.
- [ ] In-app updater detects update, offers to install.
- [ ] Click apply — UAC fires (Update.exe writes to Program Files, requires elevation). User accepts.
- [ ] Update completes, app restarts, new version reported.
- [ ] Document the UAC step in CHANGELOG / release notes so users aren't surprised.

### Task 5.4: Multi-user test

- [ ] Add a second user account on the test VM.
- [ ] Log in as second user. Tray icon should fire (started by HKLM Run-key registered by MSI, not HKCU).
- [ ] Verify second user's tray-click opens browser to the same port the first user is on.
- [ ] Verify both users see the same `Settings` values (since they share `config.json`).

---

## Phase 6: Cleanup (v0.1.22)

After v0.1.21 ships and is validated in production:

- [ ] Drop Setup.exe from vpk pack output. MSI-only artifact.
- [ ] Drop the v0.1.20 LOCALAPPDATA/APPDATA/USERPROFILE env-var propagation from `ServiceApi.handleInstall`. Locator override + Program Files install make it redundant.
- [ ] Drop the `--installto` documentation references — the install location is fixed at MSI build.
- [ ] Drop any v0.1.20 → v0.1.21 path-migration shim from Phase 1.3 if added.
- [ ] Consider tightening `config.json` ACL specifically (admin-only-write) while leaving `dependencies\` user-writable, if cross-user privilege-escalation surfaces become a real concern.

---

## Risks

1. **vpk's MSI fragment customization may not exist or be poorly documented.** If we can't inject our ProgramData ACL via WiX at MSI build time, we fall back to launcher-side first-run bootstrap which has its own race conditions (first user to launch creates the dir). **Mitigation:** investigate vpk source / file an issue if needed; fallback shim documented in Task 4.2.
2. **Velopack's `current\sq.version` manifest path may have changed name.** v0.1.17 noted `sq.version` is Squirrel-era and Velopack uses `Update.exe` for marker detection. The `VelopackLocatorConfig.ManifestPath` may need a different filename. **Mitigation:** inspect a packaged install to find the actual manifest filename before locking the locator config.
3. **MSI signing via SignPath may need a separate policy slug.** Existing slugs target Setup.exe. **Mitigation:** test in CI; if signing fails, file with SignPath or use a temporary unsigned MSI for v0.1.21-rc testing.
4. **Existing v0.1.20 users who don't uninstall before installing v0.1.21 MSI.** The MSI install will succeed, but the old install at `%LocalAppData%\WsScrcpyWeb\` lingers as orphaned files (ARP entry from the Setup.exe install is still there). **Mitigation:** PROGRAMDATA-MIGRATION.md doc; consider a v0.1.21 first-run check that warns if `%LocalAppData%\WsScrcpyWeb\` exists and prompts to clean up.
5. **Tray-menu API change is breaking for the helper crate.** Both crates must update together. **Mitigation:** the workspace builds them together; Cargo will fail loudly if one is out of sync. Test in CI.
6. **UAC on every update is a UX regression** for users currently auto-updating without prompts. Some users may be confused / annoyed. **Mitigation:** clear release-notes copy; tray icon could show update-available state and let user defer (Phase 3.4 future work).

---

## Rollback strategy

If Phase 4 breaks something we can't quickly fix:

- **Revert release.yml MSI flags.** Cherry-pick the vpk pack step back to Setup.exe-only. Cut a v0.1.21.1 patch release that's Setup.exe-only.
- **The Phase 1+2+3 code changes (path split, locator override, tray menu) can stay.** They don't depend on the install-layout change. v0.1.21.1 just goes back to the v0.1.20 install location while keeping the better tray and the locator-override robustness.
- **Existing v0.1.21 MSI users would have their config and deps in ProgramData.** The Setup.exe-only v0.1.21.1 would install to `%LocalAppData%`, find no config there, and trigger first-run again. We'd want a small migration to copy ProgramData state back to LocalAppData if Phase 1.3 shim is bidirectional. Or just accept that the small set of v0.1.21-MSI testers does a fresh setup.

---

## Out of scope for this plan

- Linux AppImage layout changes — Linux unaffected, no migration needed.
- macOS support — not on the roadmap.
- Group Policy deployment recipes — possible future doc, not blocking.
- Tray "update available" badge — Phase 3.4 future work.
- ACL hardening of `config.json` to admin-only-write — Phase 6 / future refinement.
- Cross-user log separation — future refinement.
