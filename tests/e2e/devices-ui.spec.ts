import {
    type APIRequestContext,
    type Browser,
    type BrowserContext,
    expect,
    type Locator,
    type Page,
    test,
} from '@playwright/test';
import { type Credentials, dismissPromptsFor, expectAppShell, loginAs } from './support/auth';
import { gotoHome } from './support/consent';
import { countFetches, fetchCount } from './support/fetchCounter';
import {
    isolatedAdb,
    type LockedPrivateServer,
    PRIVATE_ADMIN,
    PRIVATE_USER,
    startLockedPrivateServer,
} from './support/lockedServer';
import { waitForDependencies } from './support/privateServer';

/**
 * Smoke rows 7.10, 7.11, 7.13 and 7.14 — the fast-tier halves, with no device.
 *
 * "No device" has to be made true, not assumed. The machine's adb daemon (5037)
 * auto-connects every paired device advertising on the LAN, so on a
 * developer's box the shared server lists real devices and a quick scan finds
 * them (measured 2026-10-05: a Google TV Streamer). The rows whose subject IS
 * the empty case — 7.10 and 7.13 — therefore run on a spec-owned server with an
 * adb daemon of its own (port 8183, mDNS discovery off), and check that
 * daemon out of band before judging the page.
 *
 * Nothing here scans a real network. 7.10's quick scan is mDNS only, and 7.11
 * routes the scan socket to a stub that never reaches the server, so even the
 * scan it starts on purpose touches nothing.
 *
 * 7.11 and 7.14's non-admin case need users, so that server is locked (8182).
 * 7.14's other cases run on the shared server and leave no pairing session
 * behind.
 *
 * Row 8.30 (slow-client shedding, stuck-CLOSING termination) is NOT here: both
 * mechanisms act only on a live scrcpy session's media, which needs a device.
 */

test.use({ locale: 'en-US' });

/** Copied from src/server/pairing/PairingService.ts (SUPERSEDED_MESSAGE) and PairingSession.ts (PAIRING_TTL_MS). */
const SUPERSEDED_MESSAGE = 'This pairing attempt was replaced by a newer one. Continue in the new attempt.';
const PAIRING_TTL_MS = 180_000;
/** Copied from src/app/client/NetworkDiscoveryPanel.ts. */
const QR_PROMPT = 'Scan this code on the phone: Wireless debugging → Pair device with QR code.';
const EXPIRED_TEXT = 'The pairing window closed. Start again to get a fresh code.';
const NEEDS_ADMIN = 'Pairing needs an admin account. Ask an administrator to pair this device.';
const MDNS_SCANNING = 'scanning over mDNS…';
const MDNS_NONE = 'No devices advertising over mDNS. Try scan network for a full subnet probe.';
/** Copied from src/server/api/PairingApi.ts. */
const BAD_ADDRESS = 'address must be IP:port, as shown on the phone';
const BAD_CODE = 'code must be the numeric pairing code shown on the phone';
const NO_SUCH_SESSION = 'no such pairing session';

function discoveryPanel(page: Page): Locator {
    return page.locator('#discovery-panel');
}

function pairingSection(page: Page): Locator {
    return page.locator('#discovery-panel .discovery-pairing');
}

async function startQrFromUi(page: Page): Promise<{ sessionId: string; svg: string; expiresInMs: number }> {
    const qrResponse = page.waitForResponse(
        (r) => new URL(r.url()).pathname === '/api/devices/pair/qr' && r.request().method() === 'POST',
    );
    await pairingSection(page).getByRole('button', { name: 'scan QR code', exact: true }).click();
    const res = await qrResponse;
    expect(res.status()).toBe(200);
    return (await res.json()) as { sessionId: string; svg: string; expiresInMs: number };
}

async function pairStatus(ctx: APIRequestContext, sessionId: string): Promise<{ status: number; body: unknown }> {
    const res = await ctx.get(`/api/devices/pair/status?sessionId=${encodeURIComponent(sessionId)}`);
    return { status: res.status(), body: await res.json() };
}

/** Drop a pairing session through the API, and prove it is gone. */
async function cancelPairing(ctx: APIRequestContext, sessionId: string): Promise<void> {
    const res = await ctx.post('/api/devices/pair/cancel', { data: { sessionId } });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await pairStatus(ctx, sessionId)).toEqual({ status: 404, body: { error: NO_SUCH_SESSION } });
}

test.describe('7.14 pairing edges, shared server', () => {
    test('7.14 cancelling a QR pairing clears the code and stops the polling', async ({ page }) => {
        await countFetches(page, ['/api/devices/pair/status']);
        await page.clock.install();
        await gotoHome(page);
        const section = pairingSection(page);
        await expect(section.locator('.discovery-pairing-title')).toHaveText('Pair a new device');

        const qr = await startQrFromUi(page);
        expect(qr).toEqual({
            sessionId: expect.any(String),
            svg: expect.stringContaining('<svg'),
            expiresInMs: PAIRING_TTL_MS,
        });
        const qrBox = section.locator('[data-pair-qr]');
        const status = section.locator('[data-pair-status]');
        const cancel = section.getByRole('button', { name: 'cancel', exact: true });
        await expect(qrBox.locator('svg')).toBeVisible();
        await expect(status).toHaveText(`${QR_PROMPT} It stops working in about 3 minutes.`);
        await expect(cancel).toBeVisible();

        // Polling is live before the cancel...
        await page.clock.runFor(2_500);
        await expect.poll(() => fetchCount(page, '/api/devices/pair/status')).toBeGreaterThan(0);

        await cancel.click();
        await expect(status).toHaveText('Pairing cancelled.');
        await expect(qrBox).toBeHidden();
        await expect(qrBox.locator('svg')).toHaveCount(0);
        await expect(cancel).toBeHidden();

        // ...and stopped after it: five poll intervals on the page's clock, and
        // not one more status request.
        const atCancel = await fetchCount(page, '/api/devices/pair/status');
        await page.clock.runFor(5_000);
        expect(await fetchCount(page, '/api/devices/pair/status')).toBe(atCancel);

        // Server side: the cancel dropped the session.
        await expect
            .poll(() => pairStatus(page.request, qr.sessionId))
            .toEqual({ status: 404, body: { error: NO_SUCH_SESSION } });
    });

    test('7.14 an expired QR pairing offers start again, which starts a fresh one', async ({ page }) => {
        await gotoHome(page);
        const section = pairingSection(page);
        const status = section.locator('[data-pair-status]');
        const qrBox = section.locator('[data-pair-qr]');
        const action = section.locator('[data-pair-action]');

        // The real TTL is three minutes; the status read is stubbed to the state
        // the server reports once it has passed.
        const isStatus = (url: URL) => url.pathname === '/api/devices/pair/status';
        await page.route(isStatus, (route) =>
            route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'expired' }) }),
        );
        const first = await startQrFromUi(page);
        await expect(status).toHaveText(EXPIRED_TEXT);
        await expect(status).not.toHaveClass(/\berror\b/);
        await expect(action).toBeVisible();
        await expect(action).toHaveText('start again');
        await expect(qrBox).toBeHidden();
        await expect(section.getByRole('button', { name: 'cancel', exact: true })).toBeHidden();

        await page.unroute(isStatus);
        const fresh = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/devices/pair/qr');
        await action.click();
        const second = (await (await fresh).json()) as { sessionId: string };
        expect(second.sessionId).not.toBe(first.sessionId);
        await expect(qrBox.locator('svg')).toBeVisible();
        await expect(status).toHaveText(`${QR_PROMPT} It stops working in about 3 minutes.`);
        await expect(action).toBeHidden();

        await section.getByRole('button', { name: 'cancel', exact: true }).click();
        await expect(status).toHaveText('Pairing cancelled.');
        await expect
            .poll(() => pairStatus(page.request, second.sessionId))
            .toEqual({ status: 404, body: { error: NO_SUCH_SESSION } });
    });

    test('7.14 a second pairing attempt replaces the first, and the first one says so', async ({ page }) => {
        await gotoHome(page);
        const section = pairingSection(page);
        const status = section.locator('[data-pair-status]');
        const first = await startQrFromUi(page);
        await expect(section.locator('[data-pair-qr] svg')).toBeVisible();

        // Another attempt from elsewhere (a second tab, another browser).
        const res = await page.request.post('/api/devices/pair/qr');
        expect(res.status()).toBe(200);
        const second = (await res.json()) as { sessionId: string };
        try {
            await expect(status).toHaveText(SUPERSEDED_MESSAGE);
            await expect(status).toHaveClass(/\berror\b/);
            await expect(section.locator('[data-pair-action]')).toHaveText('start again');
            await expect(section.locator('[data-pair-qr]')).toBeHidden();

            expect(await pairStatus(page.request, first.sessionId)).toEqual({
                status: 200,
                body: { state: 'failed', message: SUPERSEDED_MESSAGE },
            });
            // The control: the newer attempt is the live one.
            expect(await pairStatus(page.request, second.sessionId)).toMatchObject({
                status: 200,
                body: { state: 'awaiting-scan' },
            });
        } finally {
            await cancelPairing(page.request, second.sessionId);
        }
    });

    test('7.14 a bad pairing address or code is refused with 400, and an unknown session id with 404', async ({
        page,
    }) => {
        await gotoHome(page);
        const api = page.request;

        const badAddress = await api.post('/api/devices/pair/code', {
            data: { address: 'phone-without-a-port', code: '123456' },
        });
        expect(badAddress.status()).toBe(400);
        expect(await badAddress.json()).toEqual({ error: BAD_ADDRESS });
        const badCode = await api.post('/api/devices/pair/code', {
            data: { address: '192.168.250.10:41415', code: '12ab' },
        });
        expect(badCode.status()).toBe(400);
        expect(await badCode.json()).toEqual({ error: BAD_CODE });

        const unknown = await pairStatus(api, 'e2e-164d-made-up-session');
        expect(unknown).toEqual({ status: 404, body: { error: NO_SUCH_SESSION } });

        // The same 400s, as the pairing-code form shows them.
        const section = pairingSection(page);
        const status = section.locator('[data-pair-status]');
        await section.getByRole('button', { name: 'pairing code', exact: true }).click();
        const address = section.getByRole('textbox', { name: 'pairing address shown on the phone' });
        const code = section.getByRole('textbox', { name: 'pairing code shown on the phone' });
        await address.fill('phone-without-a-port');
        await code.fill('123456');
        await section.getByRole('button', { name: 'pair', exact: true }).click();
        await expect(status).toHaveText(BAD_ADDRESS);
        await expect(status).toHaveClass(/\berror\b/);
        await address.fill('192.168.250.10:41415');
        await code.fill('12ab');
        await section.getByRole('button', { name: 'pair', exact: true }).click();
        await expect(status).toHaveText(BAD_CODE);
        await expect(status).toHaveClass(/\berror\b/);

        // The control: a well-formed address and code are accepted and become a
        // session that the status route knows. Aimed at a closed loopback port
        // (8187 is in this batch's range and never bound), so `adb pair` fails
        // fast and touches nothing; waited out so no pair is left in flight.
        const good = await api.post('/api/devices/pair/code', { data: { address: '127.0.0.1:8187', code: '123456' } });
        expect(good.status()).toBe(200);
        const { sessionId } = (await good.json()) as { sessionId: string };
        expect(sessionId).toEqual(expect.any(String));
        await expect
            .poll(async () => (await pairStatus(api, sessionId)).body, { timeout: 30_000 })
            .toMatchObject({ state: 'failed' });
        expect((await pairStatus(api, sessionId)).status).toBe(200);
    });
});

/**
 * A browser context signed in to `baseURL` as `creds`, on the app shell.
 * `prepare` runs before the app document loads — where a WebSocket route has
 * to be installed for the page to honour it.
 */
async function signedIn(
    browser: Browser,
    baseURL: string,
    creds: Credentials,
    prepare?: (page: Page) => Promise<void>,
): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({ baseURL, locale: 'en-US' });
    const page = await context.newPage();
    await page.goto('/'); // the login page; mints the instance token
    expect((await loginAs(context.request, creds)).status(), `login as ${creds.username}`).toBe(200);
    await dismissPromptsFor(context.request);
    if (prepare) await prepare(page);
    await page.goto('/');
    await expectAppShell(page);
    return { context, page };
}

function etaFor(totalHosts: number): string {
    // The rate the dialog states: "roughly 30 seconds per 1,000 hosts".
    const seconds = Math.round((totalHosts / 1000) * 30);
    if (seconds < 60) return `${seconds} seconds`;
    const minutes = Math.round(seconds / 60);
    return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

test.describe('7.10, 7.11, 7.13 and 7.14 on a spec-owned server with its own adb daemon', () => {
    let server: LockedPrivateServer | undefined;
    const contexts: BrowserContext[] = [];

    test.beforeAll(async () => {
        test.setTimeout(180_000);
        server = await startLockedPrivateServer('ws-scrcpy-web-e2e-164d-devices', 8182, { isolatedAdbPort: 8183 });
    });

    test.afterEach(async () => {
        while (contexts.length) await contexts.pop()?.close();
    });

    test.afterAll(async () => {
        await server?.stop();
    });

    function live(): LockedPrivateServer {
        if (!server) throw new Error('the private server did not start');
        return server;
    }

    test('7.13 with no device connected the list says No devices connected and shows no device card', async ({
        browser,
    }) => {
        test.setTimeout(180_000);
        const srv = live();
        const admin = await signedIn(browser, srv.paths.baseURL, PRIVATE_ADMIN);
        contexts.push(admin.context);
        await waitForDependencies(admin.context.request, 120_000, ['adb']);

        // Out of band, the server's own daemon: nothing attached.
        await expect
            .poll(() =>
                isolatedAdb(srv, 'devices')
                    .split(/\r?\n/)
                    .map((l) => l.trim())
                    .filter((l) => l && !l.startsWith('*')),
            )
            .toEqual(['List of devices attached']);

        await admin.page.reload();
        const empty = admin.page.locator('#devices .empty-state-card');
        await expect(empty).toBeVisible();
        await expect(empty).toHaveText('No devices connected.');
        await expect(admin.page.locator('#devices .device')).toHaveCount(0);
    });

    test('7.10 quick scan with nothing advertising shows the mDNS line, then the no-devices message', async ({
        browser,
    }) => {
        test.setTimeout(180_000);
        const srv = live();

        // A pass-through to the REAL server that holds its replies until the
        // in-progress line has been seen: a scan with nothing to find can finish
        // faster than an assertion can catch the line in between.
        const toServer: unknown[] = [];
        const fromServer: { type?: string; found?: number }[] = [];
        let release: () => void = () => {};
        const released = new Promise<void>((resolve) => {
            release = resolve;
        });
        const admin = await signedIn(browser, srv.paths.baseURL, PRIVATE_ADMIN, async (page) => {
            await page.routeWebSocket(/\/ws-scan$/, (ws) => {
                const upstream = ws.connectToServer();
                ws.onMessage((message) => {
                    toServer.push(JSON.parse(String(message)));
                    upstream.send(message);
                });
                upstream.onMessage(async (message) => {
                    fromServer.push(JSON.parse(String(message)) as { type?: string });
                    await released;
                    ws.send(message);
                });
            });
        });
        contexts.push(admin.context);
        const { page } = admin;
        // A scan before adb is on disk answers "adb daemon not ready" — true, but not this row.
        await waitForDependencies(admin.context.request, 120_000, ['adb']);
        // Out of band: the server's daemon sees nothing advertising.
        expect(isolatedAdb(srv, 'mdns', 'services').trim()).toBe('List of discovered mdns services');

        const info = discoveryPanel(page).locator('.discovery-info');
        await discoveryPanel(page).getByRole('button', { name: 'quick scan', exact: true }).click();
        await expect(info).toHaveText(MDNS_SCANNING);

        await expect.poll(() => fromServer.map((m) => m.type), { timeout: 60_000 }).toContain('scan.complete');
        expect(toServer).toEqual([{ type: 'scan.start', subnets: [], mdnsOnly: true }]);
        expect(fromServer.map((m) => m.type)).toEqual(['scan.started', 'scan.complete']);
        expect(fromServer[1]).toEqual({ type: 'scan.complete', found: 0 });
        // Still the in-progress line while the server's answer is held.
        await expect(info).toHaveText(MDNS_SCANNING);

        release();
        await expect(info).toHaveText(MDNS_NONE);
        await expect(discoveryPanel(page).locator('.discovery-card')).toHaveCount(0);
    });

    test('7.11 scan network: subnets persist per user, over 2,048 hosts asks first, and the cheat-sheet link opens the help page', async ({
        browser,
    }) => {
        const srv = live();
        const baseURL = srv.paths.baseURL;

        // The guard that makes this row safe: every scan socket the page opens
        // lands here and NEVER reaches the server.
        const scanStarts: unknown[] = [];
        let scanSockets = 0;
        const admin = await signedIn(browser, baseURL, PRIVATE_ADMIN, async (page) => {
            await page.routeWebSocket(/\/ws-scan$/, (ws) => {
                scanSockets += 1;
                ws.onMessage((message) => {
                    scanStarts.push(JSON.parse(String(message)));
                });
            });
        });
        contexts.push(admin.context);
        const { page } = admin;

        const detectedRes = await page.request.get('/api/devices/scan/subnet');
        expect(detectedRes.status()).toBe(200);
        const detected = (await detectedRes.json()) as { cidr?: string; hostCount?: number };
        const detectedHosts = detected.cidr ? (detected.hostCount ?? 0) : 0;
        const detectedRows = detected.cidr ? 1 : 0;

        const openScanModal = async (on: Page): Promise<Locator> => {
            await discoveryPanel(on).getByRole('button', { name: 'scan network', exact: true }).click();
            const modal = on.locator('dialog.scan-network-modal[open]');
            await expect(modal).toBeVisible();
            return modal;
        };
        // A row is "<label><actions ✎ ×>"; the label span is what the user reads.
        const manualLabels = (modal: Locator) =>
            modal.locator('ul > li').filter({ hasText: '(manually added)' }).locator(':scope > span').first();
        const manualRows = (modal: Locator) => modal.locator('ul > li').filter({ hasText: '(manually added)' });
        const subnetDialog = page.locator('dialog.add-subnet-modal[open]');
        const addSubnet = async (modal: Locator, cidr: string, hosts: string) => {
            await modal.getByRole('button', { name: 'add subnet', exact: true }).click();
            await expect(subnetDialog).toBeVisible();
            await subnetDialog.getByRole('textbox').fill(cidr);
            await expect(subnetDialog).toContainText(`✓ CIDR, ${hosts} hosts`);
            await subnetDialog.getByRole('button', { name: 'add', exact: true }).click();
            await expect(subnetDialog).toBeHidden();
        };
        const storedSubnets = async (ctx: APIRequestContext) => {
            const res = await ctx.get('/api/settings');
            expect(res.status()).toBe(200);
            return ((await res.json()) as Record<string, unknown>)['scanSubnets'];
        };

        // --- add, edit (✎), remove (×) ---
        let modal = await openScanModal(page);
        await expect(manualRows(modal)).toHaveCount(0);
        await addSubnet(modal, '10.250.1.0/24', '254');
        await expect(manualRows(modal)).toHaveCount(1);
        await expect(manualLabels(modal)).toHaveText('10.250.1.0/24 — 254 hosts (manually added)');

        await manualRows(modal).getByRole('button', { name: 'edit', exact: true }).click();
        await expect(subnetDialog).toBeVisible();
        await expect(subnetDialog.locator('.modal-title')).toHaveText('Edit Subnet');
        await expect(subnetDialog.getByRole('textbox')).toHaveValue('10.250.1.0/24');
        await subnetDialog.getByRole('textbox').fill('10.250.2.0/24');
        await subnetDialog.getByRole('button', { name: 'save', exact: true }).click();
        await expect(subnetDialog).toBeHidden();
        await expect(manualRows(modal)).toHaveCount(1);
        await expect(manualLabels(modal)).toHaveText('10.250.2.0/24 — 254 hosts (manually added)');

        await addSubnet(modal, '10.250.3.0/24', '254');
        await expect(manualRows(modal)).toHaveCount(2);
        await manualRows(modal)
            .filter({ hasText: '10.250.3.0/24' })
            .getByRole('button', { name: 'remove', exact: true })
            .click();
        await expect(manualRows(modal)).toHaveCount(1);
        await expect(manualLabels(modal)).toHaveText('10.250.2.0/24 — 254 hosts (manually added)');
        await expect.poll(() => storedSubnets(page.request)).toEqual(['10.250.2.0/24']);

        // --- persisted across a reload, for this user only ---
        await modal.getByRole('button', { name: 'cancel', exact: true }).click();
        await expect(modal).toBeHidden();
        await page.reload();
        await expectAppShell(page);
        modal = await openScanModal(page);
        await expect(manualRows(modal)).toHaveCount(1);
        await expect(manualLabels(modal)).toHaveText('10.250.2.0/24 — 254 hosts (manually added)');
        await expect(modal.locator('ul > li')).toHaveCount(1 + detectedRows);

        const user = await signedIn(browser, baseURL, PRIVATE_USER);
        contexts.push(user.context);
        expect(await storedSubnets(user.context.request)).toBeUndefined();
        const userModal = await openScanModal(user.page);
        await expect(userModal.locator('ul > li')).toHaveCount(detectedRows);
        await expect(manualRows(userModal)).toHaveCount(0);

        // --- the cheat-sheet link ---
        const popupPromise = admin.context.waitForEvent('page');
        await modal.getByRole('link', { name: 'subnet cheat sheet', exact: true }).click();
        const popup = await popupPromise;
        await popup.waitForLoadState();
        expect(popup.url()).toBe(`${baseURL}/help/subnets.html`);
        await expect(popup).toHaveTitle('Subnet & CIDR Cheat Sheet — ws-scrcpy-web');
        await expect(popup.locator('h1')).toHaveText('Subnet & CIDR Cheat Sheet');
        await popup.close();

        // --- over 2,048 hosts: the large-scan dialog, with continue / cancel ---
        await addSubnet(modal, '10.250.16.0/20', '4094');
        const total = detectedHosts + 254 + 4094;
        const subnets = detectedRows + 2;
        const warning = page.locator('dialog.large-subnet-warning-modal[open]');
        await modal.getByRole('button', { name: 'start scan', exact: true }).click();
        await expect(warning).toBeVisible();
        await expect(warning.locator('.modal-title')).toHaveText('Large Scan — Confirm');
        await expect(warning).toContainText(
            `The scan covers ${total.toLocaleString('en-US')} hosts across ${subnets} subnets. ` +
                `At roughly 30 seconds per 1,000 hosts, this will take about ${etaFor(total)}.`,
        );
        await expect(warning.getByRole('button', { name: 'continue scan', exact: true })).toBeVisible();
        await warning.getByRole('button', { name: 'cancel', exact: true }).click();
        await expect(warning).toBeHidden();
        // Cancel started nothing, and left the subnet list open to edit.
        await expect(modal).toBeVisible();
        expect(scanSockets).toBe(0);

        // The control: continue DOES start the scan — into the stub above.
        await modal.getByRole('button', { name: 'start scan', exact: true }).click();
        await expect(warning).toBeVisible();
        await warning.getByRole('button', { name: 'continue scan', exact: true }).click();
        await expect(warning).toBeHidden();
        await expect.poll(() => scanStarts).toHaveLength(1);
        expect(scanSockets).toBe(1);
        expect(scanStarts[0]).toEqual({
            type: 'scan.start',
            subnets: [...(detected.cidr ? [detected.cidr] : []), '10.250.2.0/24', '10.250.16.0/20'],
        });
    });

    test('7.14 a non-admin sees Pair a new device but is told to ask an administrator', async ({ browser }) => {
        const srv = live();
        const baseURL = srv.paths.baseURL;
        const user = await signedIn(browser, baseURL, PRIVATE_USER);
        contexts.push(user.context);

        const section = pairingSection(user.page);
        await expect(section.locator('.discovery-pairing-title')).toHaveText('Pair a new device');
        await expect(section.getByRole('button', { name: 'scan QR code', exact: true })).toBeVisible();
        const qrResponse = user.page.waitForResponse((r) => new URL(r.url()).pathname === '/api/devices/pair/qr');
        await section.getByRole('button', { name: 'scan QR code', exact: true }).click();
        const res = await qrResponse;
        expect(res.status()).toBe(403);
        expect(await res.json()).toEqual({ error: 'forbidden' });
        const status = section.locator('[data-pair-status]');
        await expect(status).toHaveText(NEEDS_ADMIN);
        await expect(status).toHaveClass(/\berror\b/);
        await expect(section.locator('[data-pair-qr]')).toBeHidden();

        // Every pairing route refuses the user, not only the one the button calls.
        const api = user.context.request;
        const code = await api.post('/api/devices/pair/code', { data: { address: '127.0.0.1:8187', code: '123456' } });
        expect(code.status()).toBe(403);
        expect(await code.json()).toEqual({ error: 'forbidden' });
        const read = await api.get('/api/devices/pair/status?sessionId=anything');
        expect(read.status()).toBe(403);
        expect(await read.json()).toEqual({ error: 'forbidden' });

        // The control: the admin on the same server is given a QR.
        const admin = await signedIn(browser, baseURL, PRIVATE_ADMIN);
        contexts.push(admin.context);
        const adminQr = await admin.context.request.post('/api/devices/pair/qr');
        expect(adminQr.status()).toBe(200);
        const body = (await adminQr.json()) as { sessionId: string; svg: string; expiresInMs: number };
        expect(body).toEqual({
            sessionId: expect.any(String),
            svg: expect.stringContaining('<svg'),
            expiresInMs: PAIRING_TTL_MS,
        });
        await cancelPairing(admin.context.request, body.sessionId);
    });
});
