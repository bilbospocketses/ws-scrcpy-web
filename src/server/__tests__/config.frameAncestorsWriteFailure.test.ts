import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import { securityHeaders, setFrameAncestors } from '../security/frameGuard';

/**
 * A config.json write that fails must leave the live framing policy, the
 * in-memory list and the file exactly as they were (0.5.3 review, M5). Every
 * path that changes `frameAncestors` goes through one helper
 * (`applyAndPersistFrameAncestors`), so each caller is covered here: the
 * settings batch's `addFrameAncestors`, the consent prompt's
 * `addFrameAncestor` and the revoke route's `removeFrameAncestor`.
 *
 * The write is failed by wrapping the real `writeFileAtomicSync`: losing a disk
 * write on demand is not something a test can arrange, and failing the only
 * call that reaches the disk is the same failure as far as Config can tell.
 */
const failWrite = vi.hoisted(() => ({ on: false }));

vi.mock('../util/atomicFile', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../util/atomicFile')>();
    return {
        ...actual,
        writeFileAtomicSync: (...args: Parameters<typeof actual.writeFileAtomicSync>) => {
            if (failWrite.on) {
                throw Object.assign(new Error('EACCES: permission denied, rename'), { code: 'EACCES' });
            }
            actual.writeFileAtomicSync(...args);
        },
    };
});

const tmpDirs: string[] = [];
const saved = { CONFIG: process.env[EnvName.CONFIG_PATH], DEPS: process.env['DEPS_PATH'] };

function setup(initial: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cfg-frame-fail-'));
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(initial));
    process.env[EnvName.CONFIG_PATH] = configPath;
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    Config._resetForTest();
    return configPath;
}

afterEach(() => {
    failWrite.on = false;
    Config._resetForTest();
    setFrameAncestors([]);
    if (saved.CONFIG === undefined) delete process.env[EnvName.CONFIG_PATH];
    else process.env[EnvName.CONFIG_PATH] = saved.CONFIG;
    if (saved.DEPS === undefined) delete process.env['DEPS_PATH'];
    else process.env['DEPS_PATH'] = saved.DEPS;
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const BOOT = { webPort: 8200, installMode: 'user', firstRunComplete: true };
const BEFORE = ['http://localhost:5159'];
const BEFORE_CSP = "frame-ancestors 'self' http://localhost:5159";

describe('a failed config.json write leaves frameAncestors as it was', () => {
    function boot(): { cfg: Config; configPath: string; fileBefore: string } {
        const configPath = setup({ ...BOOT, frameAncestors: BEFORE });
        const cfg = Config.getInstance();
        // Booting applies the list to the live policy, as index.ts does.
        setFrameAncestors(cfg.frameAncestors);
        expect(securityHeaders()['Content-Security-Policy']).toBe(BEFORE_CSP);
        return { cfg, configPath, fileBefore: fs.readFileSync(configPath, 'utf-8') };
    }

    it('addFrameAncestors (the settings batch) rolls back the live policy and the list, then rethrows', () => {
        const { cfg, configPath, fileBefore } = boot();
        failWrite.on = true;

        expect(() => cfg.addFrameAncestors(['http://localhost:6000', 'https://tools.example'])).toThrow(/EACCES/);

        expect(cfg.frameAncestors).toEqual(BEFORE);
        expect(securityHeaders()['Content-Security-Policy']).toBe(BEFORE_CSP);
        expect(fs.readFileSync(configPath, 'utf-8')).toBe(fileBefore);
    });

    it('addFrameAncestor (the consent prompt) rolls back too', () => {
        const { cfg, configPath, fileBefore } = boot();
        failWrite.on = true;

        expect(() => cfg.addFrameAncestor('http://localhost:6000')).toThrow(/EACCES/);

        expect(cfg.frameAncestors).toEqual(BEFORE);
        expect(securityHeaders()['Content-Security-Policy']).toBe(BEFORE_CSP);
        expect(fs.readFileSync(configPath, 'utf-8')).toBe(fileBefore);
    });

    it('removeFrameAncestor (revoke) rolls back too, so a failed revoke is not half-applied', () => {
        const { cfg, configPath, fileBefore } = boot();
        failWrite.on = true;

        expect(() => cfg.removeFrameAncestor('http://localhost:5159')).toThrow(/EACCES/);

        expect(cfg.frameAncestors).toEqual(BEFORE);
        expect(securityHeaders()['Content-Security-Policy']).toBe(BEFORE_CSP);
        expect(fs.readFileSync(configPath, 'utf-8')).toBe(fileBefore);
    });

    it('keeps the list the getter handed out (rolled back in place, not replaced)', () => {
        const { cfg } = boot();
        const held = cfg.frameAncestors;
        failWrite.on = true;

        expect(() => cfg.addFrameAncestor('http://localhost:6000')).toThrow();

        expect(held).toEqual(BEFORE);
        expect(cfg.frameAncestors).toBe(held);
    });

    it('applies and persists normally once the write works again', () => {
        const { cfg, configPath } = boot();
        failWrite.on = true;
        expect(() => cfg.addFrameAncestors(['http://localhost:6000'])).toThrow();
        failWrite.on = false;

        expect(cfg.addFrameAncestors(['http://localhost:6000'])).toBe(true);

        expect(cfg.frameAncestors).toEqual(['http://localhost:5159', 'http://localhost:6000']);
        expect(securityHeaders()['Content-Security-Policy']).toBe(
            "frame-ancestors 'self' http://localhost:5159 http://localhost:6000",
        );
        expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))['frameAncestors']).toEqual([
            'http://localhost:5159',
            'http://localhost:6000',
        ]);
    });
});
