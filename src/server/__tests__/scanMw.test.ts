import * as http from 'http';
import { describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { SCAN_WS_PATH } from '../../common/ScanMessage';
import { ScanMw } from '../mw/ScanMw';
import { NetworkScanner } from '../network/NetworkScanner';

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

    it('accepts mdnsOnly scan.start with empty subnets and streams to scan.complete', async () => {
        const scanner = new NetworkScanner({
            adbDevices: async () => [],
            adbMdnsServices: async () => [
                {
                    name: 'adb-ABCD._adb-tls-connect._tcp.local.',
                    service: '_adb-tls-connect._tcp.',
                    address: '10.0.0.5',
                    port: 5555,
                },
            ],
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
        client.send(JSON.stringify({ type: 'scan.start', subnets: [], mdnsOnly: true }));
        const messages = await collected;

        expect(messages[0].type).toBe('scan.started');
        expect((messages[0] as any).totalHosts).toBe(0);
        expect(messages.some((m: any) => m.type === 'scan.hit' && m.source === 'mdns')).toBe(true);
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

    it('rejects scan.start targeting a public (non-RFC1918) subnet (SSRF guard)', async () => {
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
        client.send(JSON.stringify({ type: 'scan.start', subnets: ['8.8.8.0/24'] }));
        const messages = await collected;

        expect(messages[0].type).toBe('scan.error');
        expect((messages[0] as any).details?.[0]?.error).toMatch(/private|RFC ?1918/i);

        client.close();
        await new Promise<void>((r) => wss.close(() => server.close(() => r())));
    });

    it('rejects scan.start with a missing/non-array subnets field instead of throwing', async () => {
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
        // A scan.start with no `subnets` key must yield scan.error, not crash the
        // ws message handler with a `for…of undefined` TypeError. (#75)
        client.send(JSON.stringify({ type: 'scan.start' }));
        const messages = await collected;

        expect(messages[0].type).toBe('scan.error');

        client.close();
        await new Promise<void>((r) => wss.close(() => server.close(() => r())));
    });
});
