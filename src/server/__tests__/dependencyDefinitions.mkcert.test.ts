import os from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDependencyDefinitions, mkcertAssetName } from '../DependencyDefinitions';

describe('mkcert dependency definition', () => {
    const def = () => getDependencyDefinitions('').find((d) => d.name === 'mkcert')!;

    it('is registered', () => {
        expect(def()).toBeDefined();
    });

    it('pins our fork, not upstream — upstream is dormant and unfixed', () => {
        const url = def().getDownloadUrl('v0.1.0');
        expect(url).toContain('bilbospocketses/mkcert');
        expect(url).not.toContain('FiloSottile');
    });

    it('asks for an asset name that exists in the release', () => {
        // Real asset names: the v0.1.0 release's own SHA256SUMS, fetched
        // 2026-09-27 and committed as fixtures/mkcert-v0.1.0-SHA256SUMS.txt.
        const known = [
            'mkcert-v0.1.0-windows-amd64.exe',
            'mkcert-v0.1.0-windows-arm64.exe',
            'mkcert-v0.1.0-linux-amd64',
            'mkcert-v0.1.0-linux-arm64',
            'mkcert-v0.1.0-darwin-amd64',
            'mkcert-v0.1.0-darwin-arm64',
        ];
        const asset = def().getDownloadUrl('v0.1.0').split('/').pop()!;
        expect(known).toContain(asset);
    });

    it('carries NO fallbackVersion — a fallback could not be verified anyway', () => {
        // scrcpy-server falls back when api.github.com refuses the version
        // lookup. mkcert cannot: its install also needs the attestation lookup,
        // which is api.github.com too, so a fallback tag would be refused at the
        // next step. And any fixed tag here goes stale — v1.4.4-bt.2, the old
        // fallback, was deleted on 2026-09-27.
        expect(def().fallbackVersion).toBeUndefined();
    });

    it("treats the fork's latest release as authoritative, so a retired numbering line still updates", () => {
        // v1.4.4-bt.2 → v0.1.0 goes numerically DOWN; ordered comparison would
        // call bt.2 "newer than latest" and leave it installed forever.
        expect(def().latestIsAuthoritative).toBe(true);
    });

    describe('checkLatest', () => {
        let fetchSpy: ReturnType<typeof vi.spyOn>;
        afterEach(() => fetchSpy?.mockRestore());

        const answer = (tag: string) => {
            fetchSpy = vi
                .spyOn(global, 'fetch')
                .mockImplementation(async () => new Response(JSON.stringify({ tag_name: tag }), { status: 200 }));
        };

        it('returns the release tag verbatim', async () => {
            answer('v0.1.0');
            await expect(def().checkLatest()).resolves.toBe('v0.1.0');
        });

        it('refuses a tag that is not a release-tag shape', async () => {
            // The tag becomes part of a download URL and of the signer-identity
            // pattern, so an odd one is refused at the source.
            answer('v0.1.0/../../evil');
            await expect(def().checkLatest()).rejects.toThrow(/unexpected mkcert release tag/);
        });

        it('refuses the retired -bt.N numbering', async () => {
            // Every -bt tag was deleted and the fork's release workflow now
            // refuses to publish one, so a -bt "latest" can only be a mistake.
            answer('v1.4.4-bt.2');
            await expect(def().checkLatest()).rejects.toThrow(/unexpected mkcert release tag/);
        });
    });

    it('does not require a restart — nothing is loaded from it in-process', () => {
        expect(def().requiresRestart).toBe(false);
    });
});

describe('mkcertAssetName produces correct asset names for all platform/arch combinations', () => {
    const testCases: Array<{
        platform: NodeJS.Platform;
        arch: NodeJS.Architecture;
        expected: string;
    }> = [
        { platform: 'win32', arch: 'x64', expected: 'mkcert-v0.1.0-windows-amd64.exe' },
        { platform: 'win32', arch: 'arm64', expected: 'mkcert-v0.1.0-windows-arm64.exe' },
        { platform: 'linux', arch: 'x64', expected: 'mkcert-v0.1.0-linux-amd64' },
        { platform: 'linux', arch: 'arm64', expected: 'mkcert-v0.1.0-linux-arm64' },
        { platform: 'darwin', arch: 'x64', expected: 'mkcert-v0.1.0-darwin-amd64' },
        { platform: 'darwin', arch: 'arm64', expected: 'mkcert-v0.1.0-darwin-arm64' },
    ];

    testCases.forEach(({ platform, arch, expected }) => {
        it(`${platform} + ${arch} → ${expected}`, () => {
            const platformSpy = vi.spyOn(os, 'platform').mockReturnValue(platform as NodeJS.Platform);
            const archSpy = vi.spyOn(os, 'arch').mockReturnValue(arch);

            try {
                const result = mkcertAssetName('v0.1.0');
                expect(result).toBe(expected);
            } finally {
                platformSpy.mockRestore();
                archSpy.mockRestore();
            }
        });
    });
});
