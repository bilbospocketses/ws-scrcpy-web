import type { ServerItem } from '../types/Configuration';
import { httpsCollisionWarning } from './Config';
import { Logger } from './Logger';
import { findAvailablePort as realFindAvailablePort, webPortOverride } from './PortPicker';
import {
    isServiceInstance as realIsServiceInstance,
    isSiblingInstance as realIsSiblingInstance,
} from './siblingInstance';

/** The slice of Config the port resolver reads and writes. `Config` satisfies it. */
export interface WebPortConfig {
    getAppConfig(): { webPort: number };
    readonly servers: ServerItem[];
    readonly usesAdvancedServerConfig: boolean;
    setActualWebPort(actualPort: number, opts?: { persist?: boolean; autoShifted?: boolean }): void;
}

/** Injectable seams; every one defaults to the production implementation. */
export interface ReconcileWebPortDeps {
    env: NodeJS.ProcessEnv;
    findAvailablePort: (start: number, end: number) => Promise<number | null>;
    isServiceInstance: () => boolean;
    isSiblingInstance: (port: number) => Promise<boolean>;
    log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

/**
 * Settle the port the first HTTP listener binds, before HttpServer starts.
 *
 * WS_SCRCPY_WEB_PORT is the ONE port override (`PORT` was retired 2026-10-04).
 * It forces that EXACT port, with no walk forward. Set by the Linux
 * system-uninstall relaunch, the systemd system unit, the Dockerfile and the
 * e2e harness.
 *   - Free: the listener binds it, and it is reported and persisted as a CHOSEN
 *     port (`portWasAutoShifted: false`) -- persisted because the handoffs read
 *     the served port back out of config.json.
 *   - Busy: the error is logged and the listener STILL targets it, so its bind
 *     fails. The exact port is the contract; falling back to config.json's port
 *     would serve somewhere the caller did not ask for. With nothing else able
 *     to bind, HttpServer exits non-zero (smoke row 12.6); with Local HTTPS up,
 *     the app degrades to HTTPS only, as for any refused HTTP bind. Reported as
 *     the port asked for, never persisted.
 *
 * Without it: detect port collision by walking forward from the configured
 * webPort until a free port is found (range = configured..+99). On shift,
 * persist the new port and flip portWasAutoShifted in firstRunStatus.
 *
 * Either way the port settled on is the port the first listener binds:
 * HttpServer.start() binds `servers[i].port` for every entry, so it is written
 * into `servers[0]` -- not only reported through setActualWebPort. Before
 * 2026-10-04 an override that differed from config.json's webPort was persisted
 * and reported, while this boot still listened on the config port.
 *
 * `servers[0]` is the HTTP listener in the flat config (buildServerList keeps
 * it at index 0; the Local HTTPS entry at index 1 keeps httpsPort). With an
 * advanced `server[]` array it is that array's FIRST entry: the override applies
 * there, as `PORT` did. Without an override, an advanced array's first port is
 * left as written unless webPort had to shift -- unchanged from before.
 *
 * Returns the port it settled on, or null when none was free.
 */
export async function reconcileWebPort(
    config: WebPortConfig,
    deps: Partial<ReconcileWebPortDeps> = {},
): Promise<number | null> {
    const env = deps.env ?? process.env;
    const findAvailablePort = deps.findAvailablePort ?? realFindAvailablePort;
    const isServiceInstance = deps.isServiceInstance ?? (() => realIsServiceInstance(env));
    const isSiblingInstance = deps.isSiblingInstance ?? ((port: number) => realIsSiblingInstance(port));
    const log = deps.log ?? Logger.for('Server');

    const override = webPortOverride(env['WS_SCRCPY_WEB_PORT']);
    const desired = override ?? config.getAppConfig().webPort;
    // An override (Phase 2 relaunch) forces the EXACT free port; else walk forward to auto-shift.
    const found = await findAvailablePort(desired, override !== null ? desired : desired + 99);
    if (found === null) {
        if (override !== null) {
            log.error(`WS_SCRCPY_WEB_PORT ${override} is busy; not walking forward (the override is exact)`);
            config.setActualWebPort(override, { persist: false, autoShifted: false });
            bindFirstListener(config, override, log);
        } else {
            log.error(`No free port available in range ${desired}..${desired + 99}`);
        }
        return null;
    }
    if (found === desired) {
        if (override !== null) {
            // Chosen, not shifted -- even when it differs from config.json.
            config.setActualWebPort(found, { autoShifted: false });
            // The override is the port this boot LISTENS on, not only the one
            // it reports.
            bindFirstListener(config, found, log);
        } else {
            // found === webPort, which the flat config's servers[0] already
            // carries; an advanced array keeps its own first port.
            config.setActualWebPort(found);
        }
        return found;
    }
    // The configured port is busy, and WHO holds it decides whether the shift
    // is persisted. Another program: yes, the user's config should follow the
    // port that works. A SIBLING instance of this app (an elevated second
    // instance): no — the configured port is right and the sibling is serving
    // it; persisting rewrote the shared config.json to a port the surviving
    // instance did not serve (measured 2026-09-06, smoke row 3.7 case b). See
    // siblingInstance.ts.
    //
    // EXCEPT when THIS process is the service instance. On the Windows
    // service-install handoff the sibling on the configured port is the
    // OUTGOING local node (ServiceApi keeps it alive ~15 s after the service
    // reports running; supervisor.rs waits only 5 s for the port), and the
    // documented handoff depends on the service PERSISTING the port it will
    // actually serve: the tray and the install poll read it from config.json.
    // So a service instance persists its shift exactly as before.
    const sibling = !isServiceInstance() && (await isSiblingInstance(desired));
    config.setActualWebPort(found, { persist: !sibling });
    log.info(
        sibling
            ? `webPort ${desired} is held by another ws-scrcpy-web instance; using ${found} for this instance without persisting it`
            : `webPort ${desired} busy; auto-shifted to ${found}`,
    );
    bindFirstListener(config, found, log);
    return found;
}

/**
 * Point the first listener at `port`. In the flat config, an HTTPS entry already
 * on that port is dropped for this boot, with the warning Config.buildServers
 * gives when config.json's webPort collides with httpsPort: HTTP wins, since only
 * one of the two could bind. An advanced `server[]` array is used as written.
 */
function bindFirstListener(config: WebPortConfig, port: number, log: Pick<ReconcileWebPortDeps['log'], 'warn'>): void {
    const servers = config.servers;
    if (servers.length === 0) return;
    servers[0]!.port = port;
    if (config.usesAdvancedServerConfig) return;
    for (let i = servers.length - 1; i >= 1; i--) {
        if (servers[i]!.secure && servers[i]!.port === port) {
            log.warn(httpsCollisionWarning(port, port));
            servers.splice(i, 1);
        }
    }
}
