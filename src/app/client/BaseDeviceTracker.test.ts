// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseDeviceDescriptor } from '../../types/BaseDeviceDescriptor';
import type { ParamsDeviceTracker } from '../../types/ParamsDeviceTracker';
import { BaseDeviceTracker } from './BaseDeviceTracker';

// Minimal concrete subclass. BaseDeviceTracker is abstract — it requires
// buildDeviceRow plus the ManagerClient abstract socket hooks. The
// ManagerClient constructor only builds the URL (no socket opened until
// openNewConnection() is called), and the BaseDeviceTracker constructor does
// not open a connection, so this is safe to instantiate without a real
// WebSocket. We stub openNewConnection so the reconnect timer's callback is
// observable.
class TestTracker extends BaseDeviceTracker<BaseDeviceDescriptor, never> {
    public openCount = 0;
    public buildRowCount = 0;

    public static override readonly ACTION = 'test-tracker';

    public constructor() {
        super({ type: 'android', action: 'test-tracker' } as ParamsDeviceTracker, 'ws://test/');
    }

    // Build a simple identifiable row. The base is responsible for tagging it
    // with data-udid and inserting it via the diff/patch path.
    protected buildDeviceRow(tbody: Element, device: BaseDeviceDescriptor, context?: unknown): void {
        this.buildRowCount++;
        const row = document.createElement('div');
        row.className = 'device';
        row.setAttribute('data-state', device.state);
        if (context && typeof context === 'object') {
            const label = (context as Record<string, string>)[device.udid];
            if (label) {
                row.setAttribute('data-label', label);
            }
        }
        tbody.appendChild(row);
    }

    // Part A seam: fetched ONCE per table refresh, not once per row.
    protected override fetchRowContext(): Promise<unknown> {
        return fetch('/api/devices/labels').then((r) => r.json());
    }

    protected onSocketOpen(): void {
        // no-op
    }

    protected override openNewConnection(): never {
        this.openCount++;
        return undefined as never;
    }

    public callOnSocketClose(): void {
        this.onSocketClose({ reason: 'test' } as CloseEvent);
    }

    // Test helpers
    public setDescriptors(list: BaseDeviceDescriptor[]): void {
        this.descriptors = list;
    }

    public refresh(): Promise<void> {
        return this.refreshDeviceTable();
    }

    public getBlock(): HTMLElement | null {
        return document.getElementById(this.elementId);
    }
}

describe('BaseDeviceTracker reconnect timer lifecycle (#35)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('does NOT reconnect after destroy() even once the 2s timer would fire', () => {
        const tracker = new TestTracker();
        tracker.callOnSocketClose();
        tracker.destroy();
        vi.advanceTimersByTime(5000);
        expect(tracker.openCount).toBe(0);
    });

    it('reconnects after 2s when NOT destroyed', () => {
        const tracker = new TestTracker();
        tracker.callOnSocketClose();
        vi.advanceTimersByTime(2000);
        expect(tracker.openCount).toBe(1);
        tracker.destroy();
    });
});

const devA: BaseDeviceDescriptor = { udid: 'A', state: 'device' };
const devB: BaseDeviceDescriptor = { udid: 'B', state: 'device' };
const devC: BaseDeviceDescriptor = { udid: 'C', state: 'device' };

describe('BaseDeviceTracker label-fetch caching (#34 Part A)', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ A: 'Alpha', B: 'Bravo' }) });
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
    });

    it('fetches /api/devices/labels ONCE per refresh, not once per row', async () => {
        const tracker = new TestTracker();
        tracker.setDescriptors([devA, devB]);

        await tracker.refresh();
        // 2 devices, but only ONE labels fetch for the whole refresh.
        const labelCalls = fetchMock.mock.calls.filter((c) => c[0] === '/api/devices/labels');
        expect(labelCalls).toHaveLength(1);

        // Second refresh → one more fetch (one per build).
        await tracker.refresh();
        const labelCalls2 = fetchMock.mock.calls.filter((c) => c[0] === '/api/devices/labels');
        expect(labelCalls2).toHaveLength(2);

        tracker.destroy();
    });

    it('passes the fetched label map into row building', async () => {
        const tracker = new TestTracker();
        tracker.setDescriptors([devA, devB]);
        await tracker.refresh();

        const block = tracker.getBlock();
        const rowA = block?.querySelector('[data-udid="A"]');
        const rowB = block?.querySelector('[data-udid="B"]');
        expect(rowA?.getAttribute('data-label')).toBe('Alpha');
        expect(rowB?.getAttribute('data-label')).toBe('Bravo');

        tracker.destroy();
    });
});

describe('BaseDeviceTracker diff/patch by udid (#34 Part B)', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
    });

    it('preserves the SAME DOM node for an unchanged device across rebuilds', async () => {
        const tracker = new TestTracker();
        tracker.setDescriptors([devA, devB]);
        await tracker.refresh();

        const block = tracker.getBlock()!;
        const rowABefore = block.querySelector('[data-udid="A"]');
        const rowBBefore = block.querySelector('[data-udid="B"]');
        expect(rowABefore).not.toBeNull();
        expect(rowBBefore).not.toBeNull();

        // Rebuild with [A, C]: A unchanged, B removed, C added.
        tracker.setDescriptors([devA, devC]);
        await tracker.refresh();

        const rowAAfter = block.querySelector('[data-udid="A"]');
        const rowBAfter = block.querySelector('[data-udid="B"]');
        const rowCAfter = block.querySelector('[data-udid="C"]');

        // A's node is the SAME object (not recreated).
        expect(rowAAfter).toBe(rowABefore);
        // B removed.
        expect(rowBAfter).toBeNull();
        // C added.
        expect(rowCAfter).not.toBeNull();
    });

    it('does NOT rebuild every row on every refresh (unchanged rows are not re-built)', async () => {
        const tracker = new TestTracker();
        tracker.setDescriptors([devA, devB]);
        await tracker.refresh();
        const builtAfterFirst = tracker.buildRowCount;
        expect(builtAfterFirst).toBe(2);

        // Identical descriptors → no rows rebuilt.
        tracker.setDescriptors([
            { udid: 'A', state: 'device' },
            { udid: 'B', state: 'device' },
        ]);
        await tracker.refresh();
        expect(tracker.buildRowCount).toBe(builtAfterFirst);

        tracker.destroy();
    });

    it('rebuilds a row in place when its descriptor changed', async () => {
        const tracker = new TestTracker();
        tracker.setDescriptors([devA]);
        await tracker.refresh();
        const block = tracker.getBlock()!;
        expect(block.querySelector('[data-udid="A"]')?.getAttribute('data-state')).toBe('device');

        // Same udid, different state → row updated in place.
        tracker.setDescriptors([{ udid: 'A', state: 'offline' }]);
        await tracker.refresh();
        expect(block.querySelector('[data-udid="A"]')?.getAttribute('data-state')).toBe('offline');
        // Still exactly one A row.
        expect(block.querySelectorAll('[data-udid="A"]')).toHaveLength(1);

        tracker.destroy();
    });

    it('orders rows to match the descriptor list', async () => {
        const tracker = new TestTracker();
        tracker.setDescriptors([devA, devB]);
        await tracker.refresh();

        // Reverse order plus a new device.
        tracker.setDescriptors([devC, devB, devA]);
        await tracker.refresh();

        const block = tracker.getBlock()!;
        const udids = Array.from(block.querySelectorAll('[data-udid]')).map((el) => el.getAttribute('data-udid'));
        expect(udids).toEqual(['C', 'B', 'A']);

        tracker.destroy();
    });

    it('shows the empty-state card when there are no devices', async () => {
        const tracker = new TestTracker();
        tracker.setDescriptors([devA]);
        await tracker.refresh();
        const block = tracker.getBlock()!;
        expect(block.querySelector('[data-udid="A"]')).not.toBeNull();

        tracker.setDescriptors([]);
        await tracker.refresh();
        expect(block.querySelector('[data-udid="A"]')).toBeNull();
        expect(block.querySelector('.empty-state-card')).not.toBeNull();

        tracker.destroy();
    });
});
