// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authClient } from '../../AuthClient';
import { SettingsModal } from '../../SettingsModal';

/**
 * The two prompts the Settings dialog raises over itself -- "Unsaved changes"
 * (from ×/Esc/backdrop on a dirty dialog) and "Review changes" (from Save) --
 * belong to it. If the dialog closes while one is up, the prompt goes with it
 * and its answer, given or not, does nothing: no batch, no second close.
 *
 * Real dialogs throughout, no spies on the prompt statics, so the prompts are
 * the shipped ones and their buttons are the shipped buttons.
 */

let batchCount = 0;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    document.body.replaceChildren();
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute('open');
    });
    vi.spyOn(authClient, 'me').mockResolvedValue({ authEnabled: false, user: { username: 'admin', role: 'admin' } });
    batchCount = 0;
    vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
            if (typeof url === 'string' && url.startsWith('/api/settings/batch')) {
                batchCount += 1;
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({ ok: true, applied: [] }),
                });
            }
            if (typeof url === 'string' && url.startsWith('/api/config')) {
                return Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            config: { webPort: 8000 },
                            runtime: {
                                firstRunComplete: true,
                                portWasAutoShifted: false,
                                webPort: 8000,
                                docker: false,
                            },
                        }),
                });
            }
            return new Promise(() => undefined); // every other read stalls, as the dockerGating harness does
        }),
    );
});

afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

async function settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(0);
}

/** A dialog by its title -- neither prompt carries a class of its own. */
function dialogTitled(title: string): HTMLDialogElement | null {
    const all = [...document.querySelectorAll<HTMLDialogElement>('dialog.modal')];
    return all.find((d) => d.querySelector('.modal-title')?.textContent === title) ?? null;
}

function footerButton(dialog: HTMLDialogElement | null, label: string): HTMLButtonElement {
    const btn = [...(dialog?.querySelectorAll<HTMLButtonElement>('.modal-footer button') ?? [])].find(
        (b) => b.textContent === label,
    );
    expect(btn, `"${label}" in ${dialog?.querySelector('.modal-title')?.textContent}`).toBeTruthy();
    return btn as HTMLButtonElement;
}

/** Open Settings, stage an http port change, and return the dialog. */
async function openDirtySettings(): Promise<{ modal: SettingsModal; dialog: HTMLDialogElement }> {
    const modal = new SettingsModal();
    await settle();
    const dialog = document.querySelector('dialog.settings-modal') as HTMLDialogElement;
    const input = dialog.querySelector<HTMLInputElement>('input[type="number"]');
    expect(input, 'the http port input').not.toBeNull();
    if (input) {
        input.value = '9000';
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await settle();
    return { modal, dialog };
}

function clickX(dialog: HTMLDialogElement): void {
    [...dialog.querySelectorAll<HTMLButtonElement>('.modal-close')].find((b) => b.textContent === '×')?.click();
}

function clickSave(dialog: HTMLDialogElement): void {
    dialog.querySelector<HTMLButtonElement>('.modal-footer button.settings-save')?.click();
}

describe('Settings dialog: its prompts follow it', () => {
    let teardown: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        teardown = vi.spyOn(SettingsModal.prototype as unknown as { onBeforeClose: () => void }, 'onBeforeClose');
    });

    it('"Unsaved changes" is dismissed, with no second close, when the dialog closes another way', async () => {
        const { modal, dialog } = await openDirtySettings();
        clickX(dialog);
        await settle();
        expect(dialogTitled('Unsaved changes')?.hasAttribute('open')).toBe(true);

        modal.close();
        await settle();
        vi.advanceTimersByTime(250);

        expect(dialogTitled('Unsaved changes'), 'the prompt must not outlive the dialog').toBeNull();
        expect(teardown).toHaveBeenCalledTimes(1);
        expect(batchCount).toBe(0);
        // The awaiting close flow settled rather than hanging on a gone prompt.
        expect((modal as unknown as { closePromptOpen: boolean }).closePromptOpen).toBe(false);
        expect((modal as unknown as { saving: boolean }).saving).toBe(false);
    });

    it('"Review changes" is dismissed, and nothing is sent, when the dialog closes another way', async () => {
        const { modal, dialog } = await openDirtySettings();
        clickSave(dialog);
        await settle();
        expect(dialogTitled('Review changes')?.hasAttribute('open')).toBe(true);

        modal.close();
        await settle();
        vi.advanceTimersByTime(250);

        expect(dialogTitled('Review changes'), 'the summary must not outlive the dialog').toBeNull();
        expect(batchCount).toBe(0);
        expect(teardown).toHaveBeenCalledTimes(1);
        expect((modal as unknown as { saving: boolean }).saving).toBe(false);
    });

    it('an answer that lands after the dialog has closed does nothing', async () => {
        const { modal, dialog } = await openDirtySettings();
        clickX(dialog);
        await settle();

        // "discard" is in, but the flow acts on it a microtask later; the
        // dialog closes some other way in between.
        footerButton(dialogTitled('Unsaved changes'), 'discard').click();
        modal.close();
        await settle();

        expect(teardown).toHaveBeenCalledTimes(1);
    });

    it('"discard" closes the dialog once', async () => {
        const { dialog } = await openDirtySettings();
        clickX(dialog);
        await settle();

        footerButton(dialogTitled('Unsaved changes'), 'discard').click();
        await settle();
        vi.advanceTimersByTime(250);

        expect(dialog.hasAttribute('open')).toBe(false);
        expect(dialogTitled('Unsaved changes')).toBeNull();
        expect(teardown).toHaveBeenCalledTimes(1);
    });

    it('"cancel" keeps the dialog open and removes the prompt', async () => {
        const { dialog } = await openDirtySettings();
        clickX(dialog);
        await settle();

        footerButton(dialogTitled('Unsaved changes'), 'cancel').click();
        await settle();
        vi.advanceTimersByTime(250);

        expect(dialog.hasAttribute('open')).toBe(true);
        expect(dialogTitled('Unsaved changes')).toBeNull();
        expect(teardown).not.toHaveBeenCalled();
    });

    it('"Save" in the summary sends the batch once and closes the dialog once', async () => {
        const { dialog } = await openDirtySettings();
        clickSave(dialog);
        await settle();

        footerButton(dialogTitled('Review changes'), 'Save').click();
        await settle();
        vi.advanceTimersByTime(250);

        expect(batchCount).toBe(1);
        expect(dialogTitled('Review changes')).toBeNull();
        expect(dialog.hasAttribute('open')).toBe(false);
        expect(teardown).toHaveBeenCalledTimes(1);
    });

    it('"Cancel" in the summary sends nothing and keeps the dialog open', async () => {
        const { dialog } = await openDirtySettings();
        clickSave(dialog);
        await settle();

        footerButton(dialogTitled('Review changes'), 'Cancel').click();
        await settle();
        vi.advanceTimersByTime(250);

        expect(batchCount).toBe(0);
        expect(dialogTitled('Review changes')).toBeNull();
        expect(dialog.hasAttribute('open')).toBe(true);
        expect(teardown).not.toHaveBeenCalled();
    });
});
