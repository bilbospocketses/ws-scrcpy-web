import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CertPaths, migrateLegacyTlsHome, resolveCertPaths } from './certPaths';

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
        expect(normalized.startsWith(`${normalizedData}\\`)).toBe(false);
    });

    it('rejects malicious input where localAppData is under dataRoot', () => {
        expect(() =>
            resolveCertPaths({
                platform: 'win32',
                dataRoot: 'C:\\ProgramData\\WsScrcpyWeb',
                localAppData: 'C:\\ProgramData\\WsScrcpyWeb\\evil',
            }),
        ).toThrow(/caRoot must not resolve under dataRoot/);
    });

    it('rejects malicious input where HOME\\AppData\\Local is under dataRoot', () => {
        expect(() =>
            resolveCertPaths({
                platform: 'win32',
                dataRoot: 'C:\\ProgramData\\WsScrcpyWeb',
                home: 'C:\\ProgramData\\WsScrcpyWeb\\evil',
            }),
        ).toThrow(/caRoot must not resolve under dataRoot/);
    });

    it('puts CAROOT under the data root on POSIX, where the mode is real', () => {
        const p = resolveCertPaths({ platform: 'linux', dataRoot: '/data' });
        expect(p.caRoot).toBe('/data/tls/ca');
    });

    it('always returns absolute paths — mkcert writes leaves to the process cwd otherwise', () => {
        for (const opts of [
            { platform: 'linux' as const, dataRoot: '/data' },
            {
                platform: 'win32' as const,
                dataRoot: 'C:\\ProgramData\\WsScrcpyWeb',
                localAppData: 'C:\\Users\\jane\\AppData\\Local',
            },
        ]) {
            const p = resolveCertPaths(opts);
            for (const v of [p.caRoot, p.certFile, p.keyFile]) {
                expect(v === '' || v.startsWith('/') || /^[A-Za-z]:\\/.test(v)).toBe(true);
            }
        }
    });

    it('rejects relative dataRoot', () => {
        expect(() => resolveCertPaths({ platform: 'linux', dataRoot: 'relative/path' })).toThrow(
            /dataRoot must be absolute/,
        );
    });

    it('rejects relative localAppData on Windows', () => {
        expect(() =>
            resolveCertPaths({
                platform: 'win32',
                dataRoot: 'C:\\Data',
                localAppData: 'relative\\path',
            }),
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
        expect(normalized.startsWith(`${normalizedData}\\`)).toBe(false);
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
            expect(v.toLowerCase().startsWith(`${normalizedData}\\`)).toBe(false);
        }
    });

    it('throws when neither LOCALAPPDATA nor HOME is set on Windows', () => {
        expect(() =>
            resolveCertPaths({
                platform: 'win32',
                dataRoot: 'C:\\ProgramData\\WsScrcpyWeb',
            }),
        ).toThrow(/cannot resolve a per-user TLS directory on Windows/);
    });

    it('gives the Windows TLS home its own folder, beside the app folder rather than inside it', () => {
        // A per-user Velopack install lives in %LOCALAPPDATA%\WsScrcpyWeb and
        // its uninstall removes that folder. The CA every device trusts must
        // not go with it, so the TLS home is a sibling (user decision 2026-09-27).
        const p = resolveCertPaths({
            platform: 'win32',
            dataRoot: 'C:\\ProgramData\\WsScrcpyWeb',
            localAppData: 'C:\\Users\\jane\\AppData\\Local',
        });
        expect(p).toEqual({
            caRoot: 'C:\\Users\\jane\\AppData\\Local\\WsScrcpyWeb-tls\\ca',
            certFile: 'C:\\Users\\jane\\AppData\\Local\\WsScrcpyWeb-tls\\cert.pem',
            keyFile: 'C:\\Users\\jane\\AppData\\Local\\WsScrcpyWeb-tls\\key.pem',
            legacyTlsDir: 'C:\\Users\\jane\\AppData\\Local\\WsScrcpyWeb\\tls',
        });
    });

    it('reports no legacy location on POSIX, where the TLS home never moved', () => {
        expect(resolveCertPaths({ platform: 'linux', dataRoot: '/data' }).legacyTlsDir).toBeUndefined();
    });
});

describe('migrateLegacyTlsHome', () => {
    // Real directories, because the property that matters is what the
    // filesystem does: mkcert writes rootCA-key.pem read-only, and the move
    // has to carry it.
    let tmp: string;
    let paths: CertPaths;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-tls-migrate-'));
        const home = path.join(tmp, 'WsScrcpyWeb-tls');
        paths = {
            caRoot: path.join(home, 'ca'),
            certFile: path.join(home, 'cert.pem'),
            keyFile: path.join(home, 'key.pem'),
            legacyTlsDir: path.join(tmp, 'WsScrcpyWeb', 'tls'),
        };
    });

    afterEach(() => {
        // `force` removes the read-only key too; nothing to clear first.
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    /** A legacy home as a real install leaves it: CA with a read-only key, plus the leaf. */
    function seedLegacy(): void {
        const ca = path.join(paths.legacyTlsDir!, 'ca');
        fs.mkdirSync(ca, { recursive: true });
        fs.writeFileSync(path.join(ca, 'rootCA.pem'), 'ROOT CERT');
        fs.writeFileSync(path.join(ca, 'rootCA-key.pem'), 'ROOT KEY');
        fs.chmodSync(path.join(ca, 'rootCA-key.pem'), 0o400);
        fs.writeFileSync(path.join(paths.legacyTlsDir!, 'cert.pem'), 'LEAF CERT');
        fs.writeFileSync(path.join(paths.legacyTlsDir!, 'key.pem'), 'LEAF KEY');
    }

    it('moves the legacy home, read-only CA key included, when only the legacy home exists', () => {
        seedLegacy();
        expect(migrateLegacyTlsHome(paths)).toEqual({ outcome: 'moved' });
        expect(fs.readFileSync(path.join(paths.caRoot, 'rootCA.pem'), 'utf-8')).toBe('ROOT CERT');
        expect(fs.readFileSync(path.join(paths.caRoot, 'rootCA-key.pem'), 'utf-8')).toBe('ROOT KEY');
        expect(fs.readFileSync(paths.certFile, 'utf-8')).toBe('LEAF CERT');
        expect(fs.readFileSync(paths.keyFile, 'utf-8')).toBe('LEAF KEY');
        expect(fs.existsSync(paths.legacyTlsDir!)).toBe(false);
    });

    it('leaves BOTH homes alone when the new one already exists, and never overwrites it', () => {
        seedLegacy();
        fs.mkdirSync(paths.caRoot, { recursive: true });
        fs.writeFileSync(path.join(paths.caRoot, 'rootCA.pem'), 'NEWER ROOT');
        expect(migrateLegacyTlsHome(paths)).toEqual({ outcome: 'kept-both' });
        expect(fs.readFileSync(path.join(paths.caRoot, 'rootCA.pem'), 'utf-8')).toBe('NEWER ROOT');
        expect(fs.readFileSync(path.join(paths.legacyTlsDir!, 'ca', 'rootCA.pem'), 'utf-8')).toBe('ROOT CERT');
    });

    it('moves into a new home that exists but holds no files, rather than stranding the CA', () => {
        // An empty WsScrcpyWeb-tls (an interrupted start, or a hand-made folder)
        // is not a newer home. Treating it as one would leave the CA in the old
        // place on every boot while HTTPS reads "no certificate".
        seedLegacy();
        fs.mkdirSync(paths.caRoot, { recursive: true });
        expect(migrateLegacyTlsHome(paths)).toEqual({ outcome: 'moved' });
        expect(fs.readFileSync(path.join(paths.caRoot, 'rootCA-key.pem'), 'utf-8')).toBe('ROOT KEY');
        expect(fs.existsSync(paths.legacyTlsDir!)).toBe(false);
    });

    it('does nothing when there is no legacy home', () => {
        expect(migrateLegacyTlsHome(paths)).toEqual({ outcome: 'none' });
        expect(fs.existsSync(path.dirname(paths.certFile))).toBe(false);
    });

    it('does nothing on POSIX, where there is no legacy location', () => {
        const { legacyTlsDir: _unused, ...posix } = paths;
        expect(migrateLegacyTlsHome(posix)).toEqual({ outcome: 'none' });
    });

    it('retries a transient sharing violation, then moves', () => {
        // Endpoint AV can hold a handle for a moment and a rename is refused
        // while any handle is open; atomicFile's bounded retry is the remedy.
        seedLegacy();
        let calls = 0;
        const renameSync = vi.fn((from: fs.PathLike, to: fs.PathLike) => {
            calls += 1;
            if (calls === 1) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
            fs.renameSync(from, to);
        });
        expect(migrateLegacyTlsHome(paths, { ...fs, renameSync })).toEqual({ outcome: 'moved' });
        expect(renameSync).toHaveBeenCalledTimes(2);
        expect(fs.readFileSync(paths.certFile, 'utf-8')).toBe('LEAF CERT');
    });

    it('gives up after the bounded retries, reports the failure and leaves the legacy home where it was', () => {
        seedLegacy();
        const renameSync = vi.fn(() => {
            throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
        });
        expect(migrateLegacyTlsHome(paths, { ...fs, renameSync })).toEqual({
            outcome: 'failed',
            detail: 'EBUSY: resource busy or locked',
        });
        expect(renameSync).toHaveBeenCalledTimes(7);
        expect(fs.readFileSync(path.join(paths.legacyTlsDir!, 'ca', 'rootCA.pem'), 'utf-8')).toBe('ROOT CERT');
    });
});
