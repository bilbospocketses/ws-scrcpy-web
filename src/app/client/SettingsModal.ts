import type { AppConfigEnvelope, FirstRunStatus } from '../../common/ConfigEvents';
import { sameOriginUrl } from '../sameOriginUrl';
import { Modal } from '../ui/Modal';
import { authClient, type Role } from './AuthClient';
import { adminApiReachable, canSeeSection } from './adminGate';
import { closeIntent } from './settings/closeIntent';
import { type BatchResult, runSave } from './settings/SaveRunner';
import { SettingsSummaryModal } from './settings/SettingsSummaryModal';
import { type Change, StagedSettingsStore } from './settings/StagedSettingsStore';
import { type TabDef, TabStrip } from './settings/TabStrip';
import { buildDependenciesTab, destroyDependenciesTab, refreshDependencies } from './settings/tabs/DependenciesTab';
import { buildEmbeddingTab, type TabContext } from './settings/tabs/EmbeddingTab';
import { applyServerServiceStatus, buildServerTab, refreshServer } from './settings/tabs/ServerTab';
import { buildServiceTab, refreshService } from './settings/tabs/ServiceTab';
import { buildUpdatesTab, refreshUpdates } from './settings/tabs/UpdatesTab';
import { buildUsersTab } from './settings/tabs/UsersTab';

/**
 * Settings modal — unified two-column grid layout.
 *
 * Every section is built from the same primitive:
 *   <div class="settings-section-body">       <-- grid container
 *     <div class="settings-row">              <-- display: contents
 *       <label class="settings-label">...     <-- grid-column: labels
 *       <div   class="settings-control">...   <-- grid-column: controls
 *     </div>
 *     <div class="settings-section-footer">   <-- spans both columns,
 *       <p class="settings-status">...        <-- right-aligned content
 *       <button class="settings-btn ...">...
 *     </div>
 *   </div>
 *
 * Inputs are siblings of labels (NOT nested inside them — the previous
 * pattern broke vertical alignment because input position drifted with
 * label-text length). Buttons live in section footers, never inline
 * with the inputs they affect, so the right column stays a clean
 * "value column" across all rows.
 *
 * The `buildSection` / `buildRow` / `buildDynamicLabelRow` helpers that produce
 * that shape now live in each tab module under settings/tabs/ — this file owns
 * no section of its own any more, only the tab strip and the container notes.
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
 * 1.25rem, italic, weight 600), so these read as sub-notes rather than as
 * settings — which is what the SP4 branch's 730e521 exists to specify.
 */
function buildDockerNoteSection(
    title: string,
    kind: 'service' | 'updates' | 'dependencies',
    text: string,
): HTMLElement {
    const section = document.createElement('section');
    section.className = 'settings-section';
    section.dataset['dockerNote'] = kind; // stable hook for the container smoke
    const heading = document.createElement('h3');
    heading.className = 'settings-section-heading';
    heading.textContent = title;
    section.appendChild(heading);
    const body = document.createElement('div');
    body.className = 'settings-section-body';
    const note = document.createElement('p');
    note.className = 'settings-status';
    note.style.gridColumn = '1 / -1';
    note.textContent = text;
    body.appendChild(note);
    section.appendChild(body);
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
 */
export function buildDockerDependenciesNote(): HTMLElement {
    return buildDockerNoteSection(
        'Dependencies',
        'dependencies',
        'dependency updates not applicable — this instance runs in a container; pull a newer image to update.',
    );
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
 * summary reading "Web port: 8000 → 80", so answering with `webPort` makes them
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
 * idempotent, and dropping it from the store would need a per-id commit the
 * store does not have.
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
 *    away the port the user typed.
 *
 * 3. **A restart redirects.** The server names only the new PORT; the host is
 *    whatever this browser is already on (`sameOriginUrl`) — a literal
 *    localhost would send every off-box client to its own machine. Without this
 *    a port change restarts the server and leaves the browser on a dead port.
 */
export async function performStagedSave(
    store: StagedSettingsStore,
    deps: SaveDeps = liveSaveDeps,
): Promise<SettingsAction> {
    const changes = store.changes();
    // Belt and braces — the Save button is disabled when nothing is staged. An
    // empty batch is never worth a round trip, and never worth a summary
    // listing nothing.
    if (changes.length === 0) return { kind: 'close' };

    if (!(await deps.confirm(changes))) return { kind: 'stay' };

    const res = await deps.save(changes);
    if (!res.ok) return { kind: 'failed', message: saveFailureMessage(res, changes) };

    // The server has them now, so they are no longer STAGED — they are the
    // current settings. Without this the store stays dirty after a successful
    // save, and on the restart path the dialog then sits through a 4-second
    // countdown still believing it holds unsaved work: closing during it raises
    // an "unsaved changes" prompt about a batch that has already been applied,
    // and Save comes back to life offering to send it a second time.
    store.commit();

    // Both halves required: a `redirectPort` without a restart is an echo, and
    // a restart without a port has nowhere to send the browser — better to
    // close than to navigate to `:undefined`.
    if (res.restartRequired && typeof res.redirectPort === 'number') {
        return { kind: 'redirect', url: sameOriginUrl(res.redirectPort) };
    }
    return { kind: 'close' };
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

    private resolveAndClose(value: DirtyCloseChoice): void {
        if (this.resolved) return;
        this.resolved = true;
        this.resolveFn?.(value);
        this.resolveFn = null;
        this.close(value);
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

    constructor(options?: { initialTab?: string }) {
        super({ title: 'Settings' });
        // After super(), never during it: class-field initialisers run as super()
        // returns and would clobber anything assigned earlier (ES2022
        // useDefineForClassFields, the same hazard as `fillBody`). `fillBody` is
        // deferred to a microtask, so it reads this safely.
        this.initialTab = options?.initialTab ?? null;
        this.dialog.classList.add('settings-modal');
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
                const runtimeProbe = this.probeRuntime();
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
                    this.docker = runtime?.docker === true;
                    // Item 81: an admin whose calls would 403 regardless (a
                    // container with no opt-out) must not have these fired at them
                    // — the sections would fill with "couldn't reach server" where
                    // the true answer is "not from here". Fails open when the probe
                    // itself failed, matching the role fail-open above.
                    this.adminReachable = runtime ? adminApiReachable(runtime) : true;
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
                        return;
                    }
                    if (this.canUse('dependencies') && this.dependenciesTabEl) {
                        void refreshDependencies(this.dependenciesTabEl);
                    }
                    if (this.canUse('service') && this.serviceTabEl) {
                        void refreshService(this.serviceTabEl, {
                            // renderServiceState (inside ServiceTab.ts) learns the
                            // fresh ServiceStatusResponse and hands it back here so
                            // the SERVER tab's rows can react to it too — see
                            // ServiceTabCallbacks.
                            onServiceStatus: (resp) => {
                                if (this.serverTabEl) applyServerServiceStatus(this.serverTabEl, resp);
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
        // dialog builds. Users/Embedding/Service (below) take it and register
        // nothing — they are actions, not staged values (see StagedSettingsStore's
        // class doc). Server registers `webPort`; Updates registers `channel`,
        // `autoUpdate` and `updateCheckIntervalMinutes`.
        const store = new StagedSettingsStore();
        this.store = store;
        const ctx: TabContext = {
            role: this.role,
            authEnabled: this.authEnabled,
            reload: () => window.location.reload(),
        };
        const tabs: TabDef[] = [];
        if (canSeeSection(this.role, 'users')) {
            tabs.push({ id: 'users', label: 'Users', build: () => buildUsersTab(ctx, store) });
        }
        // Next to Users: both answer "who is allowed to do what with this server".
        if (canSeeSection(this.role, 'embedOrigins')) {
            tabs.push({ id: 'embedding', label: 'Embedding', build: () => buildEmbeddingTab(ctx, store) });
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
     * The dialog-level footer: one Save for every tab, plus the line that
     * reports a refused batch.
     *
     * Built during `super()`, so it may touch no instance field — hence the
     * `saveBtn`/`saveStatus` getters below, which re-find the nodes rather than
     * caching them in fields that class-field init would clobber
     * (ES2022 useDefineForClassFields, the same hazard as `fillBody`).
     */
    protected override buildFooter(): HTMLElement | null {
        const footer = document.createElement('div');
        footer.style.cssText = 'display: flex; gap: 8px; align-items: center; justify-content: flex-end;';

        const status = document.createElement('p');
        status.className = 'settings-status settings-save-status';
        status.style.cssText = 'margin: 0; margin-right: auto;';
        status.hidden = true;
        footer.appendChild(status);

        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'settings-btn settings-btn-primary settings-save';
        save.textContent = 'save';
        // Starts disabled: a freshly opened dialog has staged nothing, and the
        // tabs' baselines are not even known yet (the web port and the update
        // settings arrive on the refreshes the constructor drives).
        save.disabled = true;
        save.addEventListener('click', () => void this.onSaveClick());
        footer.appendChild(save);

        return footer;
    }

    private get saveBtn(): HTMLButtonElement | null {
        return this.frameEl.querySelector<HTMLButtonElement>('button.settings-save');
    }

    private get saveStatus(): HTMLElement | null {
        return this.frameEl.querySelector<HTMLElement>('.settings-save-status');
    }

    private setSaveStatus(msg: string, isError: boolean): void {
        const el = this.saveStatus;
        if (!el) return;
        el.textContent = msg;
        el.hidden = msg.length === 0;
        el.classList.toggle('settings-status-error', isError);
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
            this.setSaveStatus("couldn't save the changes", true);
        } finally {
            this.syncSaveButton();
        }
    }

    private async onSaveClick(): Promise<void> {
        const store = this.store;
        if (!store) return;
        // Clear any previous refusal before re-attempting, so a stale message
        // cannot be read as a fresh one.
        this.setSaveStatus('', false);
        await this.runGuarded(() => performStagedSave(store));
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
            await this.runGuarded(() => performDirtyClose(this.store ?? new StagedSettingsStore()));
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
    }

    /** Act on what the save / close flow decided. */
    private applyAction(action: SettingsAction): void {
        switch (action.kind) {
            case 'stay':
                return;
            case 'close':
                this.close();
                return;
            case 'failed':
                // Stays open, changes still staged — see performStagedSave.
                this.setSaveStatus(action.message, true);
                return;
            case 'redirect':
                // The dialog stays up showing why, then follows the server. The
                // wait is the supervisor's window to rebind the new port;
                // navigating immediately gets a connection refused.
                this.setSaveStatus('restarting → redirecting…', false);
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
        this.tabStrip?.replaceTabBody('updates', buildDockerUpdatesNote());
        this.tabStrip?.replaceTabBody('service', buildDockerServiceNote());
        this.tabStrip?.replaceTabBody('dependencies', buildDockerDependenciesNote());
        this.updatesTabEl = null;
        this.dependenciesTabEl = null;
    }

    /**
     * Ask the server whether it is running in a container (SP4 E4).
     *
     * Reads `runtime.docker` off the /api/config envelope — the runtime side, not
     * `config`, because the flag is an env implication the server deliberately
     * never persists to config.json.
     *
     * Fails open to `false`. That is the desktop answer and the one that shows
     * MORE, matching the role fail-open in the constructor: a transient fetch
     * error should not silently strip a host user's Service and Updates sections.
     */
    private async probeRuntime(): Promise<FirstRunStatus | null> {
        try {
            const r = await fetch('/api/config');
            if (!r.ok) return null;
            const env = (await r.json()) as AppConfigEnvelope;
            return env.runtime;
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
    // change password, log out, web port, install-for-all-users, stop & exit,
    // uninstall) moved to settings/tabs/ServerTab.ts, along with the pure
    // helpers only it uses. `refreshServer()` is triggered right after
    // `fillBody`, and `applyServerServiceStatus()` from the Service tab's
    // onServiceStatus callback — both via `this.serverTabEl`.
}
