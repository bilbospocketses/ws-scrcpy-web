import { generateKeyPairSync } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServerList, Config, DEFAULT_HTTPS_PORT, readCertMaterial, sanitizeHttpsPort } from '../Config';
import { resolveCertPaths } from '../tls/certPaths';

// A real self-signed EC cert (CN=ws-scrcpy-web-test-fixture), same fixture
// CertService.test.ts uses: generated with `openssl req -x509 -newkey ec
// -pkeyopt ec_paramgen_curve:prime256v1 -days 3650 -nodes`, valid to
// 2036-09-16T06:05:54Z. Parsing is what's under test, not issuance -- a fixed
// constant needs no spawn and no network.
const FIXTURE_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBnjCCAUWgAwIBAgIUStcQ9sXF0laSR8mIe3nM+b8iAMMwCgYIKoZIzj0EAwIw
JTEjMCEGA1UEAwwad3Mtc2NyY3B5LXdlYi10ZXN0LWZpeHR1cmUwHhcNMjYwOTE5
MDYwNTU0WhcNMzYwOTE2MDYwNTU0WjAlMSMwIQYDVQQDDBp3cy1zY3JjcHktd2Vi
LXRlc3QtZml4dHVyZTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABOojfkBVrVov
8C0nGPk08xRgIC0wKoWgDOKpXacP1Io0bpdODVGq5pf3bnYiDboBR2lHJUvTGjBk
9mTt2c8O+syjUzBRMB0GA1UdDgQWBBRg97TQ+jJsYsCfdwtgsNRdqqKWfTAfBgNV
HSMEGDAWgBRg97TQ+jJsYsCfdwtgsNRdqqKWfTAPBgNVHRMBAf8EBTADAQH/MAoG
CCqGSM49BAMCA0cAMEQCIEQHGds7zLREgAAuBlm6SRc3oMpo4cKCxwuTVv968g9c
AiAZewr91yqhMGc6X57yf91MI5HvQEkCssGJkWvSUNjtAg==
-----END CERTIFICATE-----
`;

// A real EC private key, generated fresh at load time via Node's builtin
// crypto (no new dependency, no openssl invocation). It does not need to
// correspond to FIXTURE_CERT_PEM's public key -- readCertMaterial validates
// each PEM parses on its own, it never checks that a cert and key pair up.
const TEST_KEY_PEM = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'sec1', format: 'pem' },
}).privateKey as string;

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

    // I2 (review fix round 2): the previous tests used .find(), so reversing
    // the array order passed all of them -- index.ts:154 and :364 both rely
    // on servers[0] being the HTTP entry (`config.servers[0]!.port = found`).
    it('keeps HTTP at index 0 and HTTPS at index 1', () => {
        const servers = buildServerList({
            httpPort: 8000,
            certMaterial: { cert: 'CERT-PEM-CONTENT', key: 'KEY-PEM-CONTENT' },
            httpsPort: 8443,
        });
        expect(servers[0]!.secure).toBe(false);
        expect(servers[0]!.port).toBe(8000);
        expect(servers[1]!.secure).toBe(true);
        expect(servers[1]!.port).toBe(8443);
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
//
// C1/C2 (review fix round 2): readable is not valid. readCertMaterial now also
// parses the content with Node's own builtins (X509Certificate, createPrivateKey)
// and rejects empty/whitespace content, so a garbage or zero-byte file degrades to
// "no certificate" instead of crashing https.createServer or silently binding a
// dead listener.
describe('readCertMaterial', () => {
    it('returns null, without throwing, when reading the key file throws', () => {
        const readFile = (p: string): string => {
            if (p === '/data/tls/key.pem') throw new Error('EACCES: permission denied');
            return FIXTURE_CERT_PEM;
        };
        expect(() => readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).not.toThrow();
        expect(readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).toBeNull();
    });

    it('returns null, without throwing, when reading the cert file throws', () => {
        const readFile = (p: string): string => {
            if (p === '/data/tls/cert.pem') throw new Error('ENOENT: no such file');
            return TEST_KEY_PEM;
        };
        expect(() => readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).not.toThrow();
        expect(readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).toBeNull();
    });

    it('returns the cert/key content when both are valid PEM', () => {
        const readFile = (p: string) => (p === '/data/tls/cert.pem' ? FIXTURE_CERT_PEM : TEST_KEY_PEM);
        expect(readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).toEqual({
            cert: FIXTURE_CERT_PEM,
            key: TEST_KEY_PEM,
        });
    });

    it('C2: returns null, without throwing, when the cert content is empty', () => {
        const readFile = (p: string) => (p === '/data/tls/cert.pem' ? '' : TEST_KEY_PEM);
        expect(() => readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).not.toThrow();
        expect(readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).toBeNull();
    });

    it('C2: returns null when the key content is whitespace-only', () => {
        const readFile = (p: string) => (p === '/data/tls/key.pem' ? '   \n\t  ' : FIXTURE_CERT_PEM);
        expect(readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).toBeNull();
    });

    it('C1: returns null, without throwing, when the cert content is garbage (not valid PEM)', () => {
        const readFile = (p: string) => (p === '/data/tls/cert.pem' ? 'not a certificate' : TEST_KEY_PEM);
        expect(() => readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).not.toThrow();
        expect(readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).toBeNull();
    });

    it('C1: returns null, without throwing, when the key content is garbage (not a valid private key)', () => {
        const readFile = (p: string) => (p === '/data/tls/key.pem' ? 'not a key' : FIXTURE_CERT_PEM);
        expect(() => readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).not.toThrow();
        expect(readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).toBeNull();
    });
});

// M3 (review fix round 2): httpsPort is now a real config.json escape hatch,
// defaulting to DEFAULT_HTTPS_PORT -- without this there was no way to set the
// spec's "until the user sets it explicitly" port at all.
describe('sanitizeHttpsPort', () => {
    it('returns DEFAULT_HTTPS_PORT when unset', () => {
        expect(sanitizeHttpsPort(undefined, () => {})).toBe(DEFAULT_HTTPS_PORT);
    });

    it('accepts a valid custom port', () => {
        expect(sanitizeHttpsPort(9443, () => {})).toBe(9443);
    });

    it('falls back to default and warns on an out-of-range port', () => {
        const warn = vi.fn();
        expect(sanitizeHttpsPort(70000, warn)).toBe(DEFAULT_HTTPS_PORT);
        expect(warn).toHaveBeenCalledOnce();
    });

    it('falls back to default and warns on zero', () => {
        const warn = vi.fn();
        expect(sanitizeHttpsPort(0, warn)).toBe(DEFAULT_HTTPS_PORT);
        expect(warn).toHaveBeenCalledOnce();
    });

    it('falls back to default and warns on a non-integer value', () => {
        const warn = vi.fn();
        expect(sanitizeHttpsPort('9443', warn)).toBe(DEFAULT_HTTPS_PORT);
        expect(warn).toHaveBeenCalledOnce();
    });
});

// I1/I3 (review fix round 2): Config.buildServers -- the private static that
// actually resolves cert paths and owns every Critical the review found -- had
// ZERO test coverage, and vitest.setup.ts's LOCALAPPDATA/HOME/USERPROFILE
// redirect (M2) pins the whole suite to the no-certificate branch, so it
// cannot be reached via ambient env either. _buildServersForTest exercises the
// real private static with an injected env, driving valid/invalid/zero-byte/
// missing certificate material through real files on disk -- not just the
// pure buildServerList with hand-picked inputs, which is what let a coupling
// bug introduced in the CALLER (e.g. `port === 80 ? 443 : httpsPort`) pass
// all 7 of the original tests.
describe('Config.buildServers (exercised via _buildServersForTest)', () => {
    const tmpDirs: string[] = [];

    afterEach(() => {
        while (tmpDirs.length) {
            const d = tmpDirs.pop()!;
            try {
                fs.rmSync(d, { recursive: true, force: true });
            } catch {
                /* best-effort cleanup */
            }
        }
    });

    /**
     * Real tmp directories, real files (or none), computed via the same
     * resolveCertPaths the production code calls -- so this test is
     * platform-agnostic (POSIX puts cert/key under dataRoot; Windows uses the
     * injected per-user dir) without needing to know which branch it is on.
     */
    function setupCertFiles(
        certContent: string | null,
        keyContent: string | null,
    ): { dataRoot: string; env: NodeJS.ProcessEnv } {
        const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cfg-https-dataroot-'));
        const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cfg-https-localappdata-'));
        tmpDirs.push(dataRoot, localAppData);
        if (certContent !== null && keyContent !== null) {
            const paths = resolveCertPaths({ platform: process.platform, dataRoot, localAppData, home: localAppData });
            fs.mkdirSync(path.dirname(paths.certFile), { recursive: true });
            fs.mkdirSync(path.dirname(paths.keyFile), { recursive: true });
            fs.writeFileSync(paths.certFile, certContent);
            fs.writeFileSync(paths.keyFile, keyContent);
        }
        return { dataRoot, env: { LOCALAPPDATA: localAppData, HOME: localAppData, USERPROFILE: localAppData } };
    }

    it('adds the HTTPS entry when the certificate and key are both valid', () => {
        const { dataRoot, env } = setupCertFiles(FIXTURE_CERT_PEM, TEST_KEY_PEM);
        const servers = Config._buildServersForTest({}, 8000, dataRoot, DEFAULT_HTTPS_PORT, env);
        expect(servers).toHaveLength(2);
        expect(servers[0]!.secure).toBe(false);
        expect(servers[1]!.secure).toBe(true);
        expect(servers[1]!.options).toMatchObject({ cert: FIXTURE_CERT_PEM, key: TEST_KEY_PEM });
    });

    it('C1: falls back to HTTP-only, not a crash, when the cert content is garbage', () => {
        const { dataRoot, env } = setupCertFiles('not a certificate', TEST_KEY_PEM);
        const servers = Config._buildServersForTest({}, 8000, dataRoot, DEFAULT_HTTPS_PORT, env);
        expect(servers).toHaveLength(1);
        expect(servers[0]!.secure).toBe(false);
    });

    it('C1: falls back to HTTP-only when the key content is garbage', () => {
        const { dataRoot, env } = setupCertFiles(FIXTURE_CERT_PEM, 'not a key');
        const servers = Config._buildServersForTest({}, 8000, dataRoot, DEFAULT_HTTPS_PORT, env);
        expect(servers).toHaveLength(1);
    });

    it('C2: falls back to HTTP-only when the cert file is zero-byte', () => {
        const { dataRoot, env } = setupCertFiles('', TEST_KEY_PEM);
        const servers = Config._buildServersForTest({}, 8000, dataRoot, DEFAULT_HTTPS_PORT, env);
        expect(servers).toHaveLength(1);
    });

    it('C2: falls back to HTTP-only when the key file is zero-byte', () => {
        const { dataRoot, env } = setupCertFiles(FIXTURE_CERT_PEM, '');
        const servers = Config._buildServersForTest({}, 8000, dataRoot, DEFAULT_HTTPS_PORT, env);
        expect(servers).toHaveLength(1);
    });

    it('emits HTTP-only when no certificate files exist at all', () => {
        const { dataRoot, env } = setupCertFiles(null, null);
        const servers = Config._buildServersForTest({}, 8000, dataRoot, DEFAULT_HTTPS_PORT, env);
        expect(servers).toHaveLength(1);
        expect(servers[0]!.secure).toBe(false);
    });

    it('emits HTTP-only when dataRoot is null (no usable per-user TLS directory)', () => {
        const servers = Config._buildServersForTest({}, 8000, null, DEFAULT_HTTPS_PORT, {});
        expect(servers).toHaveLength(1);
        expect(servers[0]!.secure).toBe(false);
    });

    it('I3: httpsPort stays independent of webPort through the REAL caller, not just the pure fn', () => {
        // The old test only drove buildServerList directly with hand-picked
        // httpPort/httpsPort literals -- a coupling bug introduced in
        // Config.buildServers itself (the caller) would never reach it.
        const { dataRoot, env } = setupCertFiles(FIXTURE_CERT_PEM, TEST_KEY_PEM);
        const servers = Config._buildServersForTest({}, 80, dataRoot, DEFAULT_HTTPS_PORT, env);
        expect(servers[0]!.port).toBe(80);
        expect(servers[1]!.port).toBe(DEFAULT_HTTPS_PORT);
    });

    it('M3: a custom httpsPort is what the HTTPS entry actually binds', () => {
        const { dataRoot, env } = setupCertFiles(FIXTURE_CERT_PEM, TEST_KEY_PEM);
        const servers = Config._buildServersForTest({}, 8000, dataRoot, 9443, env);
        expect(servers[1]!.port).toBe(9443);
    });
});
