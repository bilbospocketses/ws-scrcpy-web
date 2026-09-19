import { expect, test } from '@playwright/test';
import { openSettings, openSettingsTab } from './support/auth';

/**
 * Local HTTPS — the one spec in this plan that runs the feature in a real
 * browser instead of jsdom.
 *
 * Every other task in this plan is unit-tested, and jsdom cannot see two whole
 * classes of defect that matter here:
 *
 *   - It applies NO stylesheet. A `[hidden]` element and a visible one are
 *     indistinguishable to `expect(el).toBeVisible()` there, so a class rule
 *     that outranks the UA stylesheet's `[hidden] { display: none }` — this
 *     repo has shipped exactly that bug before, in the dependencies panel —
 *     passes every unit test and is still broken on screen.
 *   - It has no WebCodecs and no real `fetch` receiver check. `VideoDecoder`
 *     is simply absent, so nothing there can prove the point of this feature
 *     (a secure context that can decode video); and jsdom's `fetch` is an
 *     ordinary function with no "must be called on `window`" requirement, so
 *     `fetchFn: fetch` (unbound) throws `Illegal invocation` in a real Chrome
 *     click handler while sailing through every unit test that stubs it.
 *
 * So this spec needs a REAL browser pointed at a REAL LAN origin serving a
 * REAL generated certificate — none of which this repo's fast/container/
 * device tiers provide. It is `test.skip`-gated on `QA_LAN_HTTPS_ORIGIN` and
 * is recorded in docs/smoke-tests/automation-coverage.md as manual/conditional,
 * not automated: a spec that skips by default proves nothing about the
 * feature on any run that does not set the env var, and recording that as
 * "automated coverage" would be the documentation equivalent of a false
 * green. See docs/smoke-tests/smoke-test.md row 21.1 for the full manual
 * procedure this spec's own half plugs into (generate on this machine, then
 * point a SECOND machine at this spec's origin to drive the browser checks).
 *
 * To run it:
 *   1. On a machine on your LAN, generate a certificate for that machine's
 *      own LAN IP (Settings -> Server -> Local HTTPS -> ip address -> generate).
 *   2. Note the https port (Local HTTPS -> https port; 8443 unless changed).
 *   3. QA_LAN_HTTPS_ORIGIN="https://<that LAN IP>:<https port>" npm run test:e2e -- local-https
 *
 * The origin must NOT be loopback (localhost / 127.0.0.1 / ::1) --
 * `http://localhost` is a secure context all on its own, so a pass there
 * would prove nothing about the certificate. This spec FAILS (does not skip)
 * if it is pointed at one, since a skip there would look identical to "not
 * configured yet" and hide the mistake.
 */
const LAN_ORIGIN = process.env['QA_LAN_HTTPS_ORIGIN']; // e.g. https://192.168.86.3:8443

function hostnameOf(origin: string): string | null {
    try {
        // IPv6 literals come back bracketed ("[::1]") from URL#hostname; strip
        // both brackets so it compares equal to the bare form in LOOPBACK_HOSTS.
        return new URL(origin).hostname.replace(/^\[|\]$/g, '');
    } catch {
        return null;
    }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const isLoopbackOrigin = LAN_ORIGIN !== undefined && LOOPBACK_HOSTS.has(hostnameOf(LAN_ORIGIN) ?? '');

/** Same probe run against both the https and the plain-http origin below —
 *  one function, so the two sides can only differ in what they measure, never
 *  in how. */
function probeSecureContext() {
    return (async () => ({
        isSecureContext: window.isSecureContext,
        hasVideoDecoder: typeof VideoDecoder !== 'undefined',
        h264:
            typeof VideoDecoder === 'undefined'
                ? false
                : (await VideoDecoder.isConfigSupported({ codec: 'avc1.42E01E', codedWidth: 1280, codedHeight: 720 }))
                      .supported,
    }))();
}

test.describe('local https', () => {
    // Absent entirely: this whole spec needs a real LAN origin nothing in CI
    // provisions, so it is skipped by default everywhere. A present-but-
    // loopback origin is NOT covered by this skip -- see the dedicated test
    // below, which fails instead.
    test.skip(!LAN_ORIGIN, 'QA_LAN_HTTPS_ORIGIN not set — see the class doc comment for how to run this manually.');

    test('QA_LAN_HTTPS_ORIGIN must not be a loopback address', () => {
        // Deliberately NOT gated by test.skip(isLoopbackOrigin, ...): a skip
        // here would render identically to "not configured", so someone who
        // mis-sets the env var to http://localhost would see green and
        // believe the certificate had been proven. This must fail loudly.
        expect(
            isLoopbackOrigin,
            `QA_LAN_HTTPS_ORIGIN (${LAN_ORIGIN}) resolves to a loopback address. ` +
                'http://localhost is a secure context on its own, so testing against it ' +
                'proves nothing about the certificate — point this at a real LAN address instead.',
        ).toBe(false);
    });

    test('a generated certificate yields a secure context with a working decoder, contrasted against plain http on the same LAN address', async ({
        browser,
    }) => {
        test.skip(isLoopbackOrigin, 'guarded by the loopback check above — running further here would be meaningless.');

        const httpsCtx = await browser.newContext({ ignoreHTTPSErrors: true });
        const httpCtx = await browser.newContext();
        try {
            const httpsPage = await httpsCtx.newPage();
            await httpsPage.goto(LAN_ORIGIN!);
            const httpsProbe = await httpsPage.evaluate(probeSecureContext);

            // The control, on the SAME LAN address, scheme only: without this,
            // a pass above cannot be told apart from "this browser reports
            // isSecureContext true everywhere" — the exact false-green this
            // spec exists to rule out.
            const plainOrigin = LAN_ORIGIN!.replace(/^https:/, 'http:').replace(/:\d+$/, ':8000');
            const httpPage = await httpCtx.newPage();
            await httpPage.goto(plainOrigin);
            const httpProbe = await httpPage.evaluate(probeSecureContext);

            // A contrast pair inside one test: both sides measured the same
            // way, in the same run, so the certificate — not a difference in
            // how the two probes were taken — is what the gap is attributed to.
            expect(httpsProbe.isSecureContext, 'https origin: isSecureContext').toBe(true);
            expect(httpProbe.isSecureContext, 'plain-http origin: isSecureContext').toBe(false);
            expect(httpsProbe.hasVideoDecoder, 'https origin: VideoDecoder present').toBe(true);
            expect(httpProbe.hasVideoDecoder, 'plain-http origin: VideoDecoder present').toBe(false);
            // isConfigSupported, not just presence: a decoder that exists but
            // cannot configure would pass a typeof check and still not stream.
            expect(httpsProbe.h264, 'https origin: h264 isConfigSupported').toBe(true);
        } finally {
            await httpsCtx.close();
            await httpCtx.close();
        }
    });

    test('the Local HTTPS settings panel drives real generate / CA-download / exposure-save network calls, and its alert is really visible, not just present', async ({
        browser,
    }) => {
        test.skip(isLoopbackOrigin, 'guarded by the loopback check above — running further here would be meaningless.');

        const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
        try {
            const page = await ctx.newPage();
            await page.goto(LAN_ORIGIN!);

            const settings = await openSettings(page);
            const server = await openSettingsTab(settings, 'Server');
            const panel = server
                .locator('section.settings-section')
                .filter({ has: page.locator('h3.settings-section-heading', { hasText: 'Local HTTPS' }) });
            await expect(panel).toBeVisible();

            const alert = panel.locator('[data-tls-alert]');
            // Contrast pair on REAL visibility, not text presence: jsdom
            // applies no stylesheet, so it cannot see either half of this —
            // a `[hidden]` element there and a shown one are indistinguishable
            // to toBeVisible(). This repo has shipped exactly the bug this
            // guards: a class rule's `display` silently outranking the UA
            // stylesheet's `[hidden] { display: none }`.
            await expect(alert, 'alert hidden before any action').toBeHidden();

            // generate — the exact click that throws "Illegal invocation" in a
            // real browser if `fetchFn` is ever wired unbound again
            // (production did exactly this: `fetchFn: fetch`). jsdom's fetch
            // has no receiver check, so no unit test can see that failure —
            // only a real click, in a real browser, against a real server can.
            const generate = panel.locator('[data-tls-generate]');
            await generate.click();
            await expect(alert, 'alert visible after generate').toBeVisible();
            await expect(alert).toHaveText(/^certificate generated\./);

            // CA download — a real network response turned into a real browser
            // download, not a mocked blob.
            const download = panel.locator('[data-tls-download]');
            const [downloadEvent] = await Promise.all([page.waitForEvent('download'), download.click()]);
            expect(downloadEvent.suggestedFilename()).toBe('ws-scrcpy-web-local-ca.pem');
            await expect(alert).toHaveText('ca certificate downloaded.');

            // exposure save — re-saves whatever mode is already selected
            // (never flips a radio here), so this does not change the
            // server's live LAN reachability out from under whoever is
            // running the manual procedure this spec plugs into (smoke row
            // 21.1/21.3).
            const exposureOk = panel.locator('[data-exposure-ok]');
            await exposureOk.click();
            await expect(alert).toHaveText(
                /^(plain-http exposure updated\.|this server does not support saving this setting yet\.)$/,
            );
        } finally {
            await ctx.close();
        }
    });
});
