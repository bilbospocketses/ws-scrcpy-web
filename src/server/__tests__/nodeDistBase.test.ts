import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    getArch,
    getDependencyDefinitions,
    getPlatform,
    NODE_DIST_BASE_ENV,
    nodeDistBase,
} from '../DependencyDefinitions';

// Smoke row 9.12: one base for every URL Node's update path reads from
// nodejs.org, so a fixture can offer a newer Node to a fast-tier server.
describe('WS_SCRCPY_NODE_DIST_BASE', () => {
    let depsPath = '';
    const def = () => getDependencyDefinitions(depsPath).find((d) => d.name === 'nodejs')!;
    let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;
    const archive = (version: string) =>
        getPlatform() === 'win32'
            ? `v${version}/node-v${version}-win-${getArch()}.zip`
            : `v${version}/node-v${version}-linux-${getArch()}.tar.gz`;

    beforeEach(() => {
        // A deps folder with no cached prebuilt manifest, so the gating step's
        // only input is the (refused) manifest fetch and the lookup stays ungated.
        depsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'node-dist-base-'));
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        fetchSpy?.mockRestore();
        fetchSpy = undefined;
        fs.rmSync(depsPath, { recursive: true, force: true });
    });

    /** Every URL fetch was called with: the release index answers, anything else is a 404. */
    const recordFetches = (): string[] => {
        const urls: string[] = [];
        fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
            const url = String(input);
            urls.push(url);
            if (url.endsWith('/index.json')) {
                return new Response(JSON.stringify([{ version: 'v24.99.0', lts: 'Krypton' }]), { status: 200 });
            }
            return new Response('{}', { status: 404 });
        });
        return urls;
    };

    it('is named as the docs and the e2e harness name it', () => {
        expect(NODE_DIST_BASE_ENV).toBe('WS_SCRCPY_NODE_DIST_BASE');
    });

    it('unset, the index and the archive come from nodejs.org exactly as before', async () => {
        vi.stubEnv(NODE_DIST_BASE_ENV, undefined);
        expect(nodeDistBase()).toBe('https://nodejs.org/dist');
        expect(def().getDownloadUrl('24.99.0')).toBe(`https://nodejs.org/dist/${archive('24.99.0')}`);

        const urls = recordFetches();
        await expect(def().checkLatest()).resolves.toBe('24.99.0');
        expect(urls[0]).toBe('https://nodejs.org/dist/index.json');
    });

    it('set, the index and the archive move under it, trimmed and without trailing slashes', async () => {
        vi.stubEnv(NODE_DIST_BASE_ENV, ' http://127.0.0.1:8146/dist/// ');
        const base = 'http://127.0.0.1:8146/dist';
        expect(nodeDistBase()).toBe(base);
        expect(def().getDownloadUrl('24.99.0')).toBe(`${base}/${archive('24.99.0')}`);

        const urls = recordFetches();
        await expect(def().checkLatest()).resolves.toBe('24.99.0');
        expect(urls[0]).toBe(`${base}/index.json`);
        // nodejs.org is never asked for anything once the base is set.
        expect(urls.filter((u) => u.includes('nodejs.org'))).toEqual([]);
    });

    it('takes an explicit override over the environment', () => {
        vi.stubEnv(NODE_DIST_BASE_ENV, 'http://127.0.0.1:1/ignored');
        expect(nodeDistBase('https://mirror.example/node/')).toBe('https://mirror.example/node');
    });

    it('a blank value is unset', () => {
        vi.stubEnv(NODE_DIST_BASE_ENV, '   ');
        expect(nodeDistBase()).toBe('https://nodejs.org/dist');
        expect(def().getDownloadUrl('24.99.0')).toBe(`https://nodejs.org/dist/${archive('24.99.0')}`);
    });

    it("does not move the node-pty prebuilt manifest, which is this repo's release asset, not Node's", async () => {
        vi.stubEnv(NODE_DIST_BASE_ENV, 'http://127.0.0.1:8146/dist');
        const urls = recordFetches();
        await def().checkLatest();
        expect(urls.slice(1)).toEqual([
            'https://github.com/bilbospocketses/ws-scrcpy-web/releases/download/node-pty-prebuilds-latest/manifest.json',
        ]);
    });
});
