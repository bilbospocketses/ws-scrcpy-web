import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    clampScanConcurrency,
    DEFAULT_SCAN_CONCURRENCY,
    MAX_SCAN_CONCURRENCY,
    SERVICE_NOFILE_LIMIT,
} from '../fdBudget';

/**
 * The budget's arithmetic and its two cross-file pins. The numbers in
 * fdBudget.ts are only worth anything if they stay in the relationship its
 * header derives, and if the Rust launcher — which cannot import a TypeScript
 * constant — carries the same one.
 */
describe('fdBudget', () => {
    it('keeps the worst case comfortably inside the limit it grants', () => {
        // The header's derivation, restated as arithmetic so a future edit to
        // either number has to reconcile with it here.
        const base = 32;
        const perTab = 6;
        const perDevice = 8;
        const tabs = 16;
        const devices = 16;
        const worstCase = base + tabs * perTab + devices * perDevice + MAX_SCAN_CONCURRENCY;
        expect(worstCase).toBe(768);
        expect(SERVICE_NOFILE_LIMIT).toBeGreaterThanOrEqual(worstCase * 4);
        // Grantable without privilege on every systemd this app targets: the
        // oldest hard cap in the wild is 4096.
        expect(SERVICE_NOFILE_LIMIT).toBeLessThanOrEqual(4096);
        expect(DEFAULT_SCAN_CONCURRENCY).toBeLessThan(MAX_SCAN_CONCURRENCY);
    });

    it('is the number the Linux launcher raises its soft limit to before spawning Node', () => {
        // launcher/src/spawn.rs cannot import this module, so its constant is
        // pinned here by reading the source. A drift fails this test, not a
        // user's stream.
        const spawnRs = fs.readFileSync(
            path.resolve(__dirname, '..', '..', '..', 'launcher', 'src', 'spawn.rs'),
            'utf8',
        );
        const m = /pub const NOFILE_LIMIT: u64 = (\d+);/.exec(spawnRs);
        expect(m, 'launcher/src/spawn.rs must declare `pub const NOFILE_LIMIT: u64 = <n>;`').not.toBeNull();
        expect(Number(m![1])).toBe(SERVICE_NOFILE_LIMIT);
    });

    describe('clampScanConcurrency', () => {
        it('passes an in-range value through untouched', () => {
            expect(clampScanConcurrency(64)).toEqual({ value: 64, clamped: false });
            expect(clampScanConcurrency(MAX_SCAN_CONCURRENCY)).toEqual({ value: MAX_SCAN_CONCURRENCY, clamped: false });
            expect(clampScanConcurrency(1)).toEqual({ value: 1, clamped: false });
        });

        it('brings anything above the cap down to it, and says so', () => {
            expect(clampScanConcurrency(MAX_SCAN_CONCURRENCY + 1)).toEqual({
                value: MAX_SCAN_CONCURRENCY,
                clamped: true,
            });
            expect(clampScanConcurrency(100_000)).toEqual({ value: MAX_SCAN_CONCURRENCY, clamped: true });
        });

        it('falls back to the default for anything that is not a positive number', () => {
            for (const bad of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
                expect(clampScanConcurrency(bad)).toEqual({ value: DEFAULT_SCAN_CONCURRENCY, clamped: false });
            }
        });

        it('floors a fractional value rather than passing it to a loop counter', () => {
            expect(clampScanConcurrency(12.9)).toEqual({ value: 12, clamped: false });
        });
    });
});
