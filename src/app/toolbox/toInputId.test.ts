import { describe, expect, it } from 'vitest';
import { toInputId } from './toInputId';

describe('toInputId', () => {
    it('lowercases and replaces a single space', () => {
        expect(toInputId('Power Off')).toBe('power_off');
    });

    it('replaces every whitespace run, not just the first space (#89)', () => {
        expect(toInputId('Switch To TV')).toBe('switch_to_tv');
    });
});
