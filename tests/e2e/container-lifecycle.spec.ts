import { type Browser, type BrowserContext, expect, request, test } from '@playwright/test';
import { dismissPromptsFor, mintToken, newVisitorContext, openSettings, settingsSection } from './support/auth';
import {
    composeDown,
    composeRecreateKeepingVolume,
    composeUpFresh,
    dockerExecRoot,
    dockerInspectState,
    dockerStop,
    readVolumeFile,
} from './support/dockerStack';

/**
 * Smoke rows 20.6, 20.12 and 20.11 — the container's lifecycle from the
 * outside: the app's own "stop server & exit" from inside a container, a
 * `docker stop` from the host, and `docker rm` + a second `compose up` on the
 * same volume.
 *
 * All three are `@docker-host`: they drive a compose stack of their own through
 * the docker CLI (tests/docker/compose.lifecycle.yml, port 8132, its own
 * volume), so they run in this repo's CI and not under qa-harness, whose runner
 * has no docker CLI by design (tests/e2e/README.md). Each brings the stack up
 * fresh and tears it down in its `finally`.
 *
 * Row 12.1 already proves the bare server's clean exit; these are its container
 * half, where the interesting question is whether SIGTERM and the app's own
 * exit reach node *through* start.sh under `tini -g` (the 2026-09-03 finding:
 * without `-g`, `docker stop` gave exit 143 with the teardown unfinished).
 */

const FILE = 'compose.lifecycle.yml';
const CONTAINER = 'wssw-lifecycle';
const VOLUME = 'wssw-lifecycle_wsdata-lifecycle';
const BASE = 'http://127.0.0.1:8132';
const SERVER_LOG = '/data/logs/ws-scrcpy-web.log';
const TEARDOWN_LINE = 'Stopping adb daemon (kill-server)';
/** Docker's default `docker stop` grace before it SIGKILLs. */
const STOP_GRACE_MS = 10_000;

interface DependencyInfo {
    name: string;
    installedVersion: string | null;
    status: string;
}

async function waitForExit(timeoutMs: number): Promise<{ status: string; exitCode: number }> {
    const deadline = Date.now() + timeoutMs;
    let last = dockerInspectState(CONTAINER);
    while (last.status !== 'exited' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        last = dockerInspectState(CONTAINER);
    }
    return last;
}

/** Every dependency installed, polled: the first boot on a fresh volume hydrates them. */
async function waitForHydrate(baseURL: string, timeoutMs: number): Promise<DependencyInfo[]> {
    const ctx = await request.newContext({ baseURL });
    try {
        await mintToken(ctx);
        const deadline = Date.now() + timeoutMs;
        let deps: DependencyInfo[] = [];
        while (Date.now() < deadline) {
            deps = (await (await ctx.get('/api/dependencies')).json()) as DependencyInfo[];
            if (deps.length > 0 && deps.every((d) => d.installedVersion !== null)) return deps;
            await new Promise((r) => setTimeout(r, 1_000));
        }
        throw new Error(
            `dependencies not hydrated within ${timeoutMs} ms: ${deps.map((d) => `${d.name}=${d.installedVersion ?? d.status}`).join(', ')}`,
        );
    } finally {
        await ctx.dispose();
    }
}

test.describe('container lifecycle (smoke §20.6, §20.11, §20.12)', () => {
    let sharedBrowser: Browser;
    test.beforeAll(async ({ browser }) => {
        sharedBrowser = browser;
    });

    test('@docker @docker-host 20.12 `docker stop` exits 0 inside the default grace with the adb teardown logged, so nothing was SIGKILLed', async () => {
        test.setTimeout(600_000);
        composeUpFresh(FILE);
        try {
            // Let the first-run hydrate finish first: stopping mid-download would
            // put that abort in the log and blame it on the stop.
            await waitForHydrate(BASE, 300_000);
            expect(dockerInspectState(CONTAINER).status).toBe('running');

            const { elapsedMs } = dockerStop(CONTAINER);
            const state = dockerInspectState(CONTAINER);
            // 143 is SIGTERM unhandled, 137 is the SIGKILL after the grace; both
            // are the failure this row exists to catch.
            expect(state, 'docker inspect after stop').toEqual({ status: 'exited', exitCode: 0 });
            expect(elapsedMs, `docker stop took ${elapsedMs} ms; docker SIGKILLs at ${STOP_GRACE_MS} ms`).toBeLessThan(
                STOP_GRACE_MS,
            );
            // "the log shows Stopping adb daemon (kill-server)": the server log on
            // the volume, read off it directly — the container is stopped, and the
            // console echo is TTY-only so `docker logs` never carries it.
            expect(readVolumeFile(VOLUME, SERVER_LOG)).toContain(TEARDOWN_LINE);
        } finally {
            composeDown(FILE);
        }
    });

    test('@docker @docker-host 20.6 "stop server & exit" from inside a container reaches node through start.sh: the container exits 0 and is not restarted', async () => {
        test.setTimeout(600_000);
        composeUpFresh(FILE);
        let ctx: BrowserContext | undefined;
        try {
            await waitForHydrate(BASE, 300_000);
            // A fresh volume has no dismissed prompts; the bookmark reminder would
            // otherwise sit over the Settings button and swallow the click.
            const seed = await request.newContext({ baseURL: BASE });
            try {
                await mintToken(seed);
                await dismissPromptsFor(seed);
            } finally {
                await seed.dispose();
            }
            const visitor = await newVisitorContext(sharedBrowser, { baseURL: BASE });
            ctx = visitor.context;

            const settings = await openSettings(visitor.page);
            const stopBtn = settingsSection(settings, 'Server').getByRole('button', {
                name: 'stop server & exit',
                exact: true,
            });
            // The register's own ruling (row 20.6): this control must NOT be
            // gated in a container — it is exactly what `docker stop` relies on.
            await expect(stopBtn).toBeVisible();
            await expect(stopBtn).toBeEnabled();

            const shutdownRes = visitor.page.waitForResponse(
                (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/server/shutdown',
            );
            await stopBtn.click();
            const confirm = visitor.page.locator('dialog.confirm-modal');
            await expect(confirm).toBeVisible();
            await confirm.getByRole('button', { name: 'ok', exact: true }).click();
            expect((await shutdownRes).status()).toBe(200);

            // The whole container exits — node's exit 0 has to propagate through
            // start.sh's restart loop (it restarts only on 75 / the marker) and
            // through tini — and it stays exited: no restart policy, no respawn.
            const state = await waitForExit(60_000);
            expect(state, 'container state after stop server & exit').toEqual({ status: 'exited', exitCode: 0 });
            await new Promise((r) => setTimeout(r, 5_000));
            expect(dockerInspectState(CONTAINER).status, 'still exited 5 s later — not restarted').toBe('exited');
            expect(readVolumeFile(VOLUME, SERVER_LOG)).toContain(TEARDOWN_LINE);
        } finally {
            if (ctx) await ctx.close();
            composeDown(FILE);
        }
    });

    test('@docker @docker-host 20.11 `docker rm` + a second `compose up` on the same volume: the store, the hydrated dependencies and the log survive, and nothing re-downloads or re-prompts', async () => {
        test.setTimeout(900_000);
        composeUpFresh(FILE);
        let ctx: BrowserContext | undefined;
        try {
            const before = await waitForHydrate(BASE, 300_000);
            // Something in the SQLite store to survive: the prompt dismissals,
            // which are also what keeps the second boot's home page prompt-free.
            const seed = await request.newContext({ baseURL: BASE });
            let settingsBefore: Record<string, unknown>;
            try {
                await mintToken(seed);
                await dismissPromptsFor(seed);
                settingsBefore = (await (await seed.get('/api/settings')).json()) as Record<string, unknown>;
            } finally {
                await seed.dispose();
            }
            expect(settingsBefore['bookmarkDismissedGlobally']).toBe(true);
            const logBefore = dockerExecRoot(CONTAINER, `cat ${SERVER_LOG}`);
            const hydrateLines = (log: string) =>
                log.split('\n').filter((l) => l.includes('First-run: auto-installing')).length;
            expect(hydrateLines(logBefore), 'the first boot hydrated at least one dependency').toBeGreaterThan(0);
            const configBefore = dockerExecRoot(CONTAINER, 'cat /data/config.json 2>/dev/null || echo __absent__');

            composeRecreateKeepingVolume(FILE);

            // Dependencies: present at once, from the volume — no hydrate.
            const after = await waitForHydrate(BASE, 15_000);
            expect(after.map((d) => [d.name, d.installedVersion])).toEqual(
                before.map((d) => [d.name, d.installedVersion]),
            );
            // The store: the same rows, not a fresh database.
            const check = await request.newContext({ baseURL: BASE });
            try {
                await mintToken(check);
                const settingsAfter = (await (await check.get('/api/settings')).json()) as Record<string, unknown>;
                expect(settingsAfter).toEqual(settingsBefore);
            } finally {
                await check.dispose();
            }
            // The log: the first boot's lines are still there, appended to, and
            // the second boot did not hydrate again.
            const logAfter = dockerExecRoot(CONTAINER, `cat ${SERVER_LOG}`);
            expect(logAfter.length).toBeGreaterThan(logBefore.length);
            expect(logAfter.startsWith(logBefore.slice(0, 2000))).toBe(true);
            expect(hydrateLines(logAfter), 'no second first-run install').toBe(hydrateLines(logBefore));
            // config.json, when the first boot wrote one, is byte-identical.
            const configAfter = dockerExecRoot(CONTAINER, 'cat /data/config.json 2>/dev/null || echo __absent__');
            expect(configAfter).toBe(configBefore);
            // And the UI: no first-run prompt over the second boot's home page.
            const visitor = await newVisitorContext(sharedBrowser, { baseURL: BASE });
            ctx = visitor.context;
            await expect(visitor.page.getByRole('button', { name: 'Open settings' })).toBeVisible();
            await expect(visitor.page.locator('dialog[open]')).toHaveCount(0);
        } finally {
            if (ctx) await ctx.close();
            composeDown(FILE);
        }
    });
});
