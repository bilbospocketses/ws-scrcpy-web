import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveDependenciesPath } from '../Config';

describe('resolveDependenciesPath', () => {
    let tmpRoot: string;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cfg-'));
    });

    afterEach(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('returns DEPS_PATH env when set', () => {
        const result = resolveDependenciesPath(
            { DEPS_PATH: '/explicit/deps' },
            {},
            '/any/entry.js',
            () => true,
            'linux',
        );
        expect(result).toBe('/explicit/deps');
    });

    it('env wins over fileConfig and dev fallback', () => {
        const result = resolveDependenciesPath(
            { DEPS_PATH: '/env/deps' },
            { dependenciesPath: '/config/deps' },
            '/any/entry.js',
            () => true,
            'linux',
        );
        expect(result).toBe('/env/deps');
    });

    it('returns fileConfig.dependenciesPath when env is absent', () => {
        const result = resolveDependenciesPath(
            {},
            { dependenciesPath: '/from/config' },
            '/any/entry.js',
            () => true,
            'linux',
        );
        expect(result).toBe('/from/config');
    });

    it('on Linux, falls back to ../dependencies when package.json sibling exists (dev tell)', () => {
        const entry = path.join(tmpRoot, 'dist', 'index.js');
        fs.mkdirSync(path.dirname(entry), { recursive: true });
        fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
        const result = resolveDependenciesPath({}, {}, entry, fs.existsSync, 'linux');
        expect(result).toBe(path.resolve(tmpRoot, 'dependencies'));
    });

    it('on Windows, returns <dataRoot>/dependencies regardless of dev tell', () => {
        const result = resolveDependenciesPath(
            { PROGRAMDATA: 'D:\\Custom\\ProgramData' },
            {},
            'C:\\anywhere\\dist\\index.js',
            () => true, // pretend dev tell exists — should be ignored on Windows
            'win32',
        );
        expect(result).toBe(path.win32.join('D:\\Custom\\ProgramData', 'WsScrcpyWeb', 'dependencies'));
    });

    it('on Windows, defaults PROGRAMDATA to C:\\ProgramData when env is absent', () => {
        const result = resolveDependenciesPath(
            {},
            {},
            'C:\\anywhere\\dist\\index.js',
            () => false,
            'win32',
        );
        expect(result).toBe(path.win32.join('C:\\ProgramData', 'WsScrcpyWeb', 'dependencies'));
    });

    it('on Linux, throws a clear error when no source resolves and dev tell is missing', () => {
        expect(() =>
            resolveDependenciesPath({}, {}, '/no/package/json/here/dist/index.js', () => false, 'linux'),
        ).toThrow(/DEPS_PATH is not set/);
    });

    it('error message names DEPS_PATH and the platform-appropriate fallback location', () => {
        expect.assertions(3);
        try {
            resolveDependenciesPath({}, {}, '/no/pkg/dist/index.js', () => false, 'linux');
        } catch (e) {
            const msg = (e as Error).message;
            expect(msg).toContain('DEPS_PATH');
            expect(msg).toContain('<dataRoot>');
            expect(msg).toContain('package.json');
        }
    });
});
