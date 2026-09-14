import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { orderChanges, SettingsBatchApi, STAGEABLE_IDS } from '../api/SettingsBatchApi';
import { Config } from '../Config';
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
        // Actions must never be stageable: they fire UAC, delete users, etc.
        expect(STAGEABLE_IDS.has('installService')).toBe(false);
        expect(STAGEABLE_IDS.has('deleteUser')).toBe(false);
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

describe('reconcilePendingSettings', () => {
    it('abandons a pending row rather than re-applying it', () => {
        setup();
        const db = Config.getInstance().db;
        db.pendingSettings.create(1, [{ id: 'webPort', label: 'Web port', from: 8000, to: 8010 }]);

        const result = reconcilePendingSettings(db);

        expect(result.abandoned).toBe(1);
        expect(db.pendingSettings.getPending()).toHaveLength(0);
        // The port was NOT changed -- silently applying settings a user may not
        // remember confirming is worse than losing them.
        expect(Config.getInstance().getAppConfig().webPort).toBe(8000);
    });

    it('reports nothing to do on a clean boot', () => {
        setup();
        expect(reconcilePendingSettings(Config.getInstance().db)).toEqual({ abandoned: 0, pruned: 0 });
    });
});
