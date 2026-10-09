import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import tls from 'node:tls';
import { type APIRequestContext, type Browser, expect, type Locator, type Page, request, test } from '@playwright/test';
import { dismissPromptsFor, mintToken } from './support/auth';
import {
    removePrivateRoot,
    type ServerHandle,
    seedPrivateDataRoot,
    spawnServer,
    stopServer,
    waitForServer,
    withTimeout,
} from './support/privateServer';
import { selfSignedCert } from './support/selfSignedCert';
import { countOccurrences, readServerLog } from './support/serverLog';
import { installFailingMkcert, plantCert, type TlsServerPaths, tlsServerPaths } from './support/tlsFixtures';
import { guardTlsWrites, openLocalHttpsPanel, stubTlsState } from './support/tlsPanel';

/**
 * Smoke module 21 (Local HTTPS), the fast-tier halves of rows 21.6, 21.8, 21.9,
 * 21.10 and 21.11 (item 164). Row 21.12 is in mkcert-provenance.spec.ts.
 *
 * Nothing in this file runs mkcert, downloads it, or installs a CA anywhere. A
 * certificate STATE comes from one of two places:
 *
 *   - a stubbed `GET /api/tls/state` (`page.route`), for the panel rows the
 *     coverage register names as stubbed (21.8, 21.9), against the shared
 *     server, with every /api/tls write caught in the browser;
 *   - a spec-owned server whose TLS home holds the throwaway in-process
 *     certificate from selfSignedCert.ts, written where mkcert would have put
 *     it, for the rows whose subject is the server itself (21.6's 400s,
 *     21.10, 21.11) and to check that each stubbed state is one the real
 *     server actually reports.
 *
 * On Windows the TLS home lives under LOCALAPPDATA, not under the data root.
 * Every private server is spawned with LOCALAPPDATA redirected into its own
 * root (`spawnServer`, support/privateServer.ts), and the shared server into the
 * suite's (playwright.config.ts). Without that, the 21.11 rows would delete the
 * developer's real CA.
 */

// ---------------------------------------------------------------------------
// Copied server and panel text. Never imported from src/ (the suite's rule);
// each names its source.
// ---------------------------------------------------------------------------

const NO_CERT_404 = { error: 'no certificate has been generated yet' }; // src/server/api/TlsApi.ts
const CA_RATE_429 = { error: 'too many CA downloads; wait a moment and try again' }; // TlsApi.ts
const CA_RATE_LIMIT = 10; // TlsApi.ts CA_ROOT_RATE_LIMIT
const CA_DOWNLOADED_LOG = 'CA root downloaded'; // TlsApi.ts
const KIND_400 = { error: 'kind must be "ip" or "hostname"' }; // TlsApi.ts
const VALUE_400 = { error: 'value is required' }; // TlsApi.ts
const SUBJECT_400 = { error: 'that address could not be used for a certificate' }; // TlsApi.ts
const GENERATE_500 = { error: 'certificate generation failed; see the server logs for the cause' }; // TlsApi.ts
const PORT_400 = { error: 'port must be an integer between 1 and 65535' }; // src/server/Config.ts validateHttpsPortInput

// src/app/client/settings/tabs/LocalHttpsTab.ts
const PANEL_PORT_REFUSAL = 'port must be an integer between 1 and 65535.';
const PANEL_PORT_SAVED = 'https port saved. the server is restarting for the change to take effect.';
const SUB_1024_ADVISORY = 'ports below 1024 need elevated privileges on this platform; the server may fail to start.';
const EXPOSURE_NEEDS_CERT =
    'generate a certificate first — https only and redirect only take effect once an https listener can exist.';
const EXPOSURE_NEEDS_RESTART =
    'restart the server first — https only and redirect only take effect once the https listener is actually running.';
const LISTENER_NOT_STARTED =
    'certificate ready, but the https listener has not started yet. restart the server to begin serving https — regenerating will not help, and destroys any ca a device has already installed.';
const LISTENER_STALE =
    'the https listener is running, but it is still serving the certificate from before your last regenerate — including a ca that no longer exists. restart the server so it serves the new one; until then, a device using the new ca will not match what is actually being served.';
const CA_RESTORE = 'regenerate to restore the ca download.';
const MKCERT_MISSING =
    'mkcert must be installed from the dependencies tab before https can be enabled and a certificate generated. until then, this section is unavailable.';
const EXPIRY_SOON_RE =
    /^this certificate expires on .+\. regenerate before then, or streaming stops working from other machines\.$/;
// Since 0.5.3 the per-OS install steps live on the help page; the panel links to section 4.
const TRUST_HELP_HREF = 'help/certificate-subject.html#4-installing-a-certificate-establishing-trust';
const CA_FILE_NAME = 'ws-scrcpy-web-local-ca.crt'; // src/common/CaDownload.ts
const SUBJECT_HELP_HREF = 'help/certificate-subject.html';
// public/help/certificate-subject.html
const HELP_TITLE = 'TLS Certificates: The Subject Name Explained — ws-scrcpy-web';
const HELP_H1 = 'Understanding TLS Certificates: The "Subject Name" Explained Simply';

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Stubbed /api/tls/state bodies. Each mirrors a shape the real server sends:
// the private-server rows below assert the server's own answer for the
// no-certificate and certificate-but-no-listener states against these, and the
// bound row against BOUND_LISTENER.
// ---------------------------------------------------------------------------

const LAN_IP = '192.168.50.10';
const NONE_STATE = {
    status: 'none',
    candidateIps: [LAN_IP],
    httpExposure: 'open',
    httpsListener: { bound: false },
    httpsPort: 8443,
};
function readyState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        status: 'ready',
        subject: LAN_IP,
        kind: 'ip',
        notAfter: new Date(Date.now() + 800 * DAY_MS).toISOString(),
        caPresent: true,
        candidateIps: [LAN_IP],
        httpExposure: 'open',
        httpsListener: { bound: false, reason: 'restart-required' },
        httpsPort: 8443,
        ...overrides,
    };
}
const BOUND_LISTENER = { bound: true, port: 8443 };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * A refusal's body is the generic copy and nothing else: none of the caller's
 * input, no path, no stack, and nothing of mkcert's own output.
 */
function expectGenericBody(text: string, echoes: string[], label: string): void {
    // Echoes on the raw body AND the decoded message: JSON escapes quotes and
    // backslashes, so a Windows path echoed into the body would not match the
    // raw text. The rest on the decoded message only, for the same reason.
    const message = String((JSON.parse(text) as { error?: unknown }).error);
    for (const echo of echoes) {
        expect(text, `${label}: echoes "${echo}"`).not.toContain(echo);
        expect(message, `${label}: echoes "${echo}"`).not.toContain(echo);
    }
    expect(message, `${label}: names mkcert`).not.toMatch(/mkcert/i);
    expect(message, `${label}: carries a path`).not.toMatch(/[\\/]/);
    expect(message, `${label}: carries a stack frame`).not.toMatch(/\bat\s+\S+\s+\(|Error:/);
}

function panelParts(panel: Locator) {
    return {
        alert: panel.locator('[data-tls-alert]'),
        port: panel.locator('[data-tls-port]'),
        portOk: panel.locator('[data-tls-port-ok]'),
        portNotice: panel.locator('[data-tls-port-notice]'),
        download: panel.locator('[data-tls-download]'),
        listenerNotice: panel.locator('[data-tls-listener-notice]'),
        caTrustNotice: panel.locator('[data-tls-ca-trust-notice]'),
        expiryNotice: panel.locator('[data-tls-expiry-notice]'),
        caRestoreNotice: panel.locator('[data-tls-ca-restore-notice]'),
        exposureOpen: panel.locator('[data-exposure="open"]'),
        exposureHttpsOnly: panel.locator('[data-exposure="httpsOnly"]'),
        exposureRedirect: panel.locator('[data-exposure="redirect"]'),
        exposureUnavailable: panel.locator('[data-exposure-unavailable-notice]'),
    };
}

/** 21.8's Expected, for one state: the two narrowing modes off with `notice`, open on. */
async function expectExposureGated(panel: Locator, notice: string): Promise<void> {
    const p = panelParts(panel);
    await expect(p.exposureOpen).toBeEnabled();
    await expect(p.exposureHttpsOnly).toBeDisabled();
    await expect(p.exposureRedirect).toBeDisabled();
    await expect(p.exposureUnavailable).toBeVisible();
    await expect(p.exposureUnavailable).toHaveText(notice);
}

async function expectExposureOpenToAll(panel: Locator): Promise<void> {
    const p = panelParts(panel);
    await expect(p.exposureOpen).toBeEnabled();
    await expect(p.exposureHttpsOnly).toBeEnabled();
    await expect(p.exposureRedirect).toBeEnabled();
    await expect(p.exposureUnavailable).toBeHidden();
}

async function tlsState(api: APIRequestContext): Promise<Record<string, unknown>> {
    const res = await api.get('/api/tls/state');
    expect(res.status(), 'GET /api/tls/state').toBe(200);
    return (await res.json()) as Record<string, unknown>;
}

/**
 * The fingerprint of the leaf the HTTPS listener actually serves, with
 * verification ON against exactly `expectedLeaf` (lifecycle.spec.ts's
 * httpsStatus does the same): serving anything else fails the handshake.
 */
function servedFingerprint(port: number, expectedLeaf: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = tls.connect({ host: 'localhost', port, ca: expectedLeaf, timeout: 3_000 }, () => {
            const fp = socket.getPeerCertificate().fingerprint256;
            socket.end();
            resolve(fp);
        });
        socket.on('timeout', () => socket.destroy(new Error('timeout')));
        socket.on('error', reject);
    });
}

interface PrivatePanel {
    page: Page;
    panel: Locator;
    close(): Promise<void>;
}

/** A fresh context on a private server, with the panel open. Only reads: any /api/tls write is caught and fails `close()`. */
async function openPrivatePanel(browser: Browser, baseURL: string): Promise<PrivatePanel> {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    const writes = await guardTlsWrites(page);
    await page.goto('/');
    const panel = await openLocalHttpsPanel(page);
    return {
        page,
        panel,
        async close() {
            await context.close();
            expect(writes.writes, 'the panel sent a /api/tls write').toEqual([]);
        },
    };
}

async function seedPrivateUser(baseURL: string): Promise<void> {
    const seed = await request.newContext({ baseURL });
    try {
        await mintToken(seed);
        // A fresh data root has no dismissed prompts (global-setup's PATCH lives
        // in the shared server's database).
        await dismissPromptsFor(seed);
    } finally {
        await seed.dispose();
    }
}

// ===========================================================================
// The panel, on the shared server, with /api/tls/state stubbed and every
// /api/tls write caught before it leaves the browser.
// ===========================================================================

test.describe('local https fast tier: the panel against stubbed state (smoke §21)', () => {
    test('21.1 generate and the subject controls wait for mkcert, with the line pointing at Dependencies (0.5.1)', async ({
        page,
    }) => {
        // Both reads stubbed: the shared server's mkcert state is not this
        // row's to decide, and nothing here may install it.
        const writes = await guardTlsWrites(page);
        await stubTlsState(page, NONE_STATE);
        let mkcertVersion: string | null = null;
        await page.route(
            (url) => url.pathname === '/api/dependencies',
            (route) =>
                route.request().method() === 'GET'
                    ? route.fulfill({
                          status: 200,
                          contentType: 'application/json',
                          body: JSON.stringify([
                              {
                                  name: 'mkcert',
                                  displayName: 'mkcert',
                                  description: 'stubbed',
                                  installedVersion: mkcertVersion,
                                  latestVersion: 'v0.1.0',
                                  status: mkcertVersion === null ? 'not-installed' : 'up-to-date',
                                  requiresRestart: false,
                                  canUpdate: true,
                                  deferInstall: true,
                              },
                          ]),
                      })
                    : route.fallback(),
        );
        await page.goto('/');

        let panel = await openLocalHttpsPanel(page);
        const notice = panel.locator('[data-tls-mkcert-notice]');
        await expect(panel.locator('[data-tls-generate]')).toBeDisabled();
        await expect(panel.locator('[data-tls-subject]')).toBeDisabled();
        await expect(panel.locator('input[name="tls-subject-kind"]')).toHaveCount(2);
        for (const radio of await panel.locator('input[name="tls-subject-kind"]').all()) {
            await expect(radio).toBeDisabled();
        }
        await expect(notice).toBeVisible();
        await expect(notice).toHaveText(MKCERT_MISSING);
        // 0.5.3: the note is the very first thing in the Local HTTPS tab.
        await expect(panel.locator('.settings-section-body > *').first()).toHaveAttribute('data-tls-mkcert-notice', '');
        // What needs no mkcert stays usable.
        await expect(panelParts(panel).port).toBeEnabled();
        await expect(panelParts(panel).portOk).toBeEnabled();

        mkcertVersion = 'v0.1.0';
        await page.reload();
        panel = await openLocalHttpsPanel(page);
        await expect(panel.locator('[data-tls-generate]')).toBeEnabled();
        await expect(panel.locator('[data-tls-subject]')).toBeEnabled();
        await expect(panel.locator('[data-tls-mkcert-notice]')).toBeHidden();
        expect(writes.writes).toEqual([]);
    });

    test('21.6 the panel refuses https port 0 and 70000 before any request; 9443 is sent (the sub-1024 advisory shows on Linux only)', async ({
        page,
    }) => {
        const writes = await guardTlsWrites(page, (pathname, body) =>
            pathname === '/api/tls/https-port'
                ? { status: 200, json: { ok: true, port: (body as { port: number }).port, restartRequired: true } }
                : { status: 418, json: { error: 'blocked by the e2e write guard' } },
        );
        await stubTlsState(page, readyState({ httpsListener: BOUND_LISTENER }));
        await page.goto('/');
        const panel = await openLocalHttpsPanel(page);
        const p = panelParts(panel);
        await expect(p.port).toHaveValue('8443');

        for (const bad of ['0', '70000']) {
            await p.port.fill(bad);
            await p.portOk.click();
            await expect(p.alert, `port ${bad}`).toBeVisible();
            await expect(p.alert, `port ${bad}`).toHaveText(PANEL_PORT_REFUSAL);
            await expect(p.alert, `port ${bad}`).toHaveClass(/settings-status-error/);
            expect(writes.writes, `port ${bad} reached the network`).toEqual([]);
        }

        // The advisory is per platform: the server's, as /api/service/status
        // reports it to the panel (LocalHttpsTab.ts subPrivilegedPortNotice).
        const status = await page.request.get('/api/service/status');
        expect(status.status(), 'GET /api/service/status').toBe(200);
        const platform = ((await status.json()) as { platform?: string }).platform;
        await p.port.fill('80');
        if (platform === 'linux' || platform === 'darwin') {
            await expect(p.portNotice).toBeVisible();
            await expect(p.portNotice).toHaveText(SUB_1024_ADVISORY);
        } else {
            await expect(p.portNotice, `no advisory on ${platform}`).toBeHidden();
        }

        // The control: a valid port does go out, once, with exactly that body.
        await p.port.fill('9443');
        await expect(p.portNotice).toBeHidden();
        await p.portOk.click();
        await expect.poll(() => writes.writes.length).toBe(1);
        expect(writes.writes[0]).toEqual({ method: 'POST', pathname: '/api/tls/https-port', body: { port: 9443 } });
        await expect(p.alert).toHaveText(PANEL_PORT_SAVED);
    });

    test('21.8 exposure modes are gated until a certificate serves: https only and redirect are disabled, with the reason, before a certificate and before the restart; open always works', async ({
        page,
    }) => {
        const writes = await guardTlsWrites(page);
        const state = await stubTlsState(page, NONE_STATE);
        await page.goto('/');

        // Before 21.1's generate: no certificate yet.
        let panel = await openLocalHttpsPanel(page);
        await expect(panel).toContainText('no certificate yet.');
        await expectExposureGated(panel, EXPOSURE_NEEDS_CERT);

        // After the generate, before its restart: a certificate, no listener.
        state.set(readyState());
        await page.reload();
        panel = await openLocalHttpsPanel(page);
        await expect(panelParts(panel).listenerNotice).toHaveText(LISTENER_NOT_STARTED);
        await expectExposureGated(panel, EXPOSURE_NEEDS_RESTART);

        // The control: once the listener is bound, both narrowing modes open up.
        state.set(readyState({ httpsListener: BOUND_LISTENER }));
        await page.reload();
        panel = await openLocalHttpsPanel(page);
        await expectExposureOpenToAll(panel);
        expect(writes.writes).toEqual([]);
    });

    test('21.9 notices and the trust guide: one link to the install guide, opening in a new tab; the expiry notice inside 30 days; restart-required while bound; "regenerate to restore the ca download." with the CA gone', async ({
        page,
    }) => {
        const writes = await guardTlsWrites(page);
        const state = await stubTlsState(
            page,
            readyState({
                notAfter: new Date(Date.now() + 10 * DAY_MS).toISOString(),
                caPresent: false,
                httpsListener: { ...BOUND_LISTENER, reason: 'restart-required' },
            }),
        );
        await page.goto('/');
        let panel = await openLocalHttpsPanel(page);
        let p = panelParts(panel);

        await expect(p.expiryNotice).toBeVisible();
        await expect(p.expiryNotice).toHaveText(EXPIRY_SOON_RE);
        await expect(p.listenerNotice).toBeVisible();
        await expect(p.listenerNotice).toHaveText(LISTENER_STALE);
        await expect(p.caRestoreNotice).toBeVisible();
        await expect(p.caRestoreNotice).toHaveText(CA_RESTORE);
        await expect(p.download).toBeDisabled();

        // The control: a certificate with 400 days left, its CA present and a
        // listener serving it. None of the three notices; the download works.
        state.set(readyState({ caPresent: true, httpsListener: BOUND_LISTENER }));
        await page.reload();
        panel = await openLocalHttpsPanel(page);
        p = panelParts(panel);
        await expect(p.caTrustNotice).toBeVisible();
        await expect(p.expiryNotice).toBeHidden();
        await expect(p.listenerNotice).toBeHidden();
        await expect(p.caRestoreNotice).toBeHidden();
        await expect(p.download).toBeEnabled();

        // The trust guide (0.5.3): one link to the help page's install section,
        // opening in a new tab, in place of the per-OS accordion.
        await expect(panel.locator('details')).toHaveCount(0);
        const guide = panel.locator('[data-tls-trust-help] a');
        await expect(guide).toHaveCount(1);
        await expect(guide).toBeVisible();
        await expect(guide).toHaveAttribute('href', TRUST_HELP_HREF);
        await expect(guide).toHaveAttribute('target', '_blank');
        await expect(guide).toHaveAttribute('rel', 'noopener noreferrer');
        await expect(guide).toContainText('opens in a new tab');
        expect(writes.writes).toEqual([]);
    });
});

test.describe('local https fast tier: the help page (smoke §21.16)', () => {
    test('21.16 the subject line and the install-guide line each open public/help/certificate-subject.html in a new tab, themed, at the right place', async ({
        page,
        context,
        baseURL,
    }) => {
        const writes = await guardTlsWrites(page);
        await stubTlsState(page, readyState({ httpsListener: BOUND_LISTENER }));
        await page.goto('/');
        const panel = await openLocalHttpsPanel(page);

        // Under the subject radios: one short line and a link to the explainer.
        const subjectLink = panel.locator('[data-tls-subject-guide] a');
        await expect(subjectLink).toHaveAttribute('href', SUBJECT_HELP_HREF);
        await expect(subjectLink).toHaveAttribute('target', '_blank');
        await expect(subjectLink).toHaveAttribute('rel', 'noopener noreferrer');
        await expect(subjectLink).toContainText('opens in a new tab');

        let popupPromise = context.waitForEvent('page');
        await subjectLink.click();
        let popup = await popupPromise;
        await popup.waitForLoadState();
        expect(popup.url()).toBe(`${baseURL}/${SUBJECT_HELP_HREF}`);
        await expect(popup).toHaveTitle(HELP_TITLE);
        await expect(popup.locator('h1')).toHaveText(HELP_H1);
        // Themed before paint from the app's own key, like subnets.html.
        await expect(popup.locator('html')).toHaveAttribute('data-theme', /^(dark|light)$/);
        await expect(popup.locator('h2')).toHaveCount(5);
        for (const h2 of await popup.locator('h2').all()) await expect(h2).toHaveAttribute('id', /.+/);
        // The explainer's own link lands on section 4.
        await popup.locator('a[href="#4-installing-a-certificate-establishing-trust"]').first().click();
        await expect(popup).toHaveURL(/#4-installing-a-certificate-establishing-trust$/);
        await popup.close();

        // Under the download: the install guide, opened straight at section 4.
        popupPromise = context.waitForEvent('page');
        await panel.locator('[data-tls-trust-help] a').click();
        popup = await popupPromise;
        await popup.waitForLoadState();
        expect(popup.url()).toBe(`${baseURL}/${TRUST_HELP_HREF}`);
        await expect(popup.locator('#4-installing-a-certificate-establishing-trust')).toBeInViewport();
        for (const id of [
            'windows',
            'macos',
            'linux',
            'ubuntu-debian',
            'fedora-rhel',
            'android',
            'ios-ipados',
            'firefox',
        ]) {
            await expect(popup.locator(`#${id}`), id).toHaveCount(1);
        }
        await popup.close();
        expect(writes.writes).toEqual([]);
    });
});

// ===========================================================================
// One spec-owned server, real TLS state, rows that need the server itself.
// Serial: the rows build on each other's state, and the last one restarts it.
// ===========================================================================

test.describe('local https fast tier: a spec-owned server (smoke §21)', () => {
    test.describe.configure({ mode: 'serial' });
    // http 8191; the configured https port 8192 never binds (no certificate at
    // boot); 8193 is 21.6's control target.
    const A: TlsServerPaths = tlsServerPaths('ws-scrcpy-web-e2e-164e-tls', 8191);
    const HTTPS_PORT = 8192;
    const NEW_HTTPS_PORT = 8193;
    let handle: ServerHandle | undefined;
    let api: APIRequestContext;

    test.beforeAll(async () => {
        test.setTimeout(150_000);
        seedPrivateDataRoot(A, { httpsPort: HTTPS_PORT });
        installFailingMkcert(A);
        handle = spawnServer(A);
        await waitForServer(handle, A.baseURL);
        await seedPrivateUser(A.baseURL);
        api = await request.newContext({ baseURL: A.baseURL });
        await mintToken(api);
    });

    test.afterAll(async () => {
        await api?.dispose();
        if (handle) {
            try {
                await stopServer(handle);
            } catch (err) {
                console.warn(`21.x cleanup: ${String(err)}`);
            }
        }
        removePrivateRoot(A);
    });

    test('21.8 against the real server, no certificate: the panel gates https only and redirect behind "generate a certificate first"', async ({
        browser,
    }) => {
        // The stub NONE_STATE is the server's own answer, port aside.
        expect(await tlsState(api)).toMatchObject({
            status: 'none',
            httpExposure: 'open',
            httpsListener: { bound: false },
            httpsPort: HTTPS_PORT,
        });
        expect((await tlsState(api))['httpsListener']).toEqual(NONE_STATE.httpsListener);
        const view = await openPrivatePanel(browser, A.baseURL);
        try {
            await expect(view.panel).toContainText('no certificate yet.');
            await expectExposureGated(view.panel, EXPOSURE_NEEDS_CERT);
        } finally {
            await view.close();
        }
    });

    test('21.10 ca-root: with no certificate 404 spends no rate-limit slot; with one, ten downloads within 60 s each serve the PEM and log, and the 11th is 429', async () => {
        // More 404s than the limit: had any of them spent a slot, the very
        // first real download below would already be refused.
        for (let i = 0; i < CA_RATE_LIMIT + 2; i++) {
            const res = await api.get('/api/tls/ca-root');
            expect(res.status(), `no-certificate request ${i + 1}`).toBe(404);
            expect(await res.json()).toEqual(NO_CERT_404);
        }

        const planted = plantCert(A);
        expect(await tlsState(api)).toMatchObject({
            status: 'ready',
            caPresent: true,
            httpsListener: { bound: false, reason: 'restart-required' },
        });

        const started = Date.now();
        for (let i = 0; i < CA_RATE_LIMIT; i++) {
            const res = await api.get('/api/tls/ca-root');
            expect(res.status(), `download ${i + 1}`).toBe(200);
            expect(res.headers()['content-type']).toBe('application/x-pem-file');
            expect(res.headers()['content-disposition']).toBe(`attachment; filename="${CA_FILE_NAME}"`);
            expect(await res.text(), `download ${i + 1} is the CA on disk`).toBe(planted.ca.cert);
        }
        const eleventh = await api.get('/api/tls/ca-root');
        expect(Date.now() - started, 'all eleven inside the 60 s window').toBeLessThan(60_000);
        expect(eleventh.status()).toBe(429);
        expect(await eleventh.json()).toEqual(CA_RATE_429);

        // One log line per SERVED download: ten, not twelve 404s and not the 429.
        expect(countOccurrences(readServerLog(A), CA_DOWNLOADED_LOG)).toBe(CA_RATE_LIMIT);
    });

    test('21.11 generate refuses a bad kind, an empty value and unusable subjects with 400 and a generic message; nothing is echoed, the CA is untouched, the detail is in the log', async () => {
        const caBefore = readFileSync(A.caPemFile, 'utf8');
        const leafBefore = readFileSync(A.certFile, 'utf8');
        const cases: {
            name: string;
            body: unknown;
            expected: { error: string };
            echoes: string[];
            logged?: string;
        }[] = [
            {
                name: 'a bad kind',
                body: { kind: 'e2e164e-kind', value: '10.164.1.1' },
                expected: KIND_400,
                echoes: ['e2e164e-kind', '10.164.1.1'],
            },
            { name: 'no kind', body: { value: '10.164.1.2' }, expected: KIND_400, echoes: ['10.164.1.2'] },
            { name: 'an empty value', body: { kind: 'ip', value: '' }, expected: VALUE_400, echoes: [] },
            { name: 'a blank value', body: { kind: 'hostname', value: '   ' }, expected: VALUE_400, echoes: [] },
            { name: 'no value', body: { kind: 'ip' }, expected: VALUE_400, echoes: [] },
            {
                name: 'a name under kind ip',
                body: { kind: 'ip', value: 'e2e164e-not-an-ip.lan' },
                expected: SUBJECT_400,
                echoes: ['e2e164e'],
                logged: `kind 'ip' but "e2e164e-not-an-ip.lan" is not an IP address`,
            },
            {
                name: 'an IP under kind hostname',
                body: { kind: 'hostname', value: '10.164.9.8' },
                expected: SUBJECT_400,
                echoes: ['10.164.9.8'],
                logged: `kind 'hostname' but "10.164.9.8" is an IP address`,
            },
            {
                name: 'a single-label hostname',
                body: { kind: 'hostname', value: 'e2e164esingle' },
                expected: SUBJECT_400,
                echoes: ['e2e164e'],
                logged: '"e2e164esingle" is too short, or a public suffix',
            },
            {
                name: 'a public suffix',
                body: { kind: 'hostname', value: 'co.uk' },
                expected: SUBJECT_400,
                echoes: ['co.uk'],
                logged: '"co.uk" is too short, or a public suffix',
            },
            {
                name: 'a subject with a port',
                body: { kind: 'ip', value: '10.164.9.9:8443' },
                expected: SUBJECT_400,
                echoes: ['10.164.9.9'],
                logged: 'invalid certificate subject: "10.164.9.9:8443"',
            },
            {
                name: 'markup',
                body: { kind: 'hostname', value: '<b>e2e164e</b>' },
                expected: SUBJECT_400,
                echoes: ['<b>', 'e2e164e'],
                logged: 'invalid certificate subject: "<b>e2e164e</b>"',
            },
        ];
        for (const c of cases) {
            const res = await api.post('/api/tls/generate', { data: c.body });
            const text = await res.text();
            expect(res.status(), `${c.name}: ${text}`).toBe(400);
            expect(JSON.parse(text), c.name).toEqual(c.expected);
            expectGenericBody(text, c.echoes, c.name);
        }

        // Refused before removeCaRoot: the CA and the leaf are exactly as they were.
        expect(readFileSync(A.caPemFile, 'utf8'), 'CA after the refusals').toBe(caBefore);
        expect(readFileSync(A.certFile, 'utf8'), 'leaf after the refusals').toBe(leafBefore);

        // What the client was not told, the log was.
        const log = readServerLog(A);
        for (const c of cases) {
            if (c.logged) expect(log, `${c.name} logged`).toContain('generate refused: invalid certificate subject');
            if (c.logged) expect(log, `${c.name} logged`).toContain(c.logged);
        }
    });

    test('21.11 a usable subject passes validation, and mkcert itself failing answers 500 with a generic message; mkcert output is in the log only', async () => {
        const subject = '10.164.5.5';
        const res = await api.post('/api/tls/generate', { data: { kind: 'ip', value: subject } });
        const text = await res.text();
        expect(res.status(), text).toBe(500);
        expect(JSON.parse(text)).toEqual(GENERATE_500);
        expectGenericBody(text, [subject, A.mkcertExe, 'bad option'], 'mkcert failure');

        const line = readServerLog(A)
            .split(/\r?\n/)
            .find((l) => l.includes('generate failed: mkcert failed (exit '));
        expect(line, 'the mkcert failure is logged').toBeDefined();
        const detail = (line ?? '').replace(/^.*generate failed: mkcert failed \(exit \d+\): ?/, '');
        expect(detail.length, `the log carries mkcert's stderr: ${line}`).toBeGreaterThan(0);
        expectGenericBody(text, [detail], 'mkcert failure vs its own logged detail');

        // It got past every check above: generate removes the old CA only after
        // validation, right before spawning mkcert. The leaf survives.
        expect(existsSync(A.caPemFile), 'CA removed by the attempted generate').toBe(false);
        expect(existsSync(A.certFile), 'the old leaf survives a failed generate').toBe(true);
        expect(await tlsState(api)).toMatchObject({ status: 'ready', caPresent: false });
        // No CA: 404, and checked ahead of the (exhausted) rate limit.
        const caRoot = await api.get('/api/tls/ca-root');
        expect(caRoot.status()).toBe(404);
        expect(await caRoot.json()).toEqual(NO_CERT_404);
    });

    test('21.9 against the real server: a leaf with no CA beside it reads "regenerate to restore the ca download.", the download is disabled, the expiry notice shows inside 30 days, and the listener asks for a restart', async ({
        browser,
    }) => {
        const before = await tlsState(api);
        expect(before).toMatchObject({ status: 'ready', caPresent: false });
        expect(before['httpsListener']).toEqual({ bound: false, reason: 'restart-required' });
        // The planted leaf runs out in a day.
        const notAfter = Date.parse(String(before['notAfter']));
        expect(notAfter - Date.now()).toBeLessThan(30 * DAY_MS);

        const gone = await openPrivatePanel(browser, A.baseURL);
        try {
            const p = panelParts(gone.panel);
            await expect(p.caRestoreNotice).toBeVisible();
            await expect(p.caRestoreNotice).toHaveText(CA_RESTORE);
            await expect(p.download).toBeDisabled();
            await expect(p.expiryNotice).toBeVisible();
            await expect(p.expiryNotice).toHaveText(EXPIRY_SOON_RE);
            await expect(p.listenerNotice).toHaveText(LISTENER_NOT_STARTED);
            // 21.8 on the real server, after a "generate" and before its restart.
            await expectExposureGated(gone.panel, EXPOSURE_NEEDS_RESTART);
        } finally {
            await gone.close();
        }

        // The control: a CA back on disk clears the notice and enables the download.
        writeFileSync(A.caPemFile, selfSignedCert('ws-scrcpy-web e2e CA').cert, 'utf8');
        expect(await tlsState(api)).toMatchObject({ status: 'ready', caPresent: true });
        const back = await openPrivatePanel(browser, A.baseURL);
        try {
            const p = panelParts(back.panel);
            await expect(p.download).toBeEnabled();
            await expect(p.caRestoreNotice).toBeHidden();
        } finally {
            await back.close();
        }
    });

    test('21.6 POST /api/tls/https-port refuses 0, 70000 and other non-ports with 400 and saves nothing; a valid port is saved and the server exits 75 to restart', async () => {
        const configHttpsPort = () =>
            (JSON.parse(readFileSync(A.configPath, 'utf8')) as { httpsPort?: number }).httpsPort;
        const refused: { label: string; data: Record<string, unknown> }[] = [
            { label: '0', data: { port: 0 } },
            { label: '70000', data: { port: 70000 } },
            { label: '-1', data: { port: -1 } },
            { label: '1.5', data: { port: 1.5 } },
            { label: 'the string "9443"', data: { port: '9443' } },
            { label: 'null', data: { port: null } },
            { label: 'no port', data: {} },
        ];
        for (const r of refused) {
            const res = await api.post('/api/tls/https-port', { data: r.data });
            expect(res.status(), r.label).toBe(400);
            expect(await res.json(), r.label).toEqual(PORT_400);
        }
        expect(configHttpsPort(), 'config.json after the refusals').toBe(HTTPS_PORT);
        expect(existsSync(A.restartMarkerPath), 'no restart requested by a refusal').toBe(false);
        expect(handle?.child.exitCode, 'still running after the refusals').toBeNull();

        // The control: a valid port is saved and the restart is scheduled. The
        // rebind on the new port needs a supervisor (Windows guest tier).
        const ok = await api.post('/api/tls/https-port', { data: { port: NEW_HTTPS_PORT } });
        expect(ok.status()).toBe(200);
        expect(await ok.json()).toEqual({ ok: true, port: NEW_HTTPS_PORT, restartRequired: true });
        expect(configHttpsPort(), 'config.json after the save').toBe(NEW_HTTPS_PORT);
        expect(existsSync(A.restartMarkerPath), 'the .restart marker').toBe(true);
        const exit = await withTimeout(handle!.exited, 15_000, () => `waiting for exit 75:\n${handle!.output()}`);
        expect(exit.code, handle!.output()).toBe(75);
    });
});

// ===========================================================================
// A bound listener (21.9's restart-required while bound), on a second
// spec-owned server that boots with a certificate already in its TLS home.
// ===========================================================================

test('21.9 against a real bound listener: a new leaf under it reports restart-required while bound stays true, the old leaf is still served, and the panel says so', async ({
    browser,
}) => {
    test.setTimeout(150_000);
    // http 8194, https 8195.
    const B = tlsServerPaths('ws-scrcpy-web-e2e-164e-bound', 8194);
    const SECURE_PORT = 8195;
    seedPrivateDataRoot(B, { httpsPort: SECURE_PORT });
    const first = plantCert(B);
    const handle = spawnServer(B);
    const api = await request.newContext({ baseURL: B.baseURL });
    try {
        await waitForServer(handle, B.baseURL);
        await seedPrivateUser(B.baseURL);
        await mintToken(api);
        const firstFp = new X509Certificate(first.leaf.cert).fingerprint256;
        await expect
            .poll(() => servedFingerprint(SECURE_PORT, first.leaf.cert).catch((e: Error) => e.message), {
                timeout: 30_000,
            })
            .toBe(firstFp);

        const bound = await tlsState(api);
        expect(bound).toMatchObject({ status: 'ready', caPresent: true });
        expect(bound['httpsListener'], 'bound, serving the leaf on disk').toEqual({ bound: true, port: SECURE_PORT });

        // 21.8's control on the real server: a serving listener opens both narrowing modes.
        const serving = await openPrivatePanel(browser, B.baseURL);
        try {
            await expectExposureOpenToAll(serving.panel);
            await expect(panelParts(serving.panel).listenerNotice).toBeHidden();
        } finally {
            await serving.close();
        }

        // What a regenerate leaves behind: a new leaf (and CA) on disk under a listener built at boot.
        const second = plantCert(B);
        expect(new X509Certificate(second.leaf.cert).fingerprint256).not.toBe(firstFp);
        const stale = await tlsState(api);
        expect(stale['httpsListener'], 'bound stays true; the reason says restart').toEqual({
            bound: true,
            port: SECURE_PORT,
            reason: 'restart-required',
        });
        expect(await servedFingerprint(SECURE_PORT, first.leaf.cert), 'the socket still serves the old leaf').toBe(
            firstFp,
        );

        const staleView = await openPrivatePanel(browser, B.baseURL);
        try {
            const notice = panelParts(staleView.panel).listenerNotice;
            await expect(notice).toBeVisible();
            await expect(notice).toHaveText(LISTENER_STALE);
        } finally {
            await staleView.close();
        }
    } finally {
        await api.dispose();
        try {
            await stopServer(handle);
        } catch (err) {
            console.warn(`21.9 cleanup: ${String(err)}`);
        }
        removePrivateRoot(B);
    }
});

/*
 * Row 21.12 (mkcert provenance refusals) is not here: it lives in
 * mkcert-provenance.spec.ts, which points every mkcert URL at a fixture
 * release server through WS_SCRCPY_MKCERT_URL_BASE (item 167, beta.176).
 */
