// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BaseDeviceDescriptor } from '../../types/BaseDeviceDescriptor';
import type { ParamsDeviceTracker } from '../../types/ParamsDeviceTracker';
import { BaseDeviceTracker } from './BaseDeviceTracker';

// Minimal concrete subclass whose per-refresh row-context resolves via fetch,
// so we can hold a refresh "in flight" and observe coalescing (#34).
class CoalesceTracker extends BaseDeviceTracker<BaseDeviceDescriptor, never> {
    public static override readonly ACTION = 'coalesce-tracker';

    public constructor() {
        super({ type: 'android', action: 'coalesce-tracker' } as ParamsDeviceTracker, 'ws://test/');
    }

    protected buildDeviceRow(tbody: Element, device: BaseDeviceDescriptor): void {
        const row = document.createElement('div');
        row.setAttribute('data-state', device.state);
        tbody.appendChild(row);
    }

    protected override fetchRowContext(): Promise<unknown> {
        return fetch('/api/devices/labels').then((r) => r.json());
    }

    protected onSocketOpen(): void {
        // no-op
    }

    public setDescriptors(list: BaseDeviceDescriptor[]): void {
        this.descriptors = list;
    }

    public refresh(): Promise<void> {
        return this.refreshDeviceTable();
    }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('BaseDeviceTracker refresh coalescing (#34)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
    });

    it('coalesces concurrent refreshes — an in-flight refresh causes at most ONE re-run', async () => {
        const resolvers: Array<(v: unknown) => void> = [];
        const fetchMock = vi.fn(
            () =>
                new Promise<unknown>((resolve) => {
                    resolvers.push(resolve);
                }),
        );
        vi.stubGlobal('fetch', fetchMock);

        const tracker = new CoalesceTracker();
        tracker.setDescriptors([{ udid: 'A', state: 'device' } as BaseDeviceDescriptor]);

        // Three refreshes fired back-to-back; only the first starts its fetch,
        // the other two collapse into a single pending re-run.
        const p1 = tracker.refresh();
        const p2 = tracker.refresh();
        const p3 = tracker.refresh();
        await tick();
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Finish the in-flight refresh → exactly one coalesced re-run fires.
        resolvers[0]!({ json: async () => ({}) });
        await tick();
        expect(fetchMock).toHaveBeenCalledTimes(2);

        // Finish the re-run → nothing further scheduled.
        resolvers[1]!({ json: async () => ({}) });
        await Promise.all([p1, p2, p3]);
        await tick();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
