import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigApi } from '../api/ConfigApi';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import { makeReqRes } from './helpers/httpMock';

/**
 * PATCH /api/config with a port change names the NEW PORT and nothing else.
 *
 * Until 2026-09-06 the response carried `redirectTo: "http://localhost:<port>"`,
 * a URL the server built for the browser to follow. The server cannot know the
 * host the browser is on — a LAN client, a hostname, a reverse proxy and the
 * qa-harness container runner were all sent to their own localhost and lost the
 * app (Arc 1b, smoke rows 4.3 / 12.2). The client now builds the URL itself
 * from `redirectPort` on the origin it already uses (`sameOriginUrl`).
 */

const tmpDirs: string[] = [];
const saved = {
    CONFIG: process.env[EnvName.CONFIG_PATH],
    DEPS: process.env['DEPS_PATH'],
    DATA_ROOT: process.env['DATA_ROOT'],
};

function setup(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wscfgapi-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webPort: 8000 }));
    process.env[EnvName.CONFIG_PATH] = path.join(dir, 'config.json');
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    // The handler writes the `.restart` marker under the data root. Point it at
    // the temp dir, never at the machine's real ProgramData root.
    process.env['DATA_ROOT'] = dir;
    Config._resetForTest();
    return dir;
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

describe('PATCH /api/config port change', () => {
    it('answers a port change with redirectPort and never a server-built URL', async () => {
        const dir = setup();
        // The handler schedules process.exit(75) one second after answering so
        // the supervisor restarts it on the new port. Neither may happen here:
        // fake the timer so it never fires, and stub exit in case it does.
        vi.useFakeTimers({ toFake: ['setTimeout'] });
        const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

        const { req, res, getStatus, getJson } = makeReqRes(
            'PATCH',
            '/api/config',
            { webPort: 8011 },
            {},
            { remoteAddress: '127.0.0.1' },
        );
        expect(await new ConfigApi().handle(req, res)).toBe(true);
        expect(getStatus()).toBe(200);

        const body = getJson() as Record<string, unknown>;
        expect(body['restartRequired']).toBe(true);
        expect(body['redirectPort']).toBe(8011);
        expect(body).not.toHaveProperty('redirectTo');
        // The whole contract in one line: nothing in the answer names a host.
        expect(JSON.stringify(body)).not.toContain('localhost');

        // The restart half still fires: the marker is written, the exit is
        // scheduled but has not happened.
        expect(fs.existsSync(path.join(dir, '.restart'))).toBe(true);
        expect(exit).not.toHaveBeenCalled();
    });

    it('omits redirectPort when nothing needs a restart', async () => {
        setup();
        const { req, res, getStatus, getJson } = makeReqRes(
            'PATCH',
            '/api/config',
            { firstRunComplete: true },
            {},
            { remoteAddress: '127.0.0.1' },
        );
        expect(await new ConfigApi().handle(req, res)).toBe(true);
        expect(getStatus()).toBe(200);
        const body = getJson() as Record<string, unknown>;
        expect(body['restartRequired']).toBe(false);
        expect(body).not.toHaveProperty('redirectPort');
        expect(body).not.toHaveProperty('redirectTo');
    });
});

// The settings batch's equal-ports rule, applied to the other writer of the web
// port (after 0.5.3): refused only while a certificate exists (portCollision.ts).
describe('PATCH /api/config webPort on the https port', () => {
    const patch = async (webPort: unknown, certReady: () => boolean) => {
        const { req, res, getStatus, getJson } = makeReqRes(
            'PATCH',
            '/api/config',
            { webPort },
            {},
            { remoteAddress: '127.0.0.1' },
        );
        await new ConfigApi({ certReady }).handle(req, res);
        return { status: getStatus(), body: getJson() as Record<string, unknown> };
    };

    it('409s naming the field when a certificate exists, and writes nothing', async () => {
        const dir = setup();
        const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf-8');
        const { status, body } = await patch(8443, () => true);
        expect(status).toBe(409);
        expect(body).toEqual({ error: 'the http and https ports must differ (both would be 8443)', field: 'webPort' });
        expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8')).toBe(before);
        expect(fs.existsSync(path.join(dir, '.restart'))).toBe(false);
    });

    it('accepts 8443 when there is no certificate, as it always did', async () => {
        const dir = setup();
        vi.useFakeTimers({ toFake: ['setTimeout'] });
        vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
        const { status, body } = await patch(8443, () => false);
        expect(status).toBe(200);
        expect(body['redirectPort']).toBe(8443);
        expect(fs.existsSync(path.join(dir, '.restart'))).toBe(true);
    });

    it('leaves an invalid port to updateAppConfig, whose 400 names the field', async () => {
        setup();
        const certReady = vi.fn(() => true);
        const { status, body } = await patch(80, certReady);
        expect(status).toBe(400);
        expect(body['field']).toBe('webPort');
        expect(certReady).not.toHaveBeenCalled();
    });
});
