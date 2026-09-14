import type { AppConfigEnvelope, FirstRunStatus, UpdateChannel } from '../../common/ConfigEvents';
import type { UpdatesConfigPatchRequest, UpdatesStatusResponse } from '../../common/UpdateEvents';
import { Modal } from '../ui/Modal';
import { authClient, type Role } from './AuthClient';
import { adminApiReachable, canSeeSection } from './adminGate';
import { StagedSettingsStore } from './settings/StagedSettingsStore';
import { type TabDef, TabStrip } from './settings/TabStrip';
import { buildEmbeddingTab, type TabContext } from './settings/tabs/EmbeddingTab';
import { applyServerServiceStatus, buildServerTab, refreshServer } from './settings/tabs/ServerTab';
import { buildServiceTab, refreshService } from './settings/tabs/ServiceTab';
import { buildUsersTab } from './settings/tabs/UsersTab';
import { runUpgradingHandoff } from './UpgradingOverlay';

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

    // ── Updates section state ─────────────────────────────────────────────
    private updatesBody: HTMLElement | null = null;
    private updatesStatusEl: HTMLElement | null = null;
    private updatesAutoCheckbox: HTMLInputElement | null = null;
    private updatesIntervalInput: HTMLInputElement | null = null;
    private updatesChannelStableRadio: HTMLInputElement | null = null;
    private updatesChannelBetaRadio: HTMLInputElement | null = null;
    private updatesOwnerInput: HTMLInputElement | null = null;
    private updatesCheckNowBtn: HTMLButtonElement | null = null;
    private updatesIntervalDebounce: number | undefined;
    private updatesLastStatus: UpdatesStatusResponse | null = null;
    private updatesApplyInFlight = false;

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
                    if (this.canUse('updates')) void this.refreshUpdates();
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
        // class doc). Server registers `webPort`; Updates starts registering in
        // Task 9.
        const store = new StagedSettingsStore();
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
            tabs.push({ id: 'updates', label: 'Updates', build: () => this.buildUpdatesSection() });
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
    }

    // ── Layout primitives ──────────────────────────────────────────────────
    /**
     * Build a section shell. Returns { section, body } — body is the
     * grid container into which rows + footer go.
     */
    private buildSection(title: string): { section: HTMLElement; body: HTMLElement } {
        const section = document.createElement('section');
        section.className = 'settings-section';
        const heading = document.createElement('h3');
        heading.className = 'settings-section-heading';
        heading.textContent = title;
        section.appendChild(heading);
        const body = document.createElement('div');
        body.className = 'settings-section-body';
        section.appendChild(body);
        return { section, body };
    }

    /**
     * Build a single grid row: description label on the left, control(s)
     * on the right. The control argument is appended to a flex container
     * in the right column — pass a single input, or a fragment with
     * multiple controls (e.g. radios + their labels).
     */
    private buildRow(labelText: string, control: HTMLElement | DocumentFragment): HTMLElement {
        const row = document.createElement('div');
        row.className = 'settings-row';

        const label = document.createElement('span');
        label.className = 'settings-label';
        label.textContent = labelText;
        row.appendChild(label);

        const controlWrap = document.createElement('div');
        controlWrap.className = 'settings-control';
        controlWrap.appendChild(control);
        row.appendChild(controlWrap);

        return row;
    }

    /**
     * Build a single grid row whose LABEL element is returned along with
     * the row, so callers can mutate the label text dynamically (status
     * messages, dynamic notes). Same shape as buildRow but exposes the
     * label for live updates. Use this when the description on the left
     * is itself the status / dynamic info — the action button on the
     * right stays put while the label changes underneath the changing
     * state.
     */
    private buildDynamicLabelRow(
        labelText: string,
        control: HTMLElement | DocumentFragment,
    ): { row: HTMLElement; labelEl: HTMLSpanElement } {
        const row = document.createElement('div');
        row.className = 'settings-row';
        const labelEl = document.createElement('span');
        labelEl.className = 'settings-label';
        labelEl.textContent = labelText;
        row.appendChild(labelEl);
        const controlWrap = document.createElement('div');
        controlWrap.className = 'settings-control';
        controlWrap.appendChild(control);
        row.appendChild(controlWrap);
        return { row, labelEl };
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
     * The stale sub-refs are dropped too: `updatesBody`/`updatesStatusEl`/
     * `updatesCheckNowBtn` point inside the now-detached original Updates body,
     * and leaving them set would let any later call render into nothing.
     */
    private applyDockerGating(): void {
        this.tabStrip?.replaceTabBody('updates', buildDockerUpdatesNote());
        this.tabStrip?.replaceTabBody('service', buildDockerServiceNote());
        this.updatesBody = null;
        this.updatesStatusEl = null;
        this.updatesCheckNowBtn = null;
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

    // ── Updates section ────────────────────────────────────────────────────
    private buildUpdatesSection(): HTMLElement {
        const { section, body } = this.buildSection('Updates');
        const placeholder = document.createElement('p');
        placeholder.className = 'settings-status';
        placeholder.style.gridColumn = '1 / -1';
        placeholder.textContent = 'loading…';
        body.appendChild(placeholder);
        this.updatesBody = body;
        return section;
    }

    private async refreshUpdates(): Promise<void> {
        let resp: UpdatesStatusResponse | null = null;
        try {
            const r = await fetch('/api/updates/status');
            if (!r.ok) {
                this.renderUpdatesError("couldn't reach server");
                return;
            }
            resp = (await r.json()) as UpdatesStatusResponse;
        } catch {
            this.renderUpdatesError("couldn't reach server");
            return;
        }
        this.updatesLastStatus = resp;
        this.renderUpdatesSection(resp);
    }

    private renderUpdatesError(msg: string): void {
        if (!this.updatesBody) return;
        this.updatesBody.replaceChildren();
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'settings-btn';
        retryBtn.textContent = 'retry';
        retryBtn.addEventListener('click', () => {
            void this.refreshUpdates();
        });
        const { row, labelEl } = this.buildDynamicLabelRow(msg, retryBtn);
        labelEl.classList.add('settings-status-error');
        this.updatesBody.appendChild(row);
    }

    private renderUpdatesSection(s: UpdatesStatusResponse): void {
        if (!this.updatesBody) return;
        this.updatesBody.replaceChildren();
        this.updatesAutoCheckbox = null;
        this.updatesIntervalInput = null;
        this.updatesChannelStableRadio = null;
        this.updatesChannelBetaRadio = null;
        this.updatesOwnerInput = null;
        this.updatesCheckNowBtn = null;

        if (!s.isInstalled) {
            const devNote = document.createElement('p');
            devNote.className = 'settings-stub-note';
            devNote.style.gridColumn = '1 / -1';
            const versionStr = s.currentVersion ? `current: v${s.currentVersion} — ` : '';
            devNote.textContent = `${versionStr}dev mode — packaging features disabled`;
            this.updatesBody.appendChild(devNote);
            return;
        }

        // Row 1: auto-download checkbox.
        const autoCheckbox = document.createElement('input');
        autoCheckbox.type = 'checkbox';
        autoCheckbox.checked = s.autoUpdate;
        autoCheckbox.addEventListener('change', () => {
            void this.patchUpdatesConfig({ autoUpdate: autoCheckbox.checked });
        });
        this.updatesBody.appendChild(this.buildRow('automatically download updates', autoCheckbox));
        this.updatesAutoCheckbox = autoCheckbox;

        // Row 2: check interval.
        const intervalInput = document.createElement('input');
        intervalInput.type = 'number';
        intervalInput.min = '5';
        intervalInput.max = '1440';
        intervalInput.step = '1';
        intervalInput.className = 'settings-input';
        intervalInput.style.maxWidth = '110px';
        intervalInput.value = String(s.updateCheckIntervalMinutes);
        intervalInput.addEventListener('input', () => {
            if (this.updatesIntervalDebounce !== undefined) {
                window.clearTimeout(this.updatesIntervalDebounce);
            }
            this.updatesIntervalDebounce = window.setTimeout(() => {
                this.commitIntervalChange(intervalInput);
            }, 500);
        });
        intervalInput.addEventListener('blur', () => {
            if (this.updatesIntervalDebounce !== undefined) {
                window.clearTimeout(this.updatesIntervalDebounce);
                this.updatesIntervalDebounce = undefined;
            }
            this.commitIntervalChange(intervalInput);
        });
        this.updatesBody.appendChild(this.buildRow('check interval (minutes)', intervalInput));
        this.updatesIntervalInput = intervalInput;

        // Row 3: channel radios.
        const channelFrag = document.createDocumentFragment();
        const stableLabel = document.createElement('label');
        stableLabel.className = 'settings-radio-label';
        const stableRadio = document.createElement('input');
        stableRadio.type = 'radio';
        stableRadio.name = 'updates-channel';
        stableRadio.value = 'stable';
        stableRadio.checked = s.channel === 'stable';
        stableRadio.addEventListener('change', () => {
            if (stableRadio.checked) {
                void this.patchUpdatesConfig({ channel: 'stable' });
            }
        });
        stableLabel.appendChild(stableRadio);
        stableLabel.appendChild(document.createTextNode('stable'));
        channelFrag.appendChild(stableLabel);

        const betaLabel = document.createElement('label');
        betaLabel.className = 'settings-radio-label';
        const betaRadio = document.createElement('input');
        betaRadio.type = 'radio';
        betaRadio.name = 'updates-channel';
        betaRadio.value = 'beta';
        betaRadio.checked = s.channel === 'beta';
        betaRadio.addEventListener('change', () => {
            if (betaRadio.checked) {
                void this.patchUpdatesConfig({ channel: 'beta' });
            }
        });
        betaLabel.appendChild(betaRadio);
        betaLabel.appendChild(document.createTextNode('beta'));
        channelFrag.appendChild(betaLabel);

        this.updatesBody.appendChild(this.buildRow('update channel', channelFrag));
        this.updatesChannelStableRadio = stableRadio;
        this.updatesChannelBetaRadio = betaRadio;

        // Row 4: github owner.
        const ownerInput = document.createElement('input');
        ownerInput.type = 'text';
        ownerInput.className = 'settings-input';
        ownerInput.value = s.githubOwner;
        ownerInput.addEventListener('blur', () => {
            const next = ownerInput.value.trim();
            if (next.length === 0) {
                ownerInput.value = this.updatesLastStatus?.githubOwner ?? '';
                return;
            }
            if (next === this.updatesLastStatus?.githubOwner) return;
            void this.patchUpdatesConfig({ githubOwner: next });
        });
        this.updatesBody.appendChild(this.buildRow('github owner', ownerInput));
        this.updatesOwnerInput = ownerInput;

        // Action row: label = live status text (idle: "last checked … —
        // up to date (vX)", ready: "vX ready to apply", checking/downloading:
        // progress, error: failure reason — wraps in left column as needed),
        // control = dual-purpose action button (left-aligned in right column
        // like every other control). Same row pattern as inputs above. The
        // button is "check for updates now" when there's nothing to apply
        // and flips to "apply update v{X}" when status === 'ready' (mirroring
        // the home-page UpdateButton chip). Single click handler branches on
        // current status — we just retitle the button as state changes.
        const actionBtn = document.createElement('button');
        actionBtn.type = 'button';
        actionBtn.className = 'settings-btn settings-btn-primary';
        actionBtn.textContent = 'check for updates now';
        actionBtn.addEventListener('click', () => {
            const cur = this.updatesLastStatus;
            if (cur && cur.status === 'ready') {
                void this.onApplyClick(actionBtn);
            } else {
                void this.onCheckNowClick();
            }
        });
        const { row: actionRow, labelEl: actionLabelEl } = this.buildDynamicLabelRow('', actionBtn);
        this.updatesBody.appendChild(actionRow);
        this.updatesCheckNowBtn = actionBtn;
        // Track the label element so applyUpdatesStatusText can mutate it
        // (kept type-compatible with the previous statusEl field).
        this.updatesStatusEl = actionLabelEl as unknown as HTMLElement;

        this.applyUpdatesStatusText(s);
        this.applyActionButtonState(s);
    }

    private applyUpdatesStatusText(s: UpdatesStatusResponse): void {
        if (!this.updatesStatusEl) return;
        let text = '';
        let isError = false;
        let isReady = false;
        switch (s.status) {
            case 'idle':
                text = `up to date: v${s.currentVersion}`;
                break;
            case 'checking':
                text = 'checking for updates…';
                break;
            case 'downloading': {
                const pct = typeof s.progress === 'number' ? Math.round(s.progress) : 0;
                text = `downloading v${s.availableVersion ?? '?'} — ${pct}%`;
                break;
            }
            case 'ready':
                text = `update: v${s.availableVersion ?? '?'}`;
                isReady = true;
                break;
            case 'error':
                text = `check failed: ${s.errorMessage ?? 'unknown error'}`;
                isError = true;
                break;
            default:
                text = '';
        }
        this.updatesStatusEl.textContent = text;
        this.updatesStatusEl.classList.toggle('settings-status-error', isError);
        // Pair the description text color with the action button: green
        // when an update is ready (mirrors .settings-btn-ready), default
        // muted otherwise. Idle/up-to-date stays muted alongside the blue
        // "check for updates now" button.
        this.updatesStatusEl.classList.toggle('settings-status-ready', isReady);
    }

    /**
     * Drive the dual-purpose action button's label + visual state from
     * the latest status. The button physically stays mounted across
     * polls/PATCHes; we just retitle and reskin it. Click branches on
     * current status, so swapping label here is enough to swap behavior.
     *
     *   - status='ready' → "apply update v{availableVersion}", green
     *     outline+text (.settings-btn-ready, mirrors home-page chip),
     *     enabled
     *   - status='checking' / 'downloading' → "check for updates now",
     *     blue (.settings-btn-primary), disabled
     *   - everything else → "check for updates now", blue, enabled
     */
    private applyActionButtonState(s: UpdatesStatusResponse): void {
        if (!this.updatesCheckNowBtn) return;
        const btn = this.updatesCheckNowBtn;
        const busy = s.status === 'checking' || s.status === 'downloading';
        btn.disabled = busy || this.updatesApplyInFlight;
        if (s.status === 'ready') {
            btn.textContent = s.availableVersion ? `apply v${s.availableVersion}` : 'apply update';
            btn.classList.remove('settings-btn-primary');
            btn.classList.add('settings-btn-ready');
        } else {
            btn.textContent = 'check for updates now';
            btn.classList.remove('settings-btn-ready');
            btn.classList.add('settings-btn-primary');
        }
    }

    private commitIntervalChange(input: HTMLInputElement): void {
        const raw = input.value.trim();
        const n = Number.parseInt(raw, 10);
        if (!Number.isFinite(n) || n < 5 || n > 1440) {
            input.value = String(this.updatesLastStatus?.updateCheckIntervalMinutes ?? 60);
            if (this.updatesStatusEl) {
                this.updatesStatusEl.textContent = 'interval must be between 5 and 1440 minutes';
                this.updatesStatusEl.classList.add('settings-status-error');
            }
            return;
        }
        if (n === this.updatesLastStatus?.updateCheckIntervalMinutes) return;
        void this.patchUpdatesConfig({ updateCheckIntervalMinutes: n });
    }

    private async patchUpdatesConfig(body: UpdatesConfigPatchRequest): Promise<void> {
        if (this.updatesStatusEl) {
            this.updatesStatusEl.textContent = 'saving…';
            this.updatesStatusEl.classList.remove('settings-status-error');
        }
        try {
            const r = await fetch('/api/updates/config', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!r.ok) {
                if (this.updatesStatusEl) {
                    this.updatesStatusEl.textContent = `save failed (${r.status})`;
                    this.updatesStatusEl.classList.add('settings-status-error');
                }
                return;
            }
            // The PATCH /api/updates/config endpoint returns a flat
            // UpdatesStatusResponse (see UpdatesApi.handleConfig). Pre-v0.1.21
            // this code tried to "tolerate either" a flat or wrapped shape via
            // `'status' in data`, but UpdatesStatusResponse itself has a
            // `status: UpdateState` string field — making `'status' in data`
            // always true and unwrapping the flat response to the literal
            // string. v0.1.21 fixes the type lie: the server only ever returns
            // the flat shape, so we read it directly.
            const status = (await r.json()) as UpdatesStatusResponse;
            this.updatesLastStatus = status;
            this.syncControlsToStatus(status);
            this.applyUpdatesStatusText(status);
            this.applyActionButtonState(status);
        } catch {
            if (this.updatesStatusEl) {
                this.updatesStatusEl.textContent = "couldn't reach server";
                this.updatesStatusEl.classList.add('settings-status-error');
            }
        }
    }

    /** Push server-side config values back into the rendered controls without rebuilding. */
    private syncControlsToStatus(s: UpdatesStatusResponse): void {
        if (this.updatesAutoCheckbox && this.updatesAutoCheckbox.checked !== s.autoUpdate) {
            this.updatesAutoCheckbox.checked = s.autoUpdate;
        }
        if (
            this.updatesIntervalInput &&
            document.activeElement !== this.updatesIntervalInput &&
            this.updatesIntervalInput.value !== String(s.updateCheckIntervalMinutes)
        ) {
            this.updatesIntervalInput.value = String(s.updateCheckIntervalMinutes);
        }
        const channel: UpdateChannel = s.channel;
        if (this.updatesChannelStableRadio) {
            this.updatesChannelStableRadio.checked = channel === 'stable';
        }
        if (this.updatesChannelBetaRadio) {
            this.updatesChannelBetaRadio.checked = channel === 'beta';
        }
        if (
            this.updatesOwnerInput &&
            document.activeElement !== this.updatesOwnerInput &&
            this.updatesOwnerInput.value !== s.githubOwner
        ) {
            this.updatesOwnerInput.value = s.githubOwner;
        }
    }

    /**
     * Apply a downloaded update from inside the Settings modal — mirrors
     * the home-page UpdateButton chip's apply path. POST /api/updates/apply
     * returns 200 then the server exits ~100ms later (after Velopack's
     * pre-apply hygiene + waitExitThenApplyUpdate); we show a "restarting…"
     * message and reload the page after a grace window so the user lands
     * on the new version once Velopack's swap + relaunch completes.
     */
    private async onApplyClick(btn: HTMLButtonElement): Promise<void> {
        if (this.updatesApplyInFlight) return;
        this.updatesApplyInFlight = true;
        btn.disabled = true;
        const prevText = btn.textContent;
        btn.textContent = 'applying…';
        if (this.updatesStatusEl) {
            this.updatesStatusEl.textContent = 'applying update…';
            this.updatesStatusEl.classList.remove('settings-status-error');
        }
        try {
            const r = await fetch('/api/updates/apply', { method: 'POST' });
            if (!r.ok) {
                if (this.updatesStatusEl) {
                    this.updatesStatusEl.textContent = `apply failed (${r.status})`;
                    this.updatesStatusEl.classList.add('settings-status-error');
                }
                btn.disabled = false;
                btn.textContent = prevText;
                this.updatesApplyInFlight = false;
                // Re-poll to learn the current state (probably 409 because state
                // wasn't 'ready' anymore by the time we got here).
                void this.refreshUpdates();
                return;
            }
            const applyBody = (await r.json().catch(() => ({}))) as { mode?: string };
            if (applyBody.mode === 'reconnect') {
                // Linux: server relaunching the AppImage. Show the upgrading
                // overlay and poll the same origin until the new version answers.
                await runUpgradingHandoff(this.updatesLastStatus?.currentVersion ?? '');
                return;
            }
            // Success: server is exiting within ~100ms. Show "restarting…" and
            // attempt a page reload after a 5s grace period. The reload will
            // fail until Velopack finishes the swap and relaunches the server;
            // that's expected — leave the message visible.
            if (this.updatesStatusEl) {
                this.updatesStatusEl.textContent = 'server restarting to apply update — page will reload…';
            }
            btn.textContent = 'restarting…';
            window.setTimeout(() => {
                try {
                    window.location.reload();
                } catch {
                    /* server still down — user will reload manually */
                }
            }, 5_000);
        } catch {
            if (this.updatesStatusEl) {
                this.updatesStatusEl.textContent = "couldn't reach server";
                this.updatesStatusEl.classList.add('settings-status-error');
            }
            btn.disabled = false;
            btn.textContent = prevText;
            this.updatesApplyInFlight = false;
            void this.refreshUpdates();
        }
    }

    private async onCheckNowClick(): Promise<void> {
        if (!this.updatesCheckNowBtn) return;
        const btn = this.updatesCheckNowBtn;
        btn.disabled = true;
        btn.textContent = 'checking…';
        if (this.updatesStatusEl) {
            this.updatesStatusEl.textContent = 'checking for updates…';
            this.updatesStatusEl.classList.remove('settings-status-error');
        }
        // §25b using-declaration replaces the prior try/finally. The dispose
        // ONLY re-enables the button (when appropriate) — it deliberately
        // does NOT restore textContent. The success path runs
        // applyActionButtonState which sets the correct final label
        // ("apply v{X}" when ready, "check for updates now" otherwise),
        // and the failure paths set their own labels below. Prior code
        // captured `prev` before the fetch and restored it in dispose,
        // which clobbered the correct "apply v{X}" label that
        // applyActionButtonState had just set — visible as a button with
        // green-ready styling but stale "check for updates now" text
        // (caught by v0.1.25-beta.15 smoke 2026-05-20).
        using _restoreBtn = {
            [Symbol.dispose]: (): void => {
                if (
                    this.updatesLastStatus &&
                    this.updatesLastStatus.status !== 'checking' &&
                    this.updatesLastStatus.status !== 'downloading'
                ) {
                    btn.disabled = false;
                }
            },
        };
        try {
            const r = await fetch('/api/updates/check', { method: 'POST' });
            if (!r.ok) {
                if (this.updatesStatusEl) {
                    this.updatesStatusEl.textContent = `check failed (${r.status})`;
                    this.updatesStatusEl.classList.add('settings-status-error');
                }
                btn.textContent = 'check for updates now';
                return;
            }
            const s = (await r.json()) as UpdatesStatusResponse;
            this.updatesLastStatus = s;
            this.syncControlsToStatus(s);
            this.applyUpdatesStatusText(s);
            this.applyActionButtonState(s);
        } catch {
            if (this.updatesStatusEl) {
                this.updatesStatusEl.textContent = "couldn't reach server";
                this.updatesStatusEl.classList.add('settings-status-error');
            }
            btn.textContent = 'check for updates now';
        }
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
