import { describe, expect, it } from 'vitest';
import * as http from 'http';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { ScanMw } from '../mw/ScanMw';
import { NetworkScanner } from '../network/NetworkScanner';
import { SCAN_WS_PATH } from '../../common/ScanMessage';

async function collectMessages(ws: WebSocket, until: (msg: any) => boolean): Promise<any[]> {
    return new Promise((resolve, reject) => {
        const msgs: any[] = [];
        const timer = setTimeout(() => reject(new Error('timeout')), 5000);
        ws.on('message', (data: Buffer) => {
            const msg = JSON.parse(data.toString());
            msgs.push(msg);
            if (until(msg)) {
                clearTimeout(timer);
                resolve(msgs);
            }
        });
    });
}

describe('ScanMw integration', () => {
    it('accepts scan.start and streams through to scan.complete', async () => {
        const scanner = new NetworkScanner({
            adbDevices: async () => [],
            adbMdnsServices: async () => [],
            adbHandshakeProbe: async () => ({ isAdb: false }),
            concurrency: 4,
            progressInterval: 10,
        });
        ScanMw.setScanner(scanner);

        const server = http.createServer();
        const wss = new WebSocketServer({ server });
        wss.on('connection', (ws, req) => {
            if (req.url === SCAN_WS_PATH) ScanMw.attach(ws);
        });
        await new Promise<void>((r) => server.listen(0, r));
        const port = (server.address() as any).port;

        const client = new WebSocket(`ws://127.0.0.1:${port}${SCAN_WS_PATH}`);
        await new Promise<void>((r) => client.once('open', r));

        const collected = collectMessages(client, (m) => m.type === 'scan.complete');
        client.send(JSON.stringify({ type: 'scan.start', subnets: ['192.168.1.0/30'] }));
        const messages = await collected;

        expect(messages[0].type).toBe('scan.started');
        expect(messages.at(-1).type).toBe('scan.complete');

        client.close();
        await new Promise<void>((r) => wss.close(() => server.close(() => r())));
    });

    it('rejects scan.start with invalid subnets', async () => {
        const scanner = new NetworkScanner({
            adbDevices: async () => [],
            adbMdnsServices: async () => [],
            adbHandshakeProbe: async () => ({ isAdb: false }),
            concurrency: 4,
            progressInterval: 10,
        });
        ScanMw.setScanner(scanner);

        const server = http.createServer();
        const wss = new WebSocketServer({ server });
        wss.on('connection', (ws, req) => {
            if (req.url === SCAN_WS_PATH) ScanMw.attach(ws);
        });
        await new Promise<void>((r) => server.listen(0, r));
        const port = (server.address() as any).port;

        const client = new WebSocket(`ws://127.0.0.1:${port}${SCAN_WS_PATH}`);
        await new Promise<void>((r) => client.once('open', r));

        const collected = collectMessages(client, (m) => m.type === 'scan.error');
        client.send(JSON.stringify({ type: 'scan.start', subnets: ['garbage'] }));
        const messages = await collected;

        expect(messages[0].type).toBe('scan.error');
        expect((messages[0] as any).details).toBeDefined();

        client.close();
        await new Promise<void>((r) => wss.close(() => server.close(() => r())));
    });
});
