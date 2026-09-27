import type { SerializedBundle } from '@sigstore/bundle';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createSigstoreVerifier,
    defaultMkcertProvenanceDeps,
    isMkcertReleaseTag,
    type MkcertProvenanceDeps,
    type MkcertSignerPolicy,
    mkcertSignerIdentityPattern,
    verifyMkcertManifestProvenance,
} from '../mkcertProvenance';

// The REAL checksum manifest of bilbospocketses/mkcert v0.1.0 and the REAL
// build-provenance attestation GitHub holds for it, captured 2026-09-27 from
// /repos/bilbospocketses/mkcert/attestations/sha256:<digest>. Nothing here is
// synthetic, so the tests below exercise the actual Sigstore chain: the
// Fulcio certificate, the Rekor inclusion proof and the DSSE signature.
const FIXTURES = path.join(__dirname, 'fixtures');
const REAL_TAG = 'v0.1.0';
const REAL_MANIFEST = fs.readFileSync(path.join(FIXTURES, 'mkcert-v0.1.0-SHA256SUMS.txt'), 'utf-8');
const REAL_BUNDLE = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, 'mkcert-v0.1.0-SHA256SUMS.sigstore.json'), 'utf-8'),
) as SerializedBundle;
// The windows-amd64 line's digest prefix, edited to fake a malicious binary.
const WINDOWS_DIGEST_PREFIX = '33ce34de3be5';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

type Envelope = { payload: string; payloadType: string; signatures: { sig: string }[] };
const withEnvelope = (b: SerializedBundle) => b as SerializedBundle & { dsseEnvelope: Envelope };

/**
 * What each verifier call concluded, recorded around the real verifier. A
 * refusal test asserts on this as well as on the thrown message, so it proves
 * WHICH layer refused and that every other layer passed. That is the claim a
 * mutation run would test by deleting a check; stated as an assertion, it
 * holds on every run without weakening anything.
 */
type Outcome = { passed: true } | { passed: false; code: string | undefined; message: string };
function recording(verify: MkcertProvenanceDeps['verifyBundle']) {
    const outcomes: Outcome[] = [];
    const verifyBundle: MkcertProvenanceDeps['verifyBundle'] = async (bundle, policy) => {
        try {
            await verify(bundle, policy);
            outcomes.push({ passed: true });
        } catch (err) {
            const e = err as Error & { code?: string };
            outcomes.push({ passed: false, code: e.code, message: e.message });
            throw err;
        }
    };
    return { verifyBundle, outcomes };
}

describe('the fixtures are the real v0.1.0 release, byte for byte', () => {
    it('the manifest still hashes to the digest the attestation names', () => {
        // If this fails, a formatter or an eol conversion touched the fixture,
        // and every "real crypto" test below is testing a different file.
        expect(sha256(REAL_MANIFEST)).toBe('da533f1951be4b13cf85cbff2fb60336b2b08d76607cae3fdb3479d1e2641e57');
        expect(REAL_MANIFEST).toContain(`${WINDOWS_DIGEST_PREFIX}`);
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
     * The production verifier, but against the trust root the library ships
     * rather than a fresh TUF fetch (`tufForceCache`), so CI needs no network.
     * Production refreshes TUF on every verify -- that is how a rotated Fulcio
     * or Rekor key reaches an installed app -- and this is the ONLY override.
     */
    function realDeps(bundles: SerializedBundle[]) {
        const { verifyBundle, outcomes } = recording(createSigstoreVerifier({ tufCachePath, tufForceCache: true }));
        const deps: MkcertProvenanceDeps = { fetchBundles: async () => bundles, verifyBundle };
        return { deps, outcomes };
    }

    it('accepts the real manifest under its real attestation, and the signature layer is what passed it', async () => {
        const { deps, outcomes } = realDeps([REAL_BUNDLE]);
        await expect(verifyMkcertManifestProvenance(REAL_MANIFEST, REAL_TAG, deps)).resolves.toBeUndefined();
        expect(outcomes).toEqual([{ passed: true }]);
    });

    it('keeps its TUF metadata under the cache path it is given', async () => {
        // The default is the running user's home, which for the Windows service
        // is the SYSTEM profile; DependencyManager points this at <deps>/.sigstore.
        const { deps } = realDeps([REAL_BUNDLE]);
        await verifyMkcertManifestProvenance(REAL_MANIFEST, REAL_TAG, deps);
        expect(fs.existsSync(path.join(tufCachePath, 'tuf-repo-cdn.sigstore.dev', 'root.json'))).toBe(true);
    });

    it('rejects that same genuine attestation for a DIFFERENT tag, and it is the signer-identity policy that refuses', async () => {
        // The signer identity is pinned to the exact tag being installed, so a
        // valid attestation from one release cannot vouch for another's files.
        const { deps, outcomes } = realDeps([REAL_BUNDLE]);
        await expect(verifyMkcertManifestProvenance(REAL_MANIFEST, 'v0.1.1', deps)).rejects.toThrow(
            /certificate identity/,
        );
        expect(outcomes).toEqual([
            {
                passed: false,
                code: 'UNTRUSTED_SIGNER_ERROR',
                message: expect.stringContaining('certificate identity error'),
            },
        ]);
    });

    it('rejects a tampered manifest under the genuine attestation, and ONLY the coverage check refuses', async () => {
        // The attack a same-release checksum cannot stop: alter the manifest to
        // list a malicious binary's hash. The signature layer PASSES -- the
        // attestation is genuine -- so the refusal can only have come from the
        // check that the statement names THIS manifest's digest.
        const tampered = REAL_MANIFEST.replace(WINDOWS_DIGEST_PREFIX, '0000000000aa');
        expect(tampered).not.toBe(REAL_MANIFEST);
        const { deps, outcomes } = realDeps([REAL_BUNDLE]);
        await expect(verifyMkcertManifestProvenance(tampered, REAL_TAG, deps)).rejects.toThrow(
            `the attestation does not cover mkcert-${REAL_TAG}-SHA256SUMS.txt at sha256 ${sha256(tampered)}`,
        );
        expect(outcomes).toEqual([{ passed: true }]);
    });

    it('rejects an attestation whose signed payload was edited, and it is the transparency-log check that refuses', async () => {
        const tampered = REAL_MANIFEST.replace(WINDOWS_DIGEST_PREFIX, '0000000000aa');
        const forged = withEnvelope(structuredClone(REAL_BUNDLE));
        const payload = Buffer.from(forged.dsseEnvelope.payload, 'base64').toString('utf-8');
        forged.dsseEnvelope.payload = Buffer.from(payload.replace(sha256(REAL_MANIFEST), sha256(tampered))).toString(
            'base64',
        );
        const { deps, outcomes } = realDeps([forged]);
        await expect(verifyMkcertManifestProvenance(tampered, REAL_TAG, deps)).rejects.toThrow(/payload hash mismatch/);
        expect(outcomes).toEqual([
            { passed: false, code: 'TLOG_BODY_ERROR', message: expect.stringMatching(/payload hash mismatch/) },
        ]);
    });

    it('accepts when a later attestation verifies after an earlier one fails', async () => {
        const broken = withEnvelope(structuredClone(REAL_BUNDLE));
        broken.dsseEnvelope.signatures[0]!.sig = Buffer.from('not a signature').toString('base64');
        const { deps, outcomes } = realDeps([broken, REAL_BUNDLE]);
        await expect(verifyMkcertManifestProvenance(REAL_MANIFEST, REAL_TAG, deps)).resolves.toBeUndefined();
        expect(outcomes.map((o) => o.passed)).toEqual([false, true]);
    });
});

describe('verifyMkcertManifestProvenance — refusal paths', () => {
    it('refuses when GitHub holds no attestation for the manifest, without calling the verifier', async () => {
        const verifyBundle = vi.fn();
        const deps: MkcertProvenanceDeps = { fetchBundles: async () => [], verifyBundle };
        await expect(verifyMkcertManifestProvenance(REAL_MANIFEST, REAL_TAG, deps)).rejects.toThrow(
            /no build-provenance attestation/,
        );
        expect(verifyBundle).not.toHaveBeenCalled();
    });

    it('refuses a tag that is not a release-tag shape before fetching anything', async () => {
        const fetchBundles = vi.fn();
        const deps: MkcertProvenanceDeps = { fetchBundles, verifyBundle: vi.fn() };
        await expect(verifyMkcertManifestProvenance(REAL_MANIFEST, 'v0.1.0$|.*', deps)).rejects.toThrow(
            /unexpected mkcert release tag/,
        );
        expect(fetchBundles).not.toHaveBeenCalled();
    });

    it('refuses the retired -bt.N numbering before fetching anything', async () => {
        // The fork deleted every -bt tag on 2026-09-27 and its release workflow
        // now refuses to publish one, so a -bt "latest" can only be a mistake.
        const fetchBundles = vi.fn();
        const deps: MkcertProvenanceDeps = { fetchBundles, verifyBundle: vi.fn() };
        await expect(verifyMkcertManifestProvenance(REAL_MANIFEST, 'v1.4.4-bt.2', deps)).rejects.toThrow(
            /unexpected mkcert release tag/,
        );
        expect(fetchBundles).not.toHaveBeenCalled();
    });

    it('hands the verifier the GitHub Actions issuer and the tag-pinned identity', async () => {
        let seen: MkcertSignerPolicy | undefined;
        const deps: MkcertProvenanceDeps = {
            fetchBundles: async () => [REAL_BUNDLE],
            verifyBundle: async (_bundle, policy) => {
                seen = policy;
            },
        };
        await verifyMkcertManifestProvenance(REAL_MANIFEST, REAL_TAG, deps);
        expect(seen).toEqual({
            issuer: 'https://token.actions.githubusercontent.com',
            identityPattern: mkcertSignerIdentityPattern(REAL_TAG),
        });
    });
});

describe('verifyMkcertManifestProvenance — what a signature-valid attestation must also say', () => {
    // The verifier is a stub that ACCEPTS and counts its calls, so each test
    // isolates one check that runs after the signature: the genuine statement
    // passes (the control), each variant changes exactly one field, and every
    // refusal is asserted to have happened AFTER the signature layer passed.
    type Statement = { _type: string; predicateType: string; subject: { name: string; digest: { sha256: string } }[] };
    const acceptAll = (bundles: SerializedBundle[]) => {
        const verifyBundle = vi.fn(async () => {});
        const deps: MkcertProvenanceDeps = { fetchBundles: async () => bundles, verifyBundle };
        return { deps, verifyBundle };
    };
    const variant = (edit: (statement: Statement, envelope: Envelope) => void): SerializedBundle => {
        const bundle = withEnvelope(structuredClone(REAL_BUNDLE));
        const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf-8')) as Statement;
        edit(statement, bundle.dsseEnvelope);
        bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString('base64');
        return bundle;
    };
    const manifestSubject = (s: Statement) => s.subject.find((x) => x.digest.sha256 === sha256(REAL_MANIFEST))!;

    it('accepts the genuine statement (the control for every test below)', async () => {
        const { deps, verifyBundle } = acceptAll([variant(() => {})]);
        await expect(verifyMkcertManifestProvenance(REAL_MANIFEST, REAL_TAG, deps)).resolves.toBeUndefined();
        expect(verifyBundle).toHaveBeenCalledTimes(1);
    });

    it.each([
        [
            'names the right digest under another file name',
            (s: Statement) => {
                manifestSubject(s).name = `mkcert-${REAL_TAG}-windows-amd64.exe`;
            },
            `the attestation does not cover mkcert-${REAL_TAG}-SHA256SUMS.txt`,
        ],
        [
            'is not SLSA provenance',
            (s: Statement) => {
                s.predicateType = 'https://example.com/some-other-predicate';
            },
            'the attestation is not SLSA build provenance',
        ],
        [
            'is not an in-toto v1 statement',
            (s: Statement) => {
                s._type = 'https://in-toto.io/Statement/v0.1';
            },
            'the attestation is not an in-toto v1 statement',
        ],
        [
            'sits in an envelope whose payload type is not in-toto',
            (_s: Statement, e: Envelope) => {
                e.payloadType = 'application/json';
            },
            'the attestation is not an in-toto statement',
        ],
    ])('refuses a statement that %s, after the signature layer passed', async (_label, edit, message) => {
        const { deps, verifyBundle } = acceptAll([variant(edit)]);
        await expect(verifyMkcertManifestProvenance(REAL_MANIFEST, REAL_TAG, deps)).rejects.toThrow(message);
        expect(verifyBundle).toHaveBeenCalledTimes(1);
    });

    it('refuses a bundle carrying a message signature beside its DSSE envelope, before verifying it', async () => {
        // The verifier prefers `messageSignature` when both are present, so it
        // would verify one thing while this module reads the other. Refusing
        // the shape outright makes the safety explicit rather than an accident
        // of the call shape.
        const mixed = {
            ...structuredClone(REAL_BUNDLE),
            messageSignature: { messageDigest: { algorithm: 'SHA2_256', digest: '' }, signature: '' },
        } as unknown as SerializedBundle;
        const { deps, verifyBundle } = acceptAll([mixed]);
        await expect(verifyMkcertManifestProvenance(REAL_MANIFEST, REAL_TAG, deps)).rejects.toThrow(
            /message signature/,
        );
        expect(verifyBundle).not.toHaveBeenCalled();
    });
});

describe('isMkcertReleaseTag', () => {
    it.each(['v0.1.0', 'v0.0.0', 'v12.30.456'])('accepts %s', (tag) => {
        expect(isMkcertReleaseTag(tag)).toBe(true);
    });

    it.each(['v1.4.4-bt.2', 'v01.2.3', '0.1.0', 'v0.1', 'v0.1.0-rc.1', 'v0.1.0 ', 'v0.1.0/../x', 'v0.1.0$|.*', ''])(
        'rejects %j',
        (tag) => {
            expect(isMkcertReleaseTag(tag)).toBe(false);
        },
    );
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
