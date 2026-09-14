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
 * The container replacements for the Service and Updates sections (SP4 E4).
 *
 * Exported and free-standing so the gating is unit-testable without standing up
 * the whole modal, and so the locked copy has exactly one definition.
 *
 * The copy is LOCKED — reproduced verbatim from the SP4 design §8 and
 * `todo_ws_scrcpy_web` item 2 decision 4, EXCEPT the image namespace, which was
 * re-pointed to `bilbospocketses` on 2026-09-10 when the registry moved. SP4
 * itself still reads `jchapz30`: it is a dated record, and the superseding note
 * at the top of that file is the authority, not §8. Do not reword it casually;
 * the container smoke asserts on it.
 *
 * `.settings-status` is the shared Settings-note convention (modal.css: indented
 * 1.25rem, italic, weight 600), so these read as sub-notes rather than as
 * settings — which is what the SP4 branch's 730e521 exists to specify.
 */
function buildDockerNoteSection(title: string, kind: 'service' | 'updates', text: string): HTMLElement {
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

export function buildDockerUpdatesNote(): HTMLElement {
    return buildDockerNoteSection(
        'Updates',
        'updates',
        'update via `docker pull bilbospocketses/ws-scrcpy-web:latest`.',
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
}

/** The real dialogs and the real endpoint. */
export const liveSaveDeps: SaveDeps = {
    confirm: (changes) => SettingsSummaryModal.confirm(changes),
    save: (changes) => runSave(changes),
    promptDirtyClose: () => SettingsDirtyCloseModal.choose(),
};

/** Which change the server refused, and what it said about it. */
function saveFailureMessage(res: BatchResult): string {
    const failed = res.failed;
    if (!failed) return "couldn't save the changes";
    // `failed.id` is empty for the transport failures runSave synthesises
    // ("couldn't reach server"), where naming a setting would be a lie.
    if (!failed.id) return `couldn't save the changes: ${failed.error}`;
    return `couldn't save ${failed.id}: ${failed.error}`;
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
    if (!res.ok) return { kind: 'failed', message: saveFailureMessage(res) };

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

    constructor() {
        super({ title: 'Settings' });
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
                    if (this.docker) {
                        this.applyDockerGating();
                        return;
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

    private syncSaveButton(): void {
        const btn = this.saveBtn;
        if (!btn) return;
        btn.disabled = this.store?.isDirty() !== true;
    }

    private async onSaveClick(): Promise<void> {
        const store = this.store;
        if (!store) return;
        // Clear any previous refusal before re-attempting, so a stale message
        // cannot be read as a fresh one.
        this.setSaveStatus('', false);
        const btn = this.saveBtn;
        if (btn) btn.disabled = true;
        try {
            const action = await performStagedSave(store);
            this.applyAction(action);
            // Re-enable only on the paths that leave the dialog up. After a
            // close or a redirect the changes are gone or the page is leaving,
            // and a live Save button would invite a second batch.
            if (action.kind === 'stay' || action.kind === 'failed') this.syncSaveButton();
        } catch {
            this.setSaveStatus("couldn't save the changes", true);
            this.syncSaveButton();
        }
    }

    /**
     * Every dismissal route goes through the dirty check — Escape, the backdrop
     * and the × alike. `close()` itself is deliberately NOT overridden: it is
     * what the flow below calls once the answer is in, and what the tabs' own
     * hand-offs (reset, uninstall, a reload) use to tear the dialog down.
     */
    private async attemptClose(): Promise<void> {
        if (this.closePromptOpen) return;
        this.closePromptOpen = true;
        try {
            this.applyAction(await performDirtyClose(this.store ?? new StagedSettingsStore()));
        } catch {
            this.setSaveStatus("couldn't save the changes", true);
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
                this.setSaveStatus('restarting → redirecting…', false);
                setTimeout(() => {
                    window.location.href = action.url;
                }, RESTART_REDIRECT_DELAY_MS);
                return;
        }
    }

    /**
     * Replace the Service and Updates sections with the locked container copy
     * (SP4 E4). Called only once the probe has confirmed container mode, and
     * before either section's refresh has been allowed to run — so nothing here
     * is racing a half-rendered async result.
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
     * The stale tab ref is dropped too: `updatesTabEl` points at the now-detached
     * original Updates section, and leaving it set would let a later
     * `refreshUpdates()` render into nothing — and issue the /api/updates/status
     * call this gate exists to avoid.
     */
    private applyDockerGating(): void {
        this.tabStrip?.replaceTabBody('updates', buildDockerUpdatesNote());
        this.tabStrip?.replaceTabBody('service', buildDockerServiceNote());
        this.updatesTabEl = null;
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
