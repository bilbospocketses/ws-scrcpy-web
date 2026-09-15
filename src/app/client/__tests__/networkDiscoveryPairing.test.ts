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
        const sent = JSON.stringify(fetchFn.mock.results);
        expect(sent).not.toContain('WIFI:T:ADB');
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
