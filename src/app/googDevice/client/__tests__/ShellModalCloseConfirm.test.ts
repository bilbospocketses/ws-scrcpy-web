// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The "close the shell?" confirm belongs to the ShellModal that opened it.
 *
 * The modal is built through its real constructor so the × handler, the
 * started-shell gate and the teardown are the shipped ones. Only the edges are
 * stubbed: xterm and its addons (jsdom has no canvas), the multiplexer channel
 * (a plain EventTarget the test opens by hand) and ResizeObserver (jsdom has
 * none; the test fires the captured callback, which is what starts the shell).
 */

const fake = vi.hoisted(() => ({
    sockets: new Map<string, unknown>(),
    resizeCallbacks: [] as Array<() => void>,
}));

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
vi.mock('../../../client/ManagerClient', () => ({ ManagerClient: { sockets: fake.sockets } }));
vi.mock('../../../../packages/multiplexer/Multiplexer', () => ({ Multiplexer: { wrap: vi.fn() } }));
vi.mock('../multiplexConnection', () => ({ buildMultiplexUrl: () => 'ws://shell.test/' }));

import { ShellModal } from '../ShellModal';

class FakeChannel extends EventTarget {
    public readonly OPEN = 1;
    public readyState = 1;
    public readonly send = vi.fn();
    public readonly close = vi.fn();
}

let channel: FakeChannel;
let teardown: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute('open');
    });
    fake.resizeCallbacks.length = 0;
    vi.stubGlobal(
        'ResizeObserver',
        class {
            constructor(cb: () => void) {
                fake.resizeCallbacks.push(cb);
            }
            observe(): void {}
            disconnect(): void {}
        },
    );
    channel = new FakeChannel();
    // A real multiplexer carries its socket; connect() reads its url for the host it names.
    fake.sockets.set('ws://shell.test/', { createChannel: () => channel, ws: { url: 'ws://shell.test/' } });
    // Every close path funnels through onBeforeClose exactly once per close().
    teardown = vi.spyOn(ShellModal.prototype as unknown as { onBeforeClose: () => void }, 'onBeforeClose');
});

afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fake.sockets.clear();
    document.body.replaceChildren();
});

async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** Open a ShellModal and drive it to the started state, as the real ResizeObserver would. */
function openStartedShell(): { modal: ShellModal; dialog: HTMLDialogElement } {
    const modal = new ShellModal('serial-1', 'Pixel', {});
    const dialog = document.querySelector('dialog.shell-modal') as HTMLDialogElement;
    channel.dispatchEvent(new Event('open'));
    const container = dialog.querySelector('.terminal-container') as HTMLElement;
    Object.defineProperty(container, 'clientWidth', { value: 800 });
    Object.defineProperty(container, 'clientHeight', { value: 600 });
    expect(fake.resizeCallbacks).toHaveLength(1);
    fake.resizeCallbacks[0]!();
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('"start"'));
    return { modal, dialog };
}

function clickShellX(dialog: HTMLDialogElement): void {
    const x = Array.from(dialog.querySelectorAll('button.modal-close')).find((b) => b.textContent === '×');
    expect(x, 'shell modal × should be rendered').toBeTruthy();
    (x as HTMLButtonElement).click();
}

function confirmDialog(): HTMLDialogElement | null {
    return document.querySelector('dialog.shell-close-confirm-modal');
}

function confirmButton(label: 'close' | 'cancel'): HTMLButtonElement {
    const btn = Array.from(confirmDialog()?.querySelectorAll('button') ?? []).find(
        (b) => b.textContent?.trim() === label,
    );
    expect(btn, `confirm "${label}" button should be rendered`).toBeTruthy();
    return btn as HTMLButtonElement;
}

describe('ShellModal close confirm follows the shell modal', () => {
    it('is dismissed, with no second close, when the shell modal closes another way', async () => {
        const { modal, dialog } = openStartedShell();
        clickShellX(dialog);
        expect(confirmDialog()?.hasAttribute('open')).toBe(true);

        modal.close();
        await flushMicrotasks();
        vi.advanceTimersByTime(250);

        expect(dialog.hasAttribute('open')).toBe(false);
        expect(confirmDialog(), 'the confirm must not outlive its shell modal').toBeNull();
        expect(teardown).toHaveBeenCalledTimes(1);
    });

    it('closes the shell modal once when the confirm is answered "close"', async () => {
        const { dialog } = openStartedShell();
        clickShellX(dialog);

        confirmButton('close').click();
        await flushMicrotasks();
        vi.advanceTimersByTime(250);

        expect(dialog.hasAttribute('open')).toBe(false);
        expect(confirmDialog()).toBeNull();
        expect(teardown).toHaveBeenCalledTimes(1);
    });

    it('keeps the shell modal open, and removes the confirm, when the confirm is cancelled', async () => {
        const { dialog } = openStartedShell();
        clickShellX(dialog);

        confirmButton('cancel').click();
        await flushMicrotasks();
        vi.advanceTimersByTime(250);

        expect(dialog.hasAttribute('open')).toBe(true);
        expect(document.body.contains(dialog)).toBe(true);
        expect(confirmDialog()).toBeNull();
        expect(teardown).not.toHaveBeenCalled();
    });

    it('does not close the shell modal a second time when it closes before a "close" answer lands', async () => {
        const { modal, dialog } = openStartedShell();
        clickShellX(dialog);

        // The answer is in, but its handler runs a microtask later; the shell
        // modal closes some other way in between.
        confirmButton('close').click();
        modal.close();
        await flushMicrotasks();

        expect(dialog.hasAttribute('open')).toBe(false);
        expect(teardown).toHaveBeenCalledTimes(1);
    });
});
