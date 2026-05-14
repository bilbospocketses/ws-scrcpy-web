import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeMarkerPath, decideRestart, resolveNodeBinary } from '../dev-supervisor.mjs';

describe('decideRestart', () => {
    it('returns "marker" when marker exists, regardless of exit code', () => {
        expect(decideRestart(0, true)).toBe('marker');
        expect(decideRestart(1, true)).toBe('marker');
        expect(decideRestart(75, true)).toBe('marker');
    });

    it('returns "exit-75" when exit code is 75 and no marker', () => {
        expect(decideRestart(75, false)).toBe('exit-75');
    });

    it('returns null for any other exit code with no marker', () => {
        expect(decideRestart(0, false)).toBe(null);
        expect(decideRestart(1, false)).toBe(null);
        expect(decideRestart(2, false)).toBe(null);
        expect(decideRestart(130, false)).toBe(null); // SIGINT
    });
});

describe('computeMarkerPath', () => {
    it('on Windows, uses PROGRAMDATA env var', () => {
        const result = computeMarkerPath({ PROGRAMDATA: 'D:\\Custom\\ProgramData' }, 'win32', '/repo');
        // path.join uses host separator but the input segments are preserved
        expect(result).toContain('Custom');
        expect(result).toContain('WsScrcpyWeb');
        expect(result.endsWith('.restart')).toBe(true);
    });

    it('on Windows, defaults PROGRAMDATA to C:\\ProgramData when unset', () => {
        const result = computeMarkerPath({}, 'win32', '/repo');
        expect(result).toContain('ProgramData');
        expect(result).toContain('WsScrcpyWeb');
        expect(result.endsWith('.restart')).toBe(true);
    });

    it('on non-Windows, uses repo root .restart', () => {
        const result = computeMarkerPath({}, 'linux', '/path/to/repo');
        expect(result).toBe(path.join('/path/to/repo', '.restart'));
    });
});

describe('resolveNodeBinary', () => {
    let tmpRoot;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-sup-'));
    });

    afterEach(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('on Windows, returns local-deps Node when <dataRoot>/dependencies/node/node.exe exists', () => {
        const dataRoot = path.join(tmpRoot, 'WsScrcpyWeb');
        const depsNode = path.join(dataRoot, 'dependencies', 'node', 'node.exe');
        fs.mkdirSync(path.dirname(depsNode), { recursive: true });
        fs.writeFileSync(depsNode, 'fake-node');

        // Also drop a seed node so we prove local-deps wins
        const repoRoot = path.join(tmpRoot, 'repo');
        const seedNode = path.join(repoRoot, 'seed', 'node', 'node.exe');
        fs.mkdirSync(path.dirname(seedNode), { recursive: true });
        fs.writeFileSync(seedNode, 'fake-seed');

        const result = resolveNodeBinary({ PROGRAMDATA: tmpRoot }, 'win32', repoRoot);
        expect(result).not.toBeNull();
        expect(result.source).toBe('local-deps');
        expect(result.path).toBe(depsNode);
    });

    it('on Windows, falls back to seed Node when local-deps is missing', () => {
        const repoRoot = path.join(tmpRoot, 'repo');
        const seedNode = path.join(repoRoot, 'seed', 'node', 'node.exe');
        fs.mkdirSync(path.dirname(seedNode), { recursive: true });
        fs.writeFileSync(seedNode, 'fake-seed');

        const result = resolveNodeBinary({ PROGRAMDATA: tmpRoot }, 'win32', repoRoot);
        expect(result).not.toBeNull();
        expect(result.source).toBe('seed');
        expect(result.path).toBe(seedNode);
    });

    it('on Linux, uses seed/node (no local-deps branch)', () => {
        const repoRoot = path.join(tmpRoot, 'repo');
        const seedNode = path.join(repoRoot, 'seed', 'node', 'node');
        fs.mkdirSync(path.dirname(seedNode), { recursive: true });
        fs.writeFileSync(seedNode, 'fake-seed');

        const result = resolveNodeBinary({}, 'linux', repoRoot);
        expect(result).not.toBeNull();
        expect(result.source).toBe('seed');
        expect(result.path).toBe(seedNode);
    });

    it('returns null when neither local-deps nor seed Node exists (no system-Node fallback)', () => {
        // Empty tmpRoot — no dataRoot, no seed
        const result = resolveNodeBinary({ PROGRAMDATA: tmpRoot }, 'win32', tmpRoot);
        expect(result).toBeNull();
    });
});
