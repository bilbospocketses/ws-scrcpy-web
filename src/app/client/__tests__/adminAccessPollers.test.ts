// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DependencyInfo, DependencyStatus } from '../../../common/DependencyTypes';
import type { UpdatesStatusResponse } from '../../../common/UpdateEvents';
import { ADMIN_ACCESS_LOST_EVENT, announceAdminAccessLost } from '../adminAccess';
import { ADMIN_UNREACHABLE_NOTE } from '../adminGate';
import { DependencyAlertCard } from '../DependencyAlertCard';
import { DependencyPanel } from '../DependencyPanel';
import { startEmbedRequestWatch, stopEmbedRequestWatch } from '../EmbedRequestPrompt';
import { FirstRunBanner } from '../FirstRunBanner';
import { createUpdateButton } from '../UpdateButton';

/**
 * The pollers that read operator-gated routes on a timer (0.5.5): each stops
 * for good on a 403 from its own read, and on `announceAdminAccessLost`, which
 * Settings raises before a save that ends this page's admin access. Neither
 * leaves a retry loop behind, and none shows an error for it.
 */

const local = { adminScope: 'remote' as const, callerIsLocal: true };

function dep(over: Partial<DependencyInfo>): DependencyInfo {
    return {
        name: 'adb',
        displayName: 'ADB',
        installedVersion: '1.0',
        latestVersion: '1.1',
        status: DependencyStatus.UpdateAvailable,
        description: 'desc',
        requiresRestart: false,
        canUpdate: true,
        ...over,
    };
}

const reply = (status: number, body: unknown) =>
    Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });

/** A fetch that answers every URL with `answer()`, read at call time. */
function stubFetch(answer: () => Promise<unknown>): ReturnType<typeof vi.fn> {
    const f = vi.fn(() => answer());
    vi.stubGlobal('fetch', f);
    return f;
}

const calls = (f: ReturnType<typeof vi.fn>, url: string): number => f.mock.calls.filter((c) => c[0] === url).length;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
});

afterEach(() => {
    stopEmbedRequestWatch();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
});

describe('DependencyAlertCard', () => {
    it('stops polling for good on a 403, and hides', async () => {
        let status = 200;
        const f = stubFetch(() => reply(status, status === 200 ? [dep({})] : { error: 'refused' }));
        const card = await DependencyAlertCard.create(local, 'admin');
        expect(card.getElement().hidden).toBe(false);
        status = 403;
        await vi.advanceTimersByTimeAsync(15_000);
        expect(card.getElement().hidden).toBe(true);
        const after = calls(f, '/api/dependencies');
        await vi.advanceTimersByTimeAsync(60_000);
        expect(calls(f, '/api/dependencies')).toBe(after);
    });

    it('stops before its next tick when admin access is lost', async () => {
        const f = stubFetch(() => reply(200, [dep({})]));
        const card = await DependencyAlertCard.create(local, 'admin');
        const before = calls(f, '/api/dependencies');
        announceAdminAccessLost();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(calls(f, '/api/dependencies')).toBe(before);
        expect(card.getElement().hidden).toBe(true);
    });
});

describe('FirstRunBanner', () => {
    const pending = [dep({ installedVersion: null, status: DependencyStatus.Error, displayName: 'Node' })];

    it('stops polling for good on a 403, and hides', async () => {
        let status = 200;
        const f = stubFetch(() => reply(status, status === 200 ? pending : { error: 'refused' }));
        const banner = await FirstRunBanner.create(local);
        expect(banner.getElement().style.display).toBe('block');
        status = 403;
        await vi.advanceTimersByTimeAsync(15_000);
        expect(banner.getElement().style.display).toBe('none');
        const after = calls(f, '/api/dependencies');
        await vi.advanceTimersByTimeAsync(60_000);
        expect(calls(f, '/api/dependencies')).toBe(after);
    });

    it('stops before its next tick when admin access is lost', async () => {
        const f = stubFetch(() => reply(200, pending));
        await FirstRunBanner.create(local);
        const before = calls(f, '/api/dependencies');
        announceAdminAccessLost();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(calls(f, '/api/dependencies')).toBe(before);
    });
});

describe('UpdateButton', () => {
    const checking: UpdatesStatusResponse = {
        isInstalled: true,
        currentVersion: '0.1.30',
        status: 'error',
        errorMessage: 'feed down',
        autoUpdate: true,
        channel: 'stable',
        githubOwner: 'bilbospocketses',
        updateCheckIntervalMinutes: 60,
    };

    it('shows nothing on a 403, never an error pill, and never reads again', async () => {
        const f = stubFetch(() => reply(403, { error: 'admin actions are limited to this machine' }));
        const chip = createUpdateButton();
        await vi.advanceTimersByTimeAsync(0);
        expect(chip.style.display).toBe('none');
        expect(chip.classList.contains('state-error')).toBe(false);
        expect(chip.textContent).toBe('');
        await vi.advanceTimersByTimeAsync(120_000);
        expect(calls(f, '/api/updates/status')).toBe(1);
    });

    it('a 403 after a working read hides the pill it was showing', async () => {
        let status = 200;
        const f = stubFetch(() => reply(status, status === 200 ? checking : { error: 'refused' }));
        const chip = createUpdateButton();
        await vi.advanceTimersByTimeAsync(0);
        expect(chip.classList.contains('state-error')).toBe(true);
        status = 403;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(chip.style.display).toBe('none');
        const after = calls(f, '/api/updates/status');
        await vi.advanceTimersByTimeAsync(120_000);
        expect(calls(f, '/api/updates/status')).toBe(after);
    });

    it('stops before its next tick when admin access is lost', async () => {
        const f = stubFetch(() => reply(200, checking));
        const chip = createUpdateButton();
        await vi.advanceTimersByTimeAsync(0);
        announceAdminAccessLost();
        expect(chip.style.display).toBe('none');
        await vi.advanceTimersByTimeAsync(120_000);
        expect(calls(f, '/api/updates/status')).toBe(1);
    });
});

describe('DependencyPanel (Settings → Dependencies)', () => {
    it('stops polling for good on a 403 and says why in the table', async () => {
        let status = 200;
        const f = stubFetch(() => reply(status, status === 200 ? [dep({})] : { error: 'refused' }));
        const panel = await DependencyPanel.create({ show: () => undefined });
        status = 403;
        await vi.advanceTimersByTimeAsync(15_000);
        expect(panel.getElement().querySelector('tbody')?.textContent).toBe(ADMIN_UNREACHABLE_NOTE);
        const after = calls(f, '/api/dependencies');
        await vi.advanceTimersByTimeAsync(60_000);
        expect(calls(f, '/api/dependencies')).toBe(after);
        panel.destroy();
    });

    it('stops before its next tick when admin access is lost', async () => {
        const f = stubFetch(() => reply(200, [dep({})]));
        const panel = await DependencyPanel.create({ show: () => undefined });
        const before = calls(f, '/api/dependencies');
        announceAdminAccessLost();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(calls(f, '/api/dependencies')).toBe(before);
        panel.destroy();
    });

    it('destroy removes its listener', async () => {
        stubFetch(() => reply(200, [dep({})]));
        const remove = vi.spyOn(window, 'removeEventListener');
        const panel = await DependencyPanel.create({ show: () => undefined });
        panel.destroy();
        expect(remove.mock.calls.some((c) => c[0] === ADMIN_ACCESS_LOST_EVENT)).toBe(true);
    });
});

describe('the embed-request watch', () => {
    it('never starts on another machine', async () => {
        const f = stubFetch(() => reply(200, { request: null }));
        startEmbedRequestWatch(false);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(calls(f, '/api/embed-request')).toBe(0);
    });

    it('stops for good on a 403', async () => {
        const f = stubFetch(() => reply(403, { error: 'forbidden' }));
        startEmbedRequestWatch(undefined);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(calls(f, '/api/embed-request')).toBe(1);
    });

    it('polls on this machine', async () => {
        const f = stubFetch(() => reply(200, { request: null }));
        startEmbedRequestWatch(true);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(calls(f, '/api/embed-request')).toBe(3);
    });
});
