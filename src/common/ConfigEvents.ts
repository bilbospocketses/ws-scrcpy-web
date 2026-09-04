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
    /**
     * True when the server was started with WS_SCRCPY_DOCKER=1.
     *
     * Optional so a pre-SP4 server and a post-SP4 frontend interoperate: an
     * absent field reads as false everywhere, which is the desktop answer.
     * Carried on the runtime envelope rather than in AppConfig deliberately —
     * AppConfig is what gets written to config.json, and this must never
     * persist into a /data volume that could later be mounted elsewhere.
     */
    docker?: boolean;
    /**
     * Origins this deployment permits to frame the app, from config.json's
     * `frameAncestors`. Empty means nobody, which is the default.
     *
     * Sent so the client can scope its theme-embed listener to the same set the
     * CSP already advertises. It leaks nothing: `securityHeaders()` puts the
     * identical list in a `frame-ancestors` header on every static response.
     *
     * Optional, like `docker`, so an older server and a newer frontend
     * interoperate -- an absent field reads as "no origins", the safe answer.
     */
    frameAncestors?: string[];
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
