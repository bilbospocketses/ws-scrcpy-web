import * as readline from 'readline';
import { VelopackApp } from 'velopack';
import { SCAN_WS_PATH } from '../common/ScanMessage';
import { AdbClient } from './AdbClient';
import { AdbDaemonManager } from './AdbDaemonManager';
import { CapabilitiesApi } from './api/CapabilitiesApi';
import { ConfigApi } from './api/ConfigApi';
import { DependencyApi } from './api/DependencyApi';
import { DeviceDiscoveryApi } from './api/DeviceDiscoveryApi';
import { ServerShutdownApi } from './api/ServerShutdownApi';
import { ServiceApi } from './api/ServiceApi';
import { UpdatesApi } from './api/UpdatesApi';
import { WhoamiApi } from './api/WhoamiApi';
import { Config } from './Config';
import { UpdateService } from './UpdateService';
import { DependencyManager } from './DependencyManager';
import { findAvailablePort } from './PortPicker';
import { DeviceLabelStore } from './DeviceLabelStore';
import { DeviceProbe } from './DeviceProbe';
import { Logger } from './Logger';
import { openBrowser } from './openBrowser';
import { HostTracker } from './mw/HostTracker';
import type { MwFactory } from './mw/Mw';
import { ScanMw } from './mw/ScanMw';
import { WebsocketMultiplexer } from './mw/WebsocketMultiplexer';
import { resolveNodePty } from './NodePtyResolver';
import { probeAdb } from './network/AdbHandshakeProbe';
import { resolveMac } from './network/MacResolver';
import { NetworkScanner } from './network/NetworkScanner';
import { ScrcpyConnection } from './ScrcpyConnection';
import { HttpServer } from './services/HttpServer';
import type { Service, ServiceClass } from './services/Service';
import { WebSocketServer } from './services/WebSocketServer';

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

const servicesToStart: ServiceClass[] = [HttpServer, WebSocketServer];

// MWs that accept WebSocket
const mwList: MwFactory[] = [ScrcpyConnection, DeviceProbe, WebsocketMultiplexer];

// MWs that accept Multiplexer
const mw2List: MwFactory[] = [HostTracker];

const runningServices: Service[] = [];

const config = Config.getInstance();

// Detect port collision: walk forward from the configured webPort until a free
// port is found (range = configured..+99). On shift, persist the new port and
// flip portWasAutoShifted in firstRunStatus.
async function reconcileWebPort(): Promise<void> {
    const desired = config.getAppConfig().webPort;
    const found = await findAvailablePort(desired, desired + 99);
    if (found === null) {
        Logger.for('Server').error(`No free port available in range ${desired}..${desired + 99}`);
        return;
    }
    config.setActualWebPort(found);
    if (found !== desired) {
        Logger.for('Server').info(`webPort ${desired} busy; auto-shifted to ${found}`);
        // Mutate the first server entry so HttpServer binds to the new port.
        if (config.servers.length > 0) {
            config.servers[0].port = found;
        }
    }
}

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

const serviceApi = new ServiceApi();
HttpServer.addApiHandler(serviceApi);

const shutdownApi = new ServerShutdownApi();
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
    labelFor: (key: string) => DeviceLabelStore.getInstance().get(key),
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
            const isServiceMode =
                appCfg.installMode === 'user-service' || appCfg.installMode === 'system-service';
            if (appCfg.firstRunComplete === false && !isServiceMode) {
                const port = config.servers[0]?.port ?? appCfg.webPort;
                openBrowser(`http://localhost:${port}`);
            }
        } catch (err) {
            Logger.for('Server').warn(`browser open check failed: ${(err as Error).message}`);
        }

        if (process.platform === 'win32') {
            readline
                .createInterface({
                    input: process.stdin,
                    output: process.stdout,
                })
                .on('SIGINT', () => exit('SIGINT'));
        }

        // Wrap so the handler receives the literal signal name. Node's
        // process.on('SIGINT', cb) DOES pass the signal name, but readline's
        // SIGINT event passes nothing — without the wrappers, exit() logged
        // "Received signal undefined" on Ctrl+C.
        process.on('SIGINT', () => exit('SIGINT'));
        process.on('SIGTERM', () => exit('SIGTERM'));

        // Kick off initial dependency check + auto-install in background (don't block startup)
        depManager
            .checkAll()
            .then(() => depManager.autoInstallMissing())
            .catch((err: Error) => Logger.for('DependencyManager').error('Initial check/install failed:', err.message));

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
    serverLog.error('Unhandled rejection:', reason instanceof Error ? reason.stack || reason.message : String(reason));
});

const EXIT_WATCHDOG_MS = 10_000;

let interrupted = false;
function exit(signal: string) {
    serverLog.info(`Received signal ${signal}`);
    if (interrupted) {
        serverLog.info('Force exit');
        process.exit(0);
        return;
    }
    interrupted = true;
    // Tear down our adb daemon on clean shutdown. We started it via
    // AdbClient.startServer; per the "own the daemon's lifetime" stance,
    // a clean SIGINT/SIGTERM should not leave the daemon orphaned holding
    // port 5037. This path is for clean exit ONLY — process.exit(75)
    // (restart-for-update) bypasses this function so the daemon stays
    // alive across supervisor-driven restarts. Fire-and-forget; the
    // watchdog below catches any hang, and a stuck adb is no worse than
    // today's behavior.
    serverLog.info('Stopping adb daemon (kill-server) ...');
    scanAdb.killServer().catch((err: Error) => {
        serverLog.warn(`adb kill-server during exit failed: ${err.message}`);
    });
    runningServices.forEach((service: Service) => {
        const serviceName = service.getName();
        serverLog.info(`Stopping ${serviceName} ...`);
        service.release();
    });
    // Watchdog: if release() side effects + event-loop drain haven't
    // brought the process down within EXIT_WATCHDOG_MS, force-exit. Without
    // this, anything pinning the loop (a stuck WS close, a long-lived setTimeout,
    // an unhandled promise) keeps Node alive indefinitely after Ctrl+C.
    // .unref() lets the timer NOT keep the loop alive itself — if release()
    // succeeds and the loop drains naturally before the timer fires, we exit
    // cleanly via the normal path.
    setTimeout(() => {
        serverLog.warn(`exit watchdog (${EXIT_WATCHDOG_MS}ms) fired — forcing process.exit(0)`);
        process.exit(0);
    }, EXIT_WATCHDOG_MS).unref();
}
