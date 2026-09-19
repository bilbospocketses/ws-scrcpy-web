import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import path from 'path';
import { isConnectAddress } from '../security/deviceInput';
import type { CertPaths } from './certPaths';

export type CertSubjectKind = 'ip' | 'hostname';

export interface CertState {
    status: 'none' | 'ready';
    subject?: string;
    kind?: CertSubjectKind;
    /** ISO 8601, e.g. "2036-09-16T06:05:54.000Z" -- from the leaf's own validity. */
    notAfter?: string;
    /**
     * Whether CAROOT's rootCA.pem currently exists. `generate()` deletes it
     * before every spawn (amendment C), so this can be `false` even while
     * `status` is still `'ready'` and the previous leaf is still valid --
     * that combination means "a regenerate failed after removing the old CA;
     * the leaf still works, but re-download/re-issue needs a fresh attempt."
     */
    caPresent?: boolean;
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
    /** Deletes certFile and keyFile from paths. */
    removeLeaf: () => void;
}

// A small, explicit denylist of common public suffixes -- NOT a Public Suffix
// List implementation and not claimed to be complete. It exists only to catch
// the obvious, high-impact mistake (see isAcceptableHostnameSubject below):
// a bare TLD or a widely-used second-level public suffix, under which
// unrelated third parties register names the requester does not own.
const PUBLIC_SUFFIX_DENYLIST = new Set([
    'com',
    'net',
    'org',
    'io',
    'dev',
    'app',
    'co',
    'me',
    'info',
    'biz',
    'gov',
    'edu',
    'mil',
    'co.uk',
    'org.uk',
    'ac.uk',
    'com.au',
    'net.au',
    'org.au',
    'com.br',
    'co.jp',
    'co.nz',
    'co.za',
    'com.cn',
    'co.in',
]);

/**
 * Whether a hostname subject is a name the requester could plausibly own,
 * rather than a bare TLD or a common public suffix.
 *
 * F1: `cert.go:508-510`'s DNS branch appends the subject prefixed with "."
 * UNCONDITIONALLY (`dns = append(dns, entry, "."+entry)`), so the resulting
 * CA is constrained to `{subject, *.subject}`, never to the subject alone.
 * `nameConstraintsFor` cannot fix this from the constraint string -- there is
 * no flag for "exact match only" in this fork. So the guard belongs here,
 * before the CA is ever minted: reject a subject too short, or too common, to
 * be something only the requester controls. `localhost` is the one
 * legitimate single-label exception.
 */
function isAcceptableHostnameSubject(value: string): boolean {
    if (value.toLowerCase() === 'localhost') return true;
    const labels = value.split('.');
    if (labels.length < 2) return false; // "com", "lan", "local", ...
    return !PUBLIC_SUFFIX_DENYLIST.has(value.toLowerCase());
}

/** Strips one pair of surrounding brackets from a bracketed IPv6 literal. */
function stripBrackets(value: string): string {
    return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

/**
 * `-name-constraints` value for a single-subject local CA. `value` MUST
 * already be bare (no surrounding brackets) -- see `stripBrackets` at the
 * call site.
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
 *  - an IPv4 subject repeats the literal as a DNS entry (harmless: it only
 *    matters to a validator that reads CN-as-a-DNS-name when SANs are
 *    absent) alongside its own /32 CIDR;
 *  - an IPv6 subject CANNOT use that trick: `constraintHostRegexp` rejects
 *    ":" and "[", so the literal is not a legal DNS entry at all. We use the
 *    RFC 2606 reserved "invalid" TLD instead -- it parses as a DNS name
 *    (keeping `PermittedDNSDomains` non-empty, so mkcert does not warn) and
 *    can never resolve, so it grants no real name. The /128 CIDR is what
 *    actually constrains the IP side;
 *  - a hostname subject permits only 0.0.0.0/32, which no real host is, so
 *    every routable v4 and v6 address is excluded from the IP side.
 *
 * F1, IMPORTANT: for a hostname subject this does NOT constrain the CA to
 * that subject alone -- see `isAcceptableHostnameSubject`. The CA this
 * produces permits the subject AND the entire subtree beneath it, which is
 * exactly why the subject must be a name only the requester could own.
 */
export function nameConstraintsFor(kind: CertSubjectKind, value: string): string {
    if (kind === 'hostname') {
        return `${value},0.0.0.0/32`;
    }
    if (value.includes(':')) {
        return `invalid,${value}/128`;
    }
    return `${value},${value}/32`;
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
 * (port-free, kind-consistent, subtree-acceptable) subject, name constraints
 * that cover both name types, and a check that mkcert didn't warn its way to
 * a half-constrained CA on an exit-0 path.
 */
export class CertService {
    private state: CertState = { status: 'none' };

    constructor(private readonly deps: CertServiceDeps) {}

    getState(): CertState {
        if (!this.deps.exists(this.deps.paths.certFile)) {
            return { status: 'none' };
        }
        const base: CertState = this.state.status === 'ready' ? this.state : { status: 'ready' };
        const caPresent = this.deps.exists(this.caRootPemPath());
        const notAfter = this.readNotAfter();
        return {
            ...base,
            caPresent,
            ...(notAfter !== undefined ? { notAfter } : {}),
        };
    }

    private caRootPemPath(): string {
        const pathModule = this.deps.platform === 'win32' ? path.win32 : path.posix;
        return pathModule.join(this.deps.paths.caRoot, 'rootCA.pem');
    }

    /**
     * Reads the leaf's actual validity out of the certificate itself, via
     * Node's builtin `X509Certificate` -- never a hand-rolled DER parse, and
     * never `fs` directly (the injected `readFile` is what keeps this class
     * disk-free under test).
     *
     * `getState()` runs on a plain GET route, so a missing, empty or
     * unparseable leaf is an ordinary state (no `notAfter`), never a thrown
     * error that would turn into a 500.
     */
    private readNotAfter(): string | undefined {
        try {
            const pem = this.deps.readFile(this.deps.paths.certFile);
            if (!pem) return undefined;
            // .validTo is OpenSSL's ASN1_TIME rendering (e.g. "Sep 16
            // 06:05:54 2036 GMT") -- not ISO 8601, not a format any other
            // consumer should be expected to parse, and an odd thing to put
            // on a JSON API. .validToDate is a Date on this runtime.
            return new X509Certificate(pem).validToDate.toISOString();
        } catch {
            return undefined;
        }
    }

    async generate(kind: CertSubjectKind, value: string): Promise<CertState> {
        // Validated BEFORE the spawn -- and before removeCaRoot, so a rejected
        // subject leaves an existing CA untouched.
        if (!isConnectAddress(value) || SUBJECT_WITH_PORT_RE.test(value)) {
            throw new Error(`invalid certificate subject: ${JSON.stringify(value)}`);
        }

        // F9: `kind` is a caller-supplied label, not derived from `value`, so
        // a caller can hand it a value that does not match. mkcert classifies
        // the SAN type by content, not by our `kind`, so a mismatch parses
        // cleanly, exits 0, and mints a cert whose actual SAN type falls
        // outside the constraints we built for the OTHER type -- silently:
        // "ready", and a browser NAME_CONSTRAINT_VIOLATION with nothing in
        // this stack having reported a problem.
        //
        // N1: brackets are stripped UNCONDITIONALLY, before the cross-check --
        // not just for kind 'ip'. A bracketed literal like "[1.2.3.4]" or
        // "[::ffff:1.2.3.4]" is neither a real hostname nor something
        // isIP(value) (bracketed) recognises as an IP, so the un-stripped
        // check let it slip past both guards on the hostname path and reach
        // mkcert, which refused it at main.go:176 -- but only AFTER
        // removeCaRoot() below had already destroyed a working CA.
        const bareValue = stripBrackets(value);
        if (kind === 'ip') {
            if (isIP(bareValue) === 0) {
                throw new Error(
                    `invalid certificate subject: kind 'ip' but ${JSON.stringify(value)} is not an IP address`,
                );
            }
        } else {
            if (isIP(bareValue) !== 0) {
                throw new Error(
                    `invalid certificate subject: kind 'hostname' but ${JSON.stringify(value)} is an IP address`,
                );
            }
            if (!isAcceptableHostnameSubject(bareValue)) {
                throw new Error(
                    `invalid certificate subject: ${JSON.stringify(value)} is too short, or a public suffix, to safely constrain a CA to`,
                );
            }
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
            nameConstraintsFor(kind, bareValue),
            // The trailing positional subject: for an IPv6 kind this MUST be
            // bare too -- mkcert's net.ParseIP does not accept a bracketed
            // literal.
            bareValue,
        ];
        const env: Record<string, string> = { CAROOT: caRoot, TRUST_STORES: 'none' };

        const { code, stderr } = await this.deps.run(this.deps.mkcertExe, args, env);
        if (code !== 0) {
            throw new Error(`mkcert failed (exit ${code}): ${stderr.trim()}`);
        }

        // Leaf key permissions -- applied BEFORE the F8 half-constrained check
        // below (N4): mkcert has already written the leaf key at this point
        // regardless of what the constraints turned out to cover, so a
        // rejection on the next line must not skip the chmod and leave that
        // key without the defence-in-depth mode. mkcert already writes the
        // key 0600 on this fork (cert.go: os.WriteFile(keyFile, privPEM,
        // 0600)), so on POSIX this chmod is defence in depth, not the only
        // thing protecting the key -- it costs nothing and stops being
        // redundant the moment this points at a different mkcert build, the
        // same argument the file already makes about isConnectAddress. On
        // Windows it is skipped: the leaf lives in the per-user directory
        // Task 2 resolved (AppData\Local), whose inherited ACL is the real
        // control there, because Go maps a Unix mode to the read-only
        // ATTRIBUTE on Windows and sets no ACL (measured 2026-09-18).
        if (this.deps.platform !== 'win32') {
            this.deps.chmod(keyFile, 0o600);
        }

        // F8: mkcert warns rather than fails when a name-constrained CA ends
        // up covering only one name TYPE (cert.go:383-390) -- exit 0, so the
        // check above lets it through. That is the spec's worst case (a CA
        // that "looks protected" while not being), so it must not be
        // reported as a clean `ready`. No reachable input produces this today
        // (every branch above supplies both types), but it costs three lines
        // and it is the one condition worth spending them on.
        if (/^Warning:/m.test(stderr)) {
            throw new Error(`mkcert produced a half-constrained CA, refusing to report ready: ${stderr.trim()}`);
        }

        this.state = { status: 'ready', subject: bareValue, kind };
        return this.state;
    }

    /**
     * Reads the CA's root certificate for the download route. Same no-throw
     * contract as `getState()`/`readNotAfter` (amendment H): a missing, empty
     * or unparseable file is an ordinary state on a plain GET route --
     * `undefined`, for the caller to turn into a 404 -- never a thrown 500.
     * F4 makes "missing" a common case, not an exotic one: every failed
     * regenerate deletes this file on purpose (amendment C), whether or not
     * the leaf survives.
     */
    caRootPem(): string | undefined {
        try {
            return this.deps.readFile(this.caRootPemPath());
        } catch {
            return undefined;
        }
    }

    revoke(): void {
        this.deps.removeCaRoot();
        this.deps.removeLeaf();
        this.state = { status: 'none' };
    }
}
