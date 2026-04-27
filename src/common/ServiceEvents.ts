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

export type ServiceStatus = 'running' | 'stopped' | 'not-installed';

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
    status?: ServiceStatus;
    unsupportedReason?: string;
}

/** Success response shape for /api/service/install and /api/service/uninstall. */
export interface ServiceActionSuccess {
    ok: true;
    status: ServiceStatus;
    installMode: 'user' | 'system' | 'user-service' | 'system-service';
}

/** Failure response shape for /api/service/install and /api/service/uninstall. */
export interface ServiceActionFailure {
    ok: false;
    error: string;
}

export type ServiceInstallResponse = ServiceActionSuccess | ServiceActionFailure;
export type ServiceUninstallResponse = ServiceActionSuccess | ServiceActionFailure;

/**
 * Request body for `POST /api/service/install`.
 *
 * - On **Linux**, `scope` selects between user-level (`~/.config/systemd/user/`,
 *   no sudo) and system-level (`/etc/systemd/system/`, requires root) systemd
 *   units. Defaults to `'user'` when omitted. If `scope === 'system'` and the
 *   server isn't running as root, the API returns HTTP 403 with a descriptive
 *   error.
 * - On **Windows**, `scope` is IGNORED — the install scope is auto-detected
 *   from `process.execPath` (Per-Machine vs Per-User) at install time.
 */
export interface ServiceInstallRequest {
    scope?: 'user' | 'system';
}

/** Canonical Windows service name registered with Servy / SCM. */
export const WS_SCRCPY_SERVICE_NAME = 'WsScrcpyWeb';
export const WS_SCRCPY_SERVICE_DISPLAY_NAME = 'ws-scrcpy-web';
export const WS_SCRCPY_SERVICE_DESCRIPTION =
    'ws-scrcpy-web — browser-based scrcpy front-end for Android devices.';
