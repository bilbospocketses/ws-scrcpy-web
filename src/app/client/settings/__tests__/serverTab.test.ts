// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { StagedSettingsStore } from '../StagedSettingsStore';
import { buildServerTab } from '../tabs/ServerTab';

const ctx = { role: 'admin' as const, authEnabled: false, reload: () => undefined };

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
        const labels = [...el.querySelectorAll('button')].map((b) => b.textContent);
        expect(labels).not.toContain('Save');
    });
});
