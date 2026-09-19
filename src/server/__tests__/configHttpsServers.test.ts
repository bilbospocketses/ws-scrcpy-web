import { describe, expect, it } from 'vitest';
import { buildServerList, readCertMaterial } from '../Config';

// AMENDMENT A: the plan's brief named this `buildServers`, which collides with the
// private static `Config.buildServers` already in the same file. The exported pure
// function is `buildServerList` instead; behaviour is unchanged.
//
// M1 (review fix round 1): the HTTPS entry embeds the actual `cert`/`key` PEM
// content, not `certPath`/`keyPath`. Nothing in HttpServer.ts ever turns a
// certPath/keyPath pair on a ServerItem into real key material -- only
// `Config.parseServerItem` does that, and only for the advanced (user-authored)
// `fileConfig.server` array, never for this generated entry. Embedding content
// directly here also means the untried `fs.readFileSync` inside
// `parseServerItem` is never reached for it, keeping amendment B's
// no-boot-crash guarantee intact end to end.
describe('buildServerList', () => {
    it('emits only HTTP when no certificate exists', () => {
        const servers = buildServerList({ httpPort: 8000, certMaterial: null, httpsPort: 8443 });
        expect(servers).toHaveLength(1);
        expect(servers[0]!.secure).toBe(false);
    });

    it('adds an HTTPS entry alongside HTTP once a certificate exists', () => {
        const servers = buildServerList({
            httpPort: 8000,
            certMaterial: { cert: 'CERT-PEM-CONTENT', key: 'KEY-PEM-CONTENT' },
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
            certMaterial: { cert: 'CERT-PEM-CONTENT', key: 'KEY-PEM-CONTENT' },
            httpsPort: 8443,
        });
        expect(servers.find((s) => s.secure)!.port).toBe(8443);
    });

    it('carries real cert/key PEM content, never certPath/keyPath', () => {
        const servers = buildServerList({
            httpPort: 8000,
            certMaterial: { cert: 'CERT-PEM-CONTENT', key: 'KEY-PEM-CONTENT' },
            httpsPort: 8443,
        });
        const https = servers.find((s) => s.secure)!;
        expect(https.options).toMatchObject({ cert: 'CERT-PEM-CONTENT', key: 'KEY-PEM-CONTENT' });
        // A future refactor back to paths must fail loudly, not silently ship a
        // listener with no key material -- see the M1 doc comment on
        // buildServerList for why this entry never goes through
        // Config.parseServerItem (the only place certPath/keyPath get read).
        expect(https.options).not.toHaveProperty('certPath');
        expect(https.options).not.toHaveProperty('keyPath');
    });
});

// AMENDMENT B: `certMaterial` fed into buildServerList must come from actually
// READING the cert/key, not merely checking they exist -- `Config.parseServerItem`
// reads certPath/keyPath with no try during Config construction, so an
// existing-but-unreadable file (bad ACL after a profile move, a half-written file
// mid-generation, a bind mount that lost permissions) must never reach that path.
// `readCertMaterial` opens both files and catches, returning null rather than
// throwing. Injectable readFile so the failure case needs no real unreadable file
// -- not portably creatable on Windows.
describe('readCertMaterial', () => {
    it('returns null, without throwing, when reading the key file throws', () => {
        const readFile = (p: string): string => {
            if (p === '/data/tls/key.pem') throw new Error('EACCES: permission denied');
            return 'pem contents';
        };
        expect(() => readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).not.toThrow();
        expect(readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).toBeNull();
    });

    it('returns null, without throwing, when reading the cert file throws', () => {
        const readFile = (p: string): string => {
            if (p === '/data/tls/cert.pem') throw new Error('ENOENT: no such file');
            return 'pem contents';
        };
        expect(() => readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).not.toThrow();
        expect(readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).toBeNull();
    });

    it('returns the cert/key content when both files read successfully', () => {
        const readFile = (p: string) => `content of ${p}`;
        expect(readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).toEqual({
            cert: 'content of /data/tls/cert.pem',
            key: 'content of /data/tls/key.pem',
        });
    });
});
