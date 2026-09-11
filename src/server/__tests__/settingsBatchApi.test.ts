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

    it('marks the WAL row completed BEFORE applying the port change that ends the process', async () => {
        setup();
        const cfg = Config.getInstance();
        let statusWhenApplyRan: unknown;
        const originalUpdateAppConfig = cfg.updateAppConfig.bind(cfg);
        vi.spyOn(cfg, 'updateAppConfig').mockImplementation((partial) => {
            // Read the WAL row's raw status (bypassing getPending(), which
            // only ever returns 'pending' rows) at the instant the apply
            // that ends the process begins. A test that only asserted the
            // FINAL status would pass even if the two statements below were
            // swapped -- both still run before the handler returns, so the
            // row ends up 'completed' either way. Reading it from inside the
            // apply itself is what actually pins the order.
            const row = cfg.db.sqlite.prepare('SELECT status FROM pending_settings ORDER BY id DESC LIMIT 1').get() as
                | { status: string }
                | undefined;
            statusWhenApplyRan = row?.status;
            return originalUpdateAppConfig(partial);
        });

        const r = makeReqRes(
            'POST',
            '/api/settings/batch',
            { changes: [{ id: 'webPort', label: 'Web port', from: 8000, to: 8010 }] },
            {},
            LOOPBACK,
        );
        await new SettingsBatchApi({ schedule: vi.fn(), exit: vi.fn() }).handle(r.req, r.res);

        expect(statusWhenApplyRan).toBe('completed');
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
