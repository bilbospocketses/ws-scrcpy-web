import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { resolveConfigPath, resolveDataRoot } from '../Config';

describe('resolveDataRoot', () => {
    describe('on win32', () => {
        it('returns <PROGRAMDATA>\\WsScrcpyWeb when PROGRAMDATA is set', () => {
            const result = resolveDataRoot({ PROGRAMDATA: 'C:\\ProgramData' }, 'win32');
            expect(result).toBe('C:\\ProgramData\\WsScrcpyWeb');
        });

        it('honors a non-default PROGRAMDATA value', () => {
            const result = resolveDataRoot({ PROGRAMDATA: 'D:\\Custom\\ProgramData' }, 'win32');
            expect(result).toBe('D:\\Custom\\ProgramData\\WsScrcpyWeb');
        });

        it('falls back to C:\\ProgramData\\WsScrcpyWeb when PROGRAMDATA is missing', () => {
            const result = resolveDataRoot({}, 'win32');
            expect(result).toBe('C:\\ProgramData\\WsScrcpyWeb');
        });

        it('falls back when PROGRAMDATA is set to an empty string', () => {
            const result = resolveDataRoot({ PROGRAMDATA: '' }, 'win32');
            expect(result).toBe('C:\\ProgramData\\WsScrcpyWeb');
        });
    });

    describe('on non-win32', () => {
        it('returns null on linux (no migration target on non-Windows)', () => {
            const result = resolveDataRoot({}, 'linux');
            expect(result).toBeNull();
        });

        it('returns null on darwin', () => {
            const result = resolveDataRoot({}, 'darwin');
            expect(result).toBeNull();
        });
    });
});

describe('resolveConfigPath with dataRoot', () => {
    it('returns <dataRoot>/config.json when dataRoot is provided', () => {
        const result = resolveConfigPath('/any/entry.js', () => false, 'C:\\ProgramData\\WsScrcpyWeb');
        // Use platform-correct join in expectation
        expect(result).toBe(path.join('C:\\ProgramData\\WsScrcpyWeb', 'config.json'));
    });

    it('dataRoot wins even when entry script has a sibling package.json (production preference)', () => {
        // Even if a dev-tell exists, an explicit dataRoot means production layout — use it.
        const result = resolveConfigPath('/repo/dist/index.js', () => true, '/data/root');
        expect(result).toBe(path.join('/data/root', 'config.json'));
    });

    it('falls back to entry-script-relative resolution when dataRoot is null (dev mode)', () => {
        // No dataRoot → existing dev-tell resolution applies (entry's parent dir).
        // Use path.resolve to match the implementation's host-platform behavior
        // (e.g. on Windows, /repo/dist resolves to C:\repo\dist).
        const result = resolveConfigPath('/repo/dist/index.js', () => true, null);
        expect(result).toBe(path.join(path.resolve('/repo/dist', '..'), 'config.json'));
    });

    it('falls back to entry-script-relative resolution when dataRoot is undefined', () => {
        const result = resolveConfigPath('/repo/dist/index.js', () => true);
        expect(result).toBe(path.join(path.resolve('/repo/dist', '..'), 'config.json'));
    });
});
