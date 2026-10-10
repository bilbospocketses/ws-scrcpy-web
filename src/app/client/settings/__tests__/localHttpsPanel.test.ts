// @vitest-environment jsdom
// src/app/client/settings/__tests__/localHttpsPanel.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    buildLocalHttpsPanel,
    certExpiryNotice,
    certSubjectMismatchNotice,
    fetchMkcertInstalled,
    listenerStatusNotice,
    MKCERT_MISSING_NOTICE,
    publicSuffixWarning,
    recheckLocalHttpsMkcert,
    SUBJECT_HELP_HREF,
    TLS_CERT_CHANGED_EVENT,
    TRUST_HELP_HREF,
} from '../tabs/LocalHttpsTab';

const state = (over = {}) => ({ status: 'none', ...over });

describe('local https panel', () => {
    it('offers the machine IP prefilled, so the common case is one click', async () => {
        const elA = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3'],
        });
        expect(elA.querySelector<HTMLInputElement>('[data-tls-subject]')!.value).toBe('192.168.86.3');

        // Contrast: a different candidate list produces a different prefill --
        // proves the value is READ from deps, not a hardcoded string that
        // happens to match the fixture above.
        const elB = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['10.0.0.5'],
        });
        expect(elB.querySelector<HTMLInputElement>('[data-tls-subject]')!.value).toBe('10.0.0.5');
    });

    // After 0.5.3 the https port, its ok button, its sub-1024 notice and its
    // restart note moved to the Server tab (serverTab.test.ts), where the port
    // is staged for the dialog Save. Nothing of it is left here, and nothing
    // here posts to the old route.
    it('carries no https port: no box, no ok button, no port notices', async () => {
        const fetchFn = vi.fn(async () => new Response(JSON.stringify(state({ status: 'ready', httpsPort: 9443 }))));
        const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'] });
        for (const hook of [
            '[data-tls-port]',
            '[data-tls-port-ok]',
            '[data-tls-port-notice]',
            '[data-tls-port-restart-note]',
        ]) {
            expect(el.querySelector(hook), hook).toBeNull();
        }
        const labels = [...el.querySelectorAll('.settings-label')].map((l) => l.textContent);
        expect(labels).not.toContain('https port');
        expect(el.textContent).not.toContain('changing this restarts the server');
        // The only "ok" left is the exposure one.
        const oks = [...el.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.textContent === 'ok');
        expect(oks).toHaveLength(1);
        expect(oks[0]!.hasAttribute('data-exposure-ok')).toBe(true);
    });

    it('promises no lockout when a narrowed mode is selected, and says nothing for open', async () => {
        const el = await buildLocalHttpsPanel({
            // A bound listener (N2) -- otherwise the narrowed radios are
            // disabled and clicking them is a no-op, which isn't what this
            // test is about.
            fetchFn: vi.fn(
                async () => new Response(JSON.stringify(state({ status: 'ready', httpsListener: { bound: true } }))),
            ),
            candidateIps: ['192.168.86.3'],
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

    // Each narrowed mode says what IT does to other machines: https only
    // refuses them (421), redirect answers them with a 302 to https
    // (decideHttpRequest). Before 0.5.7 both showed the https-only sentence,
    // which told a redirect user plain http would stop answering.
    it('words the lockout notice for the mode selected: refused for https only, redirected for redirect', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(
                async () => new Response(JSON.stringify(state({ status: 'ready', httpsListener: { bound: true } }))),
            ),
            candidateIps: ['192.168.86.3'],
        });
        const lockout = el.querySelector<HTMLElement>('[data-exposure-lockout-notice]')!;
        const effectNotice = el.querySelector<HTMLElement>('[data-exposure-restart-notice]')!;

        el.querySelector<HTMLInputElement>('[data-exposure="httpsOnly"]')!.click();
        expect(lockout.textContent).toMatch(/plain http will stop answering other machines/i);
        expect(lockout.textContent).not.toMatch(/sent to the https address/i);

        el.querySelector<HTMLInputElement>('[data-exposure="redirect"]')!.click();
        expect(lockout.hidden).toBe(false);
        expect(lockout.textContent).toMatch(/sent to the https address instead/i);
        expect(lockout.textContent).not.toMatch(/stop answering/i);
        expect(lockout.textContent).toMatch(/cannot lock yourself out/i);
        expect(effectNotice.hidden).toBe(false);
        expect(effectNotice.textContent).toMatch(/takes effect immediately for new connections/i);

        // And back: switching from redirect to https only replaces the text.
        el.querySelector<HTMLInputElement>('[data-exposure="httpsOnly"]')!.click();
        expect(lockout.textContent).toMatch(/plain http will stop answering other machines/i);
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
        });
        expect(elNone.querySelector<HTMLElement>('[data-tls-ca-trust-notice]')!.hidden).toBe(true);

        const elReady = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state({ status: 'ready' })))),
            candidateIps: ['192.168.86.3'],
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
        });
        expect(elIp.querySelector<HTMLElement>('[data-tls-hostname-notice]')!.hidden).toBe(true);

        const elHost = await buildLocalHttpsPanel({
            fetchFn: vi.fn(
                async () =>
                    new Response(JSON.stringify(state({ status: 'ready', kind: 'hostname', subject: 'devices.lan' }))),
            ),
            candidateIps: ['192.168.86.3'],
        });
        const notice = elHost.querySelector<HTMLElement>('[data-tls-hostname-notice]')!;
        expect(notice.hidden).toBe(false);
        expect(notice.textContent).toMatch(/must resolve on every machine/i);
    });

    it('shows a persistent accepted-name note for the current hostname cert, not just at generate time (I9)', async () => {
        // Unlike the transient "now also accepts connections addressed to X" alert (which fires
        // once, at generate time), this reflects the STANDING fact that a
        // hostname-kind cert's subject is registered -- true on every load,
        // not only right after a generate.
        const elIp = await buildLocalHttpsPanel({
            fetchFn: vi.fn(
                async () =>
                    new Response(JSON.stringify(state({ status: 'ready', kind: 'ip', subject: '192.168.86.3' }))),
            ),
            candidateIps: ['192.168.86.3'],
        });
        expect(elIp.querySelector<HTMLElement>('[data-tls-allowed-host-notice]')!.hidden).toBe(true);

        const payload = '<img src=x onerror=alert(1)>';
        const elHost = await buildLocalHttpsPanel({
            fetchFn: vi.fn(
                async () =>
                    new Response(JSON.stringify(state({ status: 'ready', kind: 'hostname', subject: payload }))),
            ),
            candidateIps: ['192.168.86.3'],
        });
        const notice = elHost.querySelector<HTMLElement>('[data-tls-allowed-host-notice]')!;
        expect(notice.hidden).toBe(false);
        expect(notice.textContent).toContain(payload);
        expect(notice.textContent).toBe(`this server accepts connections addressed to ${payload}.`);
        // It says what happens, not the name of a config.json key no control in
        // Settings is labelled with.
        expect(notice.textContent).not.toMatch(/allowedHosts/i);
        expect(notice.querySelector('img')).toBeNull();
    });

    it('uses textContent for the subject — it is user input echoed back, not silently dropped', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(
                async () =>
                    new Response(JSON.stringify(state({ status: 'ready', subject: '<img src=x onerror=alert(1)>' }))),
            ),
            candidateIps: ['192.168.86.3'],
        });
        expect(el.querySelector('img')).toBeNull();
        // Proves the subject was actually RENDERED (as inert text), ruling
        // out the trivial pass where it is simply never displayed at all.
        const subjectEl = el.querySelector<HTMLElement>('[data-tls-current-subject]')!;
        expect(subjectEl.textContent).toBe('<img src=x onerror=alert(1)>');
    });

    it('always shows the subject guide (notification 2), for both ip and hostname subjects', async () => {
        const elIp = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3'],
        });
        const elHost = await buildLocalHttpsPanel({
            fetchFn: vi.fn(
                async () =>
                    new Response(JSON.stringify(state({ status: 'ready', kind: 'hostname', subject: 'devices.lan' }))),
            ),
            candidateIps: ['192.168.86.3'],
        });
        // 0.5.3: one short line plus a link to the explainer page, replacing the
        // two-sentence "ip address: … hostname: …" summary. 0.5.5: the line
        // follows the chosen kind -- an address in ip mode, a name in hostname
        // mode -- and the link says "how this works ↗", with "(opens in a new
        // tab)" kept for a screen reader only.
        const expected: Array<[HTMLElement, string]> = [
            [elIp, 'must match the address you type on the other device to reach this server. how this works ↗'],
            [elHost, 'must match the name you type on the other device to reach this server. how this works ↗'],
        ];
        for (const [el, text] of expected) {
            const note = el.querySelector<HTMLElement>('[data-tls-subject-guide]');
            expect(note).not.toBeNull();
            expect(note!.hidden).toBe(false);
            expect(note!.textContent).toBe(text);
            expect(note!.textContent).not.toMatch(/dns resolves to this computer/);
            const links = note!.querySelectorAll<HTMLAnchorElement>('a');
            expect(links).toHaveLength(1);
            // The help page, carrying the app's theme (helpLink.ts; jsdom's
            // document has no data-theme, which reads as dark).
            expect(links[0]!.getAttribute('href')).toBe(`${SUBJECT_HELP_HREF}?theme=dark`);
            expect(SUBJECT_HELP_HREF).toBe('help/certificate-subject.html');
            expect(links[0]!.target).toBe('_blank');
            expect(links[0]!.rel).toBe('noopener noreferrer');
            expect(links[0]!.textContent).toBe('how this works ↗');
            expect(links[0]!.getAttribute('aria-label')).toBe('how this works (opens in a new tab)');
        }
        // The old note named `allowedHosts`, a config.json key no control here
        // is labelled with (0.5.1). It must not come back in another wording.
        expect(elIp.textContent).not.toMatch(/allowedHosts takes domain names only/i);
        expect(elIp.querySelector('[data-tls-subject-guide]')!.textContent).not.toMatch(/allowedHosts/i);
    });

    it('warns inside 30 days of expiry (notification 9), silent well outside it', async () => {
        const soon = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
        const elSoon = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state({ status: 'ready', notAfter: soon })))),
            candidateIps: ['192.168.86.3'],
        });
        const noticeSoon = elSoon.querySelector<HTMLElement>('[data-tls-expiry-notice]')!;
        expect(noticeSoon.hidden).toBe(false);
        expect(noticeSoon.textContent).toMatch(/expires on/i);

        const far = new Date(Date.now() + 300 * 24 * 60 * 60 * 1000).toISOString();
        const elFar = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state({ status: 'ready', notAfter: far })))),
            candidateIps: ['192.168.86.3'],
        });
        expect(elFar.querySelector<HTMLElement>('[data-tls-expiry-notice]')!.hidden).toBe(true);
    });

    it('uses past tense for an already-expired certificate (M1)', async () => {
        const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state({ status: 'ready', notAfter: past })))),
            candidateIps: ['192.168.86.3'],
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
        });
        expect(elRfc1918.querySelector<HTMLElement>('[data-tls-mismatch-notice]')!.hidden).toBe(false);

        // Loopback -- also absent from the (RFC1918-only) candidate list, but
        // the oracle cannot positively rule it out, so it must say nothing.
        const elLoopback = await buildLocalHttpsPanel({
            fetchFn: vi.fn(
                async () => new Response(JSON.stringify(state({ status: 'ready', kind: 'ip', subject: '127.0.0.1' }))),
            ),
            candidateIps: ['192.168.86.3'],
        });
        expect(elLoopback.querySelector<HTMLElement>('[data-tls-mismatch-notice]')!.hidden).toBe(true);

        // A Tailscale/CGNAT-shaped address (100.64.0.0/10) -- same reasoning.
        const elCgnat = await buildLocalHttpsPanel({
            fetchFn: vi.fn(
                async () => new Response(JSON.stringify(state({ status: 'ready', kind: 'ip', subject: '100.64.0.5' }))),
            ),
            candidateIps: ['192.168.86.3'],
        });
        expect(elCgnat.querySelector<HTMLElement>('[data-tls-mismatch-notice]')!.hidden).toBe(true);
    });

    it('pre-selects the exposure radio matching the current server mode (I5)', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(
                async () => new Response(JSON.stringify(state({ status: 'ready', httpExposure: 'httpsOnly' }))),
            ),
            candidateIps: ['192.168.86.3'],
        });
        expect(el.querySelector<HTMLInputElement>('[data-exposure="httpsOnly"]')!.checked).toBe(true);
        expect(el.querySelector<HTMLInputElement>('[data-exposure="open"]')!.checked).toBe(false);
    });

    it('defaults the exposure radio to open when the server has not reported a mode yet', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3'],
        });
        expect(el.querySelector<HTMLInputElement>('[data-exposure="open"]')!.checked).toBe(true);
    });

    // 0.5.5: the subject is ONE line -- the two radios, then one box beside
    // them -- where 0.5.3/0.5.4 had a second line with a select of this
    // computer's addresses and a small label over each field.
    it('puts the subject on one line: the radios, then one box with an accessible name of its own', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3', '10.0.0.5'],
        });
        const subjectRow = [...el.querySelectorAll<HTMLElement>('.settings-row')].find(
            (r) => r.querySelector('.settings-label')?.textContent === 'certificate subject',
        )!;
        const subject = el.querySelector<HTMLInputElement>('[data-tls-subject]')!;
        const radios = [...subjectRow.querySelectorAll<HTMLInputElement>('input[name="tls-subject-kind"]')];
        expect(radios).toHaveLength(2);
        expect(subjectRow.contains(subject)).toBe(true);
        // After the radios.
        expect(radios[1]!.compareDocumentPosition(subject) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        // The second line, its select and its small labels are gone.
        expect(el.querySelector('[data-tls-subject-fields]')).toBeNull();
        expect(el.querySelector('select')).toBeNull();
        expect(el.querySelector('.settings-field, .settings-field-label')).toBeNull();
        expect(el.querySelectorAll('[data-tls-subject]')).toHaveLength(1);
        // It lost its visible label, so it is named for assistive tech.
        expect(subject.getAttribute('aria-label')).toBe('certificate subject');
        expect(subject.placeholder).toBe('ip address');
    });

    it('makes the box a combobox of this computer addresses in ip mode, and a plain box in hostname mode', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3', '10.0.0.5'],
        });
        const subject = el.querySelector<HTMLInputElement>('[data-tls-subject]')!;
        const button = el.querySelector<HTMLButtonElement>('[data-tls-candidate-button]')!;
        const list = el.querySelector<HTMLElement>('[data-tls-candidate-list]')!;
        expect(subject.getAttribute('role')).toBe('combobox');
        expect(subject.getAttribute('aria-controls')).toBe(list.id);
        expect(list.getAttribute('role')).toBe('listbox');
        expect(button.hidden).toBe(false);
        expect(button.getAttribute('aria-label')).toBe("this computer's addresses");

        const [ipRadio, hostRadio] = [...el.querySelectorAll<HTMLInputElement>('input[name="tls-subject-kind"]')];
        button.click();
        expect(list.hidden).toBe(false);
        // hostname: no list, no ▾, and the box asks for a name.
        hostRadio!.click();
        expect(button.hidden).toBe(true);
        expect(list.hidden).toBe(true);
        expect(subject.getAttribute('aria-expanded')).toBe('false');
        expect(subject.placeholder).toBe('hostname or domain name');
        // ArrowDown does not open a list hostname mode does not have.
        subject.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        expect(list.hidden).toBe(true);

        // And back.
        ipRadio!.click();
        expect(button.hidden).toBe(false);
        expect(subject.placeholder).toBe('ip address');
    });

    it('starts in hostname mode for a hostname certificate, and has no ▾ in ip mode with no candidates', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(
                async () =>
                    new Response(
                        JSON.stringify(
                            state({ status: 'ready', kind: 'hostname', subject: 'devices.lan', candidateIps: [] }),
                        ),
                    ),
            ),
            candidateIps: [],
        });
        const subject = el.querySelector<HTMLInputElement>('[data-tls-subject]')!;
        const button = el.querySelector<HTMLButtonElement>('[data-tls-candidate-button]')!;
        expect(subject.placeholder).toBe('hostname or domain name');
        expect(button.hidden).toBe(true);
        el.querySelector<HTMLInputElement>('input[name="tls-subject-kind"][value="ip"]')!.click();
        // ip address, but nothing to pick from: still no ▾.
        expect(button.hidden).toBe(true);
        expect(subject.placeholder).toBe('ip address');
    });

    it('keeps what each kind held across a flip and back, picks included', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3', '10.0.0.5'],
        });
        const subject = el.querySelector<HTMLInputElement>('[data-tls-subject]')!;
        const [ipRadio, hostRadio] = [...el.querySelectorAll<HTMLInputElement>('input[name="tls-subject-kind"]')];
        el.querySelector<HTMLButtonElement>('[data-tls-candidate-button]')!.click();
        const second = [...el.querySelectorAll<HTMLElement>('[data-tls-candidate-list] [role="option"]')][1]!;
        second.click();
        expect(subject.value).toBe('10.0.0.5');

        hostRadio!.click();
        expect(subject.value).toBe('');
        subject.value = 'nas';
        ipRadio!.click();
        expect(subject.value).toBe('10.0.0.5');
        hostRadio!.click();
        expect(subject.value).toBe('nas');
    });

    // 0.5.5: the two busy tabs are split into cards, each under its own heading.
    it('lays the panel out as three cards -- Certificate, Trust, Exposure -- under a hidden tab title', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state({ status: 'ready', subject: '10.0.0.5' })))),
            candidateIps: ['192.168.86.3'],
        });
        const title = el.querySelector<HTMLElement>(':scope > h3.settings-section-heading')!;
        expect(title.textContent).toBe('Local HTTPS');
        expect(title.classList.contains('visually-hidden')).toBe(true);
        const headings = [...el.querySelectorAll<HTMLElement>(':scope > h4.settings-card-heading')];
        expect(headings.map((h) => h.textContent)).toEqual(['Certificate', 'Trust', 'Exposure']);
        const cards = headings.map((h) => h.nextElementSibling as HTMLElement);
        for (const card of cards) expect(card.classList.contains('settings-card')).toBe(true);

        const labelsOf = (card: HTMLElement) =>
            [...card.querySelectorAll(':scope > .settings-item')].map(
                (item) => item.querySelector('.settings-label')?.textContent,
            );
        expect(labelsOf(cards[0]!)).toEqual(['certificate subject', 'certificate']);
        expect(labelsOf(cards[1]!)).toEqual(['root ca']);
        expect(labelsOf(cards[2]!)).toEqual(['plain http exposure']);

        // Every notice sits in the item of the control it is about.
        const itemOf = (hook: string) => el.querySelector(`[${hook}]`)!.closest('.settings-item');
        const [subjectItem, certificateItem] = [...cards[0]!.querySelectorAll(':scope > .settings-item')];
        expect(itemOf('data-tls-subject-guide')).toBe(subjectItem);
        expect(itemOf('data-tls-subject-suffix-warning')).toBe(subjectItem);
        for (const hook of [
            'data-tls-current-subject',
            'data-tls-listener-notice',
            'data-tls-ca-trust-notice',
            'data-tls-mismatch-notice',
            'data-tls-hostname-notice',
            'data-tls-allowed-host-notice',
            'data-tls-expiry-notice',
            'data-tls-ca-restore-notice',
        ]) {
            expect(itemOf(hook), hook).toBe(certificateItem);
        }
        expect(itemOf('data-tls-trust-help')).toBe(cards[1]!.firstElementChild);
        for (const hook of [
            'data-exposure-lockout-notice',
            'data-exposure-restart-notice',
            'data-exposure-unavailable-notice',
        ]) {
            expect(itemOf(hook), hook).toBe(cards[2]!.firstElementChild);
        }
    });

    it('labels the exposure radios one word or phrase each', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3'],
        });
        const labels = [...el.querySelectorAll<HTMLInputElement>('input[name="tls-exposure"]')].map(
            (r) => r.closest('label')?.textContent,
        );
        expect(labels).toEqual(['open', 'https only', 'redirect to https']);
    });

    // 0.5.5: "no certificate yet." said nothing the disabled revoke and download did not.
    it('shows no certificate line without a certificate, and the subject once there is one', async () => {
        const elNone = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3'],
        });
        expect(elNone.textContent).not.toContain('no certificate yet');
        const summaryNone = elNone.querySelector<HTMLElement>('[data-tls-current-subject]');
        expect(summaryNone).toBeNull();
        const certificateItem = elNone.querySelector('[data-tls-generate]')!.closest('.settings-item')!;
        const lines = [...certificateItem.querySelectorAll<HTMLElement>(':scope > p.settings-status')];
        expect(lines.filter((p) => !p.hidden)).toEqual([]);

        const elReady = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state({ status: 'ready', subject: '10.0.0.5' })))),
            candidateIps: ['192.168.86.3'],
        });
        const summary = elReady.querySelector<HTMLElement>('[data-tls-current-subject]')!.parentElement!;
        expect(summary.hidden).toBe(false);
        expect(summary.textContent).toBe('current certificate: 10.0.0.5');
    });
});

// 0.5.5: one-word names are allowed unless they are a real internet TLD (or a
// public suffix like co.uk) -- said while typing, with generate held back.
describe('local https panel: internet TLDs and public suffixes', () => {
    async function build(fetchFn: typeof fetch = vi.fn(async () => new Response(JSON.stringify(state())))) {
        const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'] });
        const subject = el.querySelector<HTMLInputElement>('[data-tls-subject]')!;
        const type = (value: string) => {
            subject.value = value;
            subject.dispatchEvent(new Event('input', { bubbles: true }));
        };
        return {
            el,
            subject,
            type,
            warning: el.querySelector<HTMLElement>('[data-tls-subject-suffix-warning]')!,
            generate: el.querySelector<HTMLButtonElement>('[data-tls-generate]')!,
            hostname: () =>
                el.querySelector<HTMLInputElement>('input[name="tls-subject-kind"][value="hostname"]')!.click(),
            ip: () => el.querySelector<HTMLInputElement>('input[name="tls-subject-kind"][value="ip"]')!.click(),
        };
    }

    it('warns about a public suffix in hostname mode, any case and spacing, and holds generate back until it changes', async () => {
        const p = await build();
        p.hostname();
        expect(p.warning.hidden).toBe(true);
        p.type('  COM ');
        expect(p.warning.hidden).toBe(false);
        expect(p.warning.textContent).toBe(
            '"COM" is an internet domain ending, not a computer\'s name, so it can\'t be used. use something like COM.lan, or the name your devices use to reach this computer.',
        );
        expect(p.warning.classList.contains('settings-status-warning')).toBe(true);
        expect(p.warning.style.gridColumn).toBe('1 / -1');
        expect(p.generate.disabled).toBe(true);

        p.type('co.uk');
        expect(p.warning.hidden).toBe(false);
        expect(p.generate.disabled).toBe(true);

        p.type('nas');
        expect(p.warning.hidden).toBe(true);
        expect(p.generate.disabled).toBe(false);
    });

    it.each(['de', 'media', 'dev', 'app', 'io', 'De', 'MEDIA', 'xn--p1ai', 'XN--P1AI', 'org.uk'])(
        'refuses the real TLD or suffix "%s", any case, and holds generate back',
        async (name) => {
            const p = await build();
            p.hostname();
            p.type(name);
            expect(p.warning.hidden).toBe(false);
            expect(p.warning.textContent).toBe(publicSuffixWarning(name));
            expect(p.generate.disabled).toBe(true);
        },
    );

    it.each(['htpc', 'nas', 'lan', 'local', 'home', 'localhost', 'media.lan', 'devices.lan'])(
        'lets the name "%s" through',
        async (name) => {
            const p = await build();
            p.hostname();
            p.type(name);
            expect(p.warning.hidden).toBe(true);
            expect(p.generate.disabled).toBe(false);
        },
    );

    it('never warns in ip mode, and a flip to ip lifts a hostname refusal', async () => {
        const p = await build();
        p.type('com');
        expect(p.warning.hidden).toBe(true);
        expect(p.generate.disabled).toBe(false);
        p.hostname();
        p.type('net');
        expect(p.generate.disabled).toBe(true);
        p.ip();
        expect(p.warning.hidden).toBe(true);
        expect(p.generate.disabled).toBe(false);
        // Flipping back restores the hostname value, and with it the refusal.
        p.hostname();
        expect(p.subject.value).toBe('net');
        expect(p.warning.hidden).toBe(false);
        expect(p.generate.disabled).toBe(true);
    });

    it('a click on the held-back generate sends nothing', async () => {
        const fetchFn = vi.fn(async () => new Response(JSON.stringify(state()))) as unknown as typeof fetch &
            ReturnType<typeof vi.fn>;
        const p = await build(fetchFn);
        p.hostname();
        p.type('org');
        // Bypass the disabled attribute: the handler's own guard is what is under test.
        p.generate.dispatchEvent(new MouseEvent('click'));
        await new Promise((r) => setTimeout(r, 0));
        expect(fetchFn.mock.calls.map((c) => c[0])).not.toContain('/api/tls/generate');
    });

    it('does not re-enable a generate that mkcert holds, when the name becomes usable', async () => {
        const fetchFn = vi.fn(async (url: string) =>
            url === '/api/dependencies'
                ? new Response(JSON.stringify([{ name: 'mkcert', installedVersion: null, status: 'not-installed' }]))
                : new Response(JSON.stringify(state())),
        ) as unknown as typeof fetch;
        const p = await build(fetchFn);
        expect(p.generate.disabled).toBe(true);
        // The radios are disabled with mkcert missing; drive the check through the box.
        p.el.querySelector<HTMLInputElement>('input[name="tls-subject-kind"][value="hostname"]')!.checked = true;
        p.type('com');
        expect(p.generate.disabled).toBe(true);
        p.type('nas');
        // The name is fine now, but mkcert still is not installed.
        expect(p.generate.disabled).toBe(true);
    });

    it('does not re-enable a generate in flight, when the name becomes usable meanwhile', async () => {
        let answer: (r: Response) => void = () => undefined;
        const fetchFn = vi.fn((url: string) =>
            url === '/api/tls/generate'
                ? new Promise<Response>((r) => {
                      answer = r;
                  })
                : Promise.resolve(new Response(JSON.stringify(state()))),
        ) as unknown as typeof fetch;
        const p = await build(fetchFn);
        p.hostname();
        p.type('nas');
        p.generate.click();
        await new Promise((r) => setTimeout(r, 0));
        expect(p.generate.disabled).toBe(true);
        // A refusal and then a usable name while the request is out: still held.
        p.type('com');
        p.type('htpc');
        expect(p.generate.disabled).toBe(true);

        answer(new Response(JSON.stringify({ status: 'ready', kind: 'hostname', subject: 'nas' })));
        await new Promise((r) => setTimeout(r, 0));
        expect(p.generate.disabled).toBe(false);
    });

    it('says "name" when a hostname generate is refused without a reason, and "address" for an ip one -- the copy the server sends', async () => {
        const refuse = vi.fn(async (url: RequestInfo | URL) =>
            url === '/api/tls/generate'
                ? new Response('not json', { status: 400 })
                : new Response(JSON.stringify(state())),
        ) as unknown as typeof fetch;
        const host = await build(refuse);
        host.hostname();
        host.type('nas');
        host.generate.click();
        await new Promise((r) => setTimeout(r, 0));
        expect(host.el.querySelector('[data-tls-alert]')!.textContent).toBe(
            'that name could not be used for a certificate.',
        );

        const ip = await build(refuse);
        ip.generate.click();
        await new Promise((r) => setTimeout(r, 0));
        expect(ip.el.querySelector('[data-tls-alert]')!.textContent).toBe(
            'that address could not be used for a certificate.',
        );
    });

    it('shows the server reason for a refused generate as given (it already names a name or an address)', async () => {
        const fetchFn = vi.fn(async (url: RequestInfo | URL) =>
            url === '/api/tls/generate'
                ? new Response(JSON.stringify({ error: 'that name could not be used for a certificate.' }), {
                      status: 400,
                  })
                : new Response(JSON.stringify(state())),
        ) as unknown as typeof fetch;
        const p = await build(fetchFn);
        p.hostname();
        p.type('nas');
        p.generate.click();
        await new Promise((r) => setTimeout(r, 0));
        expect(p.el.querySelector('[data-tls-alert]')!.textContent).toBe(
            'that name could not be used for a certificate.',
        );
    });

    it('keeps "enter an ip address or hostname first." for an empty box', async () => {
        const p = await build();
        p.type('   ');
        p.generate.click();
        await new Promise((r) => setTimeout(r, 0));
        expect(p.el.querySelector('[data-tls-alert]')!.textContent).toBe('enter an ip address or hostname first.');
    });

    it('publicSuffixWarning quotes the name as typed', () => {
        expect(publicSuffixWarning('net')).toBe(
            '"net" is an internet domain ending, not a computer\'s name, so it can\'t be used. use something like net.lan, or the name your devices use to reach this computer.',
        );
    });
});

// The one transient alert stays in ONE place: the bottom of the tab, below and
// outside all three cards, whichever action raised it (user decision after the
// 0.5.5 review; a version that moved it beside each action was reverted).
describe('local https panel: where the transient alert shows', () => {
    beforeEach(() => {
        HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
            this.setAttribute('open', '');
        });
        HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
            this.removeAttribute('open');
        });
    });
    afterEach(() => {
        vi.useRealTimers();
        document.body.replaceChildren();
        vi.restoreAllMocks();
    });

    async function build() {
        // Every action refused, each with its own reason, so the alert's text says which one put it there.
        const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
            if (url === '/api/tls/generate') return new Response(JSON.stringify({ error: 'nope' }), { status: 400 });
            if (url === '/api/tls/ca-root') {
                return new Response(JSON.stringify({ error: 'slow down' }), { status: 429 });
            }
            if (url === '/api/tls/exposure') {
                return new Response(JSON.stringify({ error: 'refused' }), { status: 403 });
            }
            if (url === '/api/tls/revoke') return new Response(JSON.stringify({ error: 'not here' }), { status: 403 });
            return new Response(
                JSON.stringify(
                    state({ status: 'ready', kind: 'ip', subject: '10.0.0.5', httpsListener: { bound: true } }),
                ),
            );
        });
        const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['10.0.0.5'] });
        const alert = el.querySelector<HTMLElement>('[data-tls-alert]')!;
        return { el, alert };
    }

    /** Where the alert is: the tab's last element, after every card, in no card or item. */
    function expectAtTheBottom(el: HTMLElement, alert: HTMLElement): void {
        expect(alert.parentElement).toBe(el);
        expect(el.lastElementChild).toBe(alert);
        expect(alert.closest('.settings-card, .settings-item')).toBeNull();
        const cards = el.querySelectorAll('.settings-card');
        expect(cards).toHaveLength(3);
        expect(cards[2]!.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }

    it('is the last element of the tab, after the Exposure card, and starts empty', async () => {
        const { el, alert } = await build();
        expect(alert.textContent).toBe('');
        expectAtTheBottom(el, alert);
        expect(el.querySelectorAll('[data-tls-alert]')).toHaveLength(1);
    });

    it.each([
        ['generate', '[data-tls-generate]', 'nope'],
        ['download ca', '[data-tls-download]', 'slow down'],
        ['exposure ok', '[data-exposure-ok]', 'refused'],
    ])('%s: reports there, an error held for 10 s and not a moment more', async (_label, button, text) => {
        vi.useFakeTimers();
        const { el, alert } = await build();
        el.querySelector<HTMLButtonElement>(button)!.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(alert.textContent).not.toBe('');
        expect(alert.textContent).toBe(text);
        expectAtTheBottom(el, alert);
        await vi.advanceTimersByTimeAsync(9_999);
        expect(alert.textContent).not.toBe('');
        await vi.advanceTimersByTimeAsync(2);
        expect(alert.textContent).toBe('');
    });

    it('revoke: reports there too', async () => {
        const { el, alert } = await build();
        el.querySelector<HTMLButtonElement>('[data-tls-revoke]')!.click();
        await new Promise((r) => setTimeout(r, 0));
        const ok = [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(
            (b) => b.textContent === 'ok',
        )!;
        ok.click();
        await new Promise((r) => setTimeout(r, 0));
        expect(alert.textContent).toBe('not here');
        expectAtTheBottom(el, alert);
    });
});

describe('local https panel: help links carry the theme', () => {
    afterEach(() => document.documentElement.removeAttribute('data-theme'));

    it('puts the current theme in both links, before the hash, decided when the link is followed', async () => {
        document.documentElement.setAttribute('data-theme', 'light');
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3'],
        });
        const subjectLink = el.querySelector<HTMLAnchorElement>('[data-tls-subject-guide] a')!;
        const trustLink = el.querySelector<HTMLAnchorElement>('[data-tls-trust-help] a')!;
        expect(subjectLink.getAttribute('href')).toBe('help/certificate-subject.html?theme=light');
        expect(trustLink.getAttribute('href')).toBe(
            'help/certificate-subject.html?theme=light#4-installing-a-certificate-establishing-trust',
        );

        // The theme changes while the dialog is open: the next follow carries the new one.
        document.documentElement.setAttribute('data-theme', 'dark');
        subjectLink.addEventListener('click', (e) => e.preventDefault());
        subjectLink.click();
        expect(subjectLink.getAttribute('href')).toBe('help/certificate-subject.html?theme=dark');
        trustLink.dispatchEvent(new MouseEvent('auxclick', { bubbles: true }));
        expect(trustLink.getAttribute('href')).toBe(
            'help/certificate-subject.html?theme=dark#4-installing-a-certificate-establishing-trust',
        );
    });
});

// 0.5.1: generate needs mkcert, which is installed from the Dependencies tab.
// While the server says it is not installed, generate and the subject controls
// that only feed it are disabled, with a line pointing at the Dependencies tab.
describe('local https panel: generate waits for mkcert', () => {
    const mkcertRow = (installedVersion: string | null, status?: string) => ({
        name: 'mkcert',
        displayName: 'mkcert',
        installedVersion,
        status: status ?? (installedVersion === null ? 'not-installed' : 'up-to-date'),
    });

    /** Answers /api/dependencies from `deps()` (re-read every call), everything else with the TLS state. */
    function routedFetch(deps: () => unknown, tls: unknown = state()) {
        return vi.fn(async (url: string) =>
            url === '/api/dependencies' ? new Response(JSON.stringify(deps())) : new Response(JSON.stringify(tls)),
        ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    }

    function controls(el: HTMLElement) {
        return {
            generate: el.querySelector<HTMLButtonElement>('[data-tls-generate]')!,
            subject: el.querySelector<HTMLInputElement>('[data-tls-subject]')!,
            candidates: el.querySelector<HTMLButtonElement>('[data-tls-candidate-button]')!,
            radios: [...el.querySelectorAll<HTMLInputElement>('input[name="tls-subject-kind"]')],
            notice: el.querySelector<HTMLElement>('[data-tls-mkcert-notice]')!,
            revoke: el.querySelector<HTMLButtonElement>('[data-tls-revoke]')!,
            download: el.querySelector<HTMLButtonElement>('[data-tls-download]')!,
            exposureOk: el.querySelector<HTMLButtonElement>('[data-exposure-ok]')!,
        };
    }

    it('disables generate and the subject controls, and says to install mkcert, while it is not installed', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: routedFetch(() => [mkcertRow(null)]),
            candidateIps: ['192.168.86.3'],
        });
        const c = controls(el);
        expect(c.generate.disabled).toBe(true);
        expect(c.subject.disabled).toBe(true);
        expect(c.candidates.disabled).toBe(true);
        expect(c.radios).toHaveLength(2);
        for (const r of c.radios) expect(r.disabled).toBe(true);
        expect(c.notice.hidden).toBe(false);
        expect(c.notice.textContent).toBe(
            'install mkcert from the dependencies tab to generate a certificate, which is what turns https on. until then, the certificate controls below are unavailable; the other settings on this tab still work.',
        );
    });

    // After 0.5.3: a boxed callout, the tab's FIRST element, above the "Local
    // HTTPS" heading itself (0.5.3 had it as the first line under the heading).
    it('puts the mkcert callout first in the panel, above the heading, as a boxed callout', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: routedFetch(() => [mkcertRow(null)]),
            candidateIps: ['192.168.86.3'],
        });
        const notice = controls(el).notice;
        expect(el.firstElementChild).toBe(notice);
        const heading = el.querySelector(':scope > h3')!;
        expect(heading.textContent).toBe('Local HTTPS');
        expect(notice.nextElementSibling).toBe(heading);
        expect(notice.classList.contains('settings-callout')).toBe(true);
        // Not inside any card: above all three.
        expect(el.querySelector('.settings-card [data-tls-mkcert-notice]')).toBeNull();
        expect(
            notice.compareDocumentPosition(el.querySelector('.settings-card')!) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        // Exactly one such note.
        expect(el.querySelectorAll('[data-tls-mkcert-notice]')).toHaveLength(1);
    });

    it('makes "dependencies tab" a keyboard-reachable link that switches to the Dependencies tab', async () => {
        const showTab = vi.fn();
        const el = await buildLocalHttpsPanel({
            fetchFn: routedFetch(() => [mkcertRow(null)]),
            candidateIps: ['192.168.86.3'],
            showTab,
        });
        const notice = controls(el).notice;
        // The whole callout still reads as the one sentence, link included.
        expect(notice.textContent).toBe(MKCERT_MISSING_NOTICE);
        const links = notice.querySelectorAll<HTMLButtonElement>('button');
        expect(links).toHaveLength(1);
        const link = links[0]!;
        expect(link.type).toBe('button');
        expect(link.textContent).toBe('dependencies tab');
        expect(link.classList.contains('settings-inline-link')).toBe(true);
        expect(link.tabIndex).toBe(0);
        expect(notice.querySelector('a')).toBeNull();
        link.click();
        expect(showTab).toHaveBeenCalledWith('dependencies');
        expect(showTab).toHaveBeenCalledTimes(1);
    });

    it('a callout link with no dialog behind it does nothing rather than throwing', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: routedFetch(() => [mkcertRow(null)]),
            candidateIps: ['192.168.86.3'],
        });
        expect(() => controls(el).notice.querySelector<HTMLButtonElement>('button')!.click()).not.toThrow();
    });

    it('leaves what needs no mkcert alone: the exposure ok, and revoke / download for a certificate that exists', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: routedFetch(() => [mkcertRow(null)], state({ status: 'ready', subject: '192.168.86.3' })),
            candidateIps: ['192.168.86.3'],
        });
        const c = controls(el);
        expect(c.generate.disabled).toBe(true);
        expect(c.revoke.disabled).toBe(false);
        expect(c.download.disabled).toBe(false);
        expect(c.exposureOk.disabled).toBe(false);
    });

    it('a click on the disabled generate sends nothing', async () => {
        const fetchFn = routedFetch(() => [mkcertRow(null)]);
        const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'] });
        // Bypass the disabled attribute: the handler's own guard is what is under test.
        controls(el).generate.dispatchEvent(new MouseEvent('click'));
        await new Promise((r) => setTimeout(r, 0));
        expect(fetchFn.mock.calls.map((c) => c[0])).not.toContain('/api/tls/generate');
    });

    it('enables everything, with no notice, when mkcert is installed', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: routedFetch(() => [mkcertRow('v0.1.0')]),
            candidateIps: ['192.168.86.3'],
        });
        const c = controls(el);
        expect(c.generate.disabled).toBe(false);
        expect(c.subject.disabled).toBe(false);
        for (const r of c.radios) expect(r.disabled).toBe(false);
        expect(c.notice.hidden).toBe(true);
    });

    it.each([
        ['the read is refused', () => new Response('{"error":"forbidden"}', { status: 403 })],
        [
            'the list does not name mkcert',
            () => new Response(JSON.stringify([{ name: 'adb', installedVersion: null }])),
        ],
        ['the read fails', () => Promise.reject(new TypeError('Failed to fetch'))],
    ])('fails open, generate enabled, when %s', async (_label, answer) => {
        const fetchFn = vi.fn(async (url: string) =>
            url === '/api/dependencies' ? answer() : new Response(JSON.stringify(state())),
        ) as unknown as typeof fetch;
        const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'] });
        expect(controls(el).generate.disabled).toBe(false);
        expect(controls(el).notice.hidden).toBe(true);
    });

    it('does not hold the panel back while /api/dependencies hangs, and gates once it answers', async () => {
        let answer: (r: Response) => void = () => undefined;
        const fetchFn = vi.fn((url: string) =>
            url === '/api/dependencies'
                ? new Promise<Response>((r) => {
                      answer = r;
                  })
                : Promise.resolve(new Response(JSON.stringify(state()))),
        ) as unknown as typeof fetch;
        const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'] });
        expect(controls(el).generate.disabled).toBe(false);

        answer(new Response(JSON.stringify([mkcertRow(null)])));
        await new Promise((r) => setTimeout(r, 0));
        expect(controls(el).generate.disabled).toBe(true);
        expect(controls(el).notice.hidden).toBe(false);
    });

    it('a re-check after mkcert is installed enables generate and withdraws the notice', async () => {
        let installed: string | null = null;
        const el = await buildLocalHttpsPanel({
            fetchFn: routedFetch(() => [mkcertRow(installed)]),
            candidateIps: ['192.168.86.3'],
        });
        expect(controls(el).generate.disabled).toBe(true);

        installed = 'v0.1.0';
        await recheckLocalHttpsMkcert(el);

        const c = controls(el);
        expect(c.generate.disabled).toBe(false);
        expect(c.subject.disabled).toBe(false);
        for (const r of c.radios) expect(r.disabled).toBe(false);
        expect(c.notice.hidden).toBe(true);
    });

    it('fetchMkcertInstalled reads installedVersion, and answers null when it cannot tell', async () => {
        const answer = (body: unknown, status = 200) =>
            vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
        expect(await fetchMkcertInstalled(answer([mkcertRow('v0.1.0')]))).toBe(true);
        expect(await fetchMkcertInstalled(answer([mkcertRow(null)]))).toBe(false);
        expect(await fetchMkcertInstalled(answer({ status: 'none' }))).toBeNull();
        expect(await fetchMkcertInstalled(answer([], 403))).toBeNull();
        expect(await fetchMkcertInstalled(answer([]))).toBeNull();
    });

    it('fetchMkcertInstalled says "not installed" only when the server said so', async () => {
        const answer = (body: unknown) =>
            vi.fn(async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
        // The server's own verdicts.
        expect(await fetchMkcertInstalled(answer([mkcertRow(null, 'not-installed')]))).toBe(false);
        expect(await fetchMkcertInstalled(answer([mkcertRow(null, 'error')]))).toBe(false);
        // The boot window: before checkAll reaches mkcert every dependency is
        // `unknown` with a null version. That is "cannot tell", not "missing".
        expect(await fetchMkcertInstalled(answer([mkcertRow(null, 'unknown')]))).toBeNull();
        expect(await fetchMkcertInstalled(answer([mkcertRow(null, 'checking')]))).toBeNull();
        expect(await fetchMkcertInstalled(answer([{ name: 'mkcert', installedVersion: null }]))).toBeNull();
        // An installed version wins whatever the status says.
        expect(await fetchMkcertInstalled(answer([mkcertRow('v0.1.0', 'error')]))).toBe(true);
    });

    it('in the boot window (mkcert still unknown) generate stays enabled and no notice is shown', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: routedFetch(() => [mkcertRow(null, 'unknown')]),
            candidateIps: ['192.168.86.3'],
        });
        const c = controls(el);
        expect(c.generate.disabled).toBe(false);
        expect(c.subject.disabled).toBe(false);
        expect(c.notice.hidden).toBe(true);
    });
});

describe('pure notification helpers', () => {
    // subPrivilegedPortNotice moved to ServerTab.ts with the https port (serverTab.test.ts).

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
    // This repo's rule: transient outcomes get ONE alert in one place at the
    // bottom of the tab (5s success / 10s error), never a status line per
    // control (the describe above pins where). Each test below pins both that
    // the alert
    // fires with the right text AND that it stops existing at the wrong
    // moment — a version with no timer (always visible) or an immediate hide
    // (never visible) each fail one of the two assertions.

    it('uses a single shared alert element, not one per control', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3'],
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
            const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'] });
            el.querySelector<HTMLButtonElement>('[data-tls-generate]')!.click();
            await vi.advanceTimersByTimeAsync(0);

            const alert = el.querySelector<HTMLElement>('[data-tls-alert]')!;
            expect(alert.textContent).not.toBe('');
            expect(alert.textContent).toMatch(/certificate generated/i);

            await vi.advanceTimersByTimeAsync(4_999);
            expect(alert.textContent).not.toBe('');
            await vi.advanceTimersByTimeAsync(2);
            expect(alert.textContent).toBe('');
        } finally {
            vi.useRealTimers();
        }
    });

    it('states the accepted-name edit in the same alert, echoing the subject via textContent (I11)', async () => {
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
        const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'] });
        el.querySelector<HTMLButtonElement>('[data-tls-generate]')!.click();
        await new Promise((r) => setTimeout(r, 0));
        const alert = el.querySelector<HTMLElement>('[data-tls-alert]')!;
        // Paired: the payload was actually rendered as text (ruling out the
        // trivial pass where it is dropped entirely)...
        expect(alert.textContent).toContain(payload);
        expect(alert.textContent).toBe(
            `certificate generated. this server now also accepts connections addressed to ${payload}.`,
        );
        expect(alert.textContent).not.toMatch(/allowedHosts/i);
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
            const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'] });
            el.querySelector<HTMLButtonElement>('[data-tls-download]')!.click();
            await vi.advanceTimersByTimeAsync(0);

            const alert = el.querySelector<HTMLElement>('[data-tls-alert]')!;
            expect(alert.textContent).toMatch(/too many ca downloads/i);

            // Errors get the LONGER window (10s), not the success window (5s) --
            // this is the assertion that would catch a copy-paste of the wrong
            // constant into the error branch.
            await vi.advanceTimersByTimeAsync(5_000);
            expect(alert.textContent).not.toBe('');
            await vi.advanceTimersByTimeAsync(4_999);
            expect(alert.textContent).not.toBe('');
            await vi.advanceTimersByTimeAsync(2);
            expect(alert.textContent).toBe('');
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
        const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'] });
        el.querySelector<HTMLButtonElement>('[data-exposure-ok]')!.click();
        await new Promise((r) => setTimeout(r, 0));
        // Scoped to the alert element, not whole-panel textContent. The line
        // is never `hidden` (0.5.5: a live region stays in the accessibility
        // tree), so its text IS whether it shows.
        const alert = el.querySelector<HTMLElement>('[data-tls-alert]')!;
        expect(alert.textContent).not.toBe('');
        expect(alert.textContent).toMatch(/does not support saving this setting yet/i);
    });

    // The https port's restart note, range check, save and error reporting moved to the Server tab with the
    // port (serverTab.test.ts, and settingsBatchApi.test.ts for the server half).

    it('keeps a persistent condition (notification 4) visible after the transient alert times out and hides (I10)', async () => {
        // The original version of this test built the panel, advanced fake
        // timers by 15s, and re-checked textContent -- but nothing ever
        // showed a transient alert, so no timer was ever armed, and
        // textContent still matches a HIDDEN element in jsdom. Neither half
        // of that was actually exercising persistence. This version drives a
        // real transient alert through its own window and asserts the notice's
        // `.hidden` and the alert's text (empty when idle: the line is never
        // hidden since 0.5.5), so it fails if the persistent notice were ever
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
            });
            const mismatch = el.querySelector<HTMLElement>('[data-tls-mismatch-notice]')!;
            const alert = el.querySelector<HTMLElement>('[data-tls-alert]')!;

            expect(mismatch.hidden).toBe(false);
            expect(alert.textContent).toBe(''); // nothing transient has happened yet

            el.querySelector<HTMLButtonElement>('[data-tls-download]')!.click();
            await vi.advanceTimersByTimeAsync(0);
            expect(alert.textContent).not.toBe('');

            // Past the transient alert's own 10s (error) window: IT empties...
            await vi.advanceTimersByTimeAsync(10_001);
            expect(alert.textContent).toBe('');
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
            const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'] });
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
            expect(alert.textContent).not.toBe('');
            expect(alert.textContent).toMatch(/too many ca downloads/i);

            // t=11001: past the SECOND alert's own 10s deadline (measured
            // from ITS start at t=1000) -- now it hides.
            await vi.advanceTimersByTimeAsync(6_000);
            expect(alert.textContent).toBe('');
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
        });
        expect(elNone.querySelector<HTMLButtonElement>('[data-tls-revoke]')!.disabled).toBe(true);

        const elReady = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state({ status: 'ready' })))),
            candidateIps: ['192.168.86.3'],
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
        const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'] });
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
        const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'] });
        const revokeBtn = el.querySelector<HTMLButtonElement>('[data-tls-revoke]')!;
        revokeBtn.click();
        await new Promise((r) => setTimeout(r, 0));
        modalButton('ok').click();
        await new Promise((r) => setTimeout(r, 0));
        expect(fetchFn).toHaveBeenCalledWith('/api/tls/revoke', expect.objectContaining({ method: 'POST' }));
        expect(el.querySelector('[data-tls-current-subject]')).toBeNull();
        expect(revokeBtn.disabled).toBe(true);
    });

    // The Server tab's https port opens only while a certificate exists, so the
    // panel announces each change for the dialog to pass on (TLS_CERT_CHANGED_EVENT).
    it('announces a revoke, bubbling, so the Server tab re-reads its https port', async () => {
        const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
            if (url === '/api/tls/revoke') return new Response(JSON.stringify({ ok: true }));
            return new Response(JSON.stringify(state({ status: 'ready', kind: 'ip', subject: '192.168.86.3' })));
        });
        const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'] });
        // Listened for on the panel itself rather than with the panel in the
        // document: `modalButton('ok')` searches the whole document, and the
        // panel has "ok" buttons of its own.
        const announced = vi.fn((e: Event) => e.bubbles);
        el.addEventListener(TLS_CERT_CHANGED_EVENT, announced);
        el.querySelector<HTMLButtonElement>('[data-tls-revoke]')!.click();
        await new Promise((r) => setTimeout(r, 0));
        modalButton('ok').click();
        await new Promise((r) => setTimeout(r, 0));
        expect(announced).toHaveBeenCalledTimes(1);
        expect(announced.mock.results[0]?.value, 'bubbles').toBe(true);
    });

    it('announces a generate, and stays quiet when the generate is refused', async () => {
        let refuse = false;
        const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
            if (url === '/api/tls/generate') {
                return refuse
                    ? new Response(JSON.stringify({ error: 'nope' }), { status: 400 })
                    : new Response(JSON.stringify({ status: 'ready', kind: 'ip', subject: '192.168.86.3' }));
            }
            return new Response(JSON.stringify(state()));
        });
        const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'] });
        const announced = vi.fn();
        el.addEventListener(TLS_CERT_CHANGED_EVENT, announced);
        el.querySelector<HTMLButtonElement>('[data-tls-generate]')!.click();
        await new Promise((r) => setTimeout(r, 0));
        expect(announced).toHaveBeenCalledTimes(1);

        refuse = true;
        el.querySelector<HTMLButtonElement>('[data-tls-generate]')!.click();
        await new Promise((r) => setTimeout(r, 0));
        expect(announced).toHaveBeenCalledTimes(1);
    });

    it('a refused revoke shows the server-provided reason and keeps the certificate (item 153)', async () => {
        // An off-box caller in open mode is refused by requireOperator; the panel
        // must say why, as generate/exposure/port already do, not just "(403)".
        const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
            if (url === '/api/tls/revoke') {
                return new Response(JSON.stringify({ error: 'admin actions are limited to this machine' }), {
                    status: 403,
                });
            }
            return new Response(JSON.stringify(state({ status: 'ready', kind: 'ip', subject: '192.168.86.3' })));
        });
        const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'] });
        const revokeBtn = el.querySelector<HTMLButtonElement>('[data-tls-revoke]')!;
        revokeBtn.click();
        await new Promise((r) => setTimeout(r, 0));
        modalButton('ok').click();
        await new Promise((r) => setTimeout(r, 0));
        const alert = el.querySelector<HTMLElement>('[data-tls-alert]')!;
        expect(alert.textContent).toMatch(/admin actions are limited to this machine/);
        expect(el.querySelector('[data-tls-current-subject]')).not.toBeNull();
        expect(revokeBtn.disabled).toBe(false);
    });

    // I2's https port prefill moved to the Server tab with the port (serverTab.test.ts).

    // ---- 0.5.3: the install steps live on the help page; the panel links there ----

    it('replaces the per-OS trust steps with one link to the help page, opening in a new tab', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(
                async () => new Response(JSON.stringify(state({ status: 'ready', subject: '192.168.86.3' }))),
            ),
            candidateIps: ['192.168.86.3'],
        });
        // The accordion and its per-OS steps are gone.
        expect(el.querySelector('details')).toBeNull();
        expect(el.textContent).not.toMatch(/how to trust this certificate on your device/i);
        expect(el.textContent).not.toMatch(/update-ca-certificates|keychain access|renamed to end in/i);

        const line = el.querySelector<HTMLElement>('[data-tls-trust-help]')!;
        expect(line).not.toBeNull();
        expect(line.hidden).toBe(false);
        const links = line.querySelectorAll<HTMLAnchorElement>('a');
        expect(links).toHaveLength(1);
        const link = links[0]!;
        // The section's hash stays last, after the theme (helpLink.ts).
        expect(link.getAttribute('href')).toBe(
            'help/certificate-subject.html?theme=dark#4-installing-a-certificate-establishing-trust',
        );
        expect(TRUST_HELP_HREF).toBe('help/certificate-subject.html#4-installing-a-certificate-establishing-trust');
        expect(link.target).toBe('_blank');
        expect(link.rel).toBe('noopener noreferrer');
        // 0.5.5: shorter, with "(opens in a new tab)" for a screen reader only.
        expect(line.textContent).toBe(
            'install it on each device that connects (firefox has its own store). install guide ↗',
        );
        expect(link.textContent).toBe('install guide ↗');
        expect(link.getAttribute('aria-label')).toBe('install guide (opens in a new tab)');
    });

    it('saves the CA as ws-scrcpy-web-local-ca.crt (0.5.3; it was .pem)', async () => {
        const fetchFn = vi.fn(async (url: string) =>
            url === '/api/tls/ca-root'
                ? new Response('-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n', { status: 200 })
                : new Response(JSON.stringify(state({ status: 'ready', subject: '192.168.86.3' }))),
        ) as unknown as typeof fetch;
        // jsdom has no blob URLs; swap the two statics in for this test only.
        const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
        const created = vi.fn(() => 'blob:x');
        URL.createObjectURL = created;
        URL.revokeObjectURL = vi.fn();
        const names: string[] = [];
        const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
            this: HTMLAnchorElement,
        ) {
            names.push(this.download);
        });
        try {
            const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'] });
            el.querySelector<HTMLButtonElement>('[data-tls-download]')!.click();
            await vi.waitFor(() => expect(names).toEqual(['ws-scrcpy-web-local-ca.crt']));
            expect(created).toHaveBeenCalledTimes(1);
            expect(el.querySelector('[data-tls-alert]')!.textContent).toBe('ca certificate downloaded.');
        } finally {
            clickSpy.mockRestore();
            URL.createObjectURL = original.create;
            URL.revokeObjectURL = original.revoke;
        }
    });
    // ---- I7: every candidate IP, not an arbitrary one ----

    it('lists every candidate ip in the subject list, not just one, whatever the box holds (I7)', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3', '10.0.0.5', '172.16.4.9'],
        });
        const button = el.querySelector<HTMLButtonElement>('[data-tls-candidate-button]')!;
        const list = el.querySelector<HTMLElement>('[data-tls-candidate-list]')!;
        const subjectInput = el.querySelector<HTMLInputElement>('[data-tls-subject]')!;
        const options = () => [...list.querySelectorAll<HTMLElement>('[role="option"]')];
        expect(button.hidden).toBe(false); // ip mode is the default
        button.click();
        expect(options().map((o) => o.textContent)).toEqual(['192.168.86.3', '10.0.0.5', '172.16.4.9']);
        // The current value ticked.
        expect(options().map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);

        // Never filtered by what is typed (a native datalist would be).
        button.click();
        subjectInput.value = '10.0';
        subjectInput.dispatchEvent(new Event('input'));
        button.click();
        expect(options()).toHaveLength(3);
    });

    it('picking a candidate fills the subject box and closes the list; hostname mode has no list (I7)', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3', '10.0.0.5'],
        });
        const button = el.querySelector<HTMLButtonElement>('[data-tls-candidate-button]')!;
        const list = el.querySelector<HTMLElement>('[data-tls-candidate-list]')!;
        const subjectInput = el.querySelector<HTMLInputElement>('[data-tls-subject]')!;

        button.click();
        [...list.querySelectorAll<HTMLElement>('[role="option"]')][1]!.click();
        expect(subjectInput.value).toBe('10.0.0.5');
        expect(list.hidden).toBe(true);

        el.querySelector<HTMLInputElement>('input[name="tls-subject-kind"][value="hostname"]')!.click();
        expect(button.hidden).toBe(true);

        el.querySelector<HTMLInputElement>('input[name="tls-subject-kind"][value="ip"]')!.click();
        expect(button.hidden).toBe(false);
    });

    // ---- I11: narrowed exposure needs a certificate to mean anything ----

    it('disables the narrowed exposure modes with no certificate, and enables them once the listener is bound (I11)', async () => {
        const elNone = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3'],
        });
        expect(elNone.querySelector<HTMLInputElement>('[data-exposure="httpsOnly"]')!.disabled).toBe(true);
        expect(elNone.querySelector<HTMLInputElement>('[data-exposure="redirect"]')!.disabled).toBe(true);
        expect(elNone.querySelector<HTMLInputElement>('[data-exposure="open"]')!.disabled).toBe(false);
        const notice = elNone.querySelector<HTMLElement>('[data-exposure-unavailable-notice]')!;
        expect(notice.hidden).toBe(false);
        // 0.5.5: short, under the disabled radios it explains.
        expect(notice.textContent).toBe('needs a certificate first.');

        const elReady = await buildLocalHttpsPanel({
            fetchFn: vi.fn(
                async () =>
                    new Response(
                        JSON.stringify(state({ status: 'ready', httpsListener: { bound: true, port: 8443 } })),
                    ),
            ),
            candidateIps: ['192.168.86.3'],
        });
        expect(elReady.querySelector<HTMLInputElement>('[data-exposure="httpsOnly"]')!.disabled).toBe(false);
        expect(elReady.querySelector<HTMLElement>('[data-exposure-unavailable-notice]')!.hidden).toBe(true);
    });

    it('keeps the narrowed exposure modes disabled with a certificate but NO bound listener (N2)', async () => {
        // The exact gap the re-review named: a certificate can exist while
        // C1's four down-cases mean nothing is actually listening (most
        // commonly right after generate, before a restart). Gating on
        // `status === 'ready'` alone let a user narrow plain HTTP toward an
        // HTTPS listener that wasn't running.
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(
                async () =>
                    new Response(
                        JSON.stringify(
                            state({ status: 'ready', httpsListener: { bound: false, reason: 'restart-required' } }),
                        ),
                    ),
            ),
            candidateIps: ['192.168.86.3'],
        });
        expect(el.querySelector<HTMLInputElement>('[data-exposure="httpsOnly"]')!.disabled).toBe(true);
        const notice = el.querySelector<HTMLElement>('[data-exposure-unavailable-notice]')!;
        expect(notice.hidden).toBe(false);
        expect(notice.textContent).toBe('restart the server first.');
    });

    it('a generate response with a bound listener re-enables the narrowed exposure modes; one without keeps them disabled (I11/N2)', async () => {
        const responseFor = (httpsListener?: { bound: boolean; reason?: string }) =>
            vi.fn(async (url: RequestInfo | URL) => {
                if (url === '/api/tls/generate') {
                    return new Response(
                        JSON.stringify({ status: 'ready', kind: 'ip', subject: '192.168.86.3', httpsListener }),
                    );
                }
                return new Response(JSON.stringify(state()));
            });

        // A generate response with no `httpsListener` at all (an older
        // server, or one that omits it on this route) must not be read as
        // "bound" by default -- this pins that a generate happening at all
        // does NOT wrongly enable narrowing on its own.
        const stillNotBound = await buildLocalHttpsPanel({
            fetchFn: responseFor(undefined),
            candidateIps: ['192.168.86.3'],
        });
        stillNotBound.querySelector<HTMLButtonElement>('[data-tls-generate]')!.click();
        await new Promise((r) => setTimeout(r, 0));
        expect(stillNotBound.querySelector<HTMLInputElement>('[data-exposure="httpsOnly"]')!.disabled).toBe(true);

        const nowBound = await buildLocalHttpsPanel({
            fetchFn: responseFor({ bound: true }),
            candidateIps: ['192.168.86.3'],
        });
        const httpsOnlyRadio = nowBound.querySelector<HTMLInputElement>('[data-exposure="httpsOnly"]')!;
        expect(httpsOnlyRadio.disabled).toBe(true);
        nowBound.querySelector<HTMLButtonElement>('[data-tls-generate]')!.click();
        await new Promise((r) => setTimeout(r, 0));
        expect(httpsOnlyRadio.disabled).toBe(false);
    });

    // ---- C1: listener truth, not certificate existence ----

    it('says nothing about the listener when the server has not reported it, and the CA-trust claim still holds (C1)', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state({ status: 'ready' })))),
            candidateIps: ['192.168.86.3'],
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

    // NOTE: this mocks `POST /api/tls/generate`'s response, so it proves the
    // CLIENT's reaction to a given `httpsListener` shape -- it does NOT
    // prove the real route sends that shape; that is `tlsApi.test.ts`'s job.
    // The contrast pair below (bound vs. not) is what makes this a real
    // proof of the CLIENT's behaviour rather than a tautology: only the
    // "not bound" case should ever mention a restart.
    it('mentions the restart in the SAME transient alert right after a generate that needs one, and only then (C1)', async () => {
        const responseFor = (httpsListener: { bound: boolean; reason?: string }) =>
            vi.fn(async (url: RequestInfo | URL) => {
                if (url === '/api/tls/generate') {
                    return new Response(
                        JSON.stringify({ status: 'ready', kind: 'ip', subject: '192.168.86.3', httpsListener }),
                    );
                }
                return new Response(JSON.stringify(state()));
            });

        const needsRestart = await buildLocalHttpsPanel({
            fetchFn: responseFor({ bound: false, reason: 'restart-required' }),
            candidateIps: ['192.168.86.3'],
        });
        needsRestart.querySelector<HTMLButtonElement>('[data-tls-generate]')!.click();
        await new Promise((r) => setTimeout(r, 0));
        expect(needsRestart.querySelector<HTMLElement>('[data-tls-alert]')!.textContent).toMatch(
            /certificate generated\. restart the server to start serving https/i,
        );

        const alreadyBound = await buildLocalHttpsPanel({
            fetchFn: responseFor({ bound: true }),
            candidateIps: ['192.168.86.3'],
        });
        alreadyBound.querySelector<HTMLButtonElement>('[data-tls-generate]')!.click();
        await new Promise((r) => setTimeout(r, 0));
        const boundAlert = alreadyBound.querySelector<HTMLElement>('[data-tls-alert]')!;
        expect(boundAlert.textContent).toMatch(/certificate generated\./i);
        expect(boundAlert.textContent).not.toMatch(/restart/i);
    });

    it('listenerStatusNotice is null for a non-ready cert or a confirmed-bound listener with no reason', () => {
        expect(listenerStatusNotice({ status: 'none' })).toBeNull();
        expect(listenerStatusNotice({ status: 'ready', httpsListener: { bound: true, port: 8443 } })).toBeNull();
        expect(listenerStatusNotice({ status: 'ready' })).toBeNull(); // unknown -- say nothing
    });

    // NF-1 (Critical, re-review): `reason` can accompany `bound: true` -- a
    // regenerate leaves the ALREADY-bound socket serving the OLD leaf, since
    // nothing rebinds it in-process. Checking `bound` alone (the pre-NF-1
    // bug) would treat this exact case as "all good".
    it('warns about a stale leaf even when the listener IS bound, with wording distinct from "not started yet" (NF-1)', () => {
        const staleWhileBound = listenerStatusNotice({
            status: 'ready',
            httpsListener: { bound: true, port: 8443, reason: 'restart-required' },
        });
        const neverBound = listenerStatusNotice({
            status: 'ready',
            httpsListener: { bound: false, reason: 'restart-required' },
        });
        expect(staleWhileBound).not.toBeNull();
        expect(neverBound).not.toBeNull();
        // Distinct copy: one says the listener IS running (stale content),
        // the other says it has not started -- swapping them would tell a
        // user with a live-but-stale listener to wait for something that
        // already happened, or tell a user with nothing running that it's
        // "still" running the old cert.
        expect(staleWhileBound).not.toBe(neverBound);
        expect(staleWhileBound).toMatch(/is running/i);
        expect(staleWhileBound).toMatch(/no longer exists|old ca|before your last regenerate/i);
        expect(neverBound).toMatch(/has not started/i);
    });

    it('suppresses "streaming already works" for a stale-but-bound listener, and shows it for a genuinely clean one (NF-1)', async () => {
        const stale = await buildLocalHttpsPanel({
            fetchFn: vi.fn(
                async () =>
                    new Response(
                        JSON.stringify(
                            state({
                                status: 'ready',
                                httpsListener: { bound: true, port: 8443, reason: 'restart-required' },
                            }),
                        ),
                    ),
            ),
            candidateIps: ['192.168.86.3'],
        });
        expect(stale.querySelector<HTMLElement>('[data-tls-ca-trust-notice]')!.hidden).toBe(true);
        expect(stale.querySelector<HTMLElement>('[data-tls-listener-notice]')!.hidden).toBe(false);
        expect(stale.textContent).not.toMatch(/streaming already works/i);

        const clean = await buildLocalHttpsPanel({
            fetchFn: vi.fn(
                async () =>
                    new Response(
                        JSON.stringify(state({ status: 'ready', httpsListener: { bound: true, port: 8443 } })),
                    ),
            ),
            candidateIps: ['192.168.86.3'],
        });
        expect(clean.querySelector<HTMLElement>('[data-tls-ca-trust-notice]')!.hidden).toBe(false);
        expect(clean.querySelector<HTMLElement>('[data-tls-listener-notice]')!.hidden).toBe(true);
        expect(clean.textContent).toMatch(/streaming already works/i);
    });

    it('a generate that leaves the OLD leaf bound says "serves the new certificate", not "start serving https" (NF-1)', async () => {
        const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
            if (url === '/api/tls/generate') {
                return new Response(
                    JSON.stringify({
                        status: 'ready',
                        kind: 'ip',
                        subject: '192.168.86.3',
                        httpsListener: { bound: true, port: 8443, reason: 'restart-required' },
                    }),
                );
            }
            return new Response(JSON.stringify(state()));
        });
        const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'] });
        el.querySelector<HTMLButtonElement>('[data-tls-generate]')!.click();
        await new Promise((r) => setTimeout(r, 0));
        const alert = el.querySelector<HTMLElement>('[data-tls-alert]')!;
        expect(alert.textContent).toMatch(
            /certificate generated\. restart the server so it serves the new certificate/i,
        );
        expect(alert.textContent).not.toMatch(/start serving https/i);
    });
});
