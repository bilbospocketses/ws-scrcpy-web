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

    it('any other failure re-reads the status as before, with no declined line', async () => {
        const f = stubFetch({ ok: false, status: 500, body: { ok: false, error: 'boom' } });
        const chip = await clickApply();

        expect(f.mock.calls.filter((c) => c[0] === '/api/updates/status').length).toBe(2);
        expect(chip.querySelector('.update-button-label')).toBeNull();
        expect(chip.querySelector('button.update-button-action')?.textContent).toBe('apply update v0.2.0');
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
