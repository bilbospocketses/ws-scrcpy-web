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

    /**
     * Allow admin actions from off-box while running WITHOUT sign-in.
     *
     * Off by default: in open mode `requireAdmin` resolves to the implicit admin and the instance
     * token is handed to anything that can fetch a page, so without this guard any LAN host is an
     * administrator. Turning it on is a deliberate act taken at the machine (the banner's
     * confirmation modal) or by an operator who set WS_SCRCPY_ALLOW_REMOTE_ADMIN=1.
     *
     * Ignored entirely when sign-in is enabled — then a session is the proof, and this is moot.
     */
    allowRemoteAdmin?: boolean;
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
     * When `restartRequired` is true, the server requests a supervisor-driven
     * restart shortly after responding and the new server binds THIS port.
     * The frontend navigates to it on the origin the browser already uses
     * (`sameOriginUrl`). Absent when no restart is needed.
     *
     * Until 2026-09-06 this was `redirectTo`, a full `http://localhost:<port>`
     * URL built server-side — right only for a browser on the serving machine;
     * every off-box client was sent to its own localhost (qa-harness Arc 1b).
     * The server cannot know the client's host reliably, so it names the port
     * and nothing else.
     */
    redirectPort?: number;
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
    allowRemoteAdmin: false,
};

export const VALID_INSTALL_MODES: ReadonlyArray<InstallMode> = ['user', 'user-service', 'system', 'system-service'];

export const VALID_CHANNELS: ReadonlyArray<UpdateChannel> = ['stable', 'beta'];

/**
 * The update channel a build defaults to when config.json does not name one.
 *
 * A prerelease build (`0.1.30-beta.114`) defaults to `beta`; anything else to
 * `stable`. Before 2026-09-09 the default was `stable` for every build, so a
 * fresh beta install asked the feed for `releases.stable.json` and found
 * nothing until the user noticed the Updates radio -- measured by qa-harness
 * Arc 3 as `status: error … 404` against a beta-only feed. The MSI install hook
 * (`launcher/src/hooks.rs::default_channel_for_version`) derives the same answer
 * from the version Velopack hands it, so the skeleton config and the runtime
 * agree. Existing configs are NOT migrated: a written `stable` cannot be told
 * apart from a user's choice. `APP_CONFIG_DEFAULTS.channel` stays `stable` as
 * the schema default; `Config` substitutes this at load time.
 */
export function defaultChannelForVersion(version: string): UpdateChannel {
    return /-beta(?:[.\-+]|$)/i.test(version) ? 'beta' : 'stable';
}
