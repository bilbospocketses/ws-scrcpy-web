import { describe, expect, it } from 'vitest';
import { resolveCertPaths } from './certPaths';

describe('resolveCertPaths', () => {
    it('keeps CAROOT OUT of the shared data root on Windows — structural property', () => {
        // The security property is that caRoot does not resolve under dataRoot.
        // This test asserts the structural property, not substring matching.
        const p = resolveCertPaths({
            platform: 'win32',
            dataRoot: 'C:\\ProgramData\\WsScrcpyWeb',
            localAppData: 'C:\\Users\\jane\\AppData\\Local',
        });
        // caRoot must not be under dataRoot
        const normalized = p.caRoot.toLowerCase();
        const normalizedData = 'c:\\programdata\\wsscrcpyweb'.toLowerCase();
        expect(normalized.startsWith(normalizedData + '\\')).toBe(false);
    });

    it('rejects malicious input where localAppData is under dataRoot', () => {
        expect(() =>
            resolveCertPaths({
                platform: 'win32',
                dataRoot: 'C:\\ProgramData\\WsScrcpyWeb',
                localAppData: 'C:\\ProgramData\\WsScrcpyWeb\\evil',
            })
        ).toThrow(/caRoot must not resolve under dataRoot/);
    });

    it('rejects malicious input where HOME\\AppData\\Local is under dataRoot', () => {
        expect(() =>
            resolveCertPaths({
                platform: 'win32',
                dataRoot: 'C:\\ProgramData\\WsScrcpyWeb',
                home: 'C:\\ProgramData\\WsScrcpyWeb\\evil',
            })
        ).toThrow(/caRoot must not resolve under dataRoot/);
    });

    it('puts CAROOT under the data root on POSIX, where the mode is real', () => {
        const p = resolveCertPaths({ platform: 'linux', dataRoot: '/data' });
        expect(p.caRoot).toBe('/data/tls/ca');
    });

    it('always returns absolute paths — mkcert writes leaves to the process cwd otherwise', () => {
        for (const opts of [
            { platform: 'linux' as const, dataRoot: '/data' },
            { platform: 'win32' as const, dataRoot: 'C:\\ProgramData\\WsScrcpyWeb', localAppData: 'C:\\Users\\jane\\AppData\\Local' },
        ]) {
            const p = resolveCertPaths(opts);
            for (const v of [p.caRoot, p.certFile, p.keyFile]) {
                expect(v === '' || v.startsWith('/') || /^[A-Za-z]:\\/.test(v)).toBe(true);
            }
        }
    });

    it('rejects relative dataRoot', () => {
        expect(() =>
            resolveCertPaths({ platform: 'linux', dataRoot: 'relative/path' })
        ).toThrow(/dataRoot must be absolute/);
    });

    it('rejects relative localAppData on Windows', () => {
        expect(() =>
            resolveCertPaths({
                platform: 'win32',
                dataRoot: 'C:\\Data',
                localAppData: 'relative\\path',
            })
        ).toThrow(/LOCALAPPDATA or HOME\\AppData\\Local must be absolute/);
    });

    it('treats whitespace-only localAppData as empty and falls back to HOME', () => {
        const p = resolveCertPaths({
            platform: 'win32',
            dataRoot: 'C:\\Data',
            localAppData: '   ',
            home: 'C:\\Users\\jane',
        });
        expect(p.caRoot.toLowerCase()).toContain('jane');
    });

    it('keeps the leaf with the data root on POSIX, so a container volume carries it', () => {
        const p = resolveCertPaths({ platform: 'linux', dataRoot: '/data' });
        expect(p.certFile).toBe('/data/tls/cert.pem');
        expect(p.keyFile).toBe('/data/tls/key.pem');
    });

    it('keeps the leaf in the per-user directory on Windows, not under dataRoot', () => {
        const p = resolveCertPaths({
            platform: 'win32',
            dataRoot: 'C:\\ProgramData\\WsScrcpyWeb',
            localAppData: 'C:\\Users\\jane\\AppData\\Local',
        });
        // Leaf must also be out of dataRoot on Windows
        const normalized = p.certFile.toLowerCase();
        const normalizedData = 'c:\\programdata\\wsscrcpyweb'.toLowerCase();
        expect(normalized.startsWith(normalizedData + '\\')).toBe(false);
        // And must be in the per-user directory
        expect(p.certFile.toLowerCase()).toContain('appdata\\local');
        expect(p.keyFile.toLowerCase()).toContain('appdata\\local');
    });

    it('falls back to HOME on Windows when LOCALAPPDATA is unset', () => {
        const p = resolveCertPaths({
            platform: 'win32',
            dataRoot: 'C:\\ProgramData\\WsScrcpyWeb',
            home: 'C:\\Users\\jane',
        });
        // Both CA and leaf must be in the per-user directory
        expect(p.caRoot.toLowerCase()).toContain('jane');
        expect(p.certFile.toLowerCase()).toContain('jane');
        expect(p.keyFile.toLowerCase()).toContain('jane');
        // And all must be out of dataRoot
        const normalizedData = 'c:\\programdata\\wsscrcpyweb'.toLowerCase();
        for (const v of [p.caRoot, p.certFile, p.keyFile]) {
            expect(v.toLowerCase().startsWith(normalizedData + '\\')).toBe(false);
        }
    });

    it('throws when neither LOCALAPPDATA nor HOME is set on Windows', () => {
        expect(() =>
            resolveCertPaths({
                platform: 'win32',
                dataRoot: 'C:\\ProgramData\\WsScrcpyWeb',
            })
        ).toThrow(/cannot resolve a per-user TLS directory on Windows/);
    });
});
