import { EventEmitter } from 'events';
import type net from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTION } from '../../common/Action';

/**
 * A session released while its async start() is still running -- the browser
 * left, or the server is stopping -- used to carry on starting: it launched
 * scrcpy-server and opened sockets that nothing released until the process
 * exited, and on a deliberate stop it logged "Failed to start session" at
 * ERROR although nothing had failed.
 *
 * start() now checks after each await whether the session was released, tears
 * down what it created since, and stops quietly. These tests hold one awaited
 * step open, release the session, then let the step finish.
 */

const h = vi.hoisted(() => ({
    children: [] as { killed: boolean }[],
    order: [] as string[],
    errors: [] as string[],
    infos: [] as string[],
    shell: vi.fn<(serial: string, cmd: string) => Promise<string>>(),
    reverse: vi.fn<(serial: string, remote: string, local: string) => Promise<void>>(),
    forward: vi.fn<(serial: string, local: string, remote: string) => Promise<void>>(),
    removeReverse: vi.fn<(serial: string, remote: string) => Promise<void>>(),
    removeForward: vi.fn<(serial: string, local: string) => Promise<void>>(),
    shellSpawn: vi.fn(),
    push: vi.fn<() => Promise<void>>(),
}));

vi.mock('../AdbClient', () => {
    class AdbClient {
        shell = (serial: string, cmd: string) => h.shell(serial, cmd);
        reverse = (serial: string, remote: string, local: string) => h.reverse(serial, remote, local);
        forward = (serial: string, local: string, remote: string) => h.forward(serial, local, remote);
        removeReverse = (serial: string, remote: string) => h.removeReverse(serial, remote);
        removeForward = (serial: string, local: string) => h.removeForward(serial, local);
        shellSpawn = () => h.shellSpawn();
    }
    return { AdbClient };
});

vi.mock('../ensureScrcpyServerPushed', () => ({ ensureScrcpyServerPushed: () => h.push() }));

vi.mock('../Config', () => ({
    Config: { getInstance: () => ({ adbPath: 'adb', dependenciesPath: '/deps' }) },
}));

vi.mock('../goog-device/services/ControlCenter', () => ({
    ControlCenter: { hasInstance: () => false },
}));

vi.mock('../scrcpyServerVersion', () => ({ getInstalledScrcpyServerVersion: () => '4.0' }));

vi.mock('../Logger', () => {
    const text = (args: unknown[]) => args.map(String).join(' ');
    const logger = {
        info: (...args: unknown[]) => h.infos.push(text(args)),
        warn() {},
        error: (...args: unknown[]) => h.errors.push(text(args)),
        debug() {},
    };
    return { Logger: { for: () => logger } };
});

import { liveStreams } from '../liveStreams';
import { ScrcpyConnection, SESSION_FAILED_CLOSE_CODE } from '../ScrcpyConnection';

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

/** The private steps of start() these tests hold open or watch. */
type Steps = {
    createTcpServer(): Promise<{ server: net.Server; port: number }>;
    reserveLocalPort(): Promise<number>;
    acceptSockets(server: net.Server, count: number, timeoutMs: number): Promise<net.Socket[]>;
    connectAndAwaitDummy(port: number, maxWaitMs: number): Promise<net.Socket>;
    connectLocal(port: number, timeoutMs: number): Promise<net.Socket>;
    parseMetadata(): Promise<unknown>;
    startForwarding(): void;
};
const steps = ScrcpyConnection.prototype as unknown as Steps;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: Error) => void } {
    let resolve!: (value: T) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

let ws: FakeWs;
let connection: ScrcpyConnection;

function open(): ScrcpyConnection {
    const created = ScrcpyConnection.processRequest(ws as never, {
        action: ACTION.STREAM_SCRCPY,
        url: new URL('http://localhost/?action=stream&udid=device-1'),
        request: {} as never,
    });
    expect(created).toBeDefined();
    connection = created!;
    return connection;
}

/** The browser going away, as ws reports it. */
function browserLeaves(): void {
    ws.readyState = ws.CLOSED;
    ws.emit('close');
}

/** start() reached the abandon path and said so at info level. */
async function abandoned(): Promise<void> {
    await vi.waitFor(() => expect(h.infos.some((line) => line.startsWith('Start abandoned for device-1'))).toBe(true));
}

function expectNoFailureReported(): void {
    expect(h.errors.filter((line) => line.includes('Failed to start session'))).toEqual([]);
    expect(ws.close).not.toHaveBeenCalledWith(SESSION_FAILED_CLOSE_CODE, expect.anything());
}

/** Answer the two start-up probes: the SDK level, and an empty encoder list (changes nothing). */
function deviceSdk(sdk: number | Promise<string>): void {
    h.shell.mockImplementation((_serial, cmd) => {
        if (cmd.startsWith('getprop')) return typeof sdk === 'number' ? Promise.resolve(String(sdk)) : sdk;
        return Promise.resolve('');
    });
}

beforeEach(() => {
    h.children.length = 0;
    h.order.length = 0;
    h.errors.length = 0;
    h.infos.length = 0;
    ws = new FakeWs();
    deviceSdk(34);
    h.reverse.mockResolvedValue(undefined);
    h.forward.mockResolvedValue(undefined);
    h.removeReverse.mockImplementation(async () => {
        h.order.push('removeReverse');
    });
    h.removeForward.mockImplementation(async () => {
        h.order.push('removeForward');
    });
    h.push.mockResolvedValue(undefined);
    h.shellSpawn.mockImplementation(() => {
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
    });
});

afterEach(() => {
    connection?.release();
    liveStreams.cancelStop();
    vi.restoreAllMocks();
    h.shell.mockReset();
    h.reverse.mockReset();
    h.forward.mockReset();
    h.removeReverse.mockReset();
    h.removeForward.mockReset();
    h.shellSpawn.mockReset();
    h.push.mockReset();
});

describe('ScrcpyConnection — released before scrcpy-server is launched', () => {
    it('released during the start-up probes: nothing is pushed, tunnelled or launched', async () => {
        const sdk = deferred<string>();
        deviceSdk(sdk.promise);
        open();
        await vi.waitFor(() => expect(h.shell).toHaveBeenCalled());

        browserLeaves();
        sdk.resolve('34');
        await abandoned();

        expect(h.push).not.toHaveBeenCalled();
        expect(h.reverse).not.toHaveBeenCalled();
        expect(h.shellSpawn).not.toHaveBeenCalled();
        expectNoFailureReported();
    });

    it('released while scrcpy-server is being pushed: no tunnel and no launch', async () => {
        const push = deferred<void>();
        h.push.mockReturnValue(push.promise);
        const listen = vi.spyOn(steps, 'createTcpServer');
        open();
        await vi.waitFor(() => expect(h.push).toHaveBeenCalled());

        liveStreams.closeAllForShutdown();
        push.resolve();
        await abandoned();

        expect(listen).not.toHaveBeenCalled();
        expect(h.reverse).not.toHaveBeenCalled();
        expect(h.shellSpawn).not.toHaveBeenCalled();
        expectNoFailureReported();
    });

    it('released while the host listener is opening: the listener is closed and no tunnel is made', async () => {
        const listening = deferred<{ server: net.Server; port: number }>();
        vi.spyOn(steps, 'createTcpServer').mockReturnValue(listening.promise);
        const server = Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as net.Server;
        open();
        await vi.waitFor(() => expect(steps.createTcpServer).toHaveBeenCalled());

        browserLeaves();
        listening.resolve({ server, port: 50001 });
        await abandoned();

        expect(server.close).toHaveBeenCalled();
        expect(h.reverse).not.toHaveBeenCalled();
        expect(h.shellSpawn).not.toHaveBeenCalled();
        expectNoFailureReported();
    });

    it('released during adb reverse (server stopping): no launch, and the tunnel is removed once it exists', async () => {
        const reverse = deferred<void>();
        h.reverse.mockImplementation(async () => {
            await reverse.promise;
            h.order.push('reverse made');
        });
        open();
        await vi.waitFor(() => expect(h.reverse).toHaveBeenCalled());

        liveStreams.closeAllForShutdown();
        reverse.resolve();
        await abandoned();

        expect(h.shellSpawn).not.toHaveBeenCalled();
        // release() ran while the reverse was still being made; only a removal
        // after it exists actually removes it.
        expect(h.order.lastIndexOf('removeReverse')).toBeGreaterThan(h.order.indexOf('reverse made'));
        const internals = connection as unknown as { tcpServer?: net.Server };
        expect(internals.tcpServer?.listening).toBe(false);
        expectNoFailureReported();
    });

    it('released while a forward port is being reserved: no forward and no launch', async () => {
        deviceSdk(25);
        const port = deferred<number>();
        vi.spyOn(steps, 'reserveLocalPort').mockReturnValue(port.promise);
        open();
        await vi.waitFor(() => expect(steps.reserveLocalPort).toHaveBeenCalled());

        browserLeaves();
        port.resolve(50002);
        await abandoned();

        expect(h.forward).not.toHaveBeenCalled();
        expect(h.shellSpawn).not.toHaveBeenCalled();
        expectNoFailureReported();
    });

    it('released during adb forward: no launch, and the forward is removed once it exists', async () => {
        deviceSdk(25);
        const forward = deferred<void>();
        h.forward.mockImplementation(async () => {
            await forward.promise;
            h.order.push('forward made');
        });
        open();
        await vi.waitFor(() => expect(h.forward).toHaveBeenCalled());

        browserLeaves();
        forward.resolve();
        await abandoned();

        expect(h.shellSpawn).not.toHaveBeenCalled();
        expect(h.order.lastIndexOf('removeForward')).toBeGreaterThan(h.order.indexOf('forward made'));
        expectNoFailureReported();
    });
});

describe('ScrcpyConnection — released after scrcpy-server is launched', () => {
    it('released while waiting for the handshake: the retry loop stops instead of running out its 120 s', async () => {
        deviceSdk(25);
        const connect = vi.spyOn(steps, 'connectLocal').mockRejectedValue(new Error('ECONNREFUSED'));
        open();
        await vi.waitFor(() => expect(connect.mock.calls.length).toBeGreaterThanOrEqual(2));

        liveStreams.closeAllForShutdown();
        await abandoned();
        const attempts = connect.mock.calls.length;
        await new Promise((r) => setTimeout(r, 400));

        expect(connect.mock.calls.length).toBe(attempts);
        expect(h.children[0]?.killed).toBe(true);
        expectNoFailureReported();
    });

    it('released while the handshake socket is arriving: that socket is closed and no other is opened', async () => {
        deviceSdk(25);
        const handshake = deferred<net.Socket>();
        vi.spyOn(steps, 'connectAndAwaitDummy').mockReturnValue(handshake.promise);
        const connect = vi.spyOn(steps, 'connectLocal');
        const video = new FakeSocket();
        open();
        await vi.waitFor(() => expect(steps.connectAndAwaitDummy).toHaveBeenCalled());

        browserLeaves();
        handshake.resolve(video as unknown as net.Socket);
        await abandoned();

        expect(video.destroyed).toBe(true);
        expect(connect).not.toHaveBeenCalled();
        // It stops at once, not after announcing it is opening the rest.
        expect(h.infos.some((line) => line.includes('opening remaining sockets'))).toBe(false);
        expectNoFailureReported();
    });

    it('released during the pause after the handshake: no further socket is opened', async () => {
        deviceSdk(25);
        const video = new FakeSocket();
        vi.spyOn(steps, 'connectAndAwaitDummy').mockImplementation(async () => {
            // Lands inside the 100 ms pause that follows the handshake.
            setTimeout(() => browserLeaves(), 10);
            return video as unknown as net.Socket;
        });
        const connect = vi.spyOn(steps, 'connectLocal');
        open();
        await abandoned();

        expect(connect).not.toHaveBeenCalled();
        expect(video.destroyed).toBe(true);
        expectNoFailureReported();
    });

    it('released while the control socket connects: every socket in hand is closed, the metadata never read', async () => {
        // SDK 25 has audio off (below 30), so the next connect is control's.
        deviceSdk(25);
        const video = new FakeSocket();
        const control = new FakeSocket();
        const controlConnect = deferred<net.Socket>();
        vi.spyOn(steps, 'connectAndAwaitDummy').mockResolvedValue(video as unknown as net.Socket);
        const connect = vi.spyOn(steps, 'connectLocal').mockReturnValue(controlConnect.promise);
        const parse = vi.spyOn(steps, 'parseMetadata');
        open();
        await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));

        browserLeaves();
        controlConnect.resolve(control as unknown as net.Socket);
        await abandoned();

        expect(video.destroyed).toBe(true);
        expect(control.destroyed).toBe(true);
        expect(connect).toHaveBeenCalledTimes(1);
        expect(parse).not.toHaveBeenCalled();
        expectNoFailureReported();
    });

    it('released while the reverse-tunnel sockets arrive: they are closed and the metadata is never read', async () => {
        const accepted = deferred<net.Socket[]>();
        vi.spyOn(steps, 'acceptSockets').mockReturnValue(accepted.promise);
        const parse = vi.spyOn(steps, 'parseMetadata');
        const sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket()];
        open();
        await vi.waitFor(() => expect(steps.acceptSockets).toHaveBeenCalled());

        liveStreams.closeAllForShutdown();
        accepted.resolve(sockets as unknown as net.Socket[]);
        await abandoned();

        expect(sockets.map((s) => s.destroyed)).toEqual([true, true, true]);
        expect(parse).not.toHaveBeenCalled();
        expectNoFailureReported();
    });

    it('released before every reverse-tunnel socket connected: the wait gives up and closes the ones that did', async () => {
        // release() kills scrcpy-server and closes the listener, so the rest
        // never connect; the sockets already accepted are held only here.
        open();
        const server = new EventEmitter() as unknown as net.Server;
        const early = [new FakeSocket(), new FakeSocket()];
        const waiting = steps.acceptSockets.call(connection, server, 3, 30);
        for (const socket of early) server.emit('connection', socket);

        await expect(waiting).rejects.toThrow('Timeout waiting for 3 TCP connections (got 2)');

        expect(early.map((s) => s.destroyed)).toEqual([true, true]);
    });

    it('released while the metadata is read: nothing is sent and forwarding never starts', async () => {
        const sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket()];
        vi.spyOn(steps, 'acceptSockets').mockResolvedValue(sockets as unknown as net.Socket[]);
        const metadata = deferred<unknown>();
        vi.spyOn(steps, 'parseMetadata').mockReturnValue(metadata.promise);
        const forwarding = vi.spyOn(steps, 'startForwarding');
        open();
        await vi.waitFor(() => expect(steps.parseMetadata).toHaveBeenCalled());

        browserLeaves();
        metadata.resolve({ deviceName: 'd', videoCodec: 'h264', screenWidth: 1, screenHeight: 1, audioCodec: 'opus' });
        await abandoned();

        expect(ws.send).not.toHaveBeenCalled();
        expect(forwarding).not.toHaveBeenCalled();
        expectNoFailureReported();
    });
});

describe('ScrcpyConnection — a start that really fails is still reported', () => {
    it('logs "Failed to start session" at error level and closes with 4005', async () => {
        h.reverse.mockRejectedValue(new Error('adb: device offline'));
        open();

        await vi.waitFor(() => expect(ws.close).toHaveBeenCalled());

        expect(ws.close).toHaveBeenCalledWith(SESSION_FAILED_CLOSE_CODE, 'adb: device offline');
        expect(h.errors.some((line) => line.includes('Failed to start session for device-1'))).toBe(true);
        expect(h.infos.some((line) => line.startsWith('Start abandoned'))).toBe(false);
    });
});
