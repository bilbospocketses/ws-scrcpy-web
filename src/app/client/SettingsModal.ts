import type { AppConfigEnvelope } from '../../common/ConfigEvents';
import { FRAME_ANCESTORS_ADD_ID } from '../../common/embedderOrigin';
import { REMOTE_ADMIN_ID } from '../../common/remoteAdmin';
import { sameOriginUrl } from '../sameOriginUrl';
import { Modal } from '../ui/Modal';
import { authClient, type Role } from './AuthClient';
import { announceAdminAccessLost } from './adminAccess';
import { ADMIN_UNREACHABLE_NOTE, adminApiReachable, canSeeSection } from './adminGate';
import { DEPENDENCY_INSTALLED_EVENT } from './DependencyPanel';
import { closeIntent } from './settings/closeIntent';
import { type BatchResult, runSave } from './settings/SaveRunner';
import { SettingsSummaryModal } from './settings/SettingsSummaryModal';
import { type Change, StagedSettingsStore } from './settings/StagedSettingsStore';
import {
    buildItem,
    buildSection,
    buildTabAlert,
    destroyTabAlerts,
    type TabAlertKind,
    tabAlertIn,
} from './settings/settingsLayout';
import { type TabDef, TabStrip } from './settings/TabStrip';
import { buildDependenciesTab, destroyDependenciesTab, refreshDependencies } from './settings/tabs/DependenciesTab';
import {
    applyEmbeddingContainerMode,
    applyEmbeddingHeldBack,
    buildEmbeddingTab,
    refreshEmbedding,
    type TabContext,
} from './settings/tabs/EmbeddingTab';
import {
    applyLocalHttpsContainerMode,
    applyLocalHttpsDependencyInstalled,
    applyLocalHttpsServiceStatus,
    applyLocalHttpsServiceStatusFailed,
    applyLocalHttpsServiceStatusRefused,
    buildLocalHttpsTab,
    TLS_CERT_CHANGED_EVENT,
} from './settings/tabs/LocalHttpsTab';
import {
    applyServerAdminUnreachable,
    applyServerContainerMode,
    applyServerHostMode,
    applyServerServiceStatus,
    buildServerTab,
    refreshServer,
    refreshServerHttps,
} from './settings/tabs/ServerTab';
import { buildServiceTab, refreshService } from './settings/tabs/ServiceTab';
import { buildUpdatesTab, refreshUpdates } from './settings/tabs/UpdatesTab';
import {
    applyUsersAdminUnreachable,
    applyUsersConfig,
    buildUsersTab,
    REMOTE_ADMIN_OFF_BOX_WARNING,
} from './settings/tabs/UsersTab';

/**
 * Settings modal — every tab in a card, each setting in a two-column grid.
 *
 * Every tab but Dependencies is built from the same primitives, in
 * settings/settingsLayout.ts (which draws the full shape): a section holding a
 * card (or, on a split tab, several cards under their own headings), the card
 * holding items, and each item one setting's row plus the notes under it, laid
 * out on a grid whose labels column is the same width everywhere.
 *
 * Inputs are siblings of labels (NOT nested inside them — the previous
 * pattern broke vertical alignment because input position drifted with
 * label-text length), so the right column stays a clean "value column"
 * across all rows.
 *
 * This file owns no section of its own, only the tab strip and the container
 * notes (which are built with the same helpers, so they look like the tabs
 * they replace).
 */
/**
 * The container replacements for the Service, Updates and Dependencies sections
 * (SP4 E4; Dependencies added by item 135).
 *
 * Exported and free-standing so the gating is unit-testable without standing up
 * the whole modal, and so the locked copy has exactly one definition.
 *
 * The copy is LOCKED — reproduced verbatim from the SP4 design §8 and
 * `todo_ws_scrcpy_web` item 2 decision 4, EXCEPT the Updates text, which item
 * 135 rewrote on 2026-09-15 (see `buildDockerUpdatesNote`). Do not reword these
 * casually; the container smoke asserts on them.
 *
 * `.settings-status` is the shared Settings-note convention (modal.css: indented
 * 1.25rem, italic), so these read as sub-notes rather than as settings — which
 * is what the SP4 branch's 730e521 exists to specify.
 */
function buildDockerNoteSection(
    title: string,
    kind: 'service' | 'updates' | 'dependencies',
    text: string,
): HTMLElement {
    const { section, card } = buildSection(title);
    section.dataset['dockerNote'] = kind; // stable hook for the container smoke
    const note = document.createElement('p');
    note.className = 'settings-status';
    note.style.gridColumn = '1 / -1';
    note.textContent = text;
    card.appendChild(buildItem(note));
    // Its own status line, like every tab: the dialog's save reports there
    // when this is the tab on screen.
    buildTabAlert(section);
    return section;
}

export function buildDockerServiceNote(): HTMLElement {
    return buildDockerNoteSection(
        'Service',
        'service',
        'service install not applicable — this instance runs in a container.',
    );
}

/**
 * Names no TAG, deliberately (item 135).
 *
 * The previous copy read ``update via `docker pull …:latest`.`` and was wrong
 * about the registry for the whole pre-1.0 window: `docker-publish.yml`'s
 * `computeTags()` refuses to move `:latest` onto a beta (and
 * `scripts/__tests__/docker-tags.test.mjs` pins that refusal), so `:latest`
 * 404s today while `:beta` and the immutable `:X.Y.Z-beta.N` tags resolve.
 * Naming `:beta` instead would just move the expiry date — it becomes the wrong
 * advice at the first stable release, when `:latest` starts resolving and is
 * what a user should track.
 *
 * "pull a newer image" is true in BOTH eras and needs no second copy change at
 * 1.0, which is the property the tag-naming versions could not have.
 */
export function buildDockerUpdatesNote(): HTMLElement {
    return buildDockerNoteSection(
        'Updates',
        'updates',
        'app updates not applicable — this instance runs in a container; pull a newer image to update.',
    );
}

/**
 * Dependencies is unavailable in a container for the same reason Updates is
 * (item 135): the image ships the dependency set it was built with, and the way
 * to move it forward is to pull a newer image, not to fetch a binary into a
 * layer that the next `docker run` discards.
 *
 * The tab stays VISIBLE and says why, rather than disappearing — an admin who
 * used it on the desktop and finds it simply gone learns nothing. Same reason
 * Service and Updates are replaced rather than hidden.
 *
 * Carries `data-settings-tab="dependencies"` as well as its `data-docker-note`,
 * and that is load-bearing rather than decorative. In container mode this
 * element IS the Dependencies tab body, so it has to answer to every hook the
 * real body answers to — and Dependencies is the ONE tab with no `<h3>` of its
 * own (it wraps `DependencyPanel`, which brings its own `<h2>`), so that data
 * hook is the only way anything finds it. `tests/e2e/support/auth.ts`'s
 * `settingsSection()` special-cases it for exactly that reason, and without the
 * attribute `openSettingsTab(settings, 'Dependencies')` cannot resolve the note
 * at all: CI caught precisely that, `element(s) not found` on
 * `section[data-settings-tab="dependencies"]`.
 *
 * Service and Updates deliberately do NOT get the same treatment: their real
 * bodies do not carry the hook either (`DependenciesTab.ts` is the only place in
 * `src/` that sets it), and both are found by their headings, which
 * `buildDockerNoteSection` already renders. The rule is "the note answers to the
 * same hooks its real body does", not "every note gets every hook".
 */
/**
 * What the Updates, Service, Dependencies and Local HTTPS tabs show where the
 * admin API will not answer this page (`adminApiReachable` false, off a
 * container): every one of their reads and controls would only be refused, so
 * none is made, and the tab says why instead of "loading…" forever (0.5.5).
 * `tabId` is the tab's `data-settings-tab` hook, which Dependencies needs to be
 * found at all (see `buildDockerDependenciesNote`).
 */
export function buildAdminUnreachableSection(title: string, tabId: string): HTMLElement {
    const { section, card } = buildSection(title);
    section.dataset['settingsTab'] = tabId;
    const note = document.createElement('p');
    note.className = 'settings-status';
    note.style.gridColumn = '1 / -1';
    note.setAttribute('data-admin-unreachable-note', '');
    note.textContent = ADMIN_UNREACHABLE_NOTE;
    card.appendChild(buildItem(note));
    buildTabAlert(section);
    return section;
}

export function buildDockerDependenciesNote(): HTMLElement {
    const section = buildDockerNoteSection(
        'Dependencies',
        'dependencies',
        'dependency updates not applicable — this instance runs in a container; pull a newer image to update.',
    );
    section.dataset['settingsTab'] = 'dependencies';
    return section;
}

/**
 * How long the "restarting → redirecting…" notice stays up before the browser
 * follows the server to its new port.
 *
 * Carried over unchanged from the per-field web-port Save that Task 8 deleted.
 * It is a wait for the supervisor to bring the process back up on the new port,
 * so it is deliberately generous: arriving early gets a connection refused, and
 * the user is looking at an explanation either way.
 */
export const RESTART_REDIRECT_DELAY_MS = 4000;

/** What the dialog should do once a save or a close attempt has resolved. */
export type SettingsAction =
    | { kind: 'stay' } /** stay open, staged changes untouched */
    | { kind: 'close' } /** nothing left to do — close */
    | { kind: 'redirect'; url: string } /** saved; the server is restarting elsewhere */
    | { kind: 'failed'; message: string } /** stay open, staged changes untouched, show why */;

/** The three answers to "you have unsaved changes". */
export type DirtyCloseChoice = 'save' | 'discard' | 'cancel';

/**
 * The two dialogs and the one request the save flow needs, injected.
 *
 * Injected rather than imported at the call site so the flow above can be
 * driven without a DOM: `performStagedSave` is where "Save can never bypass the
 * summary" and "a failed batch must not disturb the store" actually live, and
 * both are properties of the ORDER of these calls, which is only pinnable if a
 * test can observe them.
 */
export interface SaveDeps {
    confirm(changes: Change[]): Promise<boolean>;
    save(changes: Change[]): Promise<BatchResult>;
    promptDirtyClose(): Promise<DirtyCloseChoice>;
    /**
     * Leave this page for `url`. A seam for the same reason `SettingsBatchApi`
     * injects `schedule`/`exit`: the effect is unobservable and untestable
     * otherwise — jsdom throws "Not implemented: navigation" on a real
     * `location.href` assignment, so without this the ONE line that actually
     * rescues the browser from a dead port could be deleted with every
     * assertion still green.
     */
    navigate(url: string): void;
}

/** The real dialogs, the real endpoint, the real navigation. */
export const liveSaveDeps: SaveDeps = {
    confirm: (changes) => SettingsSummaryModal.confirm(changes),
    save: (changes) => runSave(changes),
    promptDirtyClose: () => SettingsDirtyCloseModal.choose(),
    navigate: (url) => {
        window.location.href = url;
    },
};

/** A change's summary LABEL, falling back to its wire id if it was not in this batch. */
function labelFor(id: string, changes: Change[]): string {
    return changes.find((c) => c.id === id)?.label ?? id;
}

/**
 * Which change the server refused, what it said about it, and what it had
 * ALREADY applied before it stopped.
 *
 * Named with the change's LABEL, not its wire id: the user has just confirmed a
 * summary reading "HTTP port: 8000 → 80", so answering with `webPort` makes them
 * translate an internal identifier back to the row they touched. The id is the
 * fallback for a failure naming something that was not in this batch.
 *
 * The applied prefix matters because `SettingsBatchApi` applies non-`webPort`
 * changes ONE AT A TIME and stops at the first refusal, so a mixed batch can
 * genuinely half-land: the WAL row records that correctly, but this message was
 * the user's only view of it and said nothing. They are reading it to decide
 * whether to Discard — and the siblings are already written on the server, so
 * "couldn't save Automatic updates" alone invites them to discard edits that
 * have in fact taken effect.
 *
 * It reports only; nothing is un-staged here. Re-sending an applied change is
 * idempotent. The one exception, `COMMIT_WHEN_APPLIED`, is made by
 * `performStagedSave`, not here.
 */
function saveFailureMessage(res: BatchResult, changes: Change[]): string {
    const failed = res.failed;
    if (!failed) return "couldn't save the changes";
    // `failed.id` is empty for the transport failures runSave synthesises
    // ("couldn't reach server"), where naming a setting would be a lie. The
    // applied list is still worth reporting: a batch can be applied in part and
    // THEN lose the connection.
    const applied =
        res.applied.length > 0 ? `applied ${res.applied.map((id) => labelFor(id, changes)).join(', ')}; ` : '';
    if (!failed.id) return `${applied}couldn't save the changes: ${failed.error}`;
    return `${applied}couldn't save ${labelFor(failed.id, changes)}: ${failed.error}`;
}

/**
 * Changes that are committed (`StagedSettingsStore.commitField`) when the
 * server reports them applied in a batch that then failed on a later change
 * (0.5.3 review, M4).
 *
 * Only `frameAncestorsAdd`, because only its tab TELLS the user a staged value
 * is unsaved: Settings → Embedding lists each staged origin as
 * `pending — saved when you click save`. Left staged after the server applied
 * it, the origin stayed listed as pending and missing from the allowed list, a
 * Discard then looked like it threw the origin away while the server kept
 * allowing it, and Save offered to send it again. Committing it is what the
 * tab already reacts to after a successful save: it drops the pending row and
 * re-reads the list from the server. Every other field shows its staged value
 * in its own input, which reads the same whether or not it has been saved, and
 * re-sending one is harmless, so those are left as they were.
 */
const COMMIT_WHEN_APPLIED: ReadonlySet<string> = new Set([FRAME_ANCESTORS_ADD_ID]);

/**
 * Confirm the staged batch, send it, and say what the dialog should do next.
 *
 * Three things here are load-bearing rather than incidental:
 *
 * 1. **The summary is not bypassable.** `confirm` is awaited BEFORE `save` is
 *    reached, on every path into this function, and a `false` sends nothing.
 *    That is what makes the summary the answer to a tab guard refusing a value
 *    while an earlier valid one stays staged (type `8010`, clear the box — the
 *    box is empty, `8010` is still staged): the list the user confirms is
 *    `store.changes()`, the exact list that is sent, so what will be applied is
 *    always named before it is applied.
 *
 * 2. **A failure leaves the store alone.** No `reset()`, and above all no tab
 *    refresh: `refreshUpdates`/`refreshServer` RE-REGISTER their fields with
 *    server values, which silently discards every staged edit. Refreshing on a
 *    failed save would therefore answer "your port was rejected" by throwing
 *    away the port the user typed. The one exception is a change in
 *    `COMMIT_WHEN_APPLIED` that the server reports it DID apply; only that
 *    change is committed.
 *
 * 3. **A restart redirects.** The server names only the new PORT; the host is
 *    whatever this browser is already on (`sameOriginUrl`) — a literal
 *    localhost would send every off-box client to its own machine. Without this
 *    a port change restarts the server and leaves the browser on a dead port.
 *    Which port, and whether the page only reloads, is `restartRedirectUrl`'s
 *    call; `base` is the page's own address (a parameter so tests can be on
 *    https).
 */
export async function performStagedSave(
    store: StagedSettingsStore,
    deps: SaveDeps = liveSaveDeps,
    base: string = window.location.href,
): Promise<SettingsAction> {
    const changes = store.changes();
    // Belt and braces — the Save button is disabled when nothing is staged. An
    // empty batch is never worth a round trip, and never worth a summary
    // listing nothing.
    if (changes.length === 0) return { kind: 'close' };

    if (!(await deps.confirm(changes))) return { kind: 'stay' };

    const res = await deps.save(changes);
    if (!res.ok) {
        for (const id of res.applied) {
            if (COMMIT_WHEN_APPLIED.has(id)) store.commitField(id);
        }
        return { kind: 'failed', message: saveFailureMessage(res, changes) };
    }

    // The server has them now, so they are no longer STAGED — they are the
    // current settings. Without this the store stays dirty after a successful
    // save, and on the restart path the dialog then sits through a 4-second
    // countdown still believing it holds unsaved work: closing during it raises
    // an "unsaved changes" prompt about a batch that has already been applied,
    // and Save comes back to life offering to send it a second time.
    store.commit();

    const url = restartRedirectUrl(res, base);
    if (url !== null) return { kind: 'redirect', url };
    return { kind: 'close' };
}

/**
 * Where the page goes after a save that restarts the server, or null when
 * nothing restarts (a port named without a restart is an echo).
 *
 * The page follows the listener it is served by (M5, after 0.5.3): an http
 * page follows a moved http port (`redirectPort`), an https page a moved https
 * port (`redirectHttpsPort`). When its own port did not move -- an https page
 * saving only the http port, an http page saving only the https port -- it
 * stays on its own port but still reloads after the restart delay, rather
 * than sitting on a connection the restart is about to drop.
 */
export function restartRedirectUrl(res: BatchResult, base: string = window.location.href): string | null {
    if (!res.restartRequired) return null;
    const current = new URL(base);
    const port = current.protocol === 'https:' ? res.redirectHttpsPort : res.redirectPort;
    if (typeof port === 'number') return sameOriginUrl(port, base);
    // Its own port: the one in the URL, or the scheme's default when it has none.
    const own = current.port ? Number(current.port) : current.protocol === 'https:' ? 443 : 80;
    return sameOriginUrl(own, base);
}

/**
 * Closing the dialog with work staged.
 *
 * `cancel` means CANCEL: back to the dialog with everything still staged. Not
 * close, not discard — losing a user's edits because they hit Escape twice is
 * exactly what this prompt exists to prevent.
 */
export async function performDirtyClose(
    store: StagedSettingsStore,
    deps: SaveDeps = liveSaveDeps,
): Promise<SettingsAction> {
    if (closeIntent(store) === 'close') return { kind: 'close' };

    const choice = await deps.promptDirtyClose();
    if (choice === 'cancel') return { kind: 'stay' };
    if (choice === 'discard') return { kind: 'close' };
    // `save` runs the identical path the Save button does — summary included.
    // A save the server refuses returns 'failed', so the dialog stays open and
    // the changes survive rather than being closed away.
    return performStagedSave(store, deps);
}

/**
 * After a save that changed remote admin: has this device just lost its admin
 * access? It has when the device is off this machine, sign-in is off, and the
 * save turned remote admin off -- the server now refuses its admin calls. Read
 * from /api/config, the policy now in force, rather than worked out from the
 * batch.
 *
 * If so, the page's pollers are told (`announceAdminAccessLost`; the save
 * already told them before it went out, see `saveDeps`, and telling them twice
 * is harmless), and Settings is opened again, on Users, where it can no longer
 * act: the new dialog reads the envelope as every dialog does and holds back
 * each admin read and control the server would refuse (`adminApiReachable`).
 */
async function reopenIfAdminLost(): Promise<void> {
    try {
        const r = await fetch('/api/config');
        if (!r.ok) return;
        const env = (await r.json()) as AppConfigEnvelope;
        if (adminApiReachable(env.runtime)) return;
    } catch {
        return;
    }
    announceAdminAccessLost();
    new SettingsModal({ initialTab: 'users' });
}

/**
 * The Save / Discard / Cancel prompt raised when a dirty dialog is dismissed.
 *
 * Every ambiguous dismissal (Escape, the backdrop, the ×) resolves `cancel`,
 * the only choice that cannot lose work.
 */
export class SettingsDirtyCloseModal extends Modal {
    private resolveFn: ((value: DirtyCloseChoice) => void) | null = null;
    private resolved = false;

    public static choose(): Promise<DirtyCloseChoice> {
        return new Promise((resolve) => {
            // The base constructor already appends the dialog AND calls
            // showModal(); doing either again throws InvalidStateError.
            new SettingsDirtyCloseModal(resolve);
        });
    }

    private constructor(resolve: (value: DirtyCloseChoice) => void) {
        super({ title: 'Unsaved changes' });
        this.resolveFn = resolve;
    }

    protected buildBody(container: HTMLElement): void {
        // Safe to fill during super(), unlike the sibling modals that defer:
        // this copy is constant and reads no instance field.
        const message = document.createElement('p');
        message.style.cssText = 'margin: 0 0 8px;';
        message.textContent = 'you have changes that have not been saved yet.';
        container.appendChild(message);
    }

    protected override buildFooter(): HTMLElement | null {
        const footer = document.createElement('div');
        footer.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';
        // Listeners fire long after super() has returned, so `this.resolveFn`
        // is assigned by the time any of them run.
        for (const choice of ['cancel', 'discard', 'save'] as const) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = choice === 'save' ? 'modal-button modal-button-primary' : 'modal-button';
            btn.textContent = choice;
            btn.addEventListener('click', () => this.resolveAndClose(choice));
            footer.appendChild(btn);
        }
        return footer;
    }

    protected override onEscapeKey(): void {
        this.resolveAndClose('cancel');
    }

    protected override onBackdropClick(): void {
        this.resolveAndClose('cancel');
    }

    protected override onCloseButtonClick(): void {
        this.resolveAndClose('cancel');
    }

    // Closed without an answer (the Settings dialog closed first): settle as
    // `cancel`, the choice that does nothing, so the close flow ends.
    protected override onBeforeClose(): void {
        this.settle('cancel');
    }

    private resolveAndClose(value: DirtyCloseChoice): void {
        if (this.resolved) return;
        this.settle(value);
        this.close(value);
    }

    private settle(value: DirtyCloseChoice): void {
        if (this.resolved) return;
        this.resolved = true;
        this.resolveFn?.(value);
        this.resolveFn = null;
    }
}

export class SettingsModal extends Modal {
    private role: Role | null = null;
    private authEnabled = false;
    /**
     * True when the server reported WS_SCRCPY_DOCKER=1 (SP4 E4). Read from the
     * /api/config runtime envelope, never from AppConfig — the flag is an env
     * implication and is deliberately never persisted to config.json.
     */
    private docker = false;
    /**
     * Will the admin API answer this caller at all (item 81)? Starts true and is
     * narrowed once the runtime probe resolves — fail-open, like `role` above.
     */
    private adminReachable = true;
    /**
     * Set by fillBody so applyDockerGating() can route the Updates/Service swap
     * through TabStrip.replaceTabBody() — going around TabStrip (a direct
     * replaceWith on a captured element) left the replacement permanently
     * visible regardless of which tab was active and orphaned TabStrip's cache.
     */
    private tabStrip: TabStrip | null = null;
    /**
     * The Service tab's root element, captured when `fillBody` builds it, so
     * the constructor's post-probe block can re-enter its refresh via the
     * exported `refreshService()` — `buildServiceTab` itself takes no `this`
     * and fires no request on its own. Stays null if the tab was never built
     * (role-gated out), mirroring the `if (!this.serviceSection) return;`
     * guard this field replaces.
     */
    private serviceTabEl: HTMLElement | null = null;
    /**
     * The Server tab's root element, captured the same way and for the same
     * reason as `serviceTabEl`: `buildServerTab` fires no request of its own, so
     * the constructor drives it from outside via the exported `refreshServer()`,
     * and hands it the /api/service/status response via
     * `applyServerServiceStatus()`.
     */
    private serverTabEl: HTMLElement | null = null;
    /**
     * The Local HTTPS tab's root element, captured the same way and for the same
     * reason as `serverTabEl`: `buildLocalHttpsTab` fires no request of its own.
     * The constructor hands it container mode (`applyLocalHttpsContainerMode()`)
     * or the /api/service/status response (`applyLocalHttpsServiceStatus()`,
     * which builds the panel) or its failure
     * (`applyLocalHttpsServiceStatusFailed()`), and a dependency install
     * (`applyLocalHttpsDependencyInstalled()`). Stays null when the role cannot
     * see Local HTTPS.
     */
    private localHttpsTabEl: HTMLElement | null = null;
    /**
     * The Embedding tab's section, captured the same way: in a container the
     * constructor tells it so (`applyEmbeddingContainerMode()`), and its https
     * note then names the reverse proxy alone. Stays null when the role cannot
     * see Embedding.
     */
    private embeddingTabEl: HTMLElement | null = null;
    /**
     * The Users tab's section, captured the same way: its remote-admin item
     * waits for the /api/config envelope the constructor reads
     * (`applyUsersConfig()`). Stays null when the role cannot see Users.
     */
    private usersTabEl: HTMLElement | null = null;
    /**
     * The changes in the last batch the server accepted. Read once the dialog
     * closes after it: a batch that turned remote admin off may have ended
     * this device's admin access (see `reopenIfAdminLost`).
     */
    private lastSaved: Change[] = [];
    /**
     * The Updates tab's root element, captured the same way and for the same
     * reason as `serviceTabEl`. Its /api/updates/status read is held until
     * container mode is known, so the constructor's post-probe block is what
     * drives it, via the exported `refreshUpdates()`.
     */
    private updatesTabEl: HTMLElement | null = null;
    /**
     * The Dependencies tab's root element, captured the same way and for the
     * same reason as `serviceTabEl`: `buildDependenciesTab` fires no request of
     * its own, so the constructor drives it via the exported
     * `refreshDependencies()`. It is also what `onBeforeClose()` hands to
     * `destroyDependenciesTab()` — the panel inside polls every 15 s, and the
     * dialog is opened and dismissed repeatedly.
     */
    private dependenciesTabEl: HTMLElement | null = null;
    /**
     * Which tab to show first, when the caller had a reason to pick one — the
     * home page's dependency alert opens this dialog ON Dependencies. Null means
     * "whatever comes first", which is what every other call site wants.
     */
    private initialTab: string | null = null;
    /**
     * The one store every tab this dialog builds registers into, hoisted out of
     * `fillBody` so the footer's Save button and the close overrides can reach
     * it. Null until `fillBody` runs (it is held behind the role probe), which
     * is why every consumer guards — a dismissal during that window has nothing
     * staged by definition, so it closes.
     */
    private store: StagedSettingsStore | null = null;
    /**
     * Re-entrancy guard for the dirty-close prompt. Escape is held down, or the
     * × is double-clicked: without this, a second prompt stacks on the first and
     * the dialog is dismissed by an answer the user gave to a dialog they can no
     * longer see.
     */
    private closePromptOpen = false;
    /**
     * A batch is in flight. Distinct from `closePromptOpen`: that one stops a
     * second PROMPT stacking, this one stops a second BATCH — and the two arrive
     * by different doors (the Save button, and the prompt's `save` choice).
     */
    private saving = false;
    /**
     * `liveSaveDeps`, with both prompts opened as children of this dialog: if it
     * closes while one is up the prompt closes with it, and an answer that lands
     * after that reads as the do-nothing one (`false` / `cancel`), so no batch
     * is sent and nothing closes the dialog a second time.
     */
    private readonly saveDeps: SaveDeps = {
        confirm: (changes) => this.askChild(() => liveSaveDeps.confirm(changes), false),
        save: async (changes) => {
            // A batch that ends this device's admin access (remote admin
            // turned off by a device that is admin only because of it) stops
            // the page's pollers BEFORE it goes out, so no tick can land on the
            // refusal once it is applied. If the save then fails they stay
            // stopped until the page is reloaded, which costs a badge, not a
            // setting.
            if (changes.some((c) => c.id === REMOTE_ADMIN_ID && c.warning === REMOTE_ADMIN_OFF_BOX_WARNING)) {
                announceAdminAccessLost();
            }
            const res = await liveSaveDeps.save(changes);
            if (res.ok) this.lastSaved = changes;
            return res;
        },
        promptDirtyClose: () => this.askChild(() => liveSaveDeps.promptDirtyClose(), 'cancel'),
        navigate: (url) => liveSaveDeps.navigate(url),
    };

    constructor(options?: { initialTab?: string }) {
        super({ title: 'Settings' });
        // After super(), never during it: class-field initialisers run as super()
        // returns and would clobber anything assigned earlier (ES2022
        // useDefineForClassFields, the same hazard as `fillBody`). `fillBody` is
        // deferred to a microtask, so it reads this safely.
        this.initialTab = options?.initialTab ?? null;
        this.dialog.classList.add('settings-modal');
        // An install from the Dependencies tab bubbles up to here; the Local
        // HTTPS tab's panel re-checks mkcert so generate enables without a
        // reopen. On the dialog itself, so the listener goes with it.
        // The Server tab's https port is gated on mkcert too, so it re-reads.
        this.dialog.addEventListener(DEPENDENCY_INSTALLED_EVENT, () => {
            if (this.localHttpsTabEl) void applyLocalHttpsDependencyInstalled(this.localHttpsTabEl);
            if (this.serverTabEl && !this.docker) void refreshServerHttps(this.serverTabEl);
        });
        // A certificate generated or revoked on the Local HTTPS tab opens or
        // closes the Server tab's https port.
        this.dialog.addEventListener(TLS_CERT_CHANGED_EVENT, () => {
            if (this.serverTabEl && !this.docker) void refreshServerHttps(this.serverTabEl);
        });
        // Defer body fill past class-field init phase (ES2022 useDefineForClassFields).
        // Resolve the current user's role first so admin-only sections can be gated.
        // Fail-open: on a me() error treat as admin (preserves today's full view;
        // the server enforces 403 on admin endpoints regardless).
        queueMicrotask(() => {
            void (async () => {
                let role: Role | null = 'admin';
                let authEnabled = false;
                // SP4 E4. Start the container-mode probe now, but deliberately do
                // NOT await it before fillBody. Blocking the body on a second fetch
                // means a hung /api/config renders a permanently EMPTY Settings
                // dialog — this modal's own tests stub fetch as a never-resolving
                // promise precisely to pin "the body still renders", and that is a
                // real guarantee, not a test artifact.
                const configProbe = this.probeConfig();
                const runtimeProbe = configProbe.then((env) => env?.runtime ?? null);
                try {
                    const me = await authClient.me();
                    role = me.user?.role ?? null;
                    authEnabled = me.authEnabled;
                } catch {
                    role = 'admin';
                }
                this.role = role;
                this.authEnabled = authEnabled;
                this.fillBody(this.bodyEl);
                // Server tab is always present (it holds the user-level reset row).
                if (this.serverTabEl) void refreshServer(this.serverTabEl);
                // The Service and Updates refreshes are HELD until container mode is
                // known. That is what the plan's build-site gating was really for:
                // in a container neither endpoint describes anything actionable, and
                // firing them anyway would draw "couldn't reach server" underneath
                // the informational copy. Holding them costs nothing on the desktop
                // (the sections already render a "loading…" placeholder) and means
                // no inapplicable request is ever made in a container.
                void (async () => {
                    // Fail-open to "not a container": the desktop answer, and the one
                    // that shows MORE, so a transient error cannot silently strip a
                    // host user's Service and Updates sections.
                    const runtime = await runtimeProbe;
                    // Before the container branch returns: a container runs a
                    // version too, and the footer is the only place it shows.
                    this.showVersion(runtime?.appVersion);
                    // Remote admin is allowed in a container as well, so the
                    // Users tab hears about it before that branch returns. A
                    // failed probe, or an envelope missing either half, leaves
                    // its item hidden.
                    const env = await configProbe;
                    if (env?.runtime && env.config && this.usersTabEl) applyUsersConfig(this.usersTabEl, env);
                    this.docker = runtime?.docker === true;
                    // Item 81: an admin whose calls would 403 regardless (a
                    // container with no opt-out) must not have these fired at them
                    // — the sections would fill with "couldn't reach server" where
                    // the true answer is "not from here". Fails open when the probe
                    // itself failed, matching the role fail-open above.
                    this.adminReachable = runtime ? adminApiReachable(runtime) : true;
                    // Where the admin API will not answer, every admin control
                    // in the dialog is held back with a note saying why, so
                    // nothing can be clicked into a 403 (0.5.5). Users decides
                    // its own from the envelope (applyUsersConfig, above).
                    if (!this.adminReachable && this.serverTabEl) applyServerAdminUnreachable(this.serverTabEl);
                    // Embedding's list answers only an admin on the machine
                    // itself (`requireLocalAdmin`), so it is read only there:
                    // anywhere else it would be refused whatever the policy. An
                    // unknown caller (a failed probe) reads, the fail-open
                    // direction, as the tab did before the hold.
                    if (this.embeddingTabEl) {
                        if (this.adminReachable && runtime?.callerIsLocal !== false) {
                            void refreshEmbedding(this.embeddingTabEl);
                        } else {
                            applyEmbeddingHeldBack(this.embeddingTabEl);
                        }
                    }
                    // The container branch runs FIRST and returns, so no tab
                    // gated by it ever starts anything.
                    //
                    // Dependencies used to be started ABOVE this branch, on the
                    // reasoning that a dependency is fetched into the app's own
                    // folder either way. Item 135 settled the opposite: in a
                    // container the image owns the dependency set, so the tab is
                    // replaced by a note like Service and Updates. The ORDER is
                    // what makes that safe rather than a leak —
                    // `refreshDependencies` mounts a `DependencyPanel` that
                    // polls every 15 s, and `applyDockerGating` replaces the tab
                    // BODY, which detaches the panel's element without stopping
                    // its interval. Starting it and then swapping the body would
                    // leave a 15 s /api/dependencies poll running for the life
                    // of the page with nothing holding a reference to stop it
                    // (the §36 leak). Never started, never leaked.
                    if (this.docker) {
                        this.applyDockerGating();
                        // The Server tab's install-lifecycle rows are decided here
                        // too, explicitly, instead of being left at their built
                        // default because the service-status path below never runs
                        // in a container (findings 20.4, 20.5).
                        if (this.serverTabEl) applyServerContainerMode(this.serverTabEl);
                        // Local HTTPS is unsupported in a container (user
                        // decision 2026-09-30): its tab shows only the
                        // reverse-proxy note, and nothing there fetches.
                        if (this.localHttpsTabEl) applyLocalHttpsContainerMode(this.localHttpsTabEl);
                        // ...so the Embedding tab's https note names the
                        // reverse proxy alone.
                        if (this.embeddingTabEl) applyEmbeddingContainerMode(this.embeddingTabEl);
                        return;
                    }
                    // A host: the Server tab's port rows, built hidden so none of
                    // their copy flashes in a container, can show now.
                    if (this.serverTabEl) applyServerHostMode(this.serverTabEl);
                    // The tabs whose reads are held below say why, instead of
                    // "loading…" forever.
                    if (!this.adminReachable) this.applyAdminUnreachableNotes();
                    if (this.canUse('dependencies') && this.dependenciesTabEl) {
                        void refreshDependencies(this.dependenciesTabEl);
                    }
                    // The Server tab's https port: held until here, past the
                    // container branch, because it reads /api/tls/state, which a
                    // container refuses (and its row is hidden there anyway).
                    if (this.canUse('webPort') && this.serverTabEl) void refreshServerHttps(this.serverTabEl);
                    if (this.canUse('service') && this.serviceTabEl) {
                        void refreshService(this.serviceTabEl, {
                            // renderServiceState (inside ServiceTab.ts) learns the
                            // fresh ServiceStatusResponse and hands it back here so
                            // the SERVER tab's rows can react to it too — see
                            // ServiceTabCallbacks — and so the Local HTTPS tab can
                            // build its panel once the platform is known.
                            onServiceStatus: (resp) => {
                                if (this.serverTabEl) applyServerServiceStatus(this.serverTabEl, resp);
                                if (this.localHttpsTabEl) applyLocalHttpsServiceStatus(this.localHttpsTabEl, resp);
                            },
                            // Without this the Local HTTPS tab, which builds its
                            // panel only once a status arrives, said "loading…"
                            // forever when the read failed. It now shows the
                            // Service tab's error and retry.
                            onServiceStatusFailed: (retry) => {
                                if (this.localHttpsTabEl)
                                    applyLocalHttpsServiceStatusFailed(this.localHttpsTabEl, retry);
                            },
                            // A refusal says why on both tabs, with no retry.
                            onServiceStatusRefused: (refusal) => {
                                if (this.localHttpsTabEl)
                                    applyLocalHttpsServiceStatusRefused(this.localHttpsTabEl, refusal);
                            },
                        });
                    }
                    if (this.canUse('updates') && this.updatesTabEl) void refreshUpdates(this.updatesTabEl);
                })();
            })();
        });
    }

    protected buildBody(_container: HTMLElement): void {
        // Body content rendered by fillBody() via queueMicrotask.
    }

    private fillBody(container: HTMLElement): void {
        // beta.62: Updates first (most-touched), then Service (install/
        // uninstall), then Server — the consolidated app/server section. The
        // former standalone "App" section (reset, install-for-all-users, stop &
        // exit, uninstall) was folded into "Server", which also keeps the web
        // port row; there is no longer a separate "App" section.
        // Admin-only sections are gated on the current user's role (set before
        // fillBody is called). The server enforces the same set via requireAdmin.
        // The "Users" section (manage users button + auth toggle) is admin-only.
        //
        // `store` is a single StagedSettingsStore shared by every tab this
        // dialog builds. Service (below) takes it and registers nothing — its
        // controls are actions, not staged values (see StagedSettingsStore's
        // class doc). Users registers `allowRemoteAdmin` (its other two rows
        // are actions). Embedding registers `frameAncestorsAdd` (the
        // pre-approvals its add row stages; its revoke is an action). Server
        // registers `webPort` and `httpsPort`; Updates registers `channel`,
        // `autoUpdate`, `updateCheckIntervalMinutes` and `githubOwner`.
        const store = new StagedSettingsStore();
        this.store = store;
        const ctx: TabContext = {
            role: this.role,
            authEnabled: this.authEnabled,
            reload: () => window.location.reload(),
            // Every confirm a tab raises is a child of this dialog: it closes if
            // Settings closes, and its answer then reads as cancel.
            askChild: (ask, unanswered) => this.askChild(ask, unanswered),
            openChild: (open) => this.openChild(open),
            // Read at click time: the strip is built just below, after ctx.
            // Focus follows to the newly selected tab's button, so a keyboard
            // user whose link just vanished with its tab is not dropped on <body>.
            showTab: (id) => {
                const strip = this.tabStrip;
                if (!strip) return;
                strip.activate(id);
                strip.getElement().querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
            },
            onAdminRefused: () => this.onAdminRefused(),
        };
        const tabs: TabDef[] = [];
        if (canSeeSection(this.role, 'users')) {
            tabs.push({
                id: 'users',
                label: 'Users',
                build: () => {
                    const el = buildUsersTab(ctx, store);
                    this.usersTabEl = el; // so the constructor can hand it the /api/config envelope
                    return el;
                },
            });
        }
        // Next to Users: both answer "who is allowed to do what with this server".
        if (canSeeSection(this.role, 'embedOrigins')) {
            tabs.push({
                id: 'embedding',
                label: 'Embedding',
                build: () => {
                    const el = buildEmbeddingTab(ctx, store);
                    this.embeddingTabEl = el; // so the container branch can reword its https note
                    return el;
                },
            });
        }
        // Built unconditionally; applyDockerGating() swaps them for the locked
        // container copy if the probe comes back true. Their refresh calls are
        // held until then, so a container never issues an inapplicable request
        // and never renders an error under the copy. See the constructor.
        if (canSeeSection(this.role, 'updates')) {
            tabs.push({
                id: 'updates',
                label: 'Updates',
                build: () => {
                    const el = buildUpdatesTab(ctx, store);
                    this.updatesTabEl = el; // so the constructor can trigger its refresh post-probe
                    return el;
                },
            });
        }
        if (canSeeSection(this.role, 'service')) {
            tabs.push({
                id: 'service',
                label: 'Service',
                build: () => {
                    const el = buildServiceTab(ctx, store);
                    this.serviceTabEl = el; // so the constructor can trigger its refresh post-probe
                    return el;
                },
            });
        }
        // The home page's dependency panel, moved here whole. Its read is held
        // until the probe answers, like Service and Updates above.
        if (canSeeSection(this.role, 'dependencies')) {
            tabs.push({
                id: 'dependencies',
                label: 'Dependencies',
                build: () => {
                    const el = buildDependenciesTab(ctx, store);
                    this.dependenciesTabEl = el; // so the constructor can start it post-probe
                    return el;
                },
            });
        }
        // Always built (it contains the user-level reset row).
        tabs.push({
            id: 'server',
            label: 'Server',
            build: () => {
                const el = buildServerTab(ctx, store);
                this.serverTabEl = el; // so the constructor can trigger its refresh
                return el;
            },
        });
        // Right after Server, which held it as a second section until 0.5.3.
        // Admin-only: `/api/tls/*` is admin-gated server-side, and an ungated tab
        // would 403 on every read (adminGate.ts's `localHttps` entry).
        if (canSeeSection(this.role, 'localHttps')) {
            tabs.push({
                id: 'local-https',
                label: 'Local HTTPS',
                build: () => {
                    const el = buildLocalHttpsTab(ctx);
                    this.localHttpsTabEl = el; // so the constructor can decide what it shows
                    return el;
                },
            });
        }
        const strip = new TabStrip(tabs);
        this.tabStrip = strip; // so applyDockerGating() can route its swap through TabStrip
        // After construction, which has already activated the first tab. A no-op
        // for an id that was never built, so a caller asking for a tab this role
        // cannot see lands on the first one rather than on nothing.
        if (this.initialTab !== null) strip.activate(this.initialTab);
        container.append(strip.getElement(), strip.getPanel());

        // Keep Save's enabled state honest, straight off the store rather than
        // off DOM events. Sniffing events cannot work here: the Updates
        // check-interval field commits from a 500ms debounce timer, so its
        // `input` fires long before the value is staged and the commit itself
        // fires nothing — Save would stay greyed out over a real staged change.
        store.subscribe(() => this.syncSaveButton());
        this.syncSaveButton();
    }

    /**
     * The dialog-level footer: the running version on the left, one Save for
     * every tab on the right. A save's result is not reported here: it goes to
     * the status line at the bottom of the tab on screen (`reportSave`), the
     * one place every tab reports an action's result (0.5.5).
     *
     * Built during `super()`, so it may touch no instance field — hence the
     * `saveBtn`/`versionEl` getters below, which re-find the nodes rather than
     * caching them in fields that class-field init would clobber
     * (ES2022 useDefineForClassFields, the same hazard as `fillBody`).
     */
    protected override buildFooter(): HTMLElement | null {
        const footer = document.createElement('div');
        footer.style.cssText = 'display: flex; gap: 8px; align-items: center;';

        // The running version, left-aligned on Save's line. Hidden until the
        // runtime probe names it (`showVersion`), so the dialog never reads
        // "vundefined"; a server too old to send it leaves the line hidden.
        const version = document.createElement('span');
        version.className = 'settings-version';
        version.style.cssText =
            'flex: 0 0 auto; white-space: nowrap; font-size: 13px; color: var(--text-color-light, #888);';
        version.hidden = true;
        footer.appendChild(version);

        const save = document.createElement('button');
        save.type = 'button';
        // `margin-left: auto` keeps Save on the right edge, with or without the
        // version beside it.
        save.style.marginLeft = 'auto';
        save.className = 'settings-btn settings-btn-primary settings-save';
        save.textContent = 'save';
        // Starts disabled: a freshly opened dialog has staged nothing, and the
        // tabs' baselines are not even known yet (the ports and the update
        // settings arrive on the refreshes the constructor drives).
        save.disabled = true;
        save.addEventListener('click', () => void this.onSaveClick());
        footer.appendChild(save);

        return footer;
    }

    private get saveBtn(): HTMLButtonElement | null {
        return this.frameEl.querySelector<HTMLButtonElement>('button.settings-save');
    }

    private get versionEl(): HTMLElement | null {
        return this.frameEl.querySelector<HTMLElement>('.settings-version');
    }

    /**
     * Name the running version in the footer, or keep the line hidden when the
     * server did not say (an older server, or a failed probe). Read off the
     * /api/config runtime envelope, which every caller gets — container, dev
     * build and remote admin alike — unlike /api/updates/status (see
     * `FirstRunStatus.appVersion`).
     */
    private showVersion(version: string | undefined): void {
        const el = this.versionEl;
        if (!el) return;
        const known = typeof version === 'string' && version.length > 0;
        el.textContent = known ? `v${version}` : '';
        el.hidden = !known;
    }

    /**
     * Report a save's result on the status line of the tab on screen: the user
     * clicked Save from there, and that line is where every tab reports an
     * action's result. A tab body without a line of its own gets one.
     */
    private reportSave(kind: TabAlertKind, msg: string): void {
        const strip = this.tabStrip;
        const body = strip?.body(strip.activeId());
        if (!body) return;
        const alert = tabAlertIn(body) ?? buildTabAlert(body.querySelector<HTMLElement>('section') ?? body);
        alert.show(kind, msg);
    }

    /** Clear the save's previous result off the tab on screen. */
    private clearSaveReport(): void {
        const strip = this.tabStrip;
        const body = strip?.body(strip.activeId());
        if (body) tabAlertIn(body)?.clear();
    }

    /**
     * `this.saving` is an equal partner with dirtiness here, not a refinement.
     *
     * Disabling the button directly at the click site does NOT hold: the tabs
     * stay interactive while the batch is in flight (the summary has closed by
     * then), and `store.subscribe(…)` calls straight back into this method on
     * the next `set` — re-enabling Save mid-request from a signal that is
     * perfectly correct about dirtiness and knows nothing about the fetch. Two
     * racing batches is not merely a duplicate request: the second `webPort`
     * apply lands on a server that may already be restarting.
     */
    private syncSaveButton(): void {
        const btn = this.saveBtn;
        if (!btn) return;
        btn.disabled = this.saving || this.store?.isDirty() !== true;
    }

    /**
     * Run one save/close flow with Save held down for its whole duration.
     *
     * Both entry points funnel through here so the in-flight guard cannot be
     * half-applied — the close path reaches exactly the same `performStagedSave`
     * via its `save` choice, so guarding only the button would leave the other
     * door open.
     */
    private async runGuarded(flow: () => Promise<SettingsAction>): Promise<void> {
        if (this.saving) return;
        this.saving = true;
        this.syncSaveButton();
        try {
            const action = await flow();
            // Released only on the paths that leave the dialog open and usable.
            // After a close or a redirect we are on our way out, and a live Save
            // button would invite a second batch at the worst possible moment.
            if (action.kind === 'stay' || action.kind === 'failed') this.saving = false;
            this.applyAction(action);
        } catch {
            this.saving = false;
            this.reportSave('error', "couldn't save the changes");
        } finally {
            this.syncSaveButton();
        }
    }

    private async onSaveClick(): Promise<void> {
        const store = this.store;
        if (!store) return;
        // Clear any previous refusal before re-attempting, so a stale message
        // cannot be read as a fresh one.
        this.clearSaveReport();
        await this.runGuarded(() => performStagedSave(store, this.saveDeps));
    }

    /**
     * Every dismissal route goes through the dirty check — Escape, the backdrop
     * and the × alike. `close()` itself is deliberately NOT overridden: it is
     * what the flow below calls once the answer is in, and what the tabs' own
     * hand-offs (reset, uninstall, a reload) use to tear the dialog down.
     *
     * A dismissal arriving while a batch is in flight is dropped by
     * `runGuarded`: the question "what about your unsaved changes" has no honest
     * answer while the save that would resolve it is still outstanding.
     */
    private async attemptClose(): Promise<void> {
        if (this.closePromptOpen) return;
        this.closePromptOpen = true;
        try {
            await this.runGuarded(() => performDirtyClose(this.store ?? new StagedSettingsStore(), this.saveDeps));
        } finally {
            this.closePromptOpen = false;
        }
    }

    protected override onEscapeKey(): void {
        void this.attemptClose();
    }

    protected override onBackdropClick(): void {
        void this.attemptClose();
    }

    protected override onCloseButtonClick(): void {
        void this.attemptClose();
    }

    /**
     * The Dependencies tab wraps a panel that polls every 15 s for as long as it
     * lives. On the home page that interval was released by `onPageTeardown`;
     * inside a dialog the page outlives the panel, so each open would otherwise
     * leave another interval reading /api/dependencies forever (§36).
     */
    protected override onBeforeClose(): void {
        if (this.dependenciesTabEl) destroyDependenciesTab(this.dependenciesTabEl);
        // Every tab's status line stops its clock: nothing is left to hide.
        destroyTabAlerts(this.dialog);
    }

    /** Act on what the save / close flow decided. */
    private applyAction(action: SettingsAction): void {
        switch (action.kind) {
            case 'stay':
                return;
            case 'close':
                this.close();
                if (this.lastSaved.some((c) => c.id === REMOTE_ADMIN_ID)) void reopenIfAdminLost();
                return;
            case 'failed':
                // Stays open, changes still staged — see performStagedSave.
                this.reportSave('error', action.message);
                return;
            case 'redirect':
                // The dialog stays up showing why, then follows the server. The
                // wait is the supervisor's window to rebind the new port;
                // navigating immediately gets a connection refused. A busy
                // message, so it stays up until the page leaves.
                this.reportSave('busy', 'restarting → redirecting…');
                setTimeout(() => liveSaveDeps.navigate(action.url), RESTART_REDIRECT_DELAY_MS);
                return;
        }
    }

    /**
     * Replace the Service, Updates and Dependencies sections with the locked
     * container copy (SP4 E4; Dependencies added by item 135). Called only once
     * the probe has confirmed container mode, and before any of the three
     * sections' refreshes has been allowed to run — so nothing here is racing a
     * half-rendered async result, and in particular the Dependencies panel's
     * 15 s poll has never been started (see the call site).
     *
     * Routed through `TabStrip.replaceTabBody()` rather than a direct
     * `replaceWith` on a captured element: the probe resolves well after the
     * first tab has already been shown (Users, not Updates/Service), so a
     * direct DOM swap inserted a fresh node with no `hidden` attribute — it
     * rendered visible beside whatever tab was actually active — and left
     * TabStrip's cache pointing at the detached original, permanently killing
     * that tab's button. `replaceTabBody` preserves the outgoing node's
     * visibility and keeps the cache in sync, and is a no-op for a tab that was
     * never built (e.g. role-gated out entirely).
     *
     * The stale tab refs are dropped too: `updatesTabEl` and `dependenciesTabEl`
     * point at the now-detached original sections, and leaving them set would
     * let a later `refreshUpdates()` / `refreshDependencies()` render into
     * nothing — and issue the /api/updates/status and /api/dependencies calls
     * this gate exists to avoid. Dropping `dependenciesTabEl` also makes
     * `onBeforeClose()`'s `destroyDependenciesTab` a no-op, which is correct
     * here: no panel was ever created, so there is no interval to stop.
     */
    private applyDockerGating(): void {
        // The outgoing bodies' status lines stop their clocks first.
        for (const id of ['updates', 'service', 'dependencies']) {
            const body = this.tabStrip?.body(id);
            if (body) destroyTabAlerts(body);
        }
        this.tabStrip?.replaceTabBody('updates', buildDockerUpdatesNote());
        this.tabStrip?.replaceTabBody('service', buildDockerServiceNote());
        this.tabStrip?.replaceTabBody('dependencies', buildDockerDependenciesNote());
        this.updatesTabEl = null;
        this.dependenciesTabEl = null;
    }

    /**
     * A tab's admin read was refused as not from the operator
     * (`ctx.onAdminRefused`; 0.5.6), though `adminReachable` said the admin API
     * would answer: it fails open when the runtime probe itself fails. Does now
     * what the post-probe block does when it knows from the start: holds back
     * the Server, Users and Embedding admin controls, replaces the four
     * admin-only tabs with the note, and tells the page's pollers. Once per
     * dialog; the Dependencies panel is stopped before its body goes, since
     * replacing a body does not stop the poll inside it (§36).
     */
    private onAdminRefused(): void {
        if (!this.adminReachable) return;
        this.adminReachable = false;
        if (this.serverTabEl) applyServerAdminUnreachable(this.serverTabEl);
        if (this.usersTabEl) applyUsersAdminUnreachable(this.usersTabEl);
        if (this.embeddingTabEl) applyEmbeddingHeldBack(this.embeddingTabEl);
        if (this.dependenciesTabEl) destroyDependenciesTab(this.dependenciesTabEl);
        this.applyAdminUnreachableNotes();
        announceAdminAccessLost();
    }

    /**
     * Replace the Updates, Service, Dependencies and Local HTTPS bodies with
     * `buildAdminUnreachableSection` where the admin API will not answer this
     * page, the way `applyDockerGating` replaces them in a container (and
     * through `TabStrip.replaceTabBody` for the same reasons). From the
     * post-probe block none of the four has started anything, since their
     * refreshes are all held behind `canUse`; from `onAdminRefused` they have,
     * which is why it stops the Dependencies panel's poll first. The refs are
     * dropped so nothing drives a detached body later.
     */
    private applyAdminUnreachableNotes(): void {
        const notes: Array<[string, string]> = [
            ['updates', 'Updates'],
            ['service', 'Service'],
            ['dependencies', 'Dependencies'],
            ['local-https', 'Local HTTPS'],
        ];
        for (const [id, title] of notes) {
            const body = this.tabStrip?.body(id);
            if (!body) continue;
            destroyTabAlerts(body);
            this.tabStrip?.replaceTabBody(id, buildAdminUnreachableSection(title, id));
        }
        this.updatesTabEl = null;
        this.serviceTabEl = null;
        this.dependenciesTabEl = null;
        this.localHttpsTabEl = null;
    }

    /**
     * Ask the server whether it is running in a container (SP4 E4), among the
     * rest of the /api/config envelope.
     *
     * Reads `runtime.docker` off the envelope — the runtime side, not `config`,
     * because the flag is an env implication the server deliberately never
     * persists to config.json. The Users tab reads its remote-admin item off
     * both halves (`applyUsersConfig`).
     *
     * Fails open to `false`. That is the desktop answer and the one that shows
     * MORE, matching the role fail-open in the constructor: a transient fetch
     * error should not silently strip a host user's Service and Updates sections.
     */
    private async probeConfig(): Promise<AppConfigEnvelope | null> {
        try {
            const r = await fetch('/api/config');
            if (!r.ok) return null;
            return (await r.json()) as AppConfigEnvelope;
        } catch {
            return null;
        }
    }

    /**
     * Both halves of the admin gate (item 81): may this ROLE use the section, and
     * will the admin API answer THIS caller at all?
     *
     * Only meaningful AFTER the runtime probe resolves. `adminReachable` starts
     * true and `fillBody` runs before the probe, deliberately — a hung
     * /api/config must not render an empty dialog (see the comment at the probe's
     * call site). So section VISIBILITY stays on `canSeeSection` alone; this gates
     * the network calls, which is where an unreachable admin API would otherwise
     * surface as "couldn't reach server" under perfectly healthy copy.
     */
    private canUse(section: string): boolean {
        return canSeeSection(this.role, section) && this.adminReachable;
    }

    // Service tab (install/uninstall the OS service, Linux scope radios) moved
    // to settings/tabs/ServiceTab.ts. `refreshService()` is triggered from the
    // constructor's post-probe block, via `this.serviceTabEl`.

    // Server tab (the beta.62 consolidation of the old "App" section: reset,
    // change password, log out, the http and https ports, install-for-all-users, stop & exit,
    // uninstall) moved to settings/tabs/ServerTab.ts, along with the pure
    // helpers only it uses. `refreshServer()` is triggered right after
    // `fillBody`, and `applyServerServiceStatus()` from the Service tab's
    // onServiceStatus callback — both via `this.serverTabEl`.
}
