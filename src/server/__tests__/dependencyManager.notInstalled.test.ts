import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DependencyStatus } from '../../common/DependencyTypes';
import { DependencyManager } from '../DependencyManager';

/**
 * 0.5.1: a dependency fetched on first use (`deferInstall`, mkcert) that is not
 * installed reports `NotInstalled`, decided here on the server, so the panel
 * can offer an install button instead of an Unknown pill. Every other missing
 * dependency keeps the state it had -- `Unknown`, or `Error` when its lookup
 * failed -- because those are what the first-run banner reads as "setup is
 * incomplete".
 */
describe('NotInstalled for a first-use dependency', () => {
    let depsPath = '';
    let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

    beforeEach(() => {
        depsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wsdeps-notinst-'));
    });

    afterEach(() => {
        fetchSpy?.mockRestore();
        fetchSpy = undefined;
        fs.rmSync(depsPath, { recursive: true, force: true });
    });

    function stubLatest(tag: string): void {
        fetchSpy = vi
            .spyOn(global, 'fetch')
            .mockImplementation(async () => new Response(JSON.stringify({ tag_name: tag }), { status: 200 }));
    }

    it('checkInstalled finding no mkcert reports NotInstalled; a missing adb stays Unknown', async () => {
        const mgr = new DependencyManager(depsPath);

        await mgr.checkInstalled('mkcert');
        await mgr.checkInstalled('adb');

        expect(mgr.getByName('mkcert')!.installedVersion).toBeNull();
        expect(mgr.getByName('mkcert')!.status).toBe(DependencyStatus.NotInstalled);
        expect(mgr.getByName('adb')!.installedVersion).toBeNull();
        expect(mgr.getByName('adb')!.status).toBe(DependencyStatus.Unknown);
    });

    it('stays NotInstalled once its latest version is known', async () => {
        stubLatest('v0.1.0');
        const mgr = new DependencyManager(depsPath);
        await mgr.checkInstalled('mkcert');

        await mgr.checkLatest('mkcert');

        const mkcert = mgr.getByName('mkcert')!;
        expect(mkcert.latestVersion).toBe('v0.1.0');
        expect(mkcert.status).toBe(DependencyStatus.NotInstalled);
    });

    it('a refused lookup leaves it NotInstalled with no error, and the refusal on latestLookup', async () => {
        fetchSpy = vi
            .spyOn(global, 'fetch')
            .mockResolvedValue(new Response('{"message":"API rate limit exceeded"}', { status: 403 }));
        const mgr = new DependencyManager(depsPath);
        await mgr.checkInstalled('mkcert');

        await mgr.checkLatest('mkcert');

        const mkcert = mgr.getByName('mkcert')!;
        expect(mkcert.status).toBe(DependencyStatus.NotInstalled);
        expect(mkcert.errorMessage).toBeUndefined();
        expect(mkcert.latestLookup?.outcome).toBe('refused');
        expect(mkcert.latestLookup?.httpStatus).toBe(403);
    });

    it('a boot-installed dependency missing with a refused lookup is still an Error (item 124)', async () => {
        fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 403 }));
        const mgr = new DependencyManager(depsPath);
        const scrcpy = mgr.getByName('scrcpy-server')!;
        scrcpy.installedVersion = null;

        await mgr.checkLatest('scrcpy-server');

        expect(scrcpy.status).toBe(DependencyStatus.Error);
    });

    it('an installed mkcert resolves UpToDate / UpdateAvailable as before', async () => {
        stubLatest('v0.1.0');
        const mgr = new DependencyManager(depsPath);
        const mkcert = mgr.getByName('mkcert')!;

        mkcert.installedVersion = 'v0.1.0';
        await mgr.checkLatest('mkcert');
        expect(mkcert.status).toBe(DependencyStatus.UpToDate);

        mkcert.installedVersion = '1.4.4-bt.2';
        await mgr.checkLatest('mkcert');
        expect(mkcert.status).toBe(DependencyStatus.UpdateAvailable);
    });

    it('a failed install reports Error with the reason, and the next check reads NotInstalled again', async () => {
        fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
        const mgr = new DependencyManager(depsPath);
        await mgr.checkInstalled('mkcert');

        const result = await mgr.update('mkcert');

        const mkcert = mgr.getByName('mkcert')!;
        expect(result.success).toBe(false);
        expect(mkcert.status).toBe(DependencyStatus.Error);
        expect(mkcert.errorMessage).toBeTruthy();

        await mgr.checkInstalled('mkcert');
        expect(mkcert.status).toBe(DependencyStatus.NotInstalled);
    });

    it('autoInstallMissing still never installs it at boot', async () => {
        stubLatest('v0.1.0');
        const mgr = new DependencyManager(depsPath);
        await mgr.checkInstalled('mkcert');
        await mgr.checkLatest('mkcert');
        const updateSpy = vi
            .spyOn(mgr, 'update')
            .mockResolvedValue({ success: true, newVersion: 'x', requiresRestart: false });

        await mgr.autoInstallMissing();

        expect(updateSpy).not.toHaveBeenCalledWith('mkcert');
        expect(mgr.getByName('mkcert')!.status).toBe(DependencyStatus.NotInstalled);
    });
});
