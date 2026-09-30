// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { StagedSettingsStore } from '../StagedSettingsStore';
import { applyServerContainerMode, applyServerServiceStatus, buildServerTab, refreshServer } from '../tabs/ServerTab';

afterEach(() => {
    vi.unstubAllGlobals();
});

const ctx = { role: 'admin' as const, authEnabled: false, reload: () => undefined };

/**
 * The status line for the web port is the element immediately after its row —
 * located that way rather than by `.settings-status`, which the install and
 * stop-server notes also carry.
 */
function webPortStatusOf(el: HTMLElement): HTMLElement {
    const row = [...el.querySelectorAll('.settings-row')].find(
        (r) => r.querySelector('.settings-label')?.textContent === 'web port',
    );
    return row?.nextElementSibling as HTMLElement;
}

/** A Server-tab row's element, found by its label. */
function rowOf(el: HTMLElement, label: string): HTMLElement {
    const row = [...el.querySelectorAll<HTMLElement>('.settings-row')].find(
        (r) => r.querySelector('.settings-label')?.textContent === label,
    );
    if (!row) throw new Error(`no row labelled "${label}"`);
    return row;
}

describe('ServerTab: the install-lifecycle rows are a DECISION, never the default (findings 20.4, 20.5)', () => {
    const APP_ROWS = ['install for all users', 'uninstall ws-scrcpy-web'];

    it('both rows start hidden and undecided', () => {
        const el = buildServerTab(ctx, new StagedSettingsStore());
        expect(el.dataset['appRowsDecided']).toBeUndefined();
        for (const label of APP_ROWS) expect(rowOf(el, label).style.display).toBe('none');
    });

    it('container mode decides: hidden, and says so', () => {
        const el = buildServerTab(ctx, new StagedSettingsStore());
        applyServerContainerMode(el);
        expect(el.dataset['appRowsDecided']).toBe('container');
        for (const label of APP_ROWS) expect(rowOf(el, label).style.display).toBe('none');
        // "stop server & exit" is untouched: it is correct in a container (row 20.6).
        const stop = [...el.querySelectorAll('button')].find((b) => b.textContent === 'stop server & exit');
        expect(stop?.disabled).toBe(false);
    });

    it('the desktop path decides from the service status: shown on Linux, marked as such', () => {
        const el = buildServerTab(ctx, new StagedSettingsStore());
        applyServerServiceStatus(el, { supported: true, platform: 'linux', status: 'not-installed' });
        expect(el.dataset['appRowsDecided']).toBe('service-status');
        for (const label of APP_ROWS) expect(rowOf(el, label).style.display).toBe('');
    });
});

describe('ServerTab', () => {
    it('registers webPort so it can be staged', () => {
        const store = new StagedSettingsStore();
        buildServerTab(ctx, store);
        expect(store.get('webPort')).toBeDefined();
    });

    it('typing a new port stages it instead of saving immediately', () => {
        const store = new StagedSettingsStore();
        const el = buildServerTab(ctx, store);
        const input = el.querySelector('input[type="number"]') as HTMLInputElement;
        input.value = '8010';
        input.dispatchEvent(new Event('change', { bubbles: true }));
        expect(store.changes().map((c) => c.id)).toContain('webPort');
    });

    it('has no per-field Save button — Save lives on the dialog now', () => {
        const store = new StagedSettingsStore();
        const el = buildServerTab(ctx, store);
        // Case-insensitive on purpose. The button this tab removed rendered
        // lowercase 'save', like every other button here, so an exact-case
        // assertion would have passed with it still present — and the pin has to
        // survive a future relabel too.
        const labels = [...el.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim().toLowerCase());
        expect(labels).not.toContain('save');
    });

    // The range guard `onSavePort` used to apply before saving. With that button
    // gone it belongs on the stage: `Config.validateField` rejects a bad port by
    // THROWING, so an unguarded stage turns into a 400 the user never asked for.
    it('refuses to stage a port outside 1024-65535 and says why', () => {
        const store = new StagedSettingsStore();
        const el = buildServerTab(ctx, store);
        const input = el.querySelector('input[type="number"]') as HTMLInputElement;
        input.value = '80';
        input.dispatchEvent(new Event('change', { bubbles: true }));

        expect(store.changes()).toEqual([]);
        const status = webPortStatusOf(el);
        expect(status.textContent).toBe('port must be between 1024 and 65535');
        expect(status.hidden).toBe(false);
    });

    it('refuses to stage an emptied port field — it must not reach the server as 0', () => {
        const store = new StagedSettingsStore();
        const el = buildServerTab(ctx, store);
        const input = el.querySelector('input[type="number"]') as HTMLInputElement;
        input.value = '';
        input.dispatchEvent(new Event('change', { bubbles: true }));

        expect(store.changes()).toEqual([]);
        expect(webPortStatusOf(el).textContent).toBe('port must be between 1024 and 65535');
    });

    // '8010.5' is the case `parseInt` got wrong: it truncated to 8010 and staged
    // a port the user never typed. 'not-a-port' never reaches the guard as typed
    // — a `type="number"` input sanitises junk to '' (verified in jsdom), so it
    // arrives as the emptied case and is refused by the range arm, not the
    // integer arm. Pinned anyway: what matters is that junk cannot stage.
    it.each([
        ['1023', 'below the floor'],
        ['65536', 'above the ceiling'],
        ['8010.5', 'not an integer'],
        ['not-a-port', 'sanitised to empty by the number input'],
    ])('refuses to stage %s (%s)', (value) => {
        const store = new StagedSettingsStore();
        const el = buildServerTab(ctx, store);
        const input = el.querySelector('input[type="number"]') as HTMLInputElement;
        input.value = value;
        input.dispatchEvent(new Event('change', { bubbles: true }));

        expect(store.changes()).toEqual([]);
        expect(webPortStatusOf(el).textContent).toBe('port must be between 1024 and 65535');
    });

    it.each(['1024', '65535'])('stages %s — the boundaries are inclusive, as the server accepts them', (value) => {
        const store = new StagedSettingsStore();
        const el = buildServerTab(ctx, store);
        const input = el.querySelector('input[type="number"]') as HTMLInputElement;
        input.value = value;
        input.dispatchEvent(new Event('change', { bubbles: true }));

        expect(store.changes().map((c) => c.to)).toEqual([Number(value)]);
    });

    it('clears the range message once a valid port replaces the bad one', () => {
        const store = new StagedSettingsStore();
        const el = buildServerTab(ctx, store);
        const input = el.querySelector('input[type="number"]') as HTMLInputElement;
        input.value = '80';
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.value = '8010';
        input.dispatchEvent(new Event('change', { bubbles: true }));

        expect(store.changes().map((c) => c.id)).toContain('webPort');
        const status = webPortStatusOf(el);
        expect(status.textContent).toBe('');
        expect(status.hidden).toBe(true);
    });

    // The port is registered with a `null` baseline at build time, because no
    // tab can know the real one synchronously. `refreshServer` re-REGISTERS it
    // with the value /api/config reports, which is what makes that value the
    // baseline. If that ever became a `set`, an untouched dialog would sit
    // permanently dirty at `null → 8000` and every batch Save would carry a
    // webPort change — restarting the server for a setting nobody edited.
    it('the /api/config read baselines the port rather than staging it', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ config: { webPort: 8000 } }) }),
        );
        const store = new StagedSettingsStore();
        const el = buildServerTab(ctx, store);

        await refreshServer(el);

        const input = el.querySelector('input[type="number"]') as HTMLInputElement;
        expect(input.value).toBe('8000');
        expect(store.changes()).toEqual([]);

        // And the new baseline is what a later edit is measured against.
        input.value = '8010';
        input.dispatchEvent(new Event('change', { bubbles: true }));
        expect(store.changes()).toEqual([{ id: 'webPort', label: 'Web port', from: 8000, to: 8010 }]);
    });
});
