import {
    EMBEDDER_SCHEMES,
    type EmbedderScheme,
    embedderOriginsFromInput,
    FRAME_ANCESTORS_ADD_ID,
    isEmbedderScheme,
} from '../../../../common/embedderOrigin';
import type { Role } from '../../AuthClient';
import { ADMIN_UNREACHABLE_NOTE } from '../../adminGate';
import { ConfirmModal } from '../../ConfirmModal';
import type { StagedSettingsStore } from '../StagedSettingsStore';
import { buildItem, buildRow, buildSection, buildTabAlert, type TabAlert } from '../settingsLayout';

/**
 * What every tab builder gets, regardless of whether it uses it.
 *
 * Deliberately does NOT carry `docker` or `adminReachable`. Both are known only
 * *after* the `/api/config` probe resolves (`SettingsModal.ts` sets them once
 * `probeRuntime()` answers), whereas every tab is built eagerly during
 * `fillBody`, which runs before that probe settles (`TabStrip` builds all tab
 * bodies synchronously in its constructor). A snapshot taken here would be
 * permanently wrong. Docker gating is handled post-probe by
 * `SettingsModal.applyDockerGating()`, which swaps a tab's whole body via
 * `TabStrip.replaceTabBody()` — no tab needs to know about it itself. If a
 * future tab genuinely needs live probe state, pass an accessor
 * (`isDocker(): boolean`), never a boolean captured at build time.
 */
export interface TabContext {
    role: Role | null;
    authEnabled: boolean;
    reload(): void;
    /**
     * Open a confirm as a child of the Settings dialog (`Modal.askChild`): if
     * Settings closes while it is up, the confirm closes too and this resolves
     * to `unanswered`, which the caller treats as cancel. Every confirm a tab
     * raises goes through here, so none can outlive Settings and then act.
     */
    askChild: AskChild;
    /** Open a non-question dialog (Users) as a child of Settings (`Modal.openChild`). */
    openChild<T>(open: () => T): T;
    /**
     * Switch the Settings dialog to the tab with this id (`TabStrip.activate`;
     * a no-op for an id that was never built). The Local HTTPS tab's mkcert
     * callout uses it to send the user to `dependencies`. Optional, so a tab
     * built on its own (its unit tests) needs no dialog behind it.
     */
    showTab?: (id: string) => void;
    /**
     * The server refused one of this page's admin reads as not from the
     * operator (`adminRefusal` → `operator`), though the dialog's own check said
     * it would answer: that check fails open when it cannot be made. The dialog
     * then does what it does when it knows from the start, holding back every
     * admin control with the note, so no tab shows the refusal as "couldn't
     * reach server" with a retry that can only be refused again (0.5.6).
     * Optional, so a tab built on its own (its unit tests) needs no dialog.
     */
    onAdminRefused?: () => void;
}

export type AskChild = <T>(ask: () => Promise<T>, unanswered: T) => Promise<T>;

/**
 * For a row builder used on its own, outside a Settings dialog (its unit
 * tests): the confirm opens unbound, exactly as it did before `askChild`.
 */
export const askUnbound: AskChild = (ask) => ask();

/** The staged field's summary label: `Allowed embedders: none added → add http://…`. */
export const EMBED_ADD_LABEL = 'Allowed embedders';

/** Under the add row while `http & https` is chosen, whose port box is then disabled. */
export const EMBED_BOTH_SCHEMES_NOTE =
    'uses 80 for http and 443 for https; for other ports, add each scheme separately.';

/**
 * Under the add row, always: an https page cannot frame this app over http
 * (browsers block mixed content in a frame), so pre-approving an https
 * embedder only works once this app is served over https as well. The last
 * sentence names the way to get there, which differs in a container, where
 * Local HTTPS is not supported (`embedHttpsNote`).
 */
const EMBED_HTTPS_NOTE_LEAD =
    'an https page can only embed this app when this app is served over https too; browsers block an http frame inside an https page. ';

/** The https note for a host install, or for a container (`container`), where only a reverse proxy can serve https. */
export function embedHttpsNote(container: boolean): string {
    return (
        EMBED_HTTPS_NOTE_LEAD +
        (container
            ? 'serve this app over https from your reverse proxy first.'
            : 'set up local https or a reverse proxy first.')
    );
}

/**
 * Per-instance container switches, keyed by the section `buildEmbeddingTab`
 * returned (the same WeakMap shape as the other tabs' appliers): container mode
 * is learned after every tab is built.
 */
const containerModeAppliers = new WeakMap<HTMLElement, () => void>();
const refreshers = new WeakMap<HTMLElement, () => Promise<void>>();
const heldBackAppliers = new WeakMap<HTMLElement, () => void>();

/**
 * Read the allowed list for an Embedding tab `buildEmbeddingTab` built, which
 * fills it and shows the add row. Held until the dialog knows the read will be
 * answered: `/api/embed-origins` answers only an admin on the machine itself
 * (`requireLocalAdmin`), so SettingsModal calls this only then (0.5.5; the tab
 * used to read at build and show a refusal to anyone else). A no-op if
 * `section` was never built through `buildEmbeddingTab`.
 */
export async function refreshEmbedding(section: HTMLElement): Promise<void> {
    await refreshers.get(section)?.();
}

/**
 * Tell an Embedding tab its list will not be read on this page: it says why
 * (`ADMIN_UNREACHABLE_NOTE`) where the list would be, and the add row, and
 * with it every add and revoke, stays hidden. A no-op if `section` was never
 * built through `buildEmbeddingTab`.
 */
export function applyEmbeddingHeldBack(section: HTMLElement): void {
    heldBackAppliers.get(section)?.();
}

/**
 * Tell an Embedding tab it is running in a container, so its https note names
 * the reverse proxy alone (Local HTTPS is not supported there). A no-op if
 * `section` was never built through `buildEmbeddingTab`.
 */
export function applyEmbeddingContainerMode(section: HTMLElement): void {
    containerModeAppliers.get(section)?.();
}

/**
 * The field's baseline. ONE frozen instance, deliberately: the store compares
 * values with `Object.is`, so removing the last pending origin must put back
 * this very array for the field to read as unchanged again. A fresh `[]` would
 * leave Save enabled over nothing.
 */
const NONE_PENDING: readonly string[] = Object.freeze([]);

/** Summary text for the staged additions. */
export function formatEmbedAdditions(value: unknown): string {
    return Array.isArray(value) && value.length > 0 ? `add ${value.join(', ')}` : 'none added';
}

function registerEmbedAddField(store: StagedSettingsStore): void {
    store.register({
        id: FRAME_ANCESTORS_ADD_ID,
        label: EMBED_ADD_LABEL,
        initial: NONE_PENDING,
        format: formatEmbedAdditions,
    });
}

/**
 * The origins staged for addition and not yet saved, read off the store so
 * the tab and the batch cannot disagree.
 *
 * Read through `changes()` rather than `get()`: after a successful Save,
 * `commit()` makes the staged array the new BASELINE, so it is no longer a
 * change -- and no longer pending -- even though `get()` still returns it.
 */
export function pendingEmbedOrigins(store: StagedSettingsStore): string[] {
    const change = store.changes().find((c) => c.id === FRAME_ANCESTORS_ADD_ID);
    return Array.isArray(change?.to) ? (change.to as string[]) : [];
}

/** Everything one Embedding tab instance holds between renders. */
interface EmbeddingView {
    askChild: AskChild;
    store: StagedSettingsStore;
    /** The approved and pending rows: one item of the tab's card, with no lines between its rows. */
    list: HTMLElement;
    /** The add row and its notes, the card's other item; hidden until the approved list has loaded. */
    adder: HTMLElement;
    /** As the server last listed them; `null` while the first read is in flight. */
    approved: string[] | null;
    /** Why the list could not be read, if it could not. */
    error: string | null;
    /** The tab's status line, below the card: where a revoke that never reached the server says so. */
    alert: TabAlert;
    /** The list will not be read on this page (`applyEmbeddingHeldBack`): say why, offer nothing. */
    heldBack: boolean;
}

/**
 * The Embedding tab (admin-only) — origins allowed to frame this app, each
 * with a revoke button, and below them a row to pre-approve another.
 *
 * Permission is granted through the consent prompt the embedding app raises,
 * or (since 0.5.3) added here ahead of time. Without this tab the prompt was a
 * one-way door: approving wrote an origin into config.json and there was no
 * way back short of hand-editing the file.
 *
 * The two halves deliberately behave differently:
 *
 * - **Revoke is an action**, an immediate confirmed POST that takes effect on
 *   the running server at once. Nothing about it is staged.
 * - **Adding is a staged setting** (`frameAncestorsAdd`). The add row only puts
 *   the origin(s) in the store; they show in the list marked as pending, can
 *   be removed again, and are written only when the dialog's Save sends the
 *   batch (`SettingsBatchApi` → `Config.addFrameAncestors`, the same store a
 *   consent approval writes). Closing without saving discards them, through the
 *   dialog's ordinary unsaved-changes prompt.
 */
export function buildEmbeddingTab(ctx: TabContext, store: StagedSettingsStore): HTMLElement {
    const { section, card } = buildSection('Embedding');
    registerEmbedAddField(store);

    // One item for the whole list, as the add row below is another: the
    // origins are one setting, read as one block, and the card's dividing
    // line runs between the list and the add row, not between every origin.
    const list = buildItem();
    list.setAttribute('data-embed-list', '');

    const view: EmbeddingView = {
        askChild: ctx.askChild,
        store,
        list,
        adder: document.createElement('div'),
        approved: null,
        error: null,
        // Built now, but below the card all the same: the card is already in
        // the section and is its only one.
        alert: buildTabAlert(section),
        heldBack: false,
    };
    view.adder = buildAddRow(view);
    card.append(list, view.adder);
    renderEmbedOrigins(view);

    store.subscribe(() => {
        // A successful Save commits: the staged array becomes the baseline and
        // stops being a change. Re-baseline to "nothing pending", so a later
        // removal compares against the empty list again, and re-read the list,
        // which now holds what was just saved.
        const value = store.get(FRAME_ANCESTORS_ADD_ID);
        if (Array.isArray(value) && value.length > 0 && pendingEmbedOrigins(store).length === 0) {
            registerEmbedAddField(store);
            void refreshEmbedOrigins(view);
            return;
        }
        renderEmbedOrigins(view);
    });

    // No read here: the dialog decides whether this page may make it
    // (refreshEmbedding / applyEmbeddingHeldBack), and until then the list says
    // "loading…".
    refreshers.set(section, () => refreshEmbedOrigins(view));
    heldBackAppliers.set(section, () => {
        view.heldBack = true;
        renderEmbedOrigins(view);
    });
    containerModeAppliers.set(section, () => {
        const note = view.adder.querySelector<HTMLElement>('[data-embed-https-note]');
        if (note) note.textContent = embedHttpsNote(true);
    });
    return section;
}

async function refreshEmbedOrigins(view: EmbeddingView): Promise<void> {
    try {
        const res = await fetch('/api/embed-origins', { headers: { Accept: 'application/json' } });
        if (res.status === 403) {
            // Refused: the list answers only an admin on the machine itself,
            // whatever the remote-admin policy, so this is held back as the
            // dialog holds it back when it knows from the start; never an
            // error to retry (0.5.6). The rest of the dialog is not told: a
            // page this route refuses may still be an admin everywhere else.
            view.heldBack = true;
        } else if (!res.ok) {
            view.error = 'could not read the list — see server logs.';
        } else {
            const data = (await res.json()) as { origins?: string[] };
            view.approved = data.origins ?? [];
            view.error = null;
        }
    } catch {
        view.error = 'could not reach the server.';
    }
    renderEmbedOrigins(view);
}

/**
 * Redraw the approved and pending rows. The add row is NOT rebuilt, so what
 * the user has typed into it survives every redraw.
 */
function renderEmbedOrigins(view: EmbeddingView): void {
    const { list, askChild, store } = view;
    list.textContent = '';
    // The add row needs the approved list for its duplicate check, and a list
    // that could not be read (another machine, say) means Save would be refused.
    setAdderVisible(view.adder, view.approved !== null && view.error === null && !view.heldBack);
    if (view.heldBack) {
        // Every add and revoke would only be refused from this page.
        const note = buildRow(ADMIN_UNREACHABLE_NOTE, null);
        note.setAttribute('data-admin-unreachable-note', '');
        list.appendChild(note);
        return;
    }

    const pending = pendingEmbedOrigins(store);
    // On a read error the approved list is unknown, but anything already
    // pending is still staged and Save would still send it, so it stays listed.
    let approved: string[] = [];
    // Lines of text with no control: `null` lets each span both columns.
    if (view.error) {
        list.appendChild(buildRow(view.error, null));
    } else if (view.approved === null) {
        list.appendChild(buildRow('loading…', null));
        return;
    } else if (view.approved.length === 0 && pending.length === 0) {
        list.appendChild(buildRow('No other origins may embed this app.', null));
        return;
    } else {
        approved = view.approved;
    }

    for (const origin of approved) {
        const revokeBtn = document.createElement('button');
        revokeBtn.type = 'button';
        revokeBtn.className = 'modal-button';
        revokeBtn.textContent = 'revoke';
        revokeBtn.addEventListener('click', () => {
            void (async () => {
                // Confirm first: revoking silently breaks a working embed in the other app,
                // and the browser reports that as "refused to connect" — easy to misread as
                // the server being down.
                const sure = await askChild(
                    () =>
                        ConfirmModal.confirm({
                            title: 'revoke embedding permission?',
                            message:
                                `${origin} will no longer be able to display this app in a frame. ` +
                                'Anything it is currently showing will stop working immediately. ' +
                                'It can ask again.',
                        }),
                    false,
                );
                if (!sure) return;

                revokeBtn.disabled = true;
                try {
                    const res = await fetch('/api/embed-origins/revoke', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ origin }),
                    });
                    if (res.ok) {
                        const updated = (await res.json()) as { origins?: string[] };
                        view.approved = updated.origins ?? [];
                        view.error = null;
                        renderEmbedOrigins(view);
                    } else {
                        // Most likely a stale list — re-read rather than guess.
                        await refreshEmbedOrigins(view);
                    }
                } catch {
                    // An action's result, so on the tab's line; the list is
                    // drawn again as it was, which also gives the button back.
                    view.alert.show('error', 'could not reach the server.');
                    renderEmbedOrigins(view);
                }
            })();
        });
        list.appendChild(buildRow(origin, revokeBtn));
    }

    // Pending additions: staged, not saved. Marked as such, and removable with
    // no confirmation, since removing one changes nothing on the server.
    for (const origin of pending) {
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'modal-button';
        removeBtn.textContent = 'remove';
        removeBtn.setAttribute('aria-label', `remove ${origin} before saving`);
        removeBtn.addEventListener('click', () => {
            const rest = pendingEmbedOrigins(store).filter((o) => o !== origin);
            // Back to the baseline instance itself when nothing is left, so the
            // field reads as unchanged (see NONE_PENDING).
            store.set(FRAME_ANCESTORS_ADD_ID, rest.length > 0 ? rest : NONE_PENDING);
        });

        const row = buildRow(origin, removeBtn);
        row.setAttribute('data-embed-pending', origin);
        const tag = document.createElement('span');
        tag.className = 'settings-pending-tag';
        tag.textContent = 'pending — saved when you click save';
        row.querySelector('.settings-label')?.appendChild(tag);
        list.appendChild(row);
    }
}

/** Show or hide the add row's item (modal.css's `.settings-item[hidden]` takes it out of the layout). */
function setAdderVisible(adder: HTMLElement, visible: boolean): void {
    adder.hidden = !visible;
}

/**
 * The bottom row: address, port, scheme, add. Built once per tab; a redraw of
 * the list never touches it, so a half-typed entry survives one.
 *
 * Validated as the user types (`embedderOriginsFromInput`): a bad address or
 * port shows its reason on the line under the row and disables add, and an
 * empty address simply disables add with nothing to complain about yet. The
 * click validates again rather than trusting the button state.
 *
 * An origin that is already allowed, or already pending, is never staged
 * twice. If every origin one add would stage is a duplicate, nothing changes
 * and the line says so; with `http & https`, the new one is staged and the line
 * names the one that was skipped.
 *
 * `http & https` takes no port (after 0.5.3): one port cannot be the default
 * of both schemes, and port 80 with it used to stage `https://host:80`. While
 * it is chosen the port box is emptied and disabled, with a note saying how to
 * add another port; switching back re-enables the box, empty. Below it all, a
 * standing note that an https embedder needs this app on https too.
 */
function buildAddRow(view: EmbeddingView): HTMLElement {
    // The row and every note under it are one item.
    const wrap = buildItem();
    wrap.setAttribute('data-embed-add', '');

    const address = document.createElement('input');
    address.type = 'text';
    address.className = 'settings-input';
    address.placeholder = 'ip address or hostname';
    address.setAttribute('aria-label', 'embedder address');
    address.setAttribute('data-embed-address', '');
    address.autocomplete = 'off';
    address.spellcheck = false;
    // The one box that gives way: it starts from 9rem and grows into what the
    // others leave, so at the dialog's default width the whole row -- address,
    // port, scheme and add -- fits on one line. `.settings-input`'s 100% width
    // and 240px cap would make it ask for more than that line has, and a
    // wrapping row then breaks before anything shrinks.
    address.style.flex = '1 1 9rem';
    address.style.width = 'auto';
    address.style.minWidth = '9rem';
    address.style.maxWidth = 'none';

    // A text box, not type="number": a number input reports an entry it cannot
    // parse as '', which would read as "blank" and silently drop the port.
    const port = document.createElement('input');
    port.type = 'text';
    port.inputMode = 'numeric';
    port.className = 'settings-input';
    port.style.width = '80px';
    port.style.maxWidth = '80px';
    port.style.flexShrink = '0';
    port.placeholder = '80';
    port.setAttribute('aria-label', 'embedder port');
    port.setAttribute('data-embed-port', '');
    port.autocomplete = 'off';

    const scheme = document.createElement('select');
    scheme.className = 'settings-input';
    // Sized to its longest option ("http & https"), never squeezed below it:
    // `.settings-input` is `width: 100%`, which let the flex row shrink the
    // list until that option read "http & htt…".
    scheme.style.width = 'auto';
    scheme.style.maxWidth = 'none';
    scheme.style.flexShrink = '0';
    scheme.setAttribute('aria-label', 'embedder scheme');
    scheme.setAttribute('data-embed-scheme', '');
    const schemeText: Record<EmbedderScheme, string> = { http: 'http', https: 'https', both: 'http & https' };
    for (const value of EMBEDDER_SCHEMES) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = schemeText[value];
        scheme.appendChild(opt);
    }
    scheme.value = 'http';

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'modal-button';
    addBtn.textContent = 'add';
    addBtn.setAttribute('data-embed-add-button', '');
    addBtn.disabled = true;
    addBtn.style.flexShrink = '0';

    const controls = document.createDocumentFragment();
    controls.append(address, port, scheme, addBtn);
    const addRow = buildRow('add an embedder', controls);
    // Only on a genuinely narrow dialog, where even the address box at its
    // 9rem minimum does not fit, do the controls wrap onto a second line
    // rather than overflow.
    const addControls = addRow.querySelector<HTMLElement>('.settings-control');
    if (addControls) addControls.style.flexWrap = 'wrap';
    wrap.appendChild(addRow);

    const bothNote = document.createElement('p');
    bothNote.className = 'settings-status';
    bothNote.style.gridColumn = '1 / -1';
    bothNote.setAttribute('data-embed-both-note', '');
    bothNote.textContent = EMBED_BOTH_SCHEMES_NOTE;
    bothNote.hidden = true;
    wrap.appendChild(bothNote);

    const message = document.createElement('p');
    message.className = 'settings-status';
    message.style.gridColumn = '1 / -1';
    message.setAttribute('data-embed-add-message', '');
    message.setAttribute('role', 'status');
    message.hidden = true;
    wrap.appendChild(message);

    // Always shown. The host wording until the dialog learns it is in a
    // container (applyEmbeddingContainerMode).
    const httpsNote = document.createElement('p');
    httpsNote.className = 'settings-status';
    httpsNote.style.gridColumn = '1 / -1';
    httpsNote.setAttribute('data-embed-https-note', '');
    httpsNote.textContent = embedHttpsNote(false);
    wrap.appendChild(httpsNote);

    /** `http & https` empties and disables the port box; the other two give it back, empty. */
    const applySchemeToPort = (): void => {
        const both = scheme.value === 'both';
        if (both || port.disabled) port.value = '';
        port.disabled = both;
        bothNote.hidden = !both;
    };

    const say = (text: string, isError: boolean): void => {
        message.textContent = text;
        message.hidden = text.length === 0;
        message.classList.toggle('settings-status-error', isError);
    };

    const read = () =>
        embedderOriginsFromInput({
            address: address.value,
            port: port.value,
            scheme: isEmbedderScheme(scheme.value) ? scheme.value : 'http',
        });

    // Live check: an empty address is not yet an error (nothing typed), it
    // just leaves add disabled; anything else that fails is shown at once.
    const validate = (): void => {
        const result = read();
        address.setAttribute(
            'aria-invalid',
            String(!result.ok && result.field === 'address' && address.value.trim() !== ''),
        );
        port.setAttribute('aria-invalid', String(!result.ok && result.field === 'port'));
        if (result.ok) {
            addBtn.disabled = false;
            say('', false);
            return;
        }
        addBtn.disabled = true;
        const nothingTyped = result.field === 'address' && address.value.trim() === '';
        say(nothingTyped ? '' : result.error, !nothingTyped);
    };
    address.addEventListener('input', validate);
    port.addEventListener('input', validate);
    scheme.addEventListener('change', () => {
        applySchemeToPort();
        validate();
    });

    const add = (): void => {
        const result = read();
        if (!result.ok) {
            validate();
            if (result.field === 'address' && address.value.trim() === '') say(result.error, true);
            return;
        }
        const approved = view.approved ?? [];
        const pending = pendingEmbedOrigins(view.store);
        const fresh = result.origins.filter((o) => !approved.includes(o) && !pending.includes(o));
        const skipped = result.origins.filter((o) => !fresh.includes(o));
        const describe = (o: string): string =>
            approved.includes(o) ? `${o} is already allowed` : `${o} is already waiting to be saved`;

        if (fresh.length === 0) {
            // Nothing new: refuse, keep what was typed so it can be corrected.
            say(`${skipped.map(describe).join('; ')}.`, true);
            return;
        }
        view.store.set(FRAME_ANCESTORS_ADD_ID, [...pending, ...fresh]);
        address.value = '';
        port.value = '';
        addBtn.disabled = true;
        address.setAttribute('aria-invalid', 'false');
        port.setAttribute('aria-invalid', 'false');
        say(skipped.length > 0 ? `${skipped.map(describe).join('; ')}; added ${fresh.join(', ')}.` : '', false);
    };
    addBtn.addEventListener('click', add);
    // Enter in either box adds, like a one-line form.
    for (const input of [address, port]) {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                add();
            }
        });
    }

    return wrap;
}
