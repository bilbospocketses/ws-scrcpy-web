import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { resolveDataRoot, resolveDependenciesPath } from '../Config';
import { resolveLogFilePath } from '../Logger';

// Finding 12.5 / 20.14 / 20.15 — the log file, the dependencies folder and the
// restart marker keyed on DEPS_PATH while config.json and the store keyed on
// DATA_ROOT. Row 12.4's "Node side and launcher agree" held only because the
// Rust launcher happens to set both. In the container the split is total:
// start.sh exports DEPS_PATH=/app/dependencies, so the log path resolved to
// /app/logs — root-owned, with the app running as uid 1000 — and every write
// no-opped. The shipped container writes no server log at all.
const WIN_PROGRAMDATA = String.raw`C:\ProgramData`;
const WIN_DATA_ROOT = String.raw`D:\ws-data`;
const WIN_ENTRY = String.raw`C:pp\dist\index.js`;

describe('DATA_ROOT is the one root', () => {
    describe('resolveDataRoot', () => {
        it('honors an explicit DATA_ROOT on win32, not only on linux', () => {
            expect(resolveDataRoot({ DATA_ROOT: WIN_DATA_ROOT, PROGRAMDATA: WIN_PROGRAMDATA }, 'win32')).toBe(
                WIN_DATA_ROOT,
            );
        });

        it('still falls back to PROGRAMDATA on win32 when DATA_ROOT is unset or empty', () => {
            const expected = path.win32.join(WIN_PROGRAMDATA, 'WsScrcpyWeb');
            expect(resolveDataRoot({ PROGRAMDATA: WIN_PROGRAMDATA }, 'win32')).toBe(expected);
            expect(resolveDataRoot({ DATA_ROOT: '', PROGRAMDATA: WIN_PROGRAMDATA }, 'win32')).toBe(expected);
        });
    });

    describe('resolveDependenciesPath', () => {
        const noFile = () => false;

        it('derives <DATA_ROOT>/dependencies when only DATA_ROOT is set, on linux', () => {
            const result = resolveDependenciesPath(
                { DATA_ROOT: '/srv/ws' },
                {},
                '/opt/app/dist/index.js',
                noFile,
                'linux',
            );
            expect(result).toBe(path.posix.join('/srv/ws', 'dependencies'));
        });

        it('derives <DATA_ROOT>/dependencies when only DATA_ROOT is set, on win32', () => {
            const result = resolveDependenciesPath({ DATA_ROOT: WIN_DATA_ROOT }, {}, WIN_ENTRY, noFile, 'win32');
            expect(result).toBe(path.win32.join(WIN_DATA_ROOT, 'dependencies'));
        });

        it('still lets DEPS_PATH and config.json win over DATA_ROOT', () => {
            expect(
                resolveDependenciesPath(
                    { DATA_ROOT: '/srv/ws', DEPS_PATH: '/explicit' },
                    {},
                    '/x/dist/i.js',
                    noFile,
                    'linux',
                ),
            ).toBe('/explicit');
            expect(
                resolveDependenciesPath(
                    { DATA_ROOT: '/srv/ws' },
                    { dependenciesPath: '/from/config' },
                    '/x/dist/i.js',
                    noFile,
                    'linux',
                ),
            ).toBe('/from/config');
        });

        it('still prefers the dev tree when no DATA_ROOT is set', () => {
            const result = resolveDependenciesPath({}, {}, '/repo/dist/index.js', () => true, 'linux');
            expect(result).toBe(path.resolve('/repo', 'dependencies'));
        });
    });

    describe('resolveLogFilePath', () => {
        it('puts the log under DATA_ROOT even when DEPS_PATH names somewhere else', () => {
            // Exactly the container's shape: start.sh exports the in-image path,
            // the Dockerfile declares the volume as DATA_ROOT.
            const result = resolveLogFilePath({ DATA_ROOT: '/data', DEPS_PATH: '/app/dependencies' });
            expect(result).toBe(path.join('/data', 'logs', 'ws-scrcpy-web.log'));
        });

        it('falls back to the parent of DEPS_PATH when DATA_ROOT is unset', () => {
            // The desktop launcher sets DEPS_PATH=<dataRoot>/dependencies, so
            // this is the same answer it has always given.
            const result = resolveLogFilePath({ DEPS_PATH: path.join('/var/lib/WsScrcpyWeb', 'dependencies') });
            expect(result).toBe(path.join('/var/lib/WsScrcpyWeb', 'logs', 'ws-scrcpy-web.log'));
        });

        it('falls back to the repo root in a bare dev run', () => {
            const result = resolveLogFilePath({});
            expect(result.endsWith('ws-scrcpy-web.log')).toBe(true);
            expect(result).not.toContain(`${path.sep}logs${path.sep}`);
        });
    });
});
