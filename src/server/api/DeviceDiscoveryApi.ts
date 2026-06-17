// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import type { IncomingMessage, ServerResponse } from 'http';
import { AdbClient, parseSerialFromMdnsName } from '../AdbClient';
import { Config } from '../Config';
import { DeviceLabelStore } from '../DeviceLabelStore';
import { Logger } from '../Logger';
import { resolveMac } from '../network/MacResolver';
import { detectSubnet } from '../network/SubnetDetector';
import { assertDeletablePaths, shArg } from '../security/deviceInput';
import { BodyTooLargeError, InvalidJsonError, readJsonBodyStrict, sendInternalError } from './utils';

const log = Logger.for('DeviceDiscoveryApi');

export class DeviceDiscoveryApi {
    private adbClient: AdbClient;

    constructor() {
        this.adbClient = new AdbClient(Config.getInstance().adbPath);
    }

    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const url = req.url || '';
        if (!url.startsWith('/api/devices')) return false;

        res.setHeader('Content-Type', 'application/json');

        try {
            if (req.method === 'POST' && url === '/api/devices/scan') {
                const discovered = await this.adbClient.mdnsServices();
                const connectable = discovered.filter(
                    (d) => d.service.includes('_adb') && !d.service.includes('pairing'),
                );
                const connected = await this.adbClient.devices();
                const connectedAddresses = new Set(connected.map((d) => d.serial));
                const labelStore = DeviceLabelStore.getInstance();
                const available = connectable
                    .filter((d) => {
                        const addr = `${d.address}:${d.port}`;
                        return !connectedAddresses.has(addr);
                    })
                    .map((d) => {
                        const serial = parseSerialFromMdnsName(d.name, d.service);
                        return {
                            ...d,
                            serial,
                            label: labelStore.get(serial) || '',
                        };
                    });
                res.writeHead(200);
                res.end(JSON.stringify(available));
                return true;
            }

            if (req.method === 'GET' && url === '/api/devices/scan/subnet') {
                const detected = await detectSubnet();
                res.writeHead(200);
                res.end(JSON.stringify(detected));
                return true;
            }

            if (req.method === 'POST' && url === '/api/devices/connect') {
                const { address, serial, label } = await readJsonBodyStrict<{
                    address?: string;
                    serial?: string;
                    label?: string;
                }>(req);
                if (!address) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'address is required' }));
                    return true;
                }
                // mDNS path: serial is known upfront, save the label before connecting.
                if (serial && label) {
                    DeviceLabelStore.getInstance().set(serial, label);
                }
                const result = await this.adbClient.connect(address);
                const success = result.includes('connected');
                log.info(`connect ${address} → ${success ? 'OK' : 'FAIL'}: ${result.trim().replace(/\s+/g, ' ')}`);
                if (success && label) {
                    // Persist the label under the device's real serial AND its MAC.
                    // Storing under both keys lets future scans (which may only have
                    // MAC from ARP — no serial without racing adb) still rehydrate
                    // the label. Only applies when the user provided a label on this
                    // connect; otherwise nothing to persist.
                    try {
                        let realSerial = serial;
                        if (!realSerial) {
                            const lookedUp = (await this.adbClient.shell(address, 'getprop ro.serialno')).trim();
                            if (lookedUp) realSerial = lookedUp;
                        }
                        if (realSerial) {
                            DeviceLabelStore.getInstance().set(realSerial, label);
                        }
                        const ip = address.split(':')[0]!;
                        const mac = await resolveMac(ip);
                        if (mac) {
                            DeviceLabelStore.getInstance().set(mac, label);
                        }
                    } catch {
                        // Serial or MAC lookup failed — partial persist is OK;
                        // user can edit label later from the card.
                    }
                }
                res.writeHead(success ? 200 : 500);
                res.end(JSON.stringify({ success, message: result.trim() }));
                return true;
            }

            if (req.method === 'POST' && url === '/api/devices/disconnect') {
                const { address } = await readJsonBodyStrict<{ address?: string }>(req);
                if (!address) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'address is required' }));
                    return true;
                }
                const result = await this.adbClient.disconnect(address);
                const success = result.includes('disconnected');
                res.writeHead(success ? 200 : 500);
                res.end(JSON.stringify({ success, message: result.trim() }));
                return true;
            }

            if (req.method === 'GET' && url.startsWith('/api/devices/screen-state')) {
                const parsedUrl = new URL(url, `http://${req.headers.host}`);
                const udid = parsedUrl.searchParams.get('udid');
                if (!udid) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'udid is required' }));
                    return true;
                }
                const output = await this.adbClient.shell(udid, 'dumpsys power 2>/dev/null | grep mWakefulness');
                const awake = output.includes('Awake');
                res.writeHead(200);
                res.end(JSON.stringify({ awake }));
                return true;
            }

            if (req.method === 'POST' && url === '/api/devices/sleep-wake') {
                const { udid, action } = await readJsonBodyStrict<{ udid?: string; action?: string }>(req);
                if (!udid || !action) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'udid and action are required' }));
                    return true;
                }
                const keyevent = action === 'sleep' ? 223 : 224;
                await this.adbClient.shell(udid, `input keyevent ${keyevent}`);
                // Re-check state after a brief delay for the device to respond
                await new Promise((r) => setTimeout(r, 500));
                const output = await this.adbClient.shell(udid, 'dumpsys power 2>/dev/null | grep mWakefulness');
                const awake = output.includes('Awake');
                res.writeHead(200);
                res.end(JSON.stringify({ awake }));
                return true;
            }

            if (req.method === 'GET' && url === '/api/devices/labels') {
                const labels = DeviceLabelStore.getInstance().getAll();
                res.writeHead(200);
                res.end(JSON.stringify(labels));
                return true;
            }

            if (req.method === 'PUT' && url === '/api/devices/labels') {
                const { serial, label } = await readJsonBodyStrict<{ serial?: string; label?: string }>(req);
                if (!serial) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'serial is required' }));
                    return true;
                }
                const store = DeviceLabelStore.getInstance();
                if (label) {
                    store.set(serial, label);
                } else {
                    store.delete(serial);
                }
                res.writeHead(200);
                res.end(JSON.stringify({ success: true }));
                return true;
            }

            if (req.method === 'POST' && url === '/api/devices/files/delete') {
                const { udid, paths } = await readJsonBodyStrict<{ udid?: string; paths?: unknown }>(req);
                if (!udid) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'udid is required' }));
                    return true;
                }
                let safePaths: string[];
                try {
                    // Bound + validate the targets before any privileged delete:
                    // refuses unbounded lists, traversal, and catastrophic roots
                    // (/sdcard, /data, …). udid is serial-checked by adbClient.
                    safePaths = assertDeletablePaths(paths);
                } catch (e) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: (e as Error).message }));
                    return true;
                }
                const errors: { path: string; error: string }[] = [];
                for (const filePath of safePaths) {
                    try {
                        await this.adbClient.shell(udid, `rm -rf ${shArg(filePath)}`);
                    } catch (err) {
                        errors.push({ path: filePath, error: (err as Error).message });
                    }
                }
                const success = errors.length === 0;
                res.writeHead(success ? 200 : 207);
                res.end(JSON.stringify({ success, errors: errors.length > 0 ? errors : undefined }));
                return true;
            }

            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Not found' }));
            return true;
        } catch (err: any) {
            if (err instanceof BodyTooLargeError) {
                res.writeHead(413);
                res.end(JSON.stringify({ error: 'request body too large' }));
                return true;
            }
            if (err instanceof InvalidJsonError) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'invalid JSON body' }));
                return true;
            }
            log.error(`${req.method} ${req.url} threw: ${err?.message ?? String(err)}`);
            sendInternalError(res);
            return true;
        }
    }
}
