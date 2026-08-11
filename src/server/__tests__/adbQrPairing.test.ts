import { describe, expect, it, vi } from 'vitest';
import type { AdbClient } from '../AdbClient';
import { AdbQrPairingManager } from '../AdbQrPairing';

function fakeAdb(): Pick<AdbClient, 'mdnsServices' | 'pairQr' | 'connect'> {
    return {
        mdnsServices: vi.fn().mockResolvedValue([]),
        pairQr: vi.fn().mockResolvedValue('Failed'),
        connect: vi.fn().mockResolvedValue('failed to connect'),
    };
}

function manager(adb: ReturnType<typeof fakeAdb>, extra: Record<string, unknown> = {}) {
    let fill = 1;
    return new AdbQrPairingManager(adb, {
        autoRun: false,
        randomBytes: (size: number) => Buffer.alloc(size, fill++),
        now: () => 1_000,
        renderQr: (payload: string) => payload,
        sleep: async () => undefined,
        ...extra,
    });
}

describe('AdbQrPairingManager', () => {
    it('generates Android standard QR payload without exposing its secret in status', () => {
        const sessions = manager(fakeAdb());
        const started = sessions.start({ mode: 'lan' });
        expect(started.qrSvg).toMatch(/^WIFI:T:ADB;S:studio-wssw-[A-Za-z0-9_-]+;P:[A-Za-z0-9_-]+;;$/);
        expect(JSON.stringify(sessions.getStatus(started.id))).not.toContain(';P:');
    });

    it('pairs only the exact QR-requested LAN mDNS instance', async () => {
        const adb = fakeAdb();
        vi.mocked(adb.pairQr).mockResolvedValue('Successfully paired to 192.168.1.20:37123');
        const sessions = manager(adb);
        const started = sessions.start({ mode: 'lan' });
        const service = /;S:([^;]+);/.exec(started.qrSvg)![1]!;
        vi.mocked(adb.mdnsServices).mockResolvedValue([
            { name: `${service}-other`, service: '_adb-tls-pairing._tcp.', address: '192.168.1.19', port: 30001 },
            { name: service, service: '_adb-tls-pairing._tcp.', address: '192.168.1.20', port: 37123 },
        ]);
        await sessions.runCurrent();
        expect(adb.pairQr).toHaveBeenCalledWith('192.168.1.20:37123', expect.any(String), 5_000);
        expect(sessions.getStatus(started.id)).toMatchObject({ state: 'complete' });
    });

    it('uses mDNS ports as a zero-scan Tailscale fast path when LAN discovery is visible', async () => {
        const adb = fakeAdb();
        vi.mocked(adb.pairQr).mockResolvedValue('Successfully paired');
        vi.mocked(adb.connect).mockResolvedValue('connected to 100.64.1.20:33001');
        const tcp = vi.fn().mockResolvedValue(false);
        const sessions = manager(adb, { tcpProbe: tcp, adbProbe: vi.fn().mockResolvedValue({ isAdb: true }) });
        const started = sessions.start({ mode: 'tailscale', host: '100.64.1.20' });
        const service = /;S:([^;]+);/.exec(started.qrSvg)![1]!;
        vi.mocked(adb.mdnsServices).mockResolvedValue([
            { name: service, service: '_adb-tls-pairing._tcp.', address: '192.168.1.20', port: 33003 },
            { name: 'adb-phone-x', service: '_adb-tls-connect._tcp.', address: '192.168.1.20', port: 33001 },
        ]);
        await sessions.runCurrent();
        expect(adb.pairQr).toHaveBeenCalledWith('100.64.1.20:33003', expect.any(String), 5_000);
        expect(adb.connect).toHaveBeenCalledWith('100.64.1.20:33001');
        expect(tcp).not.toHaveBeenCalled();
        expect(sessions.getStatus(started.id)).toMatchObject({ state: 'complete', address: '100.64.1.20:33001' });
    });

    it('stops the remote scan as soon as pairing and STLS connect candidates are found', async () => {
        const adb = fakeAdb();
        vi.mocked(adb.pairQr).mockImplementation(async (address) =>
            address.endsWith(':33003') ? 'Successfully paired' : 'Failed',
        );
        vi.mocked(adb.connect).mockResolvedValue('connected to 100.64.1.20:33001');
        const probed: number[] = [];
        const sessions = manager(adb, {
            portStart: 33_000,
            portEnd: 33_010,
            concurrency: 2,
            tcpProbe: async (_host: string, port: number) => {
                probed.push(port);
                await new Promise((resolve) => setTimeout(resolve, 1));
                return port === 33_001 || port === 33_003;
            },
            adbProbe: vi.fn(async (_host: string, port: number) => ({ isAdb: port === 33_001 })),
        });
        const started = sessions.start({ mode: 'tailscale', host: '100.64.1.20' });
        await sessions.runCurrent();
        expect(sessions.getStatus(started.id)).toMatchObject({ state: 'complete', address: '100.64.1.20:33001' });
        expect(Math.max(...probed)).toBeLessThan(33_010);
    });

    it('rejects arbitrary remote scan targets', () => {
        const sessions = manager(fakeAdb());
        expect(() => sessions.start({ mode: 'tailscale', host: '192.168.1.20' })).toThrow(/Tailscale/i);
        expect(() => sessions.start({ mode: 'tailscale', host: '100.128.0.1' })).toThrow(/Tailscale/i);
        expect(() => sessions.start({ mode: 'tailscale', host: '100.064.1.20' })).toThrow(/Tailscale/i);
    });
});
