import { describe, expect, it, vi } from 'vitest';
import { CertService, type CertServiceDeps, nameConstraintsFor } from './CertService';

function makeService(over: Partial<CertServiceDeps> = {}) {
    const run = vi.fn().mockResolvedValue({ code: 0, stderr: '' });
    const chmod = vi.fn();
    const removeCaRoot = vi.fn();
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
        ...over,
    };
    return { svc: new CertService(deps), run, chmod, removeCaRoot };
}

describe('CertService.generate', () => {
    it('passes -cert-file and -key-file as ABSOLUTE paths', async () => {
        // mkcert writes leaves to the PROCESS CWD otherwise, and a spawned
        // process inherits whatever cwd it was given.
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

    it('surfaces mkcert stderr verbatim and writes no state on failure', async () => {
        const run = vi.fn().mockResolvedValue({ code: 1, stderr: 'mkcert: boom' });
        const { svc } = makeService({ run });
        await expect(svc.generate('ip', '192.168.86.3')).rejects.toThrow(/mkcert: boom/);
        expect(svc.getState().status).toBe('none');
    });

    // --- controller amendments (2026-09-19) ---

    it('constrains BOTH name types on the IP path (an unconstrained DNS subtree is not "safe")', async () => {
        const { svc, run } = makeService();
        await svc.generate('ip', '192.168.86.3');
        const args: string[] = run.mock.calls[0]![1];
        const nc = args[args.indexOf('-name-constraints') + 1];
        expect(nc).toContain('192.168.86.3/32');
        expect(nc).toContain('192.168.86.3');
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

    it('chmods the leaf key 0o600 on POSIX after a successful generate', async () => {
        const { svc, chmod } = makeService({ platform: 'linux' });
        await svc.generate('ip', '192.168.86.3');
        expect(chmod).toHaveBeenCalledWith('C:\\ProgramData\\WsScrcpyWeb\\tls\\key.pem', 0o600);
    });

    it('does NOT chmod on win32 -- a Unix mode there maps to the read-only ATTRIBUTE, not an ACL, so the per-user directory is the real control', async () => {
        const { svc, chmod } = makeService({ platform: 'win32' });
        await svc.generate('ip', '192.168.86.3');
        expect(chmod).not.toHaveBeenCalled();
    });
});

describe('CertService.revoke', () => {
    it('calls removeCaRoot and resets state to none', () => {
        const { svc, removeCaRoot } = makeService();
        svc.revoke();
        expect(removeCaRoot).toHaveBeenCalled();
        expect(svc.getState().status).toBe('none');
    });
});

// A real self-signed EC cert (CN=ws-scrcpy-web-test-fixture, generated with
// `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -days
// 3650 -nodes`, valid to 2036-09-16). A fixed constant is deliberate: this
// test is about PARSING a leaf's validity, not about mkcert's issuance, so it
// needs no spawn and no network.
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

describe('CertService.getState', () => {
    it('reports none when no leaf exists', () => {
        const { svc } = makeService();
        expect(svc.getState().status).toBe('none');
    });

    it("populates notAfter from the leaf certificate's actual validity", () => {
        const { svc } = makeService({
            exists: () => true,
            readFile: () => FIXTURE_CERT_PEM,
        });
        const state = svc.getState();
        expect(state.status).toBe('ready');
        expect(state.notAfter).toBeDefined();
        expect(Number.isNaN(new Date(state.notAfter as string).getTime())).toBe(false);
    });

    it('never throws on an unparseable leaf -- an ordinary state, not a 500', () => {
        const { svc } = makeService({
            exists: () => true,
            readFile: () => 'not a certificate',
        });
        expect(() => svc.getState()).not.toThrow();
        const state = svc.getState();
        // Either reading is acceptable: the file exists but cannot be parsed.
        // What matters is that no notAfter is fabricated and nothing throws.
        expect(state.notAfter).toBeUndefined();
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

    it('uses /128, not /32, for an IPv6 subject', () => {
        const nc = nameConstraintsFor('ip', '::1');
        expect(nc).toContain('::1/128');
        expect(nc).not.toContain('/32');
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
