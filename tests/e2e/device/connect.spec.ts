import { lookup } from 'node:dns/promises';
import { expect, type Page, type Request, test } from '@playwright/test';
import { probeWs, WS_PROBE_URLS } from '../support/auth';
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
 * Smoke rows 7.1, 7.2 and 7.4 — getting a device onto the connected list, and
 * what the list does once it is there.
 *
 * Three of the four tests are `@device` and run only inside qa-harness, against
 * the emulator on its run network. The fourth (7.2's public-range refusal) is
 * deliberately UNTAGGED: the guard it covers lives in `ScanMw` and fires before
 * a scanner ever starts, so it needs no device and belongs in the fast tier
 * where every push runs it. That is also why `deviceAddress()` is called inside
 * each test body rather than at module load — the fast tier loads this file too.
 *
 * Every test leaves the device CONNECTED, including on failure. The four device
 * spec files share one emulator and run serially in alphabetical order
 * (connect, labels, modals, streaming), so a file that exits with the device
 * detached fails the next one for a reason that points nowhere near its cause.
 */

/** `host:port`, split from the right so an IPv4 host with no ambiguity still works. */
function splitAddress(address: string): { host: string; port: string } {
    const idx = address.lastIndexOf(':');
    expect(idx, `QA_DEVICE_ADDRESS ("${address}") must be host:port`).toBeGreaterThan(0);
    return { host: address.slice(0, idx), port: address.slice(idx + 1) };
}

/**
 * The emulator's address on the run network as an IP.
 *
 * The app addresses the device by the compose alias (`qa-android:5555`), but a
 * subnet scan is a range of IPs — the two are the same device under two names,
 * and a scan can only ever find the second. The name resolves inside the runner,
 * so Node's resolver is the bridge between them.
 */
async function emulatorIp(host: string): Promise<string> {
    const { address } = await lookup(host, { family: 4 });
    expect(address, `${host} must resolve to an IPv4 address on the run network`).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    return address;
}

async function expectRowGone(page: Page, address: string, timeout = 30_000): Promise<void> {
    await expect(
        deviceRow(page, address),
        `the row for ${address} should disappear once adb has dropped it (ControlCenter polls adb every 5 s, so this is not instant)`,
    ).toHaveCount(0, { timeout });
}

/**
 * Record the manual-add banner the moment it appears.
 *
 * `.discovery-manual-result` is emptied and the whole form re-hidden 2 s after a
 * successful connect (`NetworkDiscoveryPanel.manualConnect` → `toggleManualForm`),
 * so polling for its text races that timer and would fail as a flake on a slow
 * container. A mutation observer planted before the click stashes the first
 * non-hidden state instead — the same technique `support/auth.ts` uses for the
 * lockdown farewell, for the same reason.
 */
const MANUAL_BANNER_KEY = '__e2e_manual_banner';

interface ManualBanner {
    className: string;
    text: string;
}

async function watchManualBanner(page: Page): Promise<void> {
    await page.evaluate((key: string) => {
        const el = document.querySelector('.discovery-manual-result');
        if (!el) throw new Error('no .discovery-manual-result to observe — is the manual-add form open?');
        const store = window as unknown as Record<string, ManualBanner | null>;
        store[key] = null;
        const record = (): void => {
            if (el.hasAttribute('hidden') || store[key]) return;
            store[key] = { className: el.className, text: el.textContent ?? '' };
        };
        new MutationObserver(record).observe(el, {
            attributes: true,
            childList: true,
            characterData: true,
            subtree: true,
        });
    }, MANUAL_BANNER_KEY);
}

async function readManualBanner(page: Page): Promise<ManualBanner | null> {
    return page.evaluate(
        (key: string) => (window as unknown as Record<string, ManualBanner | null>)[key] ?? null,
        MANUAL_BANNER_KEY,
    );
}

/** The one scan.error field every refusal below is judged on. */
interface ScanErrorWire {
    type: string;
    reason?: string;
    details?: { subnet: string; error: string }[];
}

test.describe('device connect and list (smoke §7.1, §7.2, §7.4)', () => {
    test('@device 7.1 the manual-add form connects a device by address and its row appears in the connected list', async ({
        page,
    }) => {
        test.setTimeout(180_000);
        const address = deviceAddress();
        const { host, port } = splitAddress(address);
        await gotoHome(page);
        const ctx = page.request;

        try {
            // Arrange from a KNOWN connected state and then detach: the row has
            // to appear during this test for the assertion to mean anything, and
            // waiting for it to vanish first proves the list was tracking it.
            await connectDevice(ctx, address);
            await waitForDeviceRow(page, address, 30_000);
            await disconnectIfConnected(ctx, address);
            await expectRowGone(page, address);

            const panel = page.locator('#discovery-panel');
            await expect(panel).toBeVisible();
            await panel.locator('.discovery-manual-btn').click();
            const form = panel.locator('.discovery-manual-form');
            await expect(form).toBeVisible();
            await form.locator('.discovery-manual-address').fill(host);
            await form.locator('.discovery-manual-port').fill(port);
            await watchManualBanner(page);

            const connectResponse = page.waitForResponse(
                (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/devices/connect',
            );
            const clickedAt = Date.now();
            await form.locator('.discovery-manual-connect').click();
            const response = await connectResponse;
            expect(response.status(), 'POST /api/devices/connect from the manual-add form').toBe(200);
            expect(await response.json()).toMatchObject({ success: true });
            // The form sends `${ip}:${port}` — the same udid the device list keys
            // on. A form that posted the bare host would still connect nothing.
            expect(response.request().postDataJSON()).toMatchObject({ address });

            await expect
                .poll(() => readManualBanner(page), {
                    message: 'the manual-add form should report the result before it auto-hides',
                    timeout: 10_000,
                })
                .not.toBeNull();
            const banner = await readManualBanner(page);
            expect(banner?.className, 'a successful connect is reported as success, never error').toContain('success');
            expect(banner?.className).not.toContain('error');
            expect(banner?.text).toBe(`Connected to ${address}`);

            await waitForDeviceRow(page, address, 30_000);
            const rowLatencyMs = Date.now() - clickedAt;
            test.info().annotations.push({
                type: '7.1 row latency',
                description: `${rowLatencyMs} ms from the connect click to a visible row`,
            });
            // The smoke row says "~5s". That is the human-perception figure, not
            // an architectural bound: ControlCenter polls adb every 5 s
            // (POLL_INTERVAL, ControlCenter.ts) and only then fetches the
            // device's properties, so 5 s is the FLOOR, not the ceiling. The
            // bound below still fails a connect that never reaches the list.
            expect(rowLatencyMs, 'the row must appear without a second poll cycle of slack').toBeLessThan(20_000);
        } finally {
            await connectDevice(ctx, address);
        }
    });

    test('@device 7.2 a private-subnet scan finds the emulator and connecting from its card adds it to the device list', async ({
        page,
    }) => {
        test.setTimeout(240_000);
        const address = deviceAddress();
        const { host } = splitAddress(address);
        const ip = await emulatorIp(host);
        // A TCP hit is always reported at port 5555 — NetworkScanner probes that
        // port and nothing else — so this is the address the card will carry.
        const scanAddress = `${ip}:5555`;

        /**
         * Stub ONLY the gateway prefill.
         *
         * `GET /api/devices/scan/subnet` detects the container's own network,
         * which Docker hands out as a /16 — 65,534 hosts, an unremovable row in
         * the modal, and a scan that would outlive this run. Answering `null`
         * puts the modal in its "couldn't detect your gateway subnet" state,
         * which is a real state (a host with no default route reaches it), and
         * leaves everything the row is actually about — the add-subnet flow, the
         * scan itself, the hit card and its connect button — unstubbed.
         */
        await page.route('**/api/devices/scan/subnet', (route) =>
            route.fulfill({ status: 200, contentType: 'application/json', body: 'null' }),
        );

        await gotoHome(page);
        const ctx = page.request;

        try {
            await connectDevice(ctx, address);
            await waitForDeviceRow(page, address, 30_000);
            // Detach the alias-addressed connection first. Reconnecting the same
            // emulator by IP while `qa-android:5555` is up would put two
            // transports for one device in front of the tracker's dedupe, and
            // the row this test waits for is the IP one.
            await disconnectIfConnected(ctx, address);
            await expectRowGone(page, address);

            await page.locator('#discovery-panel .discovery-scan-btn').click();
            const scanModal = page.locator('dialog.scan-network-modal');
            await expect(scanModal).toBeVisible();
            const startScan = scanModal.getByRole('button', { name: 'start scan', exact: true });

            // The modal PERSISTS manually added subnets (patchGlobal
            // 'scanSubnets'), so a re-run would open with this spec's own row
            // already present and the count assertion below would be reading
            // last run's state. Clear the list back to empty first.
            const removeButtons = scanModal.locator('button[aria-label="remove"]');
            for (let i = 0; i < 8 && (await removeButtons.count()) > 0; i++) {
                await removeButtons.first().click();
            }
            await expect(removeButtons).toHaveCount(0);
            await expect(
                startScan,
                'with no gateway detected and no saved subnets there is nothing to scan',
            ).toBeDisabled();

            await scanModal.getByRole('button', { name: 'add subnet', exact: true }).click();
            const addModal = page.locator('dialog.add-subnet-modal');
            await expect(addModal).toBeVisible();
            await addModal.locator('input[type="text"]').fill(`${ip}/32`);
            // A /32 parses to exactly one host; the modal says so before it will
            // let the subnet be added, and that is the whole reason this scan
            // finishes in seconds rather than sweeping the container network.
            await expect(addModal.locator('.modal-body')).toContainText('single host');
            await addModal.getByRole('button', { name: 'add', exact: true }).click();
            await expect(addModal).toBeHidden();

            const rows = scanModal.locator('ul > li');
            await expect(rows).toHaveCount(1);
            await expect(rows.first()).toContainText(`${ip}/32`);
            await expect(rows.first()).toContainText('1 host (manually added)');
            await expect(startScan).toBeEnabled();
            await startScan.click();
            await expect(scanModal).toBeHidden();

            // The card is the scan's product: a `scan.hit` the panel rendered.
            const card = page.locator(
                `#discovery-panel .discovery-card:has(.discovery-card-address[title="${scanAddress}"])`,
            );
            await expect(card, `a scan of ${ip}/32 must find the emulator's adb port`).toBeVisible({ timeout: 90_000 });

            // Both data attributes are asserted because they are what the click
            // handler posts — a card that rendered the right text but carried the
            // wrong address would connect the wrong thing.
            const connectBtn = card.locator(
                `button.discovery-connect-btn[data-address="${scanAddress}"][data-serial="${scanAddress}"]`,
            );
            await expect(connectBtn).toBeEnabled();
            const connectResponse = page.waitForResponse(
                (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/devices/connect',
            );
            await connectBtn.click();
            const response = await connectResponse;
            expect(response.status(), 'POST /api/devices/connect from the scan card').toBe(200);
            expect(await response.json()).toMatchObject({ success: true });

            await waitForDeviceRow(page, scanAddress, 30_000);
        } finally {
            await disconnectIfConnected(ctx, scanAddress);
            await connectDevice(ctx, address);
        }
    });

    test('7.2 a scan of a public CIDR is refused with the private-range reason, and no scan is started', async ({
        page,
    }) => {
        // Untagged on purpose: `ScanMw` refuses these before the scanner is
        // touched, so there is no device, no adb and no emulator in this path —
        // it belongs in the tier that runs on every push.
        await gotoHome(page);
        const publicCidr = '8.8.8.0/24';

        const startScan = async (subnets: string[]): Promise<ScanErrorWire> => {
            const probe = await probeWs(page, WS_PROBE_URLS.scan, {
                sendOnOpen: JSON.stringify({ type: 'scan.start', subnets }),
                matchType: 'scan.error',
                timeoutMs: 15_000,
            });
            // "no hang" is half of what this row asks for: a refusal that never
            // answered would surface here as probeWs's timeout, not as a close.
            expect(probe.kind, `scan.start ${JSON.stringify(subnets)} should be answered, not dropped`).toBe('message');
            if (probe.kind !== 'message') throw new Error('unreachable — asserted above');
            return JSON.parse(probe.data) as ScanErrorWire;
        };

        expect(await startScan([publicCidr])).toEqual({
            type: 'scan.error',
            reason: 'invalid subnets',
            details: [
                {
                    subnet: publicCidr,
                    error:
                        `"${publicCidr}" is outside the private (RFC1918) ranges (10/8, 172.16/12, 192.168/16); ` +
                        'scanning public addresses is not allowed.',
                },
            ],
        });

        // A malformed subnet is refused the same way — same terminal message,
        // same absence of a scan — rather than being passed to the scanner. The
        // input carries no '/' and no '-' on purpose: either character sends the
        // parser down its CIDR or range branch, which answer with their own
        // (also fine) errors rather than the unrecognized-format one.
        const malformed = await startScan(['not_a_subnet']);
        expect(malformed.reason).toBe('invalid subnets');
        expect(malformed.details).toEqual([
            {
                subnet: 'not_a_subnet',
                error:
                    'Unrecognized format. Try CIDR (192.168.1.0/24), a single IP (192.168.1.5), ' +
                    'or a range (192.168.1.10-50). See the subnet cheat sheet at /help/subnets.html for help.',
            },
        ]);

        // The proof that neither refusal STARTED anything: a scanner that had
        // begun would answer this third attempt with 'scan already in progress'
        // (ScanMw checks `scanner.isScanning()` before it validates the input),
        // so getting the validation error back again is what says no scan ran.
        expect((await startScan([publicCidr])).reason).toBe('invalid subnets');
    });

    test('@device 7.4 the device list updates in place: a rename keeps the same row node, labels are fetched per refresh, and disconnect/reconnect are reflected', async ({
        page,
    }) => {
        test.setTimeout(300_000);
        const address = deviceAddress();
        // The label cell keys on the device's own `ro.serialno`, NOT on the adb
        // address (DeviceTracker.buildDeviceRow). Reading it out of band gives
        // the cleanup below the right key and lets the PUT body be asserted
        // against something this spec did not learn from the page it is testing.
        const serial = deviceSerial();
        const label = 'e2e 7.4 renamed in place';

        await gotoHome(page);
        const ctx = page.request;

        try {
            await connectDevice(ctx, address);
            await waitForDeviceRow(page, address, 30_000);

            /**
             * One GET /api/devices/labels is issued per table refresh
             * (`fetchRowContext`), and a refresh happens only when the server
             * pushes a device message — so counting these requests counts
             * refreshes from outside the app.
             */
            let labelFetches = 0;
            const countLabelGets = (req: Request): void => {
                if (req.method() === 'GET' && new URL(req.url()).pathname === '/api/devices/labels') {
                    labelFetches += 1;
                }
            };
            page.on('request', countLabelGets);
            try {
                /**
                 * Wait for the list to go quiet before measuring anything.
                 *
                 * A just-connected device is NOT idle: `Device.fetchDeviceInfo`
                 * retries on a doubling backoff until properties and interfaces
                 * both land, `checkScreenState` and `detectDeviceKind` run on
                 * every 5 s poll, and each emit stamps `last.update.timestamp` —
                 * which `serializeDescriptor` includes, so every one of those
                 * messages is a genuinely CHANGED descriptor and the diff
                 * rebuilds the row by design. Measuring through that settling
                 * period would be measuring the emulator waking up, not the
                 * list's behaviour.
                 */
                const settleDeadline = Date.now() + 120_000;
                let seenAtLastCheck = labelFetches;
                let quietSince = Date.now();
                while (Date.now() < settleDeadline && Date.now() - quietSince < 6_000) {
                    await page.waitForTimeout(500);
                    if (labelFetches !== seenAtLastCheck) {
                        seenAtLastCheck = labelFetches;
                        quietSince = Date.now();
                    }
                }
                const settleMs = Date.now() - quietSince;
                test.info().annotations.push({
                    type: '7.4 settling',
                    description: `${labelFetches} table refreshes before the list went quiet for 6 s`,
                });
                expect(
                    settleMs,
                    'the connected list must stop refreshing once the device has settled — a list that keeps refreshing an unchanged device is the storm this row exists to catch',
                ).toBeGreaterThanOrEqual(6_000);

                // Stamp the now-stable row node. The assertions that the marker
                // is still there are assertions that THIS element survived; a
                // list that rebuilt its rows would hand back a fresh node
                // without the attribute, and the reconnect at the end of this
                // test is the control that proves the marker CAN be lost.
                const row = deviceRow(page, address);
                await row.evaluate((el) => el.setAttribute('data-e2e-row-marker', '7.4'));

                const fetchesBeforeRename = labelFetches;
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
                const putResponse = await put;
                expect(putResponse.status(), 'PUT /api/devices/labels on Enter').toBe(200);
                // Waiting for the PUT at all is what proves the save happened:
                // the cell skips it entirely when the serial is empty and still
                // re-renders locally, which would look identical on screen.
                expect(putResponse.request().postDataJSON()).toEqual({ serial, label });

                const nameText = row.locator('span.device-name-text');
                await expect(nameText).toHaveText(label);
                await expect(nameText).not.toHaveClass(/unnamed/);
                // ZERO, not "a small number": a rename repaints the one name cell
                // it changed (`renderDisplay(newLabel)`) and refreshes nothing.
                // An implementation that rebuilt the table after saving — which
                // is the obvious way to write it, and what the label map is
                // fetched per refresh to avoid — would show up here as one more
                // refresh, and as a lost marker on the next line.
                expect(
                    labelFetches - fetchesBeforeRename,
                    'a rename must not refresh the table (and so must not re-fetch the label map)',
                ).toBe(0);
                await expect(
                    deviceRow(page, address),
                    'a rename must repaint the name cell, not rebuild the row',
                ).toHaveAttribute('data-e2e-row-marker', '7.4');
                // With one device on the list "once per row" and "once per
                // refresh" cannot be told apart by counting — one row means one
                // fetch either way. What is provable here is the shape either
                // claim rules out: a rename costs no fetch at all, and a settled
                // list costs none per second.
                //
                // Both of those are ZERO-deltas, and a counter that matched no
                // request at all would satisfy them just as well. So the
                // listener stays attached through the disconnect and reconnect
                // below, where a refresh is certain, and its rise there is what
                // makes the two claims above falsifiable.
                const fetchesBeforeDisconnect = labelFetches;

                // Removal, through the row's own affordance rather than the API.
                const disconnectBtn = deviceRow(page, address).locator('button.disconnect-btn');
                await expect(disconnectBtn, 'a network device carries a disconnect button').toBeVisible();
                const disconnectResponse = page.waitForResponse(
                    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/devices/disconnect',
                );
                const disconnectedAt = Date.now();
                await disconnectBtn.click();
                expect((await disconnectResponse).status(), 'POST /api/devices/disconnect from the row').toBe(200);
                await expectRowGone(page, address);
                const removalMs = Date.now() - disconnectedAt;

                const reconnectedAt = Date.now();
                await connectDevice(ctx, address);
                await waitForDeviceRow(page, address, 30_000);
                const reappearMs = Date.now() - reconnectedAt;
                test.info().annotations.push({
                    type: '7.4 add/remove latency',
                    description: `${removalMs} ms to drop the row, ${reappearMs} ms to bring it back`,
                });
                // The smoke row's "~1s" is the client's reflection of a server
                // message. End to end the floor is ControlCenter's 5 s adb poll —
                // nothing tells the server the device left until that fires — so
                // the bound here is one poll cycle plus the property fetch, and
                // the real measurements are annotated above.
                expect(removalMs, 'the row must go within a poll cycle of the disconnect').toBeLessThan(20_000);
                expect(reappearMs, 'the row must return within a poll cycle of the reconnect').toBeLessThan(20_000);

                await expect(
                    deviceRow(page, address),
                    'a row that genuinely left and came back is a NEW node — this is the control that makes the marker assertions above falsifiable',
                ).not.toHaveAttribute('data-e2e-row-marker', '7.4');

                // The positive control for the two zero-deltas above.
                // `doRefreshDeviceTable` awaits `fetchRowContext` on EVERY
                // refresh, ahead of even the empty-list branch, so emptying the
                // list and repopulating it cannot happen without at least one
                // GET /api/devices/labels. A counter whose URL match was wrong
                // reads zero here and fails — taking the vacuous passes above
                // down with it, which is the point.
                const fetchesAcrossReconnect = labelFetches - fetchesBeforeDisconnect;
                test.info().annotations.push({
                    type: '7.4 label fetches',
                    description: `${fetchesAcrossReconnect} GET /api/devices/labels across the disconnect and reconnect`,
                });
                expect(
                    fetchesAcrossReconnect,
                    'the label-fetch counter must be seen to rise where a refresh is certain, or the zero-deltas above prove nothing',
                ).toBeGreaterThanOrEqual(1);
            } finally {
                page.off('request', countLabelGets);
            }
        } finally {
            // Restoring the shared device IS asserted: leaving it detached
            // breaks every spec file that sorts after this one, so that is worth
            // failing loudly for even at the cost of masking an earlier error.
            await connectDevice(ctx, address);
            // Clearing the label is not. labels.spec.ts's afterAll clears the
            // same way and 19.1 re-clears before it asserts, so a throw here
            // would buy nothing and would replace whatever real failure sent us
            // into this finally.
            await ctx.put('/api/devices/labels', { data: { serial, label: '' } });
        }
    });
});
