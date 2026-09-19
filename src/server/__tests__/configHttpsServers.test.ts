import { describe, expect, it } from 'vitest';
import { buildServerList, probeCertReadable } from '../Config';

// AMENDMENT A: the plan's brief named this `buildServers`, which collides with the
// private static `Config.buildServers` already in the same file. The exported pure
// function is `buildServerList` instead; behaviour and options shape are unchanged.
describe('buildServerList', () => {
    it('emits only HTTP when no certificate exists', () => {
        const servers = buildServerList({
            httpPort: 8000,
            certExists: false,
            certFile: '',
            keyFile: '',
            httpsPort: 8443,
        });
        expect(servers).toHaveLength(1);
        expect(servers[0]!.secure).toBe(false);
    });

    it('adds an HTTPS entry alongside HTTP once a certificate exists', () => {
        const servers = buildServerList({
            httpPort: 8000,
            certExists: true,
            certFile: '/data/tls/cert.pem',
            keyFile: '/data/tls/key.pem',
            httpsPort: 8443,
        });
        expect(servers).toHaveLength(2);
        expect(servers.find((s) => s.secure)!.port).toBe(8443);
        expect(servers.find((s) => !s.secure)!.port).toBe(8000);
    });

    it('does NOT move the https port when the http port changes', () => {
        // Independent defaults. Setting HTTP to 80 must not imply HTTPS 443 --
        // the user sets that explicitly or not at all.
        const servers = buildServerList({
            httpPort: 80,
            certExists: true,
            certFile: '/data/tls/cert.pem',
            keyFile: '/data/tls/key.pem',
            httpsPort: 8443,
        });
        expect(servers.find((s) => s.secure)!.port).toBe(8443);
    });

    it('passes certPath/keyPath, which parseServerItem already reads', () => {
        const servers = buildServerList({
            httpPort: 8000,
            certExists: true,
            certFile: '/data/tls/cert.pem',
            keyFile: '/data/tls/key.pem',
            httpsPort: 8443,
        });
        const https = servers.find((s) => s.secure)!;
        expect(https.options).toMatchObject({ certPath: '/data/tls/cert.pem', keyPath: '/data/tls/key.pem' });
    });
});

// AMENDMENT B: `certExists` fed into buildServerList must mean READABLE, not merely
// present -- `Config.parseServerItem` reads certPath/keyPath with no try during Config
// construction, so an existing-but-unreadable file (bad ACL after a profile move, a
// half-written file mid-generation, a bind mount that lost permissions) must never
// reach that path. The caller computes this boolean via probeCertReadable, which opens
// both files and catches rather than checking fs.existsSync. Injectable readFile so the
// failure case needs no real unreadable file -- not portably creatable on Windows.
describe('probeCertReadable', () => {
    it('returns false, without throwing, when reading the key file throws', () => {
        const readFile = (p: string): string => {
            if (p === '/data/tls/key.pem') throw new Error('EACCES: permission denied');
            return 'pem contents';
        };
        expect(() => probeCertReadable('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).not.toThrow();
        expect(probeCertReadable('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).toBe(false);
    });

    it('returns false, without throwing, when reading the cert file throws', () => {
        const readFile = (p: string): string => {
            if (p === '/data/tls/cert.pem') throw new Error('ENOENT: no such file');
            return 'pem contents';
        };
        expect(() => probeCertReadable('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).not.toThrow();
        expect(probeCertReadable('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).toBe(false);
    });

    it('returns true when both files read successfully', () => {
        const readFile = () => 'pem contents';
        expect(probeCertReadable('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).toBe(true);
    });
});
