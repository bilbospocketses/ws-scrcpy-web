import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTION } from '../../common/Action';

/**
 * Smoke row 8.27: a stream that FAILS mid-session has to say so. The browser
 * can only tell a failure from a normal end by the WebSocket close code, and
 * every mid-stream failure (scrcpy-server exiting, the device's video ending)
 * used to run the same bare `ws.close()` as a normal release — which the
 * browser receives as 1005, a normal end, so the modal just vanished.
 *
 * Failure paths now close with SESSION_FAILED_CLOSE_CODE and a reason. Normal
 * paths (the browser went away, the server released the session) keep the bare
 * close.
 */

const h = vi.hoisted(() => ({ children: [] as unknown[] }));

vi.mock('../AdbClient', () => {
    class AdbClient {
        shellSpawn() {
            const child = Object.assign(new EventEmitter(), {
                stdout: new EventEmitter(),
                stderr: new EventEmitter(),
                killed: false,
                kill() {
                    child.killed = true;
                    return true;
                },
            });
            h.children.push(child);
            return child;
        }
        removeReverse = () => Promise.resolve();
        removeForward = () => Promise.resolve();
    }
    return { AdbClient };
});

vi.mock('../Config', () => ({
    Config: { getInstance: () => ({ adbPath: 'adb', dependenciesPath: '/deps' }) },
}));

vi.mock('../goog-device/services/ControlCenter', () => ({
    ControlCenter: { hasInstance: () => false },
}));

vi.mock('../scrcpyServerVersion', () => ({ getInstalledScrcpyServerVersion: () => '4.0' }));

vi.mock('../Logger', () => {
    const quiet = { info() {}, warn() {}, error() {}, debug() {} };
    return { Logger: { for: () => quiet } };
});

import { liveStreams, SHUTDOWN_CLOSE_CODE, SHUTDOWN_CLOSE_REASON } from '../liveStreams';
import { closeReason, ScrcpyConnection, SESSION_FAILED_CLOSE_CODE } from '../ScrcpyConnection';
import { runGracefulShutdown } from '../shutdownHelpers';

class FakeWs extends EventEmitter {
    public readonly CONNECTING = 0;
    public readonly OPEN = 1;
    public readonly CLOSING = 2;
    public readonly CLOSED = 3;
    public readyState = 1;
    public bufferedAmount = 0;
    public close = vi.fn((_code?: number, _reason?: string) => {
        this.readyState = this.CLOSING;
    });
    public send = vi.fn();
    public terminate = vi.fn();
    addEventListener(type: string, listener: (...args: unknown[]) => void): void {
        this.on(type, listener);
    }
}

class FakeSocket extends EventEmitter {
    public destroyed = false;
    destroy(): void {
        this.destroyed = true;
    }
    write(): boolean {
        return true;
    }
}

type Internals = {
    launchServer(options: unknown): void;
    buildOptions(): unknown;
    startForwarding(): void;
    videoSocket?: FakeSocket;
    audioSocket?: FakeSocket;
    controlSocket?: FakeSocket;
};

let ws: FakeWs;
let connection: ScrcpyConnection;
let startSpy: ReturnType<typeof vi.spyOn>;

function open(): Internals {
    const created = ScrcpyConnection.processRequest(ws as never, {
        action: ACTION.STREAM_SCRCPY,
        url: new URL('http://localhost/?action=stream&udid=device-1'),
        request: {} as never,
    });
    expect(created).toBeDefined();
    connection = created!;
    return connection as unknown as Internals;
}

/** Launch scrcpy-server and wire the device sockets, as a successful start does. */
function live(): { internals: Internals; child: EventEmitter; video: FakeSocket } {
    const internals = open();
    internals.launchServer(internals.buildOptions());
    internals.videoSocket = new FakeSocket();
    internals.audioSocket = new FakeSocket();
    internals.controlSocket = new FakeSocket();
    internals.startForwarding();
    return { internals, child: h.children[0] as EventEmitter, video: internals.videoSocket };
}

beforeEach(() => {
    h.children.length = 0;
    ws = new FakeWs();
    // The real start() runs adb; these tests drive the session's end paths.
    startSpy = vi
        .spyOn(ScrcpyConnection.prototype as unknown as { start(): Promise<void> }, 'start')
        .mockReturnValue(new Promise<void>(() => {}));
});

afterEach(() => {
    connection?.release();
    // The registry is module-level; a test that stops the server must not
    // leave the next one refusing sessions.
    liveStreams.cancelStop();
    vi.restoreAllMocks();
});

describe('ScrcpyConnection — failure paths close with a code and a reason', () => {
    it('uses 4005, the code a failed start has always sent', () => {
        expect(SESSION_FAILED_CLOSE_CODE).toBe(4005);
    });

    it('scrcpy-server exiting mid-stream closes with the failure code and says it exited', () => {
        const { child } = live();

        child.emit('exit', 1, null);

        expect(ws.close).toHaveBeenCalledTimes(1);
        expect(ws.close).toHaveBeenCalledWith(SESSION_FAILED_CLOSE_CODE, 'scrcpy-server exited (code 1)');
    });

    it('names the signal when scrcpy-server was killed by one', () => {
        const { child } = live();

        child.emit('exit', null, 'SIGKILL');

        expect(ws.close).toHaveBeenCalledWith(SESSION_FAILED_CLOSE_CODE, 'scrcpy-server exited (signal SIGKILL)');
    });

    it.each(['end', 'error'])(
        'the device video socket ending unexpectedly (%s) closes with the failure code',
        (event) => {
            const { video, child } = live();

            video.emit(event, new Error('ECONNRESET'));
            // The release that follows kills scrcpy-server; its exit must not close again.
            child.emit('exit', null, 'SIGTERM');

            expect(ws.close).toHaveBeenCalledTimes(1);
            expect(ws.close).toHaveBeenCalledWith(SESSION_FAILED_CLOSE_CODE, 'the device stopped sending video');
        },
    );

    it('a failed start still closes with the failure code and the error message', async () => {
        startSpy.mockReturnValue(Promise.reject(new Error('Timeout waiting for 3 TCP connections (got 2)')));
        open();

        await vi.waitFor(() => expect(ws.close).toHaveBeenCalled());

        expect(ws.close).toHaveBeenCalledWith(
            SESSION_FAILED_CLOSE_CODE,
            'Timeout waiting for 3 TCP connections (got 2)',
        );
    });
});

describe('ScrcpyConnection — normal paths keep the plain close', () => {
    it('the browser going away releases without sending a failure, and the exit that follows stays quiet', () => {
        const { child, video } = live();

        ws.readyState = ws.CLOSED;
        ws.emit('close');
        child.emit('exit', null, 'SIGTERM');
        video.emit('end');

        expect(ws.close).not.toHaveBeenCalled();
    });

    it('a release by the server closes with no code', () => {
        const { child } = live();

        connection.release();
        child.emit('exit', null, 'SIGTERM');

        expect(ws.close).toHaveBeenCalledTimes(1);
        expect(ws.close).toHaveBeenCalledWith();
    });
});

/**
 * Stopping the server on purpose is not a stream failure. `adb kill-server`
 * takes scrcpy-server down with it, so a session still open when it ran took
 * its crash path and the viewer saw `stream failed: scrcpy-server exited` for
 * a stop they asked for. The stop now closes every open session with 1001
 * first, which the browser treats as a normal end.
 */
describe('ScrcpyConnection — a deliberate server stop is a clean end', () => {
    it('the graceful shutdown closes a live session with 1001 before kill-server, and the exit that follows stays quiet', async () => {
        const { child } = live();
        const order: string[] = [];
        ws.close.mockImplementation((code?: number, reason?: string) => {
            order.push(`close ${code} ${reason}`);
            ws.readyState = ws.CLOSING;
        });

        await runGracefulShutdown({
            log: { info() {}, warn() {} },
            adbPath: 'adb',
            killAdbServer: async () => {
                order.push('kill-server');
                // What kill-server does to a session's scrcpy-server.
                child.emit('exit', null, 'SIGKILL');
            },
            reapStrayAdb: async () => 0,
            services: [
                {
                    getName: () => 'WebSocket Server Service',
                    release: () => order.push('release WebSocket Server Service'),
                },
            ],
            backupStore: () => order.push('backup store'),
            platform: 'linux',
        });

        expect(order).toEqual([
            `close ${SHUTDOWN_CLOSE_CODE} ${SHUTDOWN_CLOSE_REASON}`,
            'kill-server',
            'release WebSocket Server Service',
            'backup store',
        ]);
        expect(ws.close).not.toHaveBeenCalledWith(SESSION_FAILED_CLOSE_CODE, expect.anything());
    });

    it('closeForShutdown closes with 1001 "server shutting down" and releases the session', () => {
        const { child, video } = live();

        connection.closeForShutdown();
        child.emit('exit', null, 'SIGTERM');
        video.emit('end');

        expect(SHUTDOWN_CLOSE_CODE).toBe(1001);
        expect(ws.close).toHaveBeenCalledTimes(1);
        expect(ws.close).toHaveBeenCalledWith(1001, 'server shutting down');
        expect((child as unknown as { killed: boolean }).killed).toBe(true);
        expect(liveStreams.size()).toBe(0);
    });

    it('a live session is tracked until it is released', () => {
        live();
        expect(liveStreams.size()).toBe(1);

        connection.release();

        expect(liveStreams.size()).toBe(0);
    });

    it('a session opened after the stop has begun ends with 1001 at once and never starts', () => {
        // The window between closeAllForShutdown and the WebSocket server's
        // release: a session started here would launch scrcpy-server just for
        // `adb kill-server` to kill it, and its viewer would see "stream failed".
        liveStreams.closeAllForShutdown();

        const created = ScrcpyConnection.processRequest(ws as never, {
            action: ACTION.STREAM_SCRCPY,
            url: new URL('http://localhost/?action=stream&udid=device-1'),
            request: {} as never,
        });

        expect(created).toBeUndefined();
        expect(ws.close).toHaveBeenCalledTimes(1);
        expect(ws.close).toHaveBeenCalledWith(SHUTDOWN_CLOSE_CODE, SHUTDOWN_CLOSE_REASON);
        expect(startSpy).not.toHaveBeenCalled();
        expect(h.children).toHaveLength(0);
        expect(liveStreams.size()).toBe(0);
    });

    it('a crash while the server keeps running still closes with 4005, and a later stop finds nothing to close', () => {
        const { child } = live();

        child.emit('exit', 1, null);

        expect(ws.close).toHaveBeenCalledWith(SESSION_FAILED_CLOSE_CODE, 'scrcpy-server exited (code 1)');
        expect(liveStreams.closeAllForShutdown()).toBe(0);
        expect(ws.close).toHaveBeenCalledTimes(1);
    });
});

describe('closeReason', () => {
    it('leaves a short reason alone', () => {
        expect(closeReason('scrcpy-server exited (code 1)')).toBe('scrcpy-server exited (code 1)');
    });

    it('cuts a long reason to 123 bytes of UTF-8 without splitting a character', () => {
        const reason = closeReason(`${'a'.repeat(121)}é€`);
        // 121 + 2 bytes (é) = 123; the 3-byte € would cross the limit.
        expect(reason).toBe(`${'a'.repeat(121)}é`);
        expect(Buffer.byteLength(closeReason('€'.repeat(100)), 'utf-8')).toBeLessThanOrEqual(123);
        expect(closeReason('€'.repeat(100))).toBe('€'.repeat(41));
    });
});
