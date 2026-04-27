# SP3 P5 — Update Flow: Lead Contracts

**Branch:** `sp3-p5-update-flow` (off `main` at `a6dfa49`)
**Authored:** 2026-04-27 (lead reality-check + Velopack JS SDK research before agent dispatch)
**Reads with:** `docs/specs/2026-04-26-sp3-velopack-installer.md` § Update flow API + § Velopack feed URL + § Dev-mode handling + § UI section B (header button) + § UI section E (Settings Updates), `docs/plans/2026-04-26-sp3-velopack-installer.md` § P5.

## Velopack JS SDK reality check

Confirmed by reading `node_modules/velopack/lib/index.d.ts` + `index.js` (pinned at `^0.0.1589-ga2c5a97`):

```typescript
class UpdateManager {
    constructor(urlOrPath: string, options?: UpdateOptions, locator?: VelopackLocatorConfig);
    getCurrentVersion(): string;
    getAppId(): string;
    isPortable(): boolean;
    getUpdatePendingRestart(): VelopackAsset | null;
    checkForUpdatesAsync(): Promise<UpdateInfo | null>;
    downloadUpdateAsync(update: UpdateInfo, progress?: (perc: number) => void): Promise<void>;
    waitExitThenApplyUpdate(update: UpdateInfo | VelopackAsset, silent?: boolean, restart?: boolean, restartArgs?: string[]): void;
}

interface UpdateOptions {
    AllowVersionDowngrade: boolean;
    ExplicitChannel?: string;
    MaximumDeltasBeforeFallback: number;
}

interface UpdateInfo {
    TargetFullRelease: VelopackAsset;
    BaseRelease?: VelopackAsset;
    DeltasToTarget: VelopackAsset[];
    IsDowngrade: boolean;
}

interface VelopackAsset {
    PackageId, Version, Type, FileName, SHA1, SHA256, Size, NotesMarkdown, NotesHtml: string | number;
}
```

**Spec deviation:** `UpdateManager.isInstalled()` (referenced in spec § Dev-mode handling line 196) **does NOT exist on this version of the JS SDK**. We use a custom heuristic — see decision 1 below.

## Architectural decisions (locked by user 2026-04-27)

1. **Dev-mode detection: `sq.version` file presence check, with construction-error fallback.**
   - Primary: `fs.existsSync(path.join(installRoot, 'sq.version'))` — Velopack's own install marker file.
   - Fallback: wrap `new UpdateManager(...)` in try/catch; treat construction failure as dev mode.
   - Both signals must agree before we declare "installed." If sq.version exists but UpdateManager throws, treat as dev mode + log a warning (probably a corrupted install).

2. **Auto-download semantics: `autoUpdate=true` gates auto-download only.** The Apply step is **always user-clicked**. We never restart the server unsolicited. When `autoUpdate=true` and timer/manual check finds an update, backend downloads automatically and surfaces "ready" state. User clicks Apply to trigger the swap+restart.

3. **Progress reporting transport: polling via `/api/updates/status`.** Backend `UpdateService` stashes latest progress percentage in memory (Cell-style); `/status` returns it during the `downloading` state. No WebSocket push for P5; can be added later if polling lag becomes a UX issue.

4. **Apply flow:** `waitExitThenApplyUpdate(update, silent=true, restart=true)`. Always. Service mode relies on Servy/systemd auto-restart; non-service mode relies on Velopack's built-in relaunch.

5. **State machine ownership: backend is source of truth.** UpdateService holds the canonical state (`status: 'idle' | 'checking' | 'downloading' | 'ready' | 'error'`, `progress?: number`, `availableVersion?: string`, `errorMessage?: string`, etc.). Frontend renders from `/api/updates/status` polls — does NOT derive state by counting events or storing locally. Reduces drift on multi-tab + reload.

6. **Lead-side smoke: unit tests + static checks only.** No live update-flow test from lead — that requires Velopack-built v0.1.0 + v0.1.1 artifacts in a local feed (deferred to SP3-close). UpdateService tests use DI to inject a fake UpdateManager.

7. **Channel/owner re-init: immediate auto-check on change, even with invalid values.** PATCH `/api/updates/config` accepts whatever the user enters. UpdateService re-creates its internal UpdateManager with the new feed URL/channel. An immediate check runs; if it fails (404 from a fork that doesn't exist, malformed URL, etc.), the response includes the error and the status flips to `error`. **The PATCH does not reject invalid values** — user keeps whatever they entered, sees the error feedback, can fix or leave as-is.

8. **No new dependencies.** `velopack` is already pinned + imported via `VelopackApp.build().run()` in `src/server/index.ts` from P2.

## API contract — `/api/updates/*`

### Status response shape (canonical, returned by GET /status)

```typescript
type UpdateState =
    | 'idle'         // no update available; checked successfully OR not yet checked
    | 'checking'     // checkForUpdatesAsync in flight
    | 'downloading'  // downloadUpdateAsync in flight; progress 0..100
    | 'ready'        // download complete; awaiting user Apply click
    | 'error';       // last operation failed; errorMessage populated

interface UpdatesStatusResponse {
    /** Whether the app is in installed mode (sq.version present + UpdateManager constructible). */
    isInstalled: boolean;
    /** Currently running version. Empty string in dev mode. */
    currentVersion: string;
    /** Version of the available update (when status='ready' or 'downloading'). */
    availableVersion?: string;
    /** Current state machine position. */
    status: UpdateState;
    /** Download progress 0..100 when status='downloading'. */
    progress?: number;
    /** Last error message when status='error'. */
    errorMessage?: string;
    /** Last successful check timestamp (ISO string). */
    lastCheckedAt?: string;
    /** Mirrored from config.json for UI convenience. */
    autoUpdate: boolean;
    channel: 'stable' | 'beta';
    githubOwner: string;
    updateCheckIntervalMinutes: number;
}
```

### Endpoints

| Endpoint | Method | Body | Response |
|---|---|---|---|
| `/api/updates/status` | GET | — | `UpdatesStatusResponse`, HTTP 200 always (dev mode → `isInstalled: false, status: 'idle'`) |
| `/api/updates/check` | POST | — | `UpdatesStatusResponse` after the check completes. HTTP 200 on success/no-update, 200 with `status: 'error'` on check failure (errors aren't 5xx, they're state). HTTP 503 if `isInstalled=false`. |
| `/api/updates/apply` | POST | — | `{ ok: true }` HTTP 200, then server exits 0 within ~100ms (fire-and-forget pattern from ServerShutdownApi). HTTP 409 if `status !== 'ready'`. HTTP 503 if `isInstalled=false`. |
| `/api/updates/config` | PATCH | `{ autoUpdate?, channel?, githubOwner?, updateCheckIntervalMinutes? }` (all optional) | `{ config: ..., status: UpdatesStatusResponse }`. HTTP 200 always (invalid values accepted per decision 7). On channel/owner change, triggers immediate UpdateService.reconfigure + check; on interval change, restarts the timer. |

### Dev-mode behavior

When `isInstalled=false`:
- `/status` returns `{ isInstalled: false, currentVersion: '', status: 'idle', ... config mirror }`. No errors.
- `/check` returns 503 `{ ok: false, error: 'dev mode — packaging features disabled' }`.
- `/apply` returns 503 same shape.
- `/config` PATCH still works (writes to config.json), but doesn't try to re-init UpdateManager. Just updates the persisted values for when the app is next built+installed.
- Background timer never starts.

## UpdateService design

**File:** `src/server/UpdateService.ts` (new)

Singleton-style class (one instance owned by `src/server/index.ts`, similar to existing services). Constructor takes injectables for testability.

```typescript
import type { UpdateManager, UpdateInfo, VelopackAsset, UpdateOptions } from 'velopack';

export interface UpdateServiceOptions {
    /** Override the install-root path used for sq.version detection. Default: dirname(process.execPath). */
    installRoot?: string;
    /** Override the UpdateManager constructor for tests. Default: real velopack import. */
    updateManagerFactory?: (feedUrl: string, opts: UpdateOptions) => UpdateManager;
    /** Override the feed URL builder for tests / VELOPACK_FEED_URL env override. */
    feedUrlOverride?: string;
    /** Override fs.existsSync for tests. */
    existsSync?: (p: string) => boolean;
}

export interface UpdateServiceState {
    isInstalled: boolean;
    currentVersion: string;
    status: UpdateState;
    progress?: number;
    availableVersion?: string;
    errorMessage?: string;
    lastCheckedAt?: Date;
    /** Internal: the UpdateInfo we got from checkForUpdatesAsync, kept until apply. */
    pendingUpdate?: UpdateInfo;
}

export class UpdateService {
    private mgr: UpdateManager | null = null;
    private state: UpdateServiceState;
    private timer: NodeJS.Timeout | null = null;
    private readonly opts: Required<UpdateServiceOptions>;

    constructor(opts: UpdateServiceOptions = {}) { /* ... */ }

    /** Build feed URL from current config.githubOwner. */
    private buildFeedUrl(githubOwner: string): string {
        return process.env['VELOPACK_FEED_URL']
            ?? this.opts.feedUrlOverride
            ?? `https://github.com/${githubOwner}/ws-scrcpy-web/releases/latest/download/`;
    }

    /** Initial setup: detect install mode, build mgr if installed, start timer if installed + autoUpdate. */
    public init(): void { /* ... */ }

    /** Re-create the internal mgr with new channel/owner. Triggers an immediate check. */
    public async reconfigure(channel: 'stable' | 'beta', githubOwner: string): Promise<void> { /* ... */ }

    /** Manual + auto-triggered check. Updates this.state. */
    public async checkForUpdates(): Promise<UpdateServiceState> { /* ... */ }

    /** Download the pending update if status='ready' isn't already met. Updates progress. */
    public async downloadIfNeeded(): Promise<void> { /* ... */ }

    /** Apply the pending update — server exits 0 after this returns. */
    public applyUpdate(): void { /* ... */ }

    /** Restart the background timer with current updateCheckIntervalMinutes. */
    public restartTimer(intervalMinutes: number, autoUpdate: boolean): void { /* ... */ }

    /** Snapshot state for the API response. */
    public getStatus(): UpdateServiceState { /* ... */ }
}
```

### Init flow

```typescript
init(): void {
    const installRoot = this.opts.installRoot ?? path.dirname(process.execPath);
    const sqVersionPath = path.join(installRoot, 'sq.version');
    const sqExists = this.opts.existsSync(sqVersionPath);

    if (!sqExists) {
        this.state = { isInstalled: false, currentVersion: '', status: 'idle' };
        log.info('UpdateService: dev mode (sq.version not found at install root)');
        return;
    }

    // sq.version present — try to construct the manager.
    try {
        const cfg = Config.getInstance().getAppConfig();
        const feedUrl = this.buildFeedUrl(cfg.githubOwner);
        this.mgr = this.opts.updateManagerFactory(feedUrl, {
            ExplicitChannel: cfg.channel,
            AllowVersionDowngrade: false,
            MaximumDeltasBeforeFallback: 10,
        });
        const currentVersion = this.mgr.getCurrentVersion();
        this.state = { isInstalled: true, currentVersion, status: 'idle' };
        log.info(`UpdateService: initialized for v${currentVersion} on ${cfg.channel} channel`);

        // Schedule background timer.
        this.restartTimer(cfg.updateCheckIntervalMinutes, cfg.autoUpdate);
        // Fire one immediate check on startup.
        void this.checkForUpdates().then(() => {
            if (cfg.autoUpdate && this.state.status === 'ready') {
                // Don't auto-apply per decision 2 — just leave it ready.
            }
        });
    } catch (err) {
        // sq.version present but mgr construction threw — corrupted install or SDK bug.
        log.warn(`UpdateService: sq.version exists but UpdateManager construction failed: ${(err as Error).message}. Treating as dev mode.`);
        this.state = { isInstalled: false, currentVersion: '', status: 'idle' };
    }
}
```

### checkForUpdates flow

```typescript
async checkForUpdates(): Promise<UpdateServiceState> {
    if (!this.mgr) {
        this.state = { ...this.state, status: 'idle' };
        return this.state;
    }

    this.state.status = 'checking';
    try {
        const info = await this.mgr.checkForUpdatesAsync();
        this.state.lastCheckedAt = new Date();
        if (info === null) {
            this.state.status = 'idle';
            this.state.availableVersion = undefined;
            this.state.pendingUpdate = undefined;
            return this.state;
        }

        this.state.availableVersion = info.TargetFullRelease.Version;
        this.state.pendingUpdate = info;

        const cfg = Config.getInstance().getAppConfig();
        if (cfg.autoUpdate) {
            await this.downloadIfNeeded();
        } else {
            // autoUpdate disabled: surface "available" via status='ready' but no download yet.
            // Decision: treat available-but-not-downloaded as 'ready' too. Apply will trigger
            // download-then-apply in one go (waitExitThenApplyUpdate handles undownloaded updates internally).
            // Keeps the state machine 5-valued instead of 6-valued.
            this.state.status = 'ready';
        }
    } catch (err) {
        this.state.status = 'error';
        this.state.errorMessage = (err as Error).message ?? 'check failed';
        log.warn(`UpdateService: check failed: ${this.state.errorMessage}`);
    }
    return this.state;
}
```

### downloadIfNeeded flow

```typescript
async downloadIfNeeded(): Promise<void> {
    if (!this.mgr || !this.state.pendingUpdate) return;
    if (this.state.status === 'downloading') return; // already in flight

    this.state.status = 'downloading';
    this.state.progress = 0;
    try {
        await this.mgr.downloadUpdateAsync(this.state.pendingUpdate, (perc) => {
            this.state.progress = Math.min(100, Math.max(0, Math.round(perc)));
        });
        this.state.progress = 100;
        this.state.status = 'ready';
    } catch (err) {
        this.state.status = 'error';
        this.state.errorMessage = (err as Error).message ?? 'download failed';
        log.warn(`UpdateService: download failed: ${this.state.errorMessage}`);
    }
}
```

### applyUpdate flow

```typescript
applyUpdate(): void {
    if (!this.mgr || !this.state.pendingUpdate || this.state.status !== 'ready') {
        throw new Error(`apply not allowed in current state: ${this.state.status}`);
    }
    log.info(`UpdateService: applying update v${this.state.availableVersion}`);
    // silent=true (no UI from Velopack updater), restart=true (Velopack relaunches us).
    this.mgr.waitExitThenApplyUpdate(this.state.pendingUpdate, true, true);
    // Caller (UpdatesApi.handleApply) is responsible for the deferred process.exit(0).
}
```

### reconfigure flow

```typescript
async reconfigure(channel: 'stable' | 'beta', githubOwner: string): Promise<void> {
    if (!this.state.isInstalled) {
        // Dev mode — config persisted by caller, but no UpdateManager to swap.
        return;
    }
    const feedUrl = this.buildFeedUrl(githubOwner);
    try {
        this.mgr = this.opts.updateManagerFactory(feedUrl, {
            ExplicitChannel: channel,
            AllowVersionDowngrade: false,
            MaximumDeltasBeforeFallback: 10,
        });
        // Reset state and run an immediate check.
        this.state.pendingUpdate = undefined;
        this.state.availableVersion = undefined;
        this.state.errorMessage = undefined;
        this.state.status = 'idle';
        await this.checkForUpdates();
    } catch (err) {
        // Construction failed — keep old mgr if any, surface error in state.
        this.state.status = 'error';
        this.state.errorMessage = `reconfigure failed: ${(err as Error).message}`;
        log.warn(`UpdateService: reconfigure failed (keeping previous mgr): ${this.state.errorMessage}`);
    }
}
```

### Timer

```typescript
restartTimer(intervalMinutes: number, autoUpdate: boolean): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.state.isInstalled) return;
    if (intervalMinutes <= 0) return;
    const ms = intervalMinutes * 60 * 1000;
    this.timer = setInterval(() => {
        void this.checkForUpdates();
    }, ms);
}
```

Note: timer fires every `intervalMinutes` even if `autoUpdate=false`. The check still runs (so UI sees "available"); only auto-download is gated by `autoUpdate`. The init flow already schedules an immediate check on startup separate from the timer.

## UpdatesApi handlers

**File:** `src/server/api/UpdatesApi.ts` (new). Mirror existing API patterns (ConfigApi for PATCH body parsing, ServerShutdownApi for the deferred exit).

```typescript
import type { IncomingMessage, ServerResponse } from 'http';
import { Logger } from '../Logger';
import { Config } from '../Config';
import type { UpdateService } from '../UpdateService';

const log = Logger.for('UpdatesApi');

export class UpdatesApi {
    constructor(private readonly svc: UpdateService) {}

    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const url = req.url || '';
        if (!url.startsWith('/api/updates/')) return false;
        res.setHeader('Content-Type', 'application/json');

        try {
            if (req.method === 'GET' && url === '/api/updates/status') return await this.handleStatus(res);
            if (req.method === 'POST' && url === '/api/updates/check') return await this.handleCheck(res);
            if (req.method === 'POST' && url === '/api/updates/apply') return await this.handleApply(res);
            if (req.method === 'PATCH' && url === '/api/updates/config') return await this.handleConfig(req, res);

            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Not found' }));
            return true;
        } catch (err) {
            log.error(`${req.method} ${req.url} threw: ${(err as Error).message}`);
            res.writeHead(500);
            res.end(JSON.stringify({ error: (err as Error).message }));
            return true;
        }
    }

    private buildStatusResponse(): UpdatesStatusResponse {
        const cfg = Config.getInstance().getAppConfig();
        const s = this.svc.getStatus();
        return {
            isInstalled: s.isInstalled,
            currentVersion: s.currentVersion,
            availableVersion: s.availableVersion,
            status: s.status,
            progress: s.progress,
            errorMessage: s.errorMessage,
            lastCheckedAt: s.lastCheckedAt?.toISOString(),
            autoUpdate: cfg.autoUpdate,
            channel: cfg.channel,
            githubOwner: cfg.githubOwner,
            updateCheckIntervalMinutes: cfg.updateCheckIntervalMinutes,
        };
    }

    // ... handleStatus, handleCheck, handleApply, handleConfig ...
}
```

`handleApply` mirrors ServerShutdownApi's deferred-exit pattern: call `svc.applyUpdate()`, write 200 + `{ok:true}`, then `setTimeout(() => process.exit(0), 100)`. Apply triggers `waitExitThenApplyUpdate` which schedules Velopack to swap on exit.

`handleConfig` reads JSON body via the same `readJsonBody` helper P4b added (live in ServiceApi.ts). Validates loosely:
- `autoUpdate`: boolean
- `channel`: 'stable' | 'beta' (anything else → 400)
- `githubOwner`: string (any non-empty string accepted, even invalid GH usernames per decision 7)
- `updateCheckIntervalMinutes`: integer ≥ 5 (per spec § E line 339), ≤ 1440

On successful PATCH, persists via `Config.updateAppConfig({...})`. Then:
- If `channel` or `githubOwner` changed: `await svc.reconfigure(newChannel, newOwner)` (which fires immediate check; errors land in state).
- If `updateCheckIntervalMinutes` changed: `svc.restartTimer(newInterval, currentAutoUpdate)`.
- If only `autoUpdate` changed: just persist; no UpdateService call needed (timer keeps running, next check honors new autoUpdate flag).

Returns the latest status.

## Wiring in `src/server/index.ts`

```typescript
// Add near other service singletons:
const updateService = new UpdateService();
updateService.init(); // detects install mode, schedules timer if installed

const updatesApi = new UpdatesApi(updateService);
HttpServer.addApiHandler(updatesApi);
```

Init runs before HTTP server starts — fine, `init()` is synchronous (the immediate check is fire-and-forget via void).

## Frontend: UpdateButton

**File:** `src/app/client/UpdateButton.ts` (new)

Sits next to ThemeToggle + SettingsHeader in the top-right corner. Standalone component that polls `/api/updates/status` and renders.

```typescript
export function createUpdateButton(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'update-button-container';
    container.style.display = 'none'; // hidden until status renders

    let pollTimer: number | undefined;

    async function poll(): Promise<void> {
        try {
            const r = await fetch('/api/updates/status');
            if (!r.ok) throw new Error(`status ${r.status}`);
            const s = await r.json() as UpdatesStatusResponse;
            render(container, s);
        } catch (err) {
            // network or server failure — render error state (don't hide; user might retry).
            renderError(container, (err as Error).message);
        }
    }

    poll(); // initial
    pollTimer = window.setInterval(poll, 30 * 1000); // 30s — frontend cadence is independent of backend interval

    return container;
}
```

Render logic: 5 states.
- `idle` + `isInstalled=false` (dev mode): hide entirely
- `idle` + `isInstalled=true`: hide entirely (no update)
- `checking`: small inline spinner with "Checking…" tooltip; `display: flex`
- `downloading`: blue button "Downloading update… {progress}%" with progress; clicking does nothing during download
- `ready`: green button "Apply update v{availableVersion}"; click → POST `/api/updates/apply` → on success show "Restarting…" then page-level reload after a few seconds
- `error`: red caption "Update check failed. [Retry]"; click on Retry → POST `/api/updates/check`

Polling cadence: every 30 seconds frontend-side. Backend timer is the one responsible for actually hitting Velopack; frontend just reflects current state. During `downloading`, frontend can poll faster (every 2s) to keep progress fresh — agent's call.

**Mount:** `src/app/index.ts` — `document.body.appendChild(createUpdateButton())` next to `createSettingsHeader` and `createThemeToggle`.

**CSS:** add `.update-button-container` rules to `src/style/home.css` near `.settings-header` and `.theme-toggle`. Position: top-right, third in the row from the right (gear, theme, update — or update first since it's the most attention-grabbing when present).

## Frontend: SettingsModal Updates section

**File:** `src/app/client/SettingsModal.ts` (modify the `buildUpdatesSection()` method that's currently a stub)

Replace stub content with real wire-up:

- **Auto-apply downloaded updates** checkbox — bound to `config.autoUpdate`. Clarify wording: spec says "auto-apply" but per decision 2 it really gates auto-download. **Reword to "Automatically download updates"** to match actual behavior. PATCH on toggle.
- **Update check interval** — number input, min 5, max 1440. Bound to `config.updateCheckIntervalMinutes`. PATCH on blur or after 500ms debounce.
- **Channel** — radio buttons `stable` / `beta`. PATCH triggers backend reconfigure + immediate check; surface result via inline status.
- **GitHub owner** — text input, default value from config. PATCH on blur. Per decision 7, any value accepted; if check fails after reconfigure, inline error shown but value stays.
- **Manual "Check for updates now"** button — POST `/api/updates/check`. Disable during checking/downloading.
- **Dev-mode banner**: when `isInstalled=false`, show "Dev mode — packaging features disabled" inline at the top of the section, hide all the controls (or render disabled).

Loading: on modal open, fetch `/api/updates/status` once to populate fields; reuse the polling cadence pattern from UpdateButton if useful, but a single fetch on open is sufficient since the modal is short-lived.

## File ownership matrix

**Backend agent owns:**
- `src/server/UpdateService.ts` (new)
- `src/server/__tests__/UpdateService.test.ts` (new)
- `src/server/api/UpdatesApi.ts` (new)
- `src/server/__tests__/UpdatesApi.test.ts` (new)
- `src/server/index.ts` (modify — instantiate UpdateService, register UpdatesApi)
- `src/common/UpdateEvents.ts` (new — exports `UpdateState` type + `UpdatesStatusResponse` interface; frontend imports)

**Frontend agent owns:**
- `src/app/client/UpdateButton.ts` (new)
- `src/app/index.ts` (modify — mount createUpdateButton)
- `src/app/client/SettingsModal.ts` (modify the `buildUpdatesSection` method)
- `src/style/home.css` (add `.update-button-container` rules)
- `src/style/modal.css` (add any new `.settings-updates-*` rules if needed; the existing `.settings-section`/`.settings-row` should mostly suffice)

**No-touch list:**
- `package.json` — `velopack` dep already present, no changes
- `src/server/Config.ts` — schema already has all needed fields from P2 (autoUpdate, channel, githubOwner, updateCheckIntervalMinutes)
- Anything in `launcher/`, `tray/`, `common/` — Rust unchanged for P5
- Any P3/P4a/P4b code outside the explicit modify list

## Validation gates (lead)

1. `cargo check --workspace` — clean (no Rust changes expected; verify nothing broke)
2. `cross check --workspace --target x86_64-unknown-linux-gnu` — clean (same — sanity check)
3. `cargo test --workspace` — 46 tests still green
4. `cargo clippy --workspace --all-targets -- -D warnings` — clean
5. `npx tsc --noEmit` — clean (pre-existing libcDetect error allowed)
6. `npm test` — all green; expect 458 + N tests where N = UpdateService tests + UpdatesApi tests
7. `npm run build` — webpack green
8. **No live update-flow smoke** — deferred to SP3-close per decision 6.

## Coordination notes

- Both agents read this contracts doc before any source edits
- Backend agent creates `src/common/UpdateEvents.ts` FIRST so frontend can import (or frontend uses inline matching types and trusts post-merge tsc)
- Backend agent's `readJsonBody` helper for PATCH body parsing — there's already one in `src/server/api/ServiceApi.ts` from P4b. Either (a) extract to a shared util in `src/server/api/utils.ts` (cleaner) or (b) duplicate in UpdatesApi (simpler, 12 lines). **Locked: (a)** — extract to a shared util now since P5 + future endpoints will keep wanting it.
- Neither agent commits. Lead reviews diffs, validates, commits as one unit.
- If agents find drifts not noted here, append to "## Agent drift notes" at bottom of this doc.

## Risk register

- **Velopack JS SDK behavior in dev mode** — `js_new_update_manager` may throw or may silently construct a non-functional manager. Our heuristic (sq.version + try/catch) covers both. Verify behavior empirically in unit tests with mocked factory.
- **Channel switch when no `releases.<channel>.json` exists yet** — first-time switch to beta when only stable releases exist will return null from checkForUpdates (treated as "no update available"), not as an error. Confirmed acceptable by user (decision 7).
- **GitHub owner override pointing at non-existent fork** — UpdateManager construction may not validate; check will fail with a 404 from GH. Surfaces as `status='error'` in state. Acceptable per decision 7.
- **Background timer leaks across reconfigure** — restartTimer always clears the existing timer. Test for this.
- **Apply during download** — `handleApply` returns 409 if `status !== 'ready'`. Frontend Apply button is hidden in non-ready states. Defense in depth.
- **Multi-tab Apply collision** — two browser tabs both click Apply within 100ms. Backend's deferred process.exit means second tab gets a 200 response too, but the second `applyUpdate()` call may fail (waitExitThenApplyUpdate is idempotent-ish per Velopack docs, or may throw). Wrap the second call in try/catch and ignore. Acceptable v0.1.0 limit.

## Agent drift notes

### Frontend agent (2026-04-26)

- **Spinner is CSS-only, no SVG** — contracts said "spinner can be CSS-only" as an option; chose that path because the pre-write security hook flags any `innerHTML = <constant>` for SVG, even hardcoded ones (false positive vs the existing ThemeToggle/SettingsHeader pattern). Net: `.update-button-spinner` is a bordered div with `@keyframes update-button-spin` in `home.css`. Result is functionally identical, no XSS surface. Future SVG uses elsewhere should consider whether the hook is now stricter than when ThemeToggle was written.
- **`/api/updates/config` PATCH response shape** — contracts say `{ config, status: UpdatesStatusResponse }`. SettingsModal tolerates either `{ status: ... }` envelope OR a bare `UpdatesStatusResponse` (in case backend simplifies). Backend agent should align on the documented `{ config, status }` shape.
- **Owner input — empty string handling** — backend per decision 7 accepts any non-empty string. Frontend silently restores the last known value on blur if user clears the field (no PATCH sent). This is a small UX guard, not a deviation from decision 7 (which is about the *backend* not rejecting non-empty values).
- **Inline status "interval out of range" message** — surfaced client-side without a PATCH when user types a value < 5 or > 1440. Contracts say min=5/max=1440 are HTML-validation hints; this adds a visible message + value-revert. No backend impact.
- **`UpdateButton` polling: 30s slow / 2s fast** — exactly as the contracts allowed. Confirmed that polling intervals always clear before being reset (`scheduleTimer` always `clearTimer`s first) — no leaks.
- **Apply UX** — on `POST /apply` 200, button shows "restarting…" then attempts `window.location.reload()` after 5s (contracts said "a few seconds" — picked 5s). Reload will fail until Velopack relaunches; the message stays visible. No retry logic; user can hard-refresh.
- **`UpdateButton` first-render is hidden** — the container is mounted with `display: none`. First successful poll either keeps it hidden (idle/dev mode) or transitions to a state class. First failed poll renders the error state (per spec).
- **`SettingsModal.updatesSection` field** — assigned but not read after initial render. TypeScript class fields aren't flagged as unused by default; left it in place for future "scroll into view" / "highlight section" affordances. If lint complains, can be dropped.
