# SP3 — Velopack Installer & Auto-Update

> **Initial release version:** v0.1.0 (NOT v1.0.0 — pre-1.0 versioning until stable & feature-complete)

Cross-platform installer and auto-update framework for ws-scrcpy-web on Windows, with optional Windows Service mode, taskbar tray control, and channel-based updates (stable / beta).

## Problem

Today, ws-scrcpy-web is distributed as a source repo. Users `git clone`, `npm install`, `npm start`. This is fine for developers but excludes the much larger pool of users who just want a Windows installer. There's also no auto-update mechanism — every fix requires users to `git pull && npm install && npm run build` manually.

SP1/SP1b/SP2/SP2b shipped the foundation:
- `DEPS_PATH` env contract for strict dep resolution
- Exit-75 + `.restart` marker supervisor signal
- Launcher probe chain (`dependencies/node/` → `seed/node/` fallback)
- `autoInstallMissing` for first-boot ADB download
- `FirstRunBanner` for install failures
- node-pty prebuilt matrix (Option D Node auto-advance gating)

What's missing: an actual installer that bundles all of this and an auto-update mechanism so users don't have to redo it on every release.

## Solution

A Velopack-based MSI installer for Windows, plus a Rust launcher (replaces the `start.cmd` supervisor for installed users), plus optional Servy-managed Windows Service mode, plus a tray icon for clean shutdown control. Auto-update via Velopack's `UpdateManager` against GitHub Releases with stable / beta channel support.

**Spike findings** (2026-04-26, see `project_wsscrcpy_sp3_velopack_spike.md`) confirmed Velopack's JS SDK works in plain Node 24 and that `vpk pack` produces the expected install layout 1:1 with this design.

## Goals

- **Single MSI installer** for Windows users; no more "git clone & npm install" for end-users
- **Auto-update** via Velopack against GitHub Releases (no manual reinstall required)
- **Optional Windows Service mode** for headless / always-on deployments
- **Tray icon** for clean shutdown in both service and non-service modes
- **Stable + beta channels**, switchable post-install via Settings
- **Code-signed** binaries (no SmartScreen warnings) via Microsoft Trusted Signing
- **Configurable web port** with auto-shift on collision
- **Reproducible builds** in CI on tag push

## Non-goals (deferred)

- macOS support (perma-deferred per `feedback_no_macos.md`)
- Custom MSI install-wizard UI (port picker, service picker, etc.) — Velopack's WiX template is fixed; we don't fork it
- Single-instance detection (port already-in-use → open existing tab vs auto-shift) — deferred to v0.x polish
- MSI Group Policy deployment templates — possible future work if enterprise users surface
- Per-channel separate signing certs

## Versioning

| Stage | Versions |
|---|---|
| Pre-1.0 (initial maturity) | v0.1.0, v0.1.1, ..., v0.2.0, v0.3.0, ... |
| Stable graduation | v1.0.0 onwards |

Patch bumps `0.x.y` for bug fixes; minor/major bumps `0.x` for feature upgrades; major bump `1.0.0` only when stable and feature-complete.

`scripts/bump-version.mjs <new-version>` updates `package.json`, the Cargo workspace root `Cargo.toml`, and the `[Unreleased]` → `[<new-version>]` section in `CHANGELOG.md` in lockstep. CI asserts 3-way match: `package.json.version === Cargo.toml workspace.package.version === git tag`.

---

## Architecture overview

### Folder layout (post-install)

Confirmed against spike's actual `vpk pack` output:

```
<installRoot>/                       (e.g., %LocalAppData%\ws-scrcpy-web or %ProgramFiles%\ws-scrcpy-web)
├── ws-scrcpy-web.exe                (449 KB — Velopack auto-generated friendly-name stub; forwards to current/<mainExe>)
├── Update.exe                       (2.6 MB — Velopack updater binary)
├── config.json                      (OUR addition — survives updates)
├── current/                         (Velopack-managed; WIPED on every update)
│   ├── sq.version                   (XML manifest, NuGet-derived)
│   ├── ws-scrcpy-web-launcher.exe   (Rust launcher — our --mainExe)
│   ├── ws-scrcpy-web-tray.exe       (Rust tray helper for service mode)
│   ├── servy-cli.exe                (bundled Servy ~5–10 MB; pinned version)
│   ├── start.cmd                    (legacy launcher kept for dev mode `npm start`)
│   ├── dist/                        (webpack output: server + frontend)
│   ├── node_modules/                (production deps only — npm ci --omit=dev)
│   └── seed/
│       └── node/                    (bundled Node binary — first-run fallback before dependencies/node/)
├── dependencies/                    (DEPS_PATH target — persists across updates)
│   ├── node/                        (auto-updated by dep-manager)
│   ├── adb/
│   ├── node-pty/
│   └── .restart                     (transient marker for exit-75 loop)
└── logs/                            (Servy-managed log rotation; persists)
```

**Critical invariants:**
- `current/` is wiped and replaced atomically by Velopack on every update
- Anything that must survive updates lives at install root: `config.json`, `Update.exe`, `dependencies/`, `logs/`
- Velopack's auto-generated `ws-scrcpy-web.exe` stub is the canonical entry point — service binPath, desktop shortcut, and tray helper all reference this

### Install scope detection (runtime)

```js
function detectInstallScope(installRoot) {
  const localAppData = process.env.LOCALAPPDATA;
  return installRoot.toLowerCase().startsWith(localAppData.toLowerCase()) ? 'user' : 'system';
}
```

Where `installRoot = path.dirname(process.execPath)`. PerUser → `%LocalAppData%`; anything else (Program Files, custom path) → `system`.

---

## config.json schema

Lives at install root. Survives updates.

```json
{
  "installMode": "user" | "user-service" | "system" | "system-service",
  "firstRunComplete": true,
  "autoUpdate": true,
  "updateCheckIntervalMinutes": 60,
  "channel": "stable" | "beta",
  "githubOwner": "bilbospocketses",
  "webPort": 8000,
  "dependenciesPath": "./dependencies"
}
```

Field semantics:
- `installMode` — set on first-run service prompt; drives Settings UI gating
- `firstRunComplete` — explicit flag (NOT absence-of-`installMode`); gates the welcome modal
- `autoUpdate` — if true, downloaded updates auto-apply on next exit; if false, user must click "Apply update" explicitly
- `updateCheckIntervalMinutes` — configurable in Settings; default 60; checks also fire on every startup
- `channel` — `stable` (default) or `beta`; flipping via Settings re-initializes UpdateManager with the new channel feed
- `githubOwner` — overrideable in Settings for forks; only the owner segment is configurable, full URL is hardcoded
- `webPort` — configurable; auto-shifted on collision (see "Port collision" below)
- `dependenciesPath` — relative to install root; defaults to `./dependencies`

**Resolution order for DEPS_PATH:** `process.env.DEPS_PATH` → `<installRoot>/config.json[dependenciesPath]` → dev fallback → hard-fail.

---

## Velopack integration

### `VelopackApp.build().run()` is first-thing-in-main

In **both** the Rust launcher (`ws-scrcpy-web-launcher.exe`) and our Node server entry point (`dist/server/main.js`):

- **Rust launcher** uses the Velopack Rust crate (`velopack` on crates.io) — calls `velopack::VelopackApp::build().run()` before any other logic. Velopack may exit/restart at this point during install/update lifecycle moments.
- **Node server** uses `velopack` npm package — calls `VelopackApp.build().run()` at top of `main.js`.

Both must be the very first executable statement in their respective entry points.

### Hook dispatch (Rust launcher)

Velopack invokes our `mainExe` with special flags during lifecycle moments:

| Flag | Time budget | Action |
|---|---|---|
| `--veloapp-install` | 30 s | Seed `config.json` if absent. **No service registration here** — that's UI-driven post-install. |
| `--veloapp-updated` | 15 s | If service registered (`installMode` ends in `-service`), `servy restart WsScrcpyWeb`; otherwise no-op. |
| `--veloapp-uninstall` | 30 s | If service registered: `servy stop` + `servy uninstall`. **Preserve** `dependencies/`, `config.json`, `logs/` (default behavior; in-app Settings "Uninstall" button offers explicit "also remove user data" checkbox). |

Hook return code: `0` = success, `≠ 0` = failure (Velopack treats install/update as failed).

### Update flow API (Node server)

Server routes:

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/updates/status` | GET | Returns `{ available, currentVersion, latestVersion, downloaded, autoUpdate, channel, isInstalled }` |
| `/api/updates/check` | POST | Manual re-check; calls `UpdateManager.checkForUpdatesAsync()` |
| `/api/updates/apply` | POST | Calls `waitExitThenApplyUpdates()`; server exits with code 0 (NOT 75) so Velopack swap proceeds |
| `/api/updates/config` | PATCH | Update `autoUpdate`, `channel`, `githubOwner`, or `updateCheckIntervalMinutes` in config.json. UpdateManager re-initialized if channel/owner changed. |
| `/api/server/shutdown` | POST | Clean exit (non-service mode only); calls `process.exit(0)` |

Frontend polls `/api/updates/status` on page load + every `updateCheckIntervalMinutes` (configurable). Backend background timer also runs Velopack checks at the same cadence to keep status fresh.

### Velopack feed URL

Hardcoded base: `https://github.com/${config.githubOwner}/ws-scrcpy-web/releases/latest/download/`

Velopack reads `releases.${channel}.json` from this URL. UpdateManager constructor:

```js
const feedUrl = `https://github.com/${config.githubOwner}/ws-scrcpy-web/releases/latest/download/`;
const mgr = new UpdateManager(feedUrl, { explicitChannel: config.channel });
```

`VELOPACK_FEED_URL` env override available for testing (overrides the constructed URL entirely; not exposed in Settings UI).

### Dev-mode handling

```js
if (!mgr.isInstalled()) {
  // Hide update UI, hide first-run modal, hide Stop Server & Exit
  return { available: false, reason: 'dev-mode' };
}
```

`UpdateManager.isInstalled()` returns `false` when running from `npm start` source (no `current/sq.version` manifest). Settings page shows a "Dev mode — packaging features disabled" banner.

---

## Servy integration (service mode)

### Bundling

Servy is **bundled** in `current/servy-cli.exe`, pinned to a specific GitHub release (downloaded by `scripts/fetch-servy.mjs` during build). MIT-licensed, redistributable. Bundled rather than winget-prereq because:
- Headless servers may not have winget
- Out-of-band winget updates of Servy could conflict with the running service
- Pinning Servy version to our app version ensures controlled lifecycle

### Registration command

Called by the **in-app "Install as Service" button** (Settings page) or the **first-run service prompt** (welcome modal):

```bash
current\servy-cli.exe install
  --name "WsScrcpyWeb"
  --displayName "ws-scrcpy-web"
  --description "Android device tools via adb & scrcpy"
  --binPath "<installRoot>\ws-scrcpy-web.exe"     # the friendly-name stub, NOT current/<mainExe>
  --account <currentUser | LocalSystem>           # determined by install scope
  --startType Automatic
  --maxRestartAttempts 3
  --envVars "DEPS_PATH=<installRoot>\dependencies"
  --logPath "<installRoot>\logs"
```

**Why bind to the stub, not `current/<mainExe>`:** Velopack updates the stub to forward to the new `current/` after each app update. Stub path is stable across versions; `current/` contents swap atomically. Service binPath through stub = Velopack's intended flow.

### Service identity

- Service name: `WsScrcpyWeb` (fixed; no version suffix; identity stable across upgrades)
- Display name: `ws-scrcpy-web` (lowercase per text style)
- Description: `"Android device tools via adb & scrcpy"`

### Account selection

| Install scope | Service account |
|---|---|
| PerUser (`%LocalAppData%`) | currentUser |
| PerMachine (`%ProgramFiles%`) | LocalSystem |

Determined at registration time via install scope detection.

### Lifecycle interactions with Velopack updates

| Phase | Service action |
|---|---|
| Velopack downloads + stages update | None (service keeps running on old `current/`) |
| Velopack applies update (`waitExitThenApplyUpdates`) | Server exits with code 0 → Servy detects exit → if it doesn't auto-restart fast enough, Velopack-installed `--veloapp-updated` hook calls `servy restart` after the swap |
| Velopack uninstall | `--veloapp-uninstall` hook calls `servy stop` + `servy uninstall` before MSI removes `current/` |

Servy's `--maxRestartAttempts=3` prevents infinite restart loops on a broken update; after 3 failures, service stays down until user intervenes.

### Logs

Servy provides built-in log rotation. Logs land in `<installRoot>\logs\` (sibling of `current/`, persists across updates). Configurable in Settings if user wants elsewhere.

---

## UI components

### A. First-run welcome modal (one-time)

Triggered when `config.json.firstRunComplete === false`. Modal style (styled, NOT native `confirm()`):

```
┌─────────────────────────────────────────────────────┐
│  Welcome to ws-scrcpy-web                           │
│                                                     │
│  Server is running on http://localhost:8000         │
│  You can change the port anytime in Settings.       │
│                                                     │
│  ───────────────────────────────────────────────    │
│                                                     │
│  Run as a Windows service?                          │
│  Recommended for always-on access (headless         │
│  servers, multi-user setups). The server starts     │
│  with Windows and runs in the background.           │
│                                                     │
│  You can change this later in Settings.             │
│                                                     │
│  [ Yes, install service ]  [ No, run on demand ]    │
└─────────────────────────────────────────────────────┘
```

If port was auto-shifted (8000 in use), copy adjusts:

```
│  Server is running on http://localhost:8001        │
│  (Default port 8000 was in use; we auto-picked     │
│   8001. Change anytime in Settings.)                │
```

On `Yes`: detect install scope → call `servy install` with appropriate account → set `config.json.installMode = "user-service"` or `"system-service"` → `firstRunComplete = true` → close modal.
On `No`: set `config.json.installMode = "user"` or `"system"` → `firstRunComplete = true` → close modal.

### B. Header — "Update Available" button

Position: home page header, top-right area, parallel with theme toggle.

States:
- `idle` — hidden (no update)
- `checking` — small inline spinner (rare; flashes briefly on startup)
- `downloading` — blue button: "Downloading update… 47%" with progress
- `ready` — green button: "Apply update v0.1.3" → click triggers `waitExitThenApplyUpdates` → server exits → Velopack swaps → restart
- `error` — red caption: "Update check failed. [Retry]"

Cadence: on startup + every `updateCheckIntervalMinutes` (default 60 min, configurable).

### C. Tray icon (single-purpose)

Visible in **both** non-service and service modes. Shutdown is the only action.

| Mode | Tray location |
|---|---|
| Non-service | Tray initialized in the launcher process itself (Rust `tray-icon` crate) |
| Service | Separate user-mode helper `ws-scrcpy-web-tray.exe`; auto-starts at user login via `HKCU\…\Run` registry entry; talks to the service via `localhost:<webPort>/api/server/shutdown` |

**Click behavior** (left-click and right-click identical): shows confirmation modal:

```
┌─────────────────────────────────────────┐
│  Exit ws-scrcpy-web?                    │
│                                         │
│  [ Yes ]   [ No ]                       │
└─────────────────────────────────────────┘
```

In non-service mode "Yes" exits the app cleanly (exit-0). In service mode "Yes" stops the service via Servy (which the helper invokes via `servy stop WsScrcpyWeb`).

### D. Stop Server & Exit button

Visibility: ONLY when `installMode` ∈ {`user`, `system`} (non-service modes).

Click → styled modal: "Stop the server? You'll need to relaunch ws-scrcpy-web from your Start Menu / shortcut to use it again." → `[ Yes ]` / `[ No ]` → on Yes: `POST /api/server/shutdown` → server replies 200, then `process.exit(0)`. Browser tries `window.close()`; if blocked, falls through to "Server stopped. You can close this tab." inline notice.

### E. Settings modal

New top-level modal accessible from a gear icon in the header. Sections:

**Server**
- Web port (number input, range 1024–65535, validated; save → server restart with redirect)

**Updates**
- Auto-apply downloaded updates (checkbox; default checked)
- Update check interval (number input minutes; default 60)
- Channel (`stable` | `beta` radio buttons)
- GitHub owner (text input, default `bilbospocketses` — for forks)
- Manual "Check for updates now" button

**Service** (visible only when `installMode` is set)
- Service status indicator (running / stopped / not installed)
- "Install as Service" / "Uninstall Service" button (toggles based on current state)

**App**
- "Uninstall ws-scrcpy-web" button (custom prompt with "also remove user data" checkbox; default unchecked) → triggers `msiexec /x {ProductCode}`

**Dev-mode banner** (when `isInstalled() === false`): "Dev mode — packaging features disabled"

### F. Style consistency follow-up

(Out of scope for SP3; logged as separate TODO) — existing notifications (toasts, native confirms in Connect / Disconnect / scan flows) should be migrated to styled modals for visual consistency. To be tracked in `todo_ws_scrcpy_web.md` after SP3 ships.

---

## Port collision detection

On every server startup (not just first-run, defensively):

```js
const desiredPort = config.webPort ?? 8000;
const actualPort = await findAvailablePort(desiredPort, desiredPort + 99); // try 8000..8099
if (actualPort === null) {
  fail("Could not find available port in range 8000–8099");
}
if (actualPort !== desiredPort) {
  config.webPort = actualPort;
  saveConfig();
  portWasAutoShifted = true;
}
```

UX:
- **First run** + auto-shifted: welcome modal copy mentions the auto-shift
- **Subsequent runs** + auto-shifted: dismissible info banner on home page (no modal — modals only fire once)
- **Single-instance detection** (port held by our own running app → open browser to existing instance) deferred to v0.x

---

## Packaging & CI

### Single MSI deployment

```bash
vpk pack \
  --packId WsScrcpyWeb \
  --packVersion 0.1.0 \
  --packDir publish \
  --mainExe ws-scrcpy-web-launcher.exe \
  --packTitle "ws-scrcpy-web" \
  --packAuthors "ws-scrcpy-web contributors" \
  --msi \
  --instLocation Either \
  --azureTrustedSignFile signing-metadata.json \
  --releaseNotes RELEASE_NOTES.md \
  -o Releases
```

**`--instLocation Either`** prompts user at install time for PerUser vs PerMachine.
**`--msi`** produces MSI alongside Setup.exe; CI deletes Setup.exe artifact (we ship MSI only).
**Portable zip** is produced as a free side-effect; we keep it as advanced "no-install" option.

### Code signing

**SignPath Foundation OSS program** (free for verified open-source projects per https://signpath.org/free-for-open-source) — applied 2026-04-27, awaiting approval (typically 2-4 weeks).

Two signing policies under one SignPath account:
- **Windows policy:** Authenticode → signs inner `ws-scrcpy-web-launcher.exe` + `ws-scrcpy-web-tray.exe` pre-pack, signs the MSI post-pack
- **Linux policy:** detached GPG → produces `.AppImage.sig` alongside the AppImage post-pack (per https://docs.signpath.io/crypto-providers/gpg)

CI uses `signpath/github-action-submit-signing-request@v2` with `wait-for-completion: true` to submit unsigned artifacts and download signed versions in the same workflow. Single secret: `SIGNPATH_API_TOKEN`. Three non-secret identifiers in workflow YAML: organization-id, project-slug (one per policy), signing-policy-slug.

**Estimated quota usage:** ~4 signatures per release (launcher + tray exes, MSI, AppImage). Well under SignPath Foundation's typical limits.

**SignPath OSS program requirement:** the downloads page must mention SignPath Foundation. Satisfied via:
- README "Downloads" section includes the credit
- Every GitHub Release page auto-prepends `_Signed via [SignPath Foundation](https://signpath.org)._` to release notes via `scripts/extract-changelog.mjs`
- `docs/RELEASING.md` notes the requirement to prevent drift

**Pre-approval workflow:** `release.yml` infers signing mode from the presence of `SIGNPATH_API_TOKEN` secret. When the secret is absent (today), workflow runs in **unsigned mode** — produces all artifacts plus a `SHA256SUMS` file, publishes to GH Release with a prominent "⚠️ Unsigned: SignPath approval pending" notice auto-prepended. **v0.1.0 = unsigned** (gives SignPath a live download URL to test against per their review process). **v0.1.1 = first signed release**, cut once SignPath approves and the secret is added; the unsigned-mode notice automatically disappears.

**Alternative considered + rejected: Microsoft Trusted Signing** ($9.99/mo, faster identity validation ~3-5 days). Worse SmartScreen reputation than DigiCert EV; ongoing $120/year vs $0 for SignPath OSS. Trusted Signing remains a valid fallback if SignPath OSS approval is denied.

### `publish/` folder contents

Assembled by `scripts/stage-publish.mjs`:

```
publish/
├── ws-scrcpy-web-launcher.exe    (Rust, built via `cargo build --release` in launcher/)
├── ws-scrcpy-web-tray.exe        (Rust, built via `cargo build --release` in tray/)
├── servy-cli.exe                 (downloaded by scripts/fetch-servy.mjs at pinned version)
├── start.cmd                     (legacy launcher, dev mode only)
├── dist/                         (webpack output)
├── node_modules/                 (production deps only)
└── seed/
    └── node/
        └── node.exe              (same Node version we built dist with)
```

### GitHub Actions workflow

Trigger: tag push `v*` (stable) or `v*-beta.*` (beta).

```yaml
# .github/workflows/release.yml
on:
  push:
    tags: ['v*']
jobs:
  build-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '24.x' }
      - uses: actions/setup-dotnet@v4
        with: { dotnet-version: '9.x' }
      - uses: dtolnay/rust-toolchain@stable
      - run: dotnet tool install -g vpk

      # 3-way version assertion
      - run: node scripts/assert-version-sync.mjs ${{ github.ref_name }}

      # Build steps
      - run: npm ci --omit=dev
      - run: npm run build                          # webpack
      - run: cargo build --release --workspace      # launcher + tray
      - run: node scripts/fetch-servy.mjs           # downloads pinned servy-cli.exe
      - run: node scripts/stage-publish.mjs         # assembles publish/

      # Channel detection
      - id: channel
        run: |
          if ('${{ github.ref_name }}' -match '-beta') { echo "channel=beta" >> $env:GITHUB_OUTPUT }
          else { echo "channel=stable" >> $env:GITHUB_OUTPUT }

      # Pack with signing
      - run: |
          vpk pack `
            --packId WsScrcpyWeb `
            --packVersion ${{ github.ref_name }} `
            --packDir publish `
            --mainExe ws-scrcpy-web-launcher.exe `
            --packTitle "ws-scrcpy-web" `
            --packAuthors "ws-scrcpy-web contributors" `
            --msi `
            --instLocation Either `
            --channel ${{ steps.channel.outputs.channel }} `
            --azureTrustedSignFile $env:SIGNING_METADATA `
            --releaseNotes scripts/extract-changelog.mjs ${{ github.ref_name }} `
            -o Releases
        env:
          SIGNING_METADATA: ${{ secrets.AZURE_TRUSTED_SIGNING_METADATA }}

      # Drop Setup.exe (MSI only ships)
      - run: Remove-Item Releases/*-Setup.exe

      # Generate release notes from CHANGELOG section
      - run: node scripts/extract-changelog.mjs ${{ github.ref_name }} > release-notes.md

      # Upload to GH Release
      - uses: softprops/action-gh-release@v2
        with:
          prerelease: ${{ steps.channel.outputs.channel == 'beta' }}
          body_path: release-notes.md
          files: |
            Releases/*.msi
            Releases/*-Portable.zip
            Releases/*.nupkg
            Releases/RELEASES
            Releases/releases.${{ steps.channel.outputs.channel }}.json
```

### CI-side scripts

| Script | Purpose |
|---|---|
| `scripts/bump-version.mjs <ver>` | Updates package.json + Cargo workspace + CHANGELOG |
| `scripts/assert-version-sync.mjs <tag>` | 3-way version check (package.json ↔ Cargo.toml ↔ git tag); fails CI on drift |
| `scripts/fetch-servy.mjs` | Downloads pinned servy-cli.exe from servy GH releases into `publish/` |
| `scripts/stage-publish.mjs` | Assembles `publish/` from build outputs |
| `scripts/extract-changelog.mjs <ver>` | Pulls the `[<ver>]` section from CHANGELOG.md as release notes |
| `scripts/test-update-flow.ps1` | Local v1→v2 update flow test (sandbox) |

---

## Testing & validation

### Local update flow (no GH Releases needed)

```ps1
# scripts/test-update-flow.ps1
# Build v0.1.0 → install to sandbox → build v0.1.1 to local feed → trigger update → verify swap
```

Pattern uses Velopack's documented `file:///` feed support and the spike's portable-zip-extract trick to avoid polluting `%LocalAppData%`.

### Unit tests

| Layer | Coverage |
|---|---|
| **vitest** | Port collision detection, config.json read/write/migrate, install scope detection, Velopack hook arg parsing, channel switching (UpdateManager re-init), GH owner override URL construction |
| **cargo** | Argv parsing for `--veloapp-*`, exit-75 supervisor logic, tray click → confirm → exit signal, hidden-window subsystem behavior, config.json read for service-mode detection |
| **Integration** | `scripts/test-update-flow.ps1` runs end-to-end on `windows-latest` runner |

### CI gates

| Trigger | Gates |
|---|---|
| PR push | `npm test`, `tsc --noEmit`, `cargo test`, `cargo clippy -- -D warnings`, `npm run build` (smoke build) |
| Tag push | All of above + `vpk pack` + signing + GH Release upload |

### Pre-release manual checklist (run on Hyper-V VM for Windows; user's 2 Linux VMs for Linux)

**Windows checklist:**
1. ✅ Install MSI (PerUser scope) — first-run modal appears, port shown, "Run as Service?" prompts
2. ✅ Pick "No service" → home loads, Stop Server & Exit visible, tray icon present
3. ✅ Tray click → "Exit ws-scrcpy-web?" → exit cleanly
4. ✅ Re-launch via desktop shortcut → no first-run modal, uses saved port
5. ✅ Settings → change port → save → server restarts on new port → browser auto-redirects
6. ✅ Settings → "Install as Service" → service registered → restart → Stop Server & Exit hidden, tray helper running
7. ✅ Settings → "Uninstall Service" → reverts cleanly
8. ✅ Repeat 1–2 with PerMachine scope (admin install) — service runs as LocalSystem
9. ✅ Update flow: install v0.1.0, place v0.1.1 in local feed, Check Now → "Apply update" → verify swap, config + dependencies preserved
10. ✅ Settings → "Uninstall ws-scrcpy-web" with "also remove user data" UNCHECKED → MSI uninstall fires → app removed but `dependencies/`, `config.json`, `logs/` preserved
11. ✅ Re-install → first-run modal does NOT appear (firstRunComplete preserved); previous data intact
12. ✅ Settings → "Uninstall" with "also remove user data" CHECKED → all data gone

**P4a-specific verification (must pass before SP3 closes):**
13. ✅ **Servy auto-restart-on-exit-0 behavior** (P4a risk item): in service mode, click tray helper → confirm exit → tray POSTs `/api/server/shutdown` → server replies 200 → server `process.exit(0)`. **Verify Servy does NOT auto-restart the service after this clean exit.** Open `services.msc` and confirm `ws-scrcpy-web` is in `Stopped` state and stays stopped (wait 30s to be sure). If Servy DOES auto-restart, document the workaround: ServerShutdownApi handler must call `servy stop self` before `process.exit(0)`. Fix is bounded (~10 lines in ServerShutdownApi.ts + a status-detection branch in ServyClient).
14. ✅ Tray helper Run-key verification: after service install, check `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\WsScrcpyWebTray` exists and points at `<installRoot>\current\ws-scrcpy-web-tray.exe`. After service uninstall, verify the value is gone. After log-off + log-back-in, confirm tray icon auto-appears (Run-key fired).
15. ✅ Tray helper survival across service restart: with service running and tray helper visible, restart Windows. After re-login, tray icon reappears (Run-key fired) and connects to the service that auto-started.
16. ✅ Tray helper graceful degradation: stop the service via `services.msc` (NOT via the tray). Click the tray icon → POST fails (server gone) → tray helper exits silently. No error popups.

**Linux checklist (P4b — runs once Linux sub-phase ships):**
17. ✅ Install via .deb (or .rpm/.AppImage per P4b decisions) on Linux VM #1 — first-run flow analogous to Windows
18. ✅ "Install as Service" creates systemd unit at `~/.config/systemd/user/ws-scrcpy-web.service` for user scope (or `/etc/systemd/system/` for system scope); `systemctl --user enable --now` (or `sudo systemctl enable --now`) succeeds
19. ✅ Service survives logout (`loginctl enable-linger` on user-scope install) — verify with `who -u` showing no active session yet `systemctl --user status` shows running
20. ✅ Settings → "Uninstall Service" calls `systemctl disable` + `systemctl stop` + removes unit file cleanly
21. ✅ Tray icon on Linux: per P4b decision (DEs that support tray show it; DEs that don't get a documented "use Settings web UI to stop the server" fallback)
22. ✅ Repeat all of above on Linux VM #2 with a different distro (e.g., VM #1 = Ubuntu, VM #2 = Fedora) to catch distro-specific issues

Manual checklist gates the tag push for v0.1.0. CI automation deferred.

### Uninstall behavior

**Default (Add/Remove Programs path):** preserve `dependencies/`, `config.json`, `logs/` silently. README documents manual cleanup: "After uninstalling, optionally delete `%LocalAppData%\ws-scrcpy-web` to remove all user data."

**In-app Settings → Uninstall path:** custom prompt with "also remove user data" checkbox (default unchecked). If checked, app deletes data dirs first, then `msiexec /x {ProductCode}`.

---

## Release runbook (lightweight)

Full version in `RELEASING.md` (SP5 doc work). Quick form for cutting a release:

### Stable (e.g., v0.1.0 → v0.1.1)

```bash
git checkout main && git pull
npm test && npx tsc --noEmit && cargo test && cargo clippy -- -D warnings

node scripts/bump-version.mjs 0.1.1                       # bumps package.json + Cargo + CHANGELOG
git add package.json Cargo.toml CHANGELOG.md
git commit -m "release: v0.1.1"
git push origin main

git tag v0.1.1 && git push origin v0.1.1                  # CI fires

# Run Hyper-V manual checklist against the produced MSI
# If broken: gh release edit v0.1.1 --prerelease (drops it from "latest"), fix forward
```

### Beta (e.g., v0.2.0-beta.1)

Same flow; tag pattern `v*-beta.*` triggers CI's `--channel beta` path. GH Release auto-marked as Pre-release.

### Rollback

Don't delete published releases (breaks in-flight downloads). Mark broken release as Pre-release via `gh release edit`; existing users on prior version stop seeing it as "latest"; cut a fix-forward release immediately.

---

## Open items / deferred

| Item | Status |
|---|---|
| Single-instance detection (avoid two listeners on different ports if app already running) | Deferred to v0.x |
| Linux Velopack installer + systemd service mode | **In-scope for SP3** as a later sub-phase; ships before SP3 closes. Windows path lands first to validate the Velopack mechanism, then Linux follows on the same release surface. P3 ships a `ServiceClient` interface + Windows `ServyClient` implementation + Linux `SystemdClient` stub so the Linux phase is purely additive. |
| Notification style consistency follow-up (toasts, native confirms → styled modals) | Tracked in `todo_ws_scrcpy_web.md` post-SP3 |
| Custom MSI install-wizard UI (port picker, service picker) | Not feasible without WiX template forking; covered via first-run modal |
| Automated post-release smoke test in CI | Deferred to v0.x; manual checklist on Hyper-V for v0.1.0 |
| MSI Group Policy templates | Speculative, not requested |

---

## References

- Spike findings: `project_wsscrcpy_sp3_velopack_spike.md`
- Sizing pre-read: `project_wsscrcpy_sp3_sizing.md`
- SP2/SP2b foundation: `project_wsscrcpy_sp2_sp2b.md`
- node-pty matrix + musl gap: `project_wsscrcpy_sp1b.md`
- Velopack docs: https://docs.velopack.io
- Servy: https://github.com/aelassas/servy
- MS Trusted Signing: https://azure.microsoft.com/en-us/products/artifact-signing
