// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScanProgressChip } from '../ScanProgressChip';

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
});

function labelOf(parent: HTMLElement): string {
    const label = parent.querySelector('.scan-progress-chip > span');
    return label?.textContent ?? '';
}

describe('ScanProgressChip — drain minimum display 1200ms', () => {
    it('holds draining label for 1200ms when cancelled arrives early', () => {
        const parent = document.createElement('div');
        document.body.appendChild(parent);
        const chip = new ScanProgressChip({ parent, onCancel: vi.fn() });

        chip.setDraining();
        vi.advanceTimersByTime(200);
        expect(labelOf(parent)).toContain('Finishing active scans');

        chip.setCancelled(3);
        // Cancelled came in after only 200ms of draining — chip should still show draining
        expect(labelOf(parent)).toContain('Finishing active scans');

        // Advance to 1199ms total drain time — still draining
        vi.advanceTimersByTime(999);
        expect(labelOf(parent)).toContain('Finishing active scans');

        // Cross the 1200ms boundary — now cancelled
        vi.advanceTimersByTime(1);
        expect(labelOf(parent)).toContain('Scan cancelled');
        expect(labelOf(parent)).toContain('3 devices found');
    });

    it('transitions to cancelled immediately when draining already exceeded 1200ms', () => {
        const parent = document.createElement('div');
        document.body.appendChild(parent);
        const chip = new ScanProgressChip({ parent, onCancel: vi.fn() });

        chip.setDraining();
        vi.advanceTimersByTime(1500);
        chip.setCancelled(2);

        // Drain already ran past 1200ms — no extra delay
        expect(labelOf(parent)).toContain('Scan cancelled');
        expect(labelOf(parent)).toContain('2 devices found');
    });

    it('ignores progress updates once drain starts (label stays on "Finishing")', () => {
        const parent = document.createElement('div');
        document.body.appendChild(parent);
        const chip = new ScanProgressChip({ parent, onCancel: vi.fn() });

        chip.setScanning(50, 200, 1);
        expect(labelOf(parent)).toContain('Scanning network');

        chip.setDraining();
        expect(labelOf(parent)).toContain('Finishing active scans');

        // Server keeps emitting scan.progress during drain — must NOT overwrite the label
        chip.setScanning(120, 200, 2);
        expect(labelOf(parent)).toContain('Finishing active scans');
        expect(labelOf(parent)).not.toContain('Scanning network');

        chip.setScanning(180, 200, 3);
        expect(labelOf(parent)).toContain('Finishing active scans');
    });

    it('handles setCancelled with no prior setDraining (no hang)', () => {
        const parent = document.createElement('div');
        document.body.appendChild(parent);
        const chip = new ScanProgressChip({ parent, onCancel: vi.fn() });

        chip.setCancelled(1);
        // No draining ever started — cancel must display immediately
        expect(labelOf(parent)).toContain('Scan cancelled');
        expect(labelOf(parent)).toContain('1 device found');
    });
});
