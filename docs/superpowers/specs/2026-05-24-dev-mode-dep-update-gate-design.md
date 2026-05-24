# Dev-mode dep update gate + installNodejs rollback

**Status:** Design approved 2026-05-24 via brainstorming session.
**Targets:** post-v0.1.25-beta.40, before the next stable cut.
**Scope:** Two bug fixes shipped together. Both surfaced during dev-mode testing after commit `92f8c2a` (`fix(config): align Windows dev resolveDependenciesPath with launcher`, 2026-05-14) made the in-app dep updater reachable in dev mode without making it work for launcher-gated extract paths.

---

## Background

### Bug #1 — dev-mode dep update trigger trap

User clicks "Update Node" in Settings while running the dev server (`npm start`). The server logs:

```
[DependencyManager] ERROR Update nodejs failed: extractZip requires the packaged launcher binary at C:\Users\jscha\source\repos\ws-scrcpy-web\ws-scrcpy-web-launcher.exe. Dev mode should populate dependencies/ via scripts/fetch-node.mjs (Node) or by pre-seeding from a prior install; the dependency-manager's autoInstall extractZip path is intended for Velopack-installed deployments only.
```

Root cause: `DependencyManager.extractZip` (`src/server/DependencyManager.ts:418-425`) requires the Rust launcher at `<cwd>/ws-scrcpy-web-launcher.exe` for its `--unzip` subcommand. In dev that path is the repo root, where no compiled launcher exists. `launcherIsAvailable()` returns false; `extractZip` throws.

Before commit `92f8c2a`, the dev `dependencies/` path was different from the deployed one, so `DependencyManager.checkInstalled('nodejs')` returned null in dev and the updater never reported `UpdateAvailable`. After the alignment, dev mirrors deployed at `<dataRoot>/dependencies/node/node.exe`, so the updater sees a stale Node, offers Update, and crashes on click.

### Bug #2 — `installNodejs` lacks rollback on failure

`installNodejs` (`src/server/DependencyManager.ts:322-367`) renames `node.exe` -> `node.exe.old` BEFORE calling the throwing `extractZip`. The catch block in `update()` re-throws — no rollback path. After the failed update: `node.exe.old` exists, `node.exe` does not.

On the next dev server start:

1. `checkInstalled('nodejs')` runs `node.exe --version` — file does not exist — returns null.
2. `installedVersion === null` -> status `Unknown`.
3. `autoInstallMissing()` (`DependencyManager.ts:209-214`) fires because `installedVersion === null && latestVersion !== null`.
4. Calls `update('nodejs')` -> same `extractZip` throw -> status `Error`.
5. Restart loop: every dev startup re-attempts and re-fails.

The rollback gap is also reachable in production (deployed) on any extract/copy failure mode: network-zip-corrupt, disk-full, antivirus quarantine, malformed archive. Production users would be left with no `node.exe` and a service that cannot restart.

### Why fix both together

Bug #1 prevents the dev-mode trigger of the rename-before-extract code path. But Bug #2 is reachable in production via any other failure mode in `extractZip` or `copyDirContents`. A failed Node update on a real user's machine that leaves them with no Node is a P0. Per CLAUDE.md no-accepted-tech-debt + `feedback_no_low_priority_on_packaging_paths.md`, this is release-gating tech.

---

## Goals

1. In dev mode, the dep panel accurately shows which deps can be updated in-app (per-dep `canUpdate`). Deps that need the launcher are surfaced as a disabled button with a tooltip pointing at the dev-mode workaround (`scripts/fetch-node.mjs`).
2. `POST /api/dependencies/:name/update` returns a clean 503 with a typed `reason: 'launcher-required'` when a launcher-required dep is requested in dev. The endpoint never enters the destructive install path in that case.
3. `installNodejs` is robust: either the new files are in place after the call, OR the previous `node.exe` is intact. The window where neither holds is reduced to "copy fails mid-operation" with a best-effort rollback.
4. The dev-mode restart loop (`autoInstallMissing` re-fires the failing update on every startup) cannot occur — `autoInstallMissing` skips launcher-required deps when the launcher is unavailable.

## Non-goals (YAGNI)

- Pure-JS extract fallback for dev mode (rejected option B — two code paths, masks production bugs).
- Building the Rust launcher into dev startup (rejected option D — slow startup, Rust prerequisite for all devs).
- Extending `scripts/fetch-node.mjs` to populate `<dataRoot>/dependencies/` directly (rejected option C — UX worse than option A, plus A's gate is wanted regardless).
- Refactoring `installAdb` (uses the same `extractZip` path but is not the reported failure; separate TODO if/when triaged).
- Cleaning up stale `node.exe.old` files after successful updates (separate TODO).
- Changes to the Velopack/installed update flow.
- Frontend testing harness for `DependencyPanel.actionButton` — manual smoke check covers the 3-line conditional.

---

## Design

### Data model

**`DependencyDefinition`** (`src/server/DependencyDefinitions.ts`) — one new field:

```ts
export interface DependencyDefinition {
    name: string;
    displayName: string;
    description: string;
    requiresRestart: boolean;
    pairedWith?: string;
    requiresLauncher: boolean;       // NEW
    checkInstalled: (depsPath: string) => Promise<string | null>;
    checkLatest: () => Promise<string | null>;
    getDownloadUrl: (version: string) => string;
}
```

Values per dep:

| Dep | `requiresLauncher` | Why |
| --- | --- | --- |
| `nodejs` | `true` | Uses `extractZip` (launcher `--unzip`) |
| `adb` | `true` | Uses `extractZip` (launcher `--unzip`) |
| `scrcpy-server` | `false` | Single-file `fs.copyFileSync` only |

**`DependencyInfo`** (`src/common/DependencyTypes.ts`) — one new field:

```ts
export interface DependencyInfo {
    name: string;
    displayName: string;
    installedVersion: string | null;
    latestVersion: string | null;
    status: DependencyStatus;
    description: string;
    requiresRestart: boolean;
    pairedWith?: string;
    errorMessage?: string;
    canUpdate: boolean;              // NEW — computed each getAll() call
}
```

`canUpdate` is computed (not persisted state) — recalculated on every `getAll()` so a launcher that appears mid-session (e.g., dev manually copies it in) is reflected immediately.

**`UpdateResult`** (`src/common/DependencyTypes.ts`) — one new optional field:

```ts
export interface UpdateResult {
    success: boolean;
    newVersion?: string;
    errorMessage?: string;
    requiresRestart: boolean;
    reason?: 'launcher-required';    // NEW
}
```

Typed instead of stringly — easier to extend with more refusal reasons later (e.g., `'offline'`, `'concurrent-update'`).

No new API endpoints. No shape changes to existing endpoints beyond the added fields.

### Server-side changes

#### `src/server/DependencyDefinitions.ts`

Add `requiresLauncher: true` to nodejs and adb definitions; `requiresLauncher: false` to scrcpy-server. No other changes.

#### `src/server/DependencyManager.ts`

**`getAll()`** — recompute `canUpdate` on each call:

```ts
public getAll(): DependencyInfo[] {
    const launcherAvail = launcherIsAvailable();
    return Array.from(this.state.values()).map((info) => {
        const def = this.definitions.find((d) => d.name === info.name);
        return { ...info, canUpdate: !def?.requiresLauncher || launcherAvail };
    });
}
```

**`update(name)`** — early bail when launcher unavailable for a `requiresLauncher` dep. New guard at the top, before any state mutation:

```ts
public async update(name: string): Promise<UpdateResult> {
    const def = this.definitions.find((d) => d.name === name);
    const info = this.state.get(name);
    if (!def || !info) {
        return { success: false, errorMessage: `Unknown dependency: ${name}`, requiresRestart: false };
    }
    if (def.requiresLauncher && !launcherIsAvailable()) {
        return {
            success: false,
            reason: 'launcher-required',
            errorMessage:
                `${def.displayName} updates require an installed build. ` +
                `In dev mode, populate dependencies/ via scripts/fetch-node.mjs.`,
            requiresRestart: false,
        };
    }
    // ... existing body unchanged
}
```

Status stays `UpdateAvailable` (no transition through `Updating` -> `Error`). The dep panel sees a clean refusal and remains in its current state.

**`autoInstallMissing()`** — skip launcher-required deps when launcher unavailable. Prevents the dev-mode restart loop:

```ts
public async autoInstallMissing(): Promise<void> {
    try {
        this.promoteSeedScrcpyServer();
    } catch (err) {
        log.warn(`seed-promote scrcpy-server failed: ${(err as Error).message}`);
    }

    const launcherAvail = launcherIsAvailable();
    for (const info of this.state.values()) {
        if (info.installedVersion === null && info.latestVersion !== null) {
            const def = this.definitions.find((d) => d.name === info.name);
            if (def?.requiresLauncher && !launcherAvail) {
                log.info(`Skipping auto-install of ${info.name} in dev mode (no launcher)`);
                continue;
            }
            log.info(`First-run: auto-installing ${info.name}`);
            await this.update(info.name);
        }
    }
}
```

#### `src/server/api/DependencyApi.ts`

`POST /:name/update` returns 503 specifically when the guard fires (typed by `result.reason`):

```ts
if (req.method === 'POST' && updateMatch) {
    const name = updateMatch[1]!;
    const result = await this.manager.update(name);
    if (result.reason === 'launcher-required') {
        res.writeHead(503);
    } else {
        res.writeHead(result.success ? 200 : 500);
    }
    res.end(JSON.stringify(result));
    return true;
}
```

Other endpoints (`GET /api/dependencies`, `POST /check`, `POST /restart`, `POST /retry-install`) require no changes — they return whatever `getAll()` produces, which now includes `canUpdate`.

### Frontend changes

**`src/app/client/DependencyPanel.ts`** — `actionButton()` (lines 218-226) gains a gated case:

```ts
private actionButton(dep: DependencyInfo): string {
    if (dep.status === 'update-available') {
        if (!dep.canUpdate) {
            const tooltip = 'In-app updates require an installed build. ' +
                'In dev mode, populate dependencies/ via scripts/fetch-node.mjs.';
            return `<button class="dep-btn dep-update" disabled title="${tooltip}">` +
                `update (dev)</button>`;
        }
        return `<button class="dep-btn dep-update" data-update="${dep.name}">update</button>`;
    }
    if (dep.status === 'updating') {
        return '<button class="dep-btn" disabled>updating...</button>';
    }
    return '';
}
```

Two changes alongside the gate, both within `feedback_ui_color_scheme.md` ("lowercase text"):

- Button labels lowercased (`update`, `updating...`) — minor consistency drift on lines already touched.
- Disabled variant keeps the `dep-update` class so it inherits the warn-state styling; `disabled` attribute provides the visual cue via the browser default.

No click-handler change required. The 503 path is unreachable from the disabled button; it remains as belt-and-suspenders for direct API calls (e.g., during integration testing).

Status badge unchanged. "Update available" still displays — accurate info; only the action is gated.

### `installNodejs` rollback (Bug #2)

**`src/server/DependencyManager.ts:322-367`** — reorder: extract first, then rename + copy with tight rollback.

```ts
private async installNodejs(
    downloadPath: string,
    _version: string,
    tmpDir: string,
    platform: 'win32' | 'linux',
): Promise<void> {
    const destDir = path.join(this.depsPath, 'node');
    fs.mkdirSync(destDir, { recursive: true });

    // 1. Non-destructive: extract to tmpDir (both platforms).
    if (platform === 'win32') {
        await this.extractZip(downloadPath, tmpDir, platform);
    } else {
        await execFileAsync('tar', ['xzf', downloadPath, '-C', tmpDir]);
    }
    const archiveDir = fs.readdirSync(tmpDir).find((d) => d.startsWith('node-v'));
    if (!archiveDir) {
        throw new Error('Could not find Node.js directory in extracted archive');
    }
    const extractedPath = path.join(tmpDir, archiveDir);

    // 2. Destructive (Windows only): rename + copy with rollback.
    if (platform === 'win32') {
        const runningExe = path.join(destDir, 'node.exe');
        const oldExe = path.join(destDir, 'node.exe.old');
        let renamed = false;
        if (fs.existsSync(runningExe)) {
            try {
                fs.renameSync(runningExe, oldExe);
                renamed = true;
            } catch {
                // May fail if not the managed node — proceed without rollback safety net.
            }
        }
        try {
            this.copyDirContents(extractedPath, destDir);
        } catch (err) {
            if (renamed && !fs.existsSync(runningExe)) {
                try {
                    fs.renameSync(oldExe, runningExe);
                } catch {
                    // Best-effort rollback. Original error bubbles up regardless.
                }
            }
            throw err;
        }
    } else {
        this.copyDirContents(extractedPath, destDir);
    }
}
```

**Key invariants:**

- Extract failure -> destDir untouched (rename hadn't happened yet) -> next start sees prior `node.exe` and reports prior version.
- Copy failure -> tight rollback restores `.old` -> `.exe`. Best-effort; if rollback itself fails, original error bubbles up so the user sees what really went wrong.
- Successful path -> new files in destDir, `node.exe.old` lingers (current behavior, deferred cleanup).
- The early-return guard from `update()` means this function never runs in dev. Bug #2 rollback is belt-and-suspenders for production failure modes (network-zip-corrupt, disk-full, AV-quarantine, malformed archive, mid-copy fault).

---

## Testing

### Test plan

| Test file | Status | Adds |
| --- | --- | --- |
| `dependencyDefinitions.test.ts` | existing | 1 test: each definition has correct `requiresLauncher` value |
| `dependencyManager.test.ts` | existing | 2 tests: `getAll()` returns `canUpdate` correctly per launcher availability and per dep |
| `dependencyManager.update.test.ts` | existing | 2 tests: nodejs early-bails with `reason: 'launcher-required'`; scrcpy-server succeeds without launcher. Plus install-rollback tests (see below). Existing test fixtures gain `requiresLauncher` field. |
| `dependencyManager.autoInstallMissing.test.ts` | existing | 1 test: skip-and-log path for `requiresLauncher && !launcherIsAvailable` |
| `dependencyApi.update.test.ts` | NEW | 2 tests: nodejs POST returns 503 + reason; scrcpy-server POST returns 200 without launcher |

### `installNodejs` rollback tests

Added to `dependencyManager.update.test.ts` (or a new `dependencyManager.installNodejs.test.ts` if size warrants). Real tempdir + fs (no memfs) — small surface, easier than mocking layered `fs` calls.

| Scenario | Expectation |
| --- | --- |
| Win32 extract failure | destDir state unchanged: original `node.exe` intact, no `node.exe.old` |
| Win32 copy failure | `node.exe` restored from `.old` rollback; original error bubbles |
| Win32 full success | new `node.exe`; `node.exe.old` lingers (current behavior, separate-cleanup non-goal) |
| Linux extract failure | destDir state unchanged |

Launcher-availability toggle: `vi.mock('../service/elevatedRunner', ...)` — same pattern as existing `UpdatesApi.test.ts` mocks `UpdateService`.

### Baseline

Current `npm test`: 695/695. Target post-implementation: ~702-705. No existing tests regress; fixture adaptations add fields but do not change behavior assertions.

### Manual smoke

After implementation:

1. **Recovery from current broken state:** rename `C:\ProgramData\WsScrcpyWeb\dependencies\node\node.exe.old` -> `node.exe` (or use Mode A reinstall on a clean VM).
2. **Dev mode (npm start):** dep panel shows "update available" for nodejs and adb with the disabled "update (dev)" button + tooltip. scrcpy-server's "update" button remains enabled.
3. **POST to API directly** (`curl` or DevTools) for nodejs/update in dev: 503 + body `{"success":false,"reason":"launcher-required","errorMessage":"Node.js updates require an installed build. In dev mode, populate dependencies/ via scripts/fetch-node.mjs.","requiresRestart":false}`.
4. **Restart dev server** with node.exe missing: no `autoInstallMissing` -> `update` loop. Log line `Skipping auto-install of nodejs in dev mode (no launcher)` appears.
5. **Deployed mode (VM Mode A install):** all three deps show enabled "update" buttons. Clicking nodejs update goes through the new install path; rollback path is exercised only on injected failure.

---

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| `launcherIsAvailable()` returns false during a deployed-mode launch race where the file is briefly missing | Recompute per `getAll()` call; transient false reads correct themselves on the next status poll. The `update()` re-check at call time catches stale `canUpdate`. |
| Frontend caches the `canUpdate` field across polls | `DependencyPanel.refresh()` re-fetches `/api/dependencies` on each check-for-updates click; no client-side state survives. |
| Stringly-typed `errorMessage` substring matching breaks if message wording drifts | Switched to typed `reason: 'launcher-required'` field; API check is `result.reason === 'launcher-required'`, immune to wording changes. |
| Rollback fails too (rename `.old` -> `.exe` throws) | Best-effort; original error still throws to the caller, status -> `Error`, user sees the original failure with no silent masking. |
| Win32 `fs.renameSync` semantics under AV scanner holding the file open | Existing code already handled this with `try/catch` around the rename; we preserve that pattern. |

---

## Implementation order (suggested phasing for plan)

1. **Types first** (`common/DependencyTypes.ts`) — add `canUpdate`, `reason`. Cheap, enables typed callsites downstream.
2. **Definitions** (`DependencyDefinitions.ts`) — add `requiresLauncher` per dep. Update existing definition tests.
3. **Manager — `getAll()` + `update()` guard + `autoInstallMissing()` skip** (`DependencyManager.ts`). Update existing manager tests.
4. **Rollback fix** in `installNodejs` (`DependencyManager.ts`). Add rollback tests.
5. **API** (`DependencyApi.ts`) — 503 branch. New `dependencyApi.update.test.ts` file.
6. **Frontend** (`DependencyPanel.ts`) — gated action button + lowercase labels.
7. **Manual smoke** — dev mode + deployed mode + direct API path.
8. **CHANGELOG.md** entry + version bump (post-plan, separate PR or bundled).

Each phase is independently testable; the order above means tests pass at every commit boundary.

---

## Out of scope (explicit deferrals — surface as separate TODOs)

- Cleanup of stale `node.exe.old` after successful Node updates.
- `installAdb` rollback parity with `installNodejs` (uses `extractZip` but isn't the reported failure; same pattern would apply if triaged).
- Linux equivalent of the dev-mode `dependencies/` alignment that triggered Bug #1 (separate item `§19 v0.5.0 Linux Phase-1-equivalent dataRoot` in `todo_ws_scrcpy_web.md`).
- Tighter ACL on `<dataRoot>/dependencies/` (separate item `§1d`).
- Pure-JS extract fallback (rejected option B).
