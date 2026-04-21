# SP2b — First-run bootstrap (design)

**Date:** 2026-04-21
**Status:** Approved, pending tactical plan
**Predecessor specs:** `docs/superpowers/specs/2026-04-21-installer-docker-roadmap.md`, `docs/superpowers/specs/2026-04-21-sp2-dep-manager-polish-design.md`
**Successor:** `docs/superpowers/plans/2026-04-21-sp2b-first-run-bootstrap.md` (written next via writing-plans)

---

## Purpose

A fresh Velopack install places the app on disk with an empty `dependencies/` folder. The user double-clicks the stub and expects the app to come up and work. Today, `start.cmd`/`start.sh` hard-fail if `dependencies/node/node.exe` is missing, and the dep-manager has no "install the missing ones on first boot" primitive — only an "update" operation that fires after a positive `UpdateAvailable` status.

SP2b fills that gap. It defines the seeding layout, the launcher's Node-discovery probe chain, a first-run auto-install primitive, and a home-page banner that surfaces offline-at-first-boot to the user for a one-click recovery.

SP2 (dep-manager polish — depsPath resolution, restart primitive, Option D, Logger coverage) is the predecessor. SP2b is the UX-and-bootstrap layer that sits on top. SP3 (Velopack packaging) consumes both.

## Split from SP2

Originally SP2 listed first-run bootstrap as its fourth deliverable. During the SP2 brainstorm, the scope of bootstrap — a UI component, a network failure-mode path, a chicken-and-egg Node story — was large enough to deserve its own design round, so it was carved out as SP2b.

---

## 1. Scope

### In scope

1. **Launcher Node-discovery probe chain** — `start.cmd` and `start.sh` try `<installFolder>/dependencies/node/node.exe` first, fall back to `<installFolder>/seed/node/node.exe` (the Velopack-bundled seed). Hard-fail with an instructive error only when BOTH are missing.
2. **`DependencyManager.autoInstallMissing()` primitive** — after the existing startup `checkAll` resolves, the server walks dep state and calls `update(name)` for every dep where `installedVersion === null && latestVersion !== null`. Idempotent; skips deps where latest couldn't be determined (network failure handed off to the banner path).
3. **Home-page first-run banner** — a new UI component that renders on the home page when any managed dep is in `Error` state or has `installedVersion === null` after the startup sweep. Shows the dep name(s), a short explanation, and a "Retry" button.
4. **User-initiated retry endpoint** — new `POST /api/deps/retry-install` that re-runs `checkAll` + `autoInstallMissing` synchronously and returns a summary.

### Out of scope

- **Velopack packaging and Node bundling itself** — SP3 decides the exact seed path, split-payload packaging, and release-engineering cadence. SP2b only specifies that the seed path must exist and be findable at `<installFolder>/seed/node/`.
- **Node version pinning** — whoever builds the Velopack release picks the LTS. SP1b's manifest (ABI 137 at time of writing) constrains the choice but doesn't dictate it.
- **scrcpy-server first-run download** — the scrcpy-server binary is bundled into the webpack build output at `dist/assets/scrcpy-server` (via `DeviceProbe.ts`'s `import '../../assets/scrcpy-server'`). `checkInstalled('scrcpy-server')` returns `SERVER_VERSION` unconditionally, so it is always "installed" from the dep-manager's perspective. SP2b does not need to install it.
- **Background auto-retry** — rejected during brainstorm (Q4). Retry is explicitly user-initiated via the banner.
- **Consent prompt for the auto-install** — rejected during brainstorm (Q3). Installing the app is consent to the app doing what it needs to function.
- **Blocking modal on first boot** — rejected during brainstorm (Q4). The banner is non-modal.

---

## 2. Seeding layout

Velopack places the bundled Node at:

```
<installFolder>/current/seed/node/
                            ├── node.exe          (Windows)
                            ├── node              (Linux)
                            └── ... (rest of LTS tarball contents)
```

`current/` is wiped and replaced wholesale on each Velopack app update, so the seed is re-materialized on every release. The bundled Node version is whatever the release-engineering pipeline pins it to — by policy, it must be an LTS major covered by the current SP1b node-pty prebuilt manifest.

The dep-manager's canonical writable location remains `<installFolder>/dependencies/node/` (one level up from `current/`, per the SP2 layout). The dep-manager never reads from `seed/`; it only writes to `dependencies/node/`.

### Why not copy seed → dependencies on first boot

A copy-on-first-boot flow (Option b in brainstorm Q2) was rejected in favor of a probe-chain flow (Option a) for three reasons:

1. **No first-boot detection.** The probe chain is stateless. It checks two paths and uses whichever is present.
2. **One-way writer invariant.** The dep-manager is the sole writer of `dependencies/`. Avoiding a copy path preserves that invariant.
3. **Failure surface.** A copy step can partially fail (disk full, permissions) with no corresponding UX improvement.

The side-effect of not copying is that every Velopack app update re-ships the seed payload (~35 MB for a Node LTS zip). That's an SP3 packaging optimization concern — Velopack supports split packages, so the seed can become a first-install-only asset. Does not affect SP2b's architecture.

---

## 3. Launcher probe chain

### `start.cmd` — post-SP2 state

The current SP2 `start.cmd` lines 8–14 resolve `%NODE%` from `%SCRIPT_DIR%dependencies\node\node.exe` and hard-fail if it's missing. SP2b inserts the seed fallback:

```cmd
set "NODE=%SCRIPT_DIR%dependencies\node\node.exe"
if not exist "%NODE%" set "NODE=%SCRIPT_DIR%seed\node\node.exe"
if not exist "%NODE%" (
    echo ERROR: Node.js not found at dependencies\node\ or seed\node\
    echo Reinstall the app to restore the bundled Node.
    pause
    exit /b 1
)
```

The `pause` is preserved from the existing SP2 behavior so a CLI user sees the message before the window closes.

### `start.sh` — analogous

```bash
NODE="$SCRIPT_DIR/dependencies/node/node"
if [ ! -x "$NODE" ]; then
    NODE="$SCRIPT_DIR/seed/node/node"
fi
if [ ! -x "$NODE" ]; then
    echo "ERROR: Node.js not found at dependencies/node/ or seed/node/"
    echo "Reinstall the app to restore the bundled Node."
    exit 1
fi
```

### Dev-checkout behavior

In a dev checkout (`<repo>/`), `seed/node/` does not exist. SP2's strict `depsPath` resolver falls back to `<repo>/dependencies/` (per the SP2 dev-fallback rule), which is also where dev users populate Node via their own means. SP2b's probe chain is a no-op for dev checkouts: the first probe either hits a real Node (and starts) or misses (and the fallback also misses, hard-failing with the instructive error). Existing dev workflows are unaffected.

### Docker behavior

Dockerfile bakes Node into the image under the dev/system-node convention; the launcher path is not used. SP2b's probe chain is likewise a no-op.

---

## 4. First-run auto-install

### The primitive

New method on `DependencyManager`:

```ts
public async autoInstallMissing(): Promise<void> {
    for (const info of this.state.values()) {
        if (info.installedVersion === null && info.latestVersion !== null) {
            log.info(`First-run: auto-installing ${info.name}`);
            await this.update(info.name);
        }
    }
}
```

Properties:

- **Idempotent:** can be called any number of times; does nothing once all deps have non-null `installedVersion`.
- **Tolerates offline:** if `latestVersion === null` (because `checkLatest` threw earlier), the dep is skipped. Error and Unknown states remain until the user retries.
- **Sequential, not parallel:** one `update()` at a time. Avoids network saturation on constrained links and simplifies log output.
- **Side-effects identical to user-initiated update:** same download, same install, same status transitions. Dep-panel UI shows the same progress indicators it already does.
- **No restart:** `update()` sets `info.status = UpToDate` but does not call `requestRestart()`. Restart is only triggered when the user explicitly clicks "Update" in the dep panel for a dep marked `requiresRestart: true` (currently only Node). The auto-install path is for filling in MISSING deps, not updating ones; Node will always be present (bundled seed), so there's no restart to trigger here.

### Wiring

In `src/server/index.ts`, replace the current kickoff:

```ts
depManager.checkAll()
    .catch((err: Error) =>
        Logger.for('DependencyManager').error('Initial check failed:', err.message));
```

with:

```ts
depManager.checkAll()
    .then(() => depManager.autoInstallMissing())
    .catch((err: Error) =>
        Logger.for('DependencyManager').error('Initial check/install failed:', err.message));
```

One chained `.then()`. Errors from either step propagate to the same `.catch`.

### What actually fires on a typical first boot

Given the scope (scrcpy-server pre-bundled, Node seed-present):

- `checkAll` populates nodejs + adb + scrcpy-server.
- `nodejs` state: installed (from seed), latest (from Option D filter). `resolveStatus` likely `UpToDate`. Skipped.
- `adb` state: installedVersion=null (first boot), latestVersion=valid (from Google's repository XML). `resolveStatus` → `Unknown`. Auto-install fires.
- `scrcpy-server` state: installed (from `SERVER_VERSION` constant), latest (from GitHub releases). `resolveStatus` → `UpToDate` or `UpdateAvailable`. Skipped.

Net effect: first boot silently downloads ADB and marks it UpToDate.

### Offline first boot

- `checkAll` runs: nodejs+scrcpy resolve normally; adb's `checkLatest` throws (no internet). Status: Error.
- `autoInstallMissing` walks state: adb has installed=null AND latest=null → skipped.
- No update fires. UI loads, home-page banner appears (§5).

---

## 5. Home-page banner

### Component

New class `FirstRunBanner` in `src/app/client/FirstRunBanner.ts` (path tentative — plan will verify against existing home-page mount conventions). Lifecycle:

1. On home-page load, fetch dep state via existing `GET /api/deps` endpoint.
2. Render if any managed dep has `status === DependencyStatus.Error` OR (`status === DependencyStatus.Unknown` AND `installedVersion === null`).
3. Hide otherwise.
4. On Retry click: call new `POST /api/deps/retry-install` endpoint, show a "Retrying…" state, then re-fetch dep state and re-render.

### Placement

Home page only — not shown on device-stream views, scan views, or embedded/iframe consumers. The banner would be noise on pages where device features aren't in play (e.g., the embedded `WsScrcpy.startStream()` mode shouldn't show an unrelated banner).

### Content

```
⚠ Setup incomplete — ADB failed to download. Check your network connection. [Retry]
```

- Pluralize / list names if multiple deps are pending: `ADB, scrcpy-server failed to download`.
- Dismissible: NO. Hides automatically when the state clears.
- Persistent across reloads within a session: YES, because the trigger is server state, not client flag.
- Styled to match existing notification-banner patterns in the codebase. Placement: top of the home-page content area.

### Polling / updates

No persistent websocket subscription needed for SP2b. The banner reads state on mount and after Retry. Dep-panel UI already uses its own polling / updates for in-progress downloads. User watching the auto-install happen in real-time uses the dep panel; the banner is a one-shot "you need to retry" signal.

---

## 6. Retry API

### Endpoint

`POST /api/deps/retry-install` — added to `src/server/api/DependencyApi.ts`.

Request body: none. (The endpoint's intent is "re-run the first-run bootstrap." No parameters.)

Response (JSON):

```json
{
  "success": true,
  "installed": ["adb"],
  "stillMissing": [],
  "errors": {}
}
```

Fields:

- `success` — `true` if every managed dep is now in `UpToDate` or `UpdateAvailable` state. `false` if any are still in `Error` or `Unknown(installed=null)`.
- `installed` — names of deps that moved from not-installed to installed during this call.
- `stillMissing` — names of deps that are STILL `installed=null` after this call (likely still no network).
- `errors` — map of dep name to error message, for deps that transitioned to Error state during this call.

The response is always `200 OK` regardless of the `success` boolean — the banner interprets `success === false` as "keep showing the banner, possibly update its text to reflect the latest error."

### Implementation

```ts
handleRetryInstall = async (req, res) => {
    const before = new Map<string, DependencyInfo>();
    for (const info of this.manager.getAll()) {
        before.set(info.name, { ...info });
    }
    await this.manager.checkAll();
    await this.manager.autoInstallMissing();
    const after = this.manager.getAll();
    const installed: string[] = [];
    const stillMissing: string[] = [];
    const errors: Record<string, string> = {};
    for (const info of after) {
        const prev = before.get(info.name);
        if (prev?.installedVersion === null && info.installedVersion !== null) {
            installed.push(info.name);
        }
        if (info.installedVersion === null) {
            stillMissing.push(info.name);
        }
        if (info.status === DependencyStatus.Error && info.errorMessage) {
            errors[info.name] = info.errorMessage;
        }
    }
    const success = stillMissing.length === 0 && Object.keys(errors).length === 0;
    res.json({ success, installed, stillMissing, errors });
};
```

Concurrency: the endpoint does not guard against multiple concurrent clicks from the banner. `update()` internally serializes per-dep (only one update runs at a time for a given name because `info.status = Updating` happens early), but two simultaneous invocations of the endpoint could double-fire. Acceptable risk — worst case is one redundant download. A simple flag (`this.retryInProgress = true/false`) can prevent it if the UI doesn't disable the Retry button during the request, but the UI SHOULD disable the button during the request, so not defensive-coding this.

---

## 7. Error handling

| Scenario | Outcome |
|---|---|
| No internet at first boot | ADB `checkLatest` throws → status Error → auto-install skips → banner fires |
| Network flap during ADB download | `update('adb')` throws → status Error with errorMessage → banner fires |
| Disk full / permission denied on write | `update()` throws; errorMessage carries cause; banner generic, dep panel specific |
| User kills app mid-download | tmp files cleaned by existing `try/finally` in `update()`; installed stays null → next autoInstallMissing retries |
| Corrupted install (Node missing from both `dependencies/` and `seed/`) | Launcher fails hard with "Reinstall the app" message |
| User clicks Retry multiple times rapidly | UI should disable the button during the request; backend treats each call as independent checkAll+autoInstallMissing (idempotent) |
| ADB download succeeds but the binary is invalid (unlikely) | Next `checkInstalled` still returns null; autoInstallMissing would try again on next boot or retry |

---

## 8. Testing plan

### Unit tests (vitest)

1. **`dependencyManager.autoInstallMissing.test.ts`** — new file.
   - State: `{ node: installed=X, latest=X }` → skipped.
   - State: `{ adb: installed=null, latest=1.0 }` → `update('adb')` called.
   - State: `{ adb: installed=null, latest=null }` → skipped (offline case).
   - State: `{ adb: installed=1.0, latest=2.0 }` → skipped (update path, not install path).
   - Uses `vi.spyOn(mgr, 'update')` to assert called/not-called without actually running the downloader.

2. **`dependencyApi.retryInstall.test.ts`** — new file.
   - Stubs `mgr.checkAll` and `mgr.autoInstallMissing`, verifies endpoint invokes both in order.
   - Stubs final state to test the response-shape computation: installed list, stillMissing list, errors map, success boolean.
   - Verifies 200 response regardless of success boolean.

### Manual verification

- **Happy path:** delete `dependencies/adb/`, run `start.cmd`. Observe in log: `First-run: auto-installing adb`, then `Updated adb to X.Y.Z`. Dep-panel transitions through Checking → Updating → UpToDate.
- **Offline first run:** disable network adapter, delete `dependencies/adb/`, run launcher. Observe: log shows the checkLatest failure WARN, no auto-install fires, banner appears on home page.
- **Offline recovery:** re-enable network, click Retry banner button. Observe: banner shows "Retrying…", ADB installs, banner disappears, dep panel shows UpToDate.
- **Probe chain:** temporarily rename `dependencies/node/` to `dependencies/node.bak/`. Pre-place a test Node binary at `seed/node/node.exe`. Run launcher. Observe server starts successfully using the seed Node. Restore.
- **Corrupted install:** delete both `dependencies/node/` and `seed/node/` (or never create `seed/`). Run launcher. Observe hard-fail with instructive message.

### Launcher scripts

No unit tests (shell scripts). Manual verification only — same pattern as SP2 Task 2.

---

## 9. Implementation surface

### New files

- `src/app/client/FirstRunBanner.ts` — home-page banner component.
- `src/server/__tests__/dependencyManager.autoInstallMissing.test.ts` — unit tests.
- `src/server/__tests__/dependencyApi.retryInstall.test.ts` — unit tests.

### Modified files

- `src/server/DependencyManager.ts` — add `autoInstallMissing` method.
- `src/server/api/DependencyApi.ts` — add `handleRetryInstall` + `POST /api/deps/retry-install` route.
- `src/server/index.ts` — chain `autoInstallMissing` after `checkAll` in the startup kickoff.
- `start.cmd` — probe chain (dependencies → seed → fail).
- `start.sh` — analogous probe chain.
- Home-page mount (exact file determined during planning — likely `src/app/home.html` or an equivalent TypeScript mount point). Wire up `FirstRunBanner`.
- Home-page CSS — banner styling matching existing notification patterns.
- `CHANGELOG.md` — `Added` entries for auto-install + banner; `Changed` entries for launcher probe chain.

### Unchanged files

- `src/server/DependencyDefinitions.ts` — no definition changes; Option D continues to apply to `nodejs.checkLatest`.
- `src/server/NodePtyResolver.ts` — unchanged.
- `src/common/DependencyTypes.ts` — enum and shape unchanged; the `installed=null && latest=null` offline state is representable with existing `Status.Error` (+ errorMessage) or `Status.Unknown`.

---

## 10. Sequencing into SP3 and beyond

SP2b's deliverables are SP3 prerequisites in two specific ways:

1. **Seed path contract.** SP3's Velopack packaging script must place the bundled Node at `<installFolder>/current/seed/node/` (or at whatever final path SP3 settles on, but the launcher edits in SP2b will then need to match). SP2b writes `seed/node/` into the launchers; SP3 must honor it.
2. **Bundled-Node LTS version choice.** SP3 picks a concrete Node version at release time. SP2b assumes it will match the SP1b node-pty prebuilt matrix.

SP4 (Docker) does not consume SP2b — Docker has its own Node-baking strategy.

SP5 (docs) captures the install-and-first-run flow for the README.

---

## 11. Explicitly not-doing

- **No change to Option D's filter logic.** SP2's `nodejs.checkLatest` manifest gating continues to apply unchanged.
- **No new `DependencyInfo` fields.** Banner logic is computed from existing `status` + `installedVersion`.
- **No Windows service / systemd unit wiring.** That's SP3.
- **No splash screen, no separate bootstrap server.** Rejected during brainstorm (Q1 → Option A).
- **No progress bars in the banner.** Dep-panel already shows per-dep progress; banner is a coarse "something needs your attention" signal only.
- **No automatic reboots.** First-run auto-install does not call `requestRestart()`. In practice, the only dep with `requiresRestart: true` is Node — and Node is always present at first boot via the seed, so Node will never be the target of `autoInstallMissing`. ADB and scrcpy-server have `requiresRestart: false`, so they can safely install without a restart.
