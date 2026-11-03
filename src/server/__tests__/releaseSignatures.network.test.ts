import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { getDependencyDefinitions, NODE_DIST_BASE_ENV } from '../DependencyDefinitions';
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
 * Reads nodejs.org/dist/index.json, the node-pty prebuilt manifest (a
 * github.com release asset, through the updater's own Node lookup) and
 * github.com's releases/latest redirect, never api.github.com, so a CI
 * runner's shared 60-an-hour API quota is not spent on it.
 *
 * CI: the scheduled `release-signatures` workflow
 * (.github/workflows/release-signatures.yml), daily (06:17 UTC) and on demand.
 */

const ENABLED = process.env['WS_SCRCPY_NETWORK_TESTS'] === '1';
const UA = { 'User-Agent': 'ws-scrcpy-web release-signature check' };

/**
 * A download here is bounded by NO PROGRESS, never by its total time: a slow
 * mirror only makes the test slower. It fails when nothing at all arrives --
 * no response, or no further body bytes -- for this long.
 */
const STALL_MS = 120_000;

/** `fetch` plus its whole body, aborted as HUNG only when it stops making progress. */
async function fetchWatched(url: string, init: RequestInit = {}): Promise<{ res: Response; body: Uint8Array }> {
    const controller = new AbortController();
    let stalled = false;
    let timer: NodeJS.Timeout | undefined;
    const progress = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            stalled = true;
            controller.abort();
        }, STALL_MS);
    };
    progress();
    try {
        const res = await fetch(url, { ...init, headers: UA, signal: controller.signal });
        const chunks: Uint8Array[] = [];
        const reader = res.body?.getReader();
        for (;;) {
            progress();
            const chunk = await reader?.read();
            if (!chunk || chunk.done) break;
            chunks.push(chunk.value);
        }
        return { res, body: new Uint8Array(Buffer.concat(chunks)) };
    } catch (err) {
        if (stalled) throw new Error(`HUNG: nothing arrived from ${url} for ${STALL_MS / 1000} s`, { cause: err });
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

async function bytes(url: string): Promise<Uint8Array> {
    const { res, body } = await fetchWatched(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return body;
}

/**
 * The Node version the updater would offer right now, from the updater's own
 * lookup (LTS only, filtered to the ABIs the node-pty prebuilt manifest
 * covers), so this checks the release a user would actually be asked to install.
 */
async function nodeVersionTheUpdaterOffers(): Promise<string> {
    const depsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-release-sig-network-'));
    const saved = process.env[NODE_DIST_BASE_ENV];
    delete process.env[NODE_DIST_BASE_ENV];
    try {
        const node = getDependencyDefinitions(depsPath).find((d) => d.name === 'nodejs')!;
        const offered = await node.checkLatest();
        if (!offered) throw new Error('the updater offers no Node.js version');
        return `v${offered}`;
    } finally {
        if (saved !== undefined) process.env[NODE_DIST_BASE_ENV] = saved;
        fs.rmSync(depsPath, { recursive: true, force: true });
    }
}

// `timeout: 0` turns off vitest's total-time limit for these two: every
// download in them is bounded by its own stall watch (fetchWatched), and the
// updater's lookup by the product's own timeouts.
describe.runIf(ENABLED)('the newest published hash lists verify against the pinned keys', () => {
    it('Node.js: the release the updater offers, and the newest Current and LTS', { timeout: 0 }, async () => {
        const index = JSON.parse(new TextDecoder().decode(await bytes('https://nodejs.org/dist/index.json'))) as {
            version: string;
            lts: string | false;
        }[];
        const current = index[0]!.version;
        const lts = index.find((r) => r.lts !== false)!.version;
        const offered = await nodeVersionTheUpdaterOffers();
        console.log('Node.js: the updater offers %s (newest Current %s, newest LTS %s)', offered, current, lts);

        for (const version of new Set([offered, current, lts])) {
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

    it('scrcpy: the latest release SHA256SUMS.txt', { timeout: 0 }, async () => {
        const { res } = await fetchWatched('https://github.com/Genymobile/scrcpy/releases/latest', {
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
