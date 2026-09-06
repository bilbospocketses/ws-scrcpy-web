// @vitest-environment jsdom

/**
 * BookmarkReminder replaced the PortChangeModal / ServiceFirstRunModal dialogs
 * (item 113). The contract under test: it is NOT a dialog and covers nothing;
 * each button persists its choice in one click; "never again" sits behind a
 * confirmation; × persists nothing; and — bug #35's regression — construction
 * issues no PATCH at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BookmarkReminder } from '../BookmarkReminder';
import { ConfirmModal } from '../ConfirmModal';

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as unknown as Response)),
    );
});

afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function fetchMock(): ReturnType<typeof vi.fn> {
    return fetch as unknown as ReturnType<typeof vi.fn>;
}
function patches(): Record<string, unknown>[] {
    return (fetchMock().mock.calls as unknown[][])
        .filter((args) => args[0] === '/api/settings' && (args[1] as RequestInit | undefined)?.method === 'PATCH')
        .map((args) => JSON.parse((args[1] as RequestInit).body as string) as Record<string, unknown>);
}
function button(label: string): HTMLButtonElement {
    const btn = (Array.from(document.querySelectorAll('.bookmark-reminder button')) as HTMLButtonElement[]).find(
        (b) => (b.textContent?.trim().toLowerCase() ?? '') === label || b.getAttribute('aria-label') === label,
    );
    expect(btn, `${label} button`).toBeTruthy();
    return btn!;
}
function card(): HTMLElement | null {
    return document.querySelector('.bookmark-reminder');
}

describe('BookmarkReminder', () => {
    it('is an in-flow status card, not a dialog, and shows the browser’s own address', () => {
        new BookmarkReminder({ webPort: 8000, kind: 'bookmark' }).mount();
        const el = card();
        expect(el).not.toBeNull();
        expect(el!.tagName).toBe('DIV');
        expect(el!.getAttribute('role')).toBe('status');
        expect(document.querySelector('dialog')).toBeNull();
        // The address this browser is on, port swapped in — never a literal
        // localhost built from nothing (item 112).
        const expected = new URL(window.location.href);
        expected.port = '8000';
        expect(el!.querySelector('a')?.getAttribute('href')).toBe(expected.origin);
        expect(el!.textContent).toContain('bookmark');
        expect(el!.dataset['kind']).toBe('bookmark');
    });

    it('mounts at the top of its parent', () => {
        const first = document.createElement('main');
        document.body.appendChild(first);
        new BookmarkReminder({ webPort: 8000, kind: 'bookmark' }).mount();
        expect(document.body.firstElementChild?.classList.contains('bookmark-reminder')).toBe(true);
    });

    it('issues no PATCH at construction (bug #35 regression), for either kind', async () => {
        new BookmarkReminder({ webPort: 8000, kind: 'bookmark' }).mount();
        new BookmarkReminder({ webPort: 8001, kind: 'service' }).mount();
        await flush();
        expect(patches()).toEqual([]);
    });

    it('got it stamps this port and leaves', async () => {
        const onDismissed = vi.fn();
        new BookmarkReminder({ webPort: 8000, kind: 'bookmark', onDismissed }).mount();
        button('got it').click();
        await flush();
        expect(patches()).toEqual([{ bookmarkDismissedForPort: 8000 }]);
        expect(card()).toBeNull();
        expect(onDismissed).toHaveBeenCalledTimes(1);
    });

    it('the service kind says so, and got it records the service notice as seen too', async () => {
        new BookmarkReminder({ webPort: 8001, kind: 'service' }).mount();
        expect(card()!.textContent).toContain('running as a service');
        expect(card()!.dataset['kind']).toBe('service');
        button('got it').click();
        await flush();
        expect(patches()).toEqual([{ bookmarkDismissedForPort: 8001, serviceFirstRunSeen: true }]);
        expect(card()).toBeNull();
    });

    it('never again asks first, then persists the global dismissal', async () => {
        const confirm = vi.spyOn(ConfirmModal, 'confirm').mockResolvedValue(true);
        new BookmarkReminder({ webPort: 8000, kind: 'bookmark' }).mount();
        button('never again').click();
        await flush();
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(patches()).toEqual([{ bookmarkDismissedGlobally: true }]);
        expect(card()).toBeNull();
    });

    it('never again on a service instance also records the service notice as seen', async () => {
        vi.spyOn(ConfirmModal, 'confirm').mockResolvedValue(true);
        new BookmarkReminder({ webPort: 8001, kind: 'service' }).mount();
        button('never again').click();
        await flush();
        expect(patches()).toEqual([{ bookmarkDismissedGlobally: true, serviceFirstRunSeen: true }]);
    });

    it('a cancelled confirmation writes nothing and keeps the card up', async () => {
        vi.spyOn(ConfirmModal, 'confirm').mockResolvedValue(false);
        new BookmarkReminder({ webPort: 8000, kind: 'bookmark' }).mount();
        button('never again').click();
        await flush();
        expect(patches()).toEqual([]);
        expect(card()).not.toBeNull();
    });

    it('× dismisses for this page view only: nothing persisted', async () => {
        const onDismissed = vi.fn();
        new BookmarkReminder({ webPort: 8000, kind: 'bookmark', onDismissed }).mount();
        button('dismiss for now').click();
        await flush();
        expect(patches()).toEqual([]);
        expect(card()).toBeNull();
        expect(onDismissed).toHaveBeenCalledTimes(1);
    });

    it('a second click after a choice does nothing more', async () => {
        new BookmarkReminder({ webPort: 8000, kind: 'bookmark' }).mount();
        const gotIt = button('got it');
        gotIt.click();
        gotIt.click();
        await flush();
        expect(patches()).toHaveLength(1);
    });
});
