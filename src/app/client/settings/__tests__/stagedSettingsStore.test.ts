import { beforeEach, describe, expect, it } from 'vitest';
import { StagedSettingsStore } from '../StagedSettingsStore';

let store: StagedSettingsStore;

beforeEach(() => {
    store = new StagedSettingsStore();
    store.register({ id: 'webPort', label: 'Web port', initial: 8000 });
    store.register({ id: 'channel', label: 'Update channel', initial: 'stable' });
});

describe('StagedSettingsStore', () => {
    it('is clean before anything is edited', () => {
        expect(store.isDirty()).toBe(false);
        expect(store.changes()).toEqual([]);
    });

    it('reports a change as from → to once edited', () => {
        store.set('webPort', 8010);
        expect(store.isDirty()).toBe(true);
        expect(store.changes()).toEqual([{ id: 'webPort', label: 'Web port', from: 8000, to: 8010 }]);
    });

    it('setting a value back to its initial clears the change', () => {
        store.set('webPort', 8010);
        store.set('webPort', 8000);
        expect(store.isDirty()).toBe(false);
        expect(store.changes()).toEqual([]);
    });

    it('never reports a field nobody registered — this is what keeps ACTIONS out of the summary', () => {
        store.set('installService', true);
        expect(store.changes().map((c) => c.id)).toEqual([]);
        expect(store.isDirty()).toBe(false);
        expect(store.get('installService')).toBeUndefined();
    });

    it('reset() restores every field to its initial', () => {
        store.set('webPort', 8010);
        store.set('channel', 'beta');
        store.reset();
        expect(store.isDirty()).toBe(false);
        expect(store.get('webPort')).toBe(8000);
    });

    it('puts format() in the TEXT fields and leaves the values raw', () => {
        store.register({
            id: 'autoUpdate',
            label: 'Automatic updates',
            initial: true,
            format: (v) => (v ? 'on' : 'off'),
        });
        store.set('autoUpdate', false);
        expect(store.changes()).toContainEqual({
            id: 'autoUpdate',
            label: 'Automatic updates',
            from: true,
            to: false,
            fromText: 'on',
            toText: 'off',
        });
    });

    /**
     * The regression this file used to assert the WRONG way round: it pinned
     * `to: 'off'` as correct, so the one field with a formatter was the one
     * field the server could never accept. `toEqual` above would catch a
     * reversion, but only by way of a whole-object mismatch; this says the
     * actual rule out loud, in the terms `validateField` uses.
     */
    it('a boolean field stays a boolean — the server validates the TYPE', () => {
        store.register({
            id: 'autoUpdate',
            label: 'Automatic updates',
            initial: true,
            format: (v) => (v ? 'on' : 'off'),
        });
        store.set('autoUpdate', false);
        const change = store.changes().find((c) => c.id === 'autoUpdate');
        expect(typeof change?.to).toBe('boolean');
        expect(typeof change?.from).toBe('boolean');
    });

    it('omits the text fields entirely for a field with no formatter', () => {
        store.set('webPort', 8010);
        const change = store.changes().find((c) => c.id === 'webPort');
        expect(change).not.toHaveProperty('fromText');
        expect(change).not.toHaveProperty('toText');
    });
});
