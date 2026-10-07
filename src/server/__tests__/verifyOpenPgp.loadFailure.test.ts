import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DependencyManager, PINNED_RELEASE_KEYS } from '../DependencyManager';
import { verifyDetachedSignature } from '../verifyOpenPgp';

/**
 * M5: `openpgp` is loaded when a signature is first checked, not when the
 * server starts. With the package unloadable, the server's modules still load
 * (so the server boots), and the check that needs it refuses the install.
 *
 * The mock (hoisted above the imports) makes every import of `openpgp` in
 * this file's module graph throw, the way a missing or broken package does, so
 * a static `openpgp` import anywhere under DependencyManager would fail this
 * whole file at load.
 */
vi.mock('openpgp', () => {
    throw new Error("Cannot find module 'openpgp'");
});

const LIST = 'aaaa  node-v24.99.0-linux-x64.tar.gz\n';

describe('openpgp cannot be loaded', () => {
    let tmpDepsDir: string;

    beforeEach(() => {
        tmpDepsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-dm-openpgp-missing-'));
        vi.stubEnv('WS_SCRCPY_NODE_DIST_BASE', undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        fs.rmSync(tmpDepsDir, { recursive: true, force: true });
    });

    it('the server modules still load: nothing imports openpgp at the top', () => {
        expect(typeof DependencyManager).toBe('function');
        expect(typeof verifyDetachedSignature).toBe('function');
    });

    it('verifying a signature refuses, naming the load failure', async () => {
        await expect(
            verifyDetachedSignature({
                what: 'Node.js SHASUMS256.txt for v24.99.0',
                data: new TextEncoder().encode(LIST),
                signature: new Uint8Array([1, 2, 3]),
                keySet: PINNED_RELEASE_KEYS.nodejs,
            }),
        ).rejects.toThrow(
            // vitest wraps the factory's throw in its own message; a real
            // missing package reads "Cannot find module 'openpgp'" here.
            /^Node\.js SHASUMS256\.txt for v24\.99\.0: the OpenPGP library could not be loaded \(.+\) -- refusing to install an unverified list$/,
        );
    });

    it('a Node.js update fails closed and installs nothing', async () => {
        const archive = 'not-a-real-node-archive';
        const sha = createHash('sha256').update(archive).digest('hex');
        vi.spyOn(global, 'fetch').mockImplementation(async (input: string | URL | Request) => {
            const url = new URL(String(input instanceof Request ? input.url : input));
            if (url.pathname.endsWith('/SHASUMS256.txt')) return new Response(`${sha}  whatever.tar.gz\n`);
            if (url.pathname.endsWith('/SHASUMS256.txt.sig')) return new Response(new Uint8Array([1, 2, 3]));
            return new Response(archive);
        });
        const mgr = new DependencyManager(tmpDepsDir);
        mgr.getByName('nodejs')!.latestVersion = '24.99.0';
        const install = vi.spyOn(mgr as any, 'installNodejs').mockResolvedValue(undefined);

        const result = await mgr.update('nodejs');

        expect(result.success).toBe(false);
        expect(result.errorMessage).toContain('the OpenPGP library could not be loaded');
        expect(install).not.toHaveBeenCalled();
    });
});
