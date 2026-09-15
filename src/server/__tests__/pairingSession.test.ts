import { describe, expect, it } from 'vitest';
import { newSession, type PairingSession, type PairingState } from '../pairing/PairingSession';

const T0 = 1_700_000_000_000;

describe('PairingSession', () => {
    it('starts awaiting-scan in qr mode and carries a service name and password', () => {
        const s = newSession('qr', T0);
        expect(s.state).toBe('awaiting-scan');
        expect(s.serviceName).toMatch(/^wsscrcpy-[a-z2-7]{10}$/);
        expect(s.password).toHaveLength(12);
        expect(s.expiresAt).toBe(T0 + 180_000);
    });

    it('skips awaiting-scan in code mode', () => {
        expect(newSession('code', T0).state).toBe('pairing');
    });

    it('expires exactly at the TTL boundary', () => {
        const s = newSession('qr', T0);
        expect(s.isExpired(T0 + 179_999)).toBe(false);
        expect(s.isExpired(T0 + 180_000)).toBe(true);
    });

    it('reports expired through toStatus without needing a timer', () => {
        const s = newSession('qr', T0);
        expect(s.toStatus(T0 + 200_000).state).toBe('expired');
    });

    it('never reports expired once it has reached a terminal state', () => {
        // A session that PAIRED before the clock ran out is paired, full stop.
        // Reporting it as expired would tell the user to pair a device that is
        // already paired.
        const s = newSession('qr', T0);
        s.markPairing();
        s.markConnecting('SERIAL1', '192.168.1.5:5555');
        s.markPaired();
        expect(s.toStatus(T0 + 200_000).state).toBe('paired');
    });

    it('distinguishes paired-not-connected from failed', () => {
        const s = newSession('qr', T0);
        s.markPairing();
        s.markPairedNotConnected('no connect service found');
        const st = s.toStatus(T0);
        expect(st.state).toBe('paired-not-connected');
        expect(st.message).toContain('no connect service');
    });

    it('never exposes the password through toStatus, in any state', () => {
        // Every state, not just the terminal ones. The wrong implementation this
        // guards against is a later hand adding the QR payload to the status
        // "because the client needs it to render" -- which would only ever be
        // reachable in awaiting-scan, the one state a terminal-only list misses.
        const drives: [PairingState, (s: PairingSession) => void][] = [
            ['awaiting-scan', () => {}],
            ['pairing', (s) => s.markPairing()],
            [
                'connecting',
                (s) => {
                    s.markPairing();
                    s.markConnecting('SERIAL1', '192.168.1.5:5555');
                },
            ],
            ['paired', (s) => s.markPaired()],
            [
                'paired-not-connected',
                (s) => {
                    s.markPairing();
                    s.markPairedNotConnected('x');
                },
            ],
            ['failed', (s) => s.markFailed('boom')],
            ['failed', (s) => s.cancel()],
        ];
        for (const [expected, drive] of drives) {
            const s = newSession('qr', T0);
            drive(s);
            const st = s.toStatus(T0);
            // Assert the drive reached the state it claims, so a guard that
            // silently swallowed a transition cannot leave this loop checking
            // the same state seven times.
            expect(st.state).toBe(expected);
            expect(JSON.stringify(st)).not.toContain(s.password);
        }

        // 'expired' is projected at read time rather than stored, so no drive
        // function can reach it -- it needs its own pass with a later clock.
        const expiring = newSession('qr', T0);
        const expiredStatus = expiring.toStatus(T0 + 200_000);
        expect(expiredStatus.state).toBe('expired');
        expect(JSON.stringify(expiredStatus)).not.toContain(expiring.password);
    });

    it('makes prior work inert once terminal, in both directions', () => {
        // The race: the user cancels mid-`adb pair`, the pair call succeeds
        // anyway, and the driver reports the success it was already committed
        // to. A cancelled session must not come back to life.
        const s = newSession('qr', T0);
        s.cancel();
        s.markPaired();
        expect(s.state).toBe('failed');
        expect(s.message).toBe('cancelled');

        // And the direction cancel() already covered, kept explicit.
        const t = newSession('qr', T0);
        t.markPairing();
        t.markPaired();
        t.cancel();
        expect(t.state).toBe('paired');
    });

    it('refuses a random source too short to fill the draw, rather than emitting a malformed secret', () => {
        // A short buffer would otherwise index past the end, and `alphabet[NaN]`
        // would turn the password into a run of the text "undefined".
        expect(() => newSession('qr', T0, () => Buffer.alloc(4))).toThrow(RangeError);
        expect(() => newSession('qr', T0, () => Buffer.alloc(4))).toThrow(/4 bytes, need at least 16/);
    });

    it('gives two sessions different secrets', () => {
        expect(newSession('qr', T0).password).not.toBe(newSession('qr', T0).password);
    });
});
