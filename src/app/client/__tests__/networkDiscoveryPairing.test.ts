// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PairingStatus } from '../../../common/PairingStatus';
import { isTerminalPairingState, pairingStatusText, renderPairingSection } from '../NetworkDiscoveryPanel';

// ---------------------------------------------------------------------------
// Helpers
//
// The mocked Responses carry `status` as well as `ok`, because the client
// branches on 404 and 403 specifically — a fake that only sets `ok` cannot tell
// "the session is gone" from "you are not an admin".
// ---------------------------------------------------------------------------

function jsonRes(status: number, body: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const QR_START = { sessionId: 's1', svg: '<svg viewBox="0 0 41 41"></svg>', expiresAt: 0 };

function qrStartRes(): ReturnType<typeof jsonRes> {
    return jsonRes(200, { ...QR_START, expiresAt: Date.now() + 180_000 });
}

function statusLine(el: HTMLElement): HTMLElement {
    return el.querySelector<HTMLElement>('[data-pair-status]')!;
}

function actionButton(el: HTMLElement): HTMLButtonElement {
    return el.querySelector<HTMLButtonElement>('[data-pair-action]')!;
}

describe('pairingStatusText', () => {
    it('presents paired-not-connected as a partial success with a Connect action', () => {
        // NOT an error. The pairing is durable; calling it a failure makes the
        // user re-pair a device that is already paired.
        const r = pairingStatusText({ state: 'paired-not-connected', message: 'no connect service' });
        expect(r.action).toBe('connect');
        expect(r.text).toMatch(/paired/i);
        expect(r.text).not.toMatch(/failed|error/i);
    });

    it('offers a restart on expiry', () => {
        expect(pairingStatusText({ state: 'expired' }).action).toBe('restart');
    });

    it('reports a real failure as a failure', () => {
        const r = pairingStatusText({ state: 'failed', message: 'pairing refused' });
        expect(r.text).toMatch(/refused/);
        expect(r.action).toBe('restart');
    });

    it('offers no action while a session is still running', () => {
        for (const state of ['awaiting-scan', 'pairing', 'connecting', 'paired'] as const) {
            expect(pairingStatusText({ state }).action).toBeUndefined();
        }
    });
});

describe('isTerminalPairingState', () => {
    it('counts expired as terminal', () => {
        // Expiry applies only while a session is awaiting a scan, so there is no
        // expired -> paired flip to defend against: stopping here is correct.
        expect(isTerminalPairingState('expired')).toBe(true);
    });

    it('counts paired-not-connected as terminal', () => {
        expect(isTerminalPairingState('paired-not-connected')).toBe(true);
    });

    it('does not count the in-flight states as terminal', () => {
        expect(isTerminalPairingState('awaiting-scan')).toBe(false);
        expect(isTerminalPairingState('pairing')).toBe(false);
        expect(isTerminalPairingState('connecting')).toBe(false);
    });
});

describe('renderPairingSection', () => {
    let fetchFn: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchFn = vi.fn();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    function mount(extra: Partial<Parameters<typeof renderPairingSection>[0]> = {}): HTMLElement {
        return renderPairingSection({ fetchFn: fetchFn as never, ...extra });
    }

    async function startQr(el: HTMLElement): Promise<void> {
        el.querySelector<HTMLButtonElement>('[data-pair-mode="qr"]')!.click();
        await vi.advanceTimersByTimeAsync(0);
    }

    it('renders the returned svg and never receives the payload', async () => {
        fetchFn.mockResolvedValue({
            ok: true,
            json: async () => ({
                sessionId: 's1',
                svg: '<svg viewBox="0 0 29 29"></svg>',
                expiresAt: Date.now() + 180000,
            }),
        });
        const el = renderPairingSection({ fetchFn: fetchFn as never });
        el.querySelector<HTMLButtonElement>('[data-pair-mode="qr"]')!.click();
        await vi.advanceTimersByTimeAsync(0);

        expect(el.querySelector('svg')).not.toBeNull();
        // The original form of this assertion — JSON.stringify(mock.results) —
        // could not fail: stringify drops the `json` function, so the body was
        // never in the string it searched. Read the body properly instead.
        const res = (await fetchFn.mock.results[0]!.value) as { json: () => Promise<Record<string, unknown>> };
        const body = await res.json();
        expect(Object.keys(body)).not.toContain('payload');
        expect(String(body['svg'])).not.toContain('WIFI:T:ADB');
    });

    it('never puts a payload on screen even if the server sends one', async () => {
        // The assertion above pins the ROUTE's shape. This one pins OUR code: a
        // client that started reading a payload — to re-render it, to log it, to
        // show it as a fallback — would put the pairing password in the DOM.
        // Give it one and prove none of it lands anywhere on the page.
        const payload = 'WIFI:T:ADB;S:ws-scrcpy-web;P:874319;;';
        fetchFn.mockResolvedValue(
            jsonRes(200, {
                sessionId: 's1',
                svg: '<svg viewBox="0 0 41 41"></svg>',
                expiresAt: Date.now() + 180_000,
                payload,
            }),
        );
        const el = mount();
        await startQr(el);

        expect(el.querySelector('svg')).not.toBeNull();
        expect(el.innerHTML).not.toContain('WIFI:T:ADB');
        expect(el.innerHTML).not.toContain('874319');
    });

    it('asks the server for a QR and never sends it a payload to embed', async () => {
        fetchFn.mockResolvedValue(qrStartRes());
        const el = mount();
        await startQr(el);

        const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit | undefined];
        expect(url).toBe('/api/devices/pair/qr');
        expect(init?.method).toBe('POST');
        // No body at all: the payload (which embeds the password) is built
        // server-side and only the rendered markup comes back.
        expect(init?.body).toBeUndefined();
    });

    it('stops polling once the session reaches a terminal state', async () => {
        fetchFn
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ sessionId: 's1', svg: '<svg></svg>', expiresAt: Date.now() + 180000 }),
            })
            .mockResolvedValue({ ok: true, json: async () => ({ state: 'paired' }) });
        const el = renderPairingSection({ fetchFn: fetchFn as never });
        el.querySelector<HTMLButtonElement>('[data-pair-mode="qr"]')!.click();
        await vi.advanceTimersByTimeAsync(0);

        await vi.advanceTimersByTimeAsync(1000); // first status poll -> paired
        const afterTerminal = fetchFn.mock.calls.length;
        await vi.advanceTimersByTimeAsync(5000); // must issue nothing further
        expect(fetchFn.mock.calls.length).toBe(afterTerminal);
    });

    it('stops polling on expiry and offers a restart', async () => {
        fetchFn.mockResolvedValueOnce(qrStartRes()).mockResolvedValue(jsonRes(200, { state: 'expired' }));
        const el = mount();
        await startQr(el);
        await vi.advanceTimersByTimeAsync(1000);

        const afterTerminal = fetchFn.mock.calls.length;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(fetchFn.mock.calls.length).toBe(afterTerminal);
        expect(actionButton(el).hidden).toBe(false);
        expect(actionButton(el).textContent).toMatch(/start again/i);
    });

    it('presents paired-not-connected in the DOM as a partial success, not a failure', async () => {
        fetchFn.mockResolvedValueOnce(qrStartRes()).mockResolvedValue(
            jsonRes(200, {
                state: 'paired-not-connected',
                message: 'no connect service found',
                serial: 'abc123',
                address: '192.168.86.190:5555',
            }),
        );
        const el = mount();
        await startQr(el);
        await vi.advanceTimersByTimeAsync(1000);

        const line = statusLine(el);
        expect(line.textContent).toMatch(/paired/i);
        expect(line.textContent).not.toMatch(/failed|error/i);
        // The error styling is what a user reads as "this did not work".
        expect(line.classList.contains('error')).toBe(false);
        expect(actionButton(el).hidden).toBe(false);
        expect(actionButton(el).textContent).toMatch(/connect/i);
    });

    it('connects a paired-not-connected device through the ordinary connect route', async () => {
        fetchFn
            .mockResolvedValueOnce(qrStartRes())
            .mockResolvedValueOnce(
                jsonRes(200, {
                    state: 'paired-not-connected',
                    message: 'x',
                    serial: 'abc123',
                    address: '10.0.0.5:5555',
                }),
            )
            .mockResolvedValue(jsonRes(200, { success: true, message: 'ok' }));
        const el = mount();
        await startQr(el);
        await vi.advanceTimersByTimeAsync(1000);

        actionButton(el).click();
        await vi.advanceTimersByTimeAsync(0);

        const connectCall = fetchFn.mock.calls.find((c) => c[0] === '/api/devices/connect');
        expect(connectCall).toBeDefined();
        const body = JSON.parse(String((connectCall![1] as RequestInit).body)) as Record<string, unknown>;
        expect(body['address']).toBe('10.0.0.5:5555');
        expect(body['serial']).toBe('abc123');
        expect(statusLine(el).classList.contains('error')).toBe(false);
    });

    it('treats the 404 that follows the user cancelling as confirmation, not an error', async () => {
        // Cancelling drops the session server-side, so an in-flight status poll
        // lands on a 404. Reporting that as a failure tells the user pairing
        // broke when in fact they stopped it themselves.
        let resolveStatus: ((v: unknown) => void) | undefined;
        fetchFn
            .mockResolvedValueOnce(qrStartRes())
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveStatus = resolve;
                    }),
            )
            .mockResolvedValue(jsonRes(200, { ok: true }));

        const el = mount();
        await startQr(el);
        await vi.advanceTimersByTimeAsync(1000); // the poll fires and hangs

        el.querySelector<HTMLButtonElement>('[data-pair-cancel]')!.click();
        await vi.advanceTimersByTimeAsync(0);

        expect(resolveStatus).toBeDefined();
        resolveStatus!(jsonRes(404, { error: 'no such pairing session' }));
        await vi.advanceTimersByTimeAsync(0);

        const line = statusLine(el);
        expect(line.textContent).toMatch(/cancelled/i);
        expect(line.textContent).not.toMatch(/failed|error|no longer available/i);
        expect(line.classList.contains('error')).toBe(false);
        expect(actionButton(el).hidden).toBe(true);
    });

    it('does not re-arm the poll when an in-flight status resolves after a cancel', async () => {
        // The dangerous half of the same race. `cancelSession` clears the timer
        // but cannot recall a request already in flight; if that reply is allowed
        // through it renders over "Pairing cancelled." AND schedules another
        // poll, so a session the user stopped can run on to announce success.
        let resolveStatus: ((v: unknown) => void) | undefined;
        fetchFn
            .mockResolvedValueOnce(qrStartRes())
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveStatus = resolve;
                    }),
            )
            .mockResolvedValue(jsonRes(200, { ok: true }));

        const el = mount();
        await startQr(el);
        await vi.advanceTimersByTimeAsync(1000); // the poll fires and hangs

        el.querySelector<HTMLButtonElement>('[data-pair-cancel]')!.click();
        await vi.advanceTimersByTimeAsync(0);
        const afterCancel = fetchFn.mock.calls.length;

        resolveStatus!(jsonRes(200, { state: 'awaiting-scan' }));
        await vi.advanceTimersByTimeAsync(0);

        expect(statusLine(el).textContent).toMatch(/cancelled/i);
        await vi.advanceTimersByTimeAsync(5000);
        expect(fetchFn.mock.calls.length).toBe(afterCancel);
    });

    it('does not re-arm when the cancel lands while the status BODY is being parsed', async () => {
        // The third cancel window, and the one isCurrent cannot close: the fetch
        // has already resolved 200, so the guard before the 404 branch waved it
        // through while `cancelled` was still false, and the click lands during
        // res.json(). cancelSession leaves `current` pointing at this session by
        // design — that is how the flag works — so isCurrent is still TRUE here.
        let resolveJson: ((v: unknown) => void) | undefined;
        fetchFn
            .mockResolvedValueOnce(qrStartRes())
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: () =>
                    new Promise((resolve) => {
                        resolveJson = resolve;
                    }),
            })
            .mockResolvedValue(jsonRes(200, { ok: true }));

        const el = mount();
        await startQr(el);
        await vi.advanceTimersByTimeAsync(1000); // the poll fires; the BODY hangs

        el.querySelector<HTMLButtonElement>('[data-pair-cancel]')!.click();
        await vi.advanceTimersByTimeAsync(0);
        const afterCancel = fetchFn.mock.calls.length;

        resolveJson!({ state: 'awaiting-scan' });
        await vi.advanceTimersByTimeAsync(0);

        expect(statusLine(el).textContent).toMatch(/cancelled/i);
        await vi.advanceTimersByTimeAsync(5000);
        expect(statusLine(el).textContent).toMatch(/cancelled/i);
        expect(fetchFn.mock.calls.length).toBe(afterCancel);
    });

    it('does not paint an error when the cancel lands while a FAILING status body is being parsed', async () => {
        // Same window on the !res.ok branch: serverError reads the body too, so
        // that await is a cancel window of its own.
        let resolveJson: ((v: unknown) => void) | undefined;
        fetchFn
            .mockResolvedValueOnce(qrStartRes())
            .mockResolvedValueOnce({
                ok: false,
                status: 500,
                json: () =>
                    new Promise((resolve) => {
                        resolveJson = resolve;
                    }),
            })
            .mockResolvedValue(jsonRes(200, { ok: true }));

        const el = mount();
        await startQr(el);
        await vi.advanceTimersByTimeAsync(1000);

        el.querySelector<HTMLButtonElement>('[data-pair-cancel]')!.click();
        await vi.advanceTimersByTimeAsync(0);

        resolveJson!({ error: 'internal error' });
        await vi.advanceTimersByTimeAsync(0);

        expect(statusLine(el).textContent).toMatch(/cancelled/i);
        expect(statusLine(el).classList.contains('error')).toBe(false);
        expect(actionButton(el).hidden).toBe(true);
    });

    it('does not overwrite the cancelled line when an in-flight poll ERRORS after a cancel', async () => {
        let rejectStatus: ((e: unknown) => void) | undefined;
        fetchFn
            .mockResolvedValueOnce(qrStartRes())
            .mockImplementationOnce(
                () =>
                    new Promise((_resolve, reject) => {
                        rejectStatus = reject;
                    }),
            )
            .mockResolvedValueOnce(jsonRes(200, { ok: true })) // the cancel POST
            // Anything the loop issues after that keeps failing, so an unguarded
            // catch runs its retries out and reaches the red "Lost contact…".
            .mockRejectedValue(new Error('network down'));

        const el = mount();
        await startQr(el);
        await vi.advanceTimersByTimeAsync(1000);

        el.querySelector<HTMLButtonElement>('[data-pair-cancel]')!.click();
        await vi.advanceTimersByTimeAsync(0);
        const afterCancel = fetchFn.mock.calls.length;

        rejectStatus!(new Error('network down'));
        await vi.advanceTimersByTimeAsync(0);

        expect(statusLine(el).textContent).toMatch(/cancelled/i);
        expect(statusLine(el).classList.contains('error')).toBe(false);
        expect(actionButton(el).hidden).toBe(true);

        // And it stays that way. Asserted after the retry window, because the
        // failure-tolerance means a single unguarded error only re-arms — the red
        // "Lost contact…" arrives on the third one, several seconds later.
        await vi.advanceTimersByTimeAsync(5000);
        expect(statusLine(el).textContent).toMatch(/cancelled/i);
        expect(statusLine(el).classList.contains('error')).toBe(false);
        expect(fetchFn.mock.calls.length).toBe(afterCancel);
    });

    it('recovers when a status 200 turns out not to be JSON', async () => {
        // A proxy's HTML error page, a truncated body: res.json() REJECTS. Left
        // unguarded inside `void poll()` that is an unhandled rejection with no
        // message and no re-arm — the panel sits on "Scan this code…" forever.
        fetchFn.mockResolvedValueOnce(qrStartRes()).mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => {
                throw new SyntaxError('Unexpected token < in JSON');
            },
        });
        const el = mount();
        await startQr(el);
        await vi.advanceTimersByTimeAsync(1000);

        expect(statusLine(el).textContent).not.toMatch(/scan this code/i);
        expect(statusLine(el).classList.contains('error')).toBe(true);
        expect(actionButton(el).hidden).toBe(false);
        expect(actionButton(el).textContent).toMatch(/start again/i);
    });

    it('recovers when the QR start 200 turns out not to be JSON', async () => {
        fetchFn.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => {
                throw new SyntaxError('Unexpected token < in JSON');
            },
        });
        const el = mount();
        await startQr(el);

        expect(statusLine(el).classList.contains('error')).toBe(true);
        expect(statusLine(el).textContent).not.toMatch(/requesting/i);
        expect(el.querySelector('svg')).toBeNull();
    });

    it('recovers when the code-mode start 200 turns out not to be JSON', async () => {
        fetchFn.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => {
                throw new SyntaxError('Unexpected token < in JSON');
            },
        });
        const el = mount();
        el.querySelector<HTMLButtonElement>('[data-pair-mode="code"]')!.click();
        const address = el.querySelector<HTMLInputElement>('[data-pair-address]')!;
        const code = el.querySelector<HTMLInputElement>('[data-pair-code]')!;
        address.value = '192.168.86.190:41415';
        code.value = '987530';
        code.dispatchEvent(new Event('input'));
        el.querySelector<HTMLButtonElement>('[data-pair-submit]')!.click();
        await vi.advanceTimersByTimeAsync(0);

        expect(statusLine(el).classList.contains('error')).toBe(true);
        // The form has to stay usable rather than stranding the typed address.
        expect(el.querySelector<HTMLButtonElement>('[data-pair-submit]')!.disabled).toBe(false);
    });

    it('rides out a couple of dropped polls instead of abandoning a live session', async () => {
        // Giving up on the first transport failure tells the user to start again
        // while the server may be mid-`adb pair` — nudging them into exactly the
        // re-pair that treating partial success carefully exists to prevent.
        fetchFn
            .mockResolvedValueOnce(qrStartRes())
            .mockRejectedValueOnce(new Error('offline'))
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValue(jsonRes(200, { state: 'paired' }));

        const el = mount();
        await startQr(el);
        await vi.advanceTimersByTimeAsync(1000); // failure 1
        expect(statusLine(el).classList.contains('error')).toBe(false);
        await vi.advanceTimersByTimeAsync(1000); // failure 2
        expect(statusLine(el).classList.contains('error')).toBe(false);
        await vi.advanceTimersByTimeAsync(1000); // recovers

        expect(statusLine(el).textContent).toMatch(/paired/i);
        expect(statusLine(el).classList.contains('error')).toBe(false);
    });

    it('gives up after three consecutive dropped polls', async () => {
        fetchFn.mockResolvedValueOnce(qrStartRes()).mockRejectedValue(new Error('offline'));
        const el = mount();
        await startQr(el);
        await vi.advanceTimersByTimeAsync(3000);

        expect(statusLine(el).textContent).toMatch(/lost contact/i);
        expect(statusLine(el).classList.contains('error')).toBe(true);
        const afterGivingUp = fetchFn.mock.calls.length;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(fetchFn.mock.calls.length).toBe(afterGivingUp);
    });

    it('keeps the validity note on screen after the first poll', async () => {
        fetchFn.mockResolvedValueOnce(qrStartRes()).mockResolvedValue(jsonRes(200, { state: 'awaiting-scan' }));
        const el = mount();
        await startQr(el);
        expect(statusLine(el).textContent).toMatch(/stops working in about 3 minutes/i);

        await vi.advanceTimersByTimeAsync(1000);
        // The line is rewritten whole on every poll, so a note appended only at
        // start-up would have vanished by now.
        expect(statusLine(el).textContent).toMatch(/stops working in about 3 minutes/i);
    });

    it('warns that the device row lags the paired message', async () => {
        // The server discovers device-set changes by polling adb every 5 s, so an
        // empty list right after "Paired" is expected, not a failure.
        expect(pairingStatusText({ state: 'paired' }).text).toMatch(/within a few seconds/i);
    });

    it('renders a genuine failure in the error style', async () => {
        fetchFn
            .mockResolvedValueOnce(qrStartRes())
            .mockResolvedValue(jsonRes(200, { state: 'failed', message: 'pairing refused' }));
        const el = mount();
        await startQr(el);
        await vi.advanceTimersByTimeAsync(1000);

        expect(statusLine(el).textContent).toMatch(/refused/);
        expect(statusLine(el).classList.contains('error')).toBe(true);
    });

    it('discards the start response of a session the user has already replaced', async () => {
        // Two Start clicks in a row. The first request is still in flight when
        // the second lands, and its answer must not paint over the live session.
        let resolveFirst: ((v: unknown) => void) | undefined;
        fetchFn
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveFirst = resolve;
                    }),
            )
            .mockResolvedValueOnce(
                jsonRes(200, { sessionId: 's2', svg: '<svg id="second"></svg>', expiresAt: Date.now() + 180_000 }),
            )
            .mockResolvedValue(jsonRes(200, { state: 'awaiting-scan' }));

        const el = mount();
        el.querySelector<HTMLButtonElement>('[data-pair-mode="qr"]')!.click();
        await vi.advanceTimersByTimeAsync(0);
        el.querySelector<HTMLButtonElement>('[data-pair-mode="qr"]')!.click();
        await vi.advanceTimersByTimeAsync(0);

        resolveFirst!(
            jsonRes(200, { sessionId: 's1', svg: '<svg id="first"></svg>', expiresAt: Date.now() + 180_000 }),
        );
        await vi.advanceTimersByTimeAsync(0);

        expect(el.querySelector('svg')!.id).toBe('second');
        await vi.advanceTimersByTimeAsync(1000);
        expect(fetchFn.mock.calls.at(-1)?.[0]).toBe('/api/devices/pair/status?sessionId=s2');
    });

    // `startQr` checks the generation twice, once either side of parsing the
    // body, and the two shadow each other: remove either alone and the test
    // above still passes because the other catches it. These two isolate them by
    // landing the second click in the gap only one of them covers.

    it('discards a REJECTED start belonging to a session the user has replaced', async () => {
        // Only the guard BEFORE the body read covers this: the !res.ok branch
        // writes to the status line before the second guard is ever reached, so
        // a stale 403 would paint over the live session's copy.
        let resolveFirst: ((v: unknown) => void) | undefined;
        fetchFn
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveFirst = resolve;
                    }),
            )
            .mockResolvedValueOnce(
                jsonRes(200, { sessionId: 's2', svg: '<svg id="second"></svg>', expiresAt: Date.now() + 180_000 }),
            )
            .mockResolvedValue(jsonRes(200, { state: 'awaiting-scan' }));

        const el = mount();
        el.querySelector<HTMLButtonElement>('[data-pair-mode="qr"]')!.click();
        await vi.advanceTimersByTimeAsync(0);
        el.querySelector<HTMLButtonElement>('[data-pair-mode="qr"]')!.click();
        await vi.advanceTimersByTimeAsync(0);

        resolveFirst!(jsonRes(403, { error: 'forbidden' }));
        await vi.advanceTimersByTimeAsync(0);

        expect(statusLine(el).textContent).toMatch(/scan this code/i);
        expect(statusLine(el).textContent).not.toMatch(/admin/i);
        expect(statusLine(el).classList.contains('error')).toBe(false);
    });

    it('discards a start body that finishes parsing after the session was replaced', async () => {
        // Only the guard AFTER the body read covers this: the response itself
        // arrived before the replacement, and it is the parse that lands late.
        let resolveJson: ((v: unknown) => void) | undefined;
        fetchFn
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: () =>
                    new Promise((resolve) => {
                        resolveJson = resolve;
                    }),
            })
            .mockResolvedValueOnce(
                jsonRes(200, { sessionId: 's2', svg: '<svg id="second"></svg>', expiresAt: Date.now() + 180_000 }),
            )
            .mockResolvedValue(jsonRes(200, { state: 'awaiting-scan' }));

        const el = mount();
        el.querySelector<HTMLButtonElement>('[data-pair-mode="qr"]')!.click();
        await vi.advanceTimersByTimeAsync(0);
        el.querySelector<HTMLButtonElement>('[data-pair-mode="qr"]')!.click();
        await vi.advanceTimersByTimeAsync(0);

        resolveJson!({ sessionId: 's1', svg: '<svg id="first"></svg>', expiresAt: Date.now() + 180_000 });
        await vi.advanceTimersByTimeAsync(0);

        expect(el.querySelector('svg')!.id).toBe('second');
        await vi.advanceTimersByTimeAsync(1000);
        expect(fetchFn.mock.calls.at(-1)?.[0]).toBe('/api/devices/pair/status?sessionId=s2');
    });

    it('tells the server to drop the session when the user cancels', async () => {
        fetchFn.mockResolvedValueOnce(qrStartRes()).mockResolvedValue(jsonRes(200, { ok: true }));
        const el = mount();
        await startQr(el);

        el.querySelector<HTMLButtonElement>('[data-pair-cancel]')!.click();
        await vi.advanceTimersByTimeAsync(0);

        const cancelCall = fetchFn.mock.calls.find((c) => c[0] === '/api/devices/pair/cancel');
        expect(cancelCall).toBeDefined();
        const body = JSON.parse(String((cancelCall![1] as RequestInit).body)) as Record<string, unknown>;
        expect(body['sessionId']).toBe('s1');
    });

    it('reports a 404 the user did NOT cause as a real problem', async () => {
        fetchFn
            .mockResolvedValueOnce(qrStartRes())
            .mockResolvedValue(jsonRes(404, { error: 'no such pairing session' }));
        const el = mount();
        await startQr(el);
        await vi.advanceTimersByTimeAsync(1000);

        expect(statusLine(el).classList.contains('error')).toBe(true);
        expect(actionButton(el).hidden).toBe(false);
    });

    it('explains a 403 as an admin restriction rather than a generic failure', async () => {
        fetchFn.mockResolvedValue(jsonRes(403, { error: 'forbidden' }));
        const el = mount();
        await startQr(el);

        expect(statusLine(el).textContent).toMatch(/admin/i);
        expect(el.querySelector('svg')).toBeNull();
    });

    it('requires both address and code before enabling the code-mode submit', async () => {
        const el = renderPairingSection({ fetchFn: fetchFn as never });
        el.querySelector<HTMLButtonElement>('[data-pair-mode="code"]')!.click();
        const submit = el.querySelector<HTMLButtonElement>('[data-pair-submit]')!;
        expect(submit.disabled).toBe(true);
        el.querySelector<HTMLInputElement>('[data-pair-address]')!.value = '192.168.86.190:41415';
        el.querySelector<HTMLInputElement>('[data-pair-code]')!.value = '987530';
        el.querySelector<HTMLInputElement>('[data-pair-code]')!.dispatchEvent(new Event('input'));
        expect(submit.disabled).toBe(false);
    });

    it('starts a code session and clears the single-use code from the screen', async () => {
        fetchFn
            .mockResolvedValueOnce(jsonRes(200, { sessionId: 'c1' }))
            .mockResolvedValue(jsonRes(200, { state: 'pairing' }));
        const el = mount();
        el.querySelector<HTMLButtonElement>('[data-pair-mode="code"]')!.click();
        const address = el.querySelector<HTMLInputElement>('[data-pair-address]')!;
        const code = el.querySelector<HTMLInputElement>('[data-pair-code]')!;
        address.value = '192.168.86.190:41415';
        code.value = '987530';
        code.dispatchEvent(new Event('input'));
        el.querySelector<HTMLButtonElement>('[data-pair-submit]')!.click();
        await vi.advanceTimersByTimeAsync(0);

        const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/api/devices/pair/code');
        expect(JSON.parse(String(init.body))).toEqual({ address: '192.168.86.190:41415', code: '987530' });
        expect(code.value).toBe('');

        await vi.advanceTimersByTimeAsync(1000);
        expect(fetchFn.mock.calls[1]?.[0]).toBe('/api/devices/pair/status?sessionId=c1');
    });

    it("surfaces the server's 400 wording instead of a generic failure", async () => {
        fetchFn.mockResolvedValue(jsonRes(400, { error: 'address must be IP:port, as shown on the phone' }));
        const el = mount();
        el.querySelector<HTMLButtonElement>('[data-pair-mode="code"]')!.click();
        const address = el.querySelector<HTMLInputElement>('[data-pair-address]')!;
        const code = el.querySelector<HTMLInputElement>('[data-pair-code]')!;
        address.value = 'not-an-address';
        code.value = '987530';
        code.dispatchEvent(new Event('input'));
        el.querySelector<HTMLButtonElement>('[data-pair-submit]')!.click();
        await vi.advanceTimersByTimeAsync(0);

        expect(statusLine(el).textContent).toMatch(/IP:port/);
        // Still usable: the user has to be able to correct the address.
        expect(el.querySelector<HTMLButtonElement>('[data-pair-submit]')!.disabled).toBe(false);
    });

    it('calls onPaired once the session is paired', async () => {
        const onPaired = vi.fn();
        fetchFn
            .mockResolvedValueOnce(qrStartRes())
            .mockResolvedValue(jsonRes(200, { state: 'paired', serial: 'abc123', address: '10.0.0.5:5555' }));
        const el = mount({ onPaired });
        await startQr(el);
        await vi.advanceTimersByTimeAsync(1000);

        expect(onPaired).toHaveBeenCalledTimes(1);
        const arg = onPaired.mock.calls[0]?.[0] as PairingStatus;
        expect(arg.serial).toBe('abc123');
        // The spent QR is taken down once the session is over.
        expect(el.querySelector('svg')).toBeNull();
    });
});
