// @vitest-environment jsdom

/**
 * Smoke row 14.10 sweep: the home-page update chip is the other caller of
 * POST /api/updates/apply. A cancelled polkit prompt on a machine-wide update
 * answers 403 `uac-declined`; the chip used to drop back to "apply update"
 * without a word. It now says privileges were declined, beside the same apply
 * button, until the next status poll repaints it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdatesStatusResponse } from '../../../common/UpdateEvents';
import { createUpdateButton } from '../UpdateButton';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const ready: UpdatesStatusResponse = {
    isInstalled: true,
    currentVersion: '0.1.30',
    status: 'ready',
    availableVersion: '0.2.0',
    autoUpdate: true,
    channel: 'stable',
    githubOwner: 'bilbospocketses',
    updateCheckIntervalMinutes: 60,
};

function stubFetch(apply: { ok: boolean; status: number; body: unknown }): ReturnType<typeof vi.fn> {
    const f = vi.fn((url: string) =>
        url === '/api/updates/apply'
            ? Promise.resolve({ ok: apply.ok, status: apply.status, json: () => Promise.resolve(apply.body) })
            : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(ready) }),
    );
    vi.stubGlobal('fetch', f);
    return f;
}

// The chip's 30 s poll interval must not outlive the test.
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

async function clickApply(): Promise<HTMLElement> {
    const chip = createUpdateButton();
    await flush();
    const btn = chip.querySelector<HTMLButtonElement>('button.update-button-action');
    expect(btn?.textContent).toBe('apply update v0.2.0');
    btn!.click();
    await flush();
    await flush();
    return chip;
}

describe('UpdateButton apply: a declined elevation prompt (smoke 14.10 sweep)', () => {
    it('a 403 uac-declined says privileges were declined and keeps the apply button', async () => {
        stubFetch({
            ok: false,
            status: 403,
            body: {
                ok: false,
                error: 'authentication was dismissed or not authorized. machine-wide-update cancelled.',
                reason: 'uac-declined',
            },
        });
        const chip = await clickApply();

        expect(chip.querySelector('.update-button-label')?.textContent).toBe(
            'Administrative privileges were declined. Try again and approve the prompt.',
        );
        const btn = chip.querySelector<HTMLButtonElement>('button.update-button-action');
        expect(btn?.textContent).toBe('apply update v0.2.0');
        expect(btn?.disabled).toBe(false);
    });

    it('a failed install says why beside the apply button, from the answer itself', async () => {
        // The status carries no reason here, so the line can only come from the 500's body.
        const f = stubFetch({ ok: false, status: 500, body: { ok: false, error: 'update download failed: boom' } });
        const chip = await clickApply();

        expect(chip.querySelector('.update-button-label')?.textContent).toBe(
            'install failed: update download failed: boom — click to retry',
        );
        const btn = chip.querySelector<HTMLButtonElement>('button.update-button-action');
        expect(btn?.textContent).toBe('apply update v0.2.0');
        expect(btn?.disabled).toBe(false);
        // The load and the click's own read; a 500 is not re-read, which could
        // swap the reason for the spinner of the check the server starts.
        expect(f.mock.calls.filter((c) => c[0] === '/api/updates/status').length).toBe(2);
    });

    it('a refusal for another reason (409) re-reads the status at once', async () => {
        const f = stubFetch({
            ok: false,
            status: 409,
            body: { ok: false, error: 'apply not allowed in current state: checking' },
        });
        await clickApply();

        expect(f.mock.calls.filter((c) => c[0] === '/api/updates/status').length).toBe(3);
    });
});

describe('UpdateButton: a failed install the server recorded', () => {
    it('is shown on a page loaded after it, beside the apply button', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() =>
                Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({ ...ready, lastApplyError: 'update download failed: 503' }),
                }),
            ),
        );
        const chip = createUpdateButton();
        await flush();

        expect(chip.querySelector('.update-button-label')?.textContent).toBe(
            'install failed: update download failed: 503 — click to retry',
        );
        expect(chip.querySelector('button.update-button-action')?.textContent).toBe('apply update v0.2.0');
    });
});

/**
 * A scripted server: `status` answers the reads (or they fail once `down`),
 * and the apply request is held until the test answers or drops it.
 */
function scriptedServer() {
    const server = {
        status: ready as UpdatesStatusResponse,
        down: false,
        answerApply: undefined as ((r: unknown) => void) | undefined,
        dropApply: undefined as ((e: unknown) => void) | undefined,
        /** Status reads to hold open until `release` (their answer is read when released). */
        hold: false,
        held: [] as (() => void)[],
    };
    const f = vi.fn((url: string) => {
        if (url === '/api/updates/apply') {
            return new Promise((resolve, reject) => {
                server.answerApply = resolve;
                server.dropApply = reject;
            });
        }
        const answer = (): Promise<unknown> =>
            server.down
                ? Promise.reject(new TypeError('Failed to fetch'))
                : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(server.status) });
        if (server.hold) {
            return new Promise((resolve, reject) => {
                server.held.push(() => {
                    answer().then(resolve, reject);
                });
            });
        }
        return answer();
    });
    vi.stubGlobal('fetch', f);
    return { server, statusReads: (): number => f.mock.calls.filter((c) => c[0] === '/api/updates/status').length };
}

const labelOf = (chip: HTMLElement): string | null | undefined =>
    chip.querySelector('.update-button-label')?.textContent;

/** A proxy's 504: an HTML page, not the app's JSON. */
const gateway504 = {
    ok: false,
    status: 504,
    json: () => Promise.reject(new SyntaxError('Unexpected token <')),
};

describe('UpdateButton: the install runs longer than the request (Windows download first)', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    });

    async function clickApplyOn(): Promise<HTMLElement> {
        const chip = createUpdateButton();
        await vi.advanceTimersByTimeAsync(0);
        chip.querySelector<HTMLButtonElement>('button.update-button-action')!.click();
        return chip;
    }

    it('reads the status as soon as it is clicked and every 2 s, and offers no second click', async () => {
        const { server, statusReads } = scriptedServer();
        const chip = createUpdateButton();
        await vi.advanceTimersByTimeAsync(0);
        const before = statusReads();
        chip.querySelector<HTMLButtonElement>('button.update-button-action')!.click();
        await vi.advanceTimersByTimeAsync(0);
        // At once, not on the next 30 s tick.
        expect(statusReads()).toBe(before + 1);
        // Still `ready` (the server has not started yet): nothing to click.
        expect(labelOf(chip)).toBe('installing update…');
        expect(chip.querySelector('button.update-button-action')).toBeNull();

        server.status = { ...ready, status: 'downloading', progress: 25 };
        await vi.advanceTimersByTimeAsync(2_000);
        expect(statusReads()).toBe(before + 2);
        expect(labelOf(chip)).toBe('downloading update… 25%');
    });

    it('a 504 from a proxy is not a failure: it follows the install, then restarts when the server goes down', async () => {
        const { server, statusReads } = scriptedServer();
        const chip = await clickApplyOn();
        server.status = { ...ready, status: 'downloading', progress: 40 };
        await vi.advanceTimersByTimeAsync(0);

        server.answerApply!(gateway504);
        await vi.advanceTimersByTimeAsync(0);
        expect(labelOf(chip)).toBe('downloading update… 40%');

        // Downloaded, then the hand-off: `ready` briefly, then the server is gone.
        server.status = { ...ready, progress: 100 };
        await vi.advanceTimersByTimeAsync(2_000);
        expect(labelOf(chip)).toBe('installing update…');
        server.down = true;
        await vi.advanceTimersByTimeAsync(2_000);
        expect(labelOf(chip)).toBe('restarting…');
        const reads = statusReads();
        await vi.advanceTimersByTimeAsync(4_000);
        expect(statusReads()).toBe(reads);
        expect(labelOf(chip)).toBe('restarting…');
    });

    it('an install that fails after its answer was lost shows the reason the server recorded', async () => {
        const { server } = scriptedServer();
        const chip = await clickApplyOn();
        await vi.advanceTimersByTimeAsync(0);
        server.dropApply!(new TypeError('NetworkError when attempting to fetch resource.'));
        await vi.advanceTimersByTimeAsync(0);
        expect(labelOf(chip)).toBe('installing update…');

        server.status = { ...ready, lastApplyError: 'update download failed: update download stalled' };
        await vi.advanceTimersByTimeAsync(2_000);
        expect(labelOf(chip)).toBe('install failed: update download failed: update download stalled — click to retry');
        expect(chip.querySelector('button.update-button-action')?.textContent).toBe('apply update v0.2.0');
    });

    it('an apply that never reached a running server is reported once the grace has passed', async () => {
        const { server } = scriptedServer();
        const chip = await clickApplyOn();
        await vi.advanceTimersByTimeAsync(0);
        server.dropApply!(new TypeError('Failed to fetch'));
        await vi.advanceTimersByTimeAsync(0);

        // `ready` with nothing recorded is also the moment between the download
        // and the hand-off, so it is waited out first.
        await vi.advanceTimersByTimeAsync(28_000);
        expect(labelOf(chip)).toBe('installing update…');
        await vi.advanceTimersByTimeAsync(4_000);
        expect(labelOf(chip)).toBe("install failed: couldn't reach server — click to retry");
        expect(chip.querySelector('button.update-button-action')?.textContent).toBe('apply update v0.2.0');
    });

    it('a status read still in flight when "restarting…" goes up does not paint over it', async () => {
        const { server } = scriptedServer();
        const chip = await clickApplyOn();
        await vi.advanceTimersByTimeAsync(0);
        server.hold = true;
        await vi.advanceTimersByTimeAsync(2_000);
        expect(server.held).toHaveLength(1);

        server.answerApply!({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
        await vi.advanceTimersByTimeAsync(0);
        expect(labelOf(chip)).toBe('restarting…');

        // The held read answers `ready` after all.
        server.held.shift()!();
        await vi.advanceTimersByTimeAsync(0);
        expect(labelOf(chip)).toBe('restarting…');
        expect(chip.querySelector('button.update-button-action')).toBeNull();
    });
});

describe('UpdateButton apply: an install that downloads first (Windows, automatic download off)', () => {
    it('the tooltip promises an install, not an already-downloaded update', async () => {
        stubFetch({ ok: true, status: 200, body: { ok: true } });
        const chip = createUpdateButton();
        await flush();
        expect(chip.title).toBe('click to install update');
    });

    it('shows the download while the apply request runs, and stops polling once the server goes down', async () => {
        // setTimeout too: the 5 s reload after a successful apply must not fire.
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
        let status: UpdatesStatusResponse = ready;
        let serverDown = false;
        let answerApply: ((r: unknown) => void) | undefined;
        const f = vi.fn((url: string) => {
            if (url === '/api/updates/apply') {
                return new Promise((resolve) => {
                    answerApply = resolve;
                });
            }
            if (serverDown) return Promise.reject(new TypeError('Failed to fetch'));
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(status) });
        });
        vi.stubGlobal('fetch', f);
        const statusPolls = (): number => f.mock.calls.filter((c) => c[0] === '/api/updates/status').length;
        const label = (chip: HTMLElement): string | null | undefined =>
            chip.querySelector('.update-button-label')?.textContent;

        const chip = createUpdateButton();
        await vi.advanceTimersByTimeAsync(0);
        chip.querySelector<HTMLButtonElement>('button.update-button-action')!.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(answerApply).toBeDefined();

        // The apply request is held while the server downloads; the next poll shows it.
        status = { ...ready, status: 'downloading', progress: 40 };
        await vi.advanceTimersByTimeAsync(30_000);
        expect(label(chip)).toBe('downloading update… 40%');

        // Downloaded and handed off: the server answers, then exits.
        serverDown = true;
        answerApply!({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
        await vi.advanceTimersByTimeAsync(0);
        expect(label(chip)).toBe('restarting…');
        const polls = statusPolls();
        // The 2 s downloading cadence would have polled the stopped server twice by now.
        await vi.advanceTimersByTimeAsync(4_000);
        expect(statusPolls()).toBe(polls);
        expect(label(chip)).toBe('restarting…');
    });
});
