// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkDiscoveryPanel } from '../NetworkDiscoveryPanel';

// ---------------------------------------------------------------------------
// The manual-add port default, and the one path where it is wrong.
//
// `5555` is the right default for the legacy `_adb._tcp` devices the
// manual-add button exists for. It is ALWAYS wrong for a device that paired
// over TLS: that device's connect port is an ephemeral the user has to read
// off the phone, and 5555 is the one port it is known not to listen on.
//
// The panel builds its own DOM and its constructor only wires listeners, so it
// can be stood up here. The two entry points are separate methods, which is
// what makes the distinction cleanly expressible — the private ones are
// reached by cast, as the server tests reach their own internals.
// ---------------------------------------------------------------------------

interface Innards {
    openManualFormForPairing: () => void;
    toggleManualForm: (show?: boolean) => void;
    manualConnect: () => Promise<void>;
}

function innards(panel: NetworkDiscoveryPanel): Innards {
    return panel as unknown as Innards;
}

function input(panel: NetworkDiscoveryPanel, cls: string): HTMLInputElement {
    return panel.getElement().querySelector<HTMLInputElement>(`.${cls}`)!;
}

function manualResult(panel: NetworkDiscoveryPanel): HTMLElement {
    return panel.getElement().querySelector<HTMLElement>('.discovery-manual-result')!;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true, message: 'connected' }),
    });
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('manual-add port default', () => {
    it('opens EMPTY from the pairing flow, port included', () => {
        const panel = new NetworkDiscoveryPanel();
        innards(panel).openManualFormForPairing();

        expect(panel.getElement().querySelector('.discovery-manual-form')!.hasAttribute('hidden')).toBe(false);
        // Not pre-filled — there is no address to fill from on this branch — and
        // not left at a default that is known to be wrong.
        expect(input(panel, 'discovery-manual-address').value).toBe('');
        expect(input(panel, 'discovery-manual-port').value).toBe('');
    });

    it('keeps the 5555 default for the ordinary manually-add button', () => {
        // The legacy path this default exists for is untouched. Scoping the
        // change to the pairing entry point is the whole point.
        const panel = new NetworkDiscoveryPanel();
        innards(panel).toggleManualForm(true);
        expect(input(panel, 'discovery-manual-port').value).toBe('5555');
    });

    it('refuses to submit a blank port from the pairing flow instead of quietly using 5555', async () => {
        // Clearing the field is only half the fix: `manualConnect` defaulted an
        // empty port to 5555, so a user who read the instruction as "leave it
        // alone" would have submitted a value they never typed and could not
        // see, and got back a failure that looks like an unreachable device.
        const panel = new NetworkDiscoveryPanel();
        innards(panel).openManualFormForPairing();
        input(panel, 'discovery-manual-address').value = '192.168.86.190';

        await innards(panel).manualConnect();

        expect(manualResult(panel).textContent).toMatch(/port is required/i);
        expect(manualResult(panel).classList.contains('error')).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('still defaults a blank port to 5555 on the ordinary path', async () => {
        const panel = new NetworkDiscoveryPanel();
        innards(panel).toggleManualForm(true);
        input(panel, 'discovery-manual-address').value = '192.168.86.50';
        input(panel, 'discovery-manual-port').value = '';

        await innards(panel).manualConnect();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)) as Record<string, unknown>;
        expect(body['address']).toBe('192.168.86.50:5555');
    });

    it('submits the port the user typed on the pairing path', async () => {
        const panel = new NetworkDiscoveryPanel();
        innards(panel).openManualFormForPairing();
        input(panel, 'discovery-manual-address').value = '192.168.86.190';
        input(panel, 'discovery-manual-port').value = '43777';

        await innards(panel).manualConnect();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)) as Record<string, unknown>;
        expect(body['address']).toBe('192.168.86.190:43777');
    });

    it('forgets the pairing-flow requirement once the form is closed', async () => {
        // The flag lives on the panel, not the form, so a stale `true` would
        // make the ordinary manual-add path start refusing a blank port.
        //
        // Asserting the port VALUE alone is not enough to show that: the value
        // is reset by `clearManualForm` whether or not the flag went with it,
        // so a mutation that never reset the flag passed. The flag is only
        // observable through a submit, so this submits.
        const panel = new NetworkDiscoveryPanel();
        innards(panel).openManualFormForPairing();
        innards(panel).toggleManualForm(false); // closing resets the form
        innards(panel).toggleManualForm(true); // ordinary reopen

        expect(input(panel, 'discovery-manual-port').value).toBe('5555');

        input(panel, 'discovery-manual-address').value = '192.168.86.50';
        input(panel, 'discovery-manual-port').value = '';
        await innards(panel).manualConnect();

        expect(manualResult(panel).textContent ?? '').not.toMatch(/port is required/i);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)) as Record<string, unknown>;
        expect(body['address']).toBe('192.168.86.50:5555');
    });
});

describe('the pairing flow actually reaches the cleared-port form', () => {
    // The tests above call `openManualFormForPairing` directly, which proves
    // what it does and nothing about whether anything CALLS it. A mutation
    // pointing `onConnectByHand` back at the plain `toggleManualForm(true)`
    // survived all of them. This drives the real wiring: the panel's own
    // pairing section, its own `fetch`, its own button.
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('opens the form with an empty port after an addressless paired-not-connected', async () => {
        const panel = new NetworkDiscoveryPanel();
        document.body.appendChild(panel.getElement());
        fetchMock
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    sessionId: 's1',
                    svg: '<svg viewBox="0 0 41 41"></svg>',
                    expiresInMs: 180_000,
                }),
            })
            .mockResolvedValue({
                ok: true,
                status: 200,
                // No `address`: the branch that opens the manual form at all.
                json: async () => ({
                    state: 'paired-not-connected',
                    message: 'no connect service was advertised for this device',
                }),
            });

        panel.getElement().querySelector<HTMLButtonElement>('[data-pair-mode="qr"]')!.click();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(1000); // first status poll

        const action = panel.getElement().querySelector<HTMLButtonElement>('[data-pair-action]')!;
        expect(action.hidden).toBe(false);
        expect(action.textContent).toMatch(/add it manually/i);
        action.click();
        await vi.advanceTimersByTimeAsync(0);

        expect(panel.getElement().querySelector('.discovery-manual-form')!.hasAttribute('hidden')).toBe(false);
        expect(input(panel, 'discovery-manual-port').value).toBe('');
        expect(input(panel, 'discovery-manual-address').value).toBe('');
    });
});
