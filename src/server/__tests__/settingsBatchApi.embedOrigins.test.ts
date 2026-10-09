import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    buildEmbedderOrigins,
    embedderOriginsFromInput,
    FRAME_ANCESTORS_ADD_ID,
    IPV6_EMBEDDER_ERROR,
} from '../../common/embedderOrigin';
import { EMBED_DECIDED_LOCALLY_ERROR } from '../api/EmbedRequestApi';
import {
    frameAncestorsAddRefusal,
    MAX_FRAME_ANCESTORS_PER_ADD,
    SettingsBatchApi,
    STAGEABLE_IDS,
} from '../api/SettingsBatchApi';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import { parseFrameAncestorOrigin, securityHeaders, setFrameAncestors } from '../security/frameGuard';
import { makeReqRes } from './helpers/httpMock';

/**
 * Settings → Embedding's pre-approval (0.5.3) rides the settings batch as the
 * stageable id `frameAncestorsAdd`, and lands in the SAME store a consent
 * approval writes (`Config.addFrameAncestors` → config.json `frameAncestors`,
 * applied to the running server at once). These pin the server half: the
 * allowlist entry, the validation through `parseFrameAncestorOrigin`, the
 * loopback rule the consent routes carry on top of the operator gate, and that
 * every refusal leaves no WAL row and no partial write.
 */

const tmpDirs: string[] = [];
const saved = {
    CONFIG: process.env[EnvName.CONFIG_PATH],
    DEPS: process.env['DEPS_PATH'],
    DATA_ROOT: process.env['DATA_ROOT'],
    REMOTE: process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'],
};

const BOOT = { webPort: 8000, installMode: 'user', firstRunComplete: true };

function setup(initial: Record<string, unknown> = BOOT): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsbatch-embed-'));
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(initial));
    process.env[EnvName.CONFIG_PATH] = configPath;
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    process.env['DATA_ROOT'] = dir;
    Config._resetForTest();
    // As index.ts does at boot, so the live policy starts from config.json.
    setFrameAncestors(Config.getInstance().frameAncestors);
    return configPath;
}

function restore(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
}

afterEach(() => {
    Config._resetForTest();
    setFrameAncestors([]);
    restore(EnvName.CONFIG_PATH, saved.CONFIG);
    restore('DEPS_PATH', saved.DEPS);
    restore('DATA_ROOT', saved.DATA_ROOT);
    restore('WS_SCRCPY_ALLOW_REMOTE_ADMIN', saved.REMOTE);
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const LOOPBACK = { remoteAddress: '127.0.0.1' };
const OFF_BOX = { remoteAddress: '192.168.1.50' };

function readConfig(configPath: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function walCount(): number {
    const row = Config.getInstance().db.sqlite.prepare('SELECT COUNT(*) AS n FROM pending_settings').get() as {
        n: number;
    };
    return row.n;
}

function walLast(): { status: string; changes: string } | undefined {
    return Config.getInstance()
        .db.sqlite.prepare('SELECT status, changes FROM pending_settings ORDER BY id DESC LIMIT 1')
        .get() as { status: string; changes: string } | undefined;
}

function addChange(to: unknown) {
    return { id: FRAME_ANCESTORS_ADD_ID, label: 'Allowed embedders', from: [], to };
}

async function post(changes: unknown[], socket = LOOPBACK, user?: { id: number }) {
    const r = makeReqRes('POST', '/api/settings/batch', { changes }, {}, socket);
    if (user) (r.req as unknown as { user: { id: number } }).user = user;
    await new SettingsBatchApi().handle(r.req, r.res);
    return r;
}

describe('frameAncestorsAdd is stageable', () => {
    it('is on the allowlist, under the id the client stages', () => {
        expect(FRAME_ANCESTORS_ADD_ID).toBe('frameAncestorsAdd');
        expect(STAGEABLE_IDS.has(FRAME_ANCESTORS_ADD_ID)).toBe(true);
    });
});

describe('the origins the tab stages are exactly what the server stores', () => {
    // The tab's duplicate check compares staged origins with the list the server
    // returns, and the browser compares the stored origin with what it sends. All
    // three only agree if the client's builder and `parseFrameAncestorOrigin`
    // normalize identically: a staged origin must survive it unchanged.
    it.each([
        ['localhost', '5159', 'both'],
        ['LocalHost', '', 'http'],
        ['tools.example.com', '80', 'http'],
        ['tools.example.com', '443', 'https'],
        ['tools.example.com', '80', 'both'],
        ['192.168.1.50', '8080', 'https'],
        ['192.168.1.50', '', 'both'],
    ] as const)('%s port %s %s', (address, port, scheme) => {
        const built = embedderOriginsFromInput({ address, port, scheme });
        if (!built.ok) throw new Error(built.error);
        for (const origin of built.origins) {
            expect(parseFrameAncestorOrigin(origin)).toBe(origin);
        }
    });

    it('elides the default port the same way the server does', () => {
        expect(parseFrameAncestorOrigin('http://localhost:80')).toBe(buildEmbedderOrigins('localhost', 80, 'http')[0]);
        expect(parseFrameAncestorOrigin('https://localhost:443')).toBe(
            buildEmbedderOrigins('localhost', 443, 'https')[0],
        );
    });
});

describe('frameAncestorsAddRefusal', () => {
    it('accepts a list of http(s) origins', () => {
        expect(frameAncestorsAddRefusal(['http://localhost:5159', 'https://localhost:5159'])).toBeNull();
    });

    it.each([
        ['a non-array', 'http://localhost:5159', 'must be a list of origins'],
        ['an empty list', [], 'no origins to add'],
        ['a wildcard', ['*'], 'not an http(s) origin with no path: "*"'],
        ['a path', ['http://localhost:5159/app'], 'not an http(s) origin with no path: "http://localhost:5159/app"'],
        ['another scheme', ['ftp://files.example'], 'not an http(s) origin with no path: "ftp://files.example"'],
        ['a non-string', [5159], 'not an http(s) origin with no path: 5159'],
        ['a bare host', ['localhost'], 'not an http(s) origin with no path: "localhost"'],
        // 0.5.3 review: a browser discards an IPv6 frame-ancestors source.
        [
            'an IPv6 origin',
            ['http://localhost:5159', 'http://[::1]:5159'],
            `"http://[::1]:5159": ${IPV6_EMBEDDER_ERROR}`,
        ],
    ])('refuses %s', (_name, to, error) => {
        expect(frameAncestorsAddRefusal(to)).toBe(error);
    });

    it(`refuses more than ${MAX_FRAME_ANCESTORS_PER_ADD} origins in one save`, () => {
        const many = Array.from({ length: MAX_FRAME_ANCESTORS_PER_ADD + 1 }, (_, i) => `http://localhost:${5000 + i}`);
        expect(frameAncestorsAddRefusal(many)).toMatch(/at most 32 origins/);
        expect(frameAncestorsAddRefusal(many.slice(0, MAX_FRAME_ANCESTORS_PER_ADD))).toBeNull();
    });
});

describe('POST /api/settings/batch with frameAncestorsAdd', () => {
    it('adds the origins to config.json and to the live framing policy, keeping every other key', async () => {
        const configPath = setup({ ...BOOT, allowedHosts: ['devices.example.com'] });
        expect(securityHeaders()['Content-Security-Policy']).toBeUndefined();

        const r = await post([addChange(['http://localhost:5159', 'https://localhost:5159'])]);

        expect(r.getStatus()).toBe(200);
        expect(r.getJson()).toEqual({ ok: true, applied: [FRAME_ANCESTORS_ADD_ID] });
        expect(Config.getInstance().frameAncestors).toEqual(['http://localhost:5159', 'https://localhost:5159']);
        const written = readConfig(configPath);
        expect(written['frameAncestors']).toEqual(['http://localhost:5159', 'https://localhost:5159']);
        expect(written['webPort']).toBe(8000);
        expect(written['installMode']).toBe('user');
        expect(written['allowedHosts']).toEqual(['devices.example.com']);
        // Applied to the running server: no restart needed, like a consent approval.
        expect(securityHeaders()['Content-Security-Policy']).toBe(
            "frame-ancestors 'self' http://localhost:5159 https://localhost:5159",
        );
        // One journal row for the batch, completed.
        expect(walCount()).toBe(1);
        expect(walLast()?.status).toBe('completed');
    });

    it('adds to what a consent approval already granted, and an origin already allowed is not doubled', async () => {
        const configPath = setup({ ...BOOT, frameAncestors: ['http://localhost:5159'] });

        const r = await post([addChange(['http://localhost:5159', 'http://localhost:6000'])]);

        expect(r.getStatus()).toBe(200);
        expect(readConfig(configPath)['frameAncestors']).toEqual(['http://localhost:5159', 'http://localhost:6000']);
    });

    it('applies alongside other staged settings in one batch', async () => {
        setup();
        const r = await post([
            { id: 'autoUpdate', label: 'Automatic updates', from: true, to: false },
            addChange(['http://localhost:5159']),
        ]);

        expect(r.getStatus()).toBe(200);
        expect((r.getJson() as { applied: string[] }).applied).toEqual(['autoUpdate', FRAME_ANCESTORS_ADD_ID]);
        expect(Config.getInstance().getAppConfig().autoUpdate).toBe(false);
        expect(Config.getInstance().frameAncestors).toEqual(['http://localhost:5159']);
    });

    it('refuses the whole batch on one bad origin, before the WAL row and before any write', async () => {
        const configPath = setup({ ...BOOT, frameAncestors: ['http://localhost:5159'] });
        const before = fs.readFileSync(configPath, 'utf-8');

        const r = await post([
            { id: 'autoUpdate', label: 'Automatic updates', from: true, to: false },
            addChange(['http://localhost:6000', 'http://localhost:7000/path']),
        ]);

        expect(r.getStatus()).toBe(400);
        expect(r.getJson()).toEqual({
            ok: false,
            applied: [],
            failed: {
                id: FRAME_ANCESTORS_ADD_ID,
                error: 'not an http(s) origin with no path: "http://localhost:7000/path"',
            },
        });
        // Nothing half-landed: not the good origin, not the sibling setting.
        expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
        expect(Config.getInstance().frameAncestors).toEqual(['http://localhost:5159']);
        expect(Config.getInstance().getAppConfig().autoUpdate).not.toBe(false);
        expect(walCount()).toBe(0);
    });

    it('refuses an IPv6 origin with its own reason, before any write', async () => {
        const configPath = setup({ ...BOOT, frameAncestors: ['http://localhost:5159'] });
        const before = fs.readFileSync(configPath, 'utf-8');

        const r = await post([addChange(['http://localhost:6000', 'https://[::1]'])]);

        expect(r.getStatus()).toBe(400);
        expect(r.getJson()).toEqual({
            ok: false,
            applied: [],
            failed: { id: FRAME_ANCESTORS_ADD_ID, error: `"https://[::1]": ${IPV6_EMBEDDER_ERROR}` },
        });
        expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
        expect(Config.getInstance().frameAncestors).toEqual(['http://localhost:5159']);
        expect(walCount()).toBe(0);
    });

    it.each([
        ['a wildcard', ['*']],
        ['an empty list', []],
        ['a string instead of a list', 'http://localhost:5159'],
    ])('refuses %s', async (_name, to) => {
        setup();
        const r = await post([addChange(to)]);
        expect(r.getStatus()).toBe(400);
        expect((r.getJson() as { ok: boolean; failed: { id: string } }).failed.id).toBe(FRAME_ANCESTORS_ADD_ID);
        expect(Config.getInstance().frameAncestors).toEqual([]);
        expect(securityHeaders()['Content-Security-Policy']).toBeUndefined();
        expect(walCount()).toBe(0);
    });
});

describe('who may pre-approve an embedder', () => {
    it('a non-admin is refused by the route gate, and nothing is written', async () => {
        setup();
        const bob = Config.getInstance().db.users.create({ username: 'bob', role: 'user', passwordHash: 'x' });

        const r = await post([addChange(['http://localhost:5159'])], LOOPBACK, { id: bob.id });

        expect(r.getStatus()).toBe(403);
        expect(Config.getInstance().frameAncestors).toEqual([]);
        expect(walCount()).toBe(0);
    });

    it('an off-box admin let in by the remote-admin opt-out is still refused: embed permission is decided on this machine', async () => {
        setup();
        process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] = '1';

        const r = await post([addChange(['http://localhost:5159'])], OFF_BOX);

        expect(r.getStatus()).toBe(403);
        expect(r.getJson()).toEqual({
            ok: false,
            applied: [],
            failed: { id: FRAME_ANCESTORS_ADD_ID, error: EMBED_DECIDED_LOCALLY_ERROR },
        });
        expect(Config.getInstance().frameAncestors).toEqual([]);
        expect(walCount()).toBe(0);
    });

    it('the control: the same off-box caller can still save an ordinary setting', async () => {
        // Without this, a 403 above could be the route refusing every off-box
        // caller, and the embed-specific rule would be untested.
        setup();
        process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] = '1';

        const r = await post([{ id: 'autoUpdate', label: 'Automatic updates', from: true, to: false }], OFF_BOX);

        expect(r.getStatus()).toBe(200);
        expect(Config.getInstance().getAppConfig().autoUpdate).toBe(false);
    });

    it('an off-box caller without the opt-out never gets as far as the embed rule', async () => {
        setup();
        const r = await post([addChange(['http://localhost:5159'])], OFF_BOX);
        expect(r.getStatus()).toBe(403);
        expect(r.getJson()).toEqual({ error: 'admin actions are limited to this machine' });
    });
});

/**
 * An IPv6 entry left in config.json by a build before 0.5.3, which accepted one
 * though no browser ever honored it. Load skips it (with a warning, pinned in
 * config.frameAncestors.test.ts), so it is not listed and there is nothing live
 * to revoke. Deliberately, it survives an unrelated save (`saveToDisk` keeps
 * the raw key) and is dropped the next time the embedder list itself is
 * written, which writes the in-memory list whole.
 */
describe('an IPv6 entry from an older build', () => {
    const OLD = ['http://[::1]:47812', 'http://localhost:5159'];

    it('is skipped at load without stopping the server, and is not listed or in the policy', () => {
        setup({ ...BOOT, frameAncestors: OLD });

        expect(Config.getInstance().frameAncestors).toEqual(['http://localhost:5159']);
        expect(securityHeaders()['Content-Security-Policy']).toBe("frame-ancestors 'self' http://localhost:5159");
    });

    it('is kept in config.json through an unrelated save', async () => {
        const configPath = setup({ ...BOOT, frameAncestors: OLD });

        const r = await post([{ id: 'autoUpdate', label: 'Automatic updates', from: true, to: false }]);

        expect(r.getStatus()).toBe(200);
        expect(readConfig(configPath)['frameAncestors']).toEqual(OLD);
    });

    it('is dropped from config.json the next time the embedder list is written', async () => {
        const configPath = setup({ ...BOOT, frameAncestors: OLD });

        const r = await post([addChange(['http://localhost:6000'])]);

        expect(r.getStatus()).toBe(200);
        expect(readConfig(configPath)['frameAncestors']).toEqual(['http://localhost:5159', 'http://localhost:6000']);
    });
});

describe('Config.addFrameAncestors', () => {
    it('validates every entry before changing anything', () => {
        const configPath = setup({ ...BOOT, frameAncestors: ['http://localhost:5159'] });
        const before = fs.readFileSync(configPath, 'utf-8');

        expect(Config.getInstance().addFrameAncestors(['http://localhost:6000', '*'])).toBe(false);

        expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
        expect(Config.getInstance().frameAncestors).toEqual(['http://localhost:5159']);
    });

    it('normalizes what it stores, as addFrameAncestor does', () => {
        setup();
        expect(Config.getInstance().addFrameAncestors(['HTTP://LocalHost:80', 'https://Tools.Example:443'])).toBe(true);
        expect(Config.getInstance().frameAncestors).toEqual(['http://localhost', 'https://tools.example']);
    });

    it('refuses an empty list', () => {
        setup();
        expect(Config.getInstance().addFrameAncestors([])).toBe(false);
    });
});
