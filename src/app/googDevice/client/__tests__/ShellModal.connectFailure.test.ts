// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagerClient } from '../../../client/ManagerClient';
import { ShellModal } from '../ShellModal';

// The terminal itself is out of scope here: these tests are about what the
// modal does with its socket. jsdom cannot lay out an xterm, so stub it.
vi.mock('@xterm/xterm', () => ({
    Terminal: class {
        loadAddon(): void {}
        open(): void {}
        focus(): void {}
        dispose(): void {}
    },
}));
vi.mock('@xterm/addon-attach', () => ({ AttachAddon: class {} }));
vi.mock('@xterm/addon-fit', () => ({
    FitAddon: class {
        fit(): void {}
        proposeDimensions(): { rows: number; cols: number } {
            return { rows: 24, cols: 80 };
        }
    },
}));

/**
 * Stands in for the browser's WebSocket so a test can play out the event
 * order a real socket produces: a refused or unreachable host fires `error`
 * and then `close` (code 1006) without ever firing `open`.
 */
class FakeWebSocket extends EventTarget {
    static instances: FakeWebSocket[] = [];
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readyState = 0;
    binaryType = 'blob';
    readonly url: string;

    constructor(url: string) {
        super();
        this.url = url;
        FakeWebSocket.instances.push(this);
    }

    send(_data: unknown): void {}

    close(): void {
        this.readyState = this.CLOSED;
    }

    serverOpens(): void {
        this.readyState = this.OPEN;
        this.dispatchEvent(new Event('open'));
    }

    errors(): void {
        this.readyState = this.CLOSED;
        this.dispatchEvent(new Event('error'));
    }

    closes(code: number): void {
        this.readyState = this.CLOSED;
        this.dispatchEvent(new CloseEvent('close', { code, wasClean: code === 1000 }));
    }
}

function openShell(): { modal: ShellModal; dialog: HTMLDialogElement; socket: FakeWebSocket; close: any } {
    const modal = new ShellModal('serial-1', 'Pixel', { hostname: '127.0.0.1', port: 9 });
    const close = vi.spyOn(modal, 'close');
    const dialog = document.querySelector('dialog.shell-modal') as HTMLDialogElement;
    const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    return { modal, dialog, socket, close };
}

function errorText(dialog: HTMLDialogElement): string[] {
    return Array.from(dialog.querySelectorAll('.shell-modal-error')).map((el) => el.textContent ?? '');
}

describe('ShellModal, a host that does not answer (smoke row 9.10)', () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.useFakeTimers();
        FakeWebSocket.instances = [];
        ManagerClient.sockets.clear();
        vi.stubGlobal('WebSocket', FakeWebSocket);
        vi.stubGlobal(
            'ResizeObserver',
            class {
                observe(): void {}
                disconnect(): void {}
            },
        );
        HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
            this.setAttribute('open', '');
        });
        HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
            this.removeAttribute('open');
        });
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        ManagerClient.sockets.clear();
        document.body.replaceChildren();
    });

    it('says the host could not be reached, with the close code, and closes after 4 s', async () => {
        const { dialog, socket, close } = openShell();

        socket.closes(1006);
        await vi.advanceTimersByTimeAsync(0);

        expect(errorText(dialog)).toEqual(['connection failed: could not reach 127.0.0.1:9 (code 1006)']);
        await vi.advanceTimersByTimeAsync(3999);
        expect(close).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('reports a socket error followed by its close once, not twice', async () => {
        const { dialog, socket, close } = openShell();

        socket.errors();
        socket.closes(1006);
        await vi.advanceTimersByTimeAsync(0);

        expect(errorText(dialog)).toEqual(['connection failed: could not reach 127.0.0.1:9 (code 1006)']);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(5000);
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('still reports an error that no close follows, without a code', async () => {
        const { dialog, socket, close } = openShell();

        socket.errors();
        await vi.advanceTimersByTimeAsync(0);

        const [text] = errorText(dialog);
        expect(text).toBe('connection failed: could not reach 127.0.0.1:9');
        expect(text).not.toContain('[object');
        await vi.advanceTimersByTimeAsync(4000);
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('leaves a session that opened and then ended exactly as before: no error, no auto-close', async () => {
        const { dialog, socket, close } = openShell();

        socket.serverOpens();
        await vi.advanceTimersByTimeAsync(0);
        socket.closes(1000);
        await vi.advanceTimersByTimeAsync(5000);

        expect(errorText(dialog)).toEqual([]);
        expect(close).not.toHaveBeenCalled();
        expect(dialog.hasAttribute('open')).toBe(true);
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('shows no error when the user closes the modal before the socket opens', async () => {
        const { modal, dialog, socket, close } = openShell();

        modal.close();
        socket.errors();
        socket.closes(1006);
        await vi.advanceTimersByTimeAsync(5000);

        expect(errorText(dialog)).toEqual([]);
        expect(close).toHaveBeenCalledTimes(1);
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('keeps the malformed-host message unchanged', async () => {
        const modal = new ShellModal('serial-1', 'Pixel', { hostname: 'evil/host', port: 9 });
        const close = vi.spyOn(modal, 'close');
        const dialog = document.querySelector('dialog.shell-modal') as HTMLDialogElement;

        expect(FakeWebSocket.instances).toHaveLength(0);
        expect(errorText(dialog)).toEqual([
            'connection failed: refusing to open WebSocket to invalid hostname: "evil/host"',
        ]);
        await vi.advanceTimersByTimeAsync(4000);
        expect(close).toHaveBeenCalledTimes(1);
    });
});
