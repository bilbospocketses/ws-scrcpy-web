import { describe, expect, it } from 'vitest';
import { PINNED_RELEASE_KEYS } from '../DependencyManager';
import { verifyDetachedSignature } from '../verifyOpenPgp';

/**
 * M5, network-gated: the NEWEST releases' hash lists verify against the keys
 * this repo pins. Skipped unless WS_SCRCPY_NETWORK_TESTS=1.
 *
 * This is the early warning the fail-closed policy needs. A list signed by a
 * key outside the pinned set refuses the install, so a new Node.js releaser
 * would otherwise be found by users. When this fails with "is not a pinned
 * Node.js release key", run `node scripts/refresh-release-keys.mjs`, review the
 * fingerprint diff it prints, and ship the regenerated module.
 *
 *   WS_SCRCPY_NETWORK_TESTS=1 npm test -- releaseSignatures.network
 *
 * Reads nodejs.org/dist/index.json and github.com's releases/latest redirect,
 * never api.github.com, so a CI runner's shared 60-an-hour API quota is not
 * spent on it.
 */

const ENABLED = process.env['WS_SCRCPY_NETWORK_TESTS'] === '1';
const UA = { 'User-Agent': 'ws-scrcpy-web release-signature check' };

async function bytes(url: string): Promise<Uint8Array> {
    const res = await fetch(url, { headers: UA });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return new Uint8Array(await res.arrayBuffer());
}

describe.runIf(ENABLED)('the newest published hash lists verify against the pinned keys', () => {
    it('Node.js: the newest Current and the newest LTS SHASUMS256.txt', { timeout: 60_000 }, async () => {
        const res = await fetch('https://nodejs.org/dist/index.json', { headers: UA });
        expect(res.ok).toBe(true);
        const index = (await res.json()) as { version: string; lts: string | false }[];
        const current = index[0]!.version;
        const lts = index.find((r) => r.lts !== false)!.version;

        for (const version of new Set([current, lts])) {
            const base = `https://nodejs.org/dist/${version}`;
            const signer = await verifyDetachedSignature({
                what: `Node.js SHASUMS256.txt for ${version}`,
                data: await bytes(`${base}/SHASUMS256.txt`),
                signature: await bytes(`${base}/SHASUMS256.txt.sig`),
                keySet: PINNED_RELEASE_KEYS.nodejs,
            });
            console.log('Node.js %s: signed by %s (%s)', version, signer.fingerprint, signer.owner);
        }
    });

    it('scrcpy: the latest release SHA256SUMS.txt', { timeout: 60_000 }, async () => {
        const res = await fetch('https://github.com/Genymobile/scrcpy/releases/latest', {
            headers: UA,
            redirect: 'manual',
        });
        const location = res.headers.get('location') ?? '';
        const tag = location.match(/\/releases\/tag\/(v[^/?#]+)$/)?.[1];
        expect(tag, `releases/latest redirected to ${JSON.stringify(location)}`).toBeDefined();

        const base = `https://github.com/Genymobile/scrcpy/releases/download/${tag}`;
        const signer = await verifyDetachedSignature({
            what: `scrcpy SHA256SUMS.txt for ${tag}`,
            data: await bytes(`${base}/SHA256SUMS.txt`),
            signature: await bytes(`${base}/SHA256SUMS.txt.asc`),
            keySet: PINNED_RELEASE_KEYS.scrcpyServer,
        });
        console.log('scrcpy %s: signed by %s with subkey %s', tag, signer.fingerprint, signer.signingKeyFingerprint);
    });
});
