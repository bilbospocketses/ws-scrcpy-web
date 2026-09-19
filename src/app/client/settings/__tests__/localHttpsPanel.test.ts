// @vitest-environment jsdom
// src/app/client/settings/__tests__/localHttpsPanel.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    buildLocalHttpsPanel,
    certExpiryNotice,
    certSubjectMismatchNotice,
    firefoxTrustNote,
    listenerStatusNotice,
    subPrivilegedPortNotice,
    trustInstructionsFor,
} from '../tabs/ServerTab';

const state = (over = {}) => ({ status: 'none', ...over });

describe('local https panel', () => {
    it('offers the machine IP prefilled, so the common case is one click', async () => {
        const elA = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        expect(elA.querySelector<HTMLInputElement>('[data-tls-subject]')!.value).toBe('192.168.86.3');

        // Contrast: a different candidate list produces a different prefill --
        // proves the value is READ from deps, not a hardcoded string that
        // happens to match the fixture above.
        const elB = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['10.0.0.5'],
            platform: 'win32',
        });
        expect(elB.querySelector<HTMLInputElement>('[data-tls-subject]')!.value).toBe('10.0.0.5');
    });

    it('warns that a sub-1024 port needs privileges outside win32, and only then', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3'],
            platform: 'linux',
        });
        const port = el.querySelector<HTMLInputElement>('[data-tls-port]')!;
        const notice = el.querySelector<HTMLElement>('[data-tls-port-notice]')!;

        // At rest (the default 8443 prefill) the notice must be genuinely
        // HIDDEN -- not merely absent from a text match, which jsdom would
        // still satisfy even with `setNotice`'s `hidden` line deleted.
        expect(notice.hidden).toBe(true);

        port.value = '443';
        port.dispatchEvent(new Event('input'));
        expect(notice.hidden).toBe(false);
        expect(notice.textContent).toMatch(/elevated privileges/i);

        // Back to a normal port: hides again -- proves it tracks the CURRENT
        // value rather than latching on once shown.
        port.value = '8443';
        port.dispatchEvent(new Event('input'));
        expect(notice.hidden).toBe(true);
    });

    it('does not warn about a sub-1024 port on win32', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        const port = el.querySelector<HTMLInputElement>('[data-tls-port]')!;
        port.value = '443';
        port.dispatchEvent(new Event('input'));
        expect(el.querySelector<HTMLElement>('[data-tls-port-notice]')!.hidden).toBe(true);
    });

    it('promises no lockout when a narrowed mode is selected, and says nothing for open', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state({ status: 'ready' })))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        const lockout = el.querySelector<HTMLElement>('[data-exposure-lockout-notice]')!;
        // Element name predates the review addendum's correction: exposure
        // takes effect on the next request with no restart (HttpServer.ts
        // re-reads HTTP_EXPOSURE_KEY fresh every time) -- unlike the https
        // port, which always restarts. "restart" here now names the DOM
        // hook, not the content.
        const effectNotice = el.querySelector<HTMLElement>('[data-exposure-restart-notice]')!;
        expect(lockout.hidden).toBe(true);
        expect(effectNotice.hidden).toBe(true);

        el.querySelector<HTMLInputElement>('[data-exposure="httpsOnly"]')!.click();
        expect(lockout.hidden).toBe(false);
        expect(effectNotice.hidden).toBe(false);
        expect(lockout.textContent).toMatch(/cannot lock yourself out/i);
        expect(effectNotice.textContent).toMatch(/takes effect immediately for new connections/i);
        expect(effectNotice.textContent).toMatch(/already running are not affected/i);

        // Back to open: both notices withdraw -- proves they track the
        // CURRENT selection, not a one-way "has ever been narrowed" flag.
        el.querySelector<HTMLInputElement>('[data-exposure="open"]')!.click();
        expect(lockout.hidden).toBe(true);
        expect(effectNotice.hidden).toBe(true);
    });

    it('tells the user streaming already works, once a downloadable certificate exists', async () => {
        // The measured fact that makes this panel honest: a click-through cert
        // warning is still a secure context. Someone seeing a browser warning
        // assumes it is broken and stops; this is where that gets corrected.
        // I6: reworded as an unconditional line (no signal exists for whether
        // THIS browser already trusts the CA), so it fires whenever the CA is
        // downloadable, not only when told the browser distrusts it.
        const elNone = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        expect(elNone.querySelector<HTMLElement>('[data-tls-ca-trust-notice]')!.hidden).toBe(true);

        const elReady = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state({ status: 'ready' })))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
            // Vestigial (I6) -- kept only so this call matches the brief's
            // fixed test shape; the notice no longer branches on it.
            caTrusted: false,
        });
        const notice = elReady.querySelector<HTMLElement>('[data-tls-ca-trust-notice]')!;
        expect(notice.hidden).toBe(false);
        expect(notice.textContent).toMatch(/streaming already works/i);
    });

    it('shows the ca-restore note instead of the trust note when caPresent is false (M4)', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state({ status: 'ready', caPresent: false })))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        const trustNotice = el.querySelector<HTMLElement>('[data-tls-ca-trust-notice]')!;
        const restoreNotice = el.querySelector<HTMLElement>('[data-tls-ca-restore-notice]')!;
        expect(restoreNotice.hidden).toBe(false);
        expect(restoreNotice.textContent).toMatch(/regenerate to restore the ca download/i);
        // Mutually exclusive: "install the ca below" would be meaningless
        // while the download button it points at is disabled.
        expect(trustNotice.hidden).toBe(true);
        expect(el.querySelector<HTMLButtonElement>('[data-tls-download]')!.disabled).toBe(true);
    });

    it('says a hostname must resolve on every client, and stays silent for an ip subject', async () => {
        const elIp = await buildLocalHttpsPanel({
            fetchFn: vi.fn(
                async () =>
                    new Response(JSON.stringify(state({ status: 'ready', kind: 'ip', subject: '192.168.86.3' }))),
            ),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        expect(elIp.querySelector<HTMLElement>('[data-tls-hostname-notice]')!.hidden).toBe(true);

        const elHost = await buildLocalHttpsPanel({
            fetchFn: vi.fn(
                async () =>
                    new Response(JSON.stringify(state({ status: 'ready', kind: 'hostname', subject: 'devices.lan' }))),
            ),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        const notice = elHost.querySelector<HTMLElement>('[data-tls-hostname-notice]')!;
        expect(notice.hidden).toBe(false);
        expect(notice.textContent).toMatch(/must resolve on every machine/i);
    });

    it('shows a persistent allowedHosts note for the current hostname cert, not just at generate time (I9)', async () => {
        // Unlike the transient "added X to allowedHosts" alert (which fires
        // once, at generate time), this reflects the STANDING fact that a
        // hostname-kind cert's subject is registered -- true on every load,
        // not only right after a generate.
        const elIp = await buildLocalHttpsPanel({
            fetchFn: vi.fn(
                async () =>
                    new Response(JSON.stringify(state({ status: 'ready', kind: 'ip', subject: '192.168.86.3' }))),
            ),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        expect(elIp.querySelector<HTMLElement>('[data-tls-allowed-host-notice]')!.hidden).toBe(true);

        const payload = '<img src=x onerror=alert(1)>';
        const elHost = await buildLocalHttpsPanel({
            fetchFn: vi.fn(
                async () =>
                    new Response(JSON.stringify(state({ status: 'ready', kind: 'hostname', subject: payload }))),
            ),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        const notice = elHost.querySelector<HTMLElement>('[data-tls-allowed-host-notice]')!;
        expect(notice.hidden).toBe(false);
        expect(notice.textContent).toContain(payload);
        expect(notice.textContent).toMatch(/registered in allowedHosts/i);
        expect(notice.querySelector('img')).toBeNull();
    });

    it('uses textContent for the subject — it is user input echoed back, not silently dropped', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(
                async () =>
                    new Response(JSON.stringify(state({ status: 'ready', subject: '<img src=x onerror=alert(1)>' }))),
            ),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        expect(el.querySelector('img')).toBeNull();
        // Proves the subject was actually RENDERED (as inert text), ruling
        // out the trivial pass where it is simply never displayed at all.
        const subjectEl = el.querySelector<HTMLElement>('[data-tls-current-subject]')!;
        expect(subjectEl.textContent).toBe('<img src=x onerror=alert(1)>');
    });

    it('always shows the allowedHosts note (notification 2), for both ip and hostname subjects', async () => {
        const elIp = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        const elHost = await buildLocalHttpsPanel({
            fetchFn: vi.fn(
                async () =>
                    new Response(JSON.stringify(state({ status: 'ready', kind: 'hostname', subject: 'devices.lan' }))),
            ),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        expect(elIp.textContent).toMatch(/allowedHosts takes domain names only/i);
        expect(elHost.textContent).toMatch(/allowedHosts takes domain names only/i);
    });

    it('warns inside 30 days of expiry (notification 9), silent well outside it', async () => {
        const soon = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
        const elSoon = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state({ status: 'ready', notAfter: soon })))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        const noticeSoon = elSoon.querySelector<HTMLElement>('[data-tls-expiry-notice]')!;
        expect(noticeSoon.hidden).toBe(false);
        expect(noticeSoon.textContent).toMatch(/expires on/i);

        const far = new Date(Date.now() + 300 * 24 * 60 * 60 * 1000).toISOString();
        const elFar = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state({ status: 'ready', notAfter: far })))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        expect(elFar.querySelector<HTMLElement>('[data-tls-expiry-notice]')!.hidden).toBe(true);
    });

    it('uses past tense for an already-expired certificate (M1)', async () => {
        const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state({ status: 'ready', notAfter: past })))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        const notice = el.querySelector<HTMLElement>('[data-tls-expiry-notice]')!;
        expect(notice.hidden).toBe(false);
        expect(notice.textContent).toMatch(/expired on/i);
        expect(notice.textContent).not.toMatch(/regenerate before then/i);
    });

    it('fires the address-mismatch notice only for an RFC1918 subject the candidate list can rule out (I4)', async () => {
        // RFC1918 and genuinely absent from the candidate list -- fires.
        const elRfc1918 = await buildLocalHttpsPanel({
            fetchFn: vi.fn(
                async () => new Response(JSON.stringify(state({ status: 'ready', kind: 'ip', subject: '10.0.0.9' }))),
            ),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        expect(elRfc1918.querySelector<HTMLElement>('[data-tls-mismatch-notice]')!.hidden).toBe(false);

        // Loopback -- also absent from the (RFC1918-only) candidate list, but
        // the oracle cannot positively rule it out, so it must say nothing.
        const elLoopback = await buildLocalHttpsPanel({
            fetchFn: vi.fn(
                async () => new Response(JSON.stringify(state({ status: 'ready', kind: 'ip', subject: '127.0.0.1' }))),
            ),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        expect(elLoopback.querySelector<HTMLElement>('[data-tls-mismatch-notice]')!.hidden).toBe(true);

        // A Tailscale/CGNAT-shaped address (100.64.0.0/10) -- same reasoning.
        const elCgnat = await buildLocalHttpsPanel({
            fetchFn: vi.fn(
                async () => new Response(JSON.stringify(state({ status: 'ready', kind: 'ip', subject: '100.64.0.5' }))),
            ),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        expect(elCgnat.querySelector<HTMLElement>('[data-tls-mismatch-notice]')!.hidden).toBe(true);
    });

    it('pre-selects the exposure radio matching the current server mode (I5)', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(
                async () => new Response(JSON.stringify(state({ status: 'ready', httpExposure: 'httpsOnly' }))),
            ),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        expect(el.querySelector<HTMLInputElement>('[data-exposure="httpsOnly"]')!.checked).toBe(true);
        expect(el.querySelector<HTMLInputElement>('[data-exposure="open"]')!.checked).toBe(false);
    });

    it('defaults the exposure radio to open when the server has not reported a mode yet', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        expect(el.querySelector<HTMLInputElement>('[data-exposure="open"]')!.checked).toBe(true);
    });

    it('does not guess a platform: an unknown platform shows no sub-1024 warning (M2)', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3'],
            platform: undefined,
        });
        const port = el.querySelector<HTMLInputElement>('[data-tls-port]')!;
        port.value = '443';
        port.dispatchEvent(new Event('input'));
        expect(el.querySelector<HTMLElement>('[data-tls-port-notice]')!.hidden).toBe(true);
    });
});

describe('pure notification/instruction helpers', () => {
    it('trustInstructionsFor gives distinct, per-platform guidance and a generic fallback', () => {
        const win = trustInstructionsFor('win32');
        const mac = trustInstructionsFor('darwin');
        const lin = trustInstructionsFor('linux');
        const other = trustInstructionsFor(undefined);
        expect(win).toMatch(/install certificate/i);
        expect(mac).toMatch(/keychain access/i);
        expect(lin).toMatch(/update-ca-certificates/i);
        expect(other).not.toBe(win);
        expect(other).not.toBe(mac);
        expect(other).not.toBe(lin);
    });

    it('subPrivilegedPortNotice fires only on linux/darwin for a sub-1024 port', () => {
        expect(subPrivilegedPortNotice(443, 'linux')).toMatch(/elevated privileges/i);
        expect(subPrivilegedPortNotice(443, 'darwin')).toMatch(/elevated privileges/i);
        expect(subPrivilegedPortNotice(443, 'win32')).toBeNull();
        expect(subPrivilegedPortNotice(443, undefined)).toBeNull();
        expect(subPrivilegedPortNotice(8443, 'linux')).toBeNull();
    });

    it('certSubjectMismatchNotice only judges an RFC1918 subject (I4)', () => {
        expect(
            certSubjectMismatchNotice({ status: 'ready', kind: 'ip', subject: '10.0.0.9' }, ['192.168.86.3']),
        ).toMatch(/no longer an address/i);
        expect(
            certSubjectMismatchNotice({ status: 'ready', kind: 'ip', subject: '127.0.0.1' }, ['192.168.86.3']),
        ).toBeNull();
        expect(
            certSubjectMismatchNotice({ status: 'ready', kind: 'ip', subject: '10.0.0.9' }, ['10.0.0.9']),
        ).toBeNull();
    });

    it('certExpiryNotice switches tense at the expiry boundary (M1)', () => {
        const now = new Date('2026-09-19T00:00:00.000Z');
        const soon = new Date('2026-09-25T00:00:00.000Z').toISOString();
        const past = new Date('2026-09-01T00:00:00.000Z').toISOString();
        const far = new Date('2027-09-01T00:00:00.000Z').toISOString();
        expect(certExpiryNotice({ status: 'ready', notAfter: soon }, now)).toMatch(/expires on/i);
        expect(certExpiryNotice({ status: 'ready', notAfter: past }, now)).toMatch(/expired on/i);
        expect(certExpiryNotice({ status: 'ready', notAfter: far }, now)).toBeNull();
    });
});

describe('local https panel — transient alert convention', () => {
    // This repo's rule: transient outcomes get ONE bottom-of-panel alert
    // (5s success / 10s error), never a status line scattered next to
    // whichever control caused it. Each test below pins both that the alert
    // fires with the right text AND that it stops existing at the wrong
    // moment — a version with no timer (always visible) or an immediate hide
    // (never visible) each fail one of the two assertions.

    it('uses a single shared alert element, not one per control', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        expect(el.querySelectorAll('[data-tls-alert]')).toHaveLength(1);
    });

    it('shows a success alert after generate, and auto-hides at 5s but not a moment before', async () => {
        vi.useFakeTimers();
        try {
            const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
                if (url === '/api/tls/generate') {
                    return new Response(JSON.stringify({ status: 'ready', kind: 'ip', subject: '192.168.86.3' }));
                }
                return new Response(JSON.stringify(state()));
            });
            const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'], platform: 'win32' });
            el.querySelector<HTMLButtonElement>('[data-tls-generate]')!.click();
            await vi.advanceTimersByTimeAsync(0);

            const alert = el.querySelector<HTMLElement>('[data-tls-alert]')!;
            expect(alert.hidden).toBe(false);
            expect(alert.textContent).toMatch(/certificate generated/i);

            await vi.advanceTimersByTimeAsync(4_999);
            expect(alert.hidden).toBe(false);
            await vi.advanceTimersByTimeAsync(2);
            expect(alert.hidden).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('names the allowedHosts edit in the same alert, echoing the subject via textContent (I11)', async () => {
        // A real markup-shaped payload, not `devices.lan` -- a plain hostname
        // contains no markup, so a version that swapped this composition's
        // `textContent` for `innerHTML` would pass against it just as well.
        // Only a payload with actual markup can tell the two apart.
        const payload = '<img src=x onerror=alert(1)>';
        const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
            if (url === '/api/tls/generate') {
                return new Response(
                    JSON.stringify({
                        status: 'ready',
                        kind: 'hostname',
                        subject: payload,
                        allowedHostAdded: true,
                    }),
                );
            }
            return new Response(JSON.stringify(state()));
        });
        const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'], platform: 'win32' });
        el.querySelector<HTMLButtonElement>('[data-tls-generate]')!.click();
        await new Promise((r) => setTimeout(r, 0));
        const alert = el.querySelector<HTMLElement>('[data-tls-alert]')!;
        // Paired: the payload was actually rendered as text (ruling out the
        // trivial pass where it is dropped entirely)...
        expect(alert.textContent).toContain(payload);
        expect(alert.textContent).toMatch(/added .* to allowedhosts/i);
        // ...AND it never became markup.
        expect(alert.querySelector('img')).toBeNull();
    });

    it('shows the server-provided 429 body text on a rate-limited CA download, and holds it for 10s not 5s', async () => {
        vi.useFakeTimers();
        try {
            const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
                if (url === '/api/tls/ca-root') {
                    return new Response(
                        JSON.stringify({ error: 'too many CA downloads; wait a moment and try again' }),
                        { status: 429 },
                    );
                }
                return new Response(JSON.stringify(state({ status: 'ready', kind: 'ip', subject: '192.168.86.3' })));
            });
            const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'], platform: 'win32' });
            el.querySelector<HTMLButtonElement>('[data-tls-download]')!.click();
            await vi.advanceTimersByTimeAsync(0);

            const alert = el.querySelector<HTMLElement>('[data-tls-alert]')!;
            expect(alert.textContent).toMatch(/too many ca downloads/i);

            // Errors get the LONGER window (10s), not the success window (5s) --
            // this is the assertion that would catch a copy-paste of the wrong
            // constant into the error branch.
            await vi.advanceTimersByTimeAsync(5_000);
            expect(alert.hidden).toBe(false);
            await vi.advanceTimersByTimeAsync(4_999);
            expect(alert.hidden).toBe(false);
            await vi.advanceTimersByTimeAsync(2);
            expect(alert.hidden).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('tells the user plain-http exposure saving is not supported yet, when the route 404s', async () => {
        const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
            if (url === '/api/tls/exposure') {
                return new Response(JSON.stringify({ error: 'no such tls route' }), { status: 404 });
            }
            return new Response(JSON.stringify(state({ status: 'ready' })));
        });
        const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'], platform: 'win32' });
        el.querySelector<HTMLButtonElement>('[data-exposure-ok]')!.click();
        await new Promise((r) => setTimeout(r, 0));
        // Scoped to the alert element and its visibility, not whole-panel
        // textContent -- mechanical rule: if the thing under test can be
        // hidden, assert `hidden`, not text.
        const alert = el.querySelector<HTMLElement>('[data-tls-alert]')!;
        expect(alert.hidden).toBe(false);
        expect(alert.textContent).toMatch(/does not support saving this setting yet/i);
    });

    it('tells the user changing the https port restarts the server -- distinct from exposure, which does not', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        // Standing condition, visible at rest (no click needed), and asserted
        // on the SPECIFIC element rather than whole-panel textContent --
        // several other strings in this panel also contain "restart" (the
        // exposure notices), so a whole-panel match alone would pass even if
        // this particular notice never rendered.
        const note = el.querySelector<HTMLElement>('[data-tls-port-restart-note]')!;
        expect(note.hidden).toBe(false);
        expect(note.textContent).toMatch(/restart/i);
    });

    it('rejects an out-of-range https port locally, without calling the network', async () => {
        const fetchFn = vi.fn(async () => new Response(JSON.stringify(state())));
        const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'], platform: 'win32' });
        const port = el.querySelector<HTMLInputElement>('[data-tls-port]')!;
        port.value = '99999';
        el.querySelector<HTMLButtonElement>('[data-tls-port-ok]')!.click();
        await new Promise((r) => setTimeout(r, 0));
        const alert = el.querySelector<HTMLElement>('[data-tls-alert]')!;
        expect(alert.textContent).toMatch(/port must be/i);
        expect(fetchFn).not.toHaveBeenCalledWith('/api/tls/https-port', expect.anything());
    });

    it('saves a valid https port and confirms the restart in the same alert', async () => {
        const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
            if (url === '/api/tls/https-port') {
                return new Response(JSON.stringify({ ok: true, port: 9443, restartRequired: true }));
            }
            return new Response(JSON.stringify(state()));
        });
        const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'], platform: 'win32' });
        const port = el.querySelector<HTMLInputElement>('[data-tls-port]')!;
        port.value = '9443';
        el.querySelector<HTMLButtonElement>('[data-tls-port-ok]')!.click();
        await new Promise((r) => setTimeout(r, 0));
        expect(fetchFn).toHaveBeenCalledWith(
            '/api/tls/https-port',
            expect.objectContaining({ method: 'POST', body: JSON.stringify({ port: 9443 }) }),
        );
        const alert = el.querySelector<HTMLElement>('[data-tls-alert]')!;
        expect(alert.textContent).toMatch(/restart/i);
    });

    it('shows the server-provided error text on a rejected port, rather than a generic message', async () => {
        const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
            if (url === '/api/tls/https-port') {
                return new Response(JSON.stringify({ error: 'port must be an integer between 1 and 65535' }), {
                    status: 400,
                });
            }
            return new Response(JSON.stringify(state()));
        });
        const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'], platform: 'win32' });
        const port = el.querySelector<HTMLInputElement>('[data-tls-port]')!;
        port.value = '9443';
        el.querySelector<HTMLButtonElement>('[data-tls-port-ok]')!.click();
        await new Promise((r) => setTimeout(r, 0));
        const alert = el.querySelector<HTMLElement>('[data-tls-alert]')!;
        expect(alert.textContent).toMatch(/port must be an integer between 1 and 65535/i);
    });

    it('reports a network failure distinctly, without claiming the port was saved', async () => {
        const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
            if (url === '/api/tls/https-port') throw new Error('network down');
            return new Response(JSON.stringify(state()));
        });
        const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'], platform: 'win32' });
        const port = el.querySelector<HTMLInputElement>('[data-tls-port]')!;
        port.value = '9443';
        el.querySelector<HTMLButtonElement>('[data-tls-port-ok]')!.click();
        await new Promise((r) => setTimeout(r, 0));
        const alert = el.querySelector<HTMLElement>('[data-tls-alert]')!;
        expect(alert.textContent).toMatch(/could not reach the server/i);
        expect(alert.textContent).not.toMatch(/restart/i);
    });

    it('keeps a persistent condition (notification 4) visible after the transient alert times out and hides (I10)', async () => {
        // The original version of this test built the panel, advanced fake
        // timers by 15s, and re-checked textContent -- but nothing ever
        // showed a transient alert, so no timer was ever armed, and
        // textContent still matches a HIDDEN element in jsdom. Neither half
        // of that was actually exercising persistence. This version drives a
        // real transient alert through its own window and asserts `.hidden`
        // on both elements, so it fails if the persistent notice were ever
        // wired through the SAME timer as the transient one.
        vi.useFakeTimers();
        try {
            const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
                if (url === '/api/tls/ca-root') {
                    return new Response(JSON.stringify({ error: 'no certificate has been generated yet' }), {
                        status: 404,
                    });
                }
                return new Response(JSON.stringify(state({ status: 'ready', kind: 'ip', subject: '10.0.0.9' })));
            });
            const el = await buildLocalHttpsPanel({
                fetchFn,
                // Deliberately excludes 10.0.0.9, so the mismatch notice (4) fires.
                candidateIps: ['192.168.86.3'],
                platform: 'win32',
            });
            const mismatch = el.querySelector<HTMLElement>('[data-tls-mismatch-notice]')!;
            const alert = el.querySelector<HTMLElement>('[data-tls-alert]')!;

            expect(mismatch.hidden).toBe(false);
            expect(alert.hidden).toBe(true); // nothing transient has happened yet

            el.querySelector<HTMLButtonElement>('[data-tls-download]')!.click();
            await vi.advanceTimersByTimeAsync(0);
            expect(alert.hidden).toBe(false);

            // Past the transient alert's own 10s (error) window: IT hides...
            await vi.advanceTimersByTimeAsync(10_001);
            expect(alert.hidden).toBe(true);
            // ...but the persistent condition is untouched by that timer.
            expect(mismatch.hidden).toBe(false);
            expect(mismatch.textContent).toMatch(/no longer an address of this machine/i);
        } finally {
            vi.useRealTimers();
        }
    });

    it('supersedes a pending timer when a new alert fires before the old one hides (M6)', async () => {
        // Without the `clearTimeout` in `showTransientAlert`, the FIRST
        // alert's timer would still fire on schedule and hide whatever is
        // currently showing -- even if a second, still-active alert (with
        // its own, later deadline) has since replaced it. This drives that
        // exact sequence: a 5s success alert, superseded almost immediately
        // by a 10s error alert, and checks the panel is still showing the
        // SECOND alert at the moment the FIRST alert's stale timer would
        // have fired.
        vi.useFakeTimers();
        try {
            const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
                if (url === '/api/tls/generate') {
                    return new Response(JSON.stringify({ status: 'ready', kind: 'ip', subject: '192.168.86.3' }));
                }
                if (url === '/api/tls/ca-root') {
                    return new Response(
                        JSON.stringify({ error: 'too many CA downloads; wait a moment and try again' }),
                        { status: 429 },
                    );
                }
                return new Response(JSON.stringify(state()));
            });
            const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'], platform: 'win32' });
            const alert = el.querySelector<HTMLElement>('[data-tls-alert]')!;

            // t=0: success alert, 5s window (would expire at t=5000 if
            // nothing superseded it).
            el.querySelector<HTMLButtonElement>('[data-tls-generate]')!.click();
            await vi.advanceTimersByTimeAsync(0);
            expect(alert.textContent).toMatch(/certificate generated/i);

            // t=1000: a SECOND alert fires -- the longer-lived error window
            // (10s from here, i.e. expiring at t=11000) -- well before the
            // first alert's own deadline.
            await vi.advanceTimersByTimeAsync(1_000);
            el.querySelector<HTMLButtonElement>('[data-tls-download]')!.click();
            await vi.advanceTimersByTimeAsync(0);
            expect(alert.textContent).toMatch(/too many ca downloads/i);

            // t=5001: past where the FIRST (now-stale) 5s timer would have
            // fired. Without supersession, THIS is where the alert would go
            // hidden despite the second alert still being well within its
            // own window.
            await vi.advanceTimersByTimeAsync(4_001);
            expect(alert.hidden).toBe(false);
            expect(alert.textContent).toMatch(/too many ca downloads/i);

            // t=11001: past the SECOND alert's own 10s deadline (measured
            // from ITS start at t=1000) -- now it hides.
            await vi.advanceTimersByTimeAsync(6_000);
            expect(alert.hidden).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('local https panel — final review fixes (C1, I1, I2, I5, I7, I11)', () => {
    beforeEach(() => {
        // ConfirmModal (I1's revoke confirmation) uses <dialog>.showModal/close,
        // which jsdom doesn't implement -- same stub this repo's own
        // ConfirmModal.test.ts uses.
        HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
            this.setAttribute('open', '');
        });
        HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
            this.removeAttribute('open');
        });
    });
    afterEach(() => {
        document.body.replaceChildren();
        vi.restoreAllMocks();
    });

    function modalButton(label: string): HTMLButtonElement {
        const btn = (Array.from(document.querySelectorAll('button')) as HTMLButtonElement[]).find(
            (b) => b.textContent?.trim().toLowerCase() === label.toLowerCase(),
        );
        expect(btn, `button "${label}"`).toBeTruthy();
        return btn!;
    }

    // ---- I1: revoke ----

    it('revoke is disabled with no certificate, enabled once one exists (I1)', async () => {
        const elNone = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        expect(elNone.querySelector<HTMLButtonElement>('[data-tls-revoke]')!.disabled).toBe(true);

        const elReady = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state({ status: 'ready' })))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        expect(elReady.querySelector<HTMLButtonElement>('[data-tls-revoke]')!.disabled).toBe(false);
    });

    // Split into two tests rather than one cancel-then-confirm sequence:
    // `Modal.close()` removes its <dialog> from the DOM on a REAL 250ms
    // fallback timer (jsdom fires no `transitionend`), so a second modal
    // opened moments later shares the document with the first one's
    // now-inert leftover buttons -- `modalButton()`'s global
    // `querySelectorAll` would find whichever came first. One modal per
    // test sidesteps that rather than waiting out a real 250ms per case.

    it('cancelling the revoke confirmation makes no network call and leaves the certificate alone (I1)', async () => {
        const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
            if (url === '/api/tls/revoke') return new Response(JSON.stringify({ ok: true }));
            return new Response(JSON.stringify(state({ status: 'ready', kind: 'ip', subject: '192.168.86.3' })));
        });
        const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'], platform: 'win32' });
        el.querySelector<HTMLButtonElement>('[data-tls-revoke]')!.click();
        await new Promise((r) => setTimeout(r, 0));
        modalButton('cancel').click();
        await new Promise((r) => setTimeout(r, 0));
        expect(fetchFn).not.toHaveBeenCalledWith('/api/tls/revoke', expect.anything());
        expect(el.querySelector('[data-tls-current-subject]')).not.toBeNull();
    });

    it('confirming revoke calls POST /api/tls/revoke and clears the certificate (I1)', async () => {
        const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
            if (url === '/api/tls/revoke') return new Response(JSON.stringify({ ok: true }));
            return new Response(JSON.stringify(state({ status: 'ready', kind: 'ip', subject: '192.168.86.3' })));
        });
        const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'], platform: 'win32' });
        const revokeBtn = el.querySelector<HTMLButtonElement>('[data-tls-revoke]')!;
        revokeBtn.click();
        await new Promise((r) => setTimeout(r, 0));
        modalButton('ok').click();
        await new Promise((r) => setTimeout(r, 0));
        expect(fetchFn).toHaveBeenCalledWith('/api/tls/revoke', expect.objectContaining({ method: 'POST' }));
        expect(el.querySelector('[data-tls-current-subject]')).toBeNull();
        expect(revokeBtn.disabled).toBe(true);
    });

    // ---- I2: https port prefill ----

    it('prefills the https port from the server, not a hardcoded 8443 (I2)', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state({ status: 'ready', httpsPort: 9443 })))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        expect(el.querySelector<HTMLInputElement>('[data-tls-port]')!.value).toBe('9443');
    });

    it('falls back to 8443 only when the server has not reported a port (I2)', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        expect(el.querySelector<HTMLInputElement>('[data-tls-port]')!.value).toBe('8443');
    });

    // ---- I5: every device, not just the server's OS ----

    it('trustInstructionsFor covers android and ios distinctly (I5)', () => {
        const android = trustInstructionsFor('android');
        const ios = trustInstructionsFor('ios');
        expect(android).toMatch(/install a certificate/i);
        expect(ios).toMatch(/certificate trust settings/i);
        expect(android).not.toBe(ios);
    });

    it('firefoxTrustNote names its own private trust store', () => {
        expect(firefoxTrustNote()).toMatch(/firefox keeps its own certificate store/i);
    });

    it('the accordion shows every device platform plus a firefox note, regardless of the SERVER platform (I5)', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3'],
            platform: 'linux', // the server's OS -- must not gate which entries render
        });
        expect(el.textContent).toMatch(/windows/i);
        expect(el.textContent).toMatch(/macos/i);
        expect(el.textContent).toMatch(/\blinux\b/i);
        expect(el.textContent).toMatch(/android/i);
        expect(el.textContent).toMatch(/ios/i);
        expect(el.textContent).toMatch(/firefox keeps its own certificate store/i);
    });

    // ---- I7: every candidate IP, not an arbitrary one ----

    it('lists every candidate ip in a picker, not just one (I7)', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3', '10.0.0.5', '172.16.4.9'],
            platform: 'win32',
        });
        const select = el.querySelector<HTMLSelectElement>('[data-tls-candidate-select]')!;
        const optionValues = Array.from(select.options).map((o) => o.value);
        expect(optionValues).toEqual(['192.168.86.3', '10.0.0.5', '172.16.4.9']);
        expect(select.hidden).toBe(false); // ip mode is the default
    });

    it('selecting a candidate fills the subject field, and the picker hides in hostname mode (I7)', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3', '10.0.0.5'],
            platform: 'win32',
        });
        const select = el.querySelector<HTMLSelectElement>('[data-tls-candidate-select]')!;
        const subjectInput = el.querySelector<HTMLInputElement>('[data-tls-subject]')!;

        select.value = '10.0.0.5';
        select.dispatchEvent(new Event('change'));
        expect(subjectInput.value).toBe('10.0.0.5');

        el.querySelector<HTMLInputElement>('input[name="tls-subject-kind"][value="hostname"]')!.click();
        expect(select.hidden).toBe(true);

        el.querySelector<HTMLInputElement>('input[name="tls-subject-kind"][value="ip"]')!.click();
        expect(select.hidden).toBe(false);
    });

    // ---- I11: narrowed exposure needs a certificate to mean anything ----

    it('disables the narrowed exposure modes with no certificate, and enables them once one exists (I11)', async () => {
        const elNone = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        expect(elNone.querySelector<HTMLInputElement>('[data-exposure="httpsOnly"]')!.disabled).toBe(true);
        expect(elNone.querySelector<HTMLInputElement>('[data-exposure="redirect"]')!.disabled).toBe(true);
        expect(elNone.querySelector<HTMLInputElement>('[data-exposure="open"]')!.disabled).toBe(false);
        const notice = elNone.querySelector<HTMLElement>('[data-exposure-unavailable-notice]')!;
        expect(notice.hidden).toBe(false);
        expect(notice.textContent).toMatch(/generate a certificate first/i);

        const elReady = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state({ status: 'ready' })))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        expect(elReady.querySelector<HTMLInputElement>('[data-exposure="httpsOnly"]')!.disabled).toBe(false);
        expect(elReady.querySelector<HTMLElement>('[data-exposure-unavailable-notice]')!.hidden).toBe(true);
    });

    it('a successful generate re-enables the narrowed exposure modes (I11)', async () => {
        const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
            if (url === '/api/tls/generate') {
                return new Response(JSON.stringify({ status: 'ready', kind: 'ip', subject: '192.168.86.3' }));
            }
            return new Response(JSON.stringify(state()));
        });
        const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'], platform: 'win32' });
        const httpsOnlyRadio = el.querySelector<HTMLInputElement>('[data-exposure="httpsOnly"]')!;
        expect(httpsOnlyRadio.disabled).toBe(true);

        el.querySelector<HTMLButtonElement>('[data-tls-generate]')!.click();
        await new Promise((r) => setTimeout(r, 0));
        expect(httpsOnlyRadio.disabled).toBe(false);
    });

    // ---- C1: listener truth, not certificate existence ----

    it('says nothing about the listener when the server has not reported it, and the CA-trust claim still holds (C1)', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state({ status: 'ready' })))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        expect(el.querySelector<HTMLElement>('[data-tls-listener-notice]')!.hidden).toBe(true);
        expect(el.querySelector<HTMLElement>('[data-tls-ca-trust-notice]')!.hidden).toBe(false);
    });

    it('says nothing about the listener once it is confirmed up (C1)', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(
                async () =>
                    new Response(
                        JSON.stringify(state({ status: 'ready', httpsListener: { bound: true, port: 8443 } })),
                    ),
            ),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        expect(el.querySelector<HTMLElement>('[data-tls-listener-notice]')!.hidden).toBe(true);
        expect(el.querySelector<HTMLElement>('[data-tls-ca-trust-notice]')!.hidden).toBe(false);
    });

    it('reports each listener-down case distinctly, and never claims streaming already works (C1)', async () => {
        const cases: Array<[string, RegExp]> = [
            ['restart-required', /restart the server to begin serving https/i],
            ['config-override', /advanced server configuration/i],
            ['port-collision', /same as the plain http port/i],
            ['bind-failed', /failed to start/i],
        ];
        for (const [reason, expectedText] of cases) {
            const el = await buildLocalHttpsPanel({
                fetchFn: vi.fn(
                    async () =>
                        new Response(
                            JSON.stringify(
                                state({
                                    status: 'ready',
                                    kind: 'ip',
                                    subject: '192.168.86.3',
                                    httpsListener: { bound: false, reason },
                                }),
                            ),
                        ),
                ),
                candidateIps: ['192.168.86.3'],
                platform: 'win32',
            });
            const listenerNotice = el.querySelector<HTMLElement>('[data-tls-listener-notice]')!;
            expect(listenerNotice.hidden, reason).toBe(false);
            expect(listenerNotice.textContent, reason).toMatch(expectedText);
            // The exact false claim this finding is about must never appear
            // once the listener is confirmed down, regardless of reason.
            expect(el.querySelector<HTMLElement>('[data-tls-ca-trust-notice]')!.hidden, reason).toBe(true);
            expect(el.textContent, reason).not.toMatch(/streaming already works/i);
        }
    });

    it('mentions the restart in the SAME transient alert right after a generate that needs one (C1)', async () => {
        const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
            if (url === '/api/tls/generate') {
                return new Response(
                    JSON.stringify({
                        status: 'ready',
                        kind: 'ip',
                        subject: '192.168.86.3',
                        httpsListener: { bound: false, reason: 'restart-required' },
                    }),
                );
            }
            return new Response(JSON.stringify(state()));
        });
        const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'], platform: 'win32' });
        el.querySelector<HTMLButtonElement>('[data-tls-generate]')!.click();
        await new Promise((r) => setTimeout(r, 0));
        const alert = el.querySelector<HTMLElement>('[data-tls-alert]')!;
        expect(alert.textContent).toMatch(/certificate generated\. restart the server to start serving https/i);
    });

    it('listenerStatusNotice is null for a non-ready cert or a confirmed-bound listener', () => {
        expect(listenerStatusNotice({ status: 'none' })).toBeNull();
        expect(listenerStatusNotice({ status: 'ready', httpsListener: { bound: true, port: 8443 } })).toBeNull();
        expect(listenerStatusNotice({ status: 'ready' })).toBeNull(); // unknown -- say nothing
    });
});
