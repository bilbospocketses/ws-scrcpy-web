import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeviceLabelStore } from '../DeviceLabelStore';

const TEST_FILE = path.resolve(__dirname, '..', '..', '..', 'test-device-labels.json');

describe('DeviceLabelStore', () => {
    beforeEach(() => {
        try {
            fs.unlinkSync(TEST_FILE);
        } catch {}
        DeviceLabelStore.resetInstance();
    });

    afterEach(() => {
        try {
            fs.unlinkSync(TEST_FILE);
        } catch {}
    });

    it('returns undefined for unknown serial', () => {
        const store = DeviceLabelStore.getInstance(TEST_FILE);
        expect(store.get('UNKNOWN')).toBeUndefined();
    });

    it('sets and gets a label', () => {
        const store = DeviceLabelStore.getInstance(TEST_FILE);
        store.set('SERIAL1', 'Living Room TV');
        expect(store.get('SERIAL1')).toBe('Living Room TV');
    });

    it('persists to disk', () => {
        const store = DeviceLabelStore.getInstance(TEST_FILE);
        store.set('SERIAL1', 'Living Room TV');
        const raw = JSON.parse(fs.readFileSync(TEST_FILE, 'utf-8'));
        expect(raw['SERIAL1']).toBe('Living Room TV');
    });

    it('loads existing file on init', () => {
        fs.writeFileSync(TEST_FILE, JSON.stringify({ S1: 'TV' }));
        const store = DeviceLabelStore.getInstance(TEST_FILE);
        expect(store.get('S1')).toBe('TV');
    });

    it('deletes a label', () => {
        const store = DeviceLabelStore.getInstance(TEST_FILE);
        store.set('SERIAL1', 'TV');
        store.delete('SERIAL1');
        expect(store.get('SERIAL1')).toBeUndefined();
    });

    it('getAll returns all labels', () => {
        const store = DeviceLabelStore.getInstance(TEST_FILE);
        store.set('S1', 'TV1');
        store.set('S2', 'TV2');
        expect(store.getAll()).toEqual({ S1: 'TV1', S2: 'TV2' });
    });

    it('handles missing file gracefully', () => {
        const store = DeviceLabelStore.getInstance(TEST_FILE);
        expect(store.getAll()).toEqual({});
    });
});
