// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://box.lan:8000/" }
//
// Deliberately NOT jsdom's default localhost. The redirect assertions compare
// the navigated host against this page's host, and under `localhost` that
// comparison is `localhost === localhost` — it holds just as well for code that
// hard-codes a literal `http://localhost:<port>`, which is the exact bug
// `sameOriginUrl` exists to prevent (it sent every off-box client to its own
// machine). On a non-localhost host the assertion can actually fail.

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
        navigate: vi.fn((url: string) => {
            calls.push(`navigate(${url})`);
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
        //
        // The LABEL, as the summary showed it — not the wire id. The user just
        // confirmed "Web port: 8000 → 80"; answering with `webPort` makes them
        // translate an internal identifier back to the row they touched.
        expect(action.kind === 'failed' && action.message).toContain('Web port');
        expect(action.kind === 'failed' && action.message).not.toContain('webPort');
        expect(action.kind === 'failed' && action.message).toContain('port 80 is in use');
    });

    /**
     * A batch can genuinely HALF-land: `SettingsBatchApi` applies non-webPort
     * changes one at a time and stops at the first refusal, so the siblings
     * before it are already written on the server. The user is reading this
     * message to decide whether to Discard — and a message that names only the
     * failure invites them to throw away edits that have in fact taken effect.
     */
    it('names what was already applied when a batch half-lands', async () => {
        const store = new StagedSettingsStore();
        store.register({ id: 'channel', label: 'Update channel', initial: 'beta' });
        store.register({ id: 'autoUpdate', label: 'Automatic updates', initial: true });
        store.set('channel', 'stable');
        store.set('autoUpdate', false);

        const deps = mockDeps({
            save: vi.fn(async () => ({
                ok: false,
                applied: ['channel'],
                // Deliberately an error string that does NOT repeat the wire id,
                // so the "never shows a wire id" assertion below tests the
                // message's own wording rather than the server's error text.
                failed: { id: 'autoUpdate', error: 'must be a boolean' },
            })),
        });

        const action = await performStagedSave(store, deps);
        const message = action.kind === 'failed' ? action.message : '';

        // Both by LABEL, like the failure itself — the user confirmed a summary
        // of labels, not wire ids.
        expect(message).toContain('applied Update channel');
        expect(message).toContain("couldn't save Automatic updates");
        expect(message).not.toContain('autoUpdate');
        expect(message).not.toContain('channel:');
    });

    it('says nothing about applied changes when none landed', async () => {
        const deps = mockDeps({
            save: vi.fn(async () => ({
                ok: false,
                applied: [],
                failed: { id: 'webPort', error: 'port 80 is in use' },
            })),
        });

        const action = await performStagedSave(stagedStore(), deps);
        // A bare "applied ;" prefix on the common case would be noise.
        expect(action.kind === 'failed' && action.message).not.toContain('applied');
    });

    it('reports what landed even when the connection dropped and no id is named', async () => {
        const store = new StagedSettingsStore();
        store.register({ id: 'channel', label: 'Update channel', initial: 'beta' });
        store.set('channel', 'stable');

        const deps = mockDeps({
            save: vi.fn(async () => ({
                ok: false,
                applied: ['channel'],
                failed: { id: '', error: "couldn't reach server" },
            })),
        });

        const action = await performStagedSave(store, deps);
        const message = action.kind === 'failed' ? action.message : '';
        expect(message).toContain('applied Update channel');
        expect(message).toContain("couldn't reach server");
    });

    it('falls back to the id when the failure names something not in this batch', async () => {
        // Nothing guarantees the server names an id the client staged. Better a
        // raw id than "couldn't save undefined".
        const deps = mockDeps({
            save: vi.fn(async () => ({
                ok: false,
                applied: [],
                failed: { id: 'somethingElse', error: 'nope' },
            })),
        });

        const action = await performStagedSave(stagedStore(), deps);

        expect(action.kind === 'failed' && action.message).toContain('somethingElse');
    });

    it('re-baselines the store on success, so applied changes stop counting as staged', async () => {
        // Finding 3: on the restart path the dialog stays up for the countdown.
        // A store still reporting these as staged makes that dialog prompt
        // "unsaved changes" about a batch the server has already applied.
        const store = stagedStore();
        const deps = mockDeps({
            save: vi.fn(async () => ({
                ok: true,
                applied: ['webPort'],
                restartRequired: true,
                redirectPort: 9000,
            })),
        });

        await performStagedSave(store, deps);

        expect(store.changes()).toEqual([]);
        expect(store.isDirty()).toBe(false);
        // Re-baselined to the SAVED value, not rolled back to the old one —
        // `reset()` would have put 8000 back and told the user their port change
        // had evaporated.
        expect(store.get('webPort')).toBe(80);
    });

    it('does NOT re-baseline when the batch was refused', async () => {
        // The other side of the same coin, and the one that must never move.
        const store = stagedStore();
        const deps = mockDeps({
            save: vi.fn(async () => ({ ok: false, applied: [], failed: { id: 'webPort', error: 'nope' } })),
        });

        await performStagedSave(store, deps);

        expect(store.isDirty()).toBe(true);
        expect(store.get('webPort')).toBe(80);
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

/**
 * The redirect as a USER experiences it: Save a new web port, and the browser
 * ends up on that port.
 *
 * `performStagedSave` returning `{kind:'redirect', url}` is only the pure half.
 * The effectful half — a `setTimeout` that assigns `location.href` — could be
 * deleted outright with every other assertion in this file still green, while
 * the server restarts and the browser sits on a dead port forever. That is the
 * whole failure this requirement exists to prevent, so it is pinned here
 * end-to-end: real modal, real Save button, real batch response.
 */
describe('the restart redirect actually navigates', () => {
    /** Flush promise chains while timers are faked. */
    const settle = async (): Promise<void> => {
        for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(0);
    };

    beforeEach(() => {
        vi.useFakeTimers();
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

    afterEach(() => {
        vi.useRealTimers();
    });

    /** /api/config, then a batch that restarts the server on port 9000. */
    function stubFetchRestartingOn(port: number): { batchCount: () => number } {
        const f = vi.fn((url: string) => {
            if (typeof url === 'string' && url.startsWith('/api/settings/batch')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () =>
                        Promise.resolve({
                            ok: true,
                            applied: ['webPort'],
                            restartRequired: true,
                            redirectPort: port,
                        }),
                });
            }
            return Promise.resolve({
                ok: true,
                status: 200,
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
        });
        vi.stubGlobal('fetch', f);
        return {
            batchCount: () => f.mock.calls.filter((c) => String(c[0]).startsWith('/api/settings/batch')).length,
        };
    }

    /** Stage a new web port and click Save. */
    async function saveWebPort(value: string): Promise<void> {
        const input = document.querySelector<HTMLInputElement>('dialog.settings-modal input[type="number"]');
        expect(input, 'the web port input').not.toBeNull();
        if (input) {
            input.value = value;
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        await settle();
        document.querySelector<HTMLButtonElement>('dialog.settings-modal .modal-footer button.settings-save')?.click();
        await settle();
    }

    it('waits out the delay, then navigates to the port the server named', async () => {
        const navigate = vi.spyOn(liveSaveDeps, 'navigate').mockImplementation(() => undefined);
        vi.spyOn(SettingsSummaryModal, 'confirm').mockResolvedValue(true);
        stubFetchRestartingOn(9000);

        new SettingsModal();
        await settle();
        const input = document.querySelector<HTMLInputElement>('dialog.settings-modal input[type="number"]');
        expect(input, 'the web port input').not.toBeNull();
        if (input) {
            input.value = '9000';
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        await settle();
        document.querySelector<HTMLButtonElement>('dialog.settings-modal .modal-footer button.settings-save')?.click();
        await settle();

        // The batch has come back and the notice is up, but the page has NOT
        // moved yet — navigating before the supervisor rebinds the port gets a
        // connection refused.
        expect(
            document.querySelector('dialog.settings-modal .settings-save-status')?.textContent,
            'the notice while waiting',
        ).toBe('restarting → redirecting…');
        expect(navigate, 'before any time passes').not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(RESTART_REDIRECT_DELAY_MS - 1);
        expect(navigate, 'one millisecond before the delay elapses').not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);

        expect(navigate, 'once the delay elapses').toHaveBeenCalledTimes(1);
        // Asserted apart from "it navigated": navigating to the WRONG port is
        // still navigating, and strands the browser exactly as badly as not
        // navigating at all.
        const url = new URL(String(navigate.mock.calls[0]?.[0]));
        expect(url.port).toBe('9000');
        expect(url.hostname, 'the browser stays on its own host').toBe(window.location.hostname);
    });

    it('does not claim unsaved changes if the user closes during the countdown', async () => {
        // Finding 3. The dialog is up for four seconds with × and Escape live,
        // and by then the batch has been APPLIED — prompting "you have unsaved
        // changes" about it is simply false, and offering to save it again
        // offers to re-apply a port change to a restarting server.
        vi.spyOn(liveSaveDeps, 'navigate').mockImplementation(() => undefined);
        vi.spyOn(SettingsSummaryModal, 'confirm').mockResolvedValue(true);
        const prompt = vi.spyOn(SettingsDirtyCloseModal, 'choose').mockResolvedValue('cancel');
        stubFetchRestartingOn(9000);

        new SettingsModal();
        await settle();
        const input = document.querySelector<HTMLInputElement>('dialog.settings-modal input[type="number"]');
        if (input) {
            input.value = '9000';
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        await settle();
        document.querySelector<HTMLButtonElement>('dialog.settings-modal .modal-footer button.settings-save')?.click();
        await settle();

        // Mid-countdown, the user gives up waiting and hits the ×.
        await vi.advanceTimersByTimeAsync(1000);
        [...document.querySelectorAll<HTMLButtonElement>('dialog.settings-modal .modal-close')]
            .find((b) => b.textContent === '×')
            ?.click();
        await settle();

        expect(prompt, 'the unsaved-changes prompt').not.toHaveBeenCalled();
    });

    it('will not send another batch if the user edits a field during the countdown', async () => {
        // The dialog is still interactive for those four seconds, and the server
        // is on its way down. An edit here re-dirties the store, so nothing but
        // the in-flight/leaving guard stops Save lighting up and firing a second
        // webPort apply at a process that is mid-restart.
        vi.spyOn(liveSaveDeps, 'navigate').mockImplementation(() => undefined);
        vi.spyOn(SettingsSummaryModal, 'confirm').mockResolvedValue(true);
        const { batchCount } = stubFetchRestartingOn(9000);

        new SettingsModal();
        await settle();
        await saveWebPort('9000');
        expect(batchCount(), 'the port change went out').toBe(1);

        await vi.advanceTimersByTimeAsync(1000);
        const input = document.querySelector<HTMLInputElement>('dialog.settings-modal input[type="number"]');
        if (input) {
            input.value = '9100';
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        await settle();

        const btn = document.querySelector<HTMLButtonElement>(
            'dialog.settings-modal .modal-footer button.settings-save',
        );
        expect(btn?.disabled, 'Save during the countdown').toBe(true);
        expect(batchCount(), 'after editing during the countdown').toBe(1);
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

    /**
     * A fetch whose /api/settings/batch never settles, so the test can act
     * while the batch is genuinely in flight.
     */
    function stubFetchWithHangingBatch(): { fetch: ReturnType<typeof vi.fn>; batchCount: () => number } {
        const f = vi.fn((url: string) => {
            if (typeof url === 'string' && url.startsWith('/api/settings/batch')) {
                return new Promise(() => undefined); // never settles
            }
            return Promise.resolve({
                ok: true,
                json: () =>
                    Promise.resolve({
                        config: { webPort: 8000 },
                        runtime: { firstRunComplete: true, portWasAutoShifted: false, webPort: 8000, docker: false },
                    }),
            });
        });
        vi.stubGlobal('fetch', f);
        return {
            fetch: f as unknown as ReturnType<typeof vi.fn>,
            batchCount: () =>
                (f as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c: unknown[]) =>
                    String(c[0]).startsWith('/api/settings/batch'),
                ).length,
        };
    }

    it('cannot send a second batch while the first is still in flight', async () => {
        // The store has no idea a fetch is outstanding, and it is RIGHT not to:
        // editing a field mid-request genuinely does make the dialog dirty
        // again. So the dirtiness signal re-enables Save from underneath any
        // guard that lives only at the click site, and the second batch races
        // the first — a second webPort apply against a server that may already
        // be restarting.
        const { batchCount } = stubFetchWithHangingBatch();
        vi.spyOn(SettingsSummaryModal, 'confirm').mockResolvedValue(true);
        new SettingsModal();
        await flush();

        stageWebPort('9000');
        await flush();
        saveButton()?.click();
        await flush();
        expect(batchCount(), 'the first batch went out').toBe(1);

        // Now dirty the dialog again while that batch hangs.
        stageWebPort('9100');
        await flush();

        expect(saveButton()?.disabled, 'Save while a batch is in flight').toBe(true);
        expect(batchCount(), 'after editing mid-flight').toBe(1);

        // And the guard is real, not just a disabled attribute: force the button
        // live and click it. A `disabled` that is the ONLY defence would let
        // this through.
        const btn = saveButton();
        if (btn) btn.disabled = false;
        btn?.click();
        await flush();

        expect(batchCount(), 'after clicking a force-enabled Save').toBe(1);
    });

    it('drops a dismissal that arrives while a batch is in flight', async () => {
        // The close path reaches the same performStagedSave via its `save`
        // choice, so guarding only the button leaves this door open.
        const { batchCount } = stubFetchWithHangingBatch();
        vi.spyOn(SettingsSummaryModal, 'confirm').mockResolvedValue(true);
        const prompt = vi.spyOn(SettingsDirtyCloseModal, 'choose').mockResolvedValue('save');
        new SettingsModal();
        await flush();

        stageWebPort('9000');
        await flush();
        saveButton()?.click();
        await flush();
        expect(batchCount()).toBe(1);

        [...document.querySelectorAll<HTMLButtonElement>('dialog.settings-modal .modal-close')]
            .find((b) => b.textContent === '×')
            ?.click();
        await flush();

        expect(prompt, 'no prompt while the save it would ask about is outstanding').not.toHaveBeenCalled();
        expect(batchCount()).toBe(1);
        expect(document.querySelector('dialog.settings-modal')?.hasAttribute('open')).toBe(true);
    });

    it('a refused batch leaves the dialog open, the change staged and Save usable', async () => {
        // Finding 2: requirement 2's hazard was a TAB REFRESHER, which only this
        // class can call — so the pin has to be here, not on performStagedSave.
        // A refreshServer() added to the failure branch re-registers webPort
        // from /api/config and silently discards the staged edit; every
        // assertion below is chosen to notice that.
        const bodies: unknown[] = [];
        const f = vi.fn((url: string, init?: RequestInit) => {
            if (typeof url === 'string' && url.startsWith('/api/settings/batch')) {
                bodies.push(JSON.parse(String(init?.body)));
                return Promise.resolve({
                    ok: false,
                    status: 400,
                    json: () =>
                        Promise.resolve({
                            ok: false,
                            applied: [],
                            failed: { id: 'webPort', error: 'port 9000 is in use' },
                        }),
                });
            }
            return Promise.resolve({
                ok: true,
                json: () =>
                    Promise.resolve({
                        config: { webPort: 8000 },
                        runtime: { firstRunComplete: true, portWasAutoShifted: false, webPort: 8000, docker: false },
                    }),
            });
        });
        vi.stubGlobal('fetch', f);
        vi.spyOn(SettingsSummaryModal, 'confirm').mockResolvedValue(true);
        new SettingsModal();
        await flush();

        stageWebPort('9000');
        await flush();
        saveButton()?.click();
        await flush();

        expect(
            document.querySelector('dialog.settings-modal .settings-save-status')?.textContent,
            'the refusal, named and explained',
        ).toBe("couldn't save Web port: port 9000 is in use");
        expect(document.querySelector('dialog.settings-modal')?.hasAttribute('open'), 'the dialog').toBe(true);
        expect(saveButton()?.disabled, 'Save after a refusal').toBe(false);

        // The staged change survived: sending again sends the SAME change.
        // This is what a refresh on the failure path would destroy.
        saveButton()?.click();
        await flush();
        expect(bodies).toHaveLength(2);
        expect(bodies[1]).toEqual(bodies[0]);
        expect(bodies[1]).toMatchObject({ changes: [{ id: 'webPort', from: 8000, to: 9000 }] });
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
