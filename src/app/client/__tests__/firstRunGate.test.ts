// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    getBookmarkDismissedPort,
    resetAllDismissals,
    setBookmarkDismissedPort,
} from '../firstRunGate';

describe('firstRunGate', () => {
    beforeEach(() => {
        window.localStorage.clear();
    });

    afterEach(() => {
        window.localStorage.clear();
    });

    describe('bookmarkDismissedPort flag', () => {
        it('returns null when never set', () => {
            expect(getBookmarkDismissedPort()).toBeNull();
        });

        it('returns the saved port number', () => {
            setBookmarkDismissedPort(8123);
            expect(getBookmarkDismissedPort()).toBe(8123);
        });

        it('returns null for non-numeric stored values (defensive)', () => {
            window.localStorage.setItem('wsScrcpy.bookmarkDismissedForPort', 'abc');
            expect(getBookmarkDismissedPort()).toBeNull();
        });

        it('overwrites with the most recent port', () => {
            setBookmarkDismissedPort(8000);
            setBookmarkDismissedPort(9090);
            expect(getBookmarkDismissedPort()).toBe(9090);
        });

        it('mismatching saved port vs current is the trigger to re-show modal', () => {
            setBookmarkDismissedPort(8000);
            const currentPort = 9090;
            expect(getBookmarkDismissedPort() !== currentPort).toBe(true);
        });
    });

    describe('resetAllDismissals', () => {
        it('clears bookmark flag', () => {
            setBookmarkDismissedPort(8000);
            resetAllDismissals();
            expect(getBookmarkDismissedPort()).toBeNull();
        });

        it('does not touch unrelated localStorage keys', () => {
            window.localStorage.setItem('audio.preferredBitrate', '128');
            window.localStorage.setItem('theme.mode', 'dark');
            setBookmarkDismissedPort(8000);

            resetAllDismissals();

            expect(window.localStorage.getItem('audio.preferredBitrate')).toBe('128');
            expect(window.localStorage.getItem('theme.mode')).toBe('dark');
        });

        it('is idempotent — calling on a clean state is a no-op', () => {
            expect(() => resetAllDismissals()).not.toThrow();
        });
    });
});
