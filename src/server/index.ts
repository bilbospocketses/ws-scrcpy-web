import * as readline from 'readline';
import * as net from 'net';
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
import { NetworkScanner } from './network/NetworkScanner';
import { DependencyApi } from './api/DependencyApi';
import { DeviceDiscoveryApi } from './api/DeviceDiscoveryApi';
import { HttpServer } from './services/HttpServer';
import type { Service, ServiceClass } from './services/Service';
import { WebSocketServer } from './services/WebSocketServer';

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
function tcpProbe5555(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const socket = new net.Socket();
        let settled = false;
        const done = (open: boolean) => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch { /* ignore */ }
            resolve(open);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
        socket.connect(port, host);
    });
}

const scanAdb = new AdbClient(config.adbPath);
const scanner = new NetworkScanner({
    adbDevices: () => scanAdb.devices(),
    adbMdnsServices: () => scanAdb.mdnsServices(),
    adbConnect: (addr: string) => scanAdb.connect(addr),
    adbDisconnect: (addr: string) => scanAdb.disconnect(addr),
    tcpProbe: tcpProbe5555,
    concurrency: 64,
    progressInterval: 10,
    tcpTimeoutMs: 300,
    adbConnectTimeoutMs: 3000,
});
ScanMw.setScanner(scanner);

async function loadGoogModules() {
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

        wsService.registerPathHandler('/ws-scan', (ws) => ScanMw.attach(ws));

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
