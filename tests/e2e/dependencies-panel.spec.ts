import { type Browser, type BrowserContext, expect, request, test } from '@playwright/test';
import {
    dismissPromptsFor,
    e2eBaseUrl,
    expectLoginPage,
    fetchFromPage,
    lockdown,
    loginAs,
    me,
    mintToken,
    newVisitorContext,
} from './support/auth';
import { gotoHome } from './support/consent';
import { composeDown, composeUpFresh, dockerExecRoot, dockerLogs } from './support/dockerStack';
import {
    privateServerPaths,
    type ServerHandle,
    seedPrivateDataRoot,
    spawnServer,
    stopServer,
    waitForServer,
} from './support/privateServer';

/**
 * Smoke rows 9.4, 9.5 and 1.9 — the dependencies panel, the shell-unavailable
 * reason, and the first-run bootstrap banner.
 *
 * 9.4's open-mode half runs on the shared server; its admin-gating half needs
 * locked mode and gets a spec-owned server so the shared one's auth state is
 * never touched. 9.5 and 1.9 need hosts the fast tier cannot be — one without
 * the node-pty prebuilt, one with no working resolver — so they are `@docker`
 * and bring up their own compose stacks (tests/docker/), on their own ports,
 * beside the main stack the docker config starts.
 */

interface DependencyInfo {
    name: string;
    displayName: string;
    installedVersion: string | null;
    latestVersion: string | null;
    status: string;
    errorMessage?: string;
}

test.describe('dependencies (smoke §9.4, §9.5, §1.9)', () => {
    let sharedBrowser: Browser;
    test.beforeAll(async ({ browser }) => {
        sharedBrowser = browser;
    });

    test('9.4 the Dependencies panel lists every dependency with its installed version, check-for-updates fills Latest, and the whole surface is admin-only', async () => {
        test.setTimeout(240_000);

        // --- open mode, shared server: the table loads and the check populates Latest.
        const visitor = await newVisitorContext(sharedBrowser);
        try {
            const api = visitor.context.request;
            // The fast tier's server downloads its dependencies at boot; wait for
            // that to land rather than assert a table of "Not installed".
            await expect
                .poll(
                    async () =>
                        ((await (await api.get('/api/dependencies')).json()) as DependencyInfo[]).every(
                            (d) => d.installedVersion !== null,
                        ),
                    { timeout: 120_000, message: 'first-run install to finish on the shared server' },
                )
                .toBe(true);
            const deps = (await (await api.get('/api/dependencies')).json()) as DependencyInfo[];
            // node-pty is not a managed dependency (it rides on nodejs as `pairedWith`).
            expect(deps.map((d) => d.name).sort()).toEqual(['adb', 'nodejs', 'scrcpy-server']);

            await gotoHome(visitor.page);
            const panel = visitor.page.locator('#dependency-panel');
            await expect(panel).toBeVisible();
            await expect(panel.locator('h2')).toHaveText('Dependencies');
            await expect(panel.locator('thead th')).toHaveText([
                'Dependency',
                'Installed',
                'Latest',
                'Status',
                'Action',
            ]);
            const rows = panel.locator('tbody tr.dep-row');
            await expect(rows).toHaveCount(deps.length);
            for (const dep of deps) {
                const row = rows.filter({ hasText: dep.displayName });
                await expect(row).toHaveCount(1);
                await expect(row.locator('td.dep-version').first()).toHaveText(dep.installedVersion ?? '');
                await expect(row.locator('td.dep-version').first()).not.toHaveText('Not installed');
            }

            // check for updates: the real POST, then every Latest cell filled.
            const checked = visitor.page.waitForResponse(
                (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/dependencies/check',
            );
            await panel.locator('button.dep-check-all').click();
            expect((await checked).status()).toBe(200);
            await expect(panel.locator('button.dep-check-all')).toHaveText('check for updates');
            const after = (await (await api.get('/api/dependencies')).json()) as DependencyInfo[];
            for (const dep of after) {
                expect(dep.latestVersion, `${dep.name}.latestVersion after the check`).not.toBeNull();
                const row = rows.filter({ hasText: dep.displayName });
                await expect(row.locator('td.dep-version').nth(1)).toHaveText(dep.latestVersion ?? '');
                await expect(row.locator('td.dep-version').nth(1)).not.toHaveText('—');
            }
            // NOT covered here, and said so: "run a per-dependency update, then
            // restart server" needs an update to be AVAILABLE — the update button
            // renders only for status 'update-available' — which an up-to-date
            // install cannot offer deterministically. The restart route itself is
            // proven by 10.4 and 18.12.
        } finally {
            await visitor.context.close();
        }

        // --- locked mode, spec-owned server: a user-role account is refused by
        // the server and sees no table, and a direct admin request is rejected.
        const paths = privateServerPaths('ws-scrcpy-web-e2e-deps-authz', 8131);
        seedPrivateDataRoot(paths);
        const handle: ServerHandle = spawnServer(paths);
        let userCtx: BrowserContext | undefined;
        let adminCtx: BrowserContext | undefined;
        try {
            await waitForServer(handle, paths.baseURL);
            const setup = await request.newContext({ baseURL: paths.baseURL });
            try {
                await mintToken(setup);
                const locked = await lockdown(setup, {
                    adminUsername: 'deps-admin',
                    adminPassword: 'deps-admin-pw',
                    username: 'deps-user',
                    password: 'deps-user-pw',
                    role: 'user',
                });
                expect(locked.status()).toBe(201);
                expect(await locked.json()).toEqual({ ok: true });
            } finally {
                await setup.dispose();
            }

            const user = await newVisitorContext(sharedBrowser, { baseURL: paths.baseURL });
            userCtx = user.context;
            await expectLoginPage(user.page);
            expect(
                (await loginAs(user.context.request, { username: 'deps-user', password: 'deps-user-pw' })).status(),
            ).toBe(200);
            expect((await me(user.context.request)).user?.role).toBe('user');
            await user.context.request.patch('/api/settings', {
                data: { bookmarkDismissedGlobally: true, serviceFirstRunSeen: true },
            });
            // The server half, exactly: 403 {"error":"forbidden"} on the read and
            // on the smoke row's direct POST, with strict bodies so a token-gate
            // 403 (which carries a `reason`) cannot pass for it.
            const read = await user.context.request.get('/api/dependencies');
            expect(read.status()).toBe(403);
            expect(await read.json()).toEqual({ error: 'forbidden' });
            await user.page.goto('/');
            const direct = await fetchFromPage(user.page, '/api/dependencies/adb/update', { method: 'POST' });
            expect(direct.status).toBe(403);
            expect(direct.body).toEqual({ error: 'forbidden' });
            // The UI half: the panel is not mounted at all. It used to render
            // its failure state instead — "Failed to load dependencies" — so the
            // row's "doesn't see it" was the panel FAILING rather than the panel
            // being GATED. An authorization boundary that manifests as an error
            // message reads as a bug to the user and as coverage to the
            // checklist, which is register finding 9.6.
            await expect(user.page.locator('#dependency-panel')).toHaveCount(0);

            // Contrast: the admin on the same server gets the rows.
            const admin = await newVisitorContext(sharedBrowser, { baseURL: paths.baseURL });
            adminCtx = admin.context;
            expect(
                (await loginAs(admin.context.request, { username: 'deps-admin', password: 'deps-admin-pw' })).status(),
            ).toBe(200);
            await admin.context.request.patch('/api/settings', {
                data: { bookmarkDismissedGlobally: true, serviceFirstRunSeen: true },
            });
            expect((await admin.context.request.get('/api/dependencies')).status()).toBe(200);
            await admin.page.goto('/');
            await expect(admin.page.locator('#dependency-panel tbody tr.dep-row').first()).toBeVisible();
            await expect(admin.page.locator('#dependency-panel td.dep-error-msg')).toHaveCount(0);
        } finally {
            if (userCtx) await userCtx.close();
            if (adminCtx) await adminCtx.close();
            try {
                await stopServer(handle);
            } catch (err) {
                console.warn(`9.4 cleanup: ${String(err)}`);
            }
        }
    });

    test('@docker @docker-host 9.5 a host without the node-pty prebuilt reports shell:false with a reason, where the full image reports shell:true', async () => {
        test.setTimeout(600_000);
        const FILE = 'compose.no-node-pty.yml';
        const BASE = 'http://127.0.0.1:8125';
        composeUpFresh(FILE, { build: true });
        try {
            const ctx = await request.newContext({ baseURL: BASE });
            try {
                await mintToken(ctx);
                const caps = await ctx.get('/api/capabilities');
                expect(caps.status()).toBe(200);
                // The reason is the point: the affordance must not vanish silently.
                expect(await caps.json()).toEqual({ shell: false, shellReason: 'no-seed-package' });
                // Still behind the instance token like every /api route.
                const bare = await request.newContext({ baseURL: BASE });
                try {
                    expect((await bare.get('/api/capabilities')).status()).toBe(403);
                } finally {
                    await bare.dispose();
                }
            } finally {
                await ctx.dispose();
            }
            // Contrast on the full image the docker config started: the prebuilt
            // is there, so shell is available and no reason is reported.
            const full = await request.newContext({ baseURL: e2eBaseUrl() });
            try {
                await mintToken(full);
                expect(await (await full.get('/api/capabilities')).json()).toEqual({ shell: true });
            } finally {
                await full.dispose();
            }
            // NOT covered here, and said so: the per-device shell link's tooltip
            // ("shell unavailable — node-pty seed not staged. …") needs a tracked
            // device to render the link at all; that is the device tier's row.
        } finally {
            composeDown(FILE);
        }
    });

    test('@docker @docker-host 1.9 a failed first-run download shows the setup-incomplete banner, and Retry clears it once the network is back', async () => {
        test.setTimeout(600_000);
        const FILE = 'compose.offline.yml';
        const CONTAINER = 'wssw-offline';
        const BASE = 'http://127.0.0.1:8124';
        // The stack has no working resolver, so every download fails at once.
        // `up --wait` still reports healthy: the HEALTHCHECK probes loopback only.
        composeUpFresh(FILE);
        let ctx: BrowserContext | undefined;
        try {
            // A fresh volume has no dismissed prompts; the bookmark reminder would
            // otherwise sit over the banner's Retry button.
            const seed = await request.newContext({ baseURL: BASE });
            try {
                await mintToken(seed);
                await dismissPromptsFor(seed);
            } finally {
                await seed.dispose();
            }
            const visitor = await newVisitorContext(sharedBrowser, { baseURL: BASE });
            ctx = visitor.context;
            const api = visitor.context.request;

            // The failed state, server-side first: nothing installed, each in error.
            const failed = (await (await api.get('/api/dependencies')).json()) as DependencyInfo[];
            expect(failed.length).toBeGreaterThan(0);
            for (const dep of failed) {
                expect(dep.installedVersion, dep.name).toBeNull();
                expect(dep.status, dep.name).toBe('error');
                expect(dep.errorMessage, dep.name).toBe('fetch failed');
            }

            // The banner, verbatim in shape: the icon, the sentence naming what
            // failed, and Retry.
            const banner = visitor.page.locator('.first-run-banner');
            await expect(banner).toBeVisible();
            const text = banner.locator('.first-run-banner-text');
            await expect(text).toContainText('Setup incomplete —');
            await expect(text).toContainText('failed to download. Check your network connection.');
            await expect(text).toContainText('ADB (Android Debug Bridge)');
            const retry = banner.locator('button.first-run-banner-retry');
            await expect(retry).toHaveText('Retry');

            // "Restore network": give the container a resolver. Root exec, as the
            // container runs the app as uid 1000.
            dockerExecRoot(CONTAINER, "printf 'nameserver 8.8.8.8\\nnameserver 1.1.1.1\\n' > /etc/resolv.conf");

            const retried = visitor.page.waitForResponse(
                (r) =>
                    r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/dependencies/retry-install',
            );
            await retry.click();
            const res = await retried;
            expect(res.status()).toBe(200);
            const body = (await res.json()) as {
                success: boolean;
                installed: string[];
                stillMissing: string[];
                errors: Record<string, string>;
            };
            // adb can still be mid-download when the reply is written; what must
            // not happen is an error.
            expect(body.errors).toEqual({});
            expect(body.installed.length + body.stillMissing.length).toBeGreaterThan(0);

            // Then everything lands, and the banner clears on its own poll.
            await expect
                .poll(
                    async () => {
                        const deps = (await (await api.get('/api/dependencies')).json()) as DependencyInfo[];
                        return deps.every((d) => d.installedVersion !== null && d.status !== 'error');
                    },
                    { timeout: 180_000, message: 'every dependency installed after Retry' },
                )
                .toBe(true);
            await expect(banner).toBeHidden({ timeout: 30_000 });
        } catch (err) {
            console.warn(`1.9 container log:\n${dockerLogs(CONTAINER).slice(-3000)}`);
            throw err;
        } finally {
            if (ctx) await ctx.close();
            composeDown(FILE);
        }
    });
});
