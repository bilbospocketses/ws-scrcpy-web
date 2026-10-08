import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// The REAL client store: whether the Settings dialog can send an unchanged
// channel is decided there, so the "no pick without a change" test runs it.
import { StagedSettingsStore } from '../../app/client/settings/StagedSettingsStore';
import { ConfigApi } from '../api/ConfigApi';
import { SettingsBatchApi } from '../api/SettingsBatchApi';
import { getAppVersion } from '../appVersion';
import { Config, ConfigValidationError } from '../Config';
import { CHANNEL_PICKED_KEY, GLOBAL_KEYS } from '../db/constants';
import { EnvName } from '../EnvName';
import { makeReqRes } from './helpers/httpMock';

/**
 * "Remember who picked it" (2026-10-08). v0.1.30-beta.205 installed over a data
 * folder kept from an earlier install came up on the STABLE channel: the
 * `app_settings` row from that install said `stable`, and a stored row could not
 * be told apart from a deliberate pick. A channel written through
 * `updateAppConfig` now records CHANNEL_PICKED_KEY beside it, and at load an
 * unmarked `stable` row is ignored -- the channel follows the build.
 */

vi.mock('../appVersion', async (importOriginal) => {
    const real = await importOriginal<typeof import('../appVersion')>();
    return { getAppVersion: vi.fn(real.getAppVersion) };
});

const BETA_BUILD = '0.5.1-beta.3';
const STABLE_BUILD = '0.5.0';

const tmpDirs: string[] = [];
const saved = {
    CONFIG: process.env[EnvName.CONFIG_PATH],
    DEPS: process.env['DEPS_PATH'],
    DATA_ROOT: process.env['DATA_ROOT'],
};

function restore(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(getAppVersion).mockReset();
    Config._resetForTest();
    restore(EnvName.CONFIG_PATH, saved.CONFIG);
    restore('DEPS_PATH', saved.DEPS);
    restore('DATA_ROOT', saved.DATA_ROOT);
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/**
 * Boot `version` over a data folder whose `app_settings` holds `rows` and whose
 * config.json is `fileConfig`. The rows are seeded through a first load and
 * config.json is written AFTER it, so nothing that first load saves can strip
 * a `channel` the test put in the file.
 */
function bootOver(version: string, rows: Record<string, unknown>, fileConfig: Record<string, unknown> = {}): Config {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cfg-chpick-'));
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ webPort: 8000 }));
    process.env[EnvName.CONFIG_PATH] = configPath;
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    process.env['DATA_ROOT'] = dir;
    vi.mocked(getAppVersion).mockReturnValue(version);
    Config._resetForTest();
    const seed = Config.getInstance().db.appSettings;
    for (const [k, v] of Object.entries(rows)) seed.set(k, v);
    Config._resetForTest();
    fs.writeFileSync(configPath, JSON.stringify({ webPort: 8000, ...fileConfig }));
    return Config.getInstance();
}

/** Restart the app as `version` over the same data folder. */
function restartAs(version: string): Config {
    vi.mocked(getAppVersion).mockReturnValue(version);
    Config._resetForTest();
    return Config.getInstance();
}

function marker(cfg: Config = Config.getInstance()): unknown {
    return cfg.db.appSettings.get(CHANNEL_PICKED_KEY);
}

describe('the stored channel at load: honoured when picked, else the build decides', () => {
    it('beta build over an unmarked stable row (the 2026-10-08 report) is on beta', () => {
        const cfg = bootOver(BETA_BUILD, { channel: 'stable' });
        expect(cfg.getAppConfig().channel).toBe('beta');
    });

    it('stable build over an unmarked stable row is on stable', () => {
        const cfg = bootOver(STABLE_BUILD, { channel: 'stable' });
        expect(cfg.getAppConfig().channel).toBe('stable');
    });

    it('an unmarked beta row is honoured on a beta build and on a stable build', () => {
        // Only a pick or keepChannelAcrossApply ever wrote `beta`; v0.5.0's
        // keepChannelAcrossApply wrote it with no marker, and that install must
        // stay on beta after taking a stable release.
        expect(bootOver(BETA_BUILD, { channel: 'beta' }).getAppConfig().channel).toBe('beta');
        expect(bootOver(STABLE_BUILD, { channel: 'beta' }).getAppConfig().channel).toBe('beta');
    });

    it('a stable row marked as picked wins on a beta build', () => {
        const cfg = bootOver(BETA_BUILD, { channel: 'stable', [CHANNEL_PICKED_KEY]: true });
        expect(cfg.getAppConfig().channel).toBe('stable');
    });

    it('a beta row marked as picked wins on a stable build', () => {
        const cfg = bootOver(STABLE_BUILD, { channel: 'beta', [CHANNEL_PICKED_KEY]: true });
        expect(cfg.getAppConfig().channel).toBe('beta');
    });

    it('a marker that is not literally true does not count as a pick', () => {
        const cfg = bootOver(BETA_BUILD, { channel: 'stable', [CHANNEL_PICKED_KEY]: 'yes' });
        expect(cfg.getAppConfig().channel).toBe('beta');
    });

    it('an unmarked stable row is ignored in favour of the build, not of config.json', () => {
        // A config.json from that earlier install can say stable too; the build decides.
        const cfg = bootOver(BETA_BUILD, { channel: 'stable' }, { channel: 'stable' });
        expect(cfg.getAppConfig().channel).toBe('beta');
    });

    it('with no row, config.json still names the channel, as before', () => {
        expect(bootOver(BETA_BUILD, {}, { channel: 'stable' }).getAppConfig().channel).toBe('stable');
        expect(bootOver(STABLE_BUILD, {}, { channel: 'beta' }).getAppConfig().channel).toBe('beta');
    });

    it('with no row and no config.json channel, the build decides, as before', () => {
        expect(bootOver(BETA_BUILD, {}).getAppConfig().channel).toBe('beta');
        expect(bootOver(STABLE_BUILD, {}).getAppConfig().channel).toBe('stable');
    });

    it('an invalid stored channel is ignored, as before', () => {
        expect(bootOver(BETA_BUILD, { channel: 'nightly', [CHANNEL_PICKED_KEY]: true }).getAppConfig().channel).toBe(
            'beta',
        );
    });

    it('loading never rewrites the rows: the rule is applied on read', () => {
        const cfg = bootOver(BETA_BUILD, { channel: 'stable' });
        expect(cfg.getAppConfig().channel).toBe('beta');
        expect(cfg.db.appSettings.get('channel')).toBe('stable');
        expect(marker(cfg)).toBeUndefined();
        // So the same data folder under a stable build is still on stable.
        expect(restartAs(STABLE_BUILD).getAppConfig().channel).toBe('stable');
    });
});

describe('a channel write records the pick', () => {
    it('updateAppConfig writes the channel row and the marker, and a beta build then boots on the picked stable', () => {
        const cfg = bootOver(BETA_BUILD, {});
        expect(cfg.getAppConfig().channel).toBe('beta');
        cfg.updateAppConfig({ channel: 'stable' });
        expect(cfg.db.appSettings.get('channel')).toBe('stable');
        expect(marker(cfg)).toBe(true);
        expect(restartAs(BETA_BUILD).getAppConfig().channel).toBe('stable');
    });

    it('a write that does not name the channel writes no marker', () => {
        const cfg = bootOver(BETA_BUILD, { channel: 'stable' });
        cfg.updateAppConfig({ autoUpdate: false, updateCheckIntervalMinutes: 90 });
        expect(marker(cfg)).toBeUndefined();
        expect(restartAs(BETA_BUILD).getAppConfig().channel).toBe('beta');
    });

    it('PATCH /api/config with a channel writes the marker', async () => {
        bootOver(BETA_BUILD, { channel: 'stable' });
        const r = makeReqRes('PATCH', '/api/config', { channel: 'stable' }, {}, { remoteAddress: '127.0.0.1' });
        expect(await new ConfigApi().handle(r.req, r.res)).toBe(true);
        expect(r.getStatus()).toBe(200);
        expect(marker()).toBe(true);
        expect(restartAs(BETA_BUILD).getAppConfig().channel).toBe('stable');
    });

    it('the Settings Save sends a changed channel, and the batch records the pick', async () => {
        const cfg = bootOver(BETA_BUILD, { channel: 'stable' });
        const store = new StagedSettingsStore();
        store.register({ id: 'channel', label: 'Update channel', initial: cfg.getAppConfig().channel });
        store.set('channel', 'stable');
        const r = makeReqRes(
            'POST',
            '/api/settings/batch',
            { changes: store.changes() },
            {},
            { remoteAddress: '127.0.0.1' },
        );
        await new SettingsBatchApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(200);
        expect(marker()).toBe(true);
        expect(restartAs(BETA_BUILD).getAppConfig().channel).toBe('stable');
    });

    it('the Settings dialog never sends an unchanged channel, so re-selecting the loaded radio picks nothing', () => {
        // The tab's baseline is the EFFECTIVE channel (/api/updates/status), so
        // on the reported install the radio loads as beta. Clicking beta, or
        // stable and then beta again, leaves nothing to save.
        const cfg = bootOver(BETA_BUILD, { channel: 'stable' });
        const store = new StagedSettingsStore();
        store.register({ id: 'channel', label: 'Update channel', initial: cfg.getAppConfig().channel });
        store.set('channel', 'beta');
        expect(store.changes()).toEqual([]);
        store.set('channel', 'stable');
        store.set('channel', 'beta');
        expect(store.changes()).toEqual([]);
        expect(marker(cfg)).toBeUndefined();
    });
});

describe("the marker is the server's to write, never a client's", () => {
    it('is not a GLOBAL_KEYS entry, so no config write routes it to app_settings', () => {
        expect((GLOBAL_KEYS as readonly string[]).includes(CHANNEL_PICKED_KEY)).toBe(false);
    });

    it('updateAppConfig refuses it as an unknown key and stores nothing', () => {
        const cfg = bootOver(BETA_BUILD, { channel: 'stable' });
        expect(() => cfg.updateAppConfig({ [CHANNEL_PICKED_KEY]: true } as never)).toThrow(ConfigValidationError);
        expect(marker(cfg)).toBeUndefined();
        expect(restartAs(BETA_BUILD).getAppConfig().channel).toBe('beta');
    });

    it('PATCH /api/config with it is a 400 and stores nothing', async () => {
        bootOver(BETA_BUILD, { channel: 'stable' });
        const r = makeReqRes(
            'PATCH',
            '/api/config',
            { [CHANNEL_PICKED_KEY]: true },
            {},
            { remoteAddress: '127.0.0.1' },
        );
        expect(await new ConfigApi().handle(r.req, r.res)).toBe(true);
        expect(r.getStatus()).toBe(400);
        expect(marker()).toBeUndefined();
    });

    it('a Settings batch naming it is refused and stores nothing', async () => {
        bootOver(BETA_BUILD, { channel: 'stable' });
        const r = makeReqRes(
            'POST',
            '/api/settings/batch',
            { changes: [{ id: CHANNEL_PICKED_KEY, label: 'x', from: false, to: true }] },
            {},
            { remoteAddress: '127.0.0.1' },
        );
        await new SettingsBatchApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(400);
        expect(marker()).toBeUndefined();
    });
});
