// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authClient } from '../../AuthClient';
import {
    type DirtyCloseChoice,
    liveSaveDeps,
    performDirtyClose,
    performStagedSave,
    RESTART_REDIRECT_DELAY_MS,
    type SaveDeps,
    SettingsDirtyCloseModal,
    SettingsModal,
} from '../../SettingsModal';
import { closeIntent } from '../closeIntent';
import type { BatchResult } from '../SaveRunner';
import { runSave } from '../SaveRunner';
import { SettingsSummaryModal } from '../SettingsSummaryModal';
import type { Change } from '../StagedSettingsStore';
import { StagedSettingsStore } from '../StagedSettingsStore';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** A `fetch` stub answering with one canned status + JSON body. */
function stubFetch(status: number, body: unknown): void {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
            ok: status >= 200 && status < 300,
            status,
            json: async () => body,
        })),
    );
}

describe('closeIntent', () => {
    it('closes straight away when nothing is staged', () => {
        expect(closeIntent(new StagedSettingsStore())).toBe('close');
    });

    it('prompts when there are staged changes', () => {
        const store = new StagedSettingsStore();
        store.register({ id: 'channel', label: 'Channel', initial: 'stable' });
        store.set('channel', 'beta');
        expect(closeIntent(store)).toBe('prompt');
    });
});

describe('runSave treats a non-ok response as a failure', () => {
    // `fetch` resolves NORMALLY for a 400 — only `res.ok` says the server
    // refused. Code that awaits the promise and reads the body sees a refused
    // batch as a success, which is the single most damaging way to get this
    // wrong: the dialog would close on a save the server threw away.

    it('reports a refused-id 400, whose body carries no `ok` field at all', async () => {
        // SettingsBatchApi answers a non-stageable id with a BARE 400:
        // `{ error: 'not a stageable setting: …' }` — no `ok`, no `applied`, no
        // `failed`. Reading the body alone yields `ok: undefined`, so this is
        // the shape that a missing `res.ok` check cannot survive.
        stubFetch(400, { error: 'not a stageable setting: githubOwner' });

        const result = await runSave([{ id: 'githubOwner', label: 'Owner', from: 'a', to: 'b' }]);

        expect(result.ok).toBe(false);
        expect(result.failed?.error).toContain('not a stageable setting: githubOwner');
    });

    it('surfaces failed.id and failed.error from a rejected-apply 400', async () => {
        stubFetch(400, { ok: false, applied: ['channel'], failed: { id: 'webPort', error: 'port 80 is in use' } });

        const result = await runSave([{ id: 'webPort', label: 'Web port', from: 8000, to: 80 }]);

        expect(result.ok).toBe(false);
        expect(result.failed?.id).toBe('webPort');
        expect(result.failed?.error).toBe('port 80 is in use');
        // The partial progress the server did make is preserved, not dropped.
        expect(result.applied).toEqual(['channel']);
    });

    it('does not let an ok-looking body override a non-ok status', async () => {
        // Defensive, and the sharpest mutation target in this describe: if the
        // `res.ok` check were removed, this body alone would report success.
        stubFetch(400, { ok: true, applied: ['channel'] });

        const result = await runSave([{ id: 'channel', label: 'Channel', from: 'stable', to: 'beta' }]);

        expect(result.ok).toBe(false);
    });

    it('passes a 200 through as the server wrote it', async () => {
        // The control: a check that refuses everything would pass all three
        // tests above and be completely broken.
        stubFetch(200, { ok: true, applied: ['channel'], restartRequired: false });

        const result = await runSave([{ id: 'channel', label: 'Channel', from: 'stable', to: 'beta' }]);

        expect(result.ok).toBe(true);
        expect(result.applied).toEqual(['channel']);
    });

    it('reports a 200 whose body is not readable JSON', async () => {
        // A proxy or a tunnel answering 200 with an HTML error page. `res.ok` is
        // true, so the status check alone passes it through — the body has to be
        // checked too, or `ok` comes back `undefined` and every downstream
        // `if (result.ok)` silently takes the failure branch without a reason.
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                status: 200,
                json: async () => {
                    throw new SyntaxError('Unexpected token < in JSON at position 0');
                },
            })),
        );

        const result = await runSave([{ id: 'channel', label: 'Channel', from: 'stable', to: 'beta' }]);

        expect(result.ok).toBe(false);
        expect(result.failed?.error).toContain('200');
    });

    it('reports an unreachable server rather than throwing', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new Error('network down');
            }),
        );

        const result = await runSave([{ id: 'channel', label: 'Channel', from: 'stable', to: 'beta' }]);

        expect(result.ok).toBe(false);
        expect(result.failed?.error).toBe("couldn't reach server");
    });
});

/** A store with one staged change: web port 8000 -> 80. */
function stagedStore(): StagedSettingsStore {
    const store = new StagedSettingsStore();
    store.register({ id: 'webPort', label: 'Web port', initial: 8000 });
    store.set('webPort', 80);
    return store;
}

/**
 * Deps with both collaborators mocked, plus a shared call-ORDER log.
 *
 * The order log is what pins "Save always goes through the summary": asserting
 * only that both were called would hold just as well for code that fires the
 * batch first and shows the summary afterwards.
 */
function mockDeps(overrides: Partial<SaveDeps> = {}): SaveDeps & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        confirm: vi.fn(async (changes: Change[]) => {
            calls.push(`confirm(${changes.map((c) => c.id).join(',')})`);
            return true;
        }),
        save: vi.fn(async (changes: Change[]) => {
            calls.push(`save(${changes.map((c) => c.id).join(',')})`);
            return { ok: true, applied: changes.map((c) => c.id) } as BatchResult;
        }),
        promptDirtyClose: vi.fn(async () => {
            calls.push('prompt');
            return 'cancel' as DirtyCloseChoice;
        }),
        ...overrides,
    };
}

describe('performStagedSave', () => {
    it('opens the summary BEFORE sending, with exactly the staged changes', async () => {
        const store = stagedStore();
        const deps = mockDeps();

        await performStagedSave(store, deps);

        // Both the order and the payload. `confirm` renders from the same list
        // that is sent, so the user cannot confirm one thing and save another.
        expect(deps.calls).toEqual(['confirm(webPort)', 'save(webPort)']);
        expect(deps.confirm).toHaveBeenCalledWith([{ id: 'webPort', label: 'Web port', from: 8000, to: 80 }]);
    });

    it('sends nothing when the summary is cancelled, and keeps the changes staged', async () => {
        const store = stagedStore();
        const before = store.changes();
        const deps = mockDeps({ confirm: vi.fn(async () => false) });

        const action = await performStagedSave(store, deps);

        expect(deps.save).not.toHaveBeenCalled();
        expect(action).toEqual({ kind: 'stay' });
        expect(store.changes()).toEqual(before);
    });

    it('never opens the summary, and sends nothing, when nothing is staged', async () => {
        const deps = mockDeps();

        const action = await performStagedSave(new StagedSettingsStore(), deps);

        expect(deps.confirm).not.toHaveBeenCalled();
        expect(deps.save).not.toHaveBeenCalled();
        expect(action).toEqual({ kind: 'close' });
    });

    it('closes the dialog on a plain success', async () => {
        const action = await performStagedSave(stagedStore(), mockDeps());

        expect(action).toEqual({ kind: 'close' });
    });

    it('keeps the dialog open with the changes INTACT when the batch is refused', async () => {
        const store = stagedStore();
        const before = store.changes();
        const deps = mockDeps({
            save: vi.fn(async () => ({
                ok: false,
                applied: [],
                failed: { id: 'webPort', error: 'port 80 is in use' },
            })),
        });

        const action = await performStagedSave(store, deps);

        expect(action.kind).toBe('failed');
        // The live trap this pins: calling a tab's refresher here would
        // re-register its fields with server values and silently DISCARD every
        // staged edit, so the user's work would vanish on a failed save.
        expect(store.changes()).toEqual(before);
        expect(store.changes()).toHaveLength(1);
    });

    it('names the failing change and the server reason', async () => {
        const deps = mockDeps({
            save: vi.fn(async () => ({
                ok: false,
                applied: [],
                failed: { id: 'webPort', error: 'port 80 is in use' },
            })),
        });

        const action = await performStagedSave(stagedStore(), deps);

        // Both halves: which change failed, and why. A message carrying only one
        // of them leaves the user unable to act on it.
        expect(action.kind === 'failed' && action.message).toContain('webPort');
        expect(action.kind === 'failed' && action.message).toContain('port 80 is in use');
    });

    it('redirects to the SAME origin on the new port when the server restarts', async () => {
        const deps = mockDeps({
            save: vi.fn(async () => ({
                ok: true,
                applied: ['webPort'],
                restartRequired: true,
                redirectPort: 9000,
            })),
        });

        const action = await performStagedSave(stagedStore(), deps);

        expect(action.kind).toBe('redirect');
        // Asserted separately from `kind`: a redirect to the WRONG port is still
        // a redirect, and would leave the browser on a dead port for good.
        const url = new URL(action.kind === 'redirect' ? action.url : '');
        expect(url.port).toBe('9000');
        expect(url.hostname).toBe(window.location.hostname);
    });

    it('does not redirect when a restart is required but no port came back', async () => {
        const deps = mockDeps({
            save: vi.fn(async () => ({ ok: true, applied: ['webPort'], restartRequired: true })),
        });

        // Better to close than to navigate to `:undefined` / `:NaN`.
        expect(await performStagedSave(stagedStore(), deps)).toEqual({ kind: 'close' });
    });

    it('waits 4 seconds before following the restart', () => {
        // A locked value, written out here rather than imported into the
        // comparison, the same way the container copy is pinned: it is the
        // supervisor's window to rebind the new port, and shortening it lands
        // the browser on a connection refused. This asserts the constant, not
        // the scheduling — the setTimeout that consumes it is in the modal.
        expect(RESTART_REDIRECT_DELAY_MS).toBe(4000);
    });

    it('does not redirect on a port echo without a restart', async () => {
        const deps = mockDeps({
            save: vi.fn(async () => ({ ok: true, applied: ['webPort'], redirectPort: 9000 })),
        });

        expect(await performStagedSave(stagedStore(), deps)).toEqual({ kind: 'close' });
    });
});

describe('performDirtyClose', () => {
    it('closes without prompting when nothing is staged', async () => {
        const deps = mockDeps();

        const action = await performDirtyClose(new StagedSettingsStore(), deps);

        expect(action).toEqual({ kind: 'close' });
        expect(deps.promptDirtyClose).not.toHaveBeenCalled();
    });

    it('CANCEL returns to the dialog with the changes intact — it neither closes nor discards', async () => {
        const store = stagedStore();
        const before = store.changes();
        const deps = mockDeps({ promptDirtyClose: vi.fn(async () => 'cancel' as DirtyCloseChoice) });

        const action = await performDirtyClose(store, deps);

        expect(action).toEqual({ kind: 'stay' });
        expect(store.changes()).toEqual(before);
        expect(deps.save).not.toHaveBeenCalled();
        expect(deps.confirm).not.toHaveBeenCalled();
    });

    it('DISCARD closes and sends nothing', async () => {
        const deps = mockDeps({ promptDirtyClose: vi.fn(async () => 'discard' as DirtyCloseChoice) });

        const action = await performDirtyClose(stagedStore(), deps);

        expect(action).toEqual({ kind: 'close' });
        expect(deps.save).not.toHaveBeenCalled();
    });

    it('SAVE goes through the summary, exactly as the Save button does', async () => {
        const deps = mockDeps({ promptDirtyClose: vi.fn(async () => 'save' as DirtyCloseChoice) });

        const action = await performDirtyClose(stagedStore(), deps);

        expect(action).toEqual({ kind: 'close' });
        expect(deps.calls).toEqual(['confirm(webPort)', 'save(webPort)']);
    });

    it('SAVE that fails keeps the dialog open rather than closing it', async () => {
        const store = stagedStore();
        const before = store.changes();
        const deps = mockDeps({
            promptDirtyClose: vi.fn(async () => 'save' as DirtyCloseChoice),
            save: vi.fn(async () => ({ ok: false, applied: [], failed: { id: 'webPort', error: 'nope' } })),
        });

        const action = await performDirtyClose(store, deps);

        // The whole point of the prompt is not to lose work: a close-triggered
        // save that the server refuses must not then close anyway.
        expect(action.kind).toBe('failed');
        expect(store.changes()).toEqual(before);
    });
});

describe('SettingsDirtyCloseModal', () => {
    beforeEach(() => {
        // jsdom implements neither method; same stubs as settingsSummaryModal's.
        HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
            this.setAttribute('open', '');
        });
        HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
            this.removeAttribute('open');
        });
        // The base Modal removes its dialog on a transitionend that jsdom never
        // fires, falling back to a 250ms real timer — so without this the
        // previous case's dialog is still in the DOM when the next one opens.
        document.body.replaceChildren();
    });

    /** The footer button labels of the one open dialog, in order. */
    function footerLabels(): (string | null)[] {
        return [...document.querySelectorAll<HTMLButtonElement>('dialog.modal .modal-footer button')].map(
            (b) => b.textContent,
        );
    }

    it('offers exactly three choices, and no more', async () => {
        const promise = SettingsDirtyCloseModal.choose();

        // A fourth button, or a missing discard, is a different dialog than the
        // one the other tests here drive.
        expect(footerLabels()).toEqual(['cancel', 'discard', 'save']);

        document.querySelector<HTMLButtonElement>('dialog.modal .modal-footer button')?.click();
        await expect(promise).resolves.toBe('cancel');
    });

    it('resolves each button as its own choice', async () => {
        for (const label of ['save', 'discard', 'cancel'] as const) {
            document.body.replaceChildren();
            const promise = SettingsDirtyCloseModal.choose();
            const btn = [...document.querySelectorAll<HTMLButtonElement>('dialog.modal .modal-footer button')].find(
                (b) => b.textContent === label,
            );
            btn?.click();
            // Named per iteration so a failure says WHICH button mis-resolved.
            await expect(promise, `the "${label}" button`).resolves.toBe(label);
        }
    });

    it('treats every dismissal as CANCEL, never as discard or save', async () => {
        // Esc, the backdrop and the × are ambiguous, and the safe reading is the
        // one that loses nothing: back to the dialog, changes still staged.
        const escapeKey = SettingsDirtyCloseModal.choose();
        document.querySelector('dialog.modal')?.dispatchEvent(new Event('cancel', { cancelable: true }));
        await expect(escapeKey, 'Escape').resolves.toBe('cancel');

        document.body.replaceChildren();
        const backdrop = SettingsDirtyCloseModal.choose();
        document.querySelector('dialog.modal')?.dispatchEvent(new MouseEvent('click', { cancelable: true }));
        await expect(backdrop, 'the backdrop').resolves.toBe('cancel');

        document.body.replaceChildren();
        const closeBtn = SettingsDirtyCloseModal.choose();
        [...document.querySelectorAll<HTMLButtonElement>('dialog.modal .modal-close')]
            .find((b) => b.textContent === '×')
            ?.click();
        await expect(closeBtn, 'the × button').resolves.toBe('cancel');
    });
});

/**
 * The signal the Save button's enabled state rides on.
 *
 * Save is enabled exactly when `isDirty()`, and the dialog cannot infer that
 * from DOM events: the Updates check-interval field commits from a 500ms
 * DEBOUNCE timer, so its `input` fires half a second before the value is
 * staged and the commit itself fires nothing at all. A dialog listening to
 * `input`/`change`/`click` therefore leaves Save greyed out over a real staged
 * change until the user happens to click something unrelated.
 */
describe('StagedSettingsStore.subscribe', () => {
    it('fires for a value staged from a timer, where no DOM event exists to hear', async () => {
        const store = new StagedSettingsStore();
        store.register({ id: 'updateCheckIntervalMinutes', label: 'Check interval', initial: 60 });
        const seen: boolean[] = [];
        store.subscribe(() => seen.push(store.isDirty()));

        // Exactly how UpdatesTab's debounce commits: inside a timer callback,
        // with no event dispatched.
        await new Promise((r) => setTimeout(() => r(store.set('updateCheckIntervalMinutes', 90)), 0));

        expect(seen).toEqual([true]);
    });

    it('fires on register, because re-registering MOVES the baseline', async () => {
        // The tabs re-register from their refreshes, which is what turns an
        // untouched-but-unknown field clean. Save has to follow that too.
        const store = new StagedSettingsStore();
        store.register({ id: 'webPort', label: 'Web port', initial: null });
        store.set('webPort', 8000);
        const seen: boolean[] = [];
        store.subscribe(() => seen.push(store.isDirty()));

        store.register({ id: 'webPort', label: 'Web port', initial: 8000 });

        expect(seen).toEqual([false]);
    });

    it('fires on the two wholesale clears as well, so a subscriber cannot miss one', async () => {
        // `reset` and `clear` change `isDirty()` exactly as `set` does. Neither
        // has a caller in the Settings dialog today — which is precisely why
        // they are pinned: a future one must not find a Save button still lit
        // over a store that has just been emptied.
        const store = new StagedSettingsStore();
        store.register({ id: 'channel', label: 'Channel', initial: 'stable' });
        store.set('channel', 'beta');
        const seen: boolean[] = [];
        store.subscribe(() => seen.push(store.isDirty()));

        store.reset();
        expect(seen, 'after reset()').toEqual([false]);

        store.set('channel', 'beta');
        store.clear();
        expect(seen, 'after clear()').toEqual([false, true, false]);
    });

    it('stops firing once unsubscribed', async () => {
        const store = new StagedSettingsStore();
        store.register({ id: 'channel', label: 'Channel', initial: 'stable' });
        let hits = 0;
        const off = store.subscribe(() => {
            hits += 1;
        });

        store.set('channel', 'beta');
        off();
        store.set('channel', 'stable');

        expect(hits).toBe(1);
    });
});

/**
 * The seam between the flow above and the real dialogs.
 *
 * Everything in `performStagedSave`'s own describe injects mocks, so on its own
 * it proves only that the flow calls WHATEVER it was handed. These pin what it
 * is actually handed in production — without them, `confirm` could be
 * `async () => true` and every test above would still pass while the summary
 * never opened.
 */
describe('liveSaveDeps', () => {
    const CHANGES: Change[] = [{ id: 'webPort', label: 'Web port', from: 8000, to: 9000 }];

    it('routes confirm through the change summary', async () => {
        const spy = vi.spyOn(SettingsSummaryModal, 'confirm').mockResolvedValue(false);

        await expect(liveSaveDeps.confirm(CHANGES)).resolves.toBe(false);
        expect(spy).toHaveBeenCalledWith(CHANGES);
    });

    it('routes the dirty-close prompt through the Save/Discard/Cancel dialog', async () => {
        const spy = vi.spyOn(SettingsDirtyCloseModal, 'choose').mockResolvedValue('discard');

        await expect(liveSaveDeps.promptDirtyClose()).resolves.toBe('discard');
        expect(spy).toHaveBeenCalled();
    });

    it('sends the batch to the one endpoint, as the changes it was given', async () => {
        const f = vi.fn(async (_url: string, _init: RequestInit) => ({
            ok: true,
            status: 200,
            json: async () => ({ ok: true, applied: ['webPort'] }),
        }));
        vi.stubGlobal('fetch', f);

        await expect(liveSaveDeps.save(CHANGES)).resolves.toEqual({ ok: true, applied: ['webPort'] });
        expect(f).toHaveBeenCalledWith('/api/settings/batch', expect.objectContaining({ method: 'POST' }));
        // The exact payload, not just the destination: a batch posted to the
        // right URL with the wrong changes is the failure that matters.
        expect(JSON.parse(String(f.mock.calls[0]?.[1].body))).toEqual({ changes: CHANGES });
    });
});

describe('the dialog-level Save button', () => {
    const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

    /** Answers /api/config, stalls everything else — the dockerGating harness. */
    function stubFetchAnsweringConfig(): ReturnType<typeof vi.fn> {
        const f = vi.fn((url: string) => {
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
            return new Promise(() => undefined); // never settles
        });
        vi.stubGlobal('fetch', f);
        return f as unknown as ReturnType<typeof vi.fn>;
    }

    beforeEach(() => {
        document.body.replaceChildren();
        // Track open/closed in the attribute, so the close-path tests below can
        // tell "stayed open" from "closed" without depending on the 250ms
        // real-timer removal the base Modal schedules.
        HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
            this.setAttribute('open', '');
        });
        HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
            this.removeAttribute('open');
        });
        vi.spyOn(authClient, 'me').mockResolvedValue({
            authEnabled: false,
            user: { username: 'admin', role: 'admin' },
        });
    });

    function saveButton(): HTMLButtonElement | null {
        return document.querySelector<HTMLButtonElement>('dialog.settings-modal .modal-footer button.settings-save');
    }

    /** The Server tab's web-port field, staged by a bubbling `change`. */
    function stageWebPort(value: string): void {
        const input = document.querySelector<HTMLInputElement>('dialog.settings-modal input[type="number"]');
        expect(input, 'the web port input').not.toBeNull();
        if (input) {
            input.value = value;
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    it('renders one Save for the whole dialog, disabled while nothing is staged', async () => {
        stubFetchAnsweringConfig();
        new SettingsModal();
        await flush();

        const save = saveButton();
        expect(save).not.toBeNull();
        expect(save?.textContent).toBe('save');
        // Asserted separately from existence: a Save that is live on an
        // untouched dialog invites an empty batch, and would have been the
        // easiest thing to get wrong here.
        expect(save?.disabled).toBe(true);
        // One dialog-level Save, not a per-tab one — that is the whole point of
        // Task 8's per-field-Save deletion.
        expect(document.querySelectorAll('dialog.settings-modal button.settings-save').length).toBe(1);
    });

    it('enables Save once a tab stages something', async () => {
        stubFetchAnsweringConfig();
        new SettingsModal();
        await flush();

        stageWebPort('9000');
        await flush();

        expect(saveButton()?.disabled).toBe(false);
    });

    it('goes back to disabled when the edit is typed back to its original', async () => {
        // The store compares rather than latching, and the button has to follow
        // it — otherwise Save stays lit over an empty change list.
        stubFetchAnsweringConfig();
        new SettingsModal();
        await flush();

        stageWebPort('9000');
        await flush();
        expect(saveButton()?.disabled, 'after staging 9000').toBe(false);

        stageWebPort('8000');
        await flush();
        expect(saveButton()?.disabled, 'after typing 8000 back').toBe(true);
    });

    it('cannot send a batch without going through the summary first', async () => {
        // The DOM-level form of the same guarantee `performStagedSave` pins:
        // there is no path from the button to the endpoint that skips the
        // summary. The summary is refused here, so nothing may be sent.
        const f = stubFetchAnsweringConfig();
        const confirmSpy = vi.spyOn(SettingsSummaryModal, 'confirm').mockResolvedValue(false);
        new SettingsModal();
        await flush();

        stageWebPort('9000');
        await flush();
        saveButton()?.click();
        await flush();

        expect(confirmSpy).toHaveBeenCalledTimes(1);
        // And with the real staged change, so the user is shown what would be
        // sent rather than an empty or stale list.
        expect(confirmSpy.mock.calls[0]?.[0]).toMatchObject([{ id: 'webPort', from: 8000, to: 9000 }]);
        expect(f.mock.calls.map((c) => String(c[0]))).not.toContain('/api/settings/batch');
        // Refusing the summary returns to the dialog with the change still
        // staged — so Save is live again, not stuck disabled.
        expect(saveButton()?.disabled).toBe(false);
    });
});

describe('closing the Settings dialog with work staged', () => {
    const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

    function stubFetchAnsweringConfig(): ReturnType<typeof vi.fn> {
        const f = vi.fn((url: string) => {
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
            return new Promise(() => undefined);
        });
        vi.stubGlobal('fetch', f);
        return f as unknown as ReturnType<typeof vi.fn>;
    }

    beforeEach(() => {
        document.body.replaceChildren();
        HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
            this.setAttribute('open', '');
        });
        HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
            this.removeAttribute('open');
        });
        vi.spyOn(authClient, 'me').mockResolvedValue({
            authEnabled: false,
            user: { username: 'admin', role: 'admin' },
        });
    });

    const dialog = (): HTMLDialogElement | null => document.querySelector<HTMLDialogElement>('dialog.settings-modal');
    const isOpen = (): boolean => dialog()?.hasAttribute('open') === true;

    function stageWebPort(value: string): void {
        const input = document.querySelector<HTMLInputElement>('dialog.settings-modal input[type="number"]');
        if (input) {
            input.value = value;
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    /** Open a dialog and optionally dirty it. */
    async function openDialog(dirty: boolean): Promise<void> {
        stubFetchAnsweringConfig();
        new SettingsModal();
        await flush();
        if (dirty) {
            stageWebPort('9000');
            await flush();
        }
    }

    function clickCloseX(): void {
        [...document.querySelectorAll<HTMLButtonElement>('dialog.settings-modal .modal-close')]
            .find((b) => b.textContent === '×')
            ?.click();
    }

    it('closes immediately when nothing is staged — the control', async () => {
        // Without this, a modal that simply refused to close would pass every
        // "it stayed open" assertion below.
        const spy = vi.spyOn(SettingsDirtyCloseModal, 'choose');
        await openDialog(false);
        expect(isOpen(), 'before closing').toBe(true);

        clickCloseX();
        await flush();

        expect(isOpen()).toBe(false);
        expect(spy, 'a clean dialog must not be interrogated').not.toHaveBeenCalled();
    });

    it('prompts, and CANCEL leaves the dialog open with the change still staged', async () => {
        const spy = vi.spyOn(SettingsDirtyCloseModal, 'choose').mockResolvedValue('cancel');
        await openDialog(true);

        clickCloseX();
        await flush();

        expect(spy).toHaveBeenCalledTimes(1);
        expect(isOpen(), 'the dialog').toBe(true);
        // Asserted separately from "still open": a cancel that kept the dialog
        // up but dropped the edits would satisfy the line above and still have
        // thrown the user's work away.
        expect(saveStillEnabled(), 'Save, i.e. the change is still staged').toBe(true);
    });

    it('prompts, and DISCARD closes', async () => {
        vi.spyOn(SettingsDirtyCloseModal, 'choose').mockResolvedValue('discard');
        await openDialog(true);

        clickCloseX();
        await flush();

        expect(isOpen()).toBe(false);
    });

    it('routes Escape and the backdrop through the same prompt, not straight to close', async () => {
        for (const fire of [
            () => dialog()?.dispatchEvent(new Event('cancel', { cancelable: true })),
            () => dialog()?.dispatchEvent(new MouseEvent('click', { cancelable: true })),
        ]) {
            document.body.replaceChildren();
            vi.unstubAllGlobals();
            const spy = vi.spyOn(SettingsDirtyCloseModal, 'choose').mockResolvedValue('cancel');
            await openDialog(true);

            fire();
            await flush();

            expect(spy).toHaveBeenCalledTimes(1);
            expect(isOpen()).toBe(true);
            spy.mockRestore();
        }
    });

    function saveStillEnabled(): boolean {
        const btn = document.querySelector<HTMLButtonElement>(
            'dialog.settings-modal .modal-footer button.settings-save',
        );
        return btn?.disabled === false;
    }
});
