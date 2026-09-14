// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdatesStatusResponse } from '../../../../common/UpdateEvents';
import { StagedSettingsStore } from '../StagedSettingsStore';
import { buildUpdatesTab, refreshUpdates } from '../tabs/UpdatesTab';

afterEach(() => {
    vi.unstubAllGlobals();
});

const ctx = { role: 'admin' as const, authEnabled: false, reload: () => undefined };

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function status(over: Partial<UpdatesStatusResponse> = {}): UpdatesStatusResponse {
    return {
        isInstalled: true,
        currentVersion: '0.1.30',
        status: 'idle',
        autoUpdate: true,
        channel: 'stable',
        githubOwner: 'bilbospocketses',
        updateCheckIntervalMinutes: 60,
        ...over,
    };
}

/** A fetch that answers every /api/updates/* call with `s`. */
function stubUpdates(s: UpdatesStatusResponse): ReturnType<typeof vi.fn> {
    const f = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(s) }));
    vi.stubGlobal('fetch', f);
    return f;
}

/**
 * Build the tab AND run the read that fills it.
 *
 * Unlike the Server tab, this one renders nothing but a "loading…" placeholder
 * synchronously — every control is created by `refreshUpdates` from the
 * /api/updates/status response, because what to render (dev-mode note, error +
 * retry, or the full control set) is a function of that response. So a test
 * that wants a checkbox has to get past the read first.
 */
async function mountUpdatesTab(s: UpdatesStatusResponse = status()): Promise<{
    el: HTMLElement;
    store: StagedSettingsStore;
    fetchSpy: ReturnType<typeof vi.fn>;
}> {
    const fetchSpy = stubUpdates(s);
    const store = new StagedSettingsStore();
    const el = buildUpdatesTab(ctx, store);
    await refreshUpdates(el);
    return { el, store, fetchSpy };
}

/** True when any call on the spy was a PATCH — the write this tab no longer does. */
function patched(fetchSpy: ReturnType<typeof vi.fn>): boolean {
    return fetchSpy.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
}

const autoCheckboxOf = (el: HTMLElement): HTMLInputElement => el.querySelector('input[type="checkbox"]')!;
const intervalInputOf = (el: HTMLElement): HTMLInputElement => el.querySelector('input[type="number"]')!;
const channelRadioOf = (el: HTMLElement, value: string): HTMLInputElement =>
    el.querySelector(`input[type="radio"][value="${value}"]`)!;

/**
 * The live status text — the LABEL of the action row, which doubles as this
 * section's status line (see the action-row comment in UpdatesTab). Located via
 * the action button rather than by position, so adding a row above cannot
 * silently retarget the assertion at the wrong element.
 */
function actionStatusOf(el: HTMLElement): HTMLElement {
    const btn = [...el.querySelectorAll('button')].find((b) => /check for updates|apply/i.test(b.textContent ?? ''));
    return btn!.closest('.settings-row')!.querySelector('.settings-label') as HTMLElement;
}

describe('UpdatesTab', () => {
    it('toggling auto-update stages it and sends NOTHING', async () => {
        const { el, store, fetchSpy } = await mountUpdatesTab();

        const toggle = autoCheckboxOf(el);
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));

        expect(store.changes().map((c) => c.id)).toContain('autoUpdate');
        expect(patched(fetchSpy)).toBe(false);
    });

    it('picking the other channel stages it and sends NOTHING', async () => {
        const { el, store, fetchSpy } = await mountUpdatesTab(status({ channel: 'stable' }));

        const beta = channelRadioOf(el, 'beta');
        beta.checked = true;
        beta.dispatchEvent(new Event('change', { bubbles: true }));

        expect(store.changes()).toEqual([{ id: 'channel', label: 'Update channel', from: 'stable', to: 'beta' }]);
        expect(patched(fetchSpy)).toBe(false);
    });

    it('editing the interval stages it and sends NOTHING', async () => {
        const { el, store, fetchSpy } = await mountUpdatesTab(status({ updateCheckIntervalMinutes: 60 }));

        const input = intervalInputOf(el);
        input.value = '90';
        input.dispatchEvent(new Event('blur'));

        expect(store.changes()).toEqual([
            { id: 'updateCheckIntervalMinutes', label: 'Check interval (minutes)', from: 60, to: 90 },
        ]);
        expect(patched(fetchSpy)).toBe(false);
    });

    it('the "check now" button is still an ACTION and is not staged', async () => {
        const { el, store, fetchSpy } = await mountUpdatesTab();

        const check = [...el.querySelectorAll('button')].find((b) => /check/i.test(b.textContent ?? ''));
        expect(check).toBeTruthy();
        check?.click();
        await flush();

        expect(store.changes().map((c) => c.id)).not.toContain('checkNow');
        // The assertion above can only fail if something deliberately registers
        // a 'checkNow' field, which nothing would. These two can: the first
        // catches the button staging ANYTHING, the second catches it having
        // quietly stopped being an action at all.
        expect(store.changes()).toEqual([]);
        expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toContain('/api/updates/check');
    });

    /**
     * The three fields are registered with a `null` baseline at build time,
     * because no tab can know the real values synchronously — every tab is built
     * before the read that learns them. `refreshUpdates` re-REGISTERS them with
     * what /api/updates/status reports, which is what makes those values the
     * baseline. If that ever became a `set`, an untouched dialog would sit
     * permanently dirty at `null → …` on all three, and every batch Save would
     * carry three update-config writes nobody asked for.
     */
    it('the /api/updates/status read baselines the three fields rather than staging them', async () => {
        const { el, store } = await mountUpdatesTab(
            status({ autoUpdate: true, channel: 'beta', updateCheckIntervalMinutes: 90 }),
        );

        expect(store.changes()).toEqual([]);
        expect(autoCheckboxOf(el).checked).toBe(true);
        expect(intervalInputOf(el).value).toBe('90');
        expect(channelRadioOf(el, 'beta').checked).toBe(true);
        expect(channelRadioOf(el, 'stable').checked).toBe(false);

        // And the new baseline is what a later edit is measured against.
        const toggle = autoCheckboxOf(el);
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
        expect(store.changes()).toEqual([{ id: 'autoUpdate', label: 'Automatic updates', from: 'on', to: 'off' }]);
    });

    // The range guard `commitIntervalChange` applied before PATCHing, re-homed
    // onto the stage. `Config.validateField('updateCheckIntervalMinutes')` wants
    // an integer in [5, 1440] and `updateAppConfig` rejects anything else by
    // THROWING, so an unguarded stage turns into a 400 at Save time — an error
    // about a value the user typed minutes earlier, in a dialog that gave no
    // hint at the time.
    //
    // '90.5' is the case the old `Number.parseInt` got wrong: it truncated to 90
    // and staged a value the field did not show. 'junk' never reaches the guard
    // as typed — a type="number" input sanitises it to '' — so it arrives as the
    // emptied case. Pinned anyway: what matters is that it cannot stage.
    it.each([
        ['4', 'below the floor'],
        ['1441', 'above the ceiling'],
        ['90.5', 'not an integer'],
        ['', 'emptied'],
        ['junk', 'sanitised to empty by the number input'],
    ])('refuses to stage interval %s (%s)', async (value) => {
        const { el, store } = await mountUpdatesTab(status({ updateCheckIntervalMinutes: 60 }));

        const input = intervalInputOf(el);
        input.value = value;
        input.dispatchEvent(new Event('blur'));

        expect(store.changes()).toEqual([]);
        const line = actionStatusOf(el);
        expect(line.textContent).toBe('interval must be between 5 and 1440 minutes');
        expect(line.classList.contains('settings-status-error')).toBe(true);
        // The refused value does not stay on screen either — the field snaps
        // back to the last value the server reported.
        expect(input.value).toBe('60');
    });

    it.each(['5', '1440'])(
        'stages interval %s — the boundaries are inclusive, as the server accepts them',
        async (value) => {
            const { el, store } = await mountUpdatesTab(status({ updateCheckIntervalMinutes: 60 }));

            const input = intervalInputOf(el);
            input.value = value;
            input.dispatchEvent(new Event('blur'));

            expect(store.changes().map((c) => c.to)).toEqual([Number(value)]);
        },
    );

    /**
     * Staging is a comparison against the baseline, not a one-way latch. The
     * pre-tabs code returned early when the typed value equalled the server's,
     * which was right for a PATCH (nothing to send) and wrong for a stage: the
     * earlier 90 would still be staged while the field read 60, and Save would
     * write a value the user had already undone.
     */
    it('a refused interval leaves the previously staged one both on screen and staged', async () => {
        const { el, store } = await mountUpdatesTab(status({ updateCheckIntervalMinutes: 60 }));

        const input = intervalInputOf(el);
        input.value = '90';
        input.dispatchEvent(new Event('blur'));
        input.value = '99999';
        input.dispatchEvent(new Event('blur'));

        // Snapping back to the server's 60 here would leave the field showing 60
        // while Save wrote 90.
        expect(input.value).toBe('90');
        expect(store.changes().map((c) => c.to)).toEqual([90]);
    });

    /**
     * "check now" answers with a full UpdatesStatusResponse, which carries the
     * server's copy of all three staged values. Pushing those back into the
     * controls — as the pre-tabs code did — would silently revert an edit the
     * user had just made while it stayed in the store, so the dialog would show
     * one value and Save would write another.
     */
    it('a "check now" response does not clobber a staged edit', async () => {
        const { el, store } = await mountUpdatesTab(status({ autoUpdate: true, updateCheckIntervalMinutes: 60 }));

        const toggle = autoCheckboxOf(el);
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
        const input = intervalInputOf(el);
        input.value = '90';
        input.dispatchEvent(new Event('blur'));

        [...el.querySelectorAll('button')].find((b) => /check/i.test(b.textContent ?? ''))?.click();
        await flush();

        expect(toggle.checked).toBe(false);
        expect(input.value).toBe('90');
        const stagedIds = store.changes().map((c) => c.id);
        expect(stagedIds.sort()).toEqual(['autoUpdate', 'updateCheckIntervalMinutes']);
    });

    it('typing the original interval back clears the staged change', async () => {
        const { el, store } = await mountUpdatesTab(status({ updateCheckIntervalMinutes: 60 }));

        const input = intervalInputOf(el);
        input.value = '90';
        input.dispatchEvent(new Event('blur'));
        expect(store.changes().map((c) => c.id)).toEqual(['updateCheckIntervalMinutes']);

        input.value = '60';
        input.dispatchEvent(new Event('blur'));
        expect(store.changes()).toEqual([]);
    });
});
