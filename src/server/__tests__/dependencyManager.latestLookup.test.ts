import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DependencyStatus } from '../../common/DependencyTypes';
import { DependencyManager, SKIP_BOOT_LATEST_ENV } from '../DependencyManager';
import { Logger } from '../Logger';

/**
 * `latestLookup` (2026-10-06, smoke 9.4).
 *
 * 9.4 excused a null Latest for a GitHub-backed dependency only when a SEPARATE
 * `/rate_limit` query, made after the check, read 0 remaining. That raced the
 * hourly reset: the app's own lookup was refused with HTTP 403 while the later
 * query read 60, then 1, and the row failed falsely twice. The app now records
 * how each of its own lookups ended, numbered, so a reader can excuse the
 * refusal of the lookup it caused and nothing else.
 */

const ADB_XML =
    '<remotePackage path="platform-tools"><revision><major>37</major><minor>0</minor><micro>1</micro></revision></remotePackage>';

/** Answers every URL the way the test names; `api.github.com` and dl.google.com are told apart by host. */
function stubFetch(answer: (url: string) => Response | Promise<Response>) {
    return vi.spyOn(global, 'fetch').mockImplementation(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        return answer(url);
    });
}

/** By parsed host, not substring: `https://evil.test/api.github.com` is not GitHub's API. */
function isGitHubApi(url: string): boolean {
    return new URL(url).hostname === 'api.github.com';
}

describe('DependencyManager records each latest-version lookup', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsscrcpy-latest-lookup-'));
    });

    afterEach(() => {
        fetchSpy?.mockRestore();
        fetchSpy = undefined;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('is absent until the first lookup', () => {
        const mgr = new DependencyManager(tmpDir);
        expect(mgr.getByName('adb')!.latestLookup).toBeUndefined();
    });

    it('counts lookups per dependency, +1 each', async () => {
        fetchSpy = stubFetch(() => new Response(ADB_XML, { status: 200 }));
        const mgr = new DependencyManager(tmpDir);

        await mgr.checkLatest('adb');
        await mgr.checkLatest('adb');
        await mgr.checkLatest('scrcpy-server');

        expect(mgr.getByName('adb')!.latestLookup?.seq).toBe(2);
        // Its own count: scrcpy-server's first lookup is 1, not 3.
        expect(mgr.getByName('scrcpy-server')!.latestLookup?.seq).toBe(1);
    });

    it("records 'ok' when the lookup answered with a version", async () => {
        fetchSpy = stubFetch(() => new Response(ADB_XML, { status: 200 }));
        const mgr = new DependencyManager(tmpDir);

        await mgr.checkLatest('adb');

        const lookup = mgr.getByName('adb')!.latestLookup!;
        expect(lookup).toMatchObject({ seq: 1, outcome: 'ok' });
        expect(lookup.httpStatus).toBeUndefined();
        expect(Number.isNaN(Date.parse(lookup.at))).toBe(false);
        expect(mgr.getByName('adb')!.latestVersion).toBe('37.0.1');
    });

    it.each([403, 429])("records 'refused' with the status when the server answered HTTP %i", async (status) => {
        fetchSpy = stubFetch(() => new Response('{"message":"API rate limit exceeded"}', { status }));
        const mgr = new DependencyManager(tmpDir);
        const dep = mgr.getByName('scrcpy-server')!;
        dep.installedVersion = '4.1';

        await mgr.checkLatest('scrcpy-server');

        expect(dep.latestLookup).toMatchObject({ seq: 1, outcome: 'refused', httpStatus: status });
        // Everything checkLatest already did is unchanged.
        expect(dep.latestVersion).toBeNull();
        expect(dep.status).toBe(DependencyStatus.Unknown);
        expect(dep.errorMessage).toBeUndefined();
    });

    it("records 'failed' when there was no answer at all", async () => {
        fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
        const mgr = new DependencyManager(tmpDir);
        const dep = mgr.getByName('adb')!;

        await mgr.checkLatest('adb');

        expect(dep.latestLookup).toMatchObject({ seq: 1, outcome: 'failed' });
        expect(dep.latestLookup?.httpStatus).toBeUndefined();
        expect(dep.status).toBe(DependencyStatus.Error);
    });

    it("records 'failed' when the answer held no version the definition accepts", async () => {
        fetchSpy = stubFetch(() => new Response('<nothing/>', { status: 200 }));
        const mgr = new DependencyManager(tmpDir);

        await mgr.checkLatest('adb');

        expect(mgr.getByName('adb')!.latestLookup).toMatchObject({ seq: 1, outcome: 'failed' });
    });

    it('a refused lookup followed by an ok one reads ok', async () => {
        let refuse = true;
        fetchSpy = stubFetch(() =>
            refuse
                ? new Response('{}', { status: 403 })
                : new Response(JSON.stringify({ tag_name: 'v4.1' }), { status: 200 }),
        );
        const mgr = new DependencyManager(tmpDir);
        const dep = mgr.getByName('scrcpy-server')!;
        dep.installedVersion = '4.1';

        await mgr.checkLatest('scrcpy-server');
        expect(dep.latestLookup).toMatchObject({ seq: 1, outcome: 'refused', httpStatus: 403 });

        refuse = false;
        await mgr.checkLatest('scrcpy-server');
        expect(dep.latestLookup).toEqual({ seq: 2, at: expect.any(String), outcome: 'ok' });
        expect(dep.latestVersion).toBe('4.1');
    });

    it('records the lookup inside update(), numbered after the earlier ones', async () => {
        let refuse = true;
        fetchSpy = stubFetch((url) => {
            if (isGitHubApi(url)) {
                return refuse
                    ? new Response('{}', { status: 403 })
                    : new Response(JSON.stringify({ tag_name: 'v4.0' }), { status: 200 });
            }
            return new Response('fake-v4.0-jar-bytes', { status: 200 });
        });
        const mgr = new DependencyManager(tmpDir);
        const dep = mgr.getByName('scrcpy-server')!;
        dep.installedVersion = '3.3.4';

        await mgr.checkLatest('scrcpy-server');
        expect(dep.latestLookup).toMatchObject({ seq: 1, outcome: 'refused' });

        refuse = false;
        const result = await mgr.update('scrcpy-server');

        expect(result.success).toBe(true);
        expect(dep.latestLookup).toMatchObject({ seq: 2, outcome: 'ok' });
    });

    it('records a refused lookup inside update() that then falls back to the bundled version', async () => {
        fetchSpy = stubFetch((url) =>
            isGitHubApi(url) ? new Response('{}', { status: 403 }) : new Response('fake-jar-bytes', { status: 200 }),
        );
        const mgr = new DependencyManager(tmpDir);

        const result = await mgr.update('scrcpy-server');

        expect(result.success).toBe(true);
        expect(mgr.getByName('scrcpy-server')!.latestLookup).toMatchObject({
            seq: 1,
            outcome: 'refused',
            httpStatus: 403,
        });
    });

    it('reaches GET /api/dependencies through getAll()', async () => {
        fetchSpy = stubFetch(() => new Response(ADB_XML, { status: 200 }));
        const mgr = new DependencyManager(tmpDir);
        await mgr.checkLatest('adb');

        const wire = JSON.parse(JSON.stringify(await mgr.getAll())) as { name: string; latestLookup?: unknown }[];

        expect(wire.find((d) => d.name === 'adb')?.latestLookup).toMatchObject({ seq: 1, outcome: 'ok' });
    });
});

/**
 * WS_SCRCPY_SKIP_BOOT_LATEST. The fast e2e tier boots many servers, and each
 * boot spent 2-3 of api.github.com's 60 unauthenticated calls an hour on
 * lookups for dependencies already installed, which nothing then read.
 */
describe(`checkAll and ${SKIP_BOOT_LATEST_ENV}`, () => {
    let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;
    let tmpDir: string;
    const saved = process.env[SKIP_BOOT_LATEST_ENV];

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsscrcpy-skip-boot-'));
        // 403 is not retried, so every lookup ends at once.
        fetchSpy = stubFetch(() => new Response('{}', { status: 403 }));
    });

    afterEach(() => {
        fetchSpy?.mockRestore();
        fetchSpy = undefined;
        vi.restoreAllMocks();
        if (saved === undefined) delete process.env[SKIP_BOOT_LATEST_ENV];
        else process.env[SKIP_BOOT_LATEST_ENV] = saved;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    /** adb and nodejs installed, scrcpy-server and mkcert not. */
    function managerWithInstalled(): DependencyManager {
        const mgr = new DependencyManager(tmpDir);
        const installed: Record<string, string | null> = {
            nodejs: '24.21.0',
            adb: '37.0.1',
            'scrcpy-server': null,
            mkcert: null,
        };
        vi.spyOn(mgr, 'checkInstalled').mockImplementation(async (name: string) => {
            mgr.getByName(name)!.installedVersion = installed[name] ?? null;
        });
        return mgr;
    }

    const lookedUp = (mgr: DependencyManager, name: string) => mgr.getByName(name)!.latestLookup !== undefined;

    it("boot + '1' skips the installed dependencies and still looks up the ones not installed", async () => {
        process.env[SKIP_BOOT_LATEST_ENV] = '1';
        const info = vi.spyOn(Logger.prototype, 'info');
        const mgr = managerWithInstalled();

        await mgr.checkAll({ boot: true });

        expect(lookedUp(mgr, 'nodejs'), 'nodejs is installed').toBe(false);
        expect(lookedUp(mgr, 'adb'), 'adb is installed').toBe(false);
        expect(lookedUp(mgr, 'scrcpy-server'), 'not installed: its install needs the answer').toBe(true);
        expect(lookedUp(mgr, 'mkcert'), 'not installed').toBe(true);
        expect(mgr.getByName('adb')!.status, 'installed, latest unknown').toBe(DependencyStatus.Unknown);
        const skipped = info.mock.calls.filter((c) =>
            String(c[0]).startsWith('boot latest-version lookups skipped for installed dependencies'),
        );
        expect(skipped.map((c) => c[0])).toEqual([
            `boot latest-version lookups skipped for installed dependencies (${SKIP_BOOT_LATEST_ENV}=1)`,
        ]);
    });

    it('a non-boot checkAll (POST /api/dependencies/check) ignores the variable', async () => {
        process.env[SKIP_BOOT_LATEST_ENV] = '1';
        const mgr = managerWithInstalled();

        await mgr.checkAll();

        for (const name of ['nodejs', 'adb', 'scrcpy-server', 'mkcert']) {
            expect(lookedUp(mgr, name), name).toBe(true);
        }
    });

    it.each([
        ['unset', undefined],
        ['0', '0'],
        ['true', 'true'],
        ['" 1"', ' 1'],
    ])('a boot pass with the variable %s looks everything up', async (_label, value) => {
        if (value === undefined) delete process.env[SKIP_BOOT_LATEST_ENV];
        else process.env[SKIP_BOOT_LATEST_ENV] = value;
        const info = vi.spyOn(Logger.prototype, 'info');
        const mgr = managerWithInstalled();

        await mgr.checkAll({ boot: true });

        for (const name of ['nodejs', 'adb', 'scrcpy-server', 'mkcert']) {
            expect(lookedUp(mgr, name), name).toBe(true);
        }
        expect(info.mock.calls.some((c) => String(c[0]).startsWith('boot latest-version lookups skipped'))).toBe(false);
    });

    it('update() always looks up, whatever the variable says', async () => {
        process.env[SKIP_BOOT_LATEST_ENV] = '1';
        const mgr = managerWithInstalled();
        await mgr.checkAll({ boot: true });
        expect(lookedUp(mgr, 'adb')).toBe(false);

        // The download itself is not under test; any failure after the lookup is fine.
        await mgr.update('adb');

        expect(mgr.getByName('adb')!.latestLookup).toMatchObject({ seq: 1, outcome: 'refused', httpStatus: 403 });
    });
});
