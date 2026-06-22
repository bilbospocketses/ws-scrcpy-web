import { VelopackApp } from 'velopack';
import { SCAN_WS_PATH } from '../common/ScanMessage';
import { AdbClient } from './AdbClient';
import { AdbDaemonManager } from './AdbDaemonManager';
import { AuthApi } from './api/AuthApi';
import { UsersApi } from './api/UsersApi';
import { CapabilitiesApi } from './api/CapabilitiesApi';
import { ConfigApi } from './api/ConfigApi';
import { DependencyApi } from './api/DependencyApi';
import { DeviceDiscoveryApi } from './api/DeviceDiscoveryApi';
import { ServerShutdownApi } from './api/ServerShutdownApi';
import { ServiceApi } from './api/ServiceApi';
import { SettingsApi } from './api/SettingsApi';
import { UpdatesApi } from './api/UpdatesApi';
import { WhoamiApi } from './api/WhoamiApi';
import { Config } from './Config';
import { DependencyManager } from './DependencyManager';
import { DeviceProbe } from './DeviceProbe';
import { IMPLICIT_ADMIN_ID } from './db/constants';
import { Logger } from './Logger';
import { HostTracker } from './mw/HostTracker';
import type { MwFactory } from './mw/Mw';
import { ScanMw } from './mw/ScanMw';
import { WebsocketMultiplexer } from './mw/WebsocketMultiplexer';
import { resolveNodePty } from './NodePtyResolver';
import { probeAdb } from './network/AdbHandshakeProbe';
import { resolveMac } from './network/MacResolver';
import { NetworkScanner } from './network/NetworkScanner';
import { consumeSuppressBrowserMarker, openBrowser, shouldAutoOpenBrowser } from './openBrowser';
import { findAvailablePort, webPortOverride } from './PortPicker';
import { ScrcpyConnection } from './ScrcpyConnection';
import { AuthGate } from './auth/AuthGate';
import { setAllowedHosts } from './security/originGuard';
import { makeProductionCoreDeps, parseSystemServiceArgs, runSystemServiceCli } from './service/systemServiceCli';
import { HttpServer } from './services/HttpServer';
import type { Service, ServiceClass } from './services/Service';
import { WebSocketServer } from './services/WebSocketServer';
import { reapStrayAdbOnWindows } from './shutdownHelpers';
import { UpdateService } from './UpdateService';
import { forceBlockingStdio } from './util/forceBlockingStdio';

// Velopack JS SDK init must run before any other side-effecting startup logic.
// In dev mode (no install layout) this returns gracefully without altering state.
//
// `setAutoApplyOnStartup(false)` is critical: the JS SDK's default is `true`,
// which auto-fires `Update.exe apply` on every Node startup if a previously-
// staged nupkg exists in `<localappdata>\<AppId>\packages\`. v0.1.23-beta.1
// → beta.2 testing showed this caused an infinite Update.exe / UAC loop after
// any failed apply: the staged package stayed, and every subsequent app
// launch auto-fired Update.exe again, prompting UAC every time. Apply must
// be triggered exclusively by an explicit user click via
// UpdateService.applyUpdate so users can recover from a stuck swap by
// closing the app, instead of being trapped in a re-fire loop.
try {
    VelopackApp.build().setAutoApplyOnStartup(false).run();
} catch (err) {
    Logger.for('Velopack').warn(`VelopackApp.build().run() failed: ${(err as Error)?.message ?? String(err)}`);
}

// One-shot privileged mode: if --install-system-service / --uninstall-system-service
// / --system-service-status is present, execute the op and exit. Never start the
// HTTP/WS server. Velopack.run() above must still fire first (Velopack update
// hooks must be registered before any other startup logic per SDK contract).
const __ssArgs = parseSystemServiceArgs(process.argv);
if (__ssArgs) {
    runSystemServiceCli(__ssArgs, makeProductionCoreDeps())
        .then((code) => process.exit(code))
        .catch((err) => {
            console.error(String((err as Error)?.message ?? err));
            process.exit(1);
        });
} else {
    // ---------------------------------------------------------------------------
    // Normal server startup — only reached when no system-service CLI flag given.
    // ---------------------------------------------------------------------------

    const servicesToStart: ServiceClass[] = [HttpServer, WebSocketServer];

    // MWs that accept WebSocket
    const mwList: MwFactory[] = [ScrcpyConnection, DeviceProbe, WebsocketMultiplexer];

    // MWs that accept Multiplexer
    const mw2List: MwFactory[] = [HostTracker];

    const runningServices: Service[] = [];

    const config = Config.getInstance();

    // Apply the operator-configured Host allowlist to the security layer before
    // any server starts accepting requests. Empty by default (localhost + IP
    // literals only); a config.json `allowedHosts` opts a domain/reverse-proxy
    // deployment in. See docs/SECURITY.md.
    setAllowedHosts(config.allowedHosts);

    // Detect port collision: walk forward from the configured webPort until a free
    // port is found (range = configured..+99). On shift, persist the new port and
    // flip portWasAutoShifted in firstRunStatus.
    async function reconcileWebPort(): Promise<void> {
        const override = webPortOverride(process.env['WS_SCRCPY_WEB_PORT']);
        const desired = override ?? config.getAppConfig().webPort;
        // An override (Phase 2 relaunch) forces the EXACT free port; else walk forward to auto-shift.
        const found = await findAvailablePort(desired, override !== null ? desired : desired + 99);
        if (found === null) {
            Logger.for('Server').error(`No free port available in range ${desired}..${desired + 99}`);
            return;
        }
        config.setActualWebPort(found);
        if (found !== desired) {
            Logger.for('Server').info(`webPort ${desired} busy; auto-shifted to ${found}`);
            // Mutate the first server entry so HttpServer binds to the new port.
            if (config.servers.length > 0) {
                config.servers[0]!.port = found;
            }
        }
    }

    HttpServer.addFirstApiHandler(new AuthGate(() => Config.getInstance().db));

    HttpServer.addApiHandler(new AuthApi());
    HttpServer.addApiHandler(new UsersApi());

    const depManager = new DependencyManager(config.dependenciesPath, {
        restartMarkerPath: config.restartMarkerPath,
    });
    const depApi = new DependencyApi(depManager);
    HttpServer.addApiHandler(depApi);

    const discoveryApi = new DeviceDiscoveryApi();
    HttpServer.addApiHandler(discoveryApi);

    const capabilitiesApi = new CapabilitiesApi();
    HttpServer.addApiHandler(capabilitiesApi);

    const configApi = new ConfigApi();
    HttpServer.addApiHandler(configApi);

    const settingsApi = new SettingsApi();
    HttpServer.addApiHandler(settingsApi);

    const serviceApi = new ServiceApi();
    HttpServer.addApiHandler(serviceApi);

    const shutdownApi = new ServerShutdownApi({
        // SE-3: flush stdio to blocking BEFORE the teardown logs run so a button/
        // tray quit's "Stopping ..." lines reach the console (Windows TTY
        // async-drop), matching the signal-quit path in exit().
        cleanup: async () => {
            forceBlockingStdio();
            await gracefulShutdown();
        },
    });
    HttpServer.addApiHandler(shutdownApi);

    const updateService = new UpdateService();
    updateService.init();
    const updatesApi = new UpdatesApi(updateService);
    HttpServer.addApiHandler(updatesApi);

    const whoamiApi = new WhoamiApi();
    HttpServer.addApiHandler(whoamiApi);

    // Wire the scanner singleton
    const scanAdb = new AdbClient(config.adbPath);

    // Kick the daemon spawn at module load so it's already up (or in-flight) by
    // the time anything async — port reconciliation, depManager checks, the WS
    // server, ControlCenter.init's first `adb devices` — needs it. Fire-and-forget;
    // the manager's single-flight ensures other early adb callers (every
    // AdbClient method awaits ensureReady() internally) share this one spawn
    // rather than racing fresh ones. 5min internal binary-wait covers a cold
    // first-install download.
    const adbDaemon = AdbDaemonManager.getInstance(config.adbPath);
    void (async () => {
        const log = Logger.for('AdbClient');
        try {
            await adbDaemon.ensureReady();
            log.info('daemon pre-warmed at startup');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`startup pre-warm failed: ${msg}; scan-time defense will retry`);
        }
    })();

    const scanner = new NetworkScanner({
        adbDevices: () => scanAdb.devices(),
        adbMdnsServices: () => scanAdb.mdnsServices(),
        adbHandshakeProbe: probeAdb,
        // Scan-time short-circuit: race the manager's in-flight (or fresh) spawn
        // against a 5s deadline. If the binary isn't on disk and the manager's
        // internal binary-wait is still polling, this surfaces a clean
        // scan.error toast within 5s instead of blocking the user for the
        // manager's full 5min budget. Single-flight in the manager means this
        // call shares the spawn with the module-load pre-warm above — no second
        // adb process is launched.
        adbStartServer: () => adbDaemon.ensureReady({ waitMs: 5_000 }),
        resolveMac,
        labelFor: (key: string) => config.db.devices.getLabel(IMPLICIT_ADMIN_ID, key),
        concurrency: config.scanConcurrency,
        progressInterval: config.scanProgressInterval,
        tcpTimeoutMs: config.scanTcpTimeoutMs,
        handshakeTimeoutMs: config.scanAdbConnectTimeoutMs,
    });
    ScanMw.setScanner(scanner);

    async function loadGoogModules() {
        // Resolve node-pty. If unavailable, shell modal will be disabled client-side
        // via /api/capabilities (added in Task 5). Server still starts; don't block on this.
        await resolveNodePty(config.dependenciesPath);

        const { ControlCenter } = await import('./goog-device/services/ControlCenter');
        const { DeviceTracker } = await import('./goog-device/mw/DeviceTracker');

        if (config.runLocalGoogTracker) {
            mw2List.push(DeviceTracker);
        }

        if (config.announceLocalGoogTracker) {
            HostTracker.registerLocalTracker(DeviceTracker);
        }

        servicesToStart.push(ControlCenter);

        const { RemoteShell } = await import('./goog-device/mw/RemoteShell');
        mw2List.push(RemoteShell);

        const { FileListing } = await import('./goog-device/mw/FileListing');
        mw2List.push(FileListing);
    }

    reconcileWebPort()
        .then(() => loadGoogModules())
        .then(() => {
            return servicesToStart.map((serviceClass: ServiceClass) => {
                const service = serviceClass.getInstance();
                runningServices.push(service);
                return service.start();
            });
        })
        .then(() => {
            const wsService = WebSocketServer.getInstance();
            mwList.forEach((mwFactory: MwFactory) => {
                wsService.registerMw(mwFactory);
            });

            mw2List.forEach((mwFactory: MwFactory) => {
                WebsocketMultiplexer.registerMw(mwFactory);
            });

            wsService.registerPathHandler(SCAN_WS_PATH, (ws) => ScanMw.attach(ws));

            // v0.1.9: auto-open browser on FIRST run, but only when this
            // is a normal user instance (not running as a service —
            // service instances run in session 0 and shouldn't open a
            // browser at all; users hit them via the URL after install
            // handoff redirects them). The open is best-effort; failure
            // to find xdg-open / cmd.exe is logged and ignored.
            try {
                const appCfg = config.getAppConfig();
                const isServiceMode = appCfg.installMode === 'user-service' || appCfg.installMode === 'system-service';
                // G1: a relaunch (the post-machine-wide-install /opt re-exec, or an
                // in-app update relaunch) sets WS_SCRCPY_NO_BROWSER=1 — the user
                // already has a tab that reconnects, so don't pop a redundant one.
                const noBrowserEnv = process.env['WS_SCRCPY_NO_BROWSER'] === '1';
                // D4: a Velopack update-relaunch (Windows local mode) carries no
                // WS_SCRCPY_NO_BROWSER, so applyUpdate left a consume-once marker —
                // honor + delete it so the post-update relaunch doesn't pop a 2nd tab
                // on top of the user's reconnecting one.
                const postUpdateRelaunch = consumeSuppressBrowserMarker(config.suppressBrowserOpenMarkerPath);
                const suppressBrowser = noBrowserEnv || postUpdateRelaunch;
                // D1: the native launcher's supervisor sets WS_SCRCPY_OPEN_BROWSER=1
                // on its FIRST Node spawn (a fresh user launch), so a cold start past
                // first-run still opens a tab — not only on first run. Supervisor
                // restarts (webPort change, crash) don't set it, so they don't re-pop
                // a tab; dev (no launcher) falls back to the first-run-only open.
                const launcherFreshLaunch = process.env['WS_SCRCPY_OPEN_BROWSER'] === '1';
                if (
                    shouldAutoOpenBrowser({
                        firstRunComplete: appCfg.firstRunComplete,
                        isServiceMode,
                        suppressBrowser,
                        launcherFreshLaunch,
                    })
                ) {
                    const port = config.servers[0]?.port ?? appCfg.webPort;
                    openBrowser(`http://localhost:${port}`);
                }
            } catch (err) {
                Logger.for('Server').warn(`browser open check failed: ${(err as Error).message}`);
            }

            // `process.on('SIGINT')` fires on Ctrl+C on modern Node (≥10) on
            // Windows too, so the older `readline.createInterface()` workaround
            // for win32 Ctrl+C detection has been removed. Keeping it actively
            // HURT shutdown: the readline interface listens on `process.stdin`
            // (flowing mode), which ref'd the ReadStream to the event loop and
            // prevented natural drain on `exit()` — the 10s exit watchdog
            // fired on every Ctrl+C as a result. Root cause confirmed
            // 2026-05-15 via active-handles dump in the watchdog path
            // (handle[2] ReadStream fd=0 was the lingerer).
            //
            // Wrap so the handler receives the literal signal name (the
            // `cb` already gets it from Node).
            process.on('SIGINT', () => exit('SIGINT'));
            process.on('SIGTERM', () => exit('SIGTERM'));

            // Kick off initial dependency check + auto-install in background (don't block startup)
            depManager
                .checkAll()
                .then(() => depManager.autoInstallMissing())
                .catch((err: Error) =>
                    Logger.for('DependencyManager').error('Initial check/install failed:', err.message),
                );

            // adb daemon pre-warm has been moved to module load (right after the
            // scanAdb singleton is constructed). All AdbClient methods await
            // `daemon.ensureReady()` internally, so post-port-reconcile callers
            // (ControlCenter.init's first `adb devices`, scanner workers, the
            // exit-handler's `killServer`) all transparently share the manager's
            // single-flight spawn rather than fanning out N parallel races.
        })
        .catch((error) => {
            Logger.for('Server').error(error.message);
            exit('1');
        });

    const serverLog = Logger.for('Server');

    process.on('uncaughtException', (err) => {
        serverLog.error('Uncaught exception:', err.stack || err.message);
        process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
        serverLog.error(
            'Unhandled rejection:',
            reason instanceof Error ? reason.stack || reason.message : String(reason),
        );
    });

    const EXIT_WATCHDOG_MS = 10_000;

    let cleanupStarted = false;
    /**
     * Shared graceful teardown: stop the adb daemon we own + release running
     * services. Idempotent so the SIGINT/SIGTERM handler and the
     * /api/server/shutdown path (Settings "stop server & exit" button / Windows
     * tray) can both call it without double-teardown. The shutdown API awaits it
     * before process.exit(0); the signal handler fires it best-effort and relies
     * on the exit watchdog below. NOT used on the exit-75 restart-for-update path,
     * which deliberately keeps the adb daemon alive across supervisor-driven
     * restarts.
     */
    async function gracefulShutdown(): Promise<void> {
        if (cleanupStarted) return;
        cleanupStarted = true;
        serverLog.info('Stopping adb daemon (kill-server) ...');
        try {
            await scanAdb.killServer();
        } catch (err) {
            serverLog.warn(`adb kill-server during exit failed: ${(err as Error).message}`);
        }
        // taskkill is the Windows-only reaper (reapStrayAdbOnWindows no-ops elsewhere);
        // only log it where it actually runs, so Linux/macOS logs don't carry a
        // Windows-command line that does nothing.
        if (process.platform === 'win32') {
            serverLog.info('Stopping stray adb (taskkill) ...');
        }
        await reapStrayAdbOnWindows();
        runningServices.forEach((service: Service) => {
            const serviceName = service.getName();
            serverLog.info(`Stopping ${serviceName} ...`);
            service.release();
        });
        // Snapshot the SQLite store on a clean shutdown — the last-good `.bak`
        // the corrupt-recovery path restores from. Best-effort; never block exit.
        try {
            const db = config.db;
            db.backup(`${db.dbPath}.bak`);
        } catch (err) {
            serverLog.warn(`db backup on shutdown failed: ${(err as Error).message}`);
        }
    }

    let interrupted = false;
    function exit(signal: string) {
        // Flush stdout/stderr to blocking so every teardown line reaches the
        // console before exit (Windows TTY async-drop). Same helper the button/
        // tray-quit path uses (ServerShutdownApi cleanup) — see forceBlockingStdio.
        forceBlockingStdio();
        serverLog.info(`Received signal ${signal}`);
        if (interrupted) {
            serverLog.info('Force exit');
            process.exit(0);
        }
        interrupted = true;
        // Fire-and-forget the shared teardown (idempotent — the /api/server/shutdown
        // path may have already run it). The 2000ms hold + watchdog below backstop
        // any hang. process.exit(75) (restart-for-update) bypasses this function
        // entirely, so the daemon stays alive across supervisor-driven restarts —
        // see gracefulShutdown's doc.
        void gracefulShutdown();
        // forceBlockingStdio() at the top of exit() makes the console.log calls in
        // serverLog / Logger synchronous-to-the-TTY, so by the time control
        // reaches here every "Stopping X" line is already on the console.
        //
        // Deliberate 2000ms pause before letting the event loop drain. With
        // 2f0b7d2's supervisor fix, native shutdown now finishes in 10s of
        // ms — fast enough that PowerShell redraws its prompt mid-output
        // (PS shows the prompt as soon as the npm.cmd batch wrapper
        // acknowledges Ctrl+C, well before our supervisor + child have
        // actually exited). The 2000ms ref'd timer holds the loop alive
        // long enough for the prompt-redraw to settle on top of completed
        // output. No correctness cost — if any service.release() side
        // effect runs longer than 2000ms, the 10s watchdog below still
        // backstops. Per user direction 2026-05-15.
        setTimeout(() => {
            /* no-op; ref'd 2000ms hold for prompt-settle */
        }, 2000);
        // Watchdog: if release() side effects + event-loop drain haven't
        // brought the process down within EXIT_WATCHDOG_MS, force-exit. Without
        // this, anything pinning the loop (a stuck WS close, a long-lived setTimeout,
        // an unhandled promise) keeps Node alive indefinitely after Ctrl+C.
        // .unref() lets the timer NOT keep the loop alive itself — if release()
        // succeeds and the loop drains naturally before the timer fires, we exit
        // cleanly via the normal path.
        setTimeout(() => {
            // Diagnostic: dump active handles + requests so we can see what
            // pinned the event loop. Only fires if synchronous teardown +
            // natural drain didn't finish within EXIT_WATCHDOG_MS — should be
            // never once all service.release() implementations cleanly close
            // their resources. Permanent instrumentation: small log noise vs
            // zero diagnostic info on future regressions.
            try {
                const proc = process as unknown as {
                    _getActiveHandles: () => unknown[];
                    _getActiveRequests: () => unknown[];
                };
                const handles = proc._getActiveHandles();
                const requests = proc._getActiveRequests();
                serverLog.warn(
                    `exit watchdog (${EXIT_WATCHDOG_MS}ms) fired — ${handles.length} active handles, ${requests.length} active requests`,
                );
                handles.forEach((h, i) => {
                    const ctor = (h as { constructor?: { name?: string } }).constructor?.name ?? 'unknown';
                    let detail = '';
                    try {
                        const handle = h as Record<string, unknown>;
                        if (typeof handle['address'] === 'function') {
                            try {
                                detail += ` addr=${JSON.stringify((handle['address'] as () => unknown)())}`;
                            } catch {
                                /* address() may throw on closed sockets */
                            }
                        }
                        if (handle['fd'] !== undefined) detail += ` fd=${handle['fd']}`;
                        if (handle['spawnfile']) detail += ` spawnfile=${handle['spawnfile'] as string}`;
                        if (handle['path']) detail += ` path=${handle['path'] as string}`;
                        if (typeof handle['_idleTimeout'] === 'number' && handle['_idleTimeout'] > 0) {
                            detail += ` timeoutMs=${handle['_idleTimeout']}`;
                        }
                    } catch {
                        /* best-effort property extraction */
                    }
                    serverLog.warn(`  handle[${i}] ${ctor}${detail}`);
                });
                requests.forEach((r, i) => {
                    const ctor = (r as { constructor?: { name?: string } }).constructor?.name ?? 'unknown';
                    serverLog.warn(`  request[${i}] ${ctor}`);
                });
            } catch (err) {
                serverLog.warn(
                    `exit-watchdog diagnostic dump failed: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
            serverLog.warn('forcing process.exit(0)');
            process.exit(0);
        }, EXIT_WATCHDOG_MS).unref();
    }
}
