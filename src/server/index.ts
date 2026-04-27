import * as readline from 'readline';
import { VelopackApp } from 'velopack';
import { SCAN_WS_PATH } from '../common/ScanMessage';
import { AdbClient } from './AdbClient';
import { CapabilitiesApi } from './api/CapabilitiesApi';
import { ConfigApi } from './api/ConfigApi';
import { DependencyApi } from './api/DependencyApi';
import { DeviceDiscoveryApi } from './api/DeviceDiscoveryApi';
import { ServerShutdownApi } from './api/ServerShutdownApi';
import { ServiceApi } from './api/ServiceApi';
import { Config } from './Config';
import { DependencyManager } from './DependencyManager';
import { findAvailablePort } from './PortPicker';
import { DeviceLabelStore } from './DeviceLabelStore';
import { DeviceProbe } from './DeviceProbe';
import { Logger } from './Logger';
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
try {
    VelopackApp.build().run();
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

const depManager = new DependencyManager(config.dependenciesPath);
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

// Wire the scanner singleton
const scanAdb = new AdbClient(config.adbPath);
const scanner = new NetworkScanner({
    adbDevices: () => scanAdb.devices(),
    adbMdnsServices: () => scanAdb.mdnsServices(),
    adbHandshakeProbe: probeAdb,
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

        if (process.platform === 'win32') {
            readline
                .createInterface({
                    input: process.stdin,
                    output: process.stdout,
                })
                .on('SIGINT', exit);
        }

        process.on('SIGINT', exit);
        process.on('SIGTERM', exit);

        // Kick off initial dependency check + auto-install in background (don't block startup)
        depManager
            .checkAll()
            .then(() => depManager.autoInstallMissing())
            .catch((err: Error) => Logger.for('DependencyManager').error('Initial check/install failed:', err.message));
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

let interrupted = false;
function exit(signal: string) {
    serverLog.info(`Received signal ${signal}`);
    if (interrupted) {
        serverLog.info('Force exit');
        process.exit(0);
        return;
    }
    interrupted = true;
    runningServices.forEach((service: Service) => {
        const serviceName = service.getName();
        serverLog.info(`Stopping ${serviceName} ...`);
        service.release();
    });
}
