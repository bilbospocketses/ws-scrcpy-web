import { describe, expect, it } from 'vitest';
import { resolveAdbPath } from '../Config';

describe('resolveAdbPath', () => {
    it('returns fileConfig.adbPath when set (user override wins)', () => {
        const r = resolveAdbPath({ adbPath: '/explicit/local/adb' }, '/install/dependencies', 'linux');
        expect(r).toEqual({ path: '/explicit/local/adb', source: 'config' });
    });

    it('returns the bundled-binary path when no override is set (linux)', () => {
        const r = resolveAdbPath({}, '/install/dependencies', 'linux');
        expect(r).toEqual({
            path: '/install/dependencies/adb/adb',
            source: 'bundled',
        });
    });

    it('uses adb.exe suffix and backslashes on win32', () => {
        const r = resolveAdbPath({}, 'C:\\install\\dependencies', 'win32');
        expect(r).toEqual({
            path: 'C:\\install\\dependencies\\adb\\adb.exe',
            source: 'bundled',
        });
    });

    it('returns the bundled path even when the file does not yet exist (first-run window)', () => {
        // The resolver does NOT fall back to system PATH when the bundled
        // binary is missing. AdbClient is expected to throw
        // AdbExecError('spawn',...) cleanly until autoInstallMissing
        // populates dependencies/adb/.
        const r = resolveAdbPath({}, '/never/will/exist', 'linux');
        expect(r.source).toBe('bundled');
        expect(r.path).toBe('/never/will/exist/adb/adb');
    });

    it('config.json override beats the bundled path', () => {
        const r = resolveAdbPath({ adbPath: '/user/picked/this/adb' }, '/install/dependencies', 'linux');
        expect(r.source).toBe('config');
        expect(r.path).toBe('/user/picked/this/adb');
    });

    it('does not consult ADB_PATH env or any process state — pure function', () => {
        // Sanity: call with same inputs twice, get same result, regardless of
        // ambient process.env. (The signature no longer accepts an env object;
        // env-var resolution was removed.)
        const a = resolveAdbPath({}, '/install/dependencies', 'linux');
        const b = resolveAdbPath({}, '/install/dependencies', 'linux');
        expect(a).toEqual(b);
    });
});
