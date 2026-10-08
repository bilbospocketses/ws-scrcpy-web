import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVER_VERSION } from '../../common/Constants';
import { DependencyStatus } from '../../common/DependencyTypes';
import { DependencyManager } from '../DependencyManager';

// The seed must match a pinned hash since 2026-10-08, so it is the vendored jar.
const SEED = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'assets', 'scrcpy-server'),
);

vi.mock('../service/elevatedRunner', () => ({
    launcherIsAvailable: vi.fn(async () => true),
    resolveLauncherPath: () => '/fake/launcher.exe',
}));

/**
 * D5 (2026-09-30): first run promoted the seed scrcpy-server and then
 * downloaded the same version over it, because the loop read the
 * installedVersion that checkAll() recorded BEFORE the promote. Measured on
 * beta.160 in a container: "promoted seed" then "Updating scrcpy-server: not
 * installed → 4.1" 0.8 s later.
 */
describe('DependencyManager.autoInstallMissing — the promoted seed counts as installed', () => {
    let root: string;
    let depsPath: string;
    let seedFile: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'wssw-seed-promote-'));
        depsPath = path.join(root, 'deps');
        fs.mkdirSync(depsPath);
        seedFile = path.join(root, 'seed', 'scrcpy-server', 'scrcpy-server');
        fs.mkdirSync(path.dirname(seedFile), { recursive: true });
        fs.writeFileSync(seedFile, SEED);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(root, { recursive: true, force: true });
    });

    function managerWithScrcpyMissing(): { mgr: DependencyManager; update: ReturnType<typeof vi.spyOn> } {
        const mgr = new DependencyManager(depsPath);
        const update = vi.spyOn(mgr, 'update').mockResolvedValue({
            success: true,
            newVersion: 'stub',
            requiresRestart: false,
        });
        // What checkAll() leaves behind on a fresh data root: nothing on disk
        // yet, and a latest version known.
        const scrcpy = mgr.getByName('scrcpy-server')!;
        scrcpy.installedVersion = null;
        scrcpy.latestVersion = SERVER_VERSION;
        return { mgr, update };
    }

    it('does not download scrcpy-server over the seed it just promoted', async () => {
        vi.spyOn(DependencyManager, 'seedScrcpyServerPath').mockReturnValue(seedFile);
        const { mgr, update } = managerWithScrcpyMissing();

        await mgr.autoInstallMissing();

        expect(fs.readFileSync(path.join(depsPath, 'scrcpy-server', 'scrcpy-server')).equals(SEED)).toBe(true);
        expect(update).not.toHaveBeenCalledWith('scrcpy-server');
        expect(mgr.getByName('scrcpy-server')!.installedVersion).toBe(SERVER_VERSION);
    });

    it('offline: the promoted seed is installed and no longer carries the failed lookup as an error', async () => {
        vi.spyOn(DependencyManager, 'seedScrcpyServerPath').mockReturnValue(seedFile);
        const { mgr, update } = managerWithScrcpyMissing();
        // What checkAll() leaves on an offline first boot: the lookup failed
        // with nothing installed yet, so checkLatest marked it Error.
        const scrcpy = mgr.getByName('scrcpy-server')!;
        scrcpy.latestVersion = null;
        scrcpy.status = DependencyStatus.Error;
        scrcpy.errorMessage = 'fetch failed';

        await mgr.autoInstallMissing();

        expect(update).not.toHaveBeenCalledWith('scrcpy-server');
        expect(scrcpy.installedVersion).toBe(SERVER_VERSION);
        expect(scrcpy.status).toBe(DependencyStatus.Unknown);
        expect(scrcpy.errorMessage).toBeUndefined();
    });

    it('control: with no seed to promote, scrcpy-server is still downloaded', async () => {
        vi.spyOn(DependencyManager, 'seedScrcpyServerPath').mockReturnValue(path.join(root, 'no-such-seed'));
        const { mgr, update } = managerWithScrcpyMissing();

        await mgr.autoInstallMissing();

        expect(update).toHaveBeenCalledWith('scrcpy-server');
    });
});
