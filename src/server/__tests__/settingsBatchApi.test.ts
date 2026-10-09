import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// The REAL client store, imported into a server test on purpose: this file is
// where the two halves of the `Change` contract are made to meet. It is pure
// state with no DOM and no network, so it runs here unchanged.
import { type BatchResult, runSave } from '../../app/client/settings/SaveRunner';
import { StagedSettingsStore } from '../../app/client/settings/StagedSettingsStore';
import { SettingsApi } from '../api/SettingsApi';
import { orderChanges, SettingsBatchApi, type SettingsBatchApiOptions, STAGEABLE_IDS } from '../api/SettingsBatchApi';
import { Config } from '../Config';
import type { Change } from '../db/PendingSettingsStore';
import { reconcilePendingSettings } from '../db/reconcilePendingSettings';
import { EnvName } from '../EnvName';
import { makeReqRes } from './helpers/httpMock';

const tmpDirs: string[] = [];
const saved = {
    CONFIG: process.env[EnvName.CONFIG_PATH],
    DEPS: process.env['DEPS_PATH'],
    DATA_ROOT: process.env['DATA_ROOT'],
};

/**
 * Returns the temp dir so webPort tests can check the `.restart` marker.
 * DATA_ROOT is set here (matching configApi.redirectPort.test.ts) because
 * Config.restartMarkerPath resolves under it -- without this, a webPort
 * batch would write `.restart` under the machine's real ProgramData root.
 */
function setup(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsbatch-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webPort: 8000 }));
    process.env[EnvName.CONFIG_PATH] = path.join(dir, 'config.json');
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    process.env['DATA_ROOT'] = dir;
    Config._resetForTest();
    return dir;
}

afterEach(() => {
    vi.restoreAllMocks();
    // The BatchResult boundary block stubs `fetch`; a no-op for every other test.
    vi.unstubAllGlobals();
    Config._resetForTest();
    if (saved.CONFIG === undefined) delete process.env[EnvName.CONFIG_PATH];
    else process.env[EnvName.CONFIG_PATH] = saved.CONFIG;
    if (saved.DEPS === undefined) delete process.env['DEPS_PATH'];
    else process.env['DEPS_PATH'] = saved.DEPS;
    if (saved.DATA_ROOT === undefined) delete process.env['DATA_ROOT'];
    else process.env['DATA_ROOT'] = saved.DATA_ROOT;
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const LOOPBACK = { remoteAddress: '127.0.0.1' };

describe('orderChanges', () => {
    it('puts webPort last — it is the only change that ends the process', () => {
        const ordered = orderChanges([
            { id: 'webPort', label: 'Web port', from: 8000, to: 8010 },
            { id: 'channel', label: 'Channel', from: 'stable', to: 'beta' },
        ]);
        expect(ordered.map((c) => c.id)).toEqual(['channel', 'webPort']);
    });

    it('leaves a batch without webPort in its original order', () => {
        const ordered = orderChanges([
            { id: 'channel', label: 'Channel', from: 'stable', to: 'beta' },
            { id: 'autoUpdate', label: 'Auto update', from: true, to: false },
        ]);
        expect(ordered.map((c) => c.id)).toEqual(['channel', 'autoUpdate']);
    });
});

describe('STAGEABLE_IDS', () => {
    it('contains only settings, never actions', () => {
        expect(STAGEABLE_IDS.has('webPort')).toBe(true);
        expect(STAGEABLE_IDS.has('channel')).toBe(true);
        // The Updates tab registers this one and Save sends it; an allowlist
        // that omitted it would refuse the whole batch with a 400 the moment
        // anyone edited the github-owner row.
        expect(STAGEABLE_IDS.has('githubOwner')).toBe(true);
        // Actions must never be stageable: they fire UAC, delete users, etc.
        expect(STAGEABLE_IDS.has('installService')).toBe(false);
        expect(STAGEABLE_IDS.has('deleteUser')).toBe(false);
    });
});

describe('POST /api/settings/batch through the server handler chain', () => {
    // src/server/index.ts registers SettingsApi BEFORE SettingsBatchApi, and
    // HttpServer asks each handler in turn until one claims the request. SettingsApi
    // used to claim every /api/settings* URL and answer 404 for a path it did not
    // know, so the batch route was never reached and the Settings dialog's Save
    // 404'd on every install (found 2026-09-30 by the container tier's row 20.18).
    // Every other test here calls SettingsBatchApi directly, which is why none saw it.
    it('is answered by SettingsBatchApi, not swallowed by SettingsApi', async () => {
        setup();
        const r = makeReqRes(
            'POST',
            '/api/settings/batch',
            { changes: [{ id: 'autoUpdate', from: true, to: false }] },
            {},
            LOOPBACK,
        );
        const chain = [new SettingsApi(), new SettingsBatchApi()];
        for (const handler of chain) {
            if (await handler.handle(r.req, r.res)) break;
        }
        expect(r.getStatus()).toBe(200);
        expect((r.getJson() as { applied: string[] }).applied).toEqual(['autoUpdate']);
    });
});

describe('POST /api/settings/batch', () => {
    it('records the batch and reports what it applied', async () => {
        setup();
        const r = makeReqRes(
            'POST',
            '/api/settings/batch',
            { changes: [{ id: 'autoUpdate', label: 'Auto update', from: true, to: false }] },
            {},
            LOOPBACK,
        );
        await new SettingsBatchApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(200);
        const body = r.getJson() as { ok: boolean; applied: string[] };
        expect(body.ok).toBe(true);
        expect(body.applied).toContain('autoUpdate');
        // The WAL row reached a terminal state -- nothing left for boot to abandon.
        expect(Config.getInstance().db.pendingSettings.getPending()).toHaveLength(0);
    });

    it('refuses an unknown change id rather than writing it anywhere', async () => {
        setup();
        const r = makeReqRes(
            'POST',
            '/api/settings/batch',
            { changes: [{ id: 'installService', label: 'Install', from: false, to: true }] },
            {},
            LOOPBACK,
        );
        await new SettingsBatchApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(400);
        expect(Config.getInstance().db.pendingSettings.getPending()).toHaveLength(0);
    });

    it('400s a malformed changes list rather than throwing a 500 at it', async () => {
        setup();
        // Both used to reach `changes.find((c) => !STAGEABLE_IDS.has(c.id))`,
        // which dereferences `c.id`, OUTSIDE the try/catch around the parse —
        // so the caller's handler turned a bad request into a server fault.
        for (const changes of [{ nope: true }, [null], ['not an object']]) {
            const r = makeReqRes('POST', '/api/settings/batch', { changes }, {}, LOOPBACK);
            await new SettingsBatchApi().handle(r.req, r.res);
            expect(r.getStatus(), JSON.stringify(changes)).toBe(400);
            expect((r.getJson() as { error: string }).error).toBe('changes must be an array of change objects');
        }
        // Nothing was recorded for any of them.
        expect(Config.getInstance().db.pendingSettings.getPending()).toHaveLength(0);
    });

    it('400s a change carrying no value instead of marking it completed', async () => {
        setup();
        // `updateAppConfig` SKIPS an undefined value silently, so this used to be
        // pushed to `applied` and the row marked `completed` — an audit trail
        // claiming a write that never happened.
        const r = makeReqRes(
            'POST',
            '/api/settings/batch',
            { changes: [{ id: 'channel', label: 'Update channel', from: 'beta' }] },
            {},
            LOOPBACK,
        );
        await new SettingsBatchApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(400);
        expect((r.getJson() as { error: string }).error).toBe('change has no value: channel');
        // Refused before the WAL row, like every other shape rejection.
        const row = Config.getInstance().db.sqlite.prepare('SELECT COUNT(*) AS n FROM pending_settings').get() as {
            n: number;
        };
        expect(row.n).toBe(0);
    });

    it('still applies a falsy value — `to: false` and `to: 0` are values, not absence', async () => {
        setup();
        const r = makeReqRes(
            'POST',
            '/api/settings/batch',
            { changes: [{ id: 'autoUpdate', label: 'Automatic updates', from: true, to: false }] },
            {},
            LOOPBACK,
        );
        await new SettingsBatchApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(200);
        expect(Config.getInstance().getAppConfig().autoUpdate).toBe(false);
    });

    it('403s an off-box caller — the route is operator-gated like every admin route', async () => {
        setup();
        const r = makeReqRes('POST', '/api/settings/batch', { changes: [] }, {}, { remoteAddress: '192.168.1.50' });
        await new SettingsBatchApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(403);
        expect(r.getJson()).toEqual({ error: 'admin actions are limited to this machine' });
    });
});

// ──────────────────────────────────────────────────────────────────────────
// A batch containing webPort ends the process (exit-75, supervisor restart)
// once the response has flushed. These drive that path via SettingsBatchApi's
// injected schedule/exit seams (SettingsBatchApiOptions, same shape as
// ServerShutdownApiOptions) so no test here starts a real timer or kills the
// vitest worker.

describe('POST /api/settings/batch — webPort restart', () => {
    it('a webPort change writes the restart marker and schedules exit-75, without firing it yet', async () => {
        const dir = setup();
        const schedule = vi.fn();
        const exit = vi.fn();
        const r = makeReqRes(
            'POST',
            '/api/settings/batch',
            { changes: [{ id: 'webPort', label: 'Web port', from: 8000, to: 8010 }] },
            {},
            LOOPBACK,
        );
        await new SettingsBatchApi({ schedule, exit }).handle(r.req, r.res);

        expect(r.getStatus()).toBe(200);
        const body = r.getJson() as {
            ok: boolean;
            applied: string[];
            restartRequired: boolean;
            redirectPort: number;
        };
        expect(body.ok).toBe(true);
        expect(body.applied).toContain('webPort');
        expect(body.restartRequired).toBe(true);
        expect(body.redirectPort).toBe(8010);

        // The marker is written and the exit is scheduled, but the response
        // must reach the client before the process goes down -- nothing has
        // fired yet.
        expect(fs.existsSync(path.join(dir, '.restart'))).toBe(true);
        expect(schedule).toHaveBeenCalledTimes(1);
        const [cb, delay] = schedule.mock.calls[0]!;
        expect(delay).toBe(1000);
        expect(exit).not.toHaveBeenCalled();

        // Firing the scheduled callback now runs the actual exit.
        await (cb as () => void)();
        expect(exit).toHaveBeenCalledWith(75);
    });

    it('marks the WAL row completed BEFORE scheduling the restart that ends the process', async () => {
        setup();
        const cfg = Config.getInstance();
        let statusWhenRestartScheduled: unknown;
        // Read the WAL row's raw status (bypassing getPending(), which only ever
        // returns 'pending' rows) at the instant the step that ends the process
        // is scheduled. A test that only asserted the FINAL status would pass
        // however the statements were ordered -- they all run before the handler
        // returns, so the row ends up 'completed' either way. Reading it from
        // inside the scheduling call is what actually pins the order.
        //
        // The probe reads from `schedule`, not from `updateAppConfig`: the config
        // write is NOT what ends the process, the restart is, and marking the row
        // completed before a write that can still throw wrote a 'completed' audit
        // row for a change that never happened (see the invalid-webPort test
        // below). Task 2's guarantee is unchanged -- nothing that could lose an
        // instruction runs while the row still says 'pending'.
        const statusNow = (): string | undefined =>
            (
                cfg.db.sqlite.prepare('SELECT status FROM pending_settings ORDER BY id DESC LIMIT 1').get() as
                    | { status: string }
                    | undefined
            )?.status;

        const r = makeReqRes(
            'POST',
            '/api/settings/batch',
            { changes: [{ id: 'webPort', label: 'Web port', from: 8000, to: 8010 }] },
            {},
            LOOPBACK,
        );
        await new SettingsBatchApi({
            schedule: () => {
                statusWhenRestartScheduled = statusNow();
            },
            exit: vi.fn(),
        }).handle(r.req, r.res);

        expect(statusWhenRestartScheduled).toBe('completed');
    });

    // The per-field Save button that used to pre-screen the port is gone, so a
    // value `Config.validateField` rejects can now reach this endpoint. It
    // rejects by THROWING, and the webPort branch used to sit outside the
    // try/catch that wraps every other change -- so a bad port wrote a
    // 'completed' audit row for a write that never happened, then threw past
    // the 400 handler.
    it('answers 400 for an invalid webPort and leaves the WAL row failed, not completed', async () => {
        setup();
        const schedule = vi.fn();
        const exit = vi.fn();
        // Spying on markCompleted is what pins the "AFTER updateAppConfig" half
        // of the ordering. The final row status alone cannot: `setStatus` is an
        // unconditional UPDATE (PendingSettingsStore), so a markCompleted call
        // moved back above the try would be overwritten by the markFailed that
        // follows, and the row would still read 'failed' below.
        const markCompleted = vi.spyOn(Config.getInstance().db.pendingSettings, 'markCompleted');
        const r = makeReqRes(
            'POST',
            '/api/settings/batch',
            { changes: [{ id: 'webPort', label: 'Web port', from: 8000, to: 0 }] },
            {},
            LOOPBACK,
        );
        await new SettingsBatchApi({ schedule, exit }).handle(r.req, r.res);

        expect(r.getStatus()).toBe(400);
        const body = r.getJson() as { ok: boolean; applied: string[]; failed: { id: string; error: string } };
        expect(body.ok).toBe(false);
        expect(body.applied).toEqual([]);
        expect(body.failed.id).toBe('webPort');
        expect(body.failed.error).toBe('webPort must be an integer between 1024 and 65535');

        // Nothing was applied and nothing was scheduled: the port stands and the
        // process is not going down.
        expect(schedule).not.toHaveBeenCalled();
        expect(exit).not.toHaveBeenCalled();
        expect(Config.getInstance().getAppConfig().webPort).toBe(8000);

        // Never marked completed at all — not "marked completed then corrected".
        expect(markCompleted).not.toHaveBeenCalled();

        // The row landed in 'failed'. A 'completed' row here would be an audit
        // trail asserting a write that did not happen.
        const row = Config.getInstance()
            .db.sqlite.prepare('SELECT status, error FROM pending_settings ORDER BY id DESC LIMIT 1')
            .get() as { status: string; error: string } | undefined;
        expect(row?.status).toBe('failed');
        expect(row?.error).toBe('webPort: webPort must be an integer between 1024 and 65535');
    });

    it('a mid-batch failure marks the row failed and never reaches a later webPort change', async () => {
        setup();
        const schedule = vi.fn();
        const exit = vi.fn();
        const r = makeReqRes(
            'POST',
            '/api/settings/batch',
            {
                changes: [
                    { id: 'channel', label: 'Channel', from: 'stable', to: 'not-a-channel' },
                    { id: 'webPort', label: 'Web port', from: 8000, to: 8010 },
                ],
            },
            {},
            LOOPBACK,
        );
        await new SettingsBatchApi({ schedule, exit }).handle(r.req, r.res);

        expect(r.getStatus()).toBe(400);
        const body = r.getJson() as { ok: boolean; applied: string[]; failed: { id: string; error: string } };
        expect(body.ok).toBe(false);
        expect(body.applied).toEqual([]);
        expect(body.failed.id).toBe('channel');

        // webPort never ran: no restart scheduled, port unchanged.
        expect(schedule).not.toHaveBeenCalled();
        expect(exit).not.toHaveBeenCalled();
        expect(Config.getInstance().getAppConfig().webPort).toBe(8000);

        // The row landed in 'failed', not just "no longer pending".
        const row = Config.getInstance()
            .db.sqlite.prepare('SELECT status, error FROM pending_settings ORDER BY id DESC LIMIT 1')
            .get() as { status: string; error: string } | undefined;
        expect(row?.status).toBe('failed');
        expect(row?.error).toBe('channel: channel must be one of: stable, beta');
    });
});

// ──────────────────────────────────────────────────────────────────────────
// The https port, staged from the Server tab since it left Local HTTPS. It is
// applied through Config.setHttpsPort, needs the same restart as webPort, and
// may never land on the web port. (The container refusal is pinned with the
// other container routes, in containerGuard.routes.test.ts.)

describe('POST /api/settings/batch — httpsPort', () => {
    const httpsChange = (to: unknown): Change => ({ id: 'httpsPort', label: 'HTTPS port', from: 8443, to });
    const readConfigFile = (dir: string): Record<string, unknown> =>
        JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8')) as Record<string, unknown>;

    it('is stageable, and goes second to last, straight before webPort', () => {
        expect(STAGEABLE_IDS.has('httpsPort')).toBe(true);
        const ordered = orderChanges([
            { id: 'webPort', label: 'HTTP port', from: 8000, to: 8010 },
            httpsChange(9443),
            { id: 'channel', label: 'Channel', from: 'stable', to: 'beta' },
        ]);
        expect(ordered.map((c) => c.id)).toEqual(['channel', 'httpsPort', 'webPort']);
    });

    it('applies a new https port to config.json and schedules one restart, with no redirect', async () => {
        const dir = setup();
        const schedule = vi.fn();
        const exit = vi.fn();
        const r = makeReqRes('POST', '/api/settings/batch', { changes: [httpsChange(9443)] }, {}, LOOPBACK);
        await new SettingsBatchApi({ schedule, exit }).handle(r.req, r.res);

        expect(r.getStatus()).toBe(200);
        expect(r.getJson()).toEqual({ ok: true, applied: ['httpsPort'], restartRequired: true });
        expect(readConfigFile(dir)['httpsPort']).toBe(9443);
        expect(Config.getInstance().httpsPort).toBe(9443);
        expect(fs.existsSync(path.join(dir, '.restart'))).toBe(true);
        expect(schedule).toHaveBeenCalledTimes(1);
        expect(exit).not.toHaveBeenCalled();
        const row = Config.getInstance()
            .db.sqlite.prepare('SELECT status FROM pending_settings ORDER BY id DESC LIMIT 1')
            .get() as { status: string } | undefined;
        expect(row?.status).toBe('completed');
    });

    it('schedules ONE restart when both ports move, and redirects to the new http port', async () => {
        const dir = setup();
        const schedule = vi.fn();
        const r = makeReqRes(
            'POST',
            '/api/settings/batch',
            { changes: [{ id: 'webPort', label: 'HTTP port', from: 8000, to: 8010 }, httpsChange(9443)] },
            {},
            LOOPBACK,
        );
        await new SettingsBatchApi({ schedule, exit: vi.fn() }).handle(r.req, r.res);

        expect(r.getStatus()).toBe(200);
        expect(r.getJson()).toEqual({
            ok: true,
            applied: ['httpsPort', 'webPort'],
            restartRequired: true,
            redirectPort: 8010,
        });
        expect(readConfigFile(dir)['httpsPort']).toBe(9443);
        expect(readConfigFile(dir)['webPort']).toBe(8010);
        expect(schedule).toHaveBeenCalledTimes(1);
    });

    it('restarts for a moved https port even when the web port in the batch did not move', async () => {
        setup();
        const schedule = vi.fn();
        const r = makeReqRes(
            'POST',
            '/api/settings/batch',
            { changes: [httpsChange(9443), { id: 'webPort', label: 'HTTP port', from: 8000, to: 8000 }] },
            {},
            LOOPBACK,
        );
        await new SettingsBatchApi({ schedule, exit: vi.fn() }).handle(r.req, r.res);

        expect(r.getStatus()).toBe(200);
        const body = r.getJson() as { restartRequired: boolean; redirectPort?: number };
        expect(body.restartRequired).toBe(true);
        expect(body.redirectPort).toBeUndefined();
        expect(schedule).toHaveBeenCalledTimes(1);
    });

    it('does not restart for an https port that did not move', async () => {
        const dir = setup();
        const schedule = vi.fn();
        const r = makeReqRes('POST', '/api/settings/batch', { changes: [httpsChange(8443)] }, {}, LOOPBACK);
        await new SettingsBatchApi({ schedule, exit: vi.fn() }).handle(r.req, r.res);

        expect(r.getStatus()).toBe(200);
        expect(r.getJson()).toEqual({ ok: true, applied: ['httpsPort'] });
        expect(schedule).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(dir, '.restart'))).toBe(false);
    });

    it('refuses an out-of-range https port before the WAL row, applying nothing', async () => {
        for (const bad of [0, 65536, 8443.5, '9443']) {
            const dir = setup();
            const schedule = vi.fn();
            const r = makeReqRes(
                'POST',
                '/api/settings/batch',
                {
                    changes: [
                        { id: 'autoUpdate', label: 'Automatic updates', from: true, to: false },
                        httpsChange(bad),
                    ],
                },
                {},
                LOOPBACK,
            );
            await new SettingsBatchApi({ schedule, exit: vi.fn() }).handle(r.req, r.res);

            expect(r.getStatus(), String(bad)).toBe(400);
            expect(r.getJson()).toEqual({
                ok: false,
                applied: [],
                failed: { id: 'httpsPort', error: 'port must be an integer between 1 and 65535' },
            });
            const cfg = Config.getInstance();
            expect(cfg.getAppConfig().autoUpdate).toBe(true);
            expect(cfg.httpsPort).toBe(8443);
            expect(readConfigFile(dir)['httpsPort']).toBeUndefined();
            const rows = cfg.db.sqlite.prepare('SELECT COUNT(*) AS n FROM pending_settings').get() as { n: number };
            expect(rows.n).toBe(0);
            expect(schedule).not.toHaveBeenCalled();
        }
    });

    it('409s an https port equal to the current http port, before anything is applied', async () => {
        const dir = setup();
        const schedule = vi.fn();
        const r = makeReqRes(
            'POST',
            '/api/settings/batch',
            {
                changes: [{ id: 'autoUpdate', label: 'Automatic updates', from: true, to: false }, httpsChange(8000)],
            },
            {},
            LOOPBACK,
        );
        await new SettingsBatchApi({ schedule, exit: vi.fn() }).handle(r.req, r.res);

        expect(r.getStatus()).toBe(409);
        expect(r.getJson()).toEqual({
            ok: false,
            applied: [],
            failed: { id: 'httpsPort', error: 'the http and https ports must differ (both would be 8000)' },
        });
        expect(Config.getInstance().getAppConfig().autoUpdate).toBe(true);
        expect(readConfigFile(dir)['httpsPort']).toBeUndefined();
        const rows = Config.getInstance().db.sqlite.prepare('SELECT COUNT(*) AS n FROM pending_settings').get() as {
            n: number;
        };
        expect(rows.n).toBe(0);
        expect(schedule).not.toHaveBeenCalled();
    });

    it('409s a batch whose two port changes collide with each other', async () => {
        setup();
        const r = makeReqRes(
            'POST',
            '/api/settings/batch',
            { changes: [{ id: 'webPort', label: 'HTTP port', from: 8000, to: 9443 }, httpsChange(9443)] },
            {},
            LOOPBACK,
        );
        await new SettingsBatchApi({ schedule: vi.fn(), exit: vi.fn() }).handle(r.req, r.res);

        expect(r.getStatus()).toBe(409);
        expect((r.getJson() as { failed: { id: string; error: string } }).failed).toEqual({
            id: 'httpsPort',
            error: 'the http and https ports must differ (both would be 9443)',
        });
        expect(Config.getInstance().getAppConfig().webPort).toBe(8000);
    });

    it('409s a web port moved onto the configured https port', async () => {
        setup();
        const schedule = vi.fn();
        const r = makeReqRes(
            'POST',
            '/api/settings/batch',
            { changes: [{ id: 'webPort', label: 'HTTP port', from: 8000, to: 8443 }] },
            {},
            LOOPBACK,
        );
        await new SettingsBatchApi({ schedule, exit: vi.fn() }).handle(r.req, r.res);

        expect(r.getStatus()).toBe(409);
        expect((r.getJson() as { failed: { id: string; error: string } }).failed).toEqual({
            id: 'webPort',
            error: 'the http and https ports must differ (both would be 8443)',
        });
        expect(Config.getInstance().getAppConfig().webPort).toBe(8000);
        expect(schedule).not.toHaveBeenCalled();
    });

    it('still schedules the restart a written https port needs when the web port after it is refused', async () => {
        const dir = setup();
        const schedule = vi.fn();
        const r = makeReqRes(
            'POST',
            '/api/settings/batch',
            { changes: [{ id: 'webPort', label: 'HTTP port', from: 8000, to: 80 }, httpsChange(9443)] },
            {},
            LOOPBACK,
        );
        await new SettingsBatchApi({ schedule, exit: vi.fn() }).handle(r.req, r.res);

        expect(r.getStatus()).toBe(400);
        const body = r.getJson() as {
            ok: boolean;
            applied: string[];
            failed: { id: string };
            restartRequired?: boolean;
        };
        expect(body.applied).toEqual(['httpsPort']);
        expect(body.failed.id).toBe('webPort');
        expect(body.restartRequired).toBe(true);
        expect(readConfigFile(dir)['httpsPort']).toBe(9443);
        expect(Config.getInstance().getAppConfig().webPort).toBe(8000);
        expect(schedule).toHaveBeenCalledTimes(1);
    });
});

/**
 * The client/server boundary, driven end to end: what `StagedSettingsStore`
 * REALLY produces, fed to the REAL endpoint.
 *
 * This is the test whose absence was the actual defect. Every other test in
 * this file hand-writes its `changes` array, and every test in
 * `stagedSettingsStore.test.ts` inspects the store's output without ever
 * sending it anywhere -- so the two halves were free to disagree, and they did:
 * the store emitted `to: 'off'` for `autoUpdate` while `validateField` accepted
 * only booleans, and BOTH suites were green because each pinned its own half of
 * a contract neither one crossed.
 *
 * Nothing here may hand-write a change. The store builds them, so a future
 * change to its output shape fails HERE rather than in production.
 */
describe('staged changes cross the wire intact', () => {
    /** The real Updates-tab registration, formatter included. */
    function autoUpdateStore(initial: boolean): StagedSettingsStore {
        const store = new StagedSettingsStore();
        store.register({
            id: 'autoUpdate',
            label: 'Automatic updates',
            initial,
            format: (v) => (v ? 'on' : 'off'),
        });
        return store;
    }

    it('a formatted boolean arrives as a BOOLEAN and is actually applied', async () => {
        setup();
        const cfg = Config.getInstance();
        // The baseline the tab would re-register from, read from the real config
        // rather than assumed.
        expect(cfg.getAppConfig().autoUpdate).toBe(true);

        const store = autoUpdateStore(cfg.getAppConfig().autoUpdate);
        store.set('autoUpdate', false);
        const changes = store.changes();

        // What the store hands `runSave`, before anything touches it. `'off'`
        // here is the bug; `false` is the contract.
        expect(changes).toHaveLength(1);
        expect(changes[0]?.to).toBe(false);
        expect(typeof changes[0]?.to).toBe('boolean');

        const r = makeReqRes('POST', '/api/settings/batch', { changes }, {}, LOOPBACK);
        await new SettingsBatchApi().handle(r.req, r.res);

        expect(r.getStatus()).toBe(200);
        const body = r.getJson() as { ok: boolean; applied: string[] };
        expect(body.ok).toBe(true);
        expect(body.applied).toEqual(['autoUpdate']);

        // Applied, not merely accepted: the setting really moved, and it is
        // still a boolean on the other side.
        expect(Config.getInstance().getAppConfig().autoUpdate).toBe(false);

        // And the WAL says so. A `failed` row here is what the bug produced.
        const row = Config.getInstance()
            .db.sqlite.prepare('SELECT status, error FROM pending_settings ORDER BY id DESC LIMIT 1')
            .get() as { status: string; error: string } | undefined;
        expect(row?.status).toBe('completed');
        expect(row?.error).toBeNull();
    });

    it('carries the display text along without the server minding it', async () => {
        setup();
        const store = autoUpdateStore(true);
        store.set('autoUpdate', false);
        const changes = store.changes();

        // The wording the user confirmed on the summary screen travels with the
        // batch -- that is the point of keeping it beside the value instead of
        // in place of it.
        expect(changes[0]?.fromText).toBe('on');
        expect(changes[0]?.toText).toBe('off');

        const r = makeReqRes('POST', '/api/settings/batch', { changes }, {}, LOOPBACK);
        await new SettingsBatchApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(200);

        // The extra fields are inert on the server but ARE recorded, so the WAL
        // row explains what the user was shown, not just what was written.
        const row = Config.getInstance()
            .db.sqlite.prepare('SELECT changes FROM pending_settings ORDER BY id DESC LIMIT 1')
            .get() as { changes: string } | undefined;
        const recorded = JSON.parse(row?.changes ?? '[]') as Change[];
        expect(recorded[0]?.toText).toBe('off');
        expect(recorded[0]?.to).toBe(false);

        expect(Config.getInstance().getAppConfig().autoUpdate).toBe(false);
    });

    it('every stageable id survives the round trip in one batch', async () => {
        setup();
        const cfg = Config.getInstance().getAppConfig();
        const store = new StagedSettingsStore();
        store.register({ id: 'channel', label: 'Update channel', initial: cfg.channel });
        store.register({
            id: 'autoUpdate',
            label: 'Automatic updates',
            initial: cfg.autoUpdate,
            format: (v) => (v ? 'on' : 'off'),
        });
        store.register({
            id: 'updateCheckIntervalMinutes',
            label: 'Check interval (minutes)',
            initial: cfg.updateCheckIntervalMinutes,
        });
        // The Updates tab's fourth staged field, and the only STRING among them.
        // It reaches a `validateField` that demands a non-empty string, so this
        // is the id whose round trip is worth watching: `channel` is checked
        // against an enum, `autoUpdate` against a type, the interval against a
        // range — none of them can be broken by a value arriving as `''`.
        store.register({ id: 'githubOwner', label: 'GitHub owner', initial: cfg.githubOwner });
        store.register({ id: 'webPort', label: 'Web port', initial: cfg.webPort });

        store.set('channel', cfg.channel === 'beta' ? 'stable' : 'beta');
        store.set('autoUpdate', !cfg.autoUpdate);
        store.set('updateCheckIntervalMinutes', 90);
        store.set('githubOwner', 'someone-else');
        store.set('webPort', 8010);

        const schedule = vi.fn();
        const exit = vi.fn();
        const r = makeReqRes('POST', '/api/settings/batch', { changes: store.changes() }, {}, LOOPBACK);
        await new SettingsBatchApi({ schedule, exit }).handle(r.req, r.res);

        expect(r.getStatus()).toBe(200);
        const body = r.getJson() as { ok: boolean; applied: string[]; restartRequired: boolean };
        expect(body.ok).toBe(true);
        // webPort last, and nothing dropped on the way.
        expect(body.applied).toEqual(['channel', 'autoUpdate', 'updateCheckIntervalMinutes', 'githubOwner', 'webPort']);
        expect(body.restartRequired).toBe(true);

        const after = Config.getInstance().getAppConfig();
        expect(after.autoUpdate).toBe(!cfg.autoUpdate);
        expect(after.updateCheckIntervalMinutes).toBe(90);
        expect(after.githubOwner).toBe('someone-else');
        expect(after.webPort).toBe(8010);
    });
});

/**
 * The SECOND half of the same boundary: the real server's response body parsed
 * by the real client.
 *
 * `BatchResult` (`SaveRunner.ts`) is hand-declared against the JSON literals
 * `SettingsBatchApi` writes, exactly as `Change` was — client tests hand-write
 * server bodies, server tests assert them, and nothing pipes one into the other.
 * That is the structure that produced the auto-update bug, so it gets closed the
 * same way: the endpoint's REAL response goes through `runSave` and the parsed
 * `BatchResult` is asserted.
 *
 * All three response shapes are covered, because they are not variations of one
 * shape — the third has no `ok` field at all, which is the case `runSave`'s
 * `res.ok` normalisation exists for.
 */
describe('the server response parses into the BatchResult the client expects', () => {
    /** Real endpoint in, real `runSave` out. Nothing hand-written between them. */
    async function throughRunSave(changes: Change[], seams: SettingsBatchApiOptions = {}): Promise<BatchResult> {
        const r = makeReqRes('POST', '/api/settings/batch', { changes }, {}, LOOPBACK);
        await new SettingsBatchApi(seams).handle(r.req, r.res);
        const body = JSON.stringify(r.getJson());
        const status = r.getStatus();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(body, { status })),
        );
        return runSave(changes);
    }

    it('shape 1 — a successful batch', async () => {
        setup();
        const result = await throughRunSave([{ id: 'channel', label: 'Update channel', from: 'beta', to: 'stable' }]);
        expect(result.ok).toBe(true);
        expect(result.applied).toEqual(['channel']);
        expect(result.failed).toBeUndefined();
        // Not a restart batch, so the client must not be told to navigate.
        expect(result.restartRequired).toBeUndefined();
        expect(result.redirectPort).toBeUndefined();
    });

    it('shape 1b — a webPort batch carries the restart and the port the client redirects to', async () => {
        setup();
        const result = await throughRunSave([{ id: 'webPort', label: 'Web port', from: 8000, to: 8010 }], {
            schedule: vi.fn(),
            exit: vi.fn(),
        });
        expect(result.ok).toBe(true);
        expect(result.restartRequired).toBe(true);
        // `SettingsModal` refuses to navigate unless this is a number — a string
        // here would strand the browser on a dead port without failing anything.
        expect(typeof result.redirectPort).toBe('number');
        expect(result.redirectPort).toBe(8010);
    });

    it('shape 2 — a rejected apply arrives as ok:false with the failing id and the real message', async () => {
        setup();
        const result = await throughRunSave([
            { id: 'channel', label: 'Update channel', from: 'stable', to: 'not-a-channel' },
        ]);
        expect(result.ok).toBe(false);
        expect(result.applied).toEqual([]);
        // The id must match a change in the batch, or `saveFailureMessage` cannot
        // resolve it to the label the user just confirmed.
        expect(result.failed?.id).toBe('channel');
        expect(result.failed?.error).toBe('channel must be one of: stable, beta');
    });

    it('shape 3 — a bare 400 with no `ok` field still reads as a refusal, not a success', async () => {
        setup();
        const result = await throughRunSave([{ id: 'installService', label: 'Install', from: false, to: true }]);
        // The trap this normalisation exists for: the server sends `{ error }`
        // with no `ok`, so `body.ok` is `undefined` — and `undefined` is not
        // `false`, so a naive `if (result.ok)` would treat a REFUSED batch as
        // applied and commit the store's baseline over it.
        expect(result.ok).toBe(false);
        expect(result.applied).toEqual([]);
        expect(result.failed?.error).toBe('not a stageable setting: installService');
    });

    /**
     * `githubOwner` crosses this boundary as a STRING, which no other staged id
     * does — and the server it reaches demands a non-empty one.
     *
     * It is here because it is the newest id on the allowlist and the one whose
     * two halves were written apart: the tab's guard (client) and
     * `Config.validateField` (server) both say "non-empty", and nothing made
     * them meet until this. Both directions are pinned, because a string field
     * can fail either way — a value that should save and doesn't, or an empty
     * one that should be refused and isn't.
     */
    it('shape 1c — a github-owner batch applies the string and says so', async () => {
        setup();
        const result = await throughRunSave([
            { id: 'githubOwner', label: 'GitHub owner', from: 'bilbospocketses', to: 'someone-else' },
        ]);
        expect(result.ok).toBe(true);
        expect(result.applied).toEqual(['githubOwner']);
        expect(result.failed).toBeUndefined();
        // Applied, not merely accepted.
        expect(Config.getInstance().getAppConfig().githubOwner).toBe('someone-else');
    });

    it('shape 2c — an EMPTY github owner is refused with the real validator message', async () => {
        setup();
        const before = Config.getInstance().getAppConfig().githubOwner;
        const result = await throughRunSave([
            { id: 'githubOwner', label: 'GitHub owner', from: 'bilbospocketses', to: '' },
        ]);
        expect(result.ok).toBe(false);
        expect(result.applied).toEqual([]);
        expect(result.failed?.id).toBe('githubOwner');
        // The message the user would be shown, straight from `validateField` —
        // not a paraphrase written here.
        expect(result.failed?.error).toBe('githubOwner must be a non-empty string');
        // And nothing moved. `''` is not `undefined`, so the endpoint's
        // valueless check does not catch it and it really does reach the writer.
        expect(Config.getInstance().getAppConfig().githubOwner).toBe(before);
    });

    it('shape 2b — a half-applied batch reports what already landed', async () => {
        setup();
        const result = await throughRunSave([
            { id: 'channel', label: 'Update channel', from: 'beta', to: 'stable' },
            { id: 'updateCheckIntervalMinutes', label: 'Check interval (minutes)', from: 60, to: 99999 },
        ]);
        expect(result.ok).toBe(false);
        // The applied sibling really was written, and the client is told so —
        // this is the list `saveFailureMessage` now names for the user.
        expect(result.applied).toEqual(['channel']);
        expect(result.failed?.id).toBe('updateCheckIntervalMinutes');
        expect(Config.getInstance().getAppConfig().channel).toBe('stable');
    });
});

/**
 * Smoke row 6.11 (found by the qa-harness session while planning it): a Save
 * of the check interval or the channel used to land in config.json and stop
 * there. Only PATCH /api/updates/config told the RUNNING update service, so the
 * old timer and the old channel kept running until the app restarted.
 *
 * The service is a spy here, injected through the same options object as the
 * restart seams; production hands in the live `UpdateService` (index.ts).
 */
describe('POST /api/settings/batch — the running update service hears the save', () => {
    function fakeUpdater() {
        return {
            reconfigure: vi.fn(async (_channel: 'stable' | 'beta', _owner: string) => undefined),
            restartTimer: vi.fn((_minutes: number, _autoUpdate: boolean) => undefined),
        };
    }

    async function save(changes: Change[], updater: ReturnType<typeof fakeUpdater>) {
        const r = makeReqRes('POST', '/api/settings/batch', { changes }, {}, LOOPBACK);
        await new SettingsBatchApi({ updater, schedule: vi.fn(), exit: vi.fn() }).handle(r.req, r.res);
        return r;
    }

    /** The other channel from the one this config starts on, so the change is real. */
    function otherChannel(): 'stable' | 'beta' {
        return Config.getInstance().getAppConfig().channel === 'beta' ? 'stable' : 'beta';
    }

    /** An interval different from the one this config starts on. */
    function otherInterval(): number {
        return Config.getInstance().getAppConfig().updateCheckIntervalMinutes === 90 ? 120 : 90;
    }

    it('an interval change restarts the timer at the new interval', async () => {
        setup();
        const before = Config.getInstance().getAppConfig();
        const to = otherInterval();
        const updater = fakeUpdater();
        const r = await save(
            [
                {
                    id: 'updateCheckIntervalMinutes',
                    label: 'Check interval (minutes)',
                    from: before.updateCheckIntervalMinutes,
                    to,
                },
            ],
            updater,
        );
        expect(r.getStatus()).toBe(200);
        expect(updater.restartTimer).toHaveBeenCalledTimes(1);
        expect(updater.restartTimer).toHaveBeenCalledWith(to, before.autoUpdate);
        expect(updater.reconfigure).not.toHaveBeenCalled();
    });

    it('a channel change reconfigures the service onto the new channel', async () => {
        setup();
        const before = Config.getInstance().getAppConfig();
        const to = otherChannel();
        const updater = fakeUpdater();
        const r = await save([{ id: 'channel', label: 'Update channel', from: before.channel, to }], updater);
        expect(r.getStatus()).toBe(200);
        expect(updater.reconfigure).toHaveBeenCalledTimes(1);
        expect(updater.reconfigure).toHaveBeenCalledWith(to, before.githubOwner);
        expect(updater.restartTimer).not.toHaveBeenCalled();
    });

    it('a github-owner change reconfigures too — it moves the feed the same way', async () => {
        setup();
        const before = Config.getInstance().getAppConfig();
        const updater = fakeUpdater();
        const r = await save(
            [{ id: 'githubOwner', label: 'GitHub owner', from: before.githubOwner, to: 'someone-else' }],
            updater,
        );
        expect(r.getStatus()).toBe(200);
        expect(updater.reconfigure).toHaveBeenCalledTimes(1);
        expect(updater.reconfigure).toHaveBeenCalledWith(before.channel, 'someone-else');
        expect(updater.restartTimer).not.toHaveBeenCalled();
    });

    it('a batch that moves neither touches neither', async () => {
        setup();
        const before = Config.getInstance().getAppConfig();
        const updater = fakeUpdater();
        const r = await save(
            [
                // autoUpdate is read by the service at every check, so it needs no call.
                { id: 'autoUpdate', label: 'Automatic updates', from: before.autoUpdate, to: !before.autoUpdate },
                // Re-stating the current interval is not a change.
                {
                    id: 'updateCheckIntervalMinutes',
                    label: 'Check interval (minutes)',
                    from: before.updateCheckIntervalMinutes,
                    to: before.updateCheckIntervalMinutes,
                },
            ],
            updater,
        );
        expect(r.getStatus()).toBe(200);
        expect(updater.reconfigure).not.toHaveBeenCalled();
        expect(updater.restartTimer).not.toHaveBeenCalled();
    });

    it('channel and interval together reconfigure once AND restart the timer at the new interval', async () => {
        setup();
        const before = Config.getInstance().getAppConfig();
        const channel = otherChannel();
        const interval = otherInterval();
        const updater = fakeUpdater();
        const r = await save(
            [
                { id: 'channel', label: 'Update channel', from: before.channel, to: channel },
                {
                    id: 'updateCheckIntervalMinutes',
                    label: 'Check interval (minutes)',
                    from: before.updateCheckIntervalMinutes,
                    to: interval,
                },
            ],
            updater,
        );
        expect(r.getStatus()).toBe(200);
        expect(updater.reconfigure).toHaveBeenCalledTimes(1);
        expect(updater.reconfigure).toHaveBeenCalledWith(channel, before.githubOwner);
        // reconfigure never touches the timer, so without this the old interval
        // kept running until restart.
        expect(updater.restartTimer).toHaveBeenCalledTimes(1);
        expect(updater.restartTimer).toHaveBeenCalledWith(interval, before.autoUpdate);
    });

    it('a half-applied batch still tells the service about the sibling that landed', async () => {
        setup();
        const before = Config.getInstance().getAppConfig();
        const to = otherChannel();
        const updater = fakeUpdater();
        const r = await save(
            [
                { id: 'channel', label: 'Update channel', from: before.channel, to },
                { id: 'updateCheckIntervalMinutes', label: 'Check interval (minutes)', from: 60, to: 99999 },
            ],
            updater,
        );
        // The batch failed at the interval, but the channel really was written —
        // a running service left on the old one is the bug this block is about.
        expect(r.getStatus()).toBe(400);
        expect(Config.getInstance().getAppConfig().channel).toBe(to);
        expect(updater.reconfigure).toHaveBeenCalledTimes(1);
        expect(updater.reconfigure).toHaveBeenCalledWith(to, before.githubOwner);
    });

    it('a batch that also moves the port leaves the updater alone — the process is about to restart', async () => {
        setup();
        const before = Config.getInstance().getAppConfig();
        const updater = fakeUpdater();
        const r = await save(
            [
                {
                    id: 'updateCheckIntervalMinutes',
                    label: 'Check interval (minutes)',
                    from: before.updateCheckIntervalMinutes,
                    to: otherInterval(),
                },
                { id: 'webPort', label: 'Web port', from: 8000, to: 8010 },
            ],
            updater,
        );
        expect(r.getStatus()).toBe(200);
        expect((r.getJson() as { restartRequired: boolean }).restartRequired).toBe(true);
        // The new process's UpdateService.init() reads the new interval from
        // config.json, so a restart here would only be cut off by the exit.
        expect(updater.restartTimer).not.toHaveBeenCalled();
        expect(updater.reconfigure).not.toHaveBeenCalled();
    });
});

describe('reconcilePendingSettings', () => {
    it('abandons a pending row rather than re-applying it', () => {
        setup();
        const db = Config.getInstance().db;
        db.pendingSettings.create(1, [{ id: 'webPort', label: 'Web port', from: 8000, to: 8010 }]);

        const result = reconcilePendingSettings(db);

        expect(result.abandoned).toBe(1);
        expect(db.pendingSettings.getPending()).toHaveLength(0);
        // The literal status, not just "no longer pending". `markCompleted` here
        // would satisfy the weaker check while recording that an interrupted
        // batch had been WRITTEN -- the opposite of what happened, and the row
        // someone reads to explain why a setting did or did not move.
        const row = Config.getInstance()
            .db.sqlite.prepare('SELECT status FROM pending_settings ORDER BY id DESC LIMIT 1')
            .get() as { status: string };
        expect(row.status).toBe('abandoned');
        // The port was NOT changed -- silently applying settings a user may not
        // remember confirming is worse than losing them.
        expect(Config.getInstance().getAppConfig().webPort).toBe(8000);
    });

    it('reports nothing to do on a clean boot', () => {
        setup();
        expect(reconcilePendingSettings(Config.getInstance().db)).toEqual({ abandoned: 0, pruned: 0 });
    });
});
