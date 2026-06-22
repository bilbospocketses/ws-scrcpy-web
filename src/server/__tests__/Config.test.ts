import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_CONFIG_DEFAULTS } from '../../common/ConfigEvents';
import { Config, ConfigValidationError } from '../Config';
import { EnvName } from '../EnvName';

describe('Config — AppConfig extension', () => {
    const tmpDirs: string[] = [];
    const savedEnv = {
        CONFIG: process.env[EnvName.CONFIG_PATH],
        DEPS: process.env['DEPS_PATH'],
        PORT: process.env['PORT'],
    };

    afterEach(() => {
        Config._resetForTest();
        if (savedEnv.CONFIG === undefined) delete process.env[EnvName.CONFIG_PATH];
        else process.env[EnvName.CONFIG_PATH] = savedEnv.CONFIG;
        if (savedEnv.DEPS === undefined) delete process.env['DEPS_PATH'];
        else process.env['DEPS_PATH'] = savedEnv.DEPS;
        if (savedEnv.PORT === undefined) delete process.env['PORT'];
        else process.env['PORT'] = savedEnv.PORT;
        while (tmpDirs.length) {
            const d = tmpDirs.pop()!;
            try {
                fs.rmSync(d, { recursive: true, force: true });
            } catch {
                /* best-effort cleanup */
            }
        }
    });

    /**
     * Set up a fresh isolated env for a single test.
     * Each call writes the given config object and returns the configPath
     * that env CONFIG_PATH is now pointing at.
     */
    function setup(initialConfig: unknown = {}): string {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cfg-app-'));
        tmpDirs.push(tmpRoot);
        const configPath = path.join(tmpRoot, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify(initialConfig));
        process.env[EnvName.CONFIG_PATH] = configPath;
        process.env['DEPS_PATH'] = path.join(tmpRoot, 'deps');
        delete process.env['PORT'];
        Config._resetForTest();
        return configPath;
    }

    it('returns full defaults when config.json contains an empty object', () => {
        setup({});
        const c = Config.getInstance().getAppConfig();
        expect(c).toEqual(APP_CONFIG_DEFAULTS);
    });

    it('migrates legacy `port` → `webPort` (now persisted via the config trim)', () => {
        const configPath = setup({ port: 8123 });
        const c = Config.getInstance().getAppConfig();
        expect(c.webPort).toBe(8123);
        // Phase 1: the one-time import trims config.json — the legacy `port`
        // alias is folded into `webPort` (the boot trio) and the old key is gone.
        const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        expect(after.webPort).toBe(8123);
        expect(after.port).toBeUndefined();
    });

    it('falls back to default for an out-of-range webPort', () => {
        setup({ webPort: 80 });
        const c = Config.getInstance().getAppConfig();
        expect(c.webPort).toBe(APP_CONFIG_DEFAULTS.webPort);
    });

    it('rejects invalid channel and falls back to stable', () => {
        setup({ channel: 'nightly' });
        const c = Config.getInstance().getAppConfig();
        expect(c.channel).toBe('stable');
    });

    it('updateAppConfig writes pretty JSON with trailing newline', () => {
        const configPath = setup({});
        const cfg = Config.getInstance();
        cfg.updateAppConfig({ firstRunComplete: true, autoUpdate: false });
        const text = fs.readFileSync(configPath, 'utf-8');
        expect(text.endsWith('\n')).toBe(true);
        expect(text).toContain('  "firstRunComplete": true');
        const parsed = JSON.parse(text);
        expect(parsed.firstRunComplete).toBe(true);
        // autoUpdate is a global now → persisted to the SQLite store, not config.json.
        expect(parsed.autoUpdate).toBeUndefined();
        expect(cfg.getAppConfig().autoUpdate).toBe(false);
    });

    it('updateAppConfig sets restartRequired when webPort changes', () => {
        setup({ webPort: 8000 });
        const cfg = Config.getInstance();
        const r = cfg.updateAppConfig({ webPort: 8001 });
        expect(r.restartRequired).toBe(true);
        expect(r.config.webPort).toBe(8001);
    });

    it('updateAppConfig leaves restartRequired false for other fields', () => {
        setup({});
        const cfg = Config.getInstance();
        const r = cfg.updateAppConfig({ channel: 'beta', githubOwner: 'someoneelse' });
        expect(r.restartRequired).toBe(false);
        expect(r.config.channel).toBe('beta');
    });

    it('updateAppConfig throws ConfigValidationError on invalid channel', () => {
        setup({});
        const cfg = Config.getInstance();
        expect(() => cfg.updateAppConfig({ channel: 'nightly' as 'stable' })).toThrow(ConfigValidationError);
    });

    it('updateAppConfig rejects an unknown config key (no arbitrary persistence)', () => {
        setup({});
        const cfg = Config.getInstance();
        expect(() => cfg.updateAppConfig(JSON.parse('{"bogusKey":1}'))).toThrow(ConfigValidationError);
    });

    it('updateAppConfig rejects prototype-pollution keys', () => {
        setup({});
        const cfg = Config.getInstance();
        for (const key of ['__proto__', 'constructor', 'prototype']) {
            expect(() => cfg.updateAppConfig(JSON.parse(`{"${key}":{"x":1}}`))).toThrow(ConfigValidationError);
        }
        // global prototype untouched
        expect(({} as Record<string, unknown>)['x']).toBeUndefined();
    });

    it('updateAppConfig throws ConfigValidationError on out-of-range interval', () => {
        setup({});
        const cfg = Config.getInstance();
        expect(() => cfg.updateAppConfig({ updateCheckIntervalMinutes: 1 })).toThrow(/5/);
    });

    it('setActualWebPort persists shifted port and flips flag', () => {
        const configPath = setup({ webPort: 8000 });
        const cfg = Config.getInstance();
        cfg.setActualWebPort(8001);
        const status = cfg.getFirstRunStatus();
        expect(status.portWasAutoShifted).toBe(true);
        expect(status.webPort).toBe(8001);
        const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        expect(onDisk.webPort).toBe(8001);
    });

    it('setActualWebPort with same port leaves portWasAutoShifted=false and does not rewrite file', () => {
        const configPath = setup({ webPort: 8000 });
        const cfg = Config.getInstance();
        // Capture AFTER getInstance — the one-time import trims config.json on open.
        const before = fs.readFileSync(configPath, 'utf-8');
        cfg.setActualWebPort(8000);
        const status = cfg.getFirstRunStatus();
        expect(status.portWasAutoShifted).toBe(false);
        expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
    });

    it('round-trips installMode through PATCH', () => {
        const configPath = setup({});
        const cfg = Config.getInstance();
        cfg.updateAppConfig({ installMode: 'user-service' });
        const reread = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        expect(reread.installMode).toBe('user-service');
    });

    it('rejects invalid installMode in PATCH', () => {
        setup({});
        const cfg = Config.getInstance();
        expect(() => cfg.updateAppConfig({ installMode: 'bogus' as 'user' })).toThrow(ConfigValidationError);
    });

    it('uninstallPendingMarkerPath returns <base>/control/uninstall-pending', () => {
        setup({});
        const cfg = Config.getInstance();
        const base = cfg.dataRoot ?? path.dirname(cfg.dependenciesPath);
        expect(cfg.uninstallPendingMarkerPath).toBe(path.join(base, 'control', 'uninstall-pending'));
    });
});
