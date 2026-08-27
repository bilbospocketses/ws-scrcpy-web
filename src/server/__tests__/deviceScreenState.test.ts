import { describe, expect, it } from 'vitest';
import { parseScreenState, SCREEN_STATE_COMMAND } from '../deviceScreenState';

/**
 * Real captures from a Pixel 10a (Android 17), taken either side of an unlock
 * while a stream was running. The locked capture is the state in which Android
 * hands scrcpy a black surface and the stream appears broken.
 */
const LOCKED = ['  mWakefulness=Awake', '    isKeyguardShowing=true'].join('\n');
const UNLOCKED = ['  mWakefulness=Awake', '    isKeyguardShowing=false'].join('\n');
const ASLEEP = ['  mWakefulness=Asleep', '    isKeyguardShowing=true'].join('\n');

describe('parseScreenState', () => {
    it('reads a locked-but-awake device, which is the black-screen case', () => {
        // The display is fully on and the user is looking at the lock screen.
        // Capture is black anyway — this is the combination that matters.
        expect(parseScreenState(LOCKED)).toEqual({ awake: true, locked: true });
    });

    it('reads an unlocked device', () => {
        expect(parseScreenState(UNLOCKED)).toEqual({ awake: true, locked: false });
    });

    it('reads a sleeping device', () => {
        expect(parseScreenState(ASLEEP)).toEqual({ awake: false, locked: true });
    });

    it('tolerates the fields arriving in either order', () => {
        const reversed = ['    isKeyguardShowing=true', '  mWakefulness=Awake'].join('\n');
        expect(parseScreenState(reversed)).toEqual({ awake: true, locked: true });
    });

    it('is case-insensitive about the keyguard field name', () => {
        expect(parseScreenState('mWakefulness=Awake\nmIsKeyguardShowing=true').locked).toBe(true);
    });

    it('does not claim "locked" when the keyguard line is missing', () => {
        // This drives a user-facing banner. Telling someone their phone is
        // locked when it is not is worse than staying quiet, so an unparseable
        // dumpsys must read as unlocked.
        expect(parseScreenState('  mWakefulness=Awake')).toEqual({ awake: true, locked: false });
        expect(parseScreenState('')).toEqual({ awake: true, locked: false });
    });

    it('does not claim "asleep" when the wakefulness line is missing', () => {
        expect(parseScreenState('isKeyguardShowing=false').awake).toBe(true);
    });

    it('treats Dreaming and Dozing as not awake', () => {
        expect(parseScreenState('mWakefulness=Dreaming').awake).toBe(false);
        expect(parseScreenState('mWakefulness=Dozing').awake).toBe(false);
    });
});

describe('SCREEN_STATE_COMMAND', () => {
    it('greps on the device so only matched lines cross the wire', () => {
        // `dumpsys window` alone is hundreds of KB; the -m1 greps keep this to
        // two short lines per poll.
        expect(SCREEN_STATE_COMMAND).toContain('grep -m1');
        expect(SCREEN_STATE_COMMAND).toContain('mWakefulness');
        expect(SCREEN_STATE_COMMAND).toContain('isKeyguardShowing');
    });

    it('asks for both readings in a single round trip', () => {
        expect(SCREEN_STATE_COMMAND.split(';')).toHaveLength(2);
    });
});
