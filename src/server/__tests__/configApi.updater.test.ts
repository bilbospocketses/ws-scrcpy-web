import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigApi } from '../api/ConfigApi';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import { makeReqRes } from './helpers/httpMock';

/**
 * PATCH /api/config writes the updater's settings too (channel, interval,
 * owner, autoUpdate), and like the Settings dialog's Save it used to stop at
 * config.json: the RUNNING update service kept its old timer and channel until
 * the app restarted (6.11 follow-up). The service is a spy here, injected the
 * way index.ts hands in the live `UpdateService`.
 */

const tmpDirs: string[] = [];
const saved = {
    CONFIG: process.env[EnvName.CONFIG_PATH],
    DEPS: process.env['DEPS_PATH'],
    DATA_ROOT: process.env['DATA_ROOT'],
};

function setup(): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wscfgupd-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webPort: 8000 }));
    process.env[EnvName.CONFIG_PATH] = path.join(dir, 'config.json');
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    // A webPort change writes the `.restart` marker under the data root.
    process.env['DATA_ROOT'] = dir;
    Config._resetForTest();
}

function restore(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Config._resetForTest();
    restore(EnvName.CONFIG_PATH, saved.CONFIG);
    restore('DEPS_PATH', saved.DEPS);
    restore('DATA_ROOT', saved.DATA_ROOT);
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function fakeUpdater() {
    return {
        reconfigure: vi.fn(async (_channel: 'stable' | 'beta', _owner: string) => undefined),
        restartTimer: vi.fn((_minutes: number, _autoUpdate: boolean) => undefined),
    };
}

async function patch(body: Record<string, unknown>, updater: ReturnType<typeof fakeUpdater>) {
    const r = makeReqRes('PATCH', '/api/config', body, {}, { remoteAddress: '127.0.0.1' });
    expect(await new ConfigApi({ updater }).handle(r.req, r.res)).toBe(true);
    return r;
}

describe('PATCH /api/config — the running update service hears the write', () => {
    it('an interval change restarts the timer at the new interval', async () => {
        setup();
        const before = Config.getInstance().getAppConfig();
        const to = before.updateCheckIntervalMinutes === 90 ? 120 : 90;
        const updater = fakeUpdater();
        const r = await patch({ updateCheckIntervalMinutes: to }, updater);
        expect(r.getStatus()).toBe(200);
        expect(updater.restartTimer).toHaveBeenCalledTimes(1);
        expect(updater.restartTimer).toHaveBeenCalledWith(to, before.autoUpdate);
        expect(updater.reconfigure).not.toHaveBeenCalled();
    });

    it('a channel change reconfigures the service onto the new channel', async () => {
        setup();
        const before = Config.getInstance().getAppConfig();
        const to = before.channel === 'beta' ? 'stable' : 'beta';
        const updater = fakeUpdater();
        const r = await patch({ channel: to }, updater);
        expect(r.getStatus()).toBe(200);
        expect(updater.reconfigure).toHaveBeenCalledTimes(1);
        expect(updater.reconfigure).toHaveBeenCalledWith(to, before.githubOwner);
        expect(updater.restartTimer).not.toHaveBeenCalled();
    });

    it('a write that moves no updater setting touches neither', async () => {
        setup();
        const before = Config.getInstance().getAppConfig();
        const updater = fakeUpdater();
        // A non-updater field, autoUpdate (read at every check), and the current
        // interval re-stated: none of them is a change the service must hear.
        const r = await patch(
            {
                firstRunComplete: true,
                autoUpdate: !before.autoUpdate,
                updateCheckIntervalMinutes: before.updateCheckIntervalMinutes,
            },
            updater,
        );
        expect(r.getStatus()).toBe(200);
        expect(updater.reconfigure).not.toHaveBeenCalled();
        expect(updater.restartTimer).not.toHaveBeenCalled();
    });

    it('a write that also moves the port leaves the updater alone — the process is about to restart', async () => {
        setup();
        // The handler schedules process.exit(75) one second after answering:
        // fake the timer so it never fires, and stub exit in case it does
        // (as configApi.redirectPort.test.ts does).
        vi.useFakeTimers({ toFake: ['setTimeout'] });
        vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
        const before = Config.getInstance().getAppConfig();
        const updater = fakeUpdater();
        const r = await patch(
            { webPort: 8011, updateCheckIntervalMinutes: before.updateCheckIntervalMinutes === 90 ? 120 : 90 },
            updater,
        );
        expect(r.getStatus()).toBe(200);
        expect((r.getJson() as { restartRequired: boolean }).restartRequired).toBe(true);
        expect(updater.restartTimer).not.toHaveBeenCalled();
        expect(updater.reconfigure).not.toHaveBeenCalled();
    });

    it('a rejected write tells the service nothing', async () => {
        setup();
        const updater = fakeUpdater();
        const r = await patch({ channel: 'nightly' }, updater);
        expect(r.getStatus()).toBe(400);
        expect(updater.reconfigure).not.toHaveBeenCalled();
        expect(updater.restartTimer).not.toHaveBeenCalled();
    });
});
