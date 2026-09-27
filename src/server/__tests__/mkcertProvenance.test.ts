import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Bundle, VerifyOptions } from 'sigstore';
import { verify as sigstoreVerify } from 'sigstore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    defaultMkcertProvenanceDeps,
    isMkcertReleaseTag,
    type MkcertProvenanceDeps,
    mkcertSignerIdentityPattern,
    verifyMkcertManifestProvenance,
} from '../mkcertProvenance';

// The REAL checksum manifest of bilbospocketses/mkcert v1.4.4-bt.2 and the REAL
// build-provenance attestation GitHub holds for it, captured 2026-09-27 from
// /repos/bilbospocketses/mkcert/attestations/sha256:<digest>. Nothing here is
// synthetic, so the tests below exercise the actual Sigstore chain: the
// Fulcio certificate, the Rekor inclusion proof and the DSSE signature.
const FIXTURES = path.join(__dirname, 'fixtures');
const REAL_TAG = 'v1.4.4-bt.2';
const REAL_MANIFEST = fs.readFileSync(path.join(FIXTURES, 'mkcert-v1.4.4-bt.2-SHA256SUMS.txt'), 'utf-8');
const REAL_BUNDLE = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, 'mkcert-v1.4.4-bt.2-SHA256SUMS.sigstore.json'), 'utf-8'),
) as Bundle;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('the fixtures are the real bt.2 release, byte for byte', () => {
    it('the manifest still hashes to the digest the attestation names', () => {
        // If this fails, a formatter or an eol conversion touched the fixture,
        // and every "real crypto" test below is testing a different file.
        expect(sha256(REAL_MANIFEST)).toBe('d8cac61cd58e78b77ad889cacbad64e7f6c23179b1e9a94c1ed45a9d16a8589d');
    });
});

describe('verifyMkcertManifestProvenance — real Sigstore verification', () => {
    let tufCachePath: string;

    beforeEach(() => {
        tufCachePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-mkcert-tuf-'));
    });

    afterEach(() => {
        fs.rmSync(tufCachePath, { recursive: true, force: true });
    });

    /**
     * Real `sigstore.verify`, but against the trust root the library ships
     * rather than a fresh TUF fetch (`tufForceCache`), so CI needs no network.
     * Production refreshes TUF on every verify -- that is how a rotated Fulcio
     * or Rekor key reaches an installed app -- and this is the ONLY override.
     */
    function realDeps(bundles: Bundle[]): MkcertProvenanceDeps {
        return {
            fetchBundles: async () => bundles,
            verifyBundle: (bundle, options) => sigstoreVerify(bundle, { ...options, tufForceCache: true }),
            tufCachePath,
        };
    }

    it('accepts the real manifest under its real attestation', async () => {
        await expect(
            verifyMkcertManifestProvenance(REAL_MANIFEST, REAL_TAG, realDeps([REAL_BUNDLE])),
        ).resolves.toBeUndefined();
    });

    it('rejects that same genuine attestation when installing a DIFFERENT tag', async () => {
        // The signer identity is pinned to the exact tag being installed, so a
        // valid attestation from one release cannot vouch for another's files.
        await expect(verifyMkcertManifestProvenance(REAL_MANIFEST, 'v0.1.0', realDeps([REAL_BUNDLE]))).rejects.toThrow(
            /certificate identity/,
        );
    });

    it('rejects a tampered manifest even when handed the genuine attestation', async () => {
        // The attack a same-release checksum cannot stop: alter the manifest to
        // list a malicious binary's hash. The attestation still verifies -- it
        // is genuine -- but it vouches for the ORIGINAL manifest's digest.
        const tampered = REAL_MANIFEST.replace('f196c8154f66', '0000000000aa');
        expect(tampered).not.toBe(REAL_MANIFEST);
        await expect(verifyMkcertManifestProvenance(tampered, REAL_TAG, realDeps([REAL_BUNDLE]))).rejects.toThrow(
            /does not cover/,
        );
    });

    it('rejects an attestation whose signed payload was edited to name the tampered digest', async () => {
        const tampered = REAL_MANIFEST.replace('f196c8154f66', '0000000000aa');
        const forged = structuredClone(REAL_BUNDLE) as Bundle & { dsseEnvelope: { payload: string } };
        const payload = Buffer.from(forged.dsseEnvelope.payload, 'base64').toString('utf-8');
        forged.dsseEnvelope.payload = Buffer.from(payload.replace(sha256(REAL_MANIFEST), sha256(tampered))).toString(
            'base64',
        );
        await expect(verifyMkcertManifestProvenance(tampered, REAL_TAG, realDeps([forged]))).rejects.toThrow(
            /payload hash mismatch/,
        );
    });

    it('accepts when a later attestation verifies after an earlier one fails', async () => {
        const broken = structuredClone(REAL_BUNDLE) as Bundle & { dsseEnvelope: { signatures: { sig: string }[] } };
        broken.dsseEnvelope.signatures[0]!.sig = Buffer.from('not a signature').toString('base64');
        await expect(
            verifyMkcertManifestProvenance(REAL_MANIFEST, REAL_TAG, realDeps([broken, REAL_BUNDLE])),
        ).resolves.toBeUndefined();
    });
});

describe('verifyMkcertManifestProvenance — refusal paths', () => {
    it('refuses when GitHub holds no attestation for the manifest, without calling the verifier', async () => {
        const verifyBundle = vi.fn();
        const deps: MkcertProvenanceDeps = { fetchBundles: async () => [], verifyBundle, tufCachePath: '/unused' };
        await expect(verifyMkcertManifestProvenance(REAL_MANIFEST, REAL_TAG, deps)).rejects.toThrow(
            /no build-provenance attestation/,
        );
        expect(verifyBundle).not.toHaveBeenCalled();
    });

    it('refuses a tag that is not a release-tag shape before fetching anything', async () => {
        const fetchBundles = vi.fn();
        const deps: MkcertProvenanceDeps = { fetchBundles, verifyBundle: vi.fn(), tufCachePath: '/unused' };
        await expect(verifyMkcertManifestProvenance(REAL_MANIFEST, 'v0.1.0$|.*', deps)).rejects.toThrow(
            /unexpected mkcert release tag/,
        );
        expect(fetchBundles).not.toHaveBeenCalled();
    });

    it('hands the verifier the GitHub Actions issuer, the tag-pinned identity and the TUF cache path', async () => {
        let seen: VerifyOptions | undefined;
        const deps: MkcertProvenanceDeps = {
            fetchBundles: async () => [REAL_BUNDLE],
            verifyBundle: async (_bundle, options) => {
                seen = options;
            },
            tufCachePath: '/data/deps/.sigstore',
        };
        await verifyMkcertManifestProvenance(REAL_MANIFEST, REAL_TAG, deps);
        expect(seen).toEqual({
            certificateIssuer: 'https://token.actions.githubusercontent.com',
            certificateIdentityURI: mkcertSignerIdentityPattern(REAL_TAG),
            tufCachePath: '/data/deps/.sigstore',
        });
    });
});

describe('isMkcertReleaseTag', () => {
    it.each(['v0.1.0', 'v1.4.4-bt.2', 'v12.30.456'])('accepts %s', (tag) => {
        expect(isMkcertReleaseTag(tag)).toBe(true);
    });

    it.each(['0.1.0', 'v0.1', 'v0.1.0-rc.1', 'v0.1.0 ', 'v0.1.0/../x', 'v0.1.0$|.*', ''])('rejects %j', (tag) => {
        expect(isMkcertReleaseTag(tag)).toBe(false);
    });
});

describe('mkcertSignerIdentityPattern', () => {
    // sigstore-js tests the certificate SAN with `san.match(pattern)` -- an
    // UNANCHORED regex. These run the same operation on the same string shape.
    const id = (s: string) => new RegExp(mkcertSignerIdentityPattern('v0.1.0')).test(s);
    const GOOD = 'https://github.com/bilbospocketses/mkcert/.github/workflows/release.yml@refs/tags/v0.1.0';

    it('matches the fork release workflow at exactly that tag', () => {
        expect(id(GOOD)).toBe(true);
    });

    it.each([
        ['a longer tag', `${GOOD}-evil`],
        ['a branch of the same name', GOOD.replace('refs/tags', 'refs/heads')],
        ['a look-alike repo', GOOD.replace('bilbospocketses/mkcert/', 'bilbospocketses/mkcert-evil/')],
        ['another owner', GOOD.replace('bilbospocketses', 'someone-else')],
        ['another workflow', GOOD.replace('release.yml', 'test.yml')],
        ['a prefix before the URL', `https://evil.example/?${GOOD}`],
        ['any-char where a dot is', GOOD.replace('github.com', 'githubXcom')],
    ])('does not match %s', (_label, san) => {
        expect(id(san)).toBe(false);
    });
});

describe('defaultMkcertProvenanceDeps().fetchBundles', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    afterEach(() => {
        fetchSpy?.mockRestore();
    });

    it('asks GitHub for attestations of that exact digest and returns their bundles', async () => {
        const urls: string[] = [];
        fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input: string | URL | Request) => {
            urls.push(String(input instanceof Request ? input.url : input));
            return new Response(JSON.stringify({ attestations: [{ bundle: REAL_BUNDLE }] }), { status: 200 });
        });
        const bundles = await defaultMkcertProvenanceDeps('/unused').fetchBundles('ab'.repeat(32));
        expect(urls).toEqual([
            `https://api.github.com/repos/bilbospocketses/mkcert/attestations/sha256:${'ab'.repeat(32)}`,
        ]);
        expect(bundles).toEqual([REAL_BUNDLE]);
    });

    it('treats a 404 as "no attestation exists", not as a lookup failure', async () => {
        fetchSpy = vi
            .spyOn(global, 'fetch')
            .mockImplementation(async () => new Response('{"message":"Not Found"}', { status: 404 }));
        await expect(defaultMkcertProvenanceDeps('/unused').fetchBundles('ab'.repeat(32))).resolves.toEqual([]);
    });

    it('surfaces a refused lookup (403 rate limit) as an error rather than as "none"', async () => {
        fetchSpy = vi
            .spyOn(global, 'fetch')
            .mockImplementation(async () => new Response('rate limited', { status: 403 }));
        await expect(defaultMkcertProvenanceDeps('/unused').fetchBundles('ab'.repeat(32))).rejects.toThrow(/403/);
    });
});
