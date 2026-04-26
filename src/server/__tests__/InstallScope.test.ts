import { describe, expect, it } from 'vitest';
import { detectInstallScope } from '../InstallScope';

describe('detectInstallScope', () => {
    it('returns "system" on non-Windows platforms regardless of execPath', () => {
        expect(
            detectInstallScope({
                platform: 'linux',
                execPath: '/home/user/ws-scrcpy-web/node',
                localAppData: undefined,
            }),
        ).toBe('system');
        expect(
            detectInstallScope({
                platform: 'darwin',
                execPath: '/Users/u/Applications/ws-scrcpy-web/node',
                localAppData: undefined,
            }),
        ).toBe('system');
    });

    it('returns "system" on Windows when LOCALAPPDATA is unset', () => {
        expect(
            detectInstallScope({
                platform: 'win32',
                execPath: 'C:\\Program Files\\ws-scrcpy-web\\current\\node.exe',
                localAppData: undefined,
            }),
        ).toBe('system');
    });

    it('returns "user" when execPath sits under LOCALAPPDATA', () => {
        expect(
            detectInstallScope({
                platform: 'win32',
                execPath: 'C:\\Users\\jamie\\AppData\\Local\\ws-scrcpy-web\\current\\node.exe',
                localAppData: 'C:\\Users\\jamie\\AppData\\Local',
            }),
        ).toBe('user');
    });

    it('compares paths case-insensitively (Windows convention)', () => {
        expect(
            detectInstallScope({
                platform: 'win32',
                execPath: 'c:\\users\\jamie\\appdata\\local\\ws-scrcpy-web\\current\\node.exe',
                localAppData: 'C:\\Users\\jamie\\AppData\\Local',
            }),
        ).toBe('user');
    });

    it('returns "system" when execPath is per-machine (Program Files)', () => {
        expect(
            detectInstallScope({
                platform: 'win32',
                execPath: 'C:\\Program Files\\ws-scrcpy-web\\current\\node.exe',
                localAppData: 'C:\\Users\\jamie\\AppData\\Local',
            }),
        ).toBe('system');
    });
});
