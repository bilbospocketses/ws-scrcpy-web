/**
 * Which live WebSockets belong to which login.
 *
 * Deleting a session row stops the *next* connection — `wsSessionUserId` fails
 * closed and the handshake is refused with 4401, which rows 18.9 and 18.10
 * prove. It did nothing to the sockets the SPA had already opened, so a stream
 * begun before logout kept running afterwards: the security boundary behaved
 * differently from the way the UI describes it (finding 18.14).
 *
 * A socket is registered with the session token that authorised it, so logging
 * out can revoke exactly that login's sockets and leave a second browser's
 * alone. Sockets opened in open mode carry no token and are never revoked by
 * logout — there was no login to end.
 */

/** The half of a WebSocket this registry needs. Keeps it testable without a live socket. */
export interface ClosableSocket {
    close(code?: number, reason?: string): void;
}

/** Close code for a socket whose login ended underneath it. Matches the handshake refusal. */
export const WS_SESSION_REVOKED = 4401;

export class SocketRegistry {
    private byToken = new Map<string, Set<ClosableSocket>>();
    private byUser = new Map<number, Set<ClosableSocket>>();

    /** Track a socket. `token` is absent in open mode, where there is no session to revoke. */
    add(socket: ClosableSocket, userId: number, token?: string | undefined): void {
        addTo(this.byUser, userId, socket);
        if (token) addTo(this.byToken, token, socket);
    }

    /** Stop tracking a socket that has closed on its own. */
    remove(socket: ClosableSocket): void {
        removeFrom(this.byUser, socket);
        removeFrom(this.byToken, socket);
    }

    /** Close every socket authorised by this session. Returns how many were closed. */
    revokeSession(token: string): number {
        return this.closeAll(this.byToken.get(token));
    }

    /**
     * Close every socket belonging to this user, whichever session opened it.
     * For deleting or disabling an account, where no single token is the answer.
     */
    revokeUser(userId: number): number {
        return this.closeAll(this.byUser.get(userId));
    }

    /** Live socket count, for tests and diagnostics. */
    size(): number {
        let n = 0;
        for (const set of this.byUser.values()) n += set.size;
        return n;
    }

    private closeAll(sockets: Set<ClosableSocket> | undefined): number {
        if (!sockets) return 0;
        // Copy first: close() synchronously fires the 'close' handler that calls
        // remove(), which mutates the very set being iterated.
        const doomed = Array.from(sockets);
        for (const socket of doomed) {
            try {
                socket.close(WS_SESSION_REVOKED, 'session ended');
            } catch {
                // A socket already tearing down is not a failure to revoke it.
            }
            this.remove(socket);
        }
        return doomed.length;
    }
}

function addTo<K>(map: Map<K, Set<ClosableSocket>>, key: K, socket: ClosableSocket): void {
    const set = map.get(key);
    if (set) set.add(socket);
    else map.set(key, new Set([socket]));
}

function removeFrom<K>(map: Map<K, Set<ClosableSocket>>, socket: ClosableSocket): void {
    for (const [key, set] of map) {
        if (set.delete(socket) && set.size === 0) map.delete(key);
    }
}
