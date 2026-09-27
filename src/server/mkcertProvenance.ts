import { createHash } from 'crypto';
import type { Bundle, VerifyOptions } from 'sigstore';
import { Logger } from './Logger';
import { fetchOkWithRetry, HttpStatusError, VERSION_CHECK_POLICY } from './util/fetchWithRetry';

const log = Logger.for('mkcertProvenance');

/**
 * I8, second form (2026-09-27). mkcert mints a CA the user installs into their
 * OS and phone trust stores, so what vouches for the download is the trust
 * model of the whole local-HTTPS feature.
 *
 * The first form pinned the release's SHA256SUMS digest in our source. That
 * held one release only, and the user moved mkcert to "latest", so the anchor
 * moves from a HASH in our source to an IDENTITY in our source: the manifest
 * must carry a Sigstore build-provenance attestation signed by the fork's own
 * release workflow at the exact tag being installed. Someone who can replace
 * release assets cannot produce that without also running the fork's workflow,
 * which takes push access to the fork, not just a stolen upload token.
 */
export const MKCERT_REPO = 'bilbospocketses/mkcert';
const SIGNER_WORKFLOW_URL = `https://github.com/${MKCERT_REPO}/.github/workflows/release.yml`;
const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';
const IN_TOTO_PAYLOAD_TYPE = 'application/vnd.in-toto+json';
const IN_TOTO_STATEMENT_V1 = 'https://in-toto.io/Statement/v1';
const SLSA_PROVENANCE_V1 = 'https://slsa.dev/provenance/v1';

/**
 * The tag shapes the fork publishes: plain `vX.Y.Z` from v0.1.0 on, and the
 * retired `v1.4.4-bt.N` line, which is still `latest` until v0.1.0 ships. The
 * tag comes from the GitHub API and ends up in a download URL and in the
 * identity pattern below, so anything else is refused rather than escaped.
 */
const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:-bt\.\d+)?$/;

export function isMkcertReleaseTag(tag: string): boolean {
    return RELEASE_TAG.test(tag);
}

/**
 * sigstore-js checks the certificate SAN with `san.match(pattern)`, an
 * UNANCHORED regex, so a bare URL would also accept a longer tag, a look-alike
 * repo or `githubXcom`. Anchored and fully escaped, and pinned to the exact tag
 * rather than `refs/tags/v*`, so one release's attestation cannot vouch for a
 * file claiming to belong to another.
 */
export function mkcertSignerIdentityPattern(tag: string): string {
    const literal = `${SIGNER_WORKFLOW_URL}@refs/tags/${tag}`.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    return `^${literal}$`;
}

export interface MkcertProvenanceDeps {
    /** Every attestation bundle GitHub holds for the digest; `[]` when there are none. */
    fetchBundles: (sha256Hex: string) => Promise<Bundle[]>;
    /** `sigstore.verify` in production; throws on any failure. */
    verifyBundle: (bundle: Bundle, options: VerifyOptions) => Promise<unknown>;
    /**
     * Where sigstore keeps its TUF metadata. Its default is under the running
     * user's home, which for the Windows service is the SYSTEM profile, so the
     * caller points it into the app's own dependencies folder instead.
     */
    tufCachePath: string;
}

export function defaultMkcertProvenanceDeps(tufCachePath: string): MkcertProvenanceDeps {
    return {
        fetchBundles: async (sha256Hex) => {
            const url = `https://api.github.com/repos/${MKCERT_REPO}/attestations/sha256:${sha256Hex}`;
            try {
                const res = await fetchOkWithRetry(url, {
                    init: { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ws-scrcpy-web' } },
                    ...VERSION_CHECK_POLICY,
                    onRetry: (n) => log.warn(`mkcert attestation lookup ${n.attempt}/${n.attempts}: ${n.reason}`),
                });
                const body = (await res.json()) as { attestations?: { bundle?: Bundle }[] };
                return (body.attestations ?? []).flatMap((a) => (a.bundle ? [a.bundle] : []));
            } catch (err) {
                // GitHub answers 404 for a digest it holds no attestation for.
                // That is a definite "none", which the caller refuses with its
                // own message; any other status is a lookup that did not happen.
                if (err instanceof HttpStatusError && err.status === 404) return [];
                throw err;
            }
        },
        // Loaded on demand: sigstore pulls in a TUF client and a signing stack
        // the server never needs unless someone turns HTTPS on.
        verifyBundle: async (bundle, options) => (await import('sigstore')).verify(bundle, options),
        tufCachePath,
    };
}

/**
 * Throws unless an attestation for `manifest`'s digest verifies against the
 * Sigstore public-good trust root, was signed by the fork's release workflow at
 * `tag`, and is an in-toto SLSA provenance statement whose subjects include
 * this manifest under its release name. Any one attestation passing is enough.
 */
export async function verifyMkcertManifestProvenance(
    manifest: string,
    tag: string,
    deps: MkcertProvenanceDeps,
): Promise<void> {
    if (!isMkcertReleaseTag(tag)) {
        throw new Error(`unexpected mkcert release tag ${JSON.stringify(tag)} -- refusing to install from it`);
    }
    const digest = createHash('sha256').update(manifest).digest('hex');
    const bundles = await deps.fetchBundles(digest);
    if (bundles.length === 0) {
        throw new Error(
            `no build-provenance attestation exists for mkcert ${tag}'s checksum manifest (sha256 ${digest}) ` +
                '-- refusing to trust it',
        );
    }

    const options: VerifyOptions = {
        certificateIssuer: GITHUB_ACTIONS_ISSUER,
        certificateIdentityURI: mkcertSignerIdentityPattern(tag),
        tufCachePath: deps.tufCachePath,
    };
    const failures: string[] = [];
    for (const bundle of bundles) {
        try {
            await deps.verifyBundle(bundle, options);
            assertStatementCoversManifest(bundle, digest, `mkcert-${tag}-SHA256SUMS.txt`);
            return;
        } catch (err) {
            failures.push(err instanceof Error ? err.message : String(err));
        }
    }
    throw new Error(
        `mkcert ${tag}'s checksum manifest has no attestation this app can verify (${failures.join('; ')}) ` +
            '-- refusing to trust it',
    );
}

/**
 * Runs only AFTER `verifyBundle` passed, so the payload read here is the one
 * the certificate signed. A genuine attestation proves nothing about THIS file
 * unless its statement names this file's digest.
 */
function assertStatementCoversManifest(bundle: Bundle, digest: string, releaseName: string): void {
    const envelope = (bundle as { dsseEnvelope?: { payload: string; payloadType: string } }).dsseEnvelope;
    if (!envelope || envelope.payloadType !== IN_TOTO_PAYLOAD_TYPE) {
        throw new Error('the attestation is not an in-toto statement');
    }
    const statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf-8')) as {
        _type?: string;
        predicateType?: string;
        subject?: { name?: string; digest?: { sha256?: string } }[];
    };
    if (statement._type !== IN_TOTO_STATEMENT_V1 || statement.predicateType !== SLSA_PROVENANCE_V1) {
        throw new Error(`the attestation is not SLSA build provenance (${statement.predicateType})`);
    }
    const covered = statement.subject?.some((s) => s.name === releaseName && s.digest?.sha256 === digest);
    if (!covered) {
        throw new Error(`the attestation does not cover ${releaseName} at sha256 ${digest}`);
    }
}
