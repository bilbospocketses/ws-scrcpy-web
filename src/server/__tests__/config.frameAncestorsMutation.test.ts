import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import { securityHeaders, setFrameAncestors } from '../security/frameGuard';

// Same temp harness as config.storeBacked.test.ts: CONFIG_PATH + DEPS_PATH, with the DB
// co-located beside config.json so each test is isolated.
const tmpDirs: string[] = [];
const saved = { CONFIG: process.env[EnvName.CONFIG_PATH], DEPS: process.env['DEPS_PATH'] };

function setup(initial: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cfg-frame-'));
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(initial));
    process.env[EnvName.CONFIG_PATH] = configPath;
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    Config._resetForTest();
    return configPath;
}

function readConfig(configPath: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

afterEach(() => {
    Config._resetForTest();
    setFrameAncestors([]);
    if (saved.CONFIG === undefined) delete process.env[EnvName.CONFIG_PATH];
    else process.env[EnvName.CONFIG_PATH] = saved.CONFIG;
    if (saved.DEPS === undefined) delete process.env['DEPS_PATH'];
    else process.env['DEPS_PATH'] = saved.DEPS;
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const BOOT = { webPort: 8200, installMode: 'user', firstRunComplete: true };

describe('Config frame-ancestor grant and revoke', () => {
    it('persists a granted origin without disturbing the other keys', () => {
        const configPath = setup({ ...BOOT, allowedHosts: ['devices.example.com'] });

        expect(Config.getInstance().addFrameAncestor('http://localhost:5159')).toBe(true);

        const written = readConfig(configPath);
        expect(written['frameAncestors']).toEqual(['http://localhost:5159']);
        // The whole file is rewritten, so every unrelated key has to survive — a user who loses
        // webPort here finds the server on a different port after the next restart.
        expect(written['webPort']).toBe(8200);
        expect(written['installMode']).toBe('user');
        expect(written['firstRunComplete']).toBe(true);
        expect(written['allowedHosts']).toEqual(['devices.example.com']);
    });

    it('applies a grant to the running server immediately', () => {
        setup(BOOT);
        Config.getInstance().addFrameAncestor('http://localhost:5159');

        // No restart: the very next response must carry the new policy.
        expect(securityHeaders()['Content-Security-Policy']).toBe("frame-ancestors 'self' http://localhost:5159");
    });

    it('revokes an origin, in the file and on the running server', () => {
        const configPath = setup({ ...BOOT, frameAncestors: ['http://localhost:5159', 'http://localhost:6000'] });

        expect(Config.getInstance().removeFrameAncestor('http://localhost:5159')).toBe(true);

        expect(readConfig(configPath)['frameAncestors']).toEqual(['http://localhost:6000']);
        expect(securityHeaders()['Content-Security-Policy']).toBe("frame-ancestors 'self' http://localhost:6000");
        expect(readConfig(configPath)['webPort']).toBe(8200);
    });

    it('drops the CSP entirely once the last origin is revoked', () => {
        setup({ ...BOOT, frameAncestors: ['http://localhost:5159'] });

        Config.getInstance().removeFrameAncestor('http://localhost:5159');

        // Back to the default same-origin-only policy, not an empty directive that allows nothing
        // meaningful but still advertises the feature.
        expect(securityHeaders()['Content-Security-Policy']).toBeUndefined();
        expect(securityHeaders()['X-Frame-Options']).toBe('SAMEORIGIN');
    });

    it('reports false for an origin that was never permitted', () => {
        setup({ ...BOOT, frameAncestors: ['http://localhost:5159'] });

        // A stale settings list must not be able to report a revocation that did not happen.
        expect(Config.getInstance().removeFrameAncestor('http://localhost:9999')).toBe(false);
        expect(Config.getInstance().frameAncestors).toEqual(['http://localhost:5159']);
    });

    it('normalises before matching, so a trailing slash still revokes', () => {
        setup({ ...BOOT, frameAncestors: ['http://localhost:5159'] });

        expect(Config.getInstance().removeFrameAncestor('http://localhost:5159/')).toBe(true);
        expect(Config.getInstance().frameAncestors).toEqual([]);
    });

    it('refuses to grant or revoke a value that is not a usable origin', () => {
        setup(BOOT);
        const config = Config.getInstance();

        expect(config.addFrameAncestor('*')).toBe(false);
        expect(config.addFrameAncestor('http://localhost:5159/embed')).toBe(false);
        expect(config.removeFrameAncestor('not a url')).toBe(false);
        expect(config.frameAncestors).toEqual([]);
    });

    it('does not duplicate an origin granted twice', () => {
        setup(BOOT);
        const config = Config.getInstance();

        config.addFrameAncestor('http://localhost:5159');
        config.addFrameAncestor('http://localhost:5159');

        expect(config.frameAncestors).toEqual(['http://localhost:5159']);
    });
});
