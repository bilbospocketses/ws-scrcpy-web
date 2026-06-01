// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { UpgradingOverlay } from '../UpgradingOverlay';

describe('UpgradingOverlay', () => {
    it('mounts, shows the applying message, swaps to timeout copy, and removes', () => {
        const o = new UpgradingOverlay();
        o.mount();
        const el = document.querySelector('.upgrading-overlay');
        expect(el).not.toBeNull();
        expect(el!.textContent).toContain('updating');

        o.setState('timeout', 'http://localhost:8000/');
        expect(document.querySelector('.upgrading-overlay')!.textContent).toContain('http://localhost:8000/');

        o.remove();
        expect(document.querySelector('.upgrading-overlay')).toBeNull();
    });

    it('mount() is idempotent (no duplicate overlay)', () => {
        const o = new UpgradingOverlay();
        o.mount();
        o.mount();
        expect(document.querySelectorAll('.upgrading-overlay')).toHaveLength(1);
        o.remove();
    });
});
