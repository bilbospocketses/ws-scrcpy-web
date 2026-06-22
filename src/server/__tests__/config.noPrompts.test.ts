import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { Config } from '../Config';
import { EnvName } from '../EnvName';

/**
 * Task 6: getAppConfig() must NOT expose the three per-user prompt-dismissal
 * flags. These moved to user_settings and are served via GET /api/settings
 * (SettingsApi). /api/config no longer carries or accepts them.
 */

const tmpDirs: string[] = [];
const saved = { CONFIG: process.env[EnvName.CONFIG_PATH], DEPS: process.env['DEPS_PATH'] };

function setup(initial: unknown): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cfg-noprompts-'));
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(initial));
    process.env[EnvName.CONFIG_PATH] = configPath;
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    Config._resetForTest();
}

afterEach(() => {
    Config._resetForTest();
    if (saved.CONFIG === undefined) delete process.env[EnvName.CONFIG_PATH];
    else process.env[EnvName.CONFIG_PATH] = saved.CONFIG;
    if (saved.DEPS === undefined) delete process.env['DEPS_PATH'];
    else process.env['DEPS_PATH'] = saved.DEPS;
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('getAppConfig() does not expose prompt-dismissal flags (Task 6)', () => {
    it('bookmarkDismissedForPort is absent from AppConfig even when present in config.json', () => {
        setup({ bookmarkDismissedForPort: 9090 });
        const cfg = Config.getInstance().getAppConfig();
        expect('bookmarkDismissedForPort' in cfg).toBe(false);
    });

    it('bookmarkDismissedGlobally is absent from AppConfig even when present in config.json', () => {
        setup({ bookmarkDismissedGlobally: true });
        const cfg = Config.getInstance().getAppConfig();
        expect('bookmarkDismissedGlobally' in cfg).toBe(false);
    });

    it('serviceFirstRunSeen is absent from AppConfig even when present in config.json', () => {
        setup({ serviceFirstRunSeen: true });
        const cfg = Config.getInstance().getAppConfig();
        expect('serviceFirstRunSeen' in cfg).toBe(false);
    });

    it('updateAppConfig rejects bookmarkDismissedForPort (unknown to /api/config now)', () => {
        setup({});
        const cfg = Config.getInstance();
        expect(() => cfg.updateAppConfig(JSON.parse('{"bookmarkDismissedForPort":8000}'))).toThrow();
    });

    it('updateAppConfig rejects bookmarkDismissedGlobally', () => {
        setup({});
        const cfg = Config.getInstance();
        expect(() => cfg.updateAppConfig(JSON.parse('{"bookmarkDismissedGlobally":true}'))).toThrow();
    });

    it('updateAppConfig rejects serviceFirstRunSeen', () => {
        setup({});
        const cfg = Config.getInstance();
        expect(() => cfg.updateAppConfig(JSON.parse('{"serviceFirstRunSeen":true}'))).toThrow();
    });
});
