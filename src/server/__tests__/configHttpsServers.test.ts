import { generateKeyPairSync } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServerList, Config, DEFAULT_HTTPS_PORT, readCertMaterial, sanitizeHttpsPort } from '../Config';
import { resolveCertPaths } from '../tls/certPaths';

// A real self-signed EC cert/key pair, GENUINELY MATCHING -- generated together
// with `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1
// -days 3650 -nodes -subj "/CN=ws-scrcpy-web-test-fixture-matched"`, valid to
// 2036-09-16. Verified with `tls.createSecureContext({cert, key})` at
// authoring time. This MUST stay a matching pair -- review fix round 2's
// fixture paired an unrelated CertService.test.ts cert with a freshly
// generated, UNRELATED key, which happened to satisfy round 2's
// parse-each-PEM-separately check while locking in exactly the C1 residue
// round 3 found (a mismatched pair throws ERR_OSSL_X509_KEY_VALUES_MISMATCH
// out of the real https.createServer, which createSecureContext also
// catches -- so a genuinely mismatched pair here would now correctly fail
// every "valid" test instead of passing one that proves nothing).
const MATCHED_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBsDCCAVWgAwIBAgIUZyaVyjlE5WplHUXIou7+G/z7LTwwCgYIKoZIzj0EAwIw
LTErMCkGA1UEAwwid3Mtc2NyY3B5LXdlYi10ZXN0LWZpeHR1cmUtbWF0Y2hlZDAe
Fw0yNjA5MTkwODAxNDNaFw0zNjA5MTYwODAxNDNaMC0xKzApBgNVBAMMIndzLXNj
cmNweS13ZWItdGVzdC1maXh0dXJlLW1hdGNoZWQwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAARJERUpsodyi0S2zdAYBRxngkS+mMi2EzzFR1TqZFC/64tc83FEZtH1
uoFDQGCRB1NKmaRa5U7dX6Mlv8leRA5mo1MwUTAdBgNVHQ4EFgQU8HzCfuYhTZyd
knkc2gMC/Go5B3wwHwYDVR0jBBgwFoAU8HzCfuYhTZydknkc2gMC/Go5B3wwDwYD
VR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNJADBGAiEA03PBA6aweWwPuXi8+Bvc
F9LMnKv989ajzlXcCuV8JqUCIQCslAXIk6F9J+93UKTYmQ61ztgeUv9iZWG9oBMQ
phIFKA==
-----END CERTIFICATE-----
`;
const MATCHED_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgkXTe5ntlD/1orOdu
ltkNicg7eodU8zvM71Kem7jwBtWhRANCAARJERUpsodyi0S2zdAYBRxngkS+mMi2
EzzFR1TqZFC/64tc83FEZtH1uoFDQGCRB1NKmaRa5U7dX6Mlv8leRA5m
-----END PRIVATE KEY-----
`;

// A second, UNRELATED EC key, generated fresh at load time via Node's builtin
// crypto -- used only to prove the mismatched-pair regression stays caught.
const UNRELATED_KEY_PEM = generateKeyPairSync('ec', {
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
//
// buildServerList itself is a PURE pass-through of whatever certMaterial it's
// handed -- it never validates content, so these tests use plain placeholder
// strings rather than real PEM. Content validation is readCertMaterial's job,
// tested separately below.
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
// C1/C2 (review fix round 2, C1 corrected in round 3): readable is not valid.
// readCertMaterial validates content with `tls.createSecureContext({cert, key})`
// -- NOT by parsing the cert and the key separately, which round 2 did and which
// missed a mismatched pair and a truncated second PEM block (see the doc comment
// on readCertMaterial). It also rejects empty/whitespace content explicitly,
// since createSecureContext accepts empty strings.
describe('readCertMaterial', () => {
    it('returns null, without throwing, when reading the key file throws', () => {
        const readFile = (p: string): string => {
            if (p === '/data/tls/key.pem') throw new Error('EACCES: permission denied');
            return MATCHED_CERT_PEM;
        };
        expect(() => readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).not.toThrow();
        expect(readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).toBeNull();
    });

    it('returns null, without throwing, when reading the cert file throws', () => {
        const readFile = (p: string): string => {
            if (p === '/data/tls/cert.pem') throw new Error('ENOENT: no such file');
            return MATCHED_KEY_PEM;
        };
        expect(() => readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).not.toThrow();
        expect(readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).toBeNull();
    });

    it('returns the cert/key content when both are valid PEM and genuinely match', () => {
        const readFile = (p: string) => (p === '/data/tls/cert.pem' ? MATCHED_CERT_PEM : MATCHED_KEY_PEM);
        expect(readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).toEqual({
            cert: MATCHED_CERT_PEM,
            key: MATCHED_KEY_PEM,
        });
    });

    it('C2: returns null, without throwing, when the cert content is empty', () => {
        const readFile = (p: string) => (p === '/data/tls/cert.pem' ? '' : MATCHED_KEY_PEM);
        expect(() => readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).not.toThrow();
        expect(readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).toBeNull();
    });

    it('C2: returns null when the key content is whitespace-only', () => {
        const readFile = (p: string) => (p === '/data/tls/key.pem' ? '   \n\t  ' : MATCHED_CERT_PEM);
        expect(readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).toBeNull();
    });

    it('C1: returns null, without throwing, when the cert content is garbage (not valid PEM)', () => {
        const readFile = (p: string) => (p === '/data/tls/cert.pem' ? 'not a certificate' : MATCHED_KEY_PEM);
        expect(() => readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).not.toThrow();
        expect(readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).toBeNull();
    });

    it('C1: returns null, without throwing, when the key content is garbage (not a valid private key)', () => {
        const readFile = (p: string) => (p === '/data/tls/key.pem' ? 'not a key' : MATCHED_CERT_PEM);
        expect(() => readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).not.toThrow();
        expect(readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).toBeNull();
    });

    // --- C1 RESIDUE regression tests (review fix round 3) ---
    // Round 2 validated the cert and the key SEPARATELY (X509Certificate,
    // createPrivateKey), which cannot detect either of these. Both are
    // measured to throw synchronously and uncaught out of the real
    // https.createServer if they ever reached it.

    it('C1 residue: returns null, without throwing, when the cert is valid but the key does not match it', () => {
        // ERR_OSSL_X509_KEY_VALUES_MISMATCH -- X509Certificate alone and
        // createPrivateKey alone both accept this pair; only
        // createSecureContext checks they belong together.
        const readFile = (p: string) => (p === '/data/tls/cert.pem' ? MATCHED_CERT_PEM : UNRELATED_KEY_PEM);
        expect(() => readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).not.toThrow();
        expect(readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).toBeNull();
    });

    it('C1 residue: returns null, without throwing, when the cert PEM has a truncated second block', () => {
        // ERR_OSSL_PEM_BAD_END_LINE -- X509Certificate reads only the FIRST
        // PEM block and returns happily; the truncated second block only
        // surfaces once TLS actually tries to use the content.
        const truncatedCert = `${MATCHED_CERT_PEM}\n-----BEGIN CERTIFICATE-----\nMIIB truncated garbage\n`;
        const readFile = (p: string) => (p === '/data/tls/cert.pem' ? truncatedCert : MATCHED_KEY_PEM);
        expect(() => readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).not.toThrow();
        expect(readCertMaterial('/data/tls/cert.pem', '/data/tls/key.pem', readFile)).toBeNull();
    });
});

// M3 (review fix round 2): httpsPort is now a real config.json escape hatch,
// defaulting to DEFAULT_HTTPS_PORT -- without this there was no way to set the
// spec's "until the user sets it explicitly" port at all.
describe('sanitizeHttpsPort', () => {
    // N1 (review fix round 3): this test previously could not fail on its own
    // -- deleting the `raw === undefined` early return still returns the
    // default via the range check falling through to the warn-and-default
    // path, so a no-op warn observed nothing. Asserting warn was NOT called
    // makes the early return load-bearing.
    it('returns DEFAULT_HTTPS_PORT when unset, without warning', () => {
        const warn = vi.fn();
        expect(sanitizeHttpsPort(undefined, warn)).toBe(DEFAULT_HTTPS_PORT);
        expect(warn).not.toHaveBeenCalled();
    });

    it('accepts a valid custom port', () => {
        const warn = vi.fn();
        expect(sanitizeHttpsPort(9443, warn)).toBe(9443);
        expect(warn).not.toHaveBeenCalled();
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
//
// N2 (review fix round 3): _buildServersForTest takes `fileConfig.httpsPort`
// through the same `sanitizeHttpsPort` the real boot path uses, rather than a
// raw `httpsPort` argument -- a test-only door into production code must not
// accept input the real path would reject.
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

    it('adds the HTTPS entry when the certificate and key are both valid and genuinely match', () => {
        const { dataRoot, env } = setupCertFiles(MATCHED_CERT_PEM, MATCHED_KEY_PEM);
        const servers = Config._buildServersForTest({}, 8000, dataRoot, env);
        expect(servers).toHaveLength(2);
        expect(servers[0]!.secure).toBe(false);
        expect(servers[1]!.secure).toBe(true);
        expect(servers[1]!.options).toMatchObject({ cert: MATCHED_CERT_PEM, key: MATCHED_KEY_PEM });
    });

    it('C1: falls back to HTTP-only, not a crash, when the cert content is garbage', () => {
        const { dataRoot, env } = setupCertFiles('not a certificate', MATCHED_KEY_PEM);
        const servers = Config._buildServersForTest({}, 8000, dataRoot, env);
        expect(servers).toHaveLength(1);
        expect(servers[0]!.secure).toBe(false);
    });

    it('C1: falls back to HTTP-only when the key content is garbage', () => {
        const { dataRoot, env } = setupCertFiles(MATCHED_CERT_PEM, 'not a key');
        const servers = Config._buildServersForTest({}, 8000, dataRoot, env);
        expect(servers).toHaveLength(1);
    });

    it('C1 residue: falls back to HTTP-only when the cert and key are both individually valid but do not match', () => {
        const { dataRoot, env } = setupCertFiles(MATCHED_CERT_PEM, UNRELATED_KEY_PEM);
        const servers = Config._buildServersForTest({}, 8000, dataRoot, env);
        expect(servers).toHaveLength(1);
        expect(servers[0]!.secure).toBe(false);
    });

    it('C2: falls back to HTTP-only when the cert file is zero-byte', () => {
        const { dataRoot, env } = setupCertFiles('', MATCHED_KEY_PEM);
        const servers = Config._buildServersForTest({}, 8000, dataRoot, env);
        expect(servers).toHaveLength(1);
    });

    it('C2: falls back to HTTP-only when the key file is zero-byte', () => {
        const { dataRoot, env } = setupCertFiles(MATCHED_CERT_PEM, '');
        const servers = Config._buildServersForTest({}, 8000, dataRoot, env);
        expect(servers).toHaveLength(1);
    });

    it('emits HTTP-only when no certificate files exist at all', () => {
        const { dataRoot, env } = setupCertFiles(null, null);
        const servers = Config._buildServersForTest({}, 8000, dataRoot, env);
        expect(servers).toHaveLength(1);
        expect(servers[0]!.secure).toBe(false);
    });

    it('emits HTTP-only when dataRoot is null (no usable per-user TLS directory)', () => {
        const servers = Config._buildServersForTest({}, 8000, null, {});
        expect(servers).toHaveLength(1);
        expect(servers[0]!.secure).toBe(false);
    });

    it('I3: httpsPort stays independent of webPort through the REAL caller, not just the pure fn', () => {
        // The old test only drove buildServerList directly with hand-picked
        // httpPort/httpsPort literals -- a coupling bug introduced in
        // Config.buildServers itself (the caller) would never reach it.
        const { dataRoot, env } = setupCertFiles(MATCHED_CERT_PEM, MATCHED_KEY_PEM);
        const servers = Config._buildServersForTest({}, 80, dataRoot, env);
        expect(servers[0]!.port).toBe(80);
        expect(servers[1]!.port).toBe(DEFAULT_HTTPS_PORT);
    });

    it('M3: a custom httpsPort from fileConfig is what the HTTPS entry actually binds', () => {
        const { dataRoot, env } = setupCertFiles(MATCHED_CERT_PEM, MATCHED_KEY_PEM);
        const servers = Config._buildServersForTest({ httpsPort: 9443 }, 8000, dataRoot, env);
        expect(servers[1]!.port).toBe(9443);
    });

    // N3 (review fix round 3): httpsPort colliding with the http port would
    // mean only one listener actually binds. HTTP must win -- it is the one
    // this whole feature promises must never stop the app starting.
    it('N3: skips the HTTPS entry and warns when httpsPort collides with the http port', () => {
        const { dataRoot, env } = setupCertFiles(MATCHED_CERT_PEM, MATCHED_KEY_PEM);
        const warn = vi.fn();
        const servers = Config._buildServersForTest({ httpsPort: 8000 }, 8000, dataRoot, env, warn);
        expect(servers).toHaveLength(1);
        expect(servers[0]!.secure).toBe(false);
        expect(servers[0]!.port).toBe(8000);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('8000'));
    });
});
