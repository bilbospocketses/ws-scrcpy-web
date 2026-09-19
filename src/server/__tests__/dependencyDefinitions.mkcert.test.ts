import { describe, expect, it } from 'vitest';
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
