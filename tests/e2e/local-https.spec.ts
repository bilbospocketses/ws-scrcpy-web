import { expect, request, test } from '@playwright/test';
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
 * !!! THE OPT-IN "regenerate" TEST AT THE BOTTOM OF THIS FILE DESTROYS THE
 * !!! INSTALLED CA. Every test ABOVE it is safe to run against a server whose
 * !!! CA a device has already trusted (smoke row 21.2) — none of them call
 * !!! generate. Read that test's own doc comment before ever setting the
 * !!! second env var it needs.
 *
 * To run the safe (default) tests:
 *   1. On a machine on your LAN, generate a certificate for that machine's
 *      own LAN IP (Settings -> Server -> Local HTTPS -> ip address -> generate),
 *      and restart the server so the listener actually binds (generating
 *      alone does not -- the listener set is built once at boot; see
 *      smoke-test.md row 21.1).
 *   2. Note the https port (Local HTTPS -> https port; 8443 unless changed)
 *      and, if you changed the plain web port from its default, that too.
 *   3. QA_LAN_HTTPS_ORIGIN="https://<that LAN IP>:<https port>" \
 *      QA_LAN_HTTP_PORT="<plain web port, default 8000>" \
 *      npm run test:e2e -- local-https
 *
 * The origin must NOT be loopback (localhost / 127.0.0.1 / ::1) --
 * `http://localhost` is a secure context on its own, so a pass there would
 * prove nothing about the certificate. This spec FAILS (does not skip) if it
 * is pointed at one, since a skip there would look identical to "not
 * configured yet" and hide the mistake.
 */
const LAN_ORIGIN = process.env['QA_LAN_HTTPS_ORIGIN']; // e.g. https://192.168.86.3:8443
// The plain-http control needs the LAN address's real web port, not a
// guess (M4) -- default 8000 matches this repo's own default, but any
// server whose operator changed it needs this override or the control
// fails for a reason unrelated to what it tests.
const HTTP_PORT = process.env['QA_LAN_HTTP_PORT'] ?? '8000';
// Opt-in only (I9): sets ANY value to run the destructive regenerate test at
// the bottom of this file. Unset by default, deliberately -- see that test's
// own doc comment.
const ALLOW_REGENERATE = Boolean(process.env['QA_LAN_HTTPS_ALLOW_REGENERATE']);

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

/**
 * The plain-http control (below) only means what it claims when the server
 * is actually answering plain http to other machines -- under `httpsOnly` or
 * `redirect` it would fail (or redirect) for a reason that has nothing to do
 * with the certificate under test (M4). Reads the live mode via the same
 * `/api/tls/state` the panel itself reads; `undefined`/absent is the server's
 * own "unset" default (`open`), matched here rather than guessed. Returns
 * `null` -- unknown, never assumed -- when the read itself fails (wrong
 * credentials, older server, network hiccup), so the caller can skip with an
 * honest reason instead of asserting against a guess.
 */
async function currentHttpExposure(): Promise<'open' | 'httpsOnly' | 'redirect' | null> {
    // Non-null: only ever called after the describe-level test.skip(!LAN_ORIGIN, ...) has run.
    const api = await request.newContext({ baseURL: LAN_ORIGIN!, ignoreHTTPSErrors: true });
    try {
        const res = await api.get('/api/tls/state');
        if (!res.ok()) return null;
        const data = (await res.json().catch(() => null)) as { httpExposure?: string } | null;
        const mode = data?.httpExposure ?? 'open';
        return mode === 'open' || mode === 'httpsOnly' || mode === 'redirect' ? mode : null;
    } catch {
        return null;
    } finally {
        await api.dispose();
    }
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

        // M4's precondition, asserted rather than assumed: the plain-http
        // control below only proves what it claims to prove when plain http
        // actually answers other machines. Under a narrowed exposure mode it
        // would fail (httpsOnly: no answer at all) or pass for the wrong
        // reason (redirect: 30x's straight to https, so isSecureContext comes
        // back true and the assertion below would misread that as a pass).
        const exposure = await currentHttpExposure();
        test.skip(
            exposure === null,
            'could not read the live plain-http exposure mode from /api/tls/state — cannot tell whether the ' +
                'plain-http control below is meaningful. Check QA_LAN_HTTPS_ORIGIN is reachable and admin-readable.',
        );
        test.skip(
            exposure !== 'open',
            `this server's plain-http exposure is currently '${exposure}', not 'open' — the plain-http control ` +
                "below needs 'open' to mean anything (under 'httpsOnly' it gets no answer at all; under " +
                "'redirect' it 30x's straight to https and would pass for the wrong reason). Switch Settings → " +
                'Server → Local HTTPS → plain http exposure back to open to run this test.',
        );

        const httpsCtx = await browser.newContext({ ignoreHTTPSErrors: true });
        const httpCtx = await browser.newContext();
        try {
            const httpsPage = await httpsCtx.newPage();
            await httpsPage.goto(LAN_ORIGIN!);
            const httpsProbe = await httpsPage.evaluate(probeSecureContext);

            // The control, on the SAME LAN address, scheme (and, per M4,
            // port) only: without this, a pass above cannot be told apart
            // from "this browser reports isSecureContext true everywhere" —
            // the exact false-green this spec exists to rule out.
            const plainOrigin = LAN_ORIGIN!.replace(/^https:/, 'http:').replace(/:\d+$/, `:${HTTP_PORT}`);
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

    test('the Local HTTPS settings panel renders, and its CA-download / exposure-save network calls actually work, with a really visible alert', async ({
        browser,
    }) => {
        test.skip(isLoopbackOrigin, 'guarded by the loopback check above — running further here would be meaningless.');

        // Deliberately does NOT click generate (I9): that button deletes the
        // installed CA and mints a fresh one (`CertService.generate()` calls
        // `removeCaRoot()` unconditionally), invalidating the trust a device
        // established at smoke row 21.2 -- exactly the prerequisite this
        // spec's own run instructions ask an operator to set up first. CA
        // download and exposure-save go through the SAME `deps.fetchFn` call
        // generate does, so they exercise the identical unbound-fetch failure
        // mode without touching trust material. The opt-in test at the
        // bottom of this file covers generate itself, for whoever explicitly
        // accepts the cost.
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

            // CA download — a real network response turned into a real
            // browser download, not a mocked blob. The exact click that
            // throws "Illegal invocation" in a real browser if `fetchFn` is
            // ever wired unbound again (production did exactly this:
            // `fetchFn: fetch`). jsdom's fetch has no receiver check, so no
            // unit test can see that failure — only a real click, in a real
            // browser, against a real server can. Assumes a certificate
            // already exists (this spec's own prerequisite) so the download
            // button is enabled.
            const download = panel.locator('[data-tls-download]');
            const [downloadEvent] = await Promise.all([page.waitForEvent('download'), download.click()]);
            expect(downloadEvent.suggestedFilename()).toBe('ws-scrcpy-web-local-ca.pem');
            await expect(alert, 'alert visible after CA download').toBeVisible();
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

    test('opt-in: regenerate produces a fresh certificate, replaces the alert text, and DESTROYS the previously installed CA', async ({
        browser,
    }) => {
        // !!! DESTRUCTIVE !!! This test clicks [data-tls-generate] against the
        // LIVE server named by QA_LAN_HTTPS_ORIGIN. `CertService.generate()`
        // calls `removeCaRoot()` unconditionally and mints a brand-new CA —
        // so every device that trusted the OLD CA (including whatever ran
        // smoke row 21.2 to set this server up in the first place) stops
        // trusting it, permanently, the instant this test runs. There is no
        // undo: the old CA's private key is gone.
        //
        // Skipped unless QA_LAN_HTTPS_ALLOW_REGENERATE is explicitly set, so
        // the rest of this file (and the default `npm run test:e2e` command
        // in the run instructions above) is safe to run against a server
        // whose CA a real device already trusts. Only opt into this test on
        // a throwaway/test server, or one you are prepared to re-trust on
        // every device afterward.
        test.skip(
            !ALLOW_REGENERATE,
            'destructive — set QA_LAN_HTTPS_ALLOW_REGENERATE to run this. It deletes the installed CA and mints a ' +
                "new one; see this test's own doc comment before opting in.",
        );
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
            await expect(alert, 'alert hidden before generate').toBeHidden();

            const generate = panel.locator('[data-tls-generate]');
            await generate.click();
            await expect(alert, 'alert visible after generate').toBeVisible();
            // Prefix match, deliberately: a fresh certificate has no bound
            // listener until a restart (the listener set is built once at
            // boot), so the panel's own copy for this case differs from the
            // no-restart-needed wording ("certificate generated. restart the
            // server to start serving https." vs. plain "certificate
            // generated."). Both start the same way; this test cares that
            // generate succeeded, not which of the two follow-up sentences
            // applies to this particular server's boot state.
            await expect(alert).toHaveText(/^certificate generated\./);
        } finally {
            await ctx.close();
        }
    });
});
