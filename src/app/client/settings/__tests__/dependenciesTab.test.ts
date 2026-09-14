// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StagedSettingsStore } from '../StagedSettingsStore';
import { buildDependenciesTab, destroyDependenciesTab, refreshDependencies } from '../tabs/DependenciesTab';
import type { TabContext } from '../tabs/EmbeddingTab';

const ctx = (): TabContext => ({ role: 'admin', authEnabled: false, reload: () => undefined });

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('Dependencies tab', () => {
    it('builds a non-empty body without touching the network', () => {
        const el = buildDependenciesTab(ctx(), new StagedSettingsStore());
        // TabStrip builds every tab body eagerly, before the /api/config probe
        // has resolved — a build-time read would fire at a caller the admin API
        // may refuse, which is the whole point of holding it.
        expect(fetch).not.toHaveBeenCalled();
        expect(el.childElementCount).toBeGreaterThan(0);
    });

    it('reads /api/dependencies only once refreshDependencies() drives it', async () => {
        const el = buildDependenciesTab(ctx(), new StagedSettingsStore());
        await refreshDependencies(el);
        expect(fetch).toHaveBeenCalledWith('/api/dependencies');
        expect(el.querySelector('#dependency-panel')).not.toBeNull();
        destroyDependenciesTab(el);
    });

    it('is a no-op for an element it never built', async () => {
        const stranger = document.createElement('div');
        await refreshDependencies(stranger);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('stops the panel polling when the tab is destroyed', async () => {
        const el = buildDependenciesTab(ctx(), new StagedSettingsStore());
        await refreshDependencies(el);
        expect(fetch).toHaveBeenCalledTimes(1);

        // Positive control: the panel really is polling, so the assertion below
        // is about destroy and not about a panel that never started.
        await vi.advanceTimersByTimeAsync(15_000);
        expect(fetch).toHaveBeenCalledTimes(2);

        destroyDependenciesTab(el);
        vi.mocked(fetch).mockClear();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('leaves nothing polling when the dialog closes while the first read is in flight', async () => {
        let release: (() => void) | undefined;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                await gate;
                return { ok: true, json: async () => [] } as unknown as Response;
            }),
        );

        const el = buildDependenciesTab(ctx(), new StagedSettingsStore());
        const inFlight = refreshDependencies(el);
        destroyDependenciesTab(el);
        release!();
        await inFlight;

        vi.mocked(fetch).mockClear();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('contributes no staged fields', () => {
        const store = new StagedSettingsStore();
        buildDependenciesTab(ctx(), store);
        expect(store.isDirty()).toBe(false);
        expect(store.changes()).toEqual([]);
    });
});
