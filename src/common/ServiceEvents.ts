/**
 * Shared types for the SP3 P3 Service Mode HTTP API.
 *
 * Frontend imports types from here for type safety against the backend's
 * /api/service/{status,install,uninstall} endpoints. Do NOT import server-only
 * modules here.
 *
 * Backend implementation lives under `src/server/service/` (see ServiceClient,
 * ServyClient, SystemdClient) and `src/server/api/ServiceApi.ts`.
 */

export type ServiceStatus = 'running' | 'stopped' | 'not-installed' | 'shutting-down';

/**
 * Response shape for `GET /api/service/status`.
 *
 * - When the host platform supports service mode (currently win32 only),
 *   `supported=true` and `status` is populated.
 * - When unsupported (non-win32 today; Linux lands later in SP3),
 *   `supported=false` and `unsupportedReason` carries a human-readable string.
 *   The HTTP status code is still 200 — this is a normal state, not an error.
 */
export interface ServiceStatusResponse {
    supported: boolean;
    platform: NodeJS.Platform;
    status?: ServiceStatus | undefined;
    unsupportedReason?: string | undefined;
    /** webPort read fresh from config.json on disk (not in-memory cache). Present when supported=true. */
    diskWebPort?: number | undefined;
    /** config.json filesystem mtime in epoch milliseconds. Present when supported=true. */
    configMtime?: number | undefined;
    /**
     * True when the answering instance is the installed service itself (its unit
     * sets WS_SCRCPY_SERVICE=1), not the transient local instance that triggered
     * the install. The post-install port-discovery poll keys hand-off completion
     * off this positive signal. Present when supported=true.
     */
    servedByService?: boolean;
    /**
     * Snapshot of `AppConfig.installMode` at status time. Lets the frontend
     * tell which service scope is active (`user-service` vs `system-service`)
     * without poking a second endpoint. `null` when never installed. Present
     * when supported=true.
     */
    installMode?: 'user' | 'system' | 'user-service' | 'system-service' | null;
    /**
     * Actual installed scope resolved from the filesystem (which systemd unit
     * file exists), NOT inferred from the mutable `installMode`. This is the
     * authoritative source for pre-selecting the Linux scope radio when a
     * service is installed: `installMode` can drift (reverted on failed
     * installs / uninstall paths) and leave the UI unable to tell which scope
     * is active. `null` when not installed or unresolvable. Linux-only —
     * omitted on Windows, where scope is auto-detected from execPath.
     */
    scope?: 'user' | 'system' | null;
    /** Linux: the shared /opt machine-wide AppImage exists. */
    machineWideInstalled?: boolean;
    /** Linux: the user declined the first-run system-wide install (marker present). */
    systemInstallDeclined?: boolean;
    /** Linux: launcher detected a newer home AppImage than /opt; offer the system-wide update. */
    optUpdateAvailable?: boolean;
}

/** Success response shape for /api/service/install and /api/service/uninstall. */
export interface ServiceActionSuccess {
    ok: true;
    status: ServiceStatus;
    installMode: 'user' | 'system' | 'user-service' | 'system-service';
    /**
     * v0.1.8 install-flow auto-redirect: when the install succeeds and
     * the new service-instance has been verified reachable on a port
     * different from this (local) instance's port, this field carries
     * the URL the frontend should navigate to. The local instance
     * schedules its own shutdown shortly after responding so the user
     * doesn't end up with two app instances fighting for the tray.
     *
     * Absent when no redirect is needed (e.g., service install
     * succeeded but the new instance is unreachable for some reason —
     * frontend should fall back to refreshing the home page).
     */
    redirectTo?: string;
    /**
     * v0.1.8 uninstall-flow Path A handoff: present when the request
     * came from a service-context API and the server has spawned a
     * fresh user-session local launcher to take over. Frontend
     * navigates to `redirectTo` with this token in the URL params; the
     * new local instance reads `?resume=uninstall-service&token=...`,
     * validates it, and auto-fires the uninstall click.
     */
    resumeToken?: string;
    /** config.json mtime snapshot at response time (epoch ms). Frontend uses as baseline for polling. */
    configMtime?: number;
    /** webPort from config.json on disk at response time. */
    diskWebPort?: number;
}

/**
 * Discriminator added in v0.1.25 to drive frontend error UX. Optional for
 * backward compatibility — older callers ignore unknown fields, and frontend
 * treats absence as 'unknown'. Add new variants here AND extend the
 * frontend mapping in `SettingsModal.ts::reasonToUserMessage` in the same
 * change to keep the discriminated union exhaustive.
 *
 * Variant semantics:
 * - `unsupported`: service mode not supported on this platform.
 * - `uac-declined`: user clicked No on the Windows UAC prompt
 *   (PowerShell Start-Process -Verb RunAs exited with ERROR_CANCELLED 1223).
 * - `handoff-timeout`: the service-context handoff couldn't reach a
 *   user-session launcher within the discover() timeout, OR (post-v0.1.25)
 *   the LocalSystem direct-uninstall path was deliberately not attempted
 *   because UAC can't fire from session 0.
 * - `handoff-no-target`: active session resolution failed AND no fallback
 *   path is available. Reserved; not currently emitted but type-stable for
 *   future granularity.
 * - `invalid-token`: the X-Resume-Token header was missing or didn't match
 *   a recently-issued token for the requested action.
 * - `servy-failure`: servy-cli (or systemd-side equivalent) exited non-zero
 *   on the actual install/uninstall operation.
 * - `service-start-failed`: the unit installed without error but never reached
 *   the running state (e.g. a bad ExecStart). The failed unit is rolled back
 *   and the app stays in local mode — the caller should surface a retry.
 * - `unknown`: catch-all for legacy / uncategorized failure paths.
 */
export type ServiceFailureReason =
    | 'unsupported'
    | 'uac-declined'
    | 'handoff-timeout'
    | 'handoff-no-target'
    | 'invalid-token'
    | 'servy-failure'
    | 'service-start-failed'
    | 'unknown';

/** Failure response shape for /api/service/install and /api/service/uninstall. */
export interface ServiceActionFailure {
    ok: false;
    error: string;
    reason?: ServiceFailureReason;
}

export type ServiceInstallResponse = ServiceActionSuccess | ServiceActionFailure;
export type ServiceUninstallResponse = ServiceActionSuccess | ServiceActionFailure;

/**
 * Request body for `POST /api/service/install`.
 *
 * - On **Linux**, `scope` selects between user-level (`~/.config/systemd/user/`,
 *   no sudo) and system-level (`/etc/systemd/system/`, requires root) systemd
 *   units. Defaults to `'user'` when omitted. If `scope === 'system'` and the
 *   server isn't running as root, `SystemdClient.install()` elevates via
 *   pkexec (single graphical password prompt covers cp + daemon-reload +
 *   enable). The API itself stays unelevated.
 * - On **Windows**, `scope` is IGNORED — the install scope is auto-detected
 *   from `process.execPath` (Per-Machine vs Per-User) at install time.
 */
export interface ServiceInstallRequest {
    scope?: 'user' | 'system';
}

/** Request body for POST /api/service/uninstall-app. `keep` preserves config.json + logs/. */
export interface AppUninstallRequest {
    keep: boolean;
}

/** Canonical Windows service name registered with Servy / SCM. */
export const WS_SCRCPY_SERVICE_NAME = 'WsScrcpyWeb';
export const WS_SCRCPY_SERVICE_DISPLAY_NAME = 'ws-scrcpy-web';
export const WS_SCRCPY_SERVICE_DESCRIPTION = 'ws-scrcpy-web — browser-based scrcpy front-end for Android devices.';
