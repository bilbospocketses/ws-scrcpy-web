// @vitest-environment jsdom

/**
 * Smoke row 1.11 (c), found by qa-harness planning: the first-run welcome
 * modal's "yes, install service" path could not survive the service hand-off.
 *
 * The local server answers the install POST and exits ~1.5 s later; the service
 * then serves the same origin with a NEW per-process token. The modal's own poll
 * read the first dead-window tick (a thrown fetch) as fatal — "lost connection
 * during handoff" — and read the service's stale-token 403 as "not ready yet"
 * until it timed out. Settings → Service has handled both since D4 (beta.141);
 * these tests hold the welcome modal to the same hand-off.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WelcomeModal } from '../WelcomeModal';

/** Drain pending microtasks without touching the (fake) timer queues. */
const drainMicrotasks = async (rounds = 12): Promise<void> => {
    for (let i = 0; i < rounds; i++) {
        await Promise.resolve();
        await new Promise<void>((r) => queueMicrotask(r));
    }
};

const jsonResponse = (body: unknown, status = 200): Response =>
    ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }) as unknown as Response;

/** What the page's own server says before the install: Linux, supported, nothing installed. */
const linuxNotInstalled = { supported: true, platform: 'linux', status: 'not-installed' };

/** The local server's install answer just before it exits (ServiceApi, Linux user scope). */
const installShuttingDown = { ok: true, status: 'shutting-down', configMtime: 100, diskWebPort: 8000 };

/** The token gate's refusal once a new process (the service) holds this origin. */
const staleTokenRefusal = jsonResponse({ error: 'forbidden', reason: 'missing or invalid token' }, 403);

type PollStep = Response | 'throw';

/**
 * fetch by URL: the pre-install probes get `linuxNotInstalled`; each poll tick
 * after the install POST consumes the next step (the last one repeats).
 */
function stubFetch(pollSteps: PollStep[]): ReturnType<typeof vi.fn> {
    let installed = false;
    let tick = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit): Promise<Response> => {
        if (url === '/api/service/install' && init?.method === 'POST') {
            installed = true;
            return Promise.resolve(jsonResponse(installShuttingDown));
        }
        if (url === '/api/service/status') {
            if (!installed) return Promise.resolve(jsonResponse(linuxNotInstalled));
            const step = pollSteps[Math.min(tick, pollSteps.length - 1)] as PollStep;
            tick++;
            if (step === 'throw') return Promise.reject(new TypeError('Failed to fetch'));
            return Promise.resolve(step);
        }
        return Promise.resolve(jsonResponse(null, 500));
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

let reloadMock: ReturnType<typeof vi.fn>;
let locationStub: { href: string; port: string; reload: ReturnType<typeof vi.fn> };

beforeEach(() => {
    document.body.replaceChildren();
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute('open');
    });
    reloadMock = vi.fn();
    locationStub = { href: 'http://192.168.1.20:8000/', port: '8000', reload: reloadMock };
    vi.stubGlobal('location', locationStub);
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

/** Build the modal, click "yes, install service", and let the install POST settle. */
async function clickInstall(): Promise<HTMLElement> {
    const modal = new WelcomeModal({ webPort: 8000, portWasAutoShifted: false, onDecision: () => {} });
    await drainMicrotasks();
    const yes = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
        (b) => b.textContent === 'yes, install service',
    );
    expect(yes, 'install button not rendered').toBeTruthy();
    yes!.click();
    await drainMicrotasks(20);
    return (modal as unknown as { statusEl: HTMLElement }).statusEl;
}

/** Advance one poll interval and let that tick's fetch chain settle. */
async function pollTick(): Promise<void> {
    await vi.advanceTimersByTimeAsync(2000);
    await drainMicrotasks();
}

describe('WelcomeModal install survives the service hand-off (smoke 1.11 c)', () => {
    it('a thrown first tick (the dead window after the local exit) is not fatal; the service answering reloads', async () => {
        stubFetch([
            'throw',
            jsonResponse({ servedByService: true, status: 'running', configMtime: 100, diskWebPort: 8000 }),
        ]);
        const status = await clickInstall();

        await pollTick(); // dead window: nothing holds the port
        expect(status.textContent).not.toMatch(/lost connection/i);

        await pollTick(); // the service answers on the same origin
        expect(status.textContent).toBe('service mode active. switching you over…');
        expect(reloadMock, 'reload waits out the grace').not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2500);
        expect(reloadMock).toHaveBeenCalledOnce();
    });

    it("the service's stale-token 403 means a new process holds this origin: reload for its token", async () => {
        stubFetch([staleTokenRefusal]);
        const status = await clickInstall();

        await pollTick();
        await vi.advanceTimersByTimeAsync(2500);
        expect(reloadMock).toHaveBeenCalledOnce();
        expect(status.textContent).toBe('service mode active. switching you over…');
    });

    it('a thrown tick followed by the stale-token 403 also reloads', async () => {
        stubFetch(['throw', 'throw', staleTokenRefusal]);
        await clickInstall();

        await pollTick();
        await pollTick();
        await pollTick();
        await vi.advanceTimersByTimeAsync(2500);
        expect(reloadMock).toHaveBeenCalledOnce();
    });

    it('a port shift reported once the service runs navigates to the same host on the new port', async () => {
        // Windows: the exiting local instance still answers, reports the SERVICE
        // as running, and config.json now names the port the service bound.
        stubFetch([jsonResponse({ servedByService: false, status: 'running', configMtime: 200, diskWebPort: 8001 })]);
        const status = await clickInstall();

        await pollTick();
        expect(status.textContent).toBe('service mode active. switching you over…');
        await vi.advanceTimersByTimeAsync(1000);
        expect(locationStub.href).toBe('http://192.168.1.20:8001/');
        expect(reloadMock).not.toHaveBeenCalled();
    });

    it('a local server that never hands off times out with the Settings → Service wording', async () => {
        stubFetch([
            jsonResponse({ servedByService: false, status: 'not-installed', configMtime: 100, diskWebPort: 8000 }),
        ]);
        const status = await clickInstall();

        for (let i = 0; i < 31; i++) await pollTick();
        expect(status.textContent).toBe(
            'service is running but port discovery timed out. reload the page at your usual address.',
        );
        expect(reloadMock).not.toHaveBeenCalled();
        const yes = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
            (b) => b.textContent === 'yes, install service',
        );
        expect(yes?.disabled).toBe(false);
    });
});
