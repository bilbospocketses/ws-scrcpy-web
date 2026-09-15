import { describe, expect, it } from 'vitest';
import { newSession, type PairingSession } from '../pairing/PairingSession';

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
        for (const drive of [
            (s: PairingSession) => s.markFailed('boom'),
            (s: PairingSession) => s.markPaired(),
            (s: PairingSession) => s.cancel(),
        ]) {
            const s = newSession('qr', T0);
            drive(s);
            expect(JSON.stringify(s.toStatus(T0))).not.toContain(s.password);
        }
    });

    it('gives two sessions different secrets', () => {
        expect(newSession('qr', T0).password).not.toBe(newSession('qr', T0).password);
    });
});
