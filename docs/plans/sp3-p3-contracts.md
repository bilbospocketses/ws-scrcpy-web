# SP3 P3 — Service Mode: Lead Contracts

**Branch:** `sp3-p3-service-mode` (off `main` at `6461b04`)
**Authored:** 2026-04-26 (lead reality-check pass before agent dispatch)
**Reads with:** `docs/specs/2026-04-26-sp3-velopack-installer.md` § Servy integration + UI section E, `docs/plans/2026-04-26-sp3-velopack-installer.md` § P3.

## Drift findings (vs plan file table)

The P3 plan task table was authored before the codebase had Modal base class + ThemeToggle in their current shape. Below are the file-path corrections agents must use:

| Plan said | Reality | Resolution |
|---|---|---|
| `src/app/client/SettingsModal.ts` (Create) | Does not exist; correct location matches sibling modals (e.g. `WelcomeModal.ts`) | **Create at `src/app/client/SettingsModal.ts`** ✓ |
| `src/app/client/components/SettingsHeader.ts` (Create) | `components/` subdir does not exist; sibling pattern is flat (e.g. `ThemeToggle.ts` lives at `src/app/client/ThemeToggle.ts`) | **Create at `src/app/client/SettingsHeader.ts`** (no subdir) |
| Modal base class location | Correct location is **`src/app/ui/Modal.ts`** (not `src/app/client/Modal.ts`) | Import `from '../ui/Modal'` |
| Header host element | No HTML `<header>` exists; `ThemeToggle` is mounted directly to `document.body` from `src/app/index.ts:78` (`document.body.appendChild(createThemeToggle())`) | `SettingsHeader` follows the same pattern: export `createSettingsHeader(): HTMLElement` and mount in `index.ts` next to `createThemeToggle()`. Both will float in the top-right corner via existing `.theme-toggle` CSS positioning |

**Modal base API** (from `src/app/ui/Modal.ts` read 2026-04-26):
- `abstract class Modal` with constructor `Modal(options: ModalOptions)`
- `ModalOptions = { title: string; onClose?: (result: unknown) => void }`
- `protected abstract buildBody(container: HTMLElement): void` — fill the modal body
- `protected buildFooter(): HTMLElement | null` — optional footer
- `protected addHeaderButton(btn: HTMLElement): void` — insert button into header controls (left of theme toggle)
- `public close(result?: unknown): void` — programmatic close
- `protected onBeforeClose(): void` — cleanup hook
- **Critical class-fields gotcha** (`feedback_es2022_class_fields.md`): values set during `super()`/`buildBody()` get clobbered by class-field initializers running afterward. WelcomeModal works around this with `queueMicrotask`-deferred state init. **SettingsModal must follow the same pattern** — don't put state in declared class fields if it's set during `buildBody`.

## Architectural decision: cross-platform service abstraction

Per spec § Non-goals (updated 2026-04-26), Linux Velopack + systemd service mode are **in-scope for SP3 as a later sub-phase**. P3 lays the architectural groundwork so the Linux sub-phase is purely additive — no churn on `ServiceApi.ts`, `SettingsModal.ts`, or `WelcomeModal.ts` when `SystemdClient` lands.

### ServiceClient interface (Backend agent owns)

**File:** `src/server/service/ServiceClient.ts` (new — note new `service/` subdir under `src/server/`)

```typescript
export type ServiceStatus = 'running' | 'stopped' | 'not-installed';
export type ServiceAccount = 'currentUser' | 'LocalSystem';
export type ServiceStartType = 'Automatic' | 'Manual' | 'Disabled';

export interface ServiceInstallOptions {
    name: string;
    displayName: string;
    description: string;
    binPath: string;
    account: ServiceAccount;
    startType: ServiceStartType;
    maxRestartAttempts: number;
    envVars: Record<string, string>;
    logPath: string;
}

export interface ServiceClient {
    install(opts: ServiceInstallOptions): Promise<void>;
    uninstall(name: string): Promise<void>;
    status(name: string): Promise<ServiceStatus>;
    restart(name: string): Promise<void>;
    stop(name: string): Promise<void>;
}

export interface ServiceClientFactoryResult {
    client: ServiceClient;
    supported: boolean;
    platform: NodeJS.Platform;
    /** When supported=false, this string is shown in the UI and returned from /api/service/status */
    unsupportedReason?: string;
}

export function getServiceClient(): ServiceClientFactoryResult;
```

Factory at `src/server/service/index.ts`:
- `process.platform === 'win32'` → `{ client: new ServyClient(), supported: true, platform: 'win32' }`
- `process.platform === 'linux'` → `{ client: new SystemdClient(), supported: false, platform: 'linux', unsupportedReason: 'Linux service mode lands later in SP3 — for now, run from source' }`
- other → `{ client: <throwing stub>, supported: false, platform, unsupportedReason: 'Service mode unsupported on this platform' }`

**ServyClient** (Windows real implementation): `src/server/service/ServyClient.ts`
**SystemdClient** (Linux stub for P3, full impl in later sub-phase): `src/server/service/SystemdClient.ts` — every method throws `'Linux service mode lands later in SP3'`. Tests assert all throws.

### ServyClient implementation specifics

- Uses `execFileSync` from `node:child_process`
- Resolves CLI path via `path.join(process.cwd(), 'servy-cli.exe')` for installed mode; falls back to `path.join(__dirname, '..', '..', '..', 'publish', 'servy-cli.exe')` if running from `dist/` in dev
- All operations are synchronous (Servy CLI is fast); wrap in `Promise.resolve()` to satisfy interface
- Throws on non-zero exit; captures stderr into the thrown Error message
- Status detection via `servy-cli list` + regex parse (Servy doesn't have a single-service `status` subcommand as of v8.2 — list-and-match is the documented pattern)

## Servy bundling — fetch-servy.mjs spec

**File:** `scripts/fetch-servy.mjs` (Backend agent owns)

Constants to embed:
- `SERVY_VERSION = '8.2'`
- `SERVY_ARCHIVE_URL = 'https://github.com/aelassas/servy/releases/download/v8.2/servy-8.2-x64-portable.7z'`
- `SERVY_ARCHIVE_SHA256 = '70373DE2F9CCCE9AD49301CDF7106D7F0695305FC76A5B1F5C757A7F573E686B'`
- `SERVY_CLI_SHA256 = '185217312C2A690BDFCF5164B97CDF110025507BBB7F45AFD1425A6CC03C3BAA'`
- Inner archive path: `servy-8.2-x64-portable/servy-cli.exe`

Steps:
1. Download archive to a temp file (skip if SHA256 already matches a cached copy)
2. Verify archive SHA256
3. Extract via `execFileSync('C:\\Windows\\System32\\tar.exe', ['-xf', archive, '-C', tempDir])` — explicit path because git-bash's GNU tar can't handle 7z; bsdtar in System32 is the one we need
4. Verify inner `servy-cli.exe` SHA256
5. Copy to `publish/servy-cli.exe`
6. Log version + path + final size

On non-Windows host: log "Servy fetch is Windows-only; skipping" and exit 0. (CI's release builds will run on Windows runners.)

**Test:** smoke runs in lead validation, not unit-tested (it's a build script, deterministic, single failure mode = network / hash drift).

**Wired into:** `scripts/stage-publish.mjs` — invoke `fetch-servy.mjs` before/around the existing publish staging steps. Backend agent edits `stage-publish.mjs` to add the call; if `stage-publish.mjs` only orchestrates Velopack staging and doesn't already exist, follow the existing P1 pattern and look at how `bump-version.mjs` is referenced.

## InstallScope (Backend agent owns)

**File:** `src/server/InstallScope.ts`

```typescript
export type InstallScope = 'user' | 'system';

export function detectInstallScope(): InstallScope {
    if (process.platform !== 'win32') return 'system'; // doesn't matter; Linux phase will reinterpret
    const localAppData = process.env['LOCALAPPDATA'];
    if (!localAppData) return 'system';
    const installDir = path.dirname(process.execPath);
    return installDir.toLowerCase().startsWith(localAppData.toLowerCase()) ? 'user' : 'system';
}
```

Tests with mocked `process.execPath` and `process.env.LOCALAPPDATA`.

## ServiceApi handlers (Backend agent owns)

**File:** `src/server/api/ServiceApi.ts`

| Endpoint | Method | Request | Response |
|---|---|---|---|
| `/api/service/status` | GET | — | `{ supported: boolean; platform: NodeJS.Platform; status?: ServiceStatus; unsupportedReason?: string }` |
| `/api/service/install` | POST | — (request body unused; scope auto-detected) | `{ ok: true; status: ServiceStatus; installMode: 'user-service' \| 'system-service' }` on success; `{ ok: false; error: string }` (400/501/500) on failure |
| `/api/service/uninstall` | POST | — | `{ ok: true; status: ServiceStatus; installMode: 'user' \| 'system' }` on success; `{ ok: false; error: string }` on failure |

**Behavior:**
- `GET /status` — calls `getServiceClient()`. If `supported=false`, returns `{ supported: false, platform, unsupportedReason }` with HTTP 200 (this is a normal state, not an error). Else calls `client.status('WsScrcpyWeb')` and returns the result.
- `POST /install` — if not supported: HTTP 501 with `{ ok: false, error: unsupportedReason }`. Else: detects InstallScope → maps to `ServiceAccount` (user→currentUser, system→LocalSystem) → calls `client.install({ ... })` with the spec params (name=WsScrcpyWeb, etc.) → on success, updates `config.json.installMode` to `user-service` or `system-service` via the existing `Config` API (P2 wired this) → returns success.
- `POST /uninstall` — calls `client.stop('WsScrcpyWeb')` (best-effort, ignore "not installed" errors) then `client.uninstall('WsScrcpyWeb')` → on success, reverts `config.json.installMode` (drop the `-service` suffix) → returns success.

**Wired into:** `src/server/index.ts` — register the routes alongside the existing P2 ConfigApi registration. **Backend agent owns this edit to `index.ts`.**

## Settings modal scaffold (Frontend agent owns)

**File:** `src/app/client/SettingsModal.ts`

Extends `Modal` from `'../ui/Modal'`. Sections per spec § E:
- **Server** — web port number input (range 1024–65535, validated). Save → `PATCH /api/config` with `{ webPort: <new> }`. If response has `restartRequired=true`, show inline notice: "Server will restart on the new port. Browser will redirect." (Actual restart wiring is P5 territory; for P3 just surface the notice.)
- **Updates (stub)** — render a placeholder section with "(Configurable in P5)" so the layout shape is locked in.
- **Service** — calls `GET /api/service/status` on modal open. Three states:
  - `supported=false` → show "Service mode is currently Windows-only. Linux support arrives later in SP3." (use `unsupportedReason` from the response if present)
  - `supported=true, status='not-installed'` → show "Install as Service" button; click triggers `POST /api/service/install`, then re-fetches status
  - `supported=true, status='running'|'stopped'` → show service status indicator + "Uninstall Service" button; click triggers `POST /api/service/uninstall`
- **App (stub)** — placeholder "(Uninstall in P7)".
- **Dev-mode banner** — for P3, ALWAYS hidden (shown when `isInstalled() === false` arrives in P5).

**State init:** Use the queueMicrotask-deferred pattern from WelcomeModal — see `src/app/client/WelcomeModal.ts` and `feedback_es2022_class_fields.md`.

## Settings header (Frontend agent owns)

**File:** `src/app/client/SettingsHeader.ts`

Mirror the shape of `ThemeToggle.ts`. Export `createSettingsHeader(): HTMLElement` that returns a `<button class="settings-header" title="Settings">` with a gear-icon SVG inside. **For SVG construction, follow the exact same pattern as `ThemeToggle.ts` uses for its sun/moon SVGs** (assignment of a hardcoded SVG string constant to the button's contents). Use a 24x24 viewBox gear path, `currentColor` fill so it inherits theme colors. Click handler instantiates `new SettingsModal({ title: 'Settings' })`.

**Mount:** `src/app/index.ts` — add `document.body.appendChild(createSettingsHeader())` next to the existing `document.body.appendChild(createThemeToggle())` line (~line 78).

**CSS:** Add `.settings-header` rules to `src/style/` (sibling location to wherever `.theme-toggle` is styled — frontend agent finds and matches). Position: top-right, next to theme toggle, same dimensions/glassmorphism treatment.

## WelcomeModal back-fill (Frontend agent owns) — T3.7

**File:** `src/app/client/WelcomeModal.ts` (modify; created in P2)

P2 stub for "yes, install service" only PATCHes `installMode='user-service'`. P3 must replace that with a real `POST /api/service/install` call. Behavior:
- On `Yes, install service` click:
  - First check `GET /api/service/status` — if `supported=false`, alert/inline-notice the unsupportedReason and fall back to `installMode='user'` (Linux dev-mode fallback)
  - If `supported=true`: call `POST /api/service/install` → on success, the API has already updated `installMode`, so just close the modal
  - On failure: show error in the modal, leave it open (user can retry or pick "No")
- On `No, run on demand` click: unchanged from P2 — `PATCH /api/config { installMode: 'user', firstRunComplete: true }`

## File ownership matrix

**Backend + Build agent owns:**
- `scripts/fetch-servy.mjs` (create)
- `scripts/stage-publish.mjs` (modify)
- `package.json` (if scripts need to be added — coordinate via npm scripts)
- `src/server/service/ServiceClient.ts` (create)
- `src/server/service/ServyClient.ts` (create)
- `src/server/service/SystemdClient.ts` (create — stub)
- `src/server/service/index.ts` (create — factory)
- `src/server/InstallScope.ts` (create)
- `src/server/api/ServiceApi.ts` (create)
- `src/server/__tests__/ServyClient.test.ts` (create)
- `src/server/__tests__/SystemdClient.test.ts` (create — assert stub throws)
- `src/server/__tests__/InstallScope.test.ts` (create)
- `src/server/__tests__/ServiceApi.test.ts` (create — basic supertest-style routing)
- `src/server/index.ts` (**modify only — register ServiceApi routes**)
- `src/common/ServiceEvents.ts` (create — shared types; see API contract section below)

**Frontend agent owns:**
- `src/app/client/SettingsModal.ts` (create)
- `src/app/client/SettingsHeader.ts` (create)
- `src/app/index.ts` (**modify only — mount createSettingsHeader**)
- `src/app/client/WelcomeModal.ts` (modify — T3.7 back-fill)
- `src/style/*.css` (add `.settings-header` rules — find right file by reading where `.theme-toggle` is styled)

**No-touch list (do NOT modify):**
- Anything in `launcher/` (Rust) — P3 has no Rust changes
- `src/server/Config.ts` (P2 work; P3 only consumes `installMode` field)
- Any other modal or component not listed above

## API contract — ServiceEvents.ts

Backend agent creates this file early so frontend agent can import. If timing skews and frontend runs before backend's file lands, frontend uses inline matching types (post-merge tsc will catch any drift):

```typescript
export type ServiceStatus = 'running' | 'stopped' | 'not-installed';

export interface ServiceStatusResponse {
    supported: boolean;
    platform: NodeJS.Platform;
    status?: ServiceStatus;          // present when supported=true
    unsupportedReason?: string;      // present when supported=false
}

export interface ServiceActionSuccess {
    ok: true;
    status: ServiceStatus;
    installMode: 'user' | 'system' | 'user-service' | 'system-service';
}

export interface ServiceActionFailure {
    ok: false;
    error: string;
}

export type ServiceInstallResponse = ServiceActionSuccess | ServiceActionFailure;
export type ServiceUninstallResponse = ServiceActionSuccess | ServiceActionFailure;
```

## Validation gates (lead runs after both agents finish)

1. `npx tsc --noEmit` — clean (the pre-existing `libcDetect.test.ts` PathLike error is allowed; flag any new errors)
2. `npm test` — all green (vitest); expect ~395+ N tests where N = backend + frontend new tests
3. `cd launcher && cargo test && cargo clippy --all-targets -- -D warnings` — green (no Rust changes expected, but verify nothing collateral broke)
4. `npm run build` — webpack green
5. **Live smoke** (Windows, manual):
   - `npm start` from clean state
   - Open `http://localhost:8000`
   - Click gear icon → Settings modal opens
   - Service section shows "not-installed" + "Install as Service" button
   - Click Install → confirm `services.msc` shows `ws-scrcpy-web` running under current user
   - Click Uninstall → confirm `services.msc` no longer lists it
   - Re-open WelcomeModal flow (set `firstRunComplete=false` in config, restart) → "Yes, install service" works end-to-end

## Coordination notes

- Both agents reference this doc as their primary spec. Do not re-read the SP3 plan task table directly — it has the file-path drifts noted above. Read it for context if needed, but treat THIS doc as the source of truth for files + contracts.
- Backend agent creates `src/common/ServiceEvents.ts` early (first thing) so its types exist for any agent that wants to import.
- Neither agent commits. Lead reviews diffs, runs validation, commits as one unit.
- If an agent finds a drift not noted here, it logs the drift to the bottom of this contracts doc and proceeds with the most consistent choice — don't block.

## Frontend agent drift notes

(2026-04-26, frontend agent run)

1. **WelcomeModal now owns first-run persistence.** The P2 design had `index.ts`'s `onDecision` callback PATCH `installMode` + `firstRunComplete`. That is incompatible with the P3 service-install path because `POST /api/service/install` updates `installMode` server-side, and the caller cannot tell which path was taken without leaking response state. Fix: WelcomeModal now performs the network work itself (GET status → POST install OR PATCH config), and `onDecision` is purely a notification hook (no required side-effects). Updated `src/app/index.ts` to drop the now-redundant PATCH.

2. **Defensive `firstRunComplete=true` PATCH after successful service install.** The contract for `POST /api/service/install` says only that `installMode` is updated server-side; it does not specify `firstRunComplete`. WelcomeModal issues a follow-up `PATCH /api/config { firstRunComplete: true }` after a successful install to guarantee the welcome modal does not re-appear next session, regardless of whether the backend's install handler sets that flag. The PATCH failure is non-fatal (install itself already succeeded). Backend agent: if your `/install` handler already sets `firstRunComplete`, this is harmless; if not, this defensive PATCH papers over the gap. Either way works.

3. **Settings modal CSS lives in `modal.css`, not a new `settings-modal.css`.** All `.settings-*` selectors (sections, rows, inputs, buttons, status) appended to `src/style/modal.css` end-of-file. `.settings-header` (top-right gear button) lives in `src/style/home.css` next to `.theme-toggle`. No new CSS file created — Modal.ts's existing `import '../../style/modal.css'` covers it.

4. **Service section button copy:** "install as service" / "uninstall service" (lowercase per existing modal style — see WelcomeModal "yes, install service" precedent).

## Lead validation findings (2026-04-26)

**Two real bugs surfaced by live smoke (now fixed):**

1. **`ServiceApi.handle()` was missing `await` on the inner handler dispatches.** Because `return handlerPromise` from an async function does NOT trigger the surrounding try/catch when the inner promise rejects, async errors bypassed the catch block and produced a malformed `{error:...}` envelope from the framework's outer error handler instead of the documented `{ok:false,error:...}`. Fixed: `return await this.handleStatus(res)` (and same for install/uninstall). Adding a unit test for this would require mocking the framework's error path; deferred to a future cleanup pass.
2. **`ServyClient.resolveServyPath()` couldn't find `publish/servy-cli.exe` from a webpack-bundled runtime.** The agent's source-layout fallback `path.resolve(__dirname, '..', '..', '..', 'publish', 'servy-cli.exe')` assumed source layout (`src/server/service/` → up three → repo root) but at runtime `__dirname` is `dist/`, so the relative climb walked outside the repo. Fixed: added `path.join(cwd, 'publish', 'servy-cli.exe')` as the second resolution candidate (npm start runs from repo root, fetch-servy.mjs writes there).

**One Servy v8.2 behavior to flag for documentation (not a P3 bug):**

- Even read-only `servy-cli list` requires Administrator elevation on first run, because Servy auto-registers a Windows Event Log source named `Servy` on the `Application` log. Without elevation, `list` throws `An unexpected error occurred: Failed to ensure Event Log source 'Servy' on log 'Application'`. Once elevated-registered (one-time), subsequent calls work non-elevated. This propagates cleanly through ServiceApi as `{ok:false,error:"servy-cli list failed: ..."}` HTTP 500, which the SettingsModal's graceful error+retry UX handles.
- **Action item:** SP3 P5 or P7 should document this in the README install path / TECHNICAL_GUIDE — first install requires elevation, after which the service-mode UI works normally. Alternatively, the launcher / installer could pre-register the Event Log source during MSI install (admin context already established). Not blocking P3.

**Live API smoke confirmed:**
- `node scripts/fetch-servy.mjs` end-to-end: download (78.9 MB) → archive SHA256 OK → bsdtar extract → inner SHA256 OK → copy to `publish/servy-cli.exe` (41.7 MB) ✓
- `node dist/index.js` boots cleanly; P2 port-collision auto-shift still works (8000 busy → 8001) ✓
- `GET /api/service/status` reaches ServiceApi handler, calls ServyClient, surfaces real Servy errors with correct envelope shape ✓
- `GET /api/config` (P2 sanity) returns expected envelope ✓

**Browser UI smoke (gear icon visibility, modal open, service-section render, button states) deferred to user — automated headless browser run was not in scope for lead validation.**
