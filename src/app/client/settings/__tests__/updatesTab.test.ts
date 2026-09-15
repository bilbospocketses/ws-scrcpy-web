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
/** The github owner row — this section's only text input. */
const ownerInputOf = (el: HTMLElement): HTMLInputElement => el.querySelector('input[type="text"]')!;

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
     * The four fields are registered with a `null` baseline at build time,
     * because no tab can know the real values synchronously — every tab is built
     * before the read that learns them. `refreshUpdates` re-REGISTERS them with
     * what /api/updates/status reports, which is what makes those values the
     * baseline. If that ever became a `set`, an untouched dialog would sit
     * permanently dirty at `null → …` on all four, and every batch Save would
     * carry four update-config writes nobody asked for.
     *
     * `githubOwner` is asserted here alongside the other three because it is the
     * one that arrived late: it wrote immediately on blur until it joined
     * `STAGEABLE_IDS`, so a re-baseline that quietly skipped it would leave the
     * field permanently dirty at `null → …` and push an owner write into every
     * Save — the exact failure this test exists to catch, on the newest field.
     */
    it('the /api/updates/status read baselines the four fields rather than staging them', async () => {
        const { el, store } = await mountUpdatesTab(
            status({ autoUpdate: true, channel: 'beta', updateCheckIntervalMinutes: 90, githubOwner: 'forky' }),
        );

        expect(store.changes()).toEqual([]);
        expect(autoCheckboxOf(el).checked).toBe(true);
        expect(intervalInputOf(el).value).toBe('90');
        expect(channelRadioOf(el, 'beta').checked).toBe(true);
        expect(channelRadioOf(el, 'stable').checked).toBe(false);
        expect(ownerInputOf(el).value).toBe('forky');

        // And the new baseline is what a later edit is measured against.
        const toggle = autoCheckboxOf(el);
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
        // Raw booleans, with the on/off wording alongside for the summary: the
        // batch endpoint passes `to` to `updateAppConfig`, which refuses
        // anything that is not a boolean.
        expect(store.changes()).toEqual([
            {
                id: 'autoUpdate',
                label: 'Automatic updates',
                from: true,
                to: false,
                fromText: 'on',
                toText: 'off',
            },
        ]);
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
        // What the field actually HOLDS after the assignment, which is not always
        // what was assigned: a type="number" input sanitises '90.5' through
        // unchanged but turns 'junk' into ''. Read rather than assumed, so the
        // assertion below says "the guard left the field alone" rather than
        // "the field equals the string this test typed".
        const onScreen = input.value;
        input.dispatchEvent(new Event('blur'));

        expect(store.changes()).toEqual([]);
        const line = actionStatusOf(el);
        expect(line.textContent).toBe('interval must be between 5 and 1440 minutes');
        expect(line.classList.contains('settings-status-error')).toBe(true);
        // The refused value STAYS on screen — `ServerTab`'s web-port guard has
        // always worked this way and this one now matches it. Snapping back to
        // 60 here (the old behaviour) would erase the entry the user has to look
        // at to see what they got wrong, and would leave two staged number
        // fields in one dialog disagreeing about what invalid input does.
        expect(input.value).toBe(onScreen);
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
    /**
     * The refusal message must not outlive the refusal.
     *
     * Without an explicit clear on the success path the label is STICKY: type 3
     * (red, "interval must be between…"), then type 90 — the 90 stages fine, but
     * the label keeps a red warning about a value that is no longer in the field
     * or in the store, until some unrelated event repaints it. Both references
     * clear it: pre-tabs the next valid commit went through the PATCH cycle
     * (`saving…` → `applyUpdatesStatusText`), and `ServerTab` calls
     * `setServerStatus('')` before `store.set`.
     *
     * This asserts the class separately from the text, because they are restored
     * by one call and a regression could plausibly drop either.
     */
    it('a valid interval clears the refusal message left by an invalid one', async () => {
        const { el, store } = await mountUpdatesTab(status({ updateCheckIntervalMinutes: 60 }));

        const input = intervalInputOf(el);
        input.value = '4';
        input.dispatchEvent(new Event('blur'));
        expect(actionStatusOf(el).textContent).toBe('interval must be between 5 and 1440 minutes');

        input.value = '90';
        input.dispatchEvent(new Event('blur'));

        const line = actionStatusOf(el);
        expect(line.textContent).toBe('up to date: v0.1.30');
        expect(line.classList.contains('settings-status-error')).toBe(false);
        // And the good value still staged — the clear must not cost the stage.
        expect(store.changes().map((c) => c.to)).toEqual([90]);
    });

    it('a refused interval leaves the typed value on screen and the earlier one staged', async () => {
        const { el, store } = await mountUpdatesTab(status({ updateCheckIntervalMinutes: 60 }));

        const input = intervalInputOf(el);
        input.value = '90';
        input.dispatchEvent(new Event('blur'));
        input.value = '99999';
        input.dispatchEvent(new Event('blur'));

        // The two halves of one refusal, and they are deliberately different
        // values: the field keeps what was just typed so the user can fix it,
        // while the STORE keeps the last value that passed the guard. A refusal
        // is a no-op on the store, never a rollback of it.
        expect(input.value).toBe('99999');
        expect(store.changes().map((c) => c.to)).toEqual([90]);
    });

    /**
     * "check now" answers with a full UpdatesStatusResponse, which carries the
     * server's copy of all four staged values. Pushing those back into the
     * controls — as the pre-tabs code did — would silently revert an edit the
     * user had just made while it stayed in the store, so the dialog would show
     * one value and Save would write another.
     *
     * The github-owner field is in here because it is the one that was still
     * being re-synced from this response (`syncOwnerToStatus`). That was right
     * while the field wrote immediately on blur — the response was the
     * authoritative answer to a write it had just made — and became this bug the
     * moment the field started staging instead.
     */
    it('a "check now" response does not clobber a staged edit', async () => {
        const { el, store } = await mountUpdatesTab(
            status({ autoUpdate: true, updateCheckIntervalMinutes: 60, githubOwner: 'bilbospocketses' }),
        );

        const toggle = autoCheckboxOf(el);
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
        const input = intervalInputOf(el);
        input.value = '90';
        input.dispatchEvent(new Event('blur'));
        const owner = ownerInputOf(el);
        owner.value = 'someone-else';
        owner.dispatchEvent(new Event('blur'));

        [...el.querySelectorAll('button')].find((b) => /check/i.test(b.textContent ?? ''))?.click();
        await flush();

        expect(toggle.checked).toBe(false);
        expect(input.value).toBe('90');
        expect(owner.value).toBe('someone-else');
        const stagedIds = store.changes().map((c) => c.id);
        expect(stagedIds.sort()).toEqual(['autoUpdate', 'githubOwner', 'updateCheckIntervalMinutes']);
    });

    /**
     * `githubOwner` STAGES like its three siblings, and — this is the half that
     * used to be the opposite — sends nothing on blur.
     *
     * It wrote immediately via `PATCH /api/updates/config` until it joined
     * `SettingsBatchApi.STAGEABLE_IDS`. Both halves stay pinned because each
     * failure mode is silent in its own way: a reverted stage would leave the
     * change out of the summary and out of the batch with nothing raised
     * anywhere (`store.set` on an unregistered id is a deliberate no-op), and a
     * surviving PATCH would write the value the moment the user tabbed away —
     * so closing the dialog without Save, or cancelling at the summary, would
     * still have changed the setting.
     *
     * The staged change is asserted whole rather than by id, because the SUMMARY
     * renders from exactly this object: `label` is the text the user reads and
     * `from`/`to` are the raw strings either side of the arrow. `githubOwner` has
     * no formatter, so `SettingsSummaryModal` falls through to `String(from)` →
     * `String(to)`, which for a string value is the value itself — "GitHub owner:
     * bilbospocketses → someone-else".
     */
    it('editing the github owner stages it and sends NOTHING', async () => {
        const { el, store, fetchSpy } = await mountUpdatesTab(status({ githubOwner: 'bilbospocketses' }));

        const owner = ownerInputOf(el);
        owner.value = 'someone-else';
        owner.dispatchEvent(new Event('blur'));
        await flush();

        expect(patched(fetchSpy)).toBe(false);
        expect(store.changes()).toEqual([
            { id: 'githubOwner', label: 'GitHub owner', from: 'bilbospocketses', to: 'someone-else' },
        ]);
    });

    it('blurring an unchanged github owner stages nothing and sends nothing', async () => {
        const { el, store, fetchSpy } = await mountUpdatesTab(status({ githubOwner: 'bilbospocketses' }));

        ownerInputOf(el).dispatchEvent(new Event('blur'));
        await flush();

        expect(store.changes()).toEqual([]);
        expect(patched(fetchSpy)).toBe(false);
    });

    it('typing the original github owner back clears the staged change', async () => {
        const { el, store } = await mountUpdatesTab(status({ githubOwner: 'bilbospocketses' }));

        const owner = ownerInputOf(el);
        owner.value = 'someone-else';
        owner.dispatchEvent(new Event('blur'));
        expect(store.changes().map((c) => c.id)).toEqual(['githubOwner']);

        owner.value = 'bilbospocketses';
        owner.dispatchEvent(new Event('blur'));
        expect(store.changes()).toEqual([]);
    });

    // `Config.validateField('githubOwner')` rejects an empty string by THROWING
    // out of `updateAppConfig`, so an unguarded stage is a 400 for the WHOLE
    // batch at Save time — every sibling change refused along with it, about a
    // field the user blanked minutes earlier.
    //
    // '   ' rather than '': the server's test is `length === 0`, so untrimmed
    // whitespace would sail past it and be SAVED as the github owner. The guard
    // trims before testing, which is what makes this case a refusal.
    it.each([
        ['', 'emptied'],
        ['   ', 'whitespace only'],
    ])('refuses to stage a github owner that is %s (%s)', async (value) => {
        const { el, store, fetchSpy } = await mountUpdatesTab(status({ githubOwner: 'bilbospocketses' }));

        const owner = ownerInputOf(el);
        owner.value = value;
        owner.dispatchEvent(new Event('blur'));
        await flush();

        expect(store.changes()).toEqual([]);
        const line = actionStatusOf(el);
        expect(line.textContent).toBe('github owner cannot be empty');
        expect(line.classList.contains('settings-status-error')).toBe(true);
        // Left on screen, exactly as the interval and web-port guards leave a
        // refused number. The old behaviour snapped this field back to the last
        // known owner and said nothing at all.
        expect(owner.value).toBe(value);
        expect(patched(fetchSpy)).toBe(false);
    });

    it('a valid github owner clears the refusal message left by an empty one', async () => {
        const { el, store } = await mountUpdatesTab(status({ githubOwner: 'bilbospocketses' }));

        const owner = ownerInputOf(el);
        owner.value = '';
        owner.dispatchEvent(new Event('blur'));
        expect(actionStatusOf(el).textContent).toBe('github owner cannot be empty');

        owner.value = 'someone-else';
        owner.dispatchEvent(new Event('blur'));

        const line = actionStatusOf(el);
        expect(line.textContent).toBe('up to date: v0.1.30');
        expect(line.classList.contains('settings-status-error')).toBe(false);
        // And the good value still staged — the clear must not cost the stage.
        expect(store.changes().map((c) => c.to)).toEqual(['someone-else']);
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
