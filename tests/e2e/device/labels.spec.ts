import { lookup } from 'node:dns/promises';
import {
    type APIRequestContext,
    type BrowserContext,
    expect,
    type Locator,
    type Page,
    request,
    test,
} from '@playwright/test';
import {
    ADMIN,
    dismissPromptsFor,
    e2eBaseUrl,
    ensureOpenMode,
    labelsFor,
    listUsers,
    lockdown,
    loginAs,
    me,
    mintToken,
    newVisitorContext,
    REGULAR,
    setLabel,
} from '../support/auth';
import { gotoHome } from '../support/consent';
import {
    connectDevice,
    deviceAddress,
    deviceRow,
    deviceSerial,
    disconnectIfConnected,
    waitForDeviceRow,
} from '../support/device';

/**
 * Smoke module 19 — per-user device labels.
 *
 * 19.1 is the open-mode no-regression check and runs against the server as the
 * rest of the device tier leaves it. 19.2 and 19.3 need login enabled with two
 * accounts, so they share a serial group whose `beforeAll` performs the
 * first-user lockdown and whose `afterAll` returns the server to open mode —
 * the same shape, and for the same reason, as `auth.spec.ts`'s module 18 group:
 * a locked server answers every later `page.goto('/')` with the login page at
 * HTTP 200, so the two device spec files that sort after this one (modals,
 * streaming) would fail on missing buttons that point nowhere near auth.
 *
 * Two identities for one device matter throughout, and they are NOT the same
 * string:
 *
 *  - the connected list's label cell keys on the device's own `ro.serialno`
 *    (`DeviceTracker.buildDeviceRow`), and
 *  - a TCP scan hit identifies the device by `ip:5555` (`NetworkScanner.probeOne`
 *    sets `serial = address`), which is what `labelFor` is asked for as a scan
 *    streams.
 *
 * So a label typed into the row does not, on its own, reach a later scan hit.
 * 19.3 therefore stores each user's label under the key the scan actually
 * resolves — through the product's own per-user route — so the row's subject
 * (per-spectator resolution) is what is under test rather than the key mismatch.
 */

const OPEN_MODE_LABEL = 'e2e 19.1 open mode';
const A_LABEL = 'A-name';
const B_LABEL = 'B-name';

/**
 * Rename a device from its row: pencil → input → Enter.
 *
 * The PUT is awaited rather than assumed. `buildLabelCell`'s save skips the
 * request entirely when the serial is empty and re-renders the typed value
 * anyway, so a UI-only assertion would pass on a label that was never stored.
 */
async function renameFromRow(page: Page, row: Locator, serial: string, label: string): Promise<void> {
    const pencil = row.locator('button.device-name-edit-btn[title="Edit device name"]');
    await expect(pencil).toBeVisible();
    await pencil.click();
    const input = row.locator('input.device-name-input');
    await expect(input).toBeVisible();
    await input.fill(label);
    const put = page.waitForResponse(
        (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/devices/labels',
    );
    await input.press('Enter');
    const response = await put;
    expect(response.status(), `PUT /api/devices/labels {${serial}: ${label}}`).toBe(200);
    expect(response.request().postDataJSON()).toEqual({ serial, label });
    await expect(row.locator('span.device-name-text')).toHaveText(label);
}

/** The shape of the `/ws-scan` server messages this file judges. */
interface ScanWireMessage {
    type: string;
    source?: string;
    address?: string;
    serial?: string;
    name?: string;
    label?: string;
    reason?: string;
    found?: number;
}

/**
 * Run one scan to completion from inside the page and return every message.
 *
 * `probeWs` resolves on the FIRST matching message, which is not enough here for
 * two reasons: the label lives on a `scan.hit` that arrives after `scan.started`,
 * and the scanner is a singleton — a second user's scan started before the first
 * has finished is answered with `scan.error: scan already in progress`. Waiting
 * for the terminal message is what lets A's scan and B's scan run back to back.
 */
async function runScan(page: Page, subnets: string[], timeoutMs = 90_000): Promise<ScanWireMessage[]> {
    const messages = await page.evaluate(
        (args: { subnets: string[]; timeoutMs: number }) =>
            new Promise<unknown[]>((resolve, reject) => {
                const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws-scan`;
                const ws = new WebSocket(url);
                const seen: unknown[] = [];
                let settled = false;
                const finish = (act: () => void): void => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    try {
                        ws.close(1000);
                    } catch {}
                    act();
                };
                const timer = setTimeout(
                    () =>
                        finish(() =>
                            reject(
                                new Error(
                                    `no terminal scan message within ${args.timeoutMs} ms; saw ${JSON.stringify(seen)}`,
                                ),
                            ),
                        ),
                    args.timeoutMs,
                );
                ws.addEventListener('open', () =>
                    ws.send(JSON.stringify({ type: 'scan.start', subnets: args.subnets })),
                );
                ws.addEventListener('message', (event: MessageEvent) => {
                    const msg = JSON.parse(String(event.data)) as { type?: string };
                    seen.push(msg);
                    if (msg.type === 'scan.complete' || msg.type === 'scan.cancelled' || msg.type === 'scan.error') {
                        finish(() => resolve(seen));
                    }
                });
                ws.addEventListener('close', () => finish(() => resolve(seen)));
            }),
        { subnets, timeoutMs },
    );
    return messages as ScanWireMessage[];
}

/** The single hit for `address`, with the whole message list in the failure text. */
function hitFor(messages: ScanWireMessage[], address: string): ScanWireMessage {
    const hits = messages.filter((m) => m.type === 'scan.hit' && m.address === address);
    expect(hits, `exactly one scan.hit for ${address}; saw ${JSON.stringify(messages)}`).toHaveLength(1);
    return hits[0] as ScanWireMessage;
}

test('@device 19.1 in open mode a label set on the device row is stored per user and survives a reload', async ({
    page,
}) => {
    test.setTimeout(180_000);
    const address = deviceAddress();
    const serial = deviceSerial();

    await gotoHome(page);
    const ctx = page.request;

    try {
        expect((await me(ctx)).authEnabled, '19.1 is the open-mode half of module 19').toBe(false);
        await connectDevice(ctx, address);
        // Start unnamed no matter what ran before: 7.4 also renames this device,
        // and inheriting its label would make "the label appeared" unfalsifiable.
        await setLabel(ctx, serial, '');
        await gotoHome(page);
        const row = await waitForDeviceRow(page, address, 30_000);
        const nameText = row.locator('span.device-name-text');
        await expect(nameText).toHaveText('Unnamed Device');
        await expect(nameText).toHaveClass(/unnamed/);

        await renameFromRow(page, row, serial, OPEN_MODE_LABEL);
        // The server-side witness. Open mode has a single implicit user
        // (IMPLICIT_ADMIN_ID), so per-user storage has to be transparent here —
        // the map the API returns is the same map the row renders from.
        expect((await labelsFor(ctx))[serial], 'the label is stored for the implicit open-mode user').toBe(
            OPEN_MODE_LABEL,
        );

        await gotoHome(page);
        const reloaded = await waitForDeviceRow(page, address, 30_000);
        await expect(reloaded.locator('span.device-name-text')).toHaveText(OPEN_MODE_LABEL);
        await expect(reloaded.locator('span.device-name-text')).not.toHaveClass(/unnamed/);
    } finally {
        await setLabel(ctx, serial, '');
        await connectDevice(ctx, address);
    }
});

test.describe('per-user device labels with login enabled (smoke §19.2, §19.3)', () => {
    /**
     * Serial and never retried. The `beforeAll` below performs the ONE-WAY
     * first-user lockdown — nothing in the API un-renames user 1 or takes its
     * password hash back — so a retry would re-run setup against a server it can
     * no longer set up, and would fail for a reason that has nothing to do with
     * labels.
     */
    test.describe.configure({ mode: 'serial', retries: 0 });

    interface Visitor {
        context: BrowserContext;
        page: Page;
    }

    let address = '';
    let serial = '';
    /** User A is user id 1 — the account the lockdown renames, and the same row the implicit open-mode user writes to. */
    let a: Visitor | undefined;
    let b: Visitor | undefined;
    /** Keys this group wrote labels under, cleared in afterAll. */
    const writtenKeys = new Set<string>();

    const signIn = async (
        context: BrowserContext,
        page: Page,
        creds: { username: string; password: string },
    ): Promise<void> => {
        // Exactly one attempt, never a retry: five failures in five minutes lock
        // the row for fifteen and unlocking needs an admin session.
        const login = await loginAs(context.request, creds);
        expect(login.status(), `login as ${creds.username}: ${await login.text()}`).toBe(200);
        // A freshly logged-in account has no dismissal flags of its own, so the
        // bookmark reminder would open over the device list on its first load.
        await dismissPromptsFor(context.request);
        await page.goto('/');
        await expect(page.getByRole('button', { name: 'Open settings' })).toBeVisible();
    };

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(180_000);
        address = deviceAddress();
        serial = deviceSerial();

        const setup = await request.newContext({ baseURL: e2eBaseUrl() });
        try {
            await mintToken(setup);
            await connectDevice(setup, address);
            expect((await me(setup)).authEnabled, 'the group starts from open mode and enables login itself').toBe(
                false,
            );
            // The lockdown branch is chosen by the SERVER, on the condition that
            // no enabled admin has a password yet. Asserting that condition here
            // turns "the container was already locked down by an earlier run"
            // into a named precondition failure instead of a 201 that silently
            // creates an ordinary user and leaves auth off.
            const secured = (await listUsers(setup)).filter((u) => u.role === 'admin' && !u.disabled && u.hasPassword);
            expect(
                secured,
                'module 19.2 needs a server that has never been locked down (qa-harness starts a fresh container per run); nothing in the API un-secures the admin account',
            ).toEqual([]);

            const res = await lockdown(setup, {
                adminUsername: ADMIN.username,
                adminPassword: ADMIN.password,
                username: REGULAR.username,
                password: REGULAR.password,
                role: 'user',
            });
            expect(res.status(), `POST /api/users (lockdown): ${await res.text()}`).toBe(201);
            expect(await res.json(), 'a 201 carrying {id} means the lockdown branch was NOT taken').toEqual({
                ok: true,
            });
            expect((await me(setup)).authEnabled).toBe(true);
        } finally {
            await setup.dispose();
        }

        a = await newVisitorContext(browser);
        await signIn(a.context, a.page, ADMIN);
        b = await newVisitorContext(browser);
        await signIn(b.context, b.page, REGULAR);

        // A owns user id 1, which is also the implicit open-mode user, so 19.1's
        // label would otherwise still be sitting there when 19.2 asserts A's
        // starting state.
        await setLabel(a.context.request, serial, '');
        await setLabel(b.context.request, serial, '');
        writtenKeys.add(serial);
        await a.page.goto('/');
        await b.page.goto('/');
        await expect(a.page.getByRole('button', { name: 'Open settings' })).toBeVisible();
        await expect(b.page.getByRole('button', { name: 'Open settings' })).toBeVisible();
    });

    test.afterAll(async () => {
        test.setTimeout(180_000);
        const clear = async (ctx: APIRequestContext | undefined): Promise<void> => {
            if (!ctx) return;
            for (const key of writtenKeys) {
                await ctx.put('/api/devices/labels', { data: { serial: key, label: '' } });
            }
        };
        await clear(a?.context.request);
        await clear(b?.context.request);
        await a?.context.close();
        await b?.context.close();
        // The belt: open mode again even when a row above failed, so the device
        // spec files that sort after this one do not meet a login page.
        await ensureOpenMode(e2eBaseUrl(), ADMIN);
        const ctx = await request.newContext({ baseURL: e2eBaseUrl() });
        try {
            await mintToken(ctx);
            await connectDevice(ctx, address);
        } finally {
            await ctx.dispose();
        }
    });

    test('@device 19.2 device labels are isolated per account: B never sees A-name, and A still does after B renames', async () => {
        test.setTimeout(180_000);
        const userA = a as Visitor;
        const userB = b as Visitor;

        const rowA = await waitForDeviceRow(userA.page, address, 30_000);
        await expect(rowA.locator('span.device-name-text')).toHaveClass(/unnamed/);
        await renameFromRow(userA.page, rowA, serial, A_LABEL);
        expect((await labelsFor(userA.context.request))[serial]).toBe(A_LABEL);

        // The negative this row exists for. Both assertions are kept: the first
        // is the row's own words, the second is the stronger claim that B holds
        // nothing at all for this device.
        const rowB = await waitForDeviceRow(userB.page, address, 30_000);
        const bName = rowB.locator('span.device-name-text');
        await expect(bName, "B must not inherit A's label").not.toHaveText(A_LABEL);
        await expect(bName).toHaveText('Unnamed Device');
        await expect(bName).toHaveClass(/unnamed/);
        expect((await labelsFor(userB.context.request))[serial], "B's own label map is empty").toBeUndefined();

        await renameFromRow(userB.page, rowB, serial, B_LABEL);
        expect((await labelsFor(userB.context.request))[serial]).toBe(B_LABEL);

        // A, reloaded AFTER B wrote to the same device, still reads A-name. Two
        // live contexts rather than a logout/login cycle: the lockout policy
        // makes repeated logins a hazard, and two open sessions demonstrate the
        // isolation more directly than one session at a time can.
        await userA.page.goto('/');
        const rowA2 = await waitForDeviceRow(userA.page, address, 30_000);
        await expect(rowA2.locator('span.device-name-text')).toHaveText(A_LABEL);
        expect((await labelsFor(userA.context.request))[serial]).toBe(A_LABEL);
        expect((await labelsFor(userB.context.request))[serial]).toBe(B_LABEL);
    });

    test('@device 19.3 a live scan hit carries the label of the user watching that scan', async () => {
        test.setTimeout(300_000);
        const userA = a as Visitor;
        const userB = b as Visitor;
        const idx = address.lastIndexOf(':');
        const host = address.slice(0, idx);
        // The app addresses the emulator by its compose alias; a subnet scan is a
        // range of IPs. The name resolves inside the runner, which is the only
        // bridge between the two.
        const ip = (await lookup(host, { family: 4 })).address;
        const scanSubnet = `${ip}/32`;
        const scanAddress = `${ip}:5555`;

        // Detach first. A scan reports reachable devices, and NetworkScanner
        // excludes the ones adb already holds — by exact address string, so a
        // device connected as `qa-android:5555` would still be reported as a hit
        // at `ip:5555`. Disconnecting removes that ambiguity from the row.
        await disconnectIfConnected(userA.context.request, address);
        await expect(deviceRow(userA.page, address)).toHaveCount(0, { timeout: 30_000 });

        try {
            // A probe scan first, for the hit's own identity. Which track claims
            // the emulator (mDNS or the TCP probe) decides what `serial` the hit
            // carries, and the label lookup keys on exactly that — so it is read
            // from the wire rather than assumed.
            const probe = await runScan(userA.page, [scanSubnet]);
            const probeHit = hitFor(probe, scanAddress);
            const hitSerial = probeHit.serial ?? '';
            expect(hitSerial, 'a scan hit must carry an identity to resolve labels against').not.toBe('');
            // The control: with nothing stored under that key yet, the hit's
            // label is empty. Without it, the two assertions below could be
            // reading a label the scanner never looked up.
            expect(probeHit.label, 'nothing is stored under the hit key yet').toBe('');
            expect(probe.some((m) => m.type === 'scan.complete')).toBe(true);

            await setLabel(userA.context.request, hitSerial, A_LABEL);
            await setLabel(userB.context.request, hitSerial, B_LABEL);
            writtenKeys.add(hitSerial);

            const asA = hitFor(await runScan(userA.page, [scanSubnet]), scanAddress);
            expect(asA.label, 'A watching the scan sees A-name').toBe(A_LABEL);
            expect(asA.serial).toBe(hitSerial);

            const asB = hitFor(await runScan(userB.page, [scanSubnet]), scanAddress);
            expect(asB.label, 'B watching the same scan target sees B-name').toBe(B_LABEL);
            expect(asB.serial).toBe(hitSerial);

            // The pair, stated as the row states it: one device, one scan target,
            // two users, two different labels on the wire.
            expect([asA.label, asB.label]).toEqual([A_LABEL, B_LABEL]);
        } finally {
            await connectDevice(userA.context.request, address);
        }
    });
});
