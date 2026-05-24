import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DependencyStatus } from '../../common/DependencyTypes';
import * as elevatedRunnerModule from '../service/elevatedRunner';
import { DependencyManager } from '../DependencyManager';

vi.mock('../service/elevatedRunner', () => ({
    launcherIsAvailable: vi.fn(() => true),
    resolveLauncherPath: () => '/fake/launcher.exe',
}));

describe('DependencyManager.autoInstallMissing', () => {
    let mgr: DependencyManager;
    let updateSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mgr = new DependencyManager('/tmp/test-deps');
        updateSpy = vi.spyOn(mgr, 'update').mockResolvedValue({
            success: true,
            newVersion: 'stub',
            requiresRestart: false,
        });
    });

    afterEach(() => {
        updateSpy.mockRestore();
    });

    it('installs deps with null installedVersion and non-null latestVersion', async () => {
        const adb = mgr.getByName('adb')!;
        adb.installedVersion = null;
        adb.latestVersion = '35.0.2';
        adb.status = DependencyStatus.Unknown;

        await mgr.autoInstallMissing();

        expect(updateSpy).toHaveBeenCalledWith('adb');
        expect(updateSpy).toHaveBeenCalledTimes(1);
    });

    it('skips deps with null latestVersion (offline case)', async () => {
        const adb = mgr.getByName('adb')!;
        adb.installedVersion = null;
        adb.latestVersion = null;
        adb.status = DependencyStatus.Error;

        await mgr.autoInstallMissing();

        expect(updateSpy).not.toHaveBeenCalled();
    });

    it('skips deps that are already installed (update-path, not install-path)', async () => {
        const nodejs = mgr.getByName('nodejs')!;
        nodejs.installedVersion = '22.11.0';
        nodejs.latestVersion = '24.14.1';
        nodejs.status = DependencyStatus.UpdateAvailable;

        await mgr.autoInstallMissing();

        expect(updateSpy).not.toHaveBeenCalled();
    });

    it('skips deps that are up-to-date', async () => {
        const nodejs = mgr.getByName('nodejs')!;
        nodejs.installedVersion = '24.14.1';
        nodejs.latestVersion = '24.14.1';
        nodejs.status = DependencyStatus.UpToDate;

        await mgr.autoInstallMissing();

        expect(updateSpy).not.toHaveBeenCalled();
    });

    it('installs multiple missing deps sequentially', async () => {
        const adb = mgr.getByName('adb')!;
        adb.installedVersion = null;
        adb.latestVersion = '35.0.2';
        const scrcpy = mgr.getByName('scrcpy-server')!;
        scrcpy.installedVersion = null;
        scrcpy.latestVersion = '3.4';

        await mgr.autoInstallMissing();

        expect(updateSpy).toHaveBeenCalledTimes(2);
        expect(updateSpy).toHaveBeenCalledWith('adb');
        expect(updateSpy).toHaveBeenCalledWith('scrcpy-server');
    });

    it('skips launcher-required deps in dev mode (no launcher available)', async () => {
        vi.mocked(elevatedRunnerModule.launcherIsAvailable).mockReturnValue(false);

        const nodejs = mgr.getByName('nodejs')!;
        nodejs.installedVersion = null;
        nodejs.latestVersion = '24.15.0';

        const scrcpy = mgr.getByName('scrcpy-server')!;
        scrcpy.installedVersion = null;
        scrcpy.latestVersion = '4.0';

        await mgr.autoInstallMissing();

        // nodejs is skipped (requiresLauncher && !launcherIsAvailable)
        expect(updateSpy).not.toHaveBeenCalledWith('nodejs');
        // scrcpy-server still gets installed (no launcher needed)
        expect(updateSpy).toHaveBeenCalledWith('scrcpy-server');

        vi.mocked(elevatedRunnerModule.launcherIsAvailable).mockReturnValue(true);
    });
});
