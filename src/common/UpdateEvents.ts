/**
 * Shared types for the SP3 P5 update flow.
 *
 * Frontend imports types from here for type safety against the backend's
 * /api/updates/* endpoints. Do NOT import server-only modules here.
 *
 * State machine (5-valued, backend-owned per contracts decision 5):
 *   idle        — no update available; checked successfully OR not yet checked
 *   checking    — checkForUpdatesAsync in flight
 *   downloading — downloadUpdateAsync in flight; progress 0..100
 *   ready       — download complete (or available, gated by autoUpdate); awaiting user Apply click
 *   error       — last operation failed; errorMessage populated
 */

import type { UpdateChannel } from './ConfigEvents';

export type UpdateState =
    | 'idle'
    | 'checking'
    | 'downloading'
    | 'ready'
    | 'error';

/**
 * Canonical response shape for GET /api/updates/status, POST /api/updates/check,
 * and embedded in PATCH /api/updates/config responses (as `status`).
 */
export interface UpdatesStatusResponse {
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
    /** Linux only: whether libfuse2 is installed (required for AppImage updates). */
    libfuse2Installed?: boolean;
    /** Mirrored from config.json for UI convenience. */
    autoUpdate: boolean;
    channel: UpdateChannel;
    githubOwner: string;
    updateCheckIntervalMinutes: number;
}

/**
 * Body shape for PATCH /api/updates/config. All fields optional — caller
 * sends only the fields they want to change. Validation rules (per contracts):
 *   - autoUpdate: boolean
 *   - channel: 'stable' | 'beta'
 *   - githubOwner: any non-empty string (decision 7 — no GH-username regex)
 *   - updateCheckIntervalMinutes: integer in [5, 1440]
 */
export interface UpdatesConfigPatchRequest {
    autoUpdate?: boolean;
    channel?: UpdateChannel;
    githubOwner?: string;
    updateCheckIntervalMinutes?: number;
}

/** Common error envelope returned by /api/updates/* on validation / dev-mode rejection. */
export interface UpdatesErrorResponse {
    ok: false;
    error: string;
}

/** Apply success envelope (returned right before the deferred process.exit). */
export interface UpdatesApplyResponse {
    ok: true;
    /**
     * Linux only. When 'reconnect', the client shows the upgrading overlay and
     * polls the same origin until the relaunched app answers on the new
     * version. Absent on Windows (which uses the operation-server HTML redirect).
     */
    mode?: 'reconnect';
}
