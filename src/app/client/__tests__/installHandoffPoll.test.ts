import { describe, expect, it, vi } from 'vitest';
import {
    INSTALL_HANDOFF_MAX_ITERATIONS,
    INSTALL_HANDOFF_POLL_INTERVAL_MS,
    type InstallHandoffPollOptions,
    startInstallHandoffPoll,
} from '../installHandoffPoll';

/**
 * The install hand-off poll shared by Settings → Service and the welcome modal
 * (smoke 1.11 c). Driven through its seams: a scripted fetch, a timer whose
 * ticks the test fires by hand, and a fake location — no DOM, no real timers.
 */

const jsonResponse = (body: unknown, status = 200): Response =>
    ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }) as unknown as Response;

const staleTokenRefusal = (): Response => jsonResponse({ error: 'forbidden', reason: 'missing or invalid token' }, 403);

type Step = (() => Response) | 'throw';

/** The exiting local instance: the service is not up yet, nothing has moved. */
const localAnswering = (): Response =>
    jsonResponse({ servedByService: false, status: 'not-installed', configMtime: 100, diskWebPort: 8000 });

function harness(steps: Step[], overrides: Partial<InstallHandoffPollOptions> = {}) {
    let tickFn: (() => void) | null = null;
    let intervalMs: number | null = null;
    const clearInterval = vi.fn();
    let call = 0;
    const fetchMock = vi.fn((_url: string, _init?: RequestInit): Promise<Response> => {
        const step = steps[Math.min(call, steps.length - 1)] as Step;
        call++;
        if (step === 'throw') return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve(step());
    });
    const onNavigate = vi.fn();
    const onReconnect = vi.fn();
    const onTimeout = vi.fn();
    const onTick = vi.fn();
    const poll = startInstallHandoffPoll({
        baselineMtime: 100,
        onNavigate,
        onReconnect,
        onTimeout,
        onTick,
        deps: {
            fetch: fetchMock,
            setInterval: (fn, ms) => {
                tickFn = fn;
                intervalMs = ms;
                return 'handle';
            },
            clearInterval,
            location: { href: 'http://192.168.1.20:8000/some/page?q=1', port: '8000' },
        },
        ...overrides,
    });
    /** Fire one interval tick and let its fetch chain settle. */
    const tick = async (): Promise<void> => {
        tickFn?.();
        for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    return {
        poll,
        tick,
        fetchMock,
        clearInterval,
        onNavigate,
        onReconnect,
        onTimeout,
        onTick,
        get intervalMs() {
            return intervalMs;
        },
    };
}

describe('startInstallHandoffPoll', () => {
    it('polls GET /api/service/status every 2 s with a per-request timeout signal', async () => {
        const h = harness([localAnswering]);
        expect(h.intervalMs).toBe(INSTALL_HANDOFF_POLL_INTERVAL_MS);
        expect(INSTALL_HANDOFF_POLL_INTERVAL_MS).toBe(2000);
        await h.tick();
        const [url, init] = h.fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/api/service/status');
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('a single thrown fetch (the hand-off dead window) is NOT fatal', async () => {
        const h = harness(['throw', localAnswering]);
        await h.tick();
        expect(h.onNavigate).not.toHaveBeenCalled();
        expect(h.onReconnect).not.toHaveBeenCalled();
        expect(h.onTimeout).not.toHaveBeenCalled();
        expect(h.clearInterval).not.toHaveBeenCalled();
        expect(h.onTick).toHaveBeenLastCalledWith(
            expect.objectContaining({ reachable: false, outcome: { kind: 'keep-polling' } }),
        );
        await h.tick();
        expect(h.fetchMock).toHaveBeenCalledTimes(2);
    });

    it('dead window, then the service answers on a new port: navigate to the same host on that port', async () => {
        const h = harness([
            'throw',
            () => jsonResponse({ servedByService: true, status: 'running', configMtime: 200, diskWebPort: 8001 }),
        ]);
        await h.tick();
        await h.tick();
        expect(h.onNavigate).toHaveBeenCalledOnce();
        expect(h.onNavigate).toHaveBeenCalledWith('http://192.168.1.20:8001/', 8001);
        expect(h.clearInterval).toHaveBeenCalledWith('handle');
    });

    it('dead window, then the service answers on the same port: reconnect', async () => {
        const h = harness([
            'throw',
            () => jsonResponse({ servedByService: true, status: 'running', configMtime: 100, diskWebPort: 8000 }),
        ]);
        await h.tick();
        await h.tick();
        expect(h.onReconnect).toHaveBeenCalledOnce();
        expect(h.onNavigate).not.toHaveBeenCalled();
    });

    it("the service's stale-token 403 means a new process holds this origin: reconnect", async () => {
        const h = harness([localAnswering, 'throw', staleTokenRefusal]);
        await h.tick();
        await h.tick();
        expect(h.onReconnect).not.toHaveBeenCalled();
        await h.tick();
        expect(h.onReconnect).toHaveBeenCalledOnce();
        expect(h.clearInterval).toHaveBeenCalledWith('handle');
    });

    it('any other 403 (not the stale-token refusal) is not a hand-off', async () => {
        const h = harness([() => jsonResponse({ error: 'forbidden' }, 403)]);
        await h.tick();
        expect(h.onReconnect).not.toHaveBeenCalled();
        expect(h.onTick).toHaveBeenLastCalledWith(
            expect.objectContaining({ tokenRejected: false, outcome: { kind: 'keep-polling' } }),
        );
    });

    it('the exiting local instance reports the service running on a shifted port: navigate there', async () => {
        // Windows: the service could not bind 8000 while the local instance held it.
        const h = harness([
            () => jsonResponse({ servedByService: false, status: 'running', configMtime: 200, diskWebPort: 8001 }),
        ]);
        await h.tick();
        expect(h.onNavigate).toHaveBeenCalledWith('http://192.168.1.20:8001/', 8001);
    });

    it('remembers the shifted disk port across the dead window (sticky state)', async () => {
        const h = harness([
            // The local instance has seen config.json move but the service is not running yet.
            () => jsonResponse({ servedByService: false, status: 'stopped', configMtime: 200, diskWebPort: 8001 }),
            'throw',
            // An answer that names no port but says the service runs.
            () => jsonResponse({ servedByService: false, status: 'running' }),
        ]);
        await h.tick();
        await h.tick();
        expect(h.onNavigate).not.toHaveBeenCalled();
        await h.tick();
        expect(h.onNavigate).toHaveBeenCalledWith('http://192.168.1.20:8001/', 8001);
    });

    it('a local server that keeps answering keeps polling, then times out after the cap', async () => {
        const h = harness([localAnswering]);
        for (let i = 0; i < INSTALL_HANDOFF_MAX_ITERATIONS; i++) await h.tick();
        expect(h.onTimeout).not.toHaveBeenCalled();
        expect(h.clearInterval).not.toHaveBeenCalled();
        await h.tick();
        expect(h.onTimeout).toHaveBeenCalledOnce();
        expect(h.clearInterval).toHaveBeenCalledWith('handle');
        expect(h.fetchMock).toHaveBeenCalledTimes(INSTALL_HANDOFF_MAX_ITERATIONS + 1);
        expect(h.onNavigate).not.toHaveBeenCalled();
        expect(h.onReconnect).not.toHaveBeenCalled();
    });

    it('only one outcome fires even when a slow tick resolves after the poll has ended', async () => {
        let releaseSlow: (r: Response) => void = () => {};
        const slow = new Promise<Response>((resolve) => {
            releaseSlow = resolve;
        });
        let tickFn: (() => void) | null = null;
        let call = 0;
        const onReconnect = vi.fn();
        startInstallHandoffPoll({
            baselineMtime: 100,
            onNavigate: vi.fn(),
            onReconnect,
            onTimeout: vi.fn(),
            deps: {
                fetch: () => (call++ === 0 ? slow : Promise.resolve(staleTokenRefusal())),
                setInterval: (fn) => {
                    tickFn = fn;
                    return 1;
                },
                clearInterval: vi.fn(),
                location: { href: 'http://localhost:8000/', port: '8000' },
            },
        });
        tickFn!(); // tick 1: in flight
        tickFn!(); // tick 2: stale token -> reconnect
        for (let i = 0; i < 10; i++) await Promise.resolve();
        expect(onReconnect).toHaveBeenCalledOnce();
        releaseSlow(staleTokenRefusal()); // tick 1 lands late
        for (let i = 0; i < 10; i++) await Promise.resolve();
        expect(onReconnect).toHaveBeenCalledOnce();
    });

    it('stop() ends the poll with no callback', async () => {
        const h = harness([staleTokenRefusal]);
        h.poll.stop();
        expect(h.clearInterval).toHaveBeenCalledWith('handle');
        await h.tick();
        expect(h.fetchMock).not.toHaveBeenCalled();
        expect(h.onReconnect).not.toHaveBeenCalled();
    });
});
