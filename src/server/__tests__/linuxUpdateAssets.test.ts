import { describe, it, expect } from 'vitest';
import { linuxAppImageAssetName, releaseAssetUrl, parseSha256Sums } from '../linuxUpdateAssets';

describe('linuxUpdateAssets', () => {
    it('builds the channel-suffixed AppImage asset name', () => {
        expect(linuxAppImageAssetName('beta')).toBe('WsScrcpyWeb-linux-beta.AppImage');
        expect(linuxAppImageAssetName('stable')).toBe('WsScrcpyWeb-linux-stable.AppImage');
    });

    it('builds the release download URL', () => {
        expect(releaseAssetUrl('bilbospocketses', '0.1.30-beta.26', 'WsScrcpyWeb-linux-beta.AppImage')).toBe(
            'https://github.com/bilbospocketses/ws-scrcpy-web/releases/download/v0.1.30-beta.26/WsScrcpyWeb-linux-beta.AppImage',
        );
    });

    it('parses SHA256SUMS by basename (path-prefixed entries)', () => {
        const sums =
            'ec1f3987e95cba5c179b14a1c04aa355a7710d72dc31c8eca9cb39f62ad9c7bc  ./linux-final/WsScrcpyWeb-linux-beta.AppImage\n' +
            '952bebf9fd143145b258348c14d942fe76c9b4018f64f7444c2fdbe22f5aee34  ./linux-final/WsScrcpyWeb-0.1.30-beta.26-linux-beta-full.nupkg\n';
        expect(parseSha256Sums(sums, 'WsScrcpyWeb-linux-beta.AppImage')).toBe(
            'ec1f3987e95cba5c179b14a1c04aa355a7710d72dc31c8eca9cb39f62ad9c7bc',
        );
    });

    it('returns null when the asset is absent', () => {
        expect(parseSha256Sums('deadbeef  ./x/other.bin\n', 'WsScrcpyWeb-linux-beta.AppImage')).toBeNull();
    });
});
