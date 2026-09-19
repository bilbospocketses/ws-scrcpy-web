import { describe, expect, it } from 'vitest';
import { resolveCertPaths } from './certPaths';

describe('resolveCertPaths', () => {
    it('keeps CAROOT OUT of the shared data root on Windows', () => {
        // C:\ProgramData\WsScrcpyWeb grants BUILTIN\Users ReadAndExecute by
        // inheritance (measured 2026-09-18), and mkcert sets no ACL on Windows,
        // so a CAROOT there is a CA private key any local account can read.
        const p = resolveCertPaths({
            platform: 'win32',
            dataRoot: 'C:\\ProgramData\\WsScrcpyWeb',
            localAppData: 'C:\\Users\\jane\\AppData\\Local',
        });
        expect(p.caRoot.toLowerCase()).not.toContain('programdata');
        expect(p.caRoot.toLowerCase()).toContain('appdata\\local');
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

    it('keeps the leaf with the data root, so a container volume carries it', () => {
        const p = resolveCertPaths({ platform: 'linux', dataRoot: '/data' });
        expect(p.certFile).toBe('/data/tls/cert.pem');
        expect(p.keyFile).toBe('/data/tls/key.pem');
    });

    it('falls back to HOME on Windows when LOCALAPPDATA is unset', () => {
        const p = resolveCertPaths({
            platform: 'win32',
            dataRoot: 'C:\\ProgramData\\WsScrcpyWeb',
            home: 'C:\\Users\\jane',
        });
        expect(p.caRoot.toLowerCase()).toContain('jane');
        expect(p.caRoot.toLowerCase()).not.toContain('programdata');
    });
});
