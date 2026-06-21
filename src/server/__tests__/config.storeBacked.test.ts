import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Config } from '../Config';
import { EnvName } from '../EnvName';

// Uses the CONFIG_PATH + DEPS_PATH temp harness (NOT DATA_ROOT, which
// resolveDataRoot ignores on Windows). The DB co-locates with config.json
// (dbDir = dirname(configFilePath)), so each test is isolated in its own temp.
const tmpDirs: string[] = [];
const saved = { CONFIG: process.env[EnvName.CONFIG_PATH], DEPS: process.env['DEPS_PATH'] };

function setup(initial: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cfg-store-'));
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(initial));
    process.env[EnvName.CONFIG_PATH] = configPath;
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    Config._resetForTest();
    return configPath;
}

afterEach(() => {
    Config._resetForTest();
    if (saved.CONFIG === undefined) delete process.env[EnvName.CONFIG_PATH];
    else process.env[EnvName.CONFIG_PATH] = saved.CONFIG;
    if (saved.DEPS === undefined) delete process.env['DEPS_PATH'];
    else process.env['DEPS_PATH'] = saved.DEPS;
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('Config store-backed composition', () => {
    it('composes AppConfig from the JSON trio + app_settings + user-1 prompts', () => {
        setup({
            webPort: 8200,
            installMode: 'user',
            firstRunComplete: true,
            channel: 'beta',
            bookmarkDismissedGlobally: true,
        });
        const cfg = Config.getInstance().getAppConfig();
        expect(cfg.webPort).toBe(8200); // trio (config.json)
        expect(cfg.installMode).toBe('user'); // trio (config.json)
        expect(cfg.channel).toBe('beta'); // global → app_settings (imported)
        expect(cfg.bookmarkDismissedGlobally).toBe(true); // prompt → user-1 (imported)
    });

    it('updateAppConfig routes fields to the right store and keeps config.json trio-only', () => {
        const configPath = setup({ webPort: 8200, installMode: 'user', firstRunComplete: false });
        const c = Config.getInstance();
        c.updateAppConfig({ channel: 'stable', firstRunComplete: true, bookmarkDismissedGlobally: true });
        // config.json holds ONLY the trio (channel + bookmark went to the DB).
        const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        expect(Object.keys(onDisk).sort()).toEqual(['firstRunComplete', 'installMode', 'webPort']);
        expect(onDisk.firstRunComplete).toBe(true);
        // Re-read composes the global + prompt back from the stores.
        Config._resetForTest();
        const cfg2 = Config.getInstance().getAppConfig();
        expect(cfg2.channel).toBe('stable');
        expect(cfg2.bookmarkDismissedGlobally).toBe(true);
    });

    it('preserves server-only boot fields (allowedHosts) across the trim and a save', () => {
        const configPath = setup({
            webPort: 8200,
            installMode: 'user',
            firstRunComplete: false,
            allowedHosts: ['proxy.example.com'],
        });
        const c = Config.getInstance();
        expect(c.allowedHosts).toEqual(['proxy.example.com']);
        // Still on disk after the import trim + a settings save (saveToDisk re-merges it).
        c.updateAppConfig({ firstRunComplete: true });
        const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        expect(onDisk.allowedHosts).toEqual(['proxy.example.com']);
        expect(onDisk.webPort).toBe(8200);
    });

    it('rejects an out-of-range stored global and keeps the default (compose validation)', () => {
        // updateCheckIntervalMinutes is a validated global; an out-of-range stored
        // value must fall back to the default rather than surfacing the bad value.
        setup({ webPort: 8200, installMode: 'user', firstRunComplete: false, updateCheckIntervalMinutes: 1 });
        const cfg = Config.getInstance().getAppConfig();
        expect(cfg.updateCheckIntervalMinutes).toBe(60);
    });
});
