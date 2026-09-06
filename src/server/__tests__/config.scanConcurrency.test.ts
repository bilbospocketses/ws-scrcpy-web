import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import { DEFAULT_SCAN_CONCURRENCY, MAX_SCAN_CONCURRENCY } from '../fdBudget';

/**
 * `scanConcurrency` is the one knob that can spend the process's whole
 * file-descriptor budget (fdBudget.ts). It accepted any number at all; now it
 * is capped, at the single site where env, config.json and the store are
 * merged, so every source is covered.
 */
const tmpDirs: string[] = [];
const saved = {
    CONFIG: process.env[EnvName.CONFIG_PATH],
    DEPS: process.env['DEPS_PATH'],
    SCAN: process.env['SCAN_CONCURRENCY'],
};

function setup(initialConfig: Record<string, unknown> = {}): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cfg-scan-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webPort: 8000, ...initialConfig }));
    process.env[EnvName.CONFIG_PATH] = path.join(dir, 'config.json');
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    Config._resetForTest();
}

afterEach(() => {
    Config._resetForTest();
    if (saved.CONFIG === undefined) delete process.env[EnvName.CONFIG_PATH];
    else process.env[EnvName.CONFIG_PATH] = saved.CONFIG;
    if (saved.DEPS === undefined) delete process.env['DEPS_PATH'];
    else process.env['DEPS_PATH'] = saved.DEPS;
    if (saved.SCAN === undefined) delete process.env['SCAN_CONCURRENCY'];
    else process.env['SCAN_CONCURRENCY'] = saved.SCAN;
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('Config.scanConcurrency', () => {
    it('defaults when nothing sets it', () => {
        delete process.env['SCAN_CONCURRENCY'];
        setup();
        expect(Config.getInstance().scanConcurrency).toBe(DEFAULT_SCAN_CONCURRENCY);
    });

    it('honours an in-range SCAN_CONCURRENCY', () => {
        process.env['SCAN_CONCURRENCY'] = '128';
        setup();
        expect(Config.getInstance().scanConcurrency).toBe(128);
    });

    it('caps SCAN_CONCURRENCY at the budget ceiling', () => {
        process.env['SCAN_CONCURRENCY'] = '100000';
        setup();
        expect(Config.getInstance().scanConcurrency).toBe(MAX_SCAN_CONCURRENCY);
    });

    it('caps a config.json scanConcurrency the same way', () => {
        delete process.env['SCAN_CONCURRENCY'];
        setup({ scanConcurrency: MAX_SCAN_CONCURRENCY * 10 });
        expect(Config.getInstance().scanConcurrency).toBe(MAX_SCAN_CONCURRENCY);
    });

    it('falls back to the default for a value that is not a number', () => {
        process.env['SCAN_CONCURRENCY'] = 'lots';
        setup();
        expect(Config.getInstance().scanConcurrency).toBe(DEFAULT_SCAN_CONCURRENCY);
    });
});
