import { describe, expect, it, vi } from 'vitest';
import { CertService, type CertServiceDeps, nameConstraintsFor, parseLeafSubject } from './CertService';

// A real self-signed EC cert (CN=ws-scrcpy-web-test-fixture, generated with
// `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -days
// 3650 -nodes`, valid to 2036-09-16T06:05:54Z). Note this is actually a CA
// certificate (basicConstraints CA:TRUE, which `openssl req -x509` sets by
// default), standing in for a leaf here -- harmless for what these tests
// check (`validTo`/`validToDate` read the same either way), but worth
// knowing if a later test ever asserts something about the leaf's shape. A
// fixed constant is deliberate: parsing is what's under test, not issuance,
// so this needs no spawn and no network.
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

// Two real leaf-shaped certs (CN plus a matching subjectAltName), generated
// with `openssl req -x509 -newkey ec ... -addext "subjectAltName=IP:..."` /
// "DNS:...". Fixed constants for the same reason as FIXTURE_CERT_PEM above --
// SAN parsing is what's under test, not issuance.
const FIXTURE_LEAF_IP_PEM = `-----BEGIN CERTIFICATE-----
MIIBlDCCATqgAwIBAgIUWRyRFrRP38lFQsYUWl0VEB9kOFowCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMMTkyLjE2OC44Ni4zMB4XDTI2MDkxOTA5MDgwM1oXDTM2MDkx
NjA5MDgwM1owFzEVMBMGA1UEAwwMMTkyLjE2OC44Ni4zMFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAEZzLReChxB1VkXdyFqWceOKv0X0CVCE3TfldHl23TaRzAvX8W
OZ2YWf8TlZz19drOeLg1JEMAogNMkc2Hr+Ghc6NkMGIwHQYDVR0OBBYEFISi43dH
QjLuf0Ggt6+vu5zEJzSWMB8GA1UdIwQYMBaAFISi43dHQjLuf0Ggt6+vu5zEJzSW
MA8GA1UdEwEB/wQFMAMBAf8wDwYDVR0RBAgwBocEwKhWAzAKBggqhkjOPQQDAgNI
ADBFAiBtorg9KaDh2fIaga0F4THSFIwFCyZeGgOZJRj9JU6Y0gIhAPNhpzV8fHWQ
mUpCOJ+/e5QDCmF8xK2hDkgMkq0Bfx6C
-----END CERTIFICATE-----
`;

const FIXTURE_LEAF_HOST_PEM = `-----BEGIN CERTIFICATE-----
MIIBmTCCAT+gAwIBAgIUYR161+lq+9CIxZUfmG2DSFhkXHUwCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLZGV2aWNlcy5sYW4wHhcNMjYwOTE5MDkwODAzWhcNMzYwOTE2
MDkwODAzWjAWMRQwEgYDVQQDDAtkZXZpY2VzLmxhbjBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABCtsnmxV3S0lEcPlxMDpcel8Rsz4htyqNckzbNYxUotomMmTQ671
VsX9OuAaJCqz4YJjeaAEXKBi9lUwfdWhpX2jazBpMB0GA1UdDgQWBBQ++j/I3XDn
XF6R3A9VfT7WyLo8AjAfBgNVHSMEGDAWgBQ++j/I3XDnXF6R3A9VfT7WyLo8AjAP
BgNVHRMBAf8EBTADAQH/MBYGA1UdEQQPMA2CC2RldmljZXMubGFuMAoGCCqGSM49
BAMCA0gAMEUCIQD/TKnjXc8X3oArqm2ECn1gxR5h3kwmltfm1IoDFD4bBgIgC71q
AWEbfuHbWLd/3KtdjuZOh4+CQq/oD+3jp2wnQ3o=
-----END CERTIFICATE-----
`;

// Same as FIXTURE_LEAF_IP_PEM but IPv6 (CN=::1). X509Certificate renders its
// SAN fully expanded ("IP Address:0:0:0:0:0:0:0:1") -- this fixture is what
// pins parseLeafSubject's compression back to "::1".
const FIXTURE_LEAF_IPV6_PEM = `-----BEGIN CERTIFICATE-----
MIIBjTCCATSgAwIBAgIUWBf1/eIyqAFo5oUXEO7o/T6fsUYwCgYIKoZIzj0EAwIw
DjEMMAoGA1UEAwwDOjoxMB4XDTI2MDkxOTA5MDgwM1oXDTM2MDkxNjA5MDgwM1ow
DjEMMAoGA1UEAwwDOjoxMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEjE3wBIBp
guzPjDzJGEAL1zKrR/ts5Z24FkmEzOx0s7lvGsRKuc4eR30GF0Z6V9FC0CK5mrJi
M3x5rloILGeVUKNwMG4wHQYDVR0OBBYEFJMm7j15WlX97Zb4nvTmHAnWgGznMB8G
A1UdIwQYMBaAFJMm7j15WlX97Zb4nvTmHAnWgGznMA8GA1UdEwEB/wQFMAMBAf8w
GwYDVR0RBBQwEocQAAAAAAAAAAAAAAAAAAAAATAKBggqhkjOPQQDAgNHADBEAiA7
Bsf7knwRr7nBtX4SAq632sSm02V8WN0xBVHyEKZhogIgVTdbtKZOrR1foYarbnNO
FxFIrJ2jrQBMK1w/ECyJ6Hg=
-----END CERTIFICATE-----
`;

function makeService(over: Partial<CertServiceDeps> = {}) {
    const run = vi.fn().mockResolvedValue({ code: 0, stderr: '' });
    const chmod = vi.fn();
    const removeCaRoot = vi.fn();
    const removeLeaf = vi.fn();
    const ensureCaRootDir = vi.fn();
    const deps: CertServiceDeps = {
        paths: {
            caRoot: 'C:\\Users\\jane\\AppData\\Local\\WsScrcpyWeb\\tls\\ca',
            certFile: 'C:\\ProgramData\\WsScrcpyWeb\\tls\\cert.pem',
            keyFile: 'C:\\ProgramData\\WsScrcpyWeb\\tls\\key.pem',
        },
        mkcertExe: 'C:\\app\\dependencies\\mkcert\\mkcert.exe',
        platform: 'win32',
        run,
        exists: () => false,
        readFile: () => '',
        chmod,
        removeCaRoot,
        removeLeaf,
        ensureCaRootDir,
        ...over,
    };
    return { svc: new CertService(deps), run, chmod, removeCaRoot, removeLeaf, ensureCaRootDir };
}

// A minimal in-memory "filesystem": exists()/readFile() consult a Set that
// removeCaRoot()/removeLeaf() actually mutate, and the default `run` mock
// re-populates it, the way a real successful mkcert invocation would. This
// is what makes revoke()/failed-generate assertions non-vacuous (F3/F4) --
// makeService()'s static `exists: () => false` cannot distinguish "never
// existed" from "was removed".
function makeStatefulService(runImpl?: CertServiceDeps['run']) {
    const paths = {
        caRoot: 'C:\\Users\\jane\\AppData\\Local\\WsScrcpyWeb\\tls\\ca',
        certFile: 'C:\\ProgramData\\WsScrcpyWeb\\tls\\cert.pem',
        keyFile: 'C:\\ProgramData\\WsScrcpyWeb\\tls\\key.pem',
    };
    const caRootPemPath = 'C:\\Users\\jane\\AppData\\Local\\WsScrcpyWeb\\tls\\ca\\rootCA.pem';
    const existing = new Set([paths.certFile, paths.keyFile, caRootPemPath]);
    const removeCaRoot = vi.fn(() => {
        existing.delete(caRootPemPath);
    });
    const removeLeaf = vi.fn(() => {
        existing.delete(paths.certFile);
        existing.delete(paths.keyFile);
    });
    const defaultRun: CertServiceDeps['run'] = async () => {
        // A real successful mkcert invocation (re)writes all three files.
        existing.add(caRootPemPath);
        existing.add(paths.certFile);
        existing.add(paths.keyFile);
        return { code: 0, stderr: '' };
    };
    const run = vi.fn(runImpl ?? defaultRun);
    const chmod = vi.fn();
    const deps: CertServiceDeps = {
        paths,
        mkcertExe: 'C:\\app\\dependencies\\mkcert\\mkcert.exe',
        platform: 'win32',
        run,
        exists: (p: string) => existing.has(p),
        readFile: (p: string) => {
            if (!existing.has(p)) {
                throw new Error(`ENOENT: no such file, open '${p}'`);
            }
            return FIXTURE_CERT_PEM;
        },
        chmod,
        removeCaRoot,
        removeLeaf,
        ensureCaRootDir: vi.fn(),
    };
    return { svc: new CertService(deps), run, removeCaRoot, removeLeaf, existing, paths, caRootPemPath };
}

describe('CertService.generate', () => {
    it('passes -cert-file and -key-file as ABSOLUTE paths', async () => {
        // Weak invariant, kept for documentation value: generate() forwards
        // deps.paths.certFile/keyFile unchanged, so this can only fail if
        // someone edits the fixture. The real guarantee -- that
        // resolveCertPaths() always returns absolute paths -- is Task 2's,
        // and Task 2's own suite is what actually proves it.
        const { svc, run } = makeService();
        await svc.generate('ip', '192.168.86.3');
        const args: string[] = run.mock.calls[0]![1];
        const cert = args[args.indexOf('-cert-file') + 1]!;
        const key = args[args.indexOf('-key-file') + 1]!;
        expect(/^[A-Za-z]:\\|^\//.test(cert)).toBe(true);
        expect(/^[A-Za-z]:\\|^\//.test(key)).toBe(true);
    });

    it('sets CAROOT to the per-user path, not the data root', async () => {
        const { svc, run } = makeService();
        await svc.generate('ip', '192.168.86.3');
        const env: Record<string, string> = run.mock.calls[0]![2];
        expect(env['CAROOT']!.toLowerCase()).not.toContain('programdata');
    });

    it('sets TRUST_STORES=none so a stray JAVA_HOME cannot abort generation', async () => {
        const { svc, run } = makeService();
        await svc.generate('ip', '192.168.86.3');
        expect(run.mock.calls[0]![2]['TRUST_STORES']).toBe('none');
    });

    it('constrains the CA by IP when the subject is an IP', async () => {
        // X.509 applies name constraints PER NAME TYPE. Constraining DNS alone
        // leaves IP addresses entirely unconstrained, and our subject is
        // usually a LAN IP -- so a DNS-only constraint would be theatre.
        const { svc, run } = makeService();
        await svc.generate('ip', '192.168.86.3');
        const args: string[] = run.mock.calls[0]![1];
        expect(args).toContain('-name-constraints');
        expect(args[args.indexOf('-name-constraints') + 1]).toContain('192.168.86.3');
    });

    it('names the CA so it is identifiable in a trust store years later', async () => {
        const { svc, run } = makeService();
        await svc.generate('hostname', 'devices.lan');
        const args: string[] = run.mock.calls[0]![1];
        expect(args).toContain('-ca-name');
        expect(args[args.indexOf('-ca-name') + 1]).toContain('ws-scrcpy-web');
    });

    it('refuses a subject that failed validation, without spawning anything', async () => {
        const { svc, run } = makeService();
        await expect(svc.generate('ip', '-Hevil.com')).rejects.toThrow(/invalid/i);
        expect(run).not.toHaveBeenCalled();
    });

    it('surfaces mkcert stderr verbatim on failure', async () => {
        // Only this half has teeth (F12): asserting getState().status here
        // too would be vacuous under makeService()'s exists: () => false --
        // it would say 'none' whether or not generate() failed. The
        // meaningful "what does a failed regenerate actually leave behind"
        // case is covered below with the stateful fake (F4).
        const run = vi.fn().mockResolvedValue({ code: 1, stderr: 'mkcert: boom' });
        const { svc } = makeService({ run });
        await expect(svc.generate('ip', '192.168.86.3')).rejects.toThrow(/mkcert: boom/);
    });

    it('resolves with the ready state carrying subject and kind (F10)', async () => {
        const { svc } = makeService();
        const result = await svc.generate('ip', '192.168.86.3');
        expect(result.status).toBe('ready');
        expect(result.subject).toBe('192.168.86.3');
        expect(result.kind).toBe('ip');
    });

    // --- controller amendments (2026-09-19) ---

    it('constrains BOTH name types on the IP path (an unconstrained DNS subtree is not "safe")', async () => {
        const { svc, run } = makeService();
        await svc.generate('ip', '192.168.86.3');
        const args: string[] = run.mock.calls[0]![1];
        const nc = args[args.indexOf('-name-constraints') + 1]!;
        // Split on "," rather than substring-testing (F11): a mutation that
        // returns only the CIDR half (the actual half-constrained/Critical
        // case) would still pass a bare .toContain('192.168.86.3') check,
        // since "192.168.86.3/32".includes("192.168.86.3") is true.
        const parts = nc.split(',');
        expect(parts).toContain('192.168.86.3');
        expect(parts).toContain('192.168.86.3/32');
    });

    it('calls removeCaRoot BEFORE run, so constraints always describe the CA actually minted', async () => {
        const { svc, run, removeCaRoot } = makeService();
        await svc.generate('ip', '192.168.86.3');
        expect(removeCaRoot.mock.invocationCallOrder[0]!).toBeLessThan(run.mock.invocationCallOrder[0]!);
    });

    it('rejects a subject carrying a port and never spawns', async () => {
        const { svc, run, removeCaRoot } = makeService();
        await expect(svc.generate('ip', '192.168.86.3:5555')).rejects.toThrow(/invalid/i);
        expect(run).not.toHaveBeenCalled();
        expect(removeCaRoot).not.toHaveBeenCalled();
    });

    it('chmods the leaf key 0o600 on POSIX after a successful generate (defence in depth -- see F15)', async () => {
        const { svc, chmod } = makeService({ platform: 'linux' });
        await svc.generate('ip', '192.168.86.3');
        expect(chmod).toHaveBeenCalledWith('C:\\ProgramData\\WsScrcpyWeb\\tls\\key.pem', 0o600);
    });

    it('does NOT chmod on win32 -- a Unix mode there maps to the read-only ATTRIBUTE, not an ACL, so the per-user directory is the real control', async () => {
        const { svc, chmod } = makeService({ platform: 'win32' });
        await svc.generate('ip', '192.168.86.3');
        expect(chmod).not.toHaveBeenCalled();
    });

    // --- review round 1 (2026-09-19) ---

    describe('F1: hostname subject must not be a bare TLD or common public suffix', () => {
        it('rejects a single-label public suffix like "com" (also blocks "lan" and "local")', async () => {
            const { svc, run, removeCaRoot } = makeService();
            await expect(svc.generate('hostname', 'com')).rejects.toThrow(/invalid/i);
            await expect(svc.generate('hostname', 'lan')).rejects.toThrow(/invalid/i);
            await expect(svc.generate('hostname', 'local')).rejects.toThrow(/invalid/i);
            expect(run).not.toHaveBeenCalled();
            expect(removeCaRoot).not.toHaveBeenCalled();
        });

        it('rejects a two-label public suffix like "co.uk", which clears the label-count rule alone', async () => {
            const { svc, run } = makeService();
            await expect(svc.generate('hostname', 'co.uk')).rejects.toThrow(/invalid/i);
            expect(run).not.toHaveBeenCalled();
        });

        it('allows "localhost" as the one legitimate single-label exception', async () => {
            const { svc, run } = makeService();
            await svc.generate('hostname', 'localhost');
            expect(run).toHaveBeenCalled();
        });

        it('allows an ordinary two-label LAN name', async () => {
            const { svc, run } = makeService();
            await svc.generate('hostname', 'devices.lan');
            expect(run).toHaveBeenCalled();
        });
    });

    describe('F2: an IPv6 subject is handled end-to-end, not just by the helper', () => {
        it('strips brackets for mkcert and uses "invalid" for the DNS side', async () => {
            const { svc, run } = makeService();
            await svc.generate('ip', '[::1]');
            const args: string[] = run.mock.calls[0]![1];
            // The trailing positional subject must be bare -- mkcert's
            // net.ParseIP does not accept a bracketed literal.
            expect(args[args.length - 1]).toBe('::1');
            const nc = args[args.indexOf('-name-constraints') + 1]!;
            expect(nc.split(',')).toEqual(['invalid', '::1/128']);
        });
    });

    describe('F8: mkcert can warn on an exit-0 path', () => {
        it('does not report ready when mkcert exits 0 but warns the CA is half-constrained', async () => {
            const run = vi.fn().mockResolvedValue({
                code: 0,
                stderr: 'Warning: these name constraints cover DNS names only, so this CA can still sign ANY IP address',
            });
            const { svc } = makeService({ run });
            await expect(svc.generate('ip', '192.168.86.3')).rejects.toThrow(/half-constrained/i);
        });

        it('still chmods the leaf key on POSIX before rejecting a half-constrained result (N4)', async () => {
            // The leaf key is already written by mkcert at this point regardless
            // of what the warning says, so the defence-in-depth chmod must not
            // be skipped just because generate() goes on to reject the result.
            const run = vi.fn().mockResolvedValue({
                code: 0,
                stderr: 'Warning: these name constraints cover DNS names only, so this CA can still sign ANY IP address',
            });
            const { svc, chmod } = makeService({ run, platform: 'linux' });
            await expect(svc.generate('ip', '192.168.86.3')).rejects.toThrow(/half-constrained/i);
            expect(chmod).toHaveBeenCalledWith('C:\\ProgramData\\WsScrcpyWeb\\tls\\key.pem', 0o600);
        });
    });

    describe('F9: kind must match the actual shape of value', () => {
        it('rejects a hostname kind whose value is actually an IP address', async () => {
            const { svc, run } = makeService();
            await expect(svc.generate('hostname', '192.168.86.3')).rejects.toThrow(/invalid/i);
            expect(run).not.toHaveBeenCalled();
        });

        it('rejects an ip kind whose value is actually a hostname', async () => {
            const { svc, run } = makeService();
            await expect(svc.generate('ip', 'devices.lan')).rejects.toThrow(/invalid/i);
            expect(run).not.toHaveBeenCalled();
        });
    });

    describe('N1: a bracketed subject on the hostname path must not reach mkcert', () => {
        // Re-review finding: stripBrackets was only applied for kind === 'ip',
        // so the hostname branch's isIP/isAcceptableHostnameSubject checks ran
        // against the BRACKETED string, which isIP reports as "not an IP" and
        // which split('.') sees as an ordinary (accepted) two-label name. The
        // value would then reach mkcert, which refuses it -- but only AFTER
        // removeCaRoot() had already destroyed a working CA. Asserting
        // removeCaRoot was never called is the point, not just the rejection.
        it('rejects a bracketed IPv4 literal before removeCaRoot runs', async () => {
            const { svc, run, removeCaRoot } = makeService();
            await expect(svc.generate('hostname', '[1.2.3.4]')).rejects.toThrow(/invalid/i);
            expect(run).not.toHaveBeenCalled();
            expect(removeCaRoot).not.toHaveBeenCalled();
        });

        it('rejects a bracketed IPv4-mapped IPv6 literal before removeCaRoot runs', async () => {
            const { svc, run, removeCaRoot } = makeService();
            await expect(svc.generate('hostname', '[::ffff:1.2.3.4]')).rejects.toThrow(/invalid/i);
            expect(run).not.toHaveBeenCalled();
            expect(removeCaRoot).not.toHaveBeenCalled();
        });
    });

    describe("M3: the CA directory gets an explicit POSIX mode, not just mkcert's own default", () => {
        // Contrast pair in one test: platform is the only thing that differs,
        // so a mutation that deletes the `platform !== 'win32'` gate (calling
        // ensureCaRootDir on BOTH platforms, or on NEITHER) fails one half or
        // the other, not just one isolated assertion.
        it('calls ensureCaRootDir on POSIX but NOT on win32, and before removeCaRoot/run', async () => {
            const posix = makeService({ platform: 'linux' });
            await posix.svc.generate('ip', '192.168.86.3');
            expect(posix.ensureCaRootDir).toHaveBeenCalledTimes(1);
            expect(posix.ensureCaRootDir.mock.invocationCallOrder[0]!).toBeLessThan(
                posix.run.mock.invocationCallOrder[0]!,
            );

            const windows = makeService({ platform: 'win32' });
            await windows.svc.generate('ip', '192.168.86.3');
            expect(windows.ensureCaRootDir).not.toHaveBeenCalled();
        });
    });
});

describe('CertService.revoke', () => {
    it('actually revokes: getState reports none afterward, not just the in-memory flag (F3)', () => {
        const { svc, removeCaRoot, removeLeaf, existing, paths } = makeStatefulService();
        expect(svc.getState().status).toBe('ready'); // leaf pre-exists in the fake
        svc.revoke();
        expect(removeCaRoot).toHaveBeenCalled();
        expect(removeLeaf).toHaveBeenCalled();
        expect(existing.has(paths.certFile)).toBe(false);
        expect(svc.getState().status).toBe('none');
    });
});

describe('CertService.getState', () => {
    it('reports none when no leaf exists', () => {
        const { svc } = makeService();
        expect(svc.getState().status).toBe('none');
    });

    it("populates notAfter from the leaf certificate's actual validity, as ISO 8601 (F6/F7)", () => {
        const { svc } = makeService({
            exists: () => true,
            readFile: () => FIXTURE_CERT_PEM,
        });
        const state = svc.getState();
        expect(state.status).toBe('ready');
        // Exact-match, not just "parses as a date" (F7): a mutation that
        // returns a fixed wrong date, or always "now" -- which would make
        // Task 8's 30-day warning fire never, the exact bug amendment H was
        // raised to fix -- must fail this test.
        expect(state.notAfter).toBe('2036-09-16T06:05:54.000Z');
    });

    it('never throws on an unparseable leaf -- an ordinary state, not a 500', () => {
        const { svc } = makeService({
            exists: () => true,
            readFile: () => 'not a certificate',
        });
        expect(() => svc.getState()).not.toThrow();
        const state = svc.getState();
        // Either reading is acceptable: the file exists but cannot be parsed.
        // What matters is that nothing is fabricated and nothing throws.
        expect(state.notAfter).toBeUndefined();
        expect(state.subject).toBeUndefined();
        expect(state.kind).toBeUndefined();
    });

    it('reflects subject and kind after generate (F10)', async () => {
        const { svc } = makeService({ exists: () => true });
        await svc.generate('hostname', 'devices.lan');
        const state = svc.getState();
        expect(state.subject).toBe('devices.lan');
        expect(state.kind).toBe('hostname');
    });

    describe('C2: hydrating subject/kind from the leaf when there is no in-memory state (e.g. after a restart)', () => {
        // What production change would make this test fail: deleting the
        // hydration branch in getState() (the one this finding is about)
        // makes BOTH assertions fail identically -- subject/kind stay
        // undefined for either leaf. A contrast pair inside one test catches
        // that a lot more honestly than two separate tests each asserting
        // one kind, which could both pass by coincidence if the branch
        // always returned, say, the IP case.
        it('an IP leaf and a hostname leaf hydrate to DIFFERENT kinds -- neither is a fresh generate() in this process', () => {
            const ipState = makeService({ exists: () => true, readFile: () => FIXTURE_LEAF_IP_PEM }).svc.getState();
            const hostState = makeService({
                exists: () => true,
                readFile: () => FIXTURE_LEAF_HOST_PEM,
            }).svc.getState();

            expect(ipState.status).toBe('ready');
            expect(ipState.subject).toBe('192.168.86.3');
            expect(ipState.kind).toBe('ip');

            expect(hostState.status).toBe('ready');
            expect(hostState.subject).toBe('devices.lan');
            expect(hostState.kind).toBe('hostname');

            expect(ipState.kind).not.toBe(hostState.kind);
            expect(ipState.subject).not.toBe(hostState.subject);
        });

        it('normalizes an IPv6 SAN to the bare, compressed form generate() itself would have stored', () => {
            const { svc } = makeService({ exists: () => true, readFile: () => FIXTURE_LEAF_IPV6_PEM });
            const state = svc.getState();
            expect(state.kind).toBe('ip');
            // X509Certificate's own rendering is fully expanded
            // ("0:0:0:0:0:0:0:1") -- if this test read that back unchanged,
            // Task 8's subject-vs-machine-address comparison would silently
            // stop matching after every restart.
            expect(state.subject).toBe('::1');
        });

        it('prefers in-memory subject/kind over the leaf on disk once generate() has run in this process', async () => {
            // The leaf on disk (a hostname cert) and the in-memory state
            // (from generate('ip', ...) below) deliberately disagree here,
            // so the assertion actually distinguishes "read from memory"
            // from "read from disk" rather than the two paths happening to
            // agree.
            const { svc } = makeService({ exists: () => true, readFile: () => FIXTURE_LEAF_HOST_PEM });
            await svc.generate('ip', '10.0.0.1');
            const state = svc.getState();
            expect(state.subject).toBe('10.0.0.1');
            expect(state.kind).toBe('ip');
        });
    });

    it('reports caPresent: true when the CA and leaf both exist', () => {
        const { svc } = makeStatefulService();
        expect(svc.getState().caPresent).toBe(true);
    });

    it('reports caPresent: false after a failed regenerate, even though the leaf (and "ready") survive (F4)', async () => {
        const failingRun: CertServiceDeps['run'] = async () => ({ code: 1, stderr: 'mkcert: boom' });
        const { svc, existing, paths, caRootPemPath } = makeStatefulService(failingRun);
        expect(svc.getState().status).toBe('ready'); // pre-existing, from the fake's initial state

        await expect(svc.generate('ip', '192.168.86.3')).rejects.toThrow(/boom/);

        // removeCaRoot() ran unconditionally before the (failing) spawn --
        // amendment C -- so the CA is gone, but nothing deletes the leaf on
        // a failed generate.
        expect(existing.has(caRootPemPath)).toBe(false);
        expect(existing.has(paths.certFile)).toBe(true);

        const state = svc.getState();
        expect(state.status).toBe('ready');
        expect(state.caPresent).toBe(false);
    });
});

// NF-1 (Critical, re-review): the HTTPS listener is created ONCE at boot
// with whatever leaf content Config.servers held then; a later generate()
// replaces the file on disk, but the listener keeps serving the OLD leaf
// until a restart -- `bound: true` on its own no longer means "serving the
// CURRENT certificate". `currentLeafFingerprint()` is the CertService half
// of detecting that: TlsApi compares this against the fingerprint
// HttpServer captured at bind time (see httpsListenerStatus.test.ts and
// buildHttpsListenerField's own tests for the other two halves of this).
// Deliberately kept OUT of CertState/getState() -- a comparison artifact,
// not something the panel needs to see in the JSON response.
describe('CertService.currentLeafFingerprint (NF-1)', () => {
    it('returns the real fingerprint of a readable, valid leaf', () => {
        const { svc } = makeService({ exists: () => true, readFile: () => FIXTURE_LEAF_IP_PEM });
        const fp = svc.currentLeafFingerprint();
        expect(typeof fp).toBe('string');
        expect(fp!.length).toBeGreaterThan(0);
    });

    // Paired: DIFFERENT cert content must produce a DIFFERENT fingerprint --
    // a hardcoded or memoized-wrong value would pass a single "returns a
    // string" assertion but fail this contrast.
    it('a different leaf produces a DIFFERENT fingerprint', () => {
        const { svc: svcA } = makeService({ exists: () => true, readFile: () => FIXTURE_LEAF_IP_PEM });
        const { svc: svcB } = makeService({ exists: () => true, readFile: () => FIXTURE_LEAF_HOST_PEM });
        expect(svcA.currentLeafFingerprint()).not.toBe(svcB.currentLeafFingerprint());
    });

    it('is stable for the SAME leaf content (not e.g. time-based)', () => {
        const { svc } = makeService({ exists: () => true, readFile: () => FIXTURE_LEAF_IP_PEM });
        expect(svc.currentLeafFingerprint()).toBe(svc.currentLeafFingerprint());
    });

    it('returns undefined, not a throw, when the leaf does not exist', () => {
        const { svc } = makeService({ exists: () => false, readFile: () => FIXTURE_LEAF_IP_PEM });
        expect(svc.currentLeafFingerprint()).toBeUndefined();
    });

    it('returns undefined, not a throw, when the leaf is unreadable or garbage', () => {
        const { svc } = makeService({
            exists: () => true,
            readFile: () => {
                throw new Error('EACCES');
            },
        });
        expect(svc.currentLeafFingerprint()).toBeUndefined();

        const { svc: svc2 } = makeService({ exists: () => true, readFile: () => 'not a certificate' });
        expect(svc2.currentLeafFingerprint()).toBeUndefined();
    });
});

describe('CertService.caRootPem', () => {
    it('returns the CA pem content when present', () => {
        const readFile = vi.fn((p: string) => {
            expect(p).toBe('C:\\Users\\jane\\AppData\\Local\\WsScrcpyWeb\\tls\\ca\\rootCA.pem');
            return FIXTURE_CERT_PEM;
        });
        const { svc } = makeService({ readFile });
        expect(svc.caRootPem()).toBe(FIXTURE_CERT_PEM);
    });

    it('returns undefined rather than throwing when the CA file is missing -- a GET route, not a 500 (F5)', () => {
        const { svc } = makeService({
            readFile: () => {
                throw new Error('ENOENT: no such file or directory');
            },
        });
        expect(() => svc.caRootPem()).not.toThrow();
        expect(svc.caRootPem()).toBeUndefined();
    });
});

describe('parseLeafSubject', () => {
    it('derives kind from the SAN prefix -- an IP entry and a DNS entry produce DIFFERENT kinds', () => {
        // A contrast pair inside one test: a broken parser that always
        // returned 'ip' (or always 'hostname') would still pass a test that
        // only checked one entry in isolation.
        const ip = parseLeafSubject('IP Address:192.168.86.3');
        const host = parseLeafSubject('DNS:devices.lan');
        expect(ip).toEqual({ subject: '192.168.86.3', kind: 'ip' });
        expect(host).toEqual({ subject: 'devices.lan', kind: 'hostname' });
        expect(ip!.kind).not.toBe(host!.kind);
    });

    it('normalizes a fully-expanded IPv6 SAN to the bare, compressed literal', () => {
        // X509Certificate.subjectAltName renders IPv6 expanded, never
        // compressed -- this is the one thing standing between that and the
        // "::1" the rest of this feature stores and compares against.
        expect(parseLeafSubject('IP Address:0:0:0:0:0:0:0:1')).toEqual({ subject: '::1', kind: 'ip' });
    });

    it('returns undefined for an absent, empty, or unrecognised SAN -- never a guess', () => {
        expect(parseLeafSubject(undefined)).toBeUndefined();
        expect(parseLeafSubject('')).toBeUndefined();
        expect(parseLeafSubject('something else entirely')).toBeUndefined();
    });
});

describe('nameConstraintsFor', () => {
    it('produces a non-empty IP range for an IPv4 subject, plus the bare name', () => {
        // cert.go's parseNameConstraints classifies an entry as a CIDR only if
        // it contains "/" -- a bare "192.168.86.3" matches the DNS-name regex
        // instead and would silently leave PermittedIPRanges empty.
        const nc = nameConstraintsFor('ip', '192.168.86.3');
        expect(nc).toContain('192.168.86.3/32');
        const parts = nc.split(',');
        expect(parts).toContain('192.168.86.3');
        expect(parts).toContain('192.168.86.3/32');
    });

    it('uses the RFC 2606 "invalid" TLD for the DNS side of an IPv6 subject, not the literal (F2)', () => {
        // cert.go's constraintHostRegexp rejects ":" and "[", so repeating an
        // IPv6 literal as a DNS entry (the IPv4 trick) is not just a
        // different choice -- it is a string mkcert refuses outright.
        const nc = nameConstraintsFor('ip', '::1');
        expect(nc).toBe('invalid,::1/128');
    });

    it('constrains the IP name type too on a hostname subject, via 0.0.0.0/32', () => {
        // 0.0.0.0/32 is not a real host, so this excludes every routable v4
        // and v6 address while still satisfying mkcert's requirement that
        // BOTH name types be constrained.
        const nc = nameConstraintsFor('hostname', 'devices.lan');
        expect(nc).toContain('0.0.0.0/32');
        expect(nc.split(',')).toContain('devices.lan');
    });
});
