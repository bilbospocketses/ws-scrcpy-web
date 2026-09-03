import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    type APIRequestContext,
    type Browser,
    type BrowserContext,
    expect,
    type Locator,
    type Page,
    request,
    test,
} from '@playwright/test';
import { e2eBaseUrl, mintToken } from '../support/auth';
import { gotoHome } from '../support/consent';
import { captureConsole, connectDevice, deviceAddress, qaAdb, screenState, waitForDeviceRow } from '../support/device';

/**
 * Smoke rows 9.1, 9.2 and 9.3 — the two device modals and the device-card
 * actions, against the real emulator inside qa-harness's Linux runner.
 *
 * Every row here is written so that the app's *effect on the device* is the
 * subject, not the app's own optimism about it. The shell modal is judged by
 * what the device's process table says after the dialog is gone; the file modal
 * by what `ls`/`cat` say on the device after each transfer; the sleep/wake
 * button by what the app's own screen-state route reads back from `dumpsys`.
 * A UI that flips a class without reaching the device passes none of them.
 *
 * The out-of-band witness is always the runner's vendored adb via `qaAdb()` —
 * never the app's adb, which is the thing under test.
 */

const TMP_DIR = '/data/local/tmp';
/** The directory 9.2 navigates into and transfers through. Created and removed out of band. */
const WORK_DIR = `${TMP_DIR}/qa-9-2`;

/**
 * The one HTTP failure this tier cannot avoid, and 9.2's only allow-list entry.
 *
 * `EmbedRequestApi.requireLocalAdmin` refuses `GET /api/embed-request` from any
 * non-loopback address by design — "embed permission is decided on this machine
 * only" — and the device tier is non-loopback by construction: the browser runs
 * in the harness runner container, the app in the subject container. The app's
 * embed-consent poller fires once on every page load and is correctly refused,
 * which Chromium reports on the console as a bare resource-load error.
 *
 * The entry is narrow in both directions. The refusal is matched by URL against
 * the recorded responses (the console line carries no URL of its own), and the
 * console line is forgiven only while a 403 was actually observed — so a real
 * error, or a 403 on any other route, still fails the row.
 */
const ALLOWED_HTTP_FAILURE = '403 GET /api/embed-request';
const RESOURCE_LOAD_403 =
    /^\[error\] Failed to load resource: the server responded with a status of 403 \(Forbidden\)$/;

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * A page with console capture armed BEFORE the first navigation.
 *
 * `newVisitorContext` navigates inside itself, which would lose everything the
 * app logs during boot — and 9.2's subject is precisely "the console stays
 * quiet", so a capture that starts after load would be asserting on a window
 * the app has already passed through.
 */
async function openApp(browser: Browser): Promise<{
    context: BrowserContext;
    page: Page;
    logs: { all: string[]; errors: string[] };
    http: string[];
}> {
    const context = await browser.newContext({ baseURL: e2eBaseUrl() });
    const page = await context.newPage();
    const logs = captureConsole(page);
    const http = captureHttpFailures(page);
    await gotoHome(page);
    return { context, page, logs, http };
}

/**
 * Every response the page received with a 4xx/5xx status, as `<status> <method>
 * <pathname>`. Chromium's console line for a failed subresource names no URL,
 * so without this the console assertion could only be all-or-nothing.
 */
function captureHttpFailures(page: Page): string[] {
    const failures: string[] = [];
    page.on('response', (res) => {
        if (res.status() >= 400) {
            failures.push(`${res.status()} ${res.request().method()} ${new URL(res.url()).pathname}`);
        }
    });
    return failures;
}

/**
 * Shell processes on the device, counted out of band.
 *
 * `ps -A`'s last column is the process NAME; an `adb shell` session shows up as
 * `sh` (toybox reports the basename, older images the full `/system/bin/sh`).
 * Both spellings are accepted so the count cannot silently read zero and make
 * "no orphan survived" vacuously true. The same command is used for the
 * baseline and for every later reading, so whatever transient the measurement
 * itself contributes cancels out.
 */
function deviceShellCount(): number {
    const out = qaAdb('shell', 'ps', '-A');
    return out.split('\n').filter((line) => /(?:^|[\s/])sh\s*$/.test(line.replace(/\r/g, ''))).length;
}

/** `true`/`false` from the device rather than an exit code, so a missing file is an answer and not a throw. */
function deviceFileExists(remotePath: string): boolean {
    return qaAdb('shell', `test -e '${remotePath}' && echo yes || echo no`).includes('yes');
}

function deviceFileText(remotePath: string): string {
    return qaAdb('shell', `cat '${remotePath}'`).replace(/\r/g, '');
}

/** The visible terminal buffer. xterm's DOM renderer paints one <div> per row under `.xterm-rows`. */
async function terminalText(rows: Locator): Promise<string> {
    return rows.evaluate((el) => (el as HTMLElement).innerText ?? '');
}

/**
 * Resolve a theme variable to the same `rgb(...)` string `toHaveCSS` compares
 * against, by letting the browser resolve it on a throwaway element.
 *
 * Comparing the button's colour to a hard-coded hex would pin the test to one
 * theme; comparing it to `getPropertyValue('--danger-color')` would compare a
 * hex to an rgb() and never match. This asserts the real claim: the button is
 * painted in the theme's danger/success colour, whichever theme is active.
 */
async function themeColor(page: Page, varName: string): Promise<string> {
    return page.evaluate((name) => {
        const probe = document.createElement('span');
        probe.style.color = `var(${name})`;
        document.body.appendChild(probe);
        const resolved = getComputedStyle(probe).color;
        probe.remove();
        return resolved;
    }, varName);
}

/** The × in a modal header. The theme toggle reuses `.modal-close`, and ListFilesModal adds a ⊞ beside it. */
function closeButton(dialog: Locator): Locator {
    return dialog.locator('.modal-header-controls button.modal-close').filter({ hasText: '×' });
}

async function readSettings(api: APIRequestContext): Promise<Record<string, unknown>> {
    const res = await api.get('/api/settings');
    expect(res.status(), 'GET /api/settings').toBe(200);
    return (await res.json()) as Record<string, unknown>;
}

async function patchSettings(api: APIRequestContext, patch: Record<string, unknown>): Promise<void> {
    const res = await api.patch('/api/settings', { data: patch });
    expect(res.status(), `PATCH /api/settings ${JSON.stringify(patch)}`).toBe(200);
}

test.describe('device modals (smoke §9.1, §9.2, §9.3)', () => {
    test('@device 9.1 the shell modal runs commands on the real device, and closing it leaves no shell behind', async ({
        browser,
    }) => {
        test.setTimeout(180_000);
        const udid = deviceAddress();
        const api = await request.newContext({ baseURL: e2eBaseUrl() });
        let context: BrowserContext | undefined;
        try {
            await mintToken(api);
            // Idempotent: "already connected" is a success, and the row must be
            // there for the overlay this row clicks through to exist at all.
            await connectDevice(api, udid);

            // Read BEFORE the browser is opened, so the only shell this test can
            // add to the device is the one the modal starts.
            const baseline = deviceShellCount();

            const opened = await openApp(browser);
            context = opened.context;
            const page = opened.page;
            const row = await waitForDeviceRow(page, udid, 30_000);

            // The shell link is soft-disabled (aria-disabled, pointer-events off)
            // when /api/capabilities reports node-pty missing. Assert the
            // affordance is live first: otherwise a dead link would fail later as
            // "the terminal never printed", blaming the wrong component.
            const caps = await api.get('/api/capabilities');
            expect(caps.status(), 'GET /api/capabilities').toBe(200);
            expect(await caps.json(), 'this image ships the node-pty prebuilt').toMatchObject({ shell: true });

            const shellLink = row.locator('div.shell.desc-block > a.link-shell');
            await expect(shellLink).toHaveCount(1);
            await expect(shellLink).toHaveText('shell');
            await expect(shellLink).not.toHaveAttribute('aria-disabled', 'true');
            await shellLink.click();

            const modal = page.locator('dialog.shell-modal');
            await expect(modal).toBeVisible();
            await expect(modal.locator('.shell-warning')).toHaveText(
                'resizing the browser window after starting a session may cause display issues',
            );
            await expect(modal.locator('.terminal-container .xterm')).toBeVisible();

            // An open dialog is not a running session: ShellModal starts the shell
            // only once a ResizeObserver reports real container dimensions. Wait
            // for the device's own prompt to be painted, or the first keystrokes
            // are typed into a terminal with nothing on the other end.
            const rows = modal.locator('.terminal-container .xterm-rows');
            await expect
                .poll(async () => (await terminalText(rows)).trim().length, {
                    timeout: 60_000,
                    message: 'the shell never printed a prompt: the session did not start',
                })
                .toBeGreaterThan(0);

            const textarea = modal.locator('.terminal-container .xterm-helper-textarea');
            await expect(textarea).toHaveCount(1);
            // focus() rather than click(): xterm's helper textarea is a 1px,
            // opacity-0 element parked at the cursor, which fails actionability.
            await textarea.evaluate((el) => (el as HTMLTextAreaElement).focus());

            await page.keyboard.type('getprop ro.product.model');
            await page.keyboard.press('Enter');
            // The typed line echoes back as `getprop ro.product.model`, which does
            // NOT contain the model string — so this can only pass on real output.
            await expect
                .poll(async () => terminalText(rows), {
                    timeout: 30_000,
                    message: 'getprop produced no output in the terminal',
                })
                .toContain('sdk_gphone64_x86_64');

            // A second command, whose expected output the DEVICE has to compute:
            // the echoed command line carries the expression, only the shell's own
            // output carries the product. Echoing the input back cannot pass this.
            const seed = 100_000 + Math.floor(Math.random() * 800_000);
            const computed = `QA_${seed * 3}`;
            await page.keyboard.type(`echo QA_$((${seed} * 3))`);
            await page.keyboard.press('Enter');
            await expect
                .poll(async () => terminalText(rows), {
                    timeout: 30_000,
                    message: `the shell did not evaluate the expression to ${computed}`,
                })
                .toContain(computed);

            // Proves the counting method can see the app's shell at all. Without
            // this, "the count returned to baseline" would also pass if the filter
            // never matched anything.
            expect(
                deviceShellCount(),
                'the running session is not visible in the device process table — the count below would be vacuous',
            ).toBeGreaterThan(baseline);

            // Closing goes through the confirm modal once a session has started.
            // Cancel first: a guard that cannot refuse proves nothing about the
            // "close" that follows.
            await closeButton(modal).click();
            const confirm = page.locator('dialog.shell-close-confirm-modal');
            await expect(confirm).toBeVisible();
            await confirm.locator('button.modal-button', { hasText: /^cancel$/ }).click();
            // Wait for removal, not just hidden: Modal.close() detaches after the
            // exit transition, and a second confirm opening meanwhile would make
            // the locator match two dialogs.
            await expect(confirm).toHaveCount(0);
            await expect(modal, 'cancel must leave the session open').toBeVisible();

            await closeButton(modal).click();
            await expect(confirm).toBeVisible();
            await confirm.locator('button.modal-button', { hasText: /^close$/ }).click();
            await expect(modal).toHaveCount(0);

            // The session ended cleanly: no orphaned shell survives on the device.
            await expect
                .poll(deviceShellCount, {
                    timeout: 30_000,
                    message: `an adb shell outlived the modal: count did not return to the baseline of ${baseline}`,
                })
                .toBe(baseline);
        } finally {
            await context?.close();
            await api.dispose();
        }
    });

    test('@device 9.2 the file modal browses, transfers and deletes on the device, remembers the icon size, and keeps the console quiet', async ({
        browser,
    }) => {
        test.setTimeout(240_000);
        const udid = deviceAddress();
        const api = await request.newContext({ baseURL: e2eBaseUrl() });
        let context: BrowserContext | undefined;
        const localDir = mkdtempSync(path.join(tmpdir(), 'qa-9-2-'));
        const fileName = `qa-upload-${randomBytes(4).toString('hex')}.txt`;
        const localFile = path.join(localDir, fileName);
        const remoteFile = `${WORK_DIR}/${fileName}`;
        const payload = `ws-scrcpy-web 9.2 ${randomBytes(16).toString('hex')}\n`;
        writeFileSync(localFile, payload, 'utf8');

        try {
            await mintToken(api);
            await connectDevice(api, udid);

            // The size picker only opens when no preference is stored, so the
            // preference is cleared first. 0 is the app's own in-band "cleared"
            // sentinel (valid sizes are 16-32) — this is the state a first-time
            // user is in, established rather than assumed from run order.
            await patchSettings(api, { iconSize: 0 });

            // A directory the modal can be navigated INTO, and a clean one: a
            // leftover from a died-mid-row run would make the "empty directory"
            // and post-delete assertions meaningless.
            qaAdb('shell', `rm -rf '${WORK_DIR}'`);
            qaAdb('shell', `mkdir -p '${WORK_DIR}'`);

            const opened = await openApp(browser);
            context = opened.context;
            const { page, logs, http } = opened;
            const row = await waitForDeviceRow(page, udid, 30_000);

            const listLink = row.locator('div.file-listing.desc-block > a.link-list-files');
            await expect(listLink).toHaveCount(1);
            await expect(listLink).toHaveText('list files');
            await listLink.click();

            const modal = page.locator('dialog.list-files-modal');
            await expect(modal).toBeVisible();

            // --- first open: the size picker, and a preference that survives a reload
            const picker = modal.locator('.list-files-size-picker');
            await expect(picker, 'no stored preference, so the picker must open').toBeVisible();
            const option28 = picker.locator('.list-files-size-option').filter({ hasText: '28px' });
            await option28.click();
            await expect(option28).toHaveClass(/selected/);
            await picker.locator('input[type="checkbox"]').check();
            await picker.locator('.list-files-size-picker-controls button.list-files-footer-btn').click();

            // The dialog's own inline custom property is what drives every icon in
            // the list, so it is the honest subject for "the size was applied".
            await expect
                .poll(async () => modal.evaluate((el) => el.style.getPropertyValue('--file-icon-size')), {
                    message: 'the chosen icon size was not applied to the dialog',
                })
                .toBe('28px');

            const breadcrumbs = modal.locator('.list-files-breadcrumbs');
            await expect(breadcrumbs).toBeVisible();
            await expect(modal.locator('.list-files-header')).toBeVisible();
            await expect(modal.locator('.list-files-breadcrumb-current')).toHaveText('tmp');

            // patchGlobal is fire-and-forget, so read it back from the server
            // rather than trusting the click. This is also the persistence claim.
            await expect
                .poll(async () => (await readSettings(api))['iconSize'], {
                    timeout: 15_000,
                    message: 'the icon-size preference never reached the server',
                })
                .toBe(28);

            // --- navigate into a directory row
            const dirRow = modal.locator(`.list-files-row[data-path="${WORK_DIR}"]`);
            await expect(dirRow, `${WORK_DIR} is missing from the listing of ${TMP_DIR}`).toBeVisible({
                timeout: 30_000,
            });
            await expect(dirRow).toHaveClass(/directory/);
            await dirRow.click();
            await expect(modal.locator('.list-files-breadcrumb-current')).toHaveText('qa-9-2');
            await expect(modal.locator('.list-files-loading')).toHaveText('empty directory');

            // --- upload
            // The hidden input is the same one the "upload" button clicks; driving
            // it directly is the only way to hand the browser a file, and it still
            // exercises the app's real push path (FilePushHandler → adb sync).
            await modal.locator('input[type="file"]').setInputFiles(localFile);
            const fileRow = modal.locator(`.list-files-row[data-path="${remoteFile}"]`);
            await expect(fileRow, 'the uploaded file never appeared in the listing').toBeVisible({ timeout: 60_000 });
            await expect(fileRow.locator('.list-files-row-name')).toHaveText(fileName);
            // The listing could be lying; the device is asked directly.
            expect(deviceFileExists(remoteFile), `${remoteFile} is not on the device`).toBe(true);
            expect(deviceFileText(remoteFile), 'the bytes on the device differ from the bytes uploaded').toBe(payload);

            // --- download
            // The row actions are visibility:hidden until the row is hovered, so a
            // bare click would wait forever on an invisible button.
            await fileRow.hover();
            const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
            await fileRow.locator('.list-files-action-download').click();
            const download = await downloadPromise;
            expect(download.suggestedFilename()).toBe(fileName);
            const downloadedPath = await download.path();
            expect(downloadedPath, 'the download produced no file').toBeTruthy();
            expect(
                readFileSync(downloadedPath as string, 'utf8'),
                'the downloaded bytes differ from the bytes on the device',
            ).toBe(payload);

            // --- delete
            // The row action asks through the native confirm(); accepting it is
            // part of the path under test.
            // Recorded rather than asserted inside the handler: a failed expect()
            // in an event listener surfaces as an unhandled rejection instead of a
            // named test failure.
            let confirmSeen = '';
            page.once('dialog', (d) => {
                confirmSeen = `${d.type()}: ${d.message()}`;
                void d.accept();
            });
            await fileRow.hover();
            await fileRow.locator('.list-files-action-delete').click();
            await expect(fileRow, 'the deleted file is still listed').toHaveCount(0, { timeout: 30_000 });
            expect(confirmSeen, 'the row delete must ask before it deletes').toBe(`confirm: delete "${fileName}"?`);
            await expect
                .poll(() => deviceFileExists(remoteFile), {
                    timeout: 30_000,
                    message: `${remoteFile} still exists on the device after the delete`,
                })
                .toBe(false);

            // --- back up through the breadcrumb
            await breadcrumbs.locator('.list-files-breadcrumb-segment', { hasText: /^tmp$/ }).click();
            await expect(modal.locator('.list-files-breadcrumb-current')).toHaveText('tmp');

            // --- the console stayed quiet through all of it (beta.66)
            // Snapshotted before the debug flag goes on, because debugError()
            // forwards to console.error once it is set.
            const quietErrors = [...logs.errors];
            const httpFailures = [...http];
            expect(
                httpFailures.filter((f) => f !== ALLOWED_HTTP_FAILURE),
                'a request failed that is not the unavoidable embed-consent refusal of this tier',
            ).toEqual([]);
            const forbiddenSeen = httpFailures.includes(ALLOWED_HTTP_FAILURE);
            expect(
                quietErrors.filter((l) => !(forbiddenSeen && RESOURCE_LOAD_403.test(l))),
                'the file-listing path logged errors on a healthy run',
            ).toEqual([]);
            expect(
                logs.all.filter((l) => l.includes('[ListFilesModal]')),
                'per-message traces must be gated behind the debug flag, not printed by default',
            ).toEqual([]);

            // --- the traces are gated, not deleted; and the preference survives a reload
            await page.evaluate(() => localStorage.setItem('ws-scrcpy-web-debug', 'true'));
            const before = logs.all.length;
            await page.reload();
            const row2 = await waitForDeviceRow(page, udid, 30_000);
            await row2.locator('div.file-listing.desc-block > a.link-list-files').click();
            const modal2 = page.locator('dialog.list-files-modal');
            await expect(modal2).toBeVisible();
            // Breadcrumbs mean initFileBrowser() ran; the picker branch and this
            // one are mutually exclusive, so asserting the picker's absence only
            // after the browser has rendered is a real check rather than a race.
            await expect(modal2.locator('.list-files-breadcrumbs')).toBeVisible({ timeout: 30_000 });
            await expect(
                modal2.locator('.list-files-size-picker'),
                'the saved preference must skip the picker',
            ).toHaveCount(0);
            expect(
                await modal2.evaluate((el) => el.style.getPropertyValue('--file-icon-size')),
                'the persisted icon size was not re-applied after the reload',
            ).toBe('28px');
            expect(
                logs.all.slice(before).filter((l) => l.includes('[ListFilesModal]')).length,
                'the debug flag must bring the per-message traces back — gated, not deleted',
            ).toBeGreaterThan(0);
        } finally {
            // Leave the preference cleared so a rerun starts from the same
            // first-time-user state this row establishes. Cleanup is swallowed on
            // purpose: a throw here would replace the real failure with its own.
            await patchSettings(api, { iconSize: 0 }).catch(() => {});
            try {
                qaAdb('shell', `rm -rf '${WORK_DIR}'`);
            } catch {
                // The next run recreates it from scratch anyway.
            }
            await context?.close();
            await api.dispose();
        }
    });

    test('@device 9.3 the sleep/wake button reflects the device state, changes it, and is themed by the state it shows', async ({
        browser,
    }) => {
        test.setTimeout(180_000);
        const udid = deviceAddress();
        const api = await request.newContext({ baseURL: e2eBaseUrl() });
        let context: BrowserContext | undefined;
        try {
            await mintToken(api);
            await connectDevice(api, udid);

            // Establish the starting state out of band (224 = KEYCODE_WAKEUP), and
            // confirm it through the app's own route, so "the button starts awake"
            // is a precondition this test owns rather than an inheritance from
            // whatever ran before it.
            if ((await screenState(api)).awake === false) qaAdb('shell', 'input', 'keyevent', '224');
            await expect
                .poll(async () => (await screenState(api)).awake, {
                    timeout: 30_000,
                    message: 'could not bring the device awake before the row starts',
                })
                .toBe(true);

            const opened = await openApp(browser);
            context = opened.context;
            const page = opened.page;
            const row = await waitForDeviceRow(page, udid, 30_000);
            const btn = row.locator('button.sleep-wake-btn');

            // The card renders `state-unknown` ("checking...") until the server's
            // poll has reported a screen state, so this waits for the real reading
            // rather than asserting on the placeholder.
            await expect(btn, 'the button never left the "checking..." placeholder').toHaveClass(/state-on/, {
                timeout: 60_000,
            });
            await expect(btn).toHaveText('turn off');
            await expect(btn).toHaveAttribute('data-awake', 'true');
            await expect(btn).toBeEnabled();
            // An awake device offers the destructive action, so it is painted in
            // the theme's danger colour.
            await expect(btn).toHaveCSS('color', await themeColor(page, '--danger-color'));

            // --- sleep
            await btn.click();
            await expect(btn).toHaveClass(/state-off/, { timeout: 30_000 });
            await expect(btn).toHaveText('turn on');
            await expect(btn).toHaveAttribute('data-awake', 'false');
            await expect(btn).toHaveCSS('color', await themeColor(page, '--success-color'));
            // The class is only a claim. This is the effect: the app's own
            // screen-state route reads `dumpsys power` on the device.
            await expect
                .poll(async () => (await screenState(api)).awake, {
                    timeout: 30_000,
                    message: 'the button showed asleep but the device is still awake',
                })
                .toBe(false);

            // --- wake again, leaving the device as the suite found it
            await btn.click();
            await expect(btn).toHaveClass(/state-on/, { timeout: 30_000 });
            await expect(btn).toHaveText('turn off');
            await expect(btn).toHaveAttribute('data-awake', 'true');
            await expect(btn).toHaveCSS('color', await themeColor(page, '--danger-color'));
            await expect
                .poll(async () => (await screenState(api)).awake, {
                    timeout: 30_000,
                    message: 'the button showed awake but the device is still asleep',
                })
                .toBe(true);
        } finally {
            // Never leave the emulator dark for the specs that follow. Swallowed
            // on purpose: a throw here would replace the real failure with its own.
            try {
                if ((await screenState(api).catch(() => ({ awake: true }))).awake === false) {
                    qaAdb('shell', 'input', 'keyevent', '224');
                }
            } catch {
                // The next row that needs the screen on establishes it itself.
            }
            await context?.close();
            await api.dispose();
        }
    });
});
