import * as readline from 'readline';
import { Config } from './Config';
import { DeviceProbe } from './DeviceProbe';
import { HostTracker } from './mw/HostTracker';
import type { MwFactory } from './mw/Mw';
import { WebsocketMultiplexer } from './mw/WebsocketMultiplexer';
import { ScrcpyConnection } from './ScrcpyConnection';
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
    })
    .catch((error) => {
        console.error(error.message);
        exit('1');
    });

let interrupted = false;
function exit(signal: string) {
    console.log(`\nReceived signal ${signal}`);
    if (interrupted) {
        console.log('Force exit');
        process.exit(0);
        return;
    }
    interrupted = true;
    runningServices.forEach((service: Service) => {
        const serviceName = service.getName();
        console.log(`Stopping ${serviceName} ...`);
        service.release();
    });
}
