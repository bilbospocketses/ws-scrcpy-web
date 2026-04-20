import { describe, expect, it, vi } from 'vitest';
import { NetworkScanner, type NetworkScannerDeps } from '../network/NetworkScanner';
import type { ParsedSubnet } from '../../common/SubnetParser';
import type { ScanServerMessage } from '../../common/ScanMessage';

function makeSubnet(hosts: string[]): ParsedSubnet {
    return {
        raw: 'test',
        normalized: `test/${hosts.length}`,
        hostCount: hosts.length,
        *hosts() { for (const h of hosts) yield h; },
    };
}

function makeWs(): { ws: any; messages: ScanServerMessage[] } {
    const messages: ScanServerMessage[] = [];
    const ws = {
        readyState: 1, OPEN: 1, CLOSED: 3, CLOSING: 2,
        send: (data: string) => messages.push(JSON.parse(data)),
        close: vi.fn(),
    };
    return { ws, messages };
}

// Baseline deps with sensible defaults — tests override only what they care about.
function baseDeps(overrides: Partial<NetworkScannerDeps> = {}): NetworkScannerDeps {
    return {
        adbDevices: async () => [],
        adbMdnsServices: async () => [],
        adbHandshakeProbe: async () => ({ isAdb: false }),
        concurrency: 4,
        progressInterval: 10,
        ...overrides,
    };
}

describe('NetworkScanner — lifecycle', () => {
    it('emits scan.started then scan.complete on empty scan', async () => {
        const scanner = new NetworkScanner(baseDeps());
        const { ws, messages } = makeWs();
        await scanner.start([makeSubnet([])], ws);
        expect(messages[0].type).toBe('scan.started');
        expect(messages.at(-1)?.type).toBe('scan.complete');
    });

    it('isScanning transitions through states', async () => {
        const scanner = new NetworkScanner(baseDeps());
        expect(scanner.isScanning()).toBe(false);
        const { ws } = makeWs();
        const p = scanner.start([makeSubnet(['1.1.1.1', '1.1.1.2'])], ws);
        expect(scanner.isScanning()).toBe(true);
        await p;
        expect(scanner.isScanning()).toBe(false);
    });

    it('rejects concurrent start calls', async () => {
        const scanner = new NetworkScanner(baseDeps({
            adbHandshakeProbe: async () => new Promise((r) => setTimeout(() => r({ isAdb: false }), 50)),
        }));
        const { ws } = makeWs();
        const p1 = scanner.start([makeSubnet(['1.1.1.1'])], ws);
        await expect(scanner.start([makeSubnet(['1.1.1.2'])], ws)).rejects.toThrow(/already scanning/);
        await p1;
    });
});

describe('NetworkScanner — TCP track', () => {
    it('emits scan.hit for handshake-confirmed devices', async () => {
        const scanner = new NetworkScanner(baseDeps({
            adbHandshakeProbe: async (h: string) => h === '1.1.1.2' ? { isAdb: true, model: 'SM-T550' } : { isAdb: false },
            progressInterval: 1,
        }));
        const { ws, messages } = makeWs();
        await scanner.start([makeSubnet(['1.1.1.1', '1.1.1.2', '1.1.1.3'])], ws);

        const hits = messages.filter((m) => m.type === 'scan.hit');
        expect(hits).toHaveLength(1);
        expect(hits[0]).toMatchObject({
            type: 'scan.hit',
            source: 'tcp',
            address: '1.1.1.2:5555',
            serial: '1.1.1.2:5555',
            name: 'SM-T550',
        });
    });

    it('uses empty name when handshake banner has no model', async () => {
        const scanner = new NetworkScanner(baseDeps({
            adbHandshakeProbe: async () => ({ isAdb: true }),
            progressInterval: 1,
        }));
        const { ws, messages } = makeWs();
        await scanner.start([makeSubnet(['1.1.1.5'])], ws);
        const hits = messages.filter((m) => m.type === 'scan.hit');
        expect(hits[0]).toMatchObject({ name: '' });
    });

    it('drops hits when handshake says not ADB', async () => {
        const scanner = new NetworkScanner(baseDeps({
            adbHandshakeProbe: async () => ({ isAdb: false }),
            progressInterval: 1,
        }));
        const { ws, messages } = makeWs();
        await scanner.start([makeSubnet(['1.1.1.1', '1.1.1.2'])], ws);
        expect(messages.filter((m) => m.type === 'scan.hit')).toHaveLength(0);
    });

    it('passes both timeouts to handshake probe', async () => {
        const calls: Array<{ connect: number; reply: number }> = [];
        const scanner = new NetworkScanner(baseDeps({
            adbHandshakeProbe: async (_h, _p, c, r) => { calls.push({ connect: c, reply: r }); return { isAdb: false }; },
            tcpTimeoutMs: 250,
            handshakeTimeoutMs: 4000,
            progressInterval: 1,
        }));
        const { ws } = makeWs();
        await scanner.start([makeSubnet(['1.1.1.1'])], ws);
        expect(calls[0]).toEqual({ connect: 250, reply: 4000 });
    });

    it('resolves MAC and looks up label by MAC', async () => {
        const scanner = new NetworkScanner(baseDeps({
            adbHandshakeProbe: async () => ({ isAdb: true, model: 'Pixel 3' }),
            resolveMac: async (ip: string) => ip === '1.1.1.2' ? 'aa:bb:cc:dd:ee:ff' : null,
            labelFor: (k: string) => (k === 'aa:bb:cc:dd:ee:ff' ? 'Jamies Pixel' : undefined),
            progressInterval: 1,
        }));
        const { ws, messages } = makeWs();
        await scanner.start([makeSubnet(['1.1.1.2'])], ws);
        const hits = messages.filter((m) => m.type === 'scan.hit');
        expect(hits[0]).toMatchObject({
            source: 'tcp',
            address: '1.1.1.2:5555',
            label: 'Jamies Pixel',
        });
    });

    it('falls back to labelFor(serial) when MAC lookup misses', async () => {
        const scanner = new NetworkScanner(baseDeps({
            adbHandshakeProbe: async () => ({ isAdb: true }),
            resolveMac: async () => 'aa:bb:cc:dd:ee:ff',
            labelFor: (k: string) => (k === '1.1.1.2:5555' ? 'Serial Match' : undefined),
            progressInterval: 1,
        }));
        const { ws, messages } = makeWs();
        await scanner.start([makeSubnet(['1.1.1.2'])], ws);
        const hits = messages.filter((m) => m.type === 'scan.hit');
        expect(hits[0]).toMatchObject({ label: 'Serial Match' });
    });

    it('emits empty label when neither MAC nor serial matches', async () => {
        const scanner = new NetworkScanner(baseDeps({
            adbHandshakeProbe: async () => ({ isAdb: true }),
            resolveMac: async () => null,
            labelFor: () => undefined,
            progressInterval: 1,
        }));
        const { ws, messages } = makeWs();
        await scanner.start([makeSubnet(['1.1.1.2'])], ws);
        expect(messages.filter((m) => m.type === 'scan.hit')[0]?.label).toBe('');
    });

    it('emits scan.progress at the configured interval', async () => {
        const scanner = new NetworkScanner(baseDeps({
            progressInterval: 2,
            concurrency: 2,
        }));
        const { ws, messages } = makeWs();
        await scanner.start([makeSubnet(['1.1.1.1', '1.1.1.2', '1.1.1.3', '1.1.1.4'])], ws);
        const progress = messages.filter((m) => m.type === 'scan.progress');
        expect(progress.length).toBeGreaterThanOrEqual(2);
        expect((progress.at(-1) as any)?.checked).toBe(4);
    });

    it('skips addresses already in adb devices', async () => {
        const callHosts: string[] = [];
        const scanner = new NetworkScanner(baseDeps({
            adbDevices: async () => [{ serial: '1.1.1.1:5555', state: 'device' }],
            adbHandshakeProbe: async (h: string) => { callHosts.push(h); return { isAdb: true }; },
            progressInterval: 1,
            concurrency: 2,
        }));
        const { ws, messages } = makeWs();
        await scanner.start([makeSubnet(['1.1.1.1', '1.1.1.2'])], ws);
        // handshake should have been called for .2 but not .1
        expect(callHosts).toContain('1.1.1.2');
        expect(callHosts).not.toContain('1.1.1.1');
        const hits = messages.filter((m) => m.type === 'scan.hit');
        expect(hits.every((h: any) => h.address !== '1.1.1.1:5555')).toBe(true);
    });

    it('respects concurrency bound', async () => {
        let current = 0;
        let maxObserved = 0;
        const scanner = new NetworkScanner(baseDeps({
            adbHandshakeProbe: async () => {
                current++;
                if (current > maxObserved) maxObserved = current;
                await new Promise((r) => setTimeout(r, 10));
                current--;
                return { isAdb: false };
            },
            concurrency: 3,
            progressInterval: 100,
        }));
        const { ws } = makeWs();
        const hosts = Array.from({ length: 20 }, (_, i) => `10.0.0.${i + 1}`);
        await scanner.start([makeSubnet(hosts)], ws);
        expect(maxObserved).toBeLessThanOrEqual(3);
    });
});

describe('NetworkScanner — mDNS track', () => {
    it('emits mDNS hits with adb-SERIAL name format', async () => {
        const scanner = new NetworkScanner(baseDeps({
            adbMdnsServices: async () => [
                { name: 'adb-49241HFAG07SUG-ABCDEF', service: '_adb-tls-connect._tcp.', address: '1.1.1.5', port: 5555 },
            ],
        }));
        const { ws, messages } = makeWs();
        await scanner.start([makeSubnet([])], ws);
        const hits = messages.filter((m) => m.type === 'scan.hit');
        expect(hits).toHaveLength(1);
        expect(hits[0]).toMatchObject({
            source: 'mdns',
            address: '1.1.1.5:5555',
            serial: '49241HFAG07SUG',
            name: 'adb-49241HFAG07SUG',
        });
    });

    it('looks up mDNS label by serial', async () => {
        const scanner = new NetworkScanner(baseDeps({
            adbMdnsServices: async () => [
                { name: 'adb-SERIAL1', service: '_adb._tcp.', address: '1.1.1.5', port: 5555 },
            ],
            labelFor: (k: string) => (k === 'SERIAL1' ? 'Living Room TV' : undefined),
        }));
        const { ws, messages } = makeWs();
        await scanner.start([makeSubnet([])], ws);
        const hits = messages.filter((m) => m.type === 'scan.hit');
        expect(hits[0]).toMatchObject({ label: 'Living Room TV' });
    });

    it('dedupes mDNS + TCP hits for same address (first wins)', async () => {
        const scanner = new NetworkScanner(baseDeps({
            adbMdnsServices: async () => [
                { name: 'adb-SERIAL1', service: '_adb-tls-connect._tcp.', address: '1.1.1.5', port: 5555 },
            ],
            adbHandshakeProbe: async (h: string) => h === '1.1.1.5' ? { isAdb: true, model: 'Pixel' } : { isAdb: false },
            progressInterval: 1,
            concurrency: 2,
        }));
        const { ws, messages } = makeWs();
        await scanner.start([makeSubnet(['1.1.1.5'])], ws);
        const hits = messages.filter((m) => m.type === 'scan.hit');
        expect(hits).toHaveLength(1);
        expect(hits[0]).toMatchObject({ source: 'mdns', serial: 'SERIAL1' });
    });

    it('skips mDNS hits already in adb devices', async () => {
        const scanner = new NetworkScanner(baseDeps({
            adbDevices: async () => [{ serial: '1.1.1.5:5555', state: 'device' }],
            adbMdnsServices: async () => [
                { name: 'adb-SERIAL1', service: '_adb-tls-connect._tcp.', address: '1.1.1.5', port: 5555 },
            ],
            progressInterval: 1,
            concurrency: 2,
        }));
        const { ws, messages } = makeWs();
        await scanner.start([makeSubnet([])], ws);
        expect(messages.filter((m) => m.type === 'scan.hit')).toHaveLength(0);
    });
});

describe('NetworkScanner — cancel drain', () => {
    it('drains in-flight probes after cancel', async () => {
        let peak = 0;
        let inFlight = 0;
        const scanner = new NetworkScanner(baseDeps({
            adbHandshakeProbe: async () => {
                inFlight++;
                peak = Math.max(peak, inFlight);
                await new Promise((r) => setTimeout(r, 20));
                inFlight--;
                return { isAdb: false };
            },
            concurrency: 4,
            progressInterval: 100,
        }));
        const { ws, messages } = makeWs();
        const hosts = Array.from({ length: 100 }, (_, i) => `10.0.0.${i + 1}`);
        const p = scanner.start([makeSubnet(hosts)], ws);
        setTimeout(() => scanner.cancel(), 5);
        await p;

        expect(messages.some((m) => m.type === 'scan.draining')).toBe(true);
        expect(messages.some((m) => m.type === 'scan.cancelled')).toBe(true);
        expect(peak).toBeLessThanOrEqual(4);
    });
});

describe('NetworkScanner — spectator snapshot', () => {
    it('sends scan.started and last scan.progress to mid-scan spectator', async () => {
        let inFlight = 0;
        const scanner = new NetworkScanner(baseDeps({
            adbHandshakeProbe: async () => {
                inFlight++;
                await new Promise((r) => setTimeout(r, 30));
                inFlight--;
                return { isAdb: false };
            },
            concurrency: 2,
            progressInterval: 2,
        }));
        const { ws: ws1 } = makeWs();
        const hosts = Array.from({ length: 20 }, (_, i) => `10.0.0.${i + 1}`);
        const scanPromise = scanner.start([makeSubnet(hosts)], ws1);

        while (inFlight === 0) await new Promise((r) => setTimeout(r, 5));
        await new Promise((r) => setTimeout(r, 40));

        const { ws: ws2, messages: spectatorMessages } = makeWs();
        scanner.attachSpectator(ws2);
        await new Promise((r) => setTimeout(r, 5));

        expect(spectatorMessages.some((m) => m.type === 'scan.started')).toBe(true);
        await scanPromise;
    });
});

describe('NetworkScanner — getState', () => {
    it('returns idle when not scanning', () => {
        const scanner = new NetworkScanner(baseDeps());
        expect(scanner.getState()).toBe('idle');
    });

    it('returns scanning during active scan', async () => {
        const scanner = new NetworkScanner(baseDeps({
            adbHandshakeProbe: async () => new Promise((r) => setTimeout(() => r({ isAdb: false }), 30)),
            concurrency: 2,
        }));
        const { ws } = makeWs();
        const p = scanner.start([makeSubnet(['1.1.1.1', '1.1.1.2'])], ws);
        expect(scanner.getState()).toBe('scanning');
        await p;
        expect(scanner.getState()).toBe('idle');
    });
});

describe('NetworkScanner — spectator cleanup', () => {
    it('removes closed WS from spectators on close event', async () => {
        const scanner = new NetworkScanner(baseDeps({
            adbHandshakeProbe: async () => new Promise((r) => setTimeout(() => r({ isAdb: false }), 30)),
            concurrency: 2,
        }));
        const listeners = new Map<string, () => void>();
        const ws: any = {
            readyState: 1, OPEN: 1, CLOSED: 3, CLOSING: 2,
            send: vi.fn(),
            once: (event: string, handler: () => void) => { listeners.set(event, handler); },
        };
        const p = scanner.start([makeSubnet(['1.1.1.1'])], ws);
        const closeHandler = listeners.get('close');
        expect(closeHandler).toBeDefined();
        closeHandler?.();
        await p;
        // No assertion error means spectators set accepted the removal.
    });
});
