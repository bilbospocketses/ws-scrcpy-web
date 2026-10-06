import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDependencyDefinitions, mkcertChecksumsUrl } from '../DependencyDefinitions';
import {
    defaultMkcertProvenanceDeps,
    MKCERT_URL_BASE_ENV,
    mkcertSignerIdentityPattern,
    mkcertUrlBases,
} from '../mkcertProvenance';

// Item 167: one base for every URL the mkcert path reads, so smoke row 21.12's
// refusals can run against a fixture release server.
describe('WS_SCRCPY_MKCERT_URL_BASE', () => {
    const def = () => getDependencyDefinitions('').find((d) => d.name === 'mkcert')!;
    let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

    afterEach(() => {
        vi.unstubAllEnvs();
        fetchSpy?.mockRestore();
        fetchSpy = undefined;
    });

    /** Every URL fetch was called with, answering each with `body`. */
    const recordFetches = (body: unknown, status = 200): string[] => {
        const urls: string[] = [];
        fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
            urls.push(String(input));
            return new Response(JSON.stringify(body), { status });
        });
        return urls;
    };

    it('is named as the docs and the e2e harness name it', () => {
        expect(MKCERT_URL_BASE_ENV).toBe('WS_SCRCPY_MKCERT_URL_BASE');
    });

    it("unset, every URL is the fork's own on GitHub, exactly as before", async () => {
        vi.stubEnv(MKCERT_URL_BASE_ENV, undefined);
        expect(mkcertUrlBases()).toEqual({
            api: 'https://api.github.com/repos/bilbospocketses/mkcert',
            web: 'https://github.com/bilbospocketses/mkcert',
        });
        expect(mkcertChecksumsUrl('v0.1.0')).toBe(
            'https://github.com/bilbospocketses/mkcert/releases/download/v0.1.0/mkcert-v0.1.0-SHA256SUMS.txt',
        );
        expect(def().getDownloadUrl('v0.1.0')).toMatch(
            /^https:\/\/github\.com\/bilbospocketses\/mkcert\/releases\/download\/v0\.1\.0\/mkcert-v0\.1\.0-/,
        );

        const urls = recordFetches({ tag_name: 'v0.1.0' });
        await def().checkLatest();
        expect(urls).toEqual(['https://api.github.com/repos/bilbospocketses/mkcert/releases/latest']);
    });

    it("set, the release lookup, both downloads and the attestation lookup all move under it, in GitHub's layout", async () => {
        vi.stubEnv(MKCERT_URL_BASE_ENV, ' http://127.0.0.1:8197/fixture/// ');
        const base = 'http://127.0.0.1:8197/fixture';
        expect(mkcertUrlBases()).toEqual({ api: base, web: base });
        expect(mkcertChecksumsUrl('v0.1.0')).toBe(`${base}/releases/download/v0.1.0/mkcert-v0.1.0-SHA256SUMS.txt`);
        expect(def().getDownloadUrl('v0.1.0').startsWith(`${base}/releases/download/v0.1.0/mkcert-v0.1.0-`)).toBe(true);

        const latest = recordFetches({ tag_name: 'v0.1.0' });
        await def().checkLatest();
        expect(latest).toEqual([`${base}/releases/latest`]);
        fetchSpy?.mockRestore();

        const attestations = recordFetches({ attestations: [] });
        const digest = 'ab'.repeat(32);
        await expect(defaultMkcertProvenanceDeps('unused').fetchBundles(digest)).resolves.toEqual([]);
        expect(attestations).toEqual([`${base}/attestations/sha256:${digest}`]);
    });

    it('a blank value is unset', () => {
        vi.stubEnv(MKCERT_URL_BASE_ENV, '   ');
        expect(mkcertUrlBases().api).toBe('https://api.github.com/repos/bilbospocketses/mkcert');
    });

    it('moves where the files come from, never who must have signed them', () => {
        // The trust anchor stays the fork's release workflow on github.com, so a
        // base can only serve a genuine release or be refused.
        const unset = mkcertSignerIdentityPattern('v0.1.0');
        vi.stubEnv(MKCERT_URL_BASE_ENV, 'http://127.0.0.1:8197');
        expect(mkcertSignerIdentityPattern('v0.1.0')).toBe(unset);
        expect(
            new RegExp(unset).test(
                'https://github.com/bilbospocketses/mkcert/.github/workflows/release.yml@refs/tags/v0.1.0',
            ),
        ).toBe(true);
    });
});
