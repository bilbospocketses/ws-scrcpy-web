import * as net from 'net';
import { describe, expect, it } from 'vitest';
import { buildCnxnPacket, dedupModel, parseCnxnReply, probeAdb } from '../network/AdbHandshakeProbe';

const A_CNXN = 0x4e584e43;
const A_AUTH = 0x48545541;
const HEADER_SIZE = 24;

function adbChecksum(buf: Buffer): number {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum = (sum + buf[i]!) >>> 0;
    return sum;
}

function buildReply(command: number, payload: Buffer): Buffer {
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt32LE(command, 0);
    header.writeUInt32LE(0x01000000, 4);
    header.writeUInt32LE(0x00001000, 8);
    header.writeUInt32LE(payload.length, 12);
    header.writeUInt32LE(adbChecksum(payload), 16);
    header.writeUInt32LE((command ^ 0xffffffff) >>> 0, 20);
    return Buffer.concat([header, payload]);
}

describe('buildCnxnPacket', () => {
    it('emits a 24-byte header + banner payload', () => {
        const pkt = buildCnxnPacket();
        expect(pkt.length).toBeGreaterThan(HEADER_SIZE);
        expect(pkt.readUInt32LE(0)).toBe(A_CNXN);
        const dataLen = pkt.readUInt32LE(12);
        expect(pkt.length).toBe(HEADER_SIZE + dataLen);
    });

    it('sets magic to command XOR 0xffffffff', () => {
        const pkt = buildCnxnPacket();
        const command = pkt.readUInt32LE(0);
        const magic = pkt.readUInt32LE(20);
        expect((command ^ magic) >>> 0).toBe(0xffffffff);
    });

    it('banner payload starts with host::', () => {
        const pkt = buildCnxnPacket();
        const dataLen = pkt.readUInt32LE(12);
        const banner = pkt.slice(HEADER_SIZE, HEADER_SIZE + dataLen).toString('utf8');
        expect(banner.startsWith('host::')).toBe(true);
    });

    it('data_check field is an unsigned byte-sum of the payload (NOT CRC32)', () => {
        // Older adbd (protocol V1) validates this checksum strictly; sending
        // CRC32 instead of byte-sum would cause silent packet drops.
        const pkt = buildCnxnPacket();
        const dataLen = pkt.readUInt32LE(12);
        const payload = pkt.slice(HEADER_SIZE, HEADER_SIZE + dataLen);
        const dataCheck = pkt.readUInt32LE(16);
        expect(dataCheck).toBe(adbChecksum(payload));
    });

    it('data_length does not include a trailing null terminator', () => {
        // Real adb sends "host::" with banner.length() (C++ string), which
        // excludes the null. Some older adbd implementations reject banners
        // whose data_length includes the terminator.
        const pkt = buildCnxnPacket();
        const dataLen = pkt.readUInt32LE(12);
        const lastByte = pkt[HEADER_SIZE + dataLen - 1];
        expect(lastByte).not.toBe(0);
    });
});

describe('parseCnxnReply', () => {
    it('returns isAdb=true and extracts model for valid CNXN', () => {
        const banner = Buffer.from('device::ro.product.name=sdk;ro.product.model=SM-T550;ro.product.device=gt5;features=cmd', 'utf8');
        const reply = buildReply(A_CNXN, banner);
        const r = parseCnxnReply(reply);
        expect(r.isAdb).toBe(true);
        expect(r.model).toBe('SM-T550');
    });

    it('falls back to ro.product.name when ro.product.model missing', () => {
        const banner = Buffer.from('device::ro.product.name=Pixel 3;features=cmd', 'utf8');
        const reply = buildReply(A_CNXN, banner);
        const r = parseCnxnReply(reply);
        expect(r.model).toBe('Pixel 3');
    });

    it('strips trailing null bytes from banner', () => {
        const banner = Buffer.from('device::ro.product.model=Pixel\0\0', 'utf8');
        const reply = buildReply(A_CNXN, banner);
        const r = parseCnxnReply(reply);
        expect(r.model).toBe('Pixel');
    });

    it('returns isAdb=true with no model for A_AUTH reply', () => {
        const reply = buildReply(A_AUTH, Buffer.from([0, 0, 0, 0]));
        const r = parseCnxnReply(reply);
        expect(r.isAdb).toBe(true);
        expect(r.model).toBeUndefined();
    });

    it('returns isAdb=false for unknown command', () => {
        const reply = buildReply(0xdeadbeef, Buffer.alloc(0));
        const r = parseCnxnReply(reply);
        expect(r.isAdb).toBe(false);
    });

    it('returns isAdb=false for CNXN with wrong magic', () => {
        const payload = Buffer.from('device::ro.product.model=X', 'utf8');
        const header = Buffer.alloc(HEADER_SIZE);
        header.writeUInt32LE(A_CNXN, 0);
        header.writeUInt32LE(0x01000000, 4);
        header.writeUInt32LE(0x00001000, 8);
        header.writeUInt32LE(payload.length, 12);
        header.writeUInt32LE(adbChecksum(payload), 16);
        header.writeUInt32LE(0xdeadbeef, 20); // bad magic
        const reply = Buffer.concat([header, payload]);
        const r = parseCnxnReply(reply);
        expect(r.isAdb).toBe(false);
    });

    it('returns isAdb=false for buffer shorter than header', () => {
        expect(parseCnxnReply(Buffer.alloc(10)).isAdb).toBe(false);
    });

    it('returns isAdb=false when data_length exceeds buffer', () => {
        const header = Buffer.alloc(HEADER_SIZE);
        header.writeUInt32LE(A_CNXN, 0);
        header.writeUInt32LE(0x01000000, 4);
        header.writeUInt32LE(0x00040000, 8);
        header.writeUInt32LE(9999, 12); // absurd length
        header.writeUInt32LE(0, 16);
        header.writeUInt32LE((A_CNXN ^ 0xffffffff) >>> 0, 20);
        expect(parseCnxnReply(header).isAdb).toBe(false);
    });
});

describe('dedupModel', () => {
    it('keeps single-word models unchanged', () => {
        expect(dedupModel('SM-T550')).toBe('SM-T550');
        expect(dedupModel('Pixel')).toBe('Pixel');
    });

    it('keeps multi-word models with no duplicates unchanged', () => {
        expect(dedupModel('Pixel 3')).toBe('Pixel 3');
        expect(dedupModel('SHIELD Android TV')).toBe('SHIELD Android TV');
    });

    it('collapses adjacent duplicate words', () => {
        expect(dedupModel('Google Google Chromecast')).toBe('Google Chromecast');
        expect(dedupModel('NVIDIA NVIDIA SHIELD')).toBe('NVIDIA SHIELD');
        expect(dedupModel('Pixel Pixel 3a')).toBe('Pixel 3a');
    });

    it('collapses triple+ repeats to single', () => {
        expect(dedupModel('Google Google Google Chromecast')).toBe('Google Chromecast');
    });

    it('collapses full-string duplicate "X X" pattern', () => {
        expect(dedupModel('Chromecast Chromecast')).toBe('Chromecast');
        expect(dedupModel('Pixel 3 Pixel 3')).toBe('Pixel 3');
    });

    it('trims whitespace', () => {
        expect(dedupModel('  Pixel 3  ')).toBe('Pixel 3');
    });

    it('returns empty string on empty input', () => {
        expect(dedupModel('')).toBe('');
        expect(dedupModel('   ')).toBe('');
    });

    it('case-insensitive adjacent dedup', () => {
        expect(dedupModel('google Google Chromecast')).toBe('google Chromecast');
    });

    it('caps the input length so a hostile ADB banner cannot blow up the dedup (#27)', () => {
        // The model string comes from an attacker-controllable device banner; the
        // result is bounded to the 256-char cap, and the dedup is a linear token
        // walk rather than a catastrophic-backtracking regex.
        expect(dedupModel('A'.repeat(5000)).length).toBeLessThanOrEqual(256);
        expect(dedupModel(Array(500).fill('Pixel').join(' ')).length).toBeLessThanOrEqual(256);
    });
});

describe('probeAdb (integration)', () => {
    // Track server-side sockets so we can force-close them in finally.
    // net.Server doesn't expose closeAllConnections (that's http.Server only).
    function makeServer(onConn: (sock: net.Socket) => void): { server: net.Server; sockets: net.Socket[] } {
        const sockets: net.Socket[] = [];
        const server = net.createServer((sock) => {
            sockets.push(sock);
            onConn(sock);
        });
        return { server, sockets };
    }
    async function closeServer(server: net.Server, sockets: net.Socket[]): Promise<void> {
        for (const s of sockets) s.destroy();
        await new Promise<void>((r) => server.close(() => r()));
    }

    it('returns isAdb=true with model for a fake ADB server', async () => {
        const { server, sockets } = makeServer((sock) => {
            sock.on('data', () => {
                // Don't bother validating the client's CNXN — just reply.
                const banner = Buffer.from('device::ro.product.model=SM-T550;features=cmd', 'utf8');
                sock.write(buildReply(A_CNXN, banner));
            });
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        const port = (server.address() as net.AddressInfo).port;
        // §25 — await-using replaces the prior try/finally closeServer pair.
        await using _server = {
            [Symbol.asyncDispose]: () => closeServer(server, sockets),
        };
        const result = await probeAdb('127.0.0.1', port, 500, 2000);
        expect(result.isAdb).toBe(true);
        expect(result.model).toBe('SM-T550');
    });

    it('returns isAdb=false on connection refused', async () => {
        // Port chosen unlikely to be listening
        const result = await probeAdb('127.0.0.1', 59999, 500, 500);
        expect(result.isAdb).toBe(false);
    });

    it('returns isAdb=false for non-ADB TCP server (garbage response)', async () => {
        const { server, sockets } = makeServer((sock) => {
            sock.write('HTTP/1.1 200 OK\r\n\r\n');
            sock.end();
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        const port = (server.address() as net.AddressInfo).port;
        // §25 — await-using replaces the prior try/finally closeServer pair.
        await using _server = {
            [Symbol.asyncDispose]: () => closeServer(server, sockets),
        };
        const result = await probeAdb('127.0.0.1', port, 500, 2000);
        expect(result.isAdb).toBe(false);
    });

    it('returns isAdb=false when server accepts but never replies (timeout)', async () => {
        const { server, sockets } = makeServer(() => {
            // Hold the socket open; send nothing.
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        const port = (server.address() as net.AddressInfo).port;
        // §25 — await-using replaces the prior try/finally closeServer pair.
        await using _server = {
            [Symbol.asyncDispose]: () => closeServer(server, sockets),
        };
        const result = await probeAdb('127.0.0.1', port, 500, 200);
        expect(result.isAdb).toBe(false);
    });
});
