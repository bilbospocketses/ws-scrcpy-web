import * as readline from 'readline';
import { Config } from './Config';
import { DependencyManager } from './DependencyManager';
import { Logger } from './Logger';
import { DeviceProbe } from './DeviceProbe';
import { HostTracker } from './mw/HostTracker';
import type { MwFactory } from './mw/Mw';
import { ScanMw } from './mw/ScanMw';
import { WebsocketMultiplexer } from './mw/WebsocketMultiplexer';
import { ScrcpyConnection } from './ScrcpyConnection';
import { AdbClient } from './AdbClient';
import { DeviceLabelStore } from './DeviceLabelStore';
import { NetworkScanner } from './network/NetworkScanner';
import { probeAdb } from './network/AdbHandshakeProbe';
import { resolveMac } from './network/MacResolver';
import { DependencyApi } from './api/DependencyApi';
import { DeviceDiscoveryApi } from './api/DeviceDiscoveryApi';
import { HttpServer } from './services/HttpServer';
import type { Service, ServiceClass } from './services/Service';
import { WebSocketServer } from './services/WebSocketServer';
import { SCAN_WS_PATH } from '../common/ScanMessage';
import { resolveNodePty } from './NodePtyResolver';

const servicesToStart: ServiceClass[] = [HttpServer, WebSocketServer];

// MWs that accept WebSocket
const mwList: MwFactory[] = [ScrcpyConnection, DeviceProbe, WebsocketMultiplexer];

// MWs that accept Multiplexer
const mw2List: MwFactory[] = [HostTracker];

const runningServices: Service[] = [];

const config = Config.getInstance();

const depManager = new DependencyManager(config.dependenciesPath);
const depApi = new DependencyApi(depManager);
HttpServer.addApiHandler(depApi);

const discoveryApi = new DeviceDiscoveryApi();
HttpServer.addApiHandler(discoveryApi);

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

loadGoogModules()
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

        // Kick off initial dependency check in background (don't block startup)
        depManager.checkAll().catch((err: Error) => Logger.for('DependencyManager').error('Initial check failed:', err.message));
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
