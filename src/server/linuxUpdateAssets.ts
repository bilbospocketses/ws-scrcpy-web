import fs from 'node:fs';
import type { UpdateChannel } from '../common/ConfigEvents';
import { downloadToFile, fetchText } from './downloadToFile';
import { verifySha256 } from './verifySha256';

/** Published Linux AppImage asset name (channel-suffixed, NOT version-suffixed). */
export function linuxAppImageAssetName(channel: UpdateChannel): string {
    return `WsScrcpyWeb-linux-${channel}.AppImage`;
}

/**
 * A test / mirror seam for the Linux in-app update's two downloads (the AppImage and
 * SHA256SUMS), the sibling of VELOPACK_FEED_URL, which redirects only Velopack's feed.
 * Set, it replaces the github.com `releases/download` prefix, so a harness can serve a
 * tampered SHA256SUMS and reach the apply's abort paths (smoke 6.2 clause G69; item 169,
 * asked for by qa-harness). The SHA-256 check still runs, against whatever the base serves.
 */
export const RELEASE_URL_BASE_ENV = 'WS_SCRCPY_RELEASE_URL_BASE';

/**
 * The prefix a release's assets live under. Without an override this is GitHub's own
 * `https://github.com/<owner>/ws-scrcpy-web/releases/download`; with one, the override
 * (trailing slashes dropped), so the layout under it is the same: `<base>/v<version>/<asset>`.
 */
export function releaseDownloadBase(githubOwner: string, override?: string): string {
    const trimmed = override?.trim();
    if (trimmed) return trimmed.replace(/\/+$/, '');
    return `https://github.com/${githubOwner}/ws-scrcpy-web/releases/download`;
}

/** Release asset download URL for a given version tag (`v<version>`), under `releaseDownloadBase`. */
export function releaseAssetUrl(
    githubOwner: string,
    version: string,
    assetName: string,
    baseOverride?: string,
): string {
    return `${releaseDownloadBase(githubOwner, baseOverride)}/v${version}/${assetName}`;
}

/**
 * Download `url` to `destPath`, then check its SHA-256 against the `assetName` entry in
 * the SHA256SUMS at `sumsUrl`. Throws, and removes the staged file, when SHA256SUMS has
 * no entry for the asset or the digest does not match. Those are the two abort paths of
 * the Linux apply, and nothing past this point may run on a file that failed here.
 */
export async function downloadVerifiedAsset(opts: {
    url: string;
    sumsUrl: string;
    assetName: string;
    destPath: string;
    fetchFn?: typeof fetch;
}): Promise<void> {
    const { url, sumsUrl, assetName, destPath, fetchFn } = opts;
    await downloadToFile(url, destPath, fetchFn);
    const sumsText = await fetchText(sumsUrl, fetchFn);
    const expected = parseSha256Sums(sumsText, assetName);
    if (!expected) {
        await fs.promises.rm(destPath, { force: true });
        throw new Error(`apply: SHA256SUMS has no entry for ${assetName}`);
    }
    if (!(await verifySha256(destPath, expected))) {
        await fs.promises.rm(destPath, { force: true });
        throw new Error(`apply: SHA-256 mismatch for ${assetName} — aborting`);
    }
}

/**
 * Parse `sha256sum`-style text and return the lowercase hex digest for `filename`,
 * matched by BASENAME (our SHA256SUMS lists path-prefixed entries like
 * `./linux-final/<asset>`). Returns null if not found.
 */
export function parseSha256Sums(text: string, filename: string): string | null {
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // "<64 hex>  <name>"  (two spaces; "*" binary marker tolerated)
        const m = trimmed.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
        const hash = m?.[1];
        const name = m?.[2];
        if (!hash || !name) continue;
        const base = name.trim().split('/').pop();
        if (base === filename) return hash.toLowerCase();
    }
    return null;
}
