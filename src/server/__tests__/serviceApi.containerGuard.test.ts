import * as fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ServiceApi } from '../api/ServiceApi';
import { Config } from '../Config';
import { EnvName } from '../EnvName';

/**
 * Findings 20.4 and 20.5 — Settings offered two install-lifecycle actions that
 * cannot work in a container. "Install for all users" runs pkexec, relocates
 * the app to /opt and re-execs; a container has no polkit and relocating inside
 * the image is meaningless. "Uninstall" tears down a service and an install
 * that do not exist there; the container's equivalent is `docker rm`.
 *
 * Hiding the rows is the cosmetic half. This is the half that holds when the
 * route is POSTed directly, which is what keeps the UI gating from having to be
 * a security boundary.
 */

const tmpDirs: string[] = [];
const saved = {
    CONFIG: process.env[EnvName.CONFIG_PATH],
    DEPS: process.env['DEPS_PATH'],
    DOCKER: process.env['WS_SCRCPY_DOCKER'],
};

function setup(docker: boolean): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-svc-docker-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webPort: 8000 }));
    process.env[EnvName.CONFIG_PATH] = path.join(dir, 'config.json');
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    if (docker) process.env['WS_SCRCPY_DOCKER'] = '1';
    else delete process.env['WS_SCRCPY_DOCKER'];
    Config._resetForTest();
}

afterEach(() => {
    Config._resetForTest();
    for (const [k, v] of [
        [EnvName.CONFIG_PATH, saved.CONFIG],
        ['DEPS_PATH', saved.DEPS],
        ['WS_SCRCPY_DOCKER', saved.DOCKER],
    ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function makeReqRes(url: string) {
    const req = {
        url,
        method: 'POST',
        headers: {},
        on(event: string, handler: (...args: unknown[]) => void) {
            if (event === 'end') queueMicrotask(() => handler());
            return this;
        },
    } as unknown as IncomingMessage;
    let statusCode = 0;
    const chunks: string[] = [];
    const res = {
        writeHead(code: number) {
            statusCode = code;
            return res;
        },
        setHeader() {},
        end(c?: string) {
            if (c) chunks.push(c);
        },
    } as unknown as ServerResponse;
    return { req, res, status: () => statusCode, json: () => JSON.parse(chunks.join('')) };
}

describe('ServiceApi install-lifecycle routes in a container', () => {
    for (const url of ['/api/service/install-system-wide', '/api/service/uninstall-app']) {
        it(`refuses ${url} with 409 and copy that names the container`, async () => {
            setup(true);
            const api = new ServiceApi();
            const { req, res, status, json } = makeReqRes(url);

            expect(await api.handle(req, res)).toBe(true);
            expect(status()).toBe(409);

            const body = json();
            expect(body.ok).toBe(false);
            // 409, not 403: the caller is permitted, the action does not apply.
            expect(body.reason).toBe('unsupported');
            // The copy has to name the container and the real remedy, or the
            // user is left with a refusal and nowhere to go.
            expect(body.error).toMatch(/container/i);
            expect(body.error).toMatch(/docker rm/);
        });
    }

    it('does not refuse them on a host, where they are the whole point', async () => {
        setup(false);
        const api = new ServiceApi();
        const { req, res, status } = makeReqRes('/api/service/install-system-wide');

        await api.handle(req, res);

        // Whatever a host answers, it is not the container refusal.
        expect(status()).not.toBe(409);
    });
});
