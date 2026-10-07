/**
 * The stream sessions that are open right now, so a deliberate stop can end
 * them CLEANLY.
 *
 * Stopping the server ("stop server & exit", the tray's exit, SIGINT/SIGTERM,
 * an exit-75 restart, an update's apply) runs `adb kill-server`, which takes
 * the adb shell running each session's scrcpy-server down with it. A session
 * still open then ran its crash path, and the viewer got `4005 scrcpy-server
 * exited (...)` -- or 1006, when the WebSocket server's terminate reached the
 * socket first -- and saw "stream failed" for ~4 s over a stop they asked for.
 *
 * Nothing else tracks these sessions: `WebSocketServer` hands each socket to
 * the middleware and keeps no handle on what it created. Module-level for the
 * same reason as `liveSockets` (WebSocketServer.ts): the stop paths live in
 * index.ts, UpdateService, DependencyManager and restartRequest, and none of
 * them holds the server.
 */

/** Going Away: the browser's stream client treats it as a normal end. */
export const SHUTDOWN_CLOSE_CODE = 1001;
export const SHUTDOWN_CLOSE_REASON = 'server shutting down';

/** The half of a stream session this registry needs. Keeps it testable without a device. */
export interface ShutdownClosable {
    /** Close the session's socket with 1001 and release it, so no failure path fires afterwards. */
    closeForShutdown(): void;
}

export class StreamRegistry {
    private sessions = new Set<ShutdownClosable>();
    /** Set by closeAllForShutdown; see isStopping(). */
    private stopping = false;

    add(session: ShutdownClosable): void {
        this.sessions.add(session);
    }

    /** Stop tracking a session that has been released. */
    remove(session: ShutdownClosable): void {
        this.sessions.delete(session);
    }

    /** Open session count, for tests and diagnostics. */
    size(): number {
        return this.sessions.size;
    }

    /**
     * True once a deliberate stop has closed the open sessions. The WebSocket
     * server keeps accepting until it is released, a beat later, and a session
     * opened in that window would launch scrcpy-server just in time for
     * `adb kill-server` to kill it -- "stream failed" again. While this is
     * true, `ScrcpyConnection.processRequest` refuses a new session with 1001.
     */
    isStopping(): boolean {
        return this.stopping;
    }

    /**
     * Accept new sessions again after a stop that did not happen. The one case:
     * an update apply that fails after its pre-apply step closed the streams
     * leaves this process running (UpdateService.applyUpdate). Every other stop
     * ends in process exit, and a restart is a new process.
     */
    cancelStop(): void {
        this.stopping = false;
    }

    /**
     * Close every open session for a deliberate stop. Returns how many were
     * closed. Run it BEFORE `adb kill-server`, so each session is already
     * released when its scrcpy-server dies. From here on no new session
     * starts (isStopping()).
     */
    closeAllForShutdown(): number {
        this.stopping = true;
        // Copy first: closeForShutdown() releases the session, and release
        // calls remove(), which mutates the very set being iterated.
        const doomed = Array.from(this.sessions);
        for (const session of doomed) {
            try {
                session.closeForShutdown();
            } catch {
                // One session failing to close must not keep the rest open.
            }
            this.remove(session);
        }
        return doomed.length;
    }
}

export const liveStreams = new StreamRegistry();
