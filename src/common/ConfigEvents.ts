/**
 * Shared types for the SP3 application config + lifecycle events.
 *
 * Frontend imports types from here for type safety against the backend's
 * GET/PATCH /api/config endpoints. Do NOT import server-only modules here.
 *
 * Transport choice for first-run / config-update notifications:
 *   We use HTTP envelopes on `GET /api/config` rather than a WS channel.
 *   - `GET /api/config` returns `{ config, runtime }` where `runtime` carries
 *     `firstRunComplete` and `portWasAutoShifted` — sufficient for one-shot
 *     consumption by WelcomeModal on app load.
 *   - `PATCH /api/config` returns the merged config + `restartRequired` flag
 *     directly; clients refresh their local view from the response.
 *   No new multiplexer channel byte is allocated for P2.
 */

export type InstallMode = 'user' | 'user-service' | 'system' | 'system-service';
export type UpdateChannel = 'stable' | 'beta';

export interface AppConfig {
    // SP3 lifecycle fields
    installMode: InstallMode | null;
    firstRunComplete: boolean;
    autoUpdate: boolean;
    updateCheckIntervalMinutes: number;
    channel: UpdateChannel;
    githubOwner: string;

    // Pre-existing fields (kept for backward compatibility / runtime usage)
    webPort: number;
    dependenciesPath?: string;
    adbPath?: string;
    scanConcurrency?: number;
    scanTcpTimeoutMs?: number;
    scanAdbConnectTimeoutMs?: number;
    scanProgressInterval?: number;
}

export interface FirstRunStatus {
    firstRunComplete: boolean;
    portWasAutoShifted: boolean;
    webPort: number;
}

/** Envelope shape returned by GET /api/config. */
export interface AppConfigEnvelope {
    config: AppConfig;
    runtime: FirstRunStatus;
}

/** Response shape returned by PATCH /api/config on success. */
export interface AppConfigPatchResponse {
    config: AppConfig;
    restartRequired: boolean;
    /**
     * v0.1.8: when `restartRequired` is true, the server will request a
     * supervisor-driven restart shortly after responding. This URL is
     * where the frontend should redirect the user once the new server
     * is up. Absent when no restart is needed.
     */
    redirectTo?: string;
}

/**
 * Reserved future event payloads — kept as types for parity with the contract
 * doc, even though P2 does not transport them over WS.
 */
export interface ConfigUpdateEvent {
    type: 'config-update';
    config: AppConfig;
}

export interface FirstRunStatusEvent extends FirstRunStatus {
    type: 'first-run-status';
}

export const APP_CONFIG_DEFAULTS: AppConfig = {
    installMode: null,
    firstRunComplete: false,
    autoUpdate: true,
    updateCheckIntervalMinutes: 60,
    channel: 'stable',
    githubOwner: 'bilbospocketses',
    webPort: 8000,
};

export const VALID_INSTALL_MODES: ReadonlyArray<InstallMode> = ['user', 'user-service', 'system', 'system-service'];

export const VALID_CHANNELS: ReadonlyArray<UpdateChannel> = ['stable', 'beta'];
