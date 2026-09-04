import { describe, expect, it, vi } from 'vitest';
import { SocketRegistry, WS_SESSION_REVOKED } from '../auth/socketRegistry';

/**
 * Finding 18.14 — deleting a session row refuses the *next* connection with
 * 4401 (rows 18.9 and 18.10 prove that), but nothing tore down the sockets the
 * SPA had already opened. A stream begun before logout kept running after it,
 * so the security boundary behaved differently from the way the UI describes
 * it. The decision taken here is that a session's sockets die with it.
 */

function fakeSocket() {
    return { close: vi.fn() };
}

describe('SocketRegistry', () => {
    it('closes the sockets of the session that logged out', () => {
        const reg = new SocketRegistry();
        const a = fakeSocket();
        const b = fakeSocket();
        reg.add(a, 7, 'token-a');
        reg.add(b, 7, 'token-a');

        expect(reg.revokeSession('token-a')).toBe(2);
        expect(a.close).toHaveBeenCalledWith(WS_SESSION_REVOKED, 'session ended');
        expect(b.close).toHaveBeenCalledWith(WS_SESSION_REVOKED, 'session ended');
        expect(reg.size()).toBe(0);
    });

    it("leaves another browser's session alone", () => {
        // Logging out of one browser must not kill a stream in another.
        const reg = new SocketRegistry();
        const mine = fakeSocket();
        const other = fakeSocket();
        reg.add(mine, 7, 'token-a');
        reg.add(other, 7, 'token-b');

        expect(reg.revokeSession('token-a')).toBe(1);
        expect(other.close).not.toHaveBeenCalled();
        expect(reg.size()).toBe(1);
    });

    it('closes every socket of a user, whichever session opened it', () => {
        // Deleting or disabling an account has no single token to revoke.
        const reg = new SocketRegistry();
        const one = fakeSocket();
        const two = fakeSocket();
        reg.add(one, 7, 'token-a');
        reg.add(two, 7, 'token-b');

        expect(reg.revokeUser(7)).toBe(2);
        expect(reg.size()).toBe(0);
    });

    it('does not touch a different user', () => {
        const reg = new SocketRegistry();
        const theirs = fakeSocket();
        reg.add(fakeSocket(), 7, 'token-a');
        reg.add(theirs, 8, 'token-b');

        reg.revokeUser(7);
        expect(theirs.close).not.toHaveBeenCalled();
        expect(reg.size()).toBe(1);
    });

    it('tracks open-mode sockets by user but never revokes them by session', () => {
        // No login happened, so there is no login to end.
        const reg = new SocketRegistry();
        const s = fakeSocket();
        reg.add(s, 1);

        expect(reg.revokeSession('anything')).toBe(0);
        expect(s.close).not.toHaveBeenCalled();
        expect(reg.revokeUser(1)).toBe(1);
    });

    it('forgets a socket that closed on its own', () => {
        const reg = new SocketRegistry();
        const s = fakeSocket();
        reg.add(s, 7, 'token-a');

        reg.remove(s);

        expect(reg.size()).toBe(0);
        expect(reg.revokeSession('token-a')).toBe(0);
        expect(s.close).not.toHaveBeenCalled();
    });

    it('survives a socket whose close() throws, and still revokes the rest', () => {
        const reg = new SocketRegistry();
        const bad = {
            close: vi.fn(() => {
                throw new Error('already destroyed');
            }),
        };
        const good = fakeSocket();
        reg.add(bad, 7, 'token-a');
        reg.add(good, 7, 'token-a');

        expect(reg.revokeSession('token-a')).toBe(2);
        expect(good.close).toHaveBeenCalled();
        expect(reg.size()).toBe(0);
    });

    it('is unbothered by a close handler that removes during iteration', () => {
        // close() synchronously fires the 'close' handler, which calls remove()
        // on the very set being iterated. Copying first is what makes this safe.
        const reg = new SocketRegistry();
        const a: { close: (c?: number, r?: string) => void } = { close: () => reg.remove(a) };
        const b: { close: (c?: number, r?: string) => void } = { close: () => reg.remove(b) };
        reg.add(a, 7, 'token-a');
        reg.add(b, 7, 'token-a');

        expect(reg.revokeSession('token-a')).toBe(2);
        expect(reg.size()).toBe(0);
    });
});
