import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DependencyStatus } from '../../common/DependencyTypes';
import { DependencyManager } from '../DependencyManager';

/**
 * End-to-end coverage for the "scrcpy-server update loop" bug:
 * pre-fix, update() set in-memory installedVersion to the new value,
 * but checkInstalled() returned the bundled SERVER_VERSION constant
 * regardless of what was on disk — so the next checkAll() flipped
 * the row back to "Update available" even though the JAR had been
 * replaced. Post-fix, the new version is persisted as a .version
 * marker and checkInstalled reads from it; both update() and the
 * subsequent checkAll() agree on what's installed.
 */
describe('DependencyManager.update("scrcpy-server") — loop fix', () => {
    let tmpDir: string;
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsscrcpy-update-'));

        // Stub fetch for both checkLatest (GitHub releases API) and the
        // binary download. Both go through global fetch.
        fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input: string | URL | Request) => {
            const url = typeof input === 'string' ? input : input.toString();
            if (url.includes('api.github.com')) {
                return new Response(JSON.stringify({ tag_name: 'v4.0' }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            // Binary download — return synthetic v4.0 bytes
            return new Response('fake-v4.0-jar-bytes', { status: 200 });
        });
    });

    afterEach(() => {
        fetchSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('persists the installed version so a subsequent checkAll does not reset it', async () => {
        const mgr = new DependencyManager(tmpDir);

        // Seed the in-memory state to look like a pre-update install.
        const info = mgr.getByName('scrcpy-server')!;
        info.installedVersion = '3.3.4';
        info.latestVersion = '4.0';
        info.status = DependencyStatus.UpdateAvailable;

        const result = await mgr.update('scrcpy-server');

        expect(result.success).toBe(true);
        expect(result.newVersion).toBe('4.0');

        // The .version marker must exist on disk after a successful update.
        const marker = path.join(tmpDir, 'scrcpy-server', '.version');
        expect(fs.readFileSync(marker, 'utf8').trim()).toBe('4.0');

        // In-memory state shows the new version.
        expect(mgr.getByName('scrcpy-server')!.installedVersion).toBe('4.0');
        expect(mgr.getByName('scrcpy-server')!.status).toBe(DependencyStatus.UpToDate);

        // The actual loop trigger: re-running checkInstalled (as checkAll
        // does) must NOT clobber installedVersion back to SERVER_VERSION.
        await mgr.checkInstalled('scrcpy-server');
        expect(mgr.getByName('scrcpy-server')!.installedVersion).toBe('4.0');
    });
});
