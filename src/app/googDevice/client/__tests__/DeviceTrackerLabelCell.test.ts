// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceTracker } from '../DeviceTracker';

// §34 Part A: buildLabelCell must NOT fetch /api/devices/labels per row. The
// label map is fetched once per table refresh (fetchRowContext) and injected.
describe('DeviceTracker.buildLabelCell label injection (#34 Part A)', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    it('renders the injected label without fetching per row', async () => {
        const cell = document.createElement('td');
        const labels: Record<string, string> = { 'serial-1': 'Living Room TV' };

        // New signature: (cell, serial, labels)
        (DeviceTracker as any).buildLabelCell(cell, 'serial-1', labels);

        // Let any microtasks settle.
        await Promise.resolve();
        await Promise.resolve();

        const nameText = cell.querySelector('.device-name-text');
        expect(nameText?.textContent).toBe('Living Room TV');
        // The whole point: no per-row label fetch.
        const labelFetches = fetchMock.mock.calls.filter((c) => c[0] === '/api/devices/labels');
        expect(labelFetches).toHaveLength(0);
    });

    it('renders "Unnamed Device" when the serial has no injected label', async () => {
        const cell = document.createElement('td');
        (DeviceTracker as any).buildLabelCell(cell, 'serial-2', { 'serial-1': 'X' });

        await Promise.resolve();
        await Promise.resolve();

        const nameText = cell.querySelector('.device-name-text');
        expect(nameText?.textContent).toBe('Unnamed Device');
        expect(nameText?.classList.contains('unnamed')).toBe(true);
    });
});
