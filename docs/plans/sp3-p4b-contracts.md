# SP3 P4b — Linux Sub-Phase: Lead Contracts

**Branch:** `sp3-p4b-linux` (off `main` at `ca2c09a`)
**Authored:** 2026-04-26 (lead reality-check + Velopack research before agent dispatch)
**Reads with:** `docs/specs/2026-04-26-sp3-velopack-installer.md` § Pre-release manual checklist (Linux items 17-22), § Open items / deferred (Linux row), `docs/plans/2026-04-26-sp3-velopack-installer.md` § P4.

## Velopack Linux research — what's locked

Confirmed via [Velopack Linux Overview](https://docs.velopack.io/packaging/operating-systems/linux) + [vpk Linux CLI](https://docs.velopack.io/reference/cli/content/vpk-linux) (read 2026-04-26):

- **Output format: AppImage only.** No .deb / .rpm / Snap / Flatpak. Velopack's deliberate design choice — AppImage runs on any modern glibc-based distro without sudo or pkg-manager integration.
- **Required `vpk pack` flags (Linux):** `-u <packId>`, `-v <version>`, `-p <packDir>`, `--mainExe <name>`, `--icon <path>` (PNG, NOT ICO), `--categories <FreeDesktop>` (optional but recommended).
- **Default channel:** `linux` (Velopack default; we honor it).
- **Update mechanism:** package downloads to `/var/tmp`, AppImage replaced atomically. `pkexec` prompts for sudo if installed in a privileged location (`/opt/`, `/usr/local/`); user installs (anywhere under `$HOME`) update without prompts.
- **No installer wizard equivalent** — first-run UX is whatever the app boots to. Velopack still fires `--veloapp-install` argv on first launch after extraction; our Rust hooks dispatcher already handles this cross-platform.

## Architectural decisions (locked by user 2026-04-26)

1. **Linux tray strategy: (c) best-effort.** Try to initialize via `tray-icon` crate's Linux backend (libayatana-appindicator under the hood); if init fails (stock GNOME without tray extension, headless server, missing libayatana-appindicator dependency), log a warning and silently continue without a tray. The web UI Settings → Stop Server button covers the non-tray case.
2. **Service scope: explicit user choice on Linux** (user OR system). On Linux there's no install-path heuristic equivalent to Windows's `%LocalAppData%` vs `%ProgramFiles%`. WelcomeModal + SettingsModal will offer both options. If user picks `system`, backend verifies `process.geteuid() === 0` (root). If not root, return descriptive error; no fallback / silent degradation. Sub-bullet: Windows behavior unchanged (auto-detect from execPath).
3. **AppImage placement: documented user responsibility.** systemd unit's `ExecStart=` is set to the absolute AppImage path at install time. If user moves/renames the AppImage post-install, service breaks at next start. README + service-install confirmation modal both document this.
4. **PNG icon: user-provided** at `assets/tray-icon.png` (256x256 RGBA, source: `C:\Temp\android-tools.png`, committed in this branch). Velopack `--icon` consumes it directly; tray-icon crate also accepts it for the Linux tray (or we keep using the existing ICO and let the crate decode the embedded PNG sub-image — agents' choice).
5. **node-pty matrix:** glibc-only (linux-x64-glibc + linux-arm64-glibc per SP1b). Musl gap stays open; documented in README as a glibc requirement. Alpine-in-container is not a P4b target.
6. **Cross-compile / build constraints (UPDATED 2026-04-26 mid-P4b):** lead now has `cross` 0.2.5 installed via Docker Desktop on WSL2 backend, plus rustup targets for Linux (x86_64/aarch64 gnu + musl) and Mac (x86_64/aarch64). Lead-side validation runs BOTH `cargo check --workspace` (Windows host) AND `cross check --workspace --target x86_64-unknown-linux-gnu` to exercise `#[cfg(target_os = "linux")]` branches via Docker. Live AppImage build + smoke still happens on user's Linux VMs at SP3-close per decision. Linux compile errors will surface locally now — agents have a real safety net.

## Drift findings (vs P3 stub + plan)

| Plan / P3 said | Reality | Resolution |
|---|---|---|
| `SystemdClient` stub throws `'Linux service mode lands later in SP3'` | ✓ Confirmed at `src/server/service/SystemdClient.ts` | Replace stub with real impl; tests get rewritten |
| `InstallScope.detectInstallScope()` returns `'system'` on non-Windows as a placeholder | ✓ Confirmed | Linux flow does NOT call detectInstallScope — scope arrives via API body. Heuristic preserved as Windows-only. |
| ServiceApi factory injection takes `scope: () => 'user' \| 'system'` | ✓ Confirmed at line 47; uses `detectInstallScope` by default | API extension: `/install` body accepts optional `scope` param. Linux requires it; Windows ignores it (auto-detect preserved). |
| Common SP3 spec § Service integration's "Account selection" table maps PerUser → currentUser, PerMachine → LocalSystem | Windows-only mapping | Linux mapping: user → systemd `--user` scope under current user; system → systemd system scope as root |
| Spec mentions `tray-icon-in-launcher` only for Windows | ✓ Confirmed | common::tray gains a `#[cfg(target_os = "linux")]` arm; launcher tray spawn already platform-conditional via cfg-or-runtime check (best-effort Linux) |

## API contract change — `POST /api/service/install`

**Before (P3):** body unused; scope auto-detected via `detectInstallScope()`.

**After (P4b):**

```typescript
// Request body (optional; backward-compat):
interface ServiceInstallRequest {
    /**
     * Service scope. On Linux this is REQUIRED in practice — the API will
     * default to 'user' if omitted, which is the safe choice.
     * On Windows this is IGNORED — scope is auto-detected from execPath.
     */
    scope?: 'user' | 'system';
}

// Response (unchanged shape, new error case for Linux+system+non-root):
type ServiceInstallResponse = ServiceActionSuccess | ServiceActionFailure;

// New 403 case:
// { ok: false, error: 'system scope requires root. Relaunch the AppImage with sudo, or pick user scope.' }
```

**Backend behavior:**
- On **Windows**: ignore the body entirely. Existing P3 logic runs unchanged (factory-injected scope detection).
- On **Linux**: read `scope` from body, default to `'user'` if absent. If `scope === 'system'` and `process.getuid?.() !== 0`, return HTTP 403 with the descriptive error above. Otherwise pass scope through to SystemdClient.install.
- ServiceApi must be extended to read JSON body for POST endpoints (currently body-less). Use existing patterns from ConfigApi's PATCH (which DOES read JSON body — see `src/server/api/ConfigApi.ts`).

**Frontend behavior:**
- WelcomeModal + SettingsModal: when supported AND platform is Linux, render a scope selector (radio buttons or select) before the install button. Default selection: `user`. Submit body: `{ scope: <selection> }`. On 403 response, show the inline error in the modal.

`src/common/ServiceEvents.ts` adds `ServiceInstallRequest` interface; backend agent updates it.

## SystemdClient real implementation

**File:** `src/server/service/SystemdClient.ts` (replace stub)

### Service scope handling

```typescript
export type SystemdScope = 'user' | 'system';

interface SystemdInstallExtensions extends ServiceInstallOptions {
    scope: SystemdScope;
}
```

Note: this is wider than the cross-platform `ServiceInstallOptions` interface. Two paths:
- **(a)** Extend `ServiceClient.install()` to take `Partial<SystemdInstallExtensions>` (backward-compat for ServyClient which ignores `scope`)
- **(b)** SystemdClient takes scope via constructor or via a setter before each install call

**Locked: (a)** — extend `ServiceInstallOptions` with `scope?: 'user' | 'system'`. Default is undefined (Windows ServyClient ignores). SystemdClient throws if scope is undefined (programmer error; ServiceApi must always pass it on Linux).

```typescript
// src/server/service/ServiceClient.ts (modify):
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
    /** Linux-only: 'user' (~/.config/systemd/user/) or 'system' (/etc/systemd/system/, requires root). Required on Linux; ignored on Windows. */
    scope?: 'user' | 'system';
}
```

### Unit file generation

Template (per scope):

```ini
[Unit]
Description=${description}
After=network.target

[Service]
Type=simple
ExecStart=${binPath}
Restart=on-failure
RestartSec=5
# maxRestartAttempts -> StartLimitBurst within StartLimitIntervalSec
StartLimitBurst=${maxRestartAttempts}
StartLimitIntervalSec=300
Environment=${each envVar as KEY=VAL on its own line}
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=${scope === 'user' ? 'default.target' : 'multi-user.target'}
```

For `user` scope: `WantedBy=default.target` (per-user systemd).
For `system` scope: `WantedBy=multi-user.target` (boot-time).

### Paths

- **User scope:**
  - Unit file: `~/.config/systemd/user/${name}.service` — i.e., `path.join(os.homedir(), '.config', 'systemd', 'user', `${name}.service`)`
  - systemctl invocations: `systemctl --user daemon-reload`, `systemctl --user enable --now ${name}.service`, `systemctl --user disable --now ${name}.service`, `systemctl --user status ${name}.service`, `systemctl --user is-active ${name}.service`
  - `loginctl enable-linger $USER` after install so the service survives logout (best-effort: log warning if loginctl fails or returns non-zero)

- **System scope:**
  - Unit file: `/etc/systemd/system/${name}.service`
  - systemctl invocations: same commands without `--user` flag
  - No `loginctl` needed — system services run regardless of session

### CLI invocations

All via `execFileSync` (matching ServyClient pattern). Status detection uses `systemctl is-active` (returns `active` / `inactive` / `unknown` / etc.) NOT `systemctl status` (verbose human-readable output, harder to parse).

```typescript
// status() implementation:
async status(name: string): Promise<ServiceStatus> {
    // Try user scope first; if no unit file, try system scope; if neither, return 'not-installed'.
    const userExists = fs.existsSync(this.userUnitPath(name));
    const systemExists = fs.existsSync(this.systemUnitPath(name));
    if (!userExists && !systemExists) return 'not-installed';

    const args = userExists
        ? ['--user', 'is-active', `${name}.service`]
        : ['is-active', `${name}.service`];
    try {
        const out = execFileSync('systemctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        return out === 'active' ? 'running' : 'stopped';
    } catch {
        // is-active returns non-zero exit when the service is inactive — that's not an error for our purposes.
        return 'stopped';
    }
}
```

### Scope-resolution helper

```typescript
private resolveActiveScope(name: string): 'user' | 'system' | null {
    if (fs.existsSync(this.userUnitPath(name))) return 'user';
    if (fs.existsSync(this.systemUnitPath(name))) return 'system';
    return null;
}
```

`uninstall(name)` calls `resolveActiveScope` to decide which scope to disable + remove unit from. `restart` and `stop` similarly.

### Install flow

```typescript
async install(opts: ServiceInstallOptions): Promise<void> {
    const scope = opts.scope;
    if (!scope) throw new Error('SystemdClient.install: scope is required (caller must pass user or system)');

    if (scope === 'system' && process.getuid?.() !== 0) {
        throw new Error('system scope requires root. Relaunch the AppImage with sudo, or pick user scope.');
    }

    const unitContent = renderUnitFile(opts);
    const unitPath = scope === 'user' ? this.userUnitPath(opts.name) : this.systemUnitPath(opts.name);

    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, unitContent, { mode: 0o644 });

    const baseArgs = scope === 'user' ? ['--user'] : [];
    execFileSync('systemctl', [...baseArgs, 'daemon-reload'], { stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('systemctl', [...baseArgs, 'enable', '--now', `${opts.name}.service`], { stdio: ['ignore', 'pipe', 'pipe'] });

    if (scope === 'user') {
        // Best-effort linger so the service survives logout.
        try {
            execFileSync('loginctl', ['enable-linger', os.userInfo().username], { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            // Common reasons: loginctl absent (non-systemd-logind systems), missing privileges
            // for some hardened distros. Log warning; the service is still installed and
            // running — it just won't survive a full logout in those edge cases.
            log.warn(`loginctl enable-linger failed (service still installed): ${(err as Error).message}`);
        }
    }
}
```

### Uninstall flow

```typescript
async uninstall(name: string): Promise<void> {
    const scope = this.resolveActiveScope(name);
    if (scope === null) return; // Already uninstalled — idempotent

    if (scope === 'system' && process.getuid?.() !== 0) {
        throw new Error('system-scope service uninstall requires root.');
    }

    const baseArgs = scope === 'user' ? ['--user'] : [];
    // Best-effort stop+disable. systemctl returns non-zero if already stopped.
    try {
        execFileSync('systemctl', [...baseArgs, 'disable', '--now', `${name}.service`], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
        log.info(`systemctl disable returned: ${(err as Error).message}`);
    }

    const unitPath = scope === 'user' ? this.userUnitPath(name) : this.systemUnitPath(name);
    try { fs.unlinkSync(unitPath); } catch { /* ignore — already gone */ }

    try {
        execFileSync('systemctl', [...baseArgs, 'daemon-reload'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
        log.warn(`daemon-reload after uninstall failed: ${(err as Error).message}`);
    }
}
```

### Tests (`src/server/__tests__/SystemdClient.test.ts` — replace stub-throw tests)

Mock `execFileSync`, `fs.existsSync`, `fs.writeFileSync`, `fs.unlinkSync`, `fs.mkdirSync`, `os.homedir`, `os.userInfo`, `process.getuid`. Cases:

- **User-scope install** writes unit file to expected path with correct content; calls daemon-reload + enable --now + loginctl enable-linger; succeeds without root
- **System-scope install** as root: writes to `/etc/systemd/system/`, calls plain systemctl (no `--user`), no loginctl
- **System-scope install** as non-root: throws "requires root" before any side-effect
- **Status** returns `running` when is-active outputs `active`; `stopped` when output is `inactive` or command exits non-zero; `not-installed` when neither unit file exists
- **Uninstall** resolves scope from existing unit file, disables + removes file + daemon-reloads
- **Uninstall idempotence** — calling on a not-installed service returns without error
- **Unit file content** snapshot test for known input opts (verify Description, ExecStart, Environment lines, WantedBy)
- **Loginctl failure tolerance** — install still succeeds when loginctl throws

## ServiceApi extension (Linux body parsing)

**File:** `src/server/api/ServiceApi.ts` (modify)

Currently `handleInstall(res)` takes only `res`. Extend to read body on POST. Pattern from ConfigApi.PATCH:

```typescript
private async handleInstall(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const result = this.factory();
    if (!result.supported) { /* unchanged 501 path */ }

    let scope: 'user' | 'system' | undefined;
    if (process.platform === 'linux') {
        // Read JSON body — optional; default to 'user' if absent or empty.
        const body = await readJsonBody(req).catch(() => ({}));
        scope = body?.scope === 'system' ? 'system' : 'user';

        if (scope === 'system' && process.getuid?.() !== 0) {
            const failure: ServiceActionFailure = {
                ok: false,
                error: 'system scope requires root. Relaunch the AppImage with sudo, or pick user scope.',
            };
            res.writeHead(403);
            res.end(JSON.stringify(failure));
            return true;
        }
    }
    // Windows: scope stays undefined; ServyClient ignores it.

    // ... rest unchanged: detectInstallScope (Windows), build args, call client.install with scope passed through ...
}
```

`readJsonBody` helper — extract from ConfigApi if it has one, or write a tiny one in ServiceApi: collect req chunks → utf8 string → JSON.parse → return parsed or `{}` on failure.

The Windows path stays bit-for-bit identical to P3.

### Updated test cases (`src/server/__tests__/ServiceApi.test.ts`)

Add cases for the Linux scope branch:
- POST with empty body on Linux defaults to `user` scope; calls SystemdClient.install with `scope: 'user'`
- POST with `{scope: 'user'}` body on Linux: same as above
- POST with `{scope: 'system'}` body on Linux as non-root: returns 403 with the documented error
- POST with `{scope: 'system'}` body on Linux as root: calls install with `scope: 'system'`
- POST on Windows: body is ignored (existing test cases continue to work)

Mock `process.platform` and `process.getuid` per case.

## WelcomeModal Linux UX

**File:** `src/app/client/WelcomeModal.ts` (modify)

Currently the modal hardcodes "run as a windows service?". Make this dynamic:

```typescript
// Before fillBody, inspect /api/service/status response:
// - status.platform === 'win32' → existing copy + flow
// - status.platform === 'linux' AND status.supported → new Linux flow (heading + scope chooser + install)
// - !supported → existing fallback to PATCH installMode='user'
```

Linux flow visual shape:

```
┌─────────────────────────────────────────────────────┐
│  Welcome to ws-scrcpy-web                           │
│  Server is running on http://localhost:8000         │
│                                                     │
│  Run as a systemd service?                          │
│  Recommended for always-on access. The server       │
│  starts at login (or boot, for system scope).       │
│                                                     │
│  Scope:                                             │
│    ○ Just for me (no sudo)              ← default   │
│    ○ All users (requires sudo)                      │
│                                                     │
│  [ Yes, install service ]  [ No, run on demand ]    │
└─────────────────────────────────────────────────────┘
```

On "Yes, install service":
- POST `/api/service/install` with `{ scope: '<selected>' }` body
- On 403 (system without sudo), display inline error from response body, leave modal open
- On other failure, display error, leave modal open
- On success, defensive PATCH `firstRunComplete=true` (preserves P3 behavior), close modal

On "No, run on demand": unchanged — PATCH `installMode='user', firstRunComplete=true`, close.

Implementation note: the scope chooser only renders when platform is Linux; Windows continues to use the binary yes/no flow unchanged.

## SettingsModal Service-section Linux UX

**File:** `src/app/client/SettingsModal.ts` (modify the Service section)

Currently when `supported=true && status='not-installed'`, shows a single "Install as Service" button. On Linux, replace with:

```
Service status: not installed

Scope:
  ○ Just for me (no sudo)              ← default
  ○ All users (requires sudo)

[ Install as service ]
```

Same POST body extension. On 403 inline error.

When `status='running'|'stopped'`, the existing "Uninstall Service" button works unchanged (uninstall reads scope from existing unit file location, no extra UI needed).

## common::tray Linux best-effort backend

**File:** `common/src/tray.rs` (modify)

Currently the tray module uses Win32-specific code paths. Wrap the existing Windows code in `#[cfg(windows)]` and add a `#[cfg(target_os = "linux")]` arm:

```rust
#[cfg(windows)]
pub fn run(...) -> anyhow::Result<TrayAction> {
    // existing impl unchanged
}

#[cfg(target_os = "linux")]
pub fn run(
    icon_bytes: &[u8],
    tooltip: &str,
    confirm_title: &str,
    confirm_body: &str,
) -> anyhow::Result<TrayAction> {
    // Best-effort: try to initialize tray-icon's Linux backend. If it fails
    // (no libayatana-appindicator, headless server, GNOME without tray
    // extension), return a sentinel error that callers downgrade to a
    // skipped-tray log message.
    //
    // Confirmation on click: try a system dialog. Options:
    //   - zenity --question (most common; pre-installed on Ubuntu, Fedora)
    //   - kdialog --yesno (KDE)
    //   - Fall back to a hardcoded ConfirmedExit (or Cancelled) if neither?
    //
    // Recommended: try zenity first, kdialog second. If both fail (headless),
    // log error and treat the click as a no-op.
    ...
}
```

The tray-icon crate (0.22) already has Linux support via libayatana-appindicator on tokio glib mainloop. Caveat: the Linux backend wants a tokio runtime + glib main context; agents should research whether this is a hard requirement at v0.22 or if the synchronous shim works on Linux too. **If tokio/glib is required**, agent has two paths:
- (a) Add the runtime only inside the Linux `#[cfg]` block, kept minimal (`tokio = { version = "1", features = ["rt"] }`)
- (b) Skip Linux tray entirely in this branch and just have `run()` return a sentinel `Err(LinuxTrayUnsupported)` immediately — defer Linux tray to P5+

**Locked: agent picks (a) if the dep tree growth is reasonable (under ~30 added crates); otherwise (b).** Document the choice in drift notes. We're best-effort either way — what matters for P4b is the service mode + WelcomeModal flow, not the tray itself.

For the click-confirm dialog on Linux, **agent picks**: zenity-then-kdialog-then-skip is the simplest portable approach. Each invoked via `execFileSync('zenity', ['--question', '--title', confirm_title, '--text', confirm_body])` returning exit 0 for Yes, non-zero for No.

### Caller sites

`launcher/src/tray.rs` and `tray/src/main.rs` already call `common::tray::run(...)`. No changes needed there beyond verifying the cross-platform behavior compiles. The tray helper binary on Linux:
- Built as `ws-scrcpy-web-tray` (no `.exe` on Linux)
- Auto-started by the systemd unit's `ExecStartPost=` ... actually wait, the tray helper is a USER process, not a service one. systemd service runs the AppImage; the tray helper needs to start when the user's desktop session starts.
- **For Linux service mode:** the tray helper's autostart equivalent of Windows's HKCU Run-key is a `~/.config/autostart/ws-scrcpy-web-tray.desktop` file. SystemdClient install writes this; uninstall removes it.

Add to SystemdClient install (user-scope only — system-scope services typically run on headless servers without a desktop session):

```typescript
private writeTrayAutostart(trayHelperPath: string): void {
    const autostartDir = path.join(os.homedir(), '.config', 'autostart');
    const desktopPath = path.join(autostartDir, 'ws-scrcpy-web-tray.desktop');
    const content = `[Desktop Entry]
Type=Application
Name=ws-scrcpy-web tray
Exec=${trayHelperPath}
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
`;
    fs.mkdirSync(autostartDir, { recursive: true });
    fs.writeFileSync(desktopPath, content, { mode: 0o644 });
}

private removeTrayAutostart(): void {
    const desktopPath = path.join(os.homedir(), '.config', 'autostart', 'ws-scrcpy-web-tray.desktop');
    try { fs.unlinkSync(desktopPath); } catch { /* idempotent */ }
}
```

For system-scope: skip autostart entirely (headless server case dominant); document in the install-confirmation modal.

### Tray helper resolution on Linux

Mirrors the ServyClient pattern:
- Installed (Velopack AppImage extracted): `<installRoot>/ws-scrcpy-web-tray` next to the main AppImage executable
- Dev: `cwd/publish/ws-scrcpy-web-tray`

SystemdClient.install on user scope: try to spawn the tray helper immediately (so the user sees it without re-login). If the helper binary doesn't exist OR spawn fails OR no display server is detected (`$DISPLAY` and `$WAYLAND_DISPLAY` both unset), log warning and proceed.

## scripts/package-linux.mjs

**File:** `scripts/package-linux.mjs` (new)

Wraps `vpk pack` for Linux. **Cannot be tested by lead from Windows** — verifies on user's Linux VM at SP3 close. Agent writes the script per spec; lead reviews it for shape but doesn't execute.

Required vpk flags per Velopack docs:
- `-u WsScrcpyWeb` (matches Windows packId for shared releases — TBD; agent picks if not yet decided)
- `-v <version>` (read from package.json or Cargo.toml workspace.package.version)
- `-p publish/` (Linux-staged build output dir)
- `--mainExe ws-scrcpy-web-launcher` (Linux launcher binary, no `.exe`)
- `--icon assets/tray-icon.png`
- `--categories Utility` (FreeDesktop categories spec)
- `--channel linux` (default; explicit)

Pre-conditions the script enforces:
- Running on Linux (warn + exit 0 on Windows; agents author it that way so it can sit alongside `package-stage.mjs` without breaking Windows dev)
- `publish/` exists and contains the launcher binary, dist/, dependencies/
- vpk binary on PATH (`which vpk` check)
- Icon file exists

The Linux launcher binary is built via:
```bash
cargo build --release --workspace --target x86_64-unknown-linux-gnu
cp target/x86_64-unknown-linux-gnu/release/ws-scrcpy-web-launcher publish/
cp target/x86_64-unknown-linux-gnu/release/ws-scrcpy-web-tray publish/
```

This Cargo invocation runs on the user's Linux VM (or eventually CI). Lead does not run it.

## File ownership matrix

**Rust agent owns:**
- `common/src/tray.rs` — modify: wrap existing Windows code in `#[cfg(windows)]`; add `#[cfg(target_os = "linux")]` arm with best-effort tray + zenity/kdialog confirm
- `common/Cargo.toml` — modify: conditional Linux deps (e.g., `[target.'cfg(target_os = "linux")'.dependencies] tokio = { version = "1", features = ["rt"] }` if needed for tray-icon Linux)
- `Cargo.toml` (root) — modify: add Linux-conditional workspace deps if the agent picks path (a) for tokio
- `launcher/src/main.rs` and `launcher/src/tray.rs` — review only; should compile clean cross-platform without changes (the existing runtime gate `if cfg.is_service_mode() return None` works on Linux too — non-service Linux launcher attempts to init tray, gets best-effort behavior). Agent verifies this.
- `tray/src/main.rs` — review only; already calls `common::tray::run` cross-platform; HTTP POST flow works the same on Linux. Verify hidden-window cfg attribute doesn't break Linux compile.

**TypeScript agent owns:**
- `src/server/service/SystemdClient.ts` — REPLACE stub with real impl
- `src/server/__tests__/SystemdClient.test.ts` — REPLACE stub-throw tests with real coverage
- `src/server/service/ServiceClient.ts` — modify: add `scope?: 'user' | 'system'` to `ServiceInstallOptions`
- `src/server/api/ServiceApi.ts` — modify: read JSON body for POST install; handle Linux scope branch + 403 response; pass scope through to client.install
- `src/server/__tests__/ServiceApi.test.ts` — modify: add Linux scope test cases (default user, explicit user, system as root, system non-root → 403)
- `src/common/ServiceEvents.ts` — modify: add `ServiceInstallRequest` interface; export
- `src/app/client/WelcomeModal.ts` — modify: dynamic copy + scope chooser on Linux
- `src/app/client/SettingsModal.ts` — modify: scope chooser in Service section on Linux

**Build agent owns** (smaller; could be folded into TS agent if scope is too thin to dispatch separately):
- `scripts/package-linux.mjs` — new
- `package.json` — modify: add `"package:linux": "node scripts/package-linux.mjs"` script alongside existing `package:stage`
- `README.md` — modify: add Linux install section + glibc requirement + AppImage placement caveat (after install, do not move/rename)

**Decision: fold Build into TS agent.** Three agents is overkill for P4b's footprint; package-linux.mjs is ~50 lines of Node.

**No-touch list:**
- `assets/tray-icon.ico` and `assets/tray-icon.png` — both committed; do not regenerate
- `src/server/service/ServyClient.ts` — Windows-only; P4b does not change Windows behavior
- `src/server/InstallScope.ts` — keep Windows-only heuristic; Linux gets explicit scope from API body
- Anything in `launcher/`, `tray/` — Rust agent owns review only

## Validation gates (lead)

1. `cargo check --workspace` — clean (Windows host; verifies the Windows-cfg branches still compile)
2. `cross check --workspace --target x86_64-unknown-linux-gnu` — clean (exercises `#[cfg(target_os = "linux")]` branches via Docker; first run pulls the cross image ~2 min, subsequent runs ~30 sec)
3. `cargo test --workspace` — common tests still green
4. `cargo clippy --workspace --all-targets -- -D warnings` — clean (Windows host clippy)
5. `npx tsc --noEmit` — clean (pre-existing libcDetect error allowed)
6. `npm test` — all green; expect 439 + N tests where N = SystemdClient real impl tests + ServiceApi Linux scope tests
7. `npm run build` — webpack green
8. **No live smoke for P4b** — AppImage build + runtime smoke deferred to user's Linux VMs at SP3-close per decision 6.

## Coordination notes

- Both agents read this contracts doc before any source edits
- TS agent does the API contract extension FIRST (adds `scope` to `ServiceInstallOptions`, updates `ServiceEvents.ts`), then SystemdClient + ServiceApi + WelcomeModal/SettingsModal
- Rust agent's work is independent — touches only common/src/tray.rs and Cargo.toml
- Neither agent commits. Lead reviews diffs, validates, commits as one unit.
- If agents find drifts not noted here (e.g., tray-icon 0.22 Linux backend has changed shape on crates.io between research and runtime), append "## Agent drift notes" to bottom of this contracts doc and proceed with the most consistent choice.

## Risk register for SP3-close smoke

- **systemd unit ExecStart=AppImage path:** if user moves AppImage post-install, service breaks. Documented risk; user chose to ship as-is.
- **loginctl enable-linger may fail on hardened distros** — install proceeds, service runs, but doesn't survive logout in those edge cases. Acceptable v0.1.0 limit.
- **GNOME without tray extension** — tray helper init fails silently; user uses web UI Stop button. Documented in README.
- **Wayland trays** — libayatana-appindicator behavior on Wayland varies by DE. Best-effort path covers it.
- **System-scope service install requires user to have run the AppImage with sudo** — surfaced via 403 with descriptive error; no silent fallback.
- **No Linux runtime validation by lead** — Linux cfg branches type-checked by review only until smoke. Agents must be unusually careful.

## Agent drift notes

### Rust agent — common::tray Linux backend (path (b) chosen) — 2026-04-26

**Decision: path (b) — skip Linux tray entirely; `run()` returns `Ok(TrayAction::Cancelled)` immediately on non-Windows.**

**Why path (a) was rejected after reading `tray-icon` 0.22.1's Cargo.toml + README:**

1. **No tokio dep — the contracts doc was wrong about that.** `tray-icon`'s Linux backend is built on `libappindicator` 0.9 + `muda` (with the `gtk` feature), which uses **GTK directly via a glib main loop** (`gtk::init()` + `gtk::main()`), not tokio. Path (a)'s "add tokio under cfg-linux" suggestion would not have helped.
2. **System library requirement is the real blocker.** `tray-icon` needs `libgtk-3-dev`, `libappindicator3-dev`, and `libxdo-dev` system packages at compile time. The default `cross-rs` Docker image (`x86_64-unknown-linux-gnu:0.2.5`) does not include these, so `cross check` would fail without a custom Dockerfile providing them. That's a meaningful infrastructure expansion just to validate Linux compile cleanliness.
3. **Dependency tree growth would be substantial.** Pulling `libappindicator` + `muda[gtk]` adds the gtk-rs stack: `gtk`, `glib`, `gobject`, `gio`, `gdk`, `gdk-pixbuf`, `atk`, `cairo`, `pango`, plus all their `-sys` crates and proc-macro bindings. ~30+ crates by my estimate, none of which we exercise on Windows.
4. **Runtime risk on top of compile risk.** Even if we gate the deps and ship a Linux binary, `gtk::init()` only succeeds with a running X11/Wayland display server. On a headless system or a container without `$DISPLAY`, init fails — same end-user outcome as path (b).
5. **P4b is best-effort either way** — the contracts doc explicitly authorizes the Cancelled-sentinel path: "what matters for P4b is the service mode + WelcomeModal flow, not the tray itself."

**Side-effect of this choice:** since tray-icon is Windows-only at the dep level now, I also moved `tray-icon`, `windows`, and `png` to a `[target.'cfg(windows)'.dependencies]` block in `common/Cargo.toml`. That keeps `cross check` for Linux from pulling them in transitively. The `windows` crate dep in `launcher/Cargo.toml` and `tray/Cargo.toml` was left untouched — it's already silent on Linux targets (its API surface is internally cfg-gated to Windows-only) and changing those manifests was out of scope for the Rust agent's tray-focused remit.

**No zenity / kdialog fallback added.** The original contract suggested zenity-then-kdialog-then-skip for the click-confirm dialog. With path (b) there is no tray click to confirm — the function returns `Cancelled` synchronously, which callers (`launcher/src/tray.rs`, `tray/src/main.rs`) already handle with a benign log message and a no-op. Wiring zenity now would be dead code.

**Validation evidence:**
- `cargo check --workspace` (Windows host): clean, 0.79s
- `cargo clippy --workspace --all-targets -- -D warnings` (Windows host): clean
- `cargo test --workspace` (Windows host): 28 + 1 + 1 doc-tests passed (no regressions; the existing 7 Windows-only tray tests still run, the new Linux-stub test is `#[cfg(not(windows))]` so it doesn't execute on Windows)
- `cross check --workspace --target x86_64-unknown-linux-gnu`: **clean, 1m 32s** (first run; pulled the cross Docker image automatically). All three crates (common, tray, launcher) compile clean on Linux. This is much stronger evidence than P4a's "review only" — Linux cfg branches are now type-checked end to end via Docker.

**Future work (deferred to P5+):** when a real Linux tray is wanted, revisit path (a) with a custom `Cross.toml` `[target.x86_64-unknown-linux-gnu]` `image` field pointing at a Dockerfile that adds the GTK system libs, OR drop tray-icon entirely on Linux in favor of `ksni`/`appindicator`-direct bindings.

### TypeScript agent (2026-04-26)

- **Drift: `src/server/service/index.ts` was NOT in the file ownership matrix but had to change.** The factory wrapped `SystemdClient` with `supported: false` per P3 (`unsupportedReason: 'Linux service mode lands later in SP3 — for now, run from source'`). P4b needs Linux to be supported by the API surface, so I flipped the linux branch to `supported: true` and dropped the `unsupportedReason`. Also updated the file's doc-comment header to reflect the new state. This is a one-line behavioral change with no risk to other platforms — Windows path is untouched, the `UnsupportedPlatformClient` for non-win32/non-linux is unchanged. Logging here so the lead is aware the file moved outside the matrix.

- **Drift: WelcomeModal heading copy strategy.** Spec says replace "run as a windows service?" with "run as a systemd service?" on Linux. I implemented this as default-then-morph: synchronous render uses a neutral "run as a service?" heading, then `probePlatform()` (kicked off from the constructor's queueMicrotask alongside `fillBody`) fetches `/api/service/status` and morphs the heading + description to either Windows-style or Linux-style copy. This avoids a blank-flicker between render and probe completion, and keeps the Windows post-morph state bit-for-bit identical to P3/P4a. Documented in the `probePlatform` docstring.

- **Drift: extra ServiceApi test added.** Contracts listed four Linux test cases (default user, explicit user, system+root, system+non-root → 403). I added a fifth covering the "client sent garbage; readJsonBody resolves `{}`; default to user scope" path because the helper has a try/catch and I wanted regression coverage on the fallback. Five Linux cases total now.

- **Drift: SystemdClient test path-normalization.** Contracts assumed Linux-style forward slashes throughout. On the lead's Windows host, `path.join('/home/jamie', '.config', ...)` produces backslashes, so the test mocks/assertions normalize via `.replace(/\\/g, '/')`. Pure test-side concern; runtime is unaffected (Linux paths use forward slashes natively).

- **Honored: NO new npm dependencies** — used Node 24 builtins exclusively (`node:child_process`, `node:fs`, `node:os`, `node:path`).
- **Honored: array-form `execFileSync` everywhere** — no shell interpolation paths anywhere in SystemdClient or scripts/package-linux.mjs.
- **Honored: file ownership** — touched none of `launcher/`, `tray/`, `common/`, `assets/`, or any Rust file.

**Validation evidence (lead's Windows host, 2026-04-26):**
- `npx tsc --noEmit` — clean (only the pre-existing libcDetect.test.ts error)
- `npm test` — 43 files / 458 tests passed (439 baseline + 14 new SystemdClient tests + 5 new ServiceApi Linux scope tests)
- `npm run build` — webpack green

**Open questions for lead review:**
1. `service/index.ts` flip to `supported: true` for linux — confirm OK, or do you want the gate elsewhere?
2. WelcomeModal default-then-morph copy strategy — confirm OK, or prefer "run as a windows service?" as the synchronous default with morph-on-Linux only?
3. README "Linux install" section placement (after "How the Launcher Works", before "Configuration") — confirm or relocate.
