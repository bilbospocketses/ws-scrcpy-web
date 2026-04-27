/**
 * Cross-platform service-manager abstraction for SP3 P3 (Service Mode).
 *
 * Backed by:
 *   - ServyClient   — Windows real implementation using Servy v8.2 CLI
 *   - SystemdClient — Linux stub (every method throws); full impl arrives later in SP3
 *
 * Factory: `getServiceClient()` (see ./index.ts) selects the right client for
 * the host platform and surfaces an `unsupportedReason` for non-win32 hosts so
 * the API + UI can render a graceful "service mode unsupported" state.
 *
 * The interface stays minimal: install / uninstall / status / restart / stop.
 * Each call is keyed by the canonical service name (`WsScrcpyWeb`); install
 * also takes display name, description, binary path, account, start type,
 * environment vars, and the log path.
 */

import type { ServiceStatus } from '../../common/ServiceEvents';

export type { ServiceStatus };

/** Account the service runs under. Maps to Servy --account on Windows. */
export type ServiceAccount = 'currentUser' | 'LocalSystem';

/** Service start type. Maps to Servy --startType on Windows. */
export type ServiceStartType = 'Automatic' | 'Manual' | 'Disabled';

/** Options accepted by ServiceClient.install(). */
export interface ServiceInstallOptions {
    /** Canonical service name (e.g. 'WsScrcpyWeb'). */
    name: string;
    /** Human-readable display name shown in services.msc. */
    displayName: string;
    /** Service description shown in services.msc. */
    description: string;
    /** Absolute path to the binary the service should launch. */
    binPath: string;
    /** Which account the service runs under. */
    account: ServiceAccount;
    /** Service start type. */
    startType: ServiceStartType;
    /** Restart attempts before SCM gives up on the service. */
    maxRestartAttempts: number;
    /** Environment variables passed to the service process. */
    envVars: Record<string, string>;
    /** Absolute path used for the service log file. */
    logPath: string;
    /**
     * Linux-only systemd scope selector.
     *
     *   - `'user'`   → unit at `~/.config/systemd/user/<name>.service`,
     *                  installed without sudo, started via `systemctl --user`.
     *                  `loginctl enable-linger` is invoked best-effort so the
     *                  service survives logout.
     *   - `'system'` → unit at `/etc/systemd/system/<name>.service`, requires
     *                  root (the API enforces this with a 403 before reaching
     *                  the client).
     *
     * Required on Linux (SystemdClient throws if undefined). Ignored on
     * Windows — ServyClient consumes `account` instead.
     */
    scope?: 'user' | 'system';
}

/**
 * Cross-platform service-manager client.
 *
 * All methods are async to keep the contract uniform across implementations,
 * even when the underlying CLI is synchronous (Windows / Servy is fast enough
 * that we wrap execFileSync in Promise.resolve).
 */
export interface ServiceClient {
    install(opts: ServiceInstallOptions): Promise<void>;
    uninstall(name: string): Promise<void>;
    status(name: string): Promise<ServiceStatus>;
    restart(name: string): Promise<void>;
    stop(name: string): Promise<void>;
}

/**
 * Result returned by `getServiceClient()`. Callers inspect `supported` to
 * decide whether to attempt service operations or surface
 * `unsupportedReason` to the UI.
 */
export interface ServiceClientFactoryResult {
    client: ServiceClient;
    supported: boolean;
    platform: NodeJS.Platform;
    /** Present when supported=false; shown verbatim by the UI / API. */
    unsupportedReason?: string;
}
