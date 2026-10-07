import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVER_JAR_SHA256 } from '../../common/Constants';
import { DependencyStatus } from '../../common/DependencyTypes';
import { getDependencyDefinitions, NODE_DIST_BASE_ENV } from '../DependencyDefinitions';
import { DependencyManager } from '../DependencyManager';
import { parseSha256Sums } from '../linuxUpdateAssets';
import { bytesResponse, makeTestReleaseKeys, makeTestSigner, type TestSigner } from './helpers/releaseSigning';

/**
 * M5: Node's SHASUMS256.txt and scrcpy's SHA256SUMS.txt must be signed by a key
 * pinned for that publisher before the list is read for a hash. Every refusal
 * ends the update with nothing installed.
 *
 * The throwaway-key cases reach the manager through its `releaseKeys`
 * constructor seam; the real-fixture cases pass no option at all, so they run
 * the keys production pins against the files the publishers actually serve.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(HERE, 'fixtures', name)));
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const urlOf = (input: string | URL | Request) => String(input instanceof Request ? input.url : input);
const notFound = () => new Response('Not Found', { status: 404 });

function stubFetch(answer: (url: URL) => Response): string[] {
    const fetched: string[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (input: string | URL | Request) => {
        const url = urlOf(input);
        fetched.push(url);
        return answer(new URL(url));
    });
    return fetched;
}

let keys: Awaited<ReturnType<typeof makeTestReleaseKeys>>;
let stranger: TestSigner;
beforeAll(async () => {
    keys = await makeTestReleaseKeys();
    stranger = await makeTestSigner('Node.js', { name: 'not a releaser' });
});

describe('DependencyManager.update("nodejs") — SHASUMS256.txt.sig by a pinned Node.js key', () => {
    const ARCHIVE = 'not-a-real-node-archive-but-deterministic-bytes';
    let tmpDepsDir: string;
    const assetFor = (version: string) =>
        path.posix.basename(
            new URL(
                getDependencyDefinitions(tmpDepsDir)
                    .find((d) => d.name === 'nodejs')!
                    .getDownloadUrl(version),
            ).pathname,
        );

    beforeEach(() => {
        tmpDepsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-dm-node-sig-'));
        vi.stubEnv(NODE_DIST_BASE_ENV, undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        fs.rmSync(tmpDepsDir, { recursive: true, force: true });
    });

    /** Serves `list` at SHASUMS256.txt and `sig` (or a 404) at .sig; anything else is the archive. */
    function setup(
        version: string,
        list: Uint8Array | string,
        sig: Uint8Array | (() => Response) | null,
        opts: { pinned?: boolean } = {},
    ) {
        const listBytes = typeof list === 'string' ? new TextEncoder().encode(list) : list;
        const fetched = stubFetch((u) => {
            if (u.pathname.endsWith('/SHASUMS256.txt')) return bytesResponse(listBytes);
            if (u.pathname.endsWith('/SHASUMS256.txt.sig')) {
                if (sig === null) return notFound();
                return typeof sig === 'function' ? sig() : bytesResponse(sig);
            }
            return new Response(ARCHIVE);
        });
        const mgr =
            opts.pinned === true
                ? new DependencyManager(tmpDepsDir)
                : new DependencyManager(tmpDepsDir, { releaseKeys: keys.releaseKeys });
        mgr.getByName('nodejs')!.latestVersion = version;
        const install = vi.spyOn(mgr as any, 'installNodejs').mockResolvedValue(undefined);
        return { mgr, install, fetched };
    }

    const version = '24.99.0';
    const goodList = () => `${sha256(ARCHIVE)}  ${assetFor(version)}\n`;

    it('installs when the list is signed by a pinned key, reading the signature beside the list', async () => {
        const list = goodList();
        const { mgr, install, fetched } = setup(version, list, await keys.node.sign(list));

        const result = await mgr.update('nodejs');

        expect(result.success, result.errorMessage).toBe(true);
        expect(install).toHaveBeenCalledTimes(1);
        expect(fetched).toContain(`https://nodejs.org/dist/v${version}/SHASUMS256.txt.sig`);
    });

    it('refuses a list with no signature, even one that vouches for the archive', async () => {
        const { mgr, install } = setup(version, goodList(), null);

        const result = await mgr.update('nodejs');

        expect(result.success).toBe(false);
        expect(result.errorMessage).toBe(
            `Node.js SHASUMS256.txt for v${version} has no signature (HTTP 404 from ` +
                `https://nodejs.org/dist/v${version}/SHASUMS256.txt.sig) -- refusing to install an unsigned list`,
        );
        expect(install).not.toHaveBeenCalled();
        expect(mgr.getByName('nodejs')!.status).toBe(DependencyStatus.Error);
    });

    it('checks the signature BEFORE the list is read for a hash', async () => {
        // Unsigned AND wrong: the refusal must be the signature's, because an
        // unvouched list is never read for a hash at all.
        const { mgr } = setup(version, `${'0'.repeat(64)}  ${assetFor(version)}\n`, null);

        const result = await mgr.update('nodejs');

        expect(result.errorMessage).toMatch(/has no signature/);
        expect(result.errorMessage).not.toMatch(/checksum mismatch/);
    });

    it('refuses when the signature cannot be fetched', async () => {
        const { mgr, install } = setup(version, goodList(), () => new Response('busy', { status: 503 }));

        const result = await mgr.update('nodejs');

        expect(result.success).toBe(false);
        expect(result.errorMessage).toBe(
            `Node.js checksum signature fetch failed: HTTP 503 from https://nodejs.org/dist/v${version}/SHASUMS256.txt.sig`,
        );
        expect(install).not.toHaveBeenCalled();
    });

    it('refuses a list changed after it was signed, before reading it for a hash', async () => {
        // The tampered list still names the archive under its true hash: only
        // the signature can refuse it.
        const signed = `${'0'.repeat(64)}  ${assetFor(version)}\n`;
        const { mgr, install } = setup(version, goodList(), await keys.node.sign(signed));

        const result = await mgr.update('nodejs');

        expect(result.success).toBe(false);
        expect(result.errorMessage).toMatch(
            new RegExp(
                `^Node\\.js SHASUMS256\\.txt for v${version.replace(/\./g, '\\.')}: signature does not verify \\(.+\\) -- refusing to install$`,
            ),
        );
        expect(install).not.toHaveBeenCalled();
    });

    it('refuses a list signed by a key outside the pinned set, naming its fingerprint', async () => {
        const list = goodList();
        const { mgr, install } = setup(version, list, await stranger.sign(list));

        const result = await mgr.update('nodejs');

        expect(result.success).toBe(false);
        expect(result.errorMessage).toBe(
            `Node.js SHASUMS256.txt for v${version} names ${stranger.fingerprint} as its claimed issuer, ` +
                'which is not a pinned Node.js release key -- refusing to install',
        );
        expect(install).not.toHaveBeenCalled();
    });

    it('reads the signature from WS_SCRCPY_NODE_DIST_BASE, and still requires the pinned set there', async () => {
        const base = 'http://127.0.0.1:8146/dist';
        vi.stubEnv(NODE_DIST_BASE_ENV, base);
        const list = goodList();

        const pinnedSigned = setup(version, list, await keys.node.sign(list));
        const ok = await pinnedSigned.mgr.update('nodejs');
        expect(ok.success, ok.errorMessage).toBe(true);
        expect(pinnedSigned.fetched).toContain(`${base}/v${version}/SHASUMS256.txt.sig`);
        expect(pinnedSigned.fetched.filter((u) => new URL(u).hostname === 'nodejs.org')).toEqual([]);

        vi.restoreAllMocks();
        const strangerSigned = setup(version, list, await stranger.sign(list));
        const refused = await strangerSigned.mgr.update('nodejs');
        expect(refused.success).toBe(false);
        expect(refused.errorMessage).toContain(
            `names ${stranger.fingerprint} as its claimed issuer, which is not a pinned`,
        );
        expect(strangerSigned.install).not.toHaveBeenCalled();
    });

    it('with no releaseKeys option, a mirror must serve a list signed by a REAL Node.js key', async () => {
        // The production composition: the env var moves the URLs and nothing
        // else, so a list the mirror signed itself is refused.
        vi.stubEnv(NODE_DIST_BASE_ENV, 'http://127.0.0.1:8146/dist');
        const list = goodList();
        const { mgr, install } = setup(version, list, await keys.node.sign(list), { pinned: true });

        const result = await mgr.update('nodejs');

        expect(result.success).toBe(false);
        expect(result.errorMessage).toContain(
            `names ${keys.node.fingerprint} as its claimed issuer, which is not a pinned Node.js release key`,
        );
        expect(install).not.toHaveBeenCalled();
    });

    it("accepts Node's genuine signed list from a mirror, with the pinned keys", async () => {
        // The counterpart of the refusal above: a mirror serving nodejs.org's
        // own files gets past the signature, and only the fake archive's hash
        // stops this install.
        const base = 'http://127.0.0.1:8146/dist';
        vi.stubEnv(NODE_DIST_BASE_ENV, base);
        const list = fixture('node-v24.21.0-SHASUMS256.txt');
        const asset = assetFor('24.21.0');
        const expected = parseSha256Sums(new TextDecoder().decode(list), asset);
        const { mgr, fetched } = setup('24.21.0', list, fixture('node-v24.21.0-SHASUMS256.txt.sig'), {
            pinned: true,
        });

        const result = await mgr.update('nodejs');

        expect(result.errorMessage).toBe(
            `Node.js checksum mismatch for ${asset} (expected ${expected}) -- refusing to install`,
        );
        expect(fetched).toContain(`${base}/v24.21.0/SHASUMS256.txt.sig`);
    });

    it("accepts nodejs.org's real v24.21.0 list with the pinned keys, then checks the archive against it", async () => {
        const list = fixture('node-v24.21.0-SHASUMS256.txt');
        const asset = assetFor('24.21.0');
        const expected = parseSha256Sums(new TextDecoder().decode(list), asset);
        expect(expected, `the real list names ${asset}`).toMatch(/^[0-9a-f]{64}$/);
        const { mgr, install } = setup('24.21.0', list, fixture('node-v24.21.0-SHASUMS256.txt.sig'), {
            pinned: true,
        });

        const result = await mgr.update('nodejs');

        // Past the signature: the refusal is the HASH of the fake archive.
        expect(result.errorMessage).toBe(
            `Node.js checksum mismatch for ${asset} (expected ${expected}) -- refusing to install`,
        );
        expect(install).not.toHaveBeenCalled();
    });
});

describe('DependencyManager.update("scrcpy-server") — SHA256SUMS.txt.asc by the pinned scrcpy key', () => {
    const JAR = 'not-a-real-scrcpy-server-but-deterministic-bytes';
    let tmpDepsDir: string;
    const installed = () => path.join(tmpDepsDir, 'scrcpy-server', 'scrcpy-server');
    const ascUrl = (v: string) => `https://github.com/Genymobile/scrcpy/releases/download/v${v}/SHA256SUMS.txt.asc`;

    beforeEach(() => {
        tmpDepsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-dm-scrcpy-sig-'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(tmpDepsDir, { recursive: true, force: true });
    });

    function setup(
        version: string,
        list: Uint8Array | string,
        sig: Uint8Array | null,
        opts: { pinned?: boolean; jar?: Uint8Array | string } = {},
    ) {
        const listBytes = typeof list === 'string' ? new TextEncoder().encode(list) : list;
        const jar = opts.jar ?? JAR;
        const fetched = stubFetch((u) => {
            if (u.pathname.endsWith('/SHA256SUMS.txt')) return bytesResponse(listBytes);
            if (u.pathname.endsWith('/SHA256SUMS.txt.asc')) return sig === null ? notFound() : bytesResponse(sig);
            return typeof jar === 'string' ? new Response(jar) : bytesResponse(jar);
        });
        const mgr =
            opts.pinned === true
                ? new DependencyManager(tmpDepsDir)
                : new DependencyManager(tmpDepsDir, { releaseKeys: keys.releaseKeys });
        mgr.getByName('scrcpy-server')!.latestVersion = version;
        return { mgr, fetched };
    }

    const list40 = `${sha256(JAR)}  scrcpy-server-v4.0\n`;

    it('installs when the list is signed by the pinned key', async () => {
        const { mgr, fetched } = setup('4.0', list40, await keys.scrcpy.sign(list40, { armored: true }));

        const result = await mgr.update('scrcpy-server');

        expect(result.success, result.errorMessage).toBe(true);
        expect(fetched).toContain(ascUrl('4.0'));
        expect(fs.readFileSync(installed(), 'utf8')).toBe(JAR);
    });

    it('refuses a list with no .asc, and installs nothing', async () => {
        const { mgr } = setup('4.0', list40, null);

        const result = await mgr.update('scrcpy-server');

        expect(result.success).toBe(false);
        expect(result.errorMessage).toBe(
            `scrcpy-server SHA256SUMS.txt for v4.0 has no signature (HTTP 404 from ${ascUrl('4.0')}) ` +
                '-- refusing to install an unsigned list',
        );
        expect(fs.existsSync(installed())).toBe(false);
    });

    it('refuses a list changed after it was signed', async () => {
        const sig = await keys.scrcpy.sign(`${'0'.repeat(64)}  scrcpy-server-v4.0\n`, { armored: true });
        const { mgr } = setup('4.0', list40, sig);

        const result = await mgr.update('scrcpy-server');

        expect(result.success).toBe(false);
        expect(result.errorMessage).toMatch(/^scrcpy-server SHA256SUMS\.txt for v4\.0: signature does not verify/);
        expect(fs.existsSync(installed())).toBe(false);
    });

    it("refuses a list signed by Node's pinned key: each publisher has its own set", async () => {
        const { mgr } = setup('4.0', list40, await keys.node.sign(list40, { armored: true }));

        const result = await mgr.update('scrcpy-server');

        expect(result.success).toBe(false);
        expect(result.errorMessage).toBe(
            `scrcpy-server SHA256SUMS.txt for v4.0 names ${keys.node.fingerprint} as its claimed issuer, ` +
                'which is not a pinned scrcpy release key -- refusing to install',
        );
        expect(fs.existsSync(installed())).toBe(false);
    });

    it("installs the vendored v4.1 jar from scrcpy's real signed list with the pinned key", async () => {
        const jar = new Uint8Array(fs.readFileSync(path.join(REPO_ROOT, 'assets', 'scrcpy-server')));
        const { mgr } = setup('4.1', fixture('scrcpy-v4.1-SHA256SUMS.txt'), fixture('scrcpy-v4.1-SHA256SUMS.txt.asc'), {
            pinned: true,
            jar,
        });

        const result = await mgr.update('scrcpy-server');

        expect(result.success, result.errorMessage).toBe(true);
        expect(sha256(fs.readFileSync(installed()))).toBe(SERVER_JAR_SHA256['4.1']);
    });
});
