import { ACTION } from '../../common/Action';
import type { ProbeResult } from '../../common/ProbeResult';

export class DeviceProbeClient {
    static probe(udid: string, baseUrl?: { hostname: string; port: number; secure: boolean }): Promise<ProbeResult> {
        return new Promise((resolve, reject) => {
            const host = baseUrl?.hostname || window.location.hostname;
            const port = baseUrl?.port || Number.parseInt(window.location.port, 10) || (baseUrl?.secure ? 443 : 80);
            const protocol = baseUrl?.secure ? 'wss' : 'ws';
            const url = new URL(`${protocol}://${host}:${port}/`);
            url.searchParams.set('action', ACTION.PROBE_DEVICE);
            url.searchParams.set('udid', udid);

            const ws = new WebSocket(url.toString());
            let received = false;

            ws.onmessage = (event) => {
                try {
                    const result: ProbeResult = JSON.parse(event.data as string);
                    received = true;
                    resolve(result);
                } catch (err) {
                    reject(new Error(`Invalid probe response: ${err}`));
                }
            };

            ws.onerror = () => {
                if (!received) reject(new Error('Probe WebSocket error'));
            };

            ws.onclose = (event) => {
                if (!received) reject(new Error(`Probe closed without response: ${event.code}`));
            };
        });
    }
}
