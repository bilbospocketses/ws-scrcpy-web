import { isConnectAddress } from '../security/deviceInput';
import type { CertPaths } from './certPaths';

export type CertSubjectKind = 'ip' | 'hostname';

export interface CertState {
    status: 'none' | 'ready';
    subject?: string;
    kind?: CertSubjectKind;
    notAfter?: string;
}

export interface CertServiceDeps {
    paths: CertPaths;
    mkcertExe: string;
    /** So the POSIX chmod path below is testable ON Windows. */
    platform: NodeJS.Platform;
    run: (exe: string, args: string[], env: Record<string, string>) => Promise<{ code: number; stderr: string }>;
    exists: (p: string) => boolean;
    readFile: (p: string) => string;
    chmod: (p: string, mode: number) => void;
    /** Deletes rootCA.pem and rootCA-key.pem from paths.caRoot. */
    removeCaRoot: () => void;
}

/**
 * `-name-constraints` value for a single-subject local CA.
 *
 * `cert.go`'s `parseNameConstraints` classifies each entry by whether it
 * contains "/": with a slash it becomes a CIDR in `PermittedIPRanges`;
 * without one it matches the DNS-name regex and becomes a
 * `PermittedDNSDomains` entry instead. A bare IP literal like "192.168.86.3"
 * has no slash and DOES match that regex (digits and dots are legal hostname
 * characters), so passing it unconstrained would silently leave
 * `PermittedIPRanges` empty -- a CA that looks constrained but signs any IP.
 *
 * mkcert also warns when either name type is left empty, because a
 * half-constrained CA "looks protected" while not being. So every call here
 * constrains BOTH types:
 *  - an IP subject repeats the literal as a DNS entry (harmless: it only
 *    matters to a validator that reads CN-as-a-DNS-name when SANs are
 *    absent) alongside its own CIDR (/32 for IPv4, /128 for IPv6);
 *  - a hostname subject permits only 0.0.0.0/32, which no real host is, so
 *    every routable v4 and v6 address is excluded from the IP side.
 */
export function nameConstraintsFor(kind: CertSubjectKind, value: string): string {
    if (kind === 'hostname') {
        return `${value},0.0.0.0/32`;
    }
    const cidrSuffix = value.includes(':') ? '128' : '32';
    return `${value},${value}/${cidrSuffix}`;
}

// isConnectAddress permits an optional ":port" because it validates *connect*
// addresses (adb host:port). A certificate subject is a name, never a
// connect target, so a port here is rejected rather than silently handed to
// mkcert. Mirrors isConnectAddress's own address shapes (bracketed IPv6, or
// a bare IPv4/hostname) so it recognises exactly the same port suffix that
// function would have accepted.
const SUBJECT_WITH_PORT_RE =
    /^(?:\[[0-9A-Fa-f:.]{2,45}\]|[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*):\d{1,5}$/;

/**
 * Owns the certificate lifecycle. Every process boundary goes through
 * `deps.run`, so the whole class is testable without spawning mkcert.
 *
 * The mkcert invocation requirements are enforced HERE rather than at the
 * call site, so there is one place to check them: absolute
 * -cert-file/-key-file, a per-user CAROOT, TRUST_STORES=none, a validated
 * (and port-free) subject, and name constraints that cover both name types.
 */
export class CertService {
    private state: CertState = { status: 'none' };

    constructor(private readonly deps: CertServiceDeps) {}

    getState(): CertState {
        if (this.state.status === 'ready') return this.state;
        if (this.deps.exists(this.deps.paths.certFile)) return { ...this.state, status: 'ready' };
        return { status: 'none' };
    }

    async generate(kind: CertSubjectKind, value: string): Promise<CertState> {
        // Validated BEFORE the spawn -- and before removeCaRoot, so a rejected
        // subject leaves an existing CA untouched.
        if (!isConnectAddress(value) || SUBJECT_WITH_PORT_RE.test(value)) {
            throw new Error(`invalid certificate subject: ${JSON.stringify(value)}`);
        }

        // -name-constraints and -ca-name are read ONLY when the CA is created
        // (cert.go's loadCA calls newCA() only if rootCA.pem is absent), so an
        // existing CAROOT silently keeps whatever constraints it was minted
        // with. Remove it unconditionally so the constraints we pass below
        // always describe the CA mkcert is about to create -- there is no
        // stored "previous subject" to drift out of sync with this one.
        // The cost is a fresh CA (and a re-download) on every regenerate;
        // that is already the flow, and it is visible rather than silent.
        this.deps.removeCaRoot();

        const { caRoot, certFile, keyFile } = this.deps.paths;
        const args = [
            '-cert-file',
            certFile,
            '-key-file',
            keyFile,
            '-ca-name',
            'ws-scrcpy-web local CA',
            '-name-constraints',
            nameConstraintsFor(kind, value),
            value,
        ];
        const env: Record<string, string> = { CAROOT: caRoot, TRUST_STORES: 'none' };

        const { code, stderr } = await this.deps.run(this.deps.mkcertExe, args, env);
        if (code !== 0) {
            throw new Error(`mkcert failed (exit ${code}): ${stderr.trim()}`);
        }

        // Leaf key permissions. On Windows the leaf lives in the per-user
        // directory Task 2 resolved (AppData\Local), whose inherited ACL is
        // already restrictive -- writing a POSIX mode there would do nothing
        // while looking like it did: Go maps a Unix mode to the read-only
        // ATTRIBUTE on Windows and sets no ACL (measured 2026-09-18). POSIX has
        // no such directory-level control, so the key's exposure depends
        // entirely on this chmod actually running.
        if (this.deps.platform !== 'win32') {
            this.deps.chmod(keyFile, 0o600);
        }

        this.state = { status: 'ready', subject: value, kind };
        return this.state;
    }

    caRootPem(): string {
        const sep = this.deps.platform === 'win32' ? '\\' : '/';
        return this.deps.readFile(`${this.deps.paths.caRoot}${sep}rootCA.pem`);
    }

    revoke(): void {
        this.deps.removeCaRoot();
        this.state = { status: 'none' };
    }
}
