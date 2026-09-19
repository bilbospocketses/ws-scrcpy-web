import os from 'os';
import { describe, expect, it, vi } from 'vitest';
import { mkcertAssetName } from '../DependencyDefinitions';
import { getDependencyDefinitions } from '../DependencyDefinitions';

describe('mkcert dependency definition', () => {
    const def = () => getDependencyDefinitions('').find((d) => d.name === 'mkcert')!;

    it('is registered', () => {
        expect(def()).toBeDefined();
    });

    it('pins our fork, not upstream — upstream is dormant and unfixed', () => {
        const url = def().getDownloadUrl('v1.4.4-bt.2');
        expect(url).toContain('bilbospocketses/mkcert');
        expect(url).not.toContain('FiloSottile');
    });

    it('asks for an asset name that exists in the release', () => {
        // Real asset names, verified against the published release 2026-09-19.
        const known = [
            'mkcert-v1.4.4-bt.2-windows-amd64.exe',
            'mkcert-v1.4.4-bt.2-linux-amd64',
            'mkcert-v1.4.4-bt.2-linux-arm64',
            'mkcert-v1.4.4-bt.2-darwin-amd64',
            'mkcert-v1.4.4-bt.2-darwin-arm64',
        ];
        const asset = def().getDownloadUrl('v1.4.4-bt.2').split('/').pop()!;
        expect(known).toContain(asset);
    });

    it('carries a fallbackVersion, so a rate-limited lookup still installs something', () => {
        // Same reasoning as scrcpy-server: api.github.com rate-limits at 60/hour
        // unauthenticated, and without this a first run installs nothing silently.
        expect(def().fallbackVersion).toBe('v1.4.4-bt.2');
    });

    it('does not require a restart — nothing is loaded from it in-process', () => {
        expect(def().requiresRestart).toBe(false);
    });
});

describe('mkcertAssetName produces correct asset names for all platform/arch combinations', () => {
    const testCases: Array<{
        platform: NodeJS.Platform;
        arch: string;
        expected: string;
    }> = [
        { platform: 'win32', arch: 'x64', expected: 'mkcert-v1.4.4-bt.2-windows-amd64.exe' },
        { platform: 'win32', arch: 'arm64', expected: 'mkcert-v1.4.4-bt.2-windows-arm64.exe' },
        { platform: 'linux', arch: 'x64', expected: 'mkcert-v1.4.4-bt.2-linux-amd64' },
        { platform: 'linux', arch: 'arm64', expected: 'mkcert-v1.4.4-bt.2-linux-arm64' },
        { platform: 'darwin', arch: 'x64', expected: 'mkcert-v1.4.4-bt.2-darwin-amd64' },
        { platform: 'darwin', arch: 'arm64', expected: 'mkcert-v1.4.4-bt.2-darwin-arm64' },
    ];

    testCases.forEach(({ platform, arch, expected }) => {
        it(`${platform} + ${arch} → ${expected}`, () => {
            const platformSpy = vi.spyOn(os, 'platform').mockReturnValue(platform as NodeJS.Platform);
            const archSpy = vi.spyOn(os, 'arch').mockReturnValue(arch);

            try {
                const result = mkcertAssetName('v1.4.4-bt.2');
                expect(result).toBe(expected);
            } finally {
                platformSpy.mockRestore();
                archSpy.mockRestore();
            }
        });
    });
});
