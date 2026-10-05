import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    downloadVerifiedAsset,
    linuxAppImageAssetName,
    parseSha256Sums,
    RELEASE_URL_BASE_ENV,
    releaseAssetUrl,
    releaseDownloadBase,
} from '../linuxUpdateAssets';

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

// Item 169 (qa-harness, smoke 6.2 clause G69): a release-URL base override so a test can serve the
// AppImage and SHA256SUMS itself and reach the abort paths. The layout mirrors GitHub's own:
// <base>/v<version>/<asset>, so the default base IS the github.com releases/download prefix.
describe('release download base override', () => {
    it('names the env var the docs and qa-harness use', () => {
        expect(RELEASE_URL_BASE_ENV).toBe('WS_SCRCPY_RELEASE_URL_BASE');
    });

    it('defaults to the github.com releases/download prefix when unset or blank', () => {
        const gh = 'https://github.com/bilbospocketses/ws-scrcpy-web/releases/download';
        expect(releaseDownloadBase('bilbospocketses')).toBe(gh);
        expect(releaseDownloadBase('bilbospocketses', undefined)).toBe(gh);
        expect(releaseDownloadBase('bilbospocketses', '   ')).toBe(gh);
    });

    it('uses the override, without trailing slashes, when set', () => {
        expect(releaseDownloadBase('bilbospocketses', 'http://127.0.0.1:8099/rel/')).toBe('http://127.0.0.1:8099/rel');
        expect(releaseDownloadBase('bilbospocketses', 'http://127.0.0.1:8099/rel//')).toBe('http://127.0.0.1:8099/rel');
    });

    it('builds <base>/v<version>/<asset> under the override', () => {
        expect(releaseAssetUrl('bilbospocketses', '0.1.30-beta.175', 'SHA256SUMS', 'http://127.0.0.1:8099/rel/')).toBe(
            'http://127.0.0.1:8099/rel/v0.1.30-beta.175/SHA256SUMS',
        );
    });

    it('is byte-for-byte the github.com URL without an override', () => {
        expect(releaseAssetUrl('someone', '1.2.3', 'X.AppImage')).toBe(
            'https://github.com/someone/ws-scrcpy-web/releases/download/v1.2.3/X.AppImage',
        );
    });
});

describe('downloadVerifiedAsset (the Linux apply download + SHA-256 check)', () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    });

    const ASSET = 'WsScrcpyWeb-linux-beta.AppImage';
    const PAYLOAD = Buffer.from('not really an AppImage, but bytes all the same');
    const GOOD = createHash('sha256').update(PAYLOAD).digest('hex');

    function setup(sums: string) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wssw-verify-'));
        dirs.push(dir);
        const requested: string[] = [];
        const fetchFn = async (url: string | URL | Request) => {
            const u = String(url);
            requested.push(u);
            if (u.endsWith(`/${ASSET}`)) return new Response(PAYLOAD, { status: 200 });
            if (u.endsWith('/SHA256SUMS')) return new Response(sums, { status: 200 });
            return new Response('nope', { status: 404, statusText: 'Not Found' });
        };
        const destPath = path.join(dir, `${ASSET}.new`);
        const opts = {
            url: `http://127.0.0.1:8099/rel/v9.9.9/${ASSET}`,
            sumsUrl: 'http://127.0.0.1:8099/rel/v9.9.9/SHA256SUMS',
            assetName: ASSET,
            destPath,
            fetchFn: fetchFn as typeof fetch,
        };
        return { opts, destPath, requested };
    }

    it('keeps the staged file when its SHA-256 matches the served SHA256SUMS (control)', async () => {
        const { opts, destPath, requested } = setup(`${GOOD}  ./linux-final/${ASSET}\n`);
        await downloadVerifiedAsset(opts);
        expect(fs.readFileSync(destPath)).toEqual(PAYLOAD);
        // Both downloads came from the overridden base, not from github.com.
        expect(requested).toEqual([opts.url, opts.sumsUrl]);
    });

    it('ABORTS on a SHA-256 mismatch and removes the staged file', async () => {
        const wrong = 'f'.repeat(64);
        const { opts, destPath } = setup(`${wrong}  ./linux-final/${ASSET}\n`);
        await expect(downloadVerifiedAsset(opts)).rejects.toThrow(`apply: SHA-256 mismatch for ${ASSET} — aborting`);
        expect(fs.existsSync(destPath)).toBe(false);
    });

    it('ABORTS when SHA256SUMS has no entry for the asset and removes the staged file', async () => {
        const { opts, destPath } = setup(`${GOOD}  ./linux-final/SomethingElse.AppImage\n`);
        await expect(downloadVerifiedAsset(opts)).rejects.toThrow(`apply: SHA256SUMS has no entry for ${ASSET}`);
        expect(fs.existsSync(destPath)).toBe(false);
    });
});
