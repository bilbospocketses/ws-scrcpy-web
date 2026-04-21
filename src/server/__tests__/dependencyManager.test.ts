import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DependencyStatus } from '../../common/DependencyTypes';
import { DependencyManager } from '../DependencyManager';

describe('DependencyManager', () => {
    it('initializes with all dependencies in unknown state', () => {
        const mgr = new DependencyManager('/tmp/test-deps');
        const deps = mgr.getAll();
        expect(deps.length).toBe(3);
        expect(deps.every((d) => d.status === DependencyStatus.Unknown)).toBe(true);
    });

    it('getByName returns correct dependency', () => {
        const mgr = new DependencyManager('/tmp/test-deps');
        const node = mgr.getByName('nodejs');
        expect(node).toBeDefined();
        expect(node!.displayName).toBe('Node.js');
    });

    it('getByName returns undefined for unknown dependency', () => {
        const mgr = new DependencyManager('/tmp/test-deps');
        expect(mgr.getByName('nonexistent')).toBeUndefined();
    });

    it('nodejs is marked as requires restart', () => {
        const mgr = new DependencyManager('/tmp/test-deps');
        const node = mgr.getByName('nodejs');
        expect(node!.requiresRestart).toBe(true);
    });

    it('scrcpy-server is marked as no restart needed', () => {
        const mgr = new DependencyManager('/tmp/test-deps');
        const scrcpy = mgr.getByName('scrcpy-server');
        expect(scrcpy!.requiresRestart).toBe(false);
    });
});

describe('DependencyManager.requestRestart', () => {
    let tmpDir: string;
    let exitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-dm-'));
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code}`);
        }) as never);
    });

    afterEach(() => {
        exitSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('writes marker at depsPath/.restart (not dirname(depsPath)/.restart)', () => {
        const mgr = new DependencyManager(tmpDir);
        expect(() => mgr.requestRestart()).toThrow(/exit:/);
        expect(fs.existsSync(path.join(tmpDir, '.restart'))).toBe(true);
        expect(fs.existsSync(path.join(path.dirname(tmpDir), '.restart'))).toBe(false);
    });

    it('exits with code 75', () => {
        const mgr = new DependencyManager(tmpDir);
        expect(() => mgr.requestRestart()).toThrow('exit:75');
    });

    it('marker body contains a timestamp marker', () => {
        const mgr = new DependencyManager(tmpDir);
        try {
            mgr.requestRestart();
        } catch {
            /* expected */
        }
        const body = fs.readFileSync(path.join(tmpDir, '.restart'), 'utf-8');
        expect(body).toMatch(/^restart-requested-\d+$/);
    });
});

describe('DependencyManager resolveStatus — never auto-downgrade', () => {
    it('keeps UpToDate when installed version is newer than latest filtered', () => {
        const mgr = new DependencyManager('/tmp/test-deps');
        const info = mgr.getByName('nodejs')!;
        info.installedVersion = '26.0.0';
        info.latestVersion = '24.14.1';
        // @ts-expect-error — invoke private method for unit test
        mgr.resolveStatus(info);
        expect(info.status).toBe(DependencyStatus.UpToDate);
    });

    it('produces UpdateAvailable when installed is older than latest', () => {
        const mgr = new DependencyManager('/tmp/test-deps');
        const info = mgr.getByName('nodejs')!;
        info.installedVersion = '22.11.0';
        info.latestVersion = '24.14.1';
        // @ts-expect-error — invoke private method for unit test
        mgr.resolveStatus(info);
        expect(info.status).toBe(DependencyStatus.UpdateAvailable);
    });

    it('produces UpToDate when versions are equal', () => {
        const mgr = new DependencyManager('/tmp/test-deps');
        const info = mgr.getByName('nodejs')!;
        info.installedVersion = '24.14.1';
        info.latestVersion = '24.14.1';
        // @ts-expect-error — invoke private method for unit test
        mgr.resolveStatus(info);
        expect(info.status).toBe(DependencyStatus.UpToDate);
    });
});
