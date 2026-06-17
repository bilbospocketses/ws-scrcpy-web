import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    DEFAULT_RELEASE_URL_BASE,
    readInstalledNodePtyVersion,
    resolveReleaseUrlBase,
} from '../fetch-prebuilts.mjs';

describe('resolveReleaseUrlBase', () => {
    it('uses the canonical GitHub URL when no override env is set', () => {
        const r = resolveReleaseUrlBase({});
        expect(r.base).toBe(DEFAULT_RELEASE_URL_BASE);
        expect(r.overridden).toBe(false);
        expect(r.ignoredOverride).toBe(false);
    });

    it('ignores WSSCRCPY_RELEASE_URL_BASE without the explicit opt-in', () => {
        const r = resolveReleaseUrlBase({
            WSSCRCPY_RELEASE_URL_BASE: 'https://evil.example/releases/download',
        });
        expect(r.base).toBe(DEFAULT_RELEASE_URL_BASE);
        expect(r.overridden).toBe(false);
        expect(r.ignoredOverride).toBe(true);
    });

    it('honors the override only when WSSCRCPY_ALLOW_RELEASE_URL_OVERRIDE=1', () => {
        const r = resolveReleaseUrlBase({
            WSSCRCPY_RELEASE_URL_BASE: 'https://mirror.internal/dl',
            WSSCRCPY_ALLOW_RELEASE_URL_OVERRIDE: '1',
        });
        expect(r.base).toBe('https://mirror.internal/dl');
        expect(r.overridden).toBe(true);
        expect(r.ignoredOverride).toBe(false);
    });

    it('treats any opt-in value other than "1" as not opted in', () => {
        const r = resolveReleaseUrlBase({
            WSSCRCPY_RELEASE_URL_BASE: 'https://mirror.internal/dl',
            WSSCRCPY_ALLOW_RELEASE_URL_OVERRIDE: 'true',
        });
        expect(r.base).toBe(DEFAULT_RELEASE_URL_BASE);
        expect(r.ignoredOverride).toBe(true);
    });

    it('does not treat the opt-in alone (no base set) as an override', () => {
        const r = resolveReleaseUrlBase({ WSSCRCPY_ALLOW_RELEASE_URL_OVERRIDE: '1' });
        expect(r.base).toBe(DEFAULT_RELEASE_URL_BASE);
        expect(r.overridden).toBe(false);
        expect(r.ignoredOverride).toBe(false);
    });
});

describe('readInstalledNodePtyVersion', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scrcpy-web-fetch-prebuilts-'));
    });

    afterEach(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
    });

    it('reads the version from <repoRoot>/node_modules/node-pty/package.json', () => {
        const pkgDir = path.join(tmpDir, 'node_modules', 'node-pty');
        fs.mkdirSync(pkgDir, { recursive: true });
        fs.writeFileSync(
            path.join(pkgDir, 'package.json'),
            JSON.stringify({ name: 'node-pty', version: '1.1.0' }),
        );
        expect(readInstalledNodePtyVersion(tmpDir)).toBe('1.1.0');
    });

    it('throws a clear error when node-pty is not installed', () => {
        expect(() => readInstalledNodePtyVersion(tmpDir)).toThrow(/node-pty/);
    });

    it('throws when the installed package.json has no version field', () => {
        const pkgDir = path.join(tmpDir, 'node_modules', 'node-pty');
        fs.mkdirSync(pkgDir, { recursive: true });
        fs.writeFileSync(
            path.join(pkgDir, 'package.json'),
            JSON.stringify({ name: 'node-pty' }),
        );
        expect(() => readInstalledNodePtyVersion(tmpDir)).toThrow(/version/);
    });
});
