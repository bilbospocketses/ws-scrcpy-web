import type { UpdateChannel } from '../common/ConfigEvents';

/** Published Linux AppImage asset name (channel-suffixed, NOT version-suffixed). */
export function linuxAppImageAssetName(channel: UpdateChannel): string {
    return `WsScrcpyWeb-linux-${channel}.AppImage`;
}

/** GitHub release asset download URL for a given version tag (`v<version>`). */
export function releaseAssetUrl(githubOwner: string, version: string, assetName: string): string {
    return `https://github.com/${githubOwner}/ws-scrcpy-web/releases/download/v${version}/${assetName}`;
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
