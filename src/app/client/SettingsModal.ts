import { Modal } from '../ui/Modal';
import { AdminConfirmModal, type AdminConfirmOptions } from './AdminConfirmModal';
import { ConfirmModal } from './ConfirmModal';
import { ServiceOperationModal } from './ServiceOperationModal';
import { runUpgradingHandoff } from './UpgradingOverlay';
import type { AppConfigEnvelope, AppConfigPatchResponse, UpdateChannel } from '../../common/ConfigEvents';
import type {
    ServiceStatusResponse,
    ServiceInstallResponse,
    ServiceUninstallResponse,
} from '../../common/ServiceEvents';
import type { UpdatesStatusResponse, UpdatesConfigPatchRequest } from '../../common/UpdateEvents';

/**
 * Follow-up copy shown after a Linux service uninstall begins, by scope.
 * User scope: the Rust teardown helper relaunches the home AppImage in local
 * mode, so the page will reconnect. System scope: no relaunch - user is
 * informed the service has been stopped.
 */
export function uninstallFollowupMessage(mode: 'user' | 'system'): string {
    return mode === 'system'
        ? 'service removed. the system service has been stopped. relaunch the app manually to use local mode.'
        : 'service removed. relaunching the app in local mode. this page will reconnect shortly.';
}

/**
 * Classify one tick of the post-install port-discovery poll. Pure (no DOM or
 * timers) so it is unit-testable. After a service install the web port is
 * handed off to the service-Node:
 * - unreachable local server -> the local instance is exiting (fix #3) and the
 *   service is rebinding the SAME port -> reconnect (reload the current URL).
 * - config.json mtime changed + a known disk port -> the service bound a new
 *   port -> navigate there (the pre-existing Windows path, unchanged).
 * - past the iteration cap -> timeout.
 */
export type PollOutcome =
    | { kind: 'keep-polling' }
    | { kind: 'navigate'; port: number }
    | { kind: 'reconnect' }
    | { kind: 'timeout' };

export function classifyInstallPoll(args: {
    reachable: boolean;
    configMtime: number | null;
    baselineMtime: number;
    diskWebPort: number | null;
    iterations: number;
    maxIterations: number;
}): PollOutcome {
    if (!args.reachable) return { kind: 'reconnect' };
    if (
        args.configMtime != null &&
        args.configMtime !== args.baselineMtime &&
        args.diskWebPort != null
    ) {
        return { kind: 'navigate', port: args.diskWebPort };
    }
    if (args.iterations > args.maxIterations) return { kind: 'timeout' };
    return { kind: 'keep-polling' };
}

/**
 * The config patch sent by "reset welcome and bookmark prompts" — clears all
 * four first-run / bookmark flags so each relevant modal can re-fire. Exported
 * (pure) for testing. (v0.1.30-beta.31 #5d adds the global bookmark flag.)
 */
export function resetPromptsPayload(): Record<string, boolean | null> {
    return {
        firstRunComplete: false,
        serviceFirstRunSeen: false,
        bookmarkDismissedForPort: null,
        bookmarkDismissedGlobally: false,
    };
}

/** Structural subset of ServiceStatusResponse that drives the scope radios.
 * Fields admit `undefined` explicitly for exactOptionalPropertyTypes so the
 * full ServiceStatusResponse is assignable. */
export interface ScopeRadioInputs {
    status?: string | undefined;
    installMode?: string | null | undefined;
    scope?: string | null | undefined;
}

export interface ScopeRadioState {
    installedScope: 'user' | 'system' | null;
    /** A service is installed -> the radios are read-only (locked). */
    locked: boolean;
    userChecked: boolean;
    systemChecked: boolean;
}

/**
 * Derive the Linux service-scope radio state from the service status. Pure (no
 * DOM) so it is unit-testable. Prefers the authoritative filesystem scope
 * (resp.scope — which systemd unit exists) and falls back to mapping the
 * mutable installMode, accepting BOTH the bare ('user'/'system') and '-service'
 * forms for older servers that don't report scope. (The pre-fix render code
 * only mapped the two '-service' forms, so a drifted installMode left both
 * radios unselected even with a service installed.)
 */
export function scopeRadioState(resp: ScopeRadioInputs): ScopeRadioState {
    const isInstalled = (resp.status ?? 'not-installed') !== 'not-installed';
    const scopeFromInstallMode: 'user' | 'system' | null =
        resp.installMode === 'system-service' || resp.installMode === 'system'
            ? 'system'
            : resp.installMode === 'user-service' || resp.installMode === 'user'
                ? 'user'
                : null;
    const installedScope: 'user' | 'system' | null =
        resp.scope === 'user' || resp.scope === 'system' ? resp.scope : scopeFromInstallMode;
    return {
        installedScope,
        locked: isInstalled,
        userChecked: isInstalled ? installedScope === 'user' : true,
        systemChecked: isInstalled && installedScope === 'system',
    };
}

/**
 * Gate the App-section "stop server & exit" button by service mode. When a
 * service is installed (service mode), the OS service manager owns the app's
 * lifecycle — a browser-initiated quit would fight it (or be restarted), so the
 * button is disabled with an explanatory note. In local mode (no service) the
 * button is enabled. Pure (no DOM) so it is unit-testable; mirrors
 * scopeRadioState's "installed" derivation.
 */
export function stopServerButtonState(resp: ScopeRadioInputs): {
    disabled: boolean;
    note: string | null;
} {
    const isInstalled = (resp.status ?? 'not-installed') !== 'not-installed';
    return isInstalled
        ? {
              disabled: true,
              note: 'managed by the system service — stop it via your service manager, or uninstall the service.',
          }
        : { disabled: false, note: null };
}

export interface SystemServiceInstallGate { enabled: boolean; note: string | null; }
/**
 * Derive whether the migration reinstall notice should be shown. Pure (no DOM)
 * so it is unit-testable; mirrors systemServiceInstallGate's shape. When true,
 * the caller should render the notice text and a [reinstall now] action button
 * that POSTs /api/service/migrate-system.
 */
export function migrationNotice(input: { serviceMigrationNeeded?: boolean }): { show: boolean; text: string } {
    return input.serviceMigrationNeeded
        ? { show: true, text: 'this service uses the old layout. reinstall it to update to the new layout.' }
        : { show: false, text: '' };
}

/** System-scope service install requires a machine-wide /opt install first
 *  (the root service execs the /opt binary; it can't exist without it). */
export function systemServiceInstallGate(input: { machineWideInstalled: boolean }): SystemServiceInstallGate {
    return input.machineWideInstalled
        ? { enabled: true, note: null }
        : { enabled: false, note: 'system service install requires installing system-wide for all users first.' };
}

/**
 * Apply the system-scope install gate to the Linux service-install button and
 * its note element. When the 'system' scope radio is the selected scope and the
 * app is NOT yet installed machine-wide (/opt), system-scope service install
 * can't work, so disable the button and surface the gate note; otherwise the
 * button is enabled and the note hidden. Pure DOM mutation on the passed
 * elements (mirrors lockScopeRadioControl) so it is unit-testable; the gate
 * logic itself lives in the unit-tested systemServiceInstallGate.
 */
export function applySystemInstallGate(
    btn: HTMLButtonElement,
    note: HTMLElement,
    systemSelected: boolean,
    machineWideInstalled: boolean,
): void {
    const gate = systemServiceInstallGate({ machineWideInstalled });
    const blocked = systemSelected && !gate.enabled;
    btn.disabled = blocked;
    note.textContent = blocked ? (gate.note ?? '') : '';
    note.hidden = !blocked;
}

/**
 * Lock a service-scope radio as read-only WITHOUT the `disabled` attribute.
 * Chromium desaturates `accent-color` on :disabled form controls, which made
 * the selected dot invisible against the muted track (item 42 — the active
 * scope was unreadable when a service was installed). Keeping the radio
 * ENABLED lets accent-color render; tabindex=-1 removes it from the tab order,
 * and the `.settings-radio-locked` class applies `pointer-events: none` on the
 * label so it can't be clicked or toggled.
 */
export function lockScopeRadioControl(label: HTMLLabelElement, radio: HTMLInputElement): void {
    radio.tabIndex = -1;
    label.classList.add('settings-radio-locked');
}

/**
 * Build a neutral (non-error) full-width service status line — a plain label,
 * no error styling, no retry button. Used for informational follow-ups like the
 * system-scope uninstall success message (item 40b — previously mis-rendered
 * through renderServiceError as red + a retry button, though it is an
 * informational success, not an error). Pure DOM so it is unit-testable, like
 * lockScopeRadioControl.
 */
export function buildServiceInfoRow(message: string): HTMLElement {
    const p = document.createElement('p');
    p.className = 'settings-status';
    p.style.gridColumn = '1 / -1';
    p.textContent = message;
    return p;
}

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
export class SettingsModal extends Modal {
    private serviceSection!: HTMLElement;
    private webPortInput!: HTMLInputElement;
    private webPortStatus!: HTMLElement;
    private serverSaveBtn!: HTMLButtonElement;
    private currentWebPort: number | null = null;
    private serviceScopeSystemRadio: HTMLInputElement | null = null;
    private servicePlatform: 'win32' | 'linux' | null = null;

    // ── App section state ─────────────────────────────────────────────────
    private stopServerButton: HTMLButtonElement | null = null;
    private stopServerNote: HTMLElement | null = null;

    // ── Updates section state ─────────────────────────────────────────────
    private updatesBody!: HTMLElement;
    private updatesStatusEl!: HTMLElement;
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
        queueMicrotask(() => {
            this.fillBody(this.bodyEl);
            void this.refreshServer();
            void this.refreshService();
            void this.refreshUpdates();
        });
    }

    protected buildBody(_container: HTMLElement): void {
        // Body content rendered by fillBody() via queueMicrotask.
    }

    private fillBody(container: HTMLElement): void {
        // v0.1.23: Updates first (most-touched section in practice),
        // then Server (host port), Service (install/uninstall),
        // App (rare-use reset).
        container.appendChild(this.buildUpdatesSection());
        container.appendChild(this.buildServerSection());
        container.appendChild(this.buildServiceSection());
        container.appendChild(this.buildAppSection());
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

    // ── Server section ─────────────────────────────────────────────────────
    private buildServerSection(): HTMLElement {
        const { section, body } = this.buildSection('Server');

        this.webPortInput = document.createElement('input');
        this.webPortInput.type = 'number';
        this.webPortInput.min = '1024';
        this.webPortInput.max = '65535';
        this.webPortInput.className = 'settings-input';
        this.webPortInput.style.maxWidth = '120px';
        body.appendChild(this.buildRow('web port', this.webPortInput));

        // Save row: label = redirect-note (wraps in left column), control =
        // save button (left-aligned in right column like every other control).
        // The label text is dynamic — starts with the redirect explainer
        // and swaps to "saving…" / "saved." / error during onSavePort.
        this.serverSaveBtn = document.createElement('button');
        this.serverSaveBtn.type = 'button';
        this.serverSaveBtn.className = 'settings-btn settings-btn-primary';
        this.serverSaveBtn.textContent = 'save';
        this.serverSaveBtn.addEventListener('click', () => {
            void this.onSavePort();
        });
        const { row: saveRow, labelEl: saveLabelEl } = this.buildDynamicLabelRow(
            'save restarts & redirects',
            this.serverSaveBtn,
        );
        body.appendChild(saveRow);
        // setServerStatus mutates this label to show progress / errors.
        // We keep the original element type as <span> so it lines up with
        // every other label in the modal — no extra <p> wrapper.
        this.webPortStatus = saveLabelEl as unknown as HTMLElement;

        return section;
    }

    private async refreshServer(): Promise<void> {
        try {
            const r = await fetch('/api/config');
            if (!r.ok) {
                this.setServerStatus("couldn't reach server", true);
                return;
            }
            const env = (await r.json()) as AppConfigEnvelope;
            this.currentWebPort = env.config.webPort;
            this.webPortInput.value = String(env.config.webPort);
            // Default note: explain the redirect-on-save behavior so the
            // user knows clicking save isn't a static config change but a
            // server restart with auto-redirect to the new URL.
            this.setServerStatus('save restarts & redirects');
        } catch {
            this.setServerStatus("couldn't reach server", true);
        }
    }

    private async onSavePort(): Promise<void> {
        const raw = this.webPortInput.value.trim();
        const port = Number.parseInt(raw, 10);
        if (!Number.isFinite(port) || port < 1024 || port > 65535) {
            this.setServerStatus('port must be between 1024 and 65535', true);
            return;
        }
        if (port === this.currentWebPort) {
            this.setServerStatus('no change.', false);
            return;
        }
        this.serverSaveBtn.disabled = true;
        this.setServerStatus('saving…', false);
        // §25b — using-declaration replaces the prior try/finally re-enabling
        // serverSaveBtn. Captures `this` so the dispose also handles the
        // early-return inside the try (where the prior code had a manual
        // re-enable line that is now redundant — kept for symmetry, see below).
        using _restoreBtn = {
            [Symbol.dispose]: (): void => {
                this.serverSaveBtn.disabled = false;
            },
        };
        try {
            const r = await fetch('/api/config', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ webPort: port }),
            });
            if (!r.ok) {
                this.setServerStatus(`save failed (${r.status})`, true);
                // Early-return path: using-dispose above re-enables the button.
                // Redundant explicit re-enable removed (was duplicating the
                // finally cleanup).
                return;
            }
            const data = (await r.json()) as AppConfigPatchResponse;
            this.currentWebPort = data.config.webPort;
            if (data.restartRequired) {
                this.setServerStatus(
                    'restarting → redirecting…',
                    false,
                );
                if (data.redirectTo) {
                    setTimeout(() => {
                        window.location.href = data.redirectTo!;
                    }, 4000);
                }
            } else {
                this.setServerStatus('saved.', false);
            }
        } catch {
            this.setServerStatus("couldn't reach server", true);
        }
    }

    private setServerStatus(msg: string, isError = false): void {
        this.webPortStatus.textContent = msg;
        this.webPortStatus.classList.toggle('settings-status-error', isError);
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

        // Linux libfuse2 gate — required for AppImage updates via Velopack.
        if (s.libfuse2Installed === false) {
            const versionNote = document.createElement('p');
            versionNote.className = 'settings-stub-note';
            versionNote.style.gridColumn = '1 / -1';
            versionNote.textContent = `current: v${s.currentVersion}`;
            this.updatesBody.appendChild(versionNote);

            const warning = document.createElement('p');
            warning.style.cssText = 'grid-column: 1 / -1; color: var(--error-color, #ff6b6b); margin: 4px 0;';
            warning.textContent = 'libfuse2 is required for in-app updates but is not installed.';
            this.updatesBody.appendChild(warning);

            const installBtn = document.createElement('button');
            installBtn.type = 'button';
            installBtn.className = 'settings-btn settings-btn-primary';
            installBtn.textContent = 'install libfuse2';
            installBtn.addEventListener('click', () => {
                installBtn.disabled = true;
                installBtn.textContent = 'installing...';
                fetch('/api/updates/install-libfuse2', { method: 'POST' })
                    .then(async (r) => {
                        const data = await r.json().catch(() => null) as { ok?: boolean; error?: string } | null;
                        if (r.ok && data?.ok) {
                            void this.refreshUpdates();
                        } else {
                            warning.textContent = data?.error ?? 'install failed';
                            installBtn.disabled = false;
                            installBtn.textContent = 'install libfuse2';
                        }
                    })
                    .catch(() => {
                        warning.textContent = "couldn't reach server";
                        installBtn.disabled = false;
                        installBtn.textContent = 'install libfuse2';
                    });
            });
            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'grid-column: 1 / -1; display: flex; justify-content: flex-start;';
            btnRow.appendChild(installBtn);
            this.updatesBody.appendChild(btnRow);

            const hint = document.createElement('p');
            hint.style.cssText = 'grid-column: 1 / -1; color: var(--text-color-light); font-size: 12px; margin: 4px 0 0;';
            hint.textContent = 'or install manually (e.g. "sudo dnf install fuse-libs") and restart the app.';
            this.updatesBody.appendChild(hint);
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
            btn.textContent = s.availableVersion
                ? `apply v${s.availableVersion}`
                : 'apply update';
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

    // ── Service section ────────────────────────────────────────────────────
    private buildServiceSection(): HTMLElement {
        const { section, body } = this.buildSection('Service');
        const placeholder = document.createElement('p');
        placeholder.className = 'settings-status';
        placeholder.style.gridColumn = '1 / -1';
        placeholder.textContent = 'loading…';
        body.appendChild(placeholder);
        this.serviceSection = body;
        return section;
    }

    private async refreshService(): Promise<void> {
        this.serviceSection.replaceChildren();
        const loading = document.createElement('p');
        loading.className = 'settings-status';
        loading.style.gridColumn = '1 / -1';
        loading.textContent = 'loading…';
        this.serviceSection.appendChild(loading);

        let resp: ServiceStatusResponse | null = null;
        try {
            const r = await fetch('/api/service/status');
            if (!r.ok) {
                this.renderServiceError("couldn't reach server", () => void this.refreshService());
                return;
            }
            resp = (await r.json()) as ServiceStatusResponse;
        } catch {
            this.renderServiceError("couldn't reach server", () => void this.refreshService());
            return;
        }
        this.renderServiceState(resp);
    }

    private renderServiceState(resp: ServiceStatusResponse): void {
        this.serviceSection.replaceChildren();
        this.servicePlatform = (resp.platform as 'win32' | 'linux') ?? null;
        // Gate the App-section "stop server & exit" button off in service mode.
        this.applyStopServerButtonState(resp);

        if (!resp.supported) {
            const notice = document.createElement('p');
            notice.className = 'settings-status';
            notice.style.gridColumn = '1 / -1';
            notice.textContent =
                resp.unsupportedReason ||
                'service mode is currently windows-only. linux support arrives later in SP3.';
            this.serviceSection.appendChild(notice);
            return;
        }

        const status = resp.status ?? 'not-installed';

        // Linux scope chooser: standard settings row matching the update
        // channel row's pattern. Always rendered on Linux. When the service is
        // installed the radios are pre-selected from the active scope and
        // LOCKED (read-only) — switching scope requires a deliberate
        // uninstall→reinstall (systemd user-scope and system-scope unit files
        // live in different paths and can't coexist for the same service
        // name). Pre-v0.1.30 the row was only rendered when not installed,
        // leaving no in-UI way to tell which scope was active.
        this.serviceScopeSystemRadio = null;
        // Captured for the system-scope install gate wired after the button is
        // built (both radios drive its re-evaluation on toggle).
        let scopeUserRadio: HTMLInputElement | null = null;
        let scopeSystemRadio: HTMLInputElement | null = null;
        if (resp.platform === 'linux') {
            // Detection + lock state (pure, unit-tested in scopeRadioState).
            // Locked radios stay ENABLED and are made non-interactive via
            // lockScopeRadioControl — NOT `disabled` — because Chromium
            // desaturates accent-color on :disabled controls, which hid the
            // selected dot (item 42).
            const st = scopeRadioState(resp);

            const scopeFrag = document.createDocumentFragment();

            const userLabel = document.createElement('label');
            userLabel.className = 'settings-radio-label';
            const userRadio = document.createElement('input');
            userRadio.type = 'radio';
            userRadio.name = 'settings-scope';
            userRadio.value = 'user';
            userRadio.checked = st.userChecked;
            userLabel.appendChild(userRadio);
            userLabel.appendChild(document.createTextNode('user'));
            if (st.locked) lockScopeRadioControl(userLabel, userRadio);
            scopeFrag.appendChild(userLabel);

            const sysLabel = document.createElement('label');
            sysLabel.className = 'settings-radio-label';
            const sysRadio = document.createElement('input');
            sysRadio.type = 'radio';
            sysRadio.name = 'settings-scope';
            sysRadio.value = 'system';
            sysRadio.checked = st.systemChecked;
            sysLabel.appendChild(sysRadio);
            sysLabel.appendChild(document.createTextNode('system (req. sudo)'));
            if (st.locked) lockScopeRadioControl(sysLabel, sysRadio);
            scopeFrag.appendChild(sysLabel);

            this.serviceSection.appendChild(this.buildRow('service scope', scopeFrag));
            // serviceScopeSystemRadio feeds the install request body; null it
            // out when locked so the install handler (unreachable in that state
            // anyway) can't accidentally consume a stale value.
            this.serviceScopeSystemRadio = st.locked ? null : sysRadio;
            scopeUserRadio = userRadio;
            scopeSystemRadio = sysRadio;
        }

        // One row: label = informational blurb (left column, wraps),
        // control = state-aware action button (left-aligned in right
        // column like every other control). Green for install (positive
        // action, mirrors apply-update); red for uninstall (destructive).
        const btn = document.createElement('button');
        btn.type = 'button';
        if (status === 'not-installed') {
            btn.className = 'settings-btn settings-btn-ready';
            btn.textContent = 'not installed — install?';
            btn.addEventListener('click', () => {
                void this.onInstallService(btn);
            });
        } else {
            btn.className = 'settings-btn settings-btn-danger';
            btn.textContent = `${status} — uninstall?`;
            btn.addEventListener('click', () => {
                void this.onUninstallService(btn);
            });
        }
        this.serviceSection.appendChild(
            this.buildRow('installs/uninstalls server service', btn),
        );

        // Linux: gate the system-scope install button on a prior machine-wide
        // (/opt) install — the root service execs the shared /opt binary, which
        // must exist first. Only relevant in the not-installed state (the
        // install button); when a service is installed the button is uninstall
        // and the radios are locked. Re-evaluated whenever the scope radio
        // toggles. Gate logic is the unit-tested applySystemInstallGate.
        if (status === 'not-installed' && resp.platform === 'linux' && scopeSystemRadio) {
            const systemRadio = scopeSystemRadio;
            const machineWideInstalled = resp.machineWideInstalled ?? false;
            const gateNote = document.createElement('p');
            gateNote.className = 'settings-status';
            gateNote.style.gridColumn = '1 / -1';
            gateNote.hidden = true;
            this.serviceSection.appendChild(gateNote);
            const applyGate = (): void =>
                applySystemInstallGate(btn, gateNote, systemRadio.checked, machineWideInstalled);
            systemRadio.addEventListener('change', applyGate);
            scopeUserRadio?.addEventListener('change', applyGate);
            applyGate();
        }
    }

    private renderServiceError(msg: string, onRetry: () => void): void {
        this.serviceSection.replaceChildren();
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'settings-btn';
        retryBtn.textContent = 'retry';
        retryBtn.addEventListener('click', onRetry);
        const { row, labelEl } = this.buildDynamicLabelRow(msg, retryBtn);
        labelEl.classList.add('settings-status-error');
        this.serviceSection.appendChild(row);
    }

    /**
     * Render a neutral informational message in the service section (no error
     * styling, no retry button) — for informational follow-ups like the
     * system-scope uninstall success message. See buildServiceInfoRow (item 40b).
     */
    private renderServiceInfo(msg: string): void {
        this.serviceSection.replaceChildren();
        this.serviceSection.appendChild(buildServiceInfoRow(msg));
    }

    private async onInstallService(btn: HTMLButtonElement): Promise<void> {
        const isLinux = this.servicePlatform === 'linux';
        const isSystemScope = this.serviceScopeSystemRadio?.checked ?? false;

        if (isLinux && !isSystemScope) {
            // User scope on Linux: no elevation needed, proceed directly.
        } else {
            const opts: AdminConfirmOptions = { action: 'install service' };
            if (this.servicePlatform) opts.platform = this.servicePlatform;
            const confirmed = await AdminConfirmModal.confirm(opts);
            if (!confirmed) return;
        }

        btn.disabled = true;
        const prevText = btn.textContent;
        btn.textContent = 'installing…';

        const requestBody: { scope?: 'user' | 'system' } = {};
        if (this.serviceScopeSystemRadio) {
            requestBody.scope = this.serviceScopeSystemRadio.checked ? 'system' : 'user';
        }
        const modal = new ServiceOperationModal({ operation: 'install' });
        try {
            const r = await fetch('/api/service/install', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
            });
            const data = (await r.json().catch(() => null)) as ServiceInstallResponse | null;
            if (!r.ok || !data || data.ok !== true) {
                const errMsg = data && data.ok === false
                    ? SettingsModal.reasonToUserMessage(data.reason, data.error)
                    : `install failed (${r.status})`;
                modal.close();
                btn.disabled = false;
                btn.textContent = prevText;
                this.renderServiceError(errMsg, () => void this.refreshService());
                return;
            }

            // §39: mtime-based discovery. Poll /api/service/status until
            // config.json mtime changes (service-Node wrote its bound port).
            const baselineMtime = data.configMtime ?? 0;
            const pollInterval = 2000;
            const maxIterations = 30;
            let iterations = 0;
            const poll = setInterval(async () => {
                iterations++;
                // A thrown/aborted fetch means the local server has dropped: under
                // fix #3 the local instance exits after a successful install, so the
                // service is taking over the SAME port (reconnect, not an error).
                let reachable = true;
                let configMtime: number | null = null;
                let diskWebPort: number | null = null;
                try {
                    const statusResp = await fetch('/api/service/status', { signal: AbortSignal.timeout(5000) });
                    if (statusResp.ok) {
                        const statusData = await statusResp.json() as { configMtime?: number; diskWebPort?: number };
                        configMtime = statusData.configMtime ?? null;
                        diskWebPort = statusData.diskWebPort ?? null;
                    }
                } catch {
                    reachable = false;
                }
                const outcome = classifyInstallPoll({
                    reachable, configMtime, baselineMtime, diskWebPort, iterations, maxIterations,
                });
                switch (outcome.kind) {
                    case 'navigate':
                        clearInterval(poll);
                        window.location.href = `http://localhost:${outcome.port}/`;
                        return;
                    case 'reconnect':
                        // Same-port handoff: reload the current URL after a short
                        // grace so the service has bound the port.
                        clearInterval(poll);
                        btn.textContent = 'reconnecting…';
                        setTimeout(() => { window.location.reload(); }, 2500);
                        return;
                    case 'timeout':
                        clearInterval(poll);
                        modal.close();
                        btn.disabled = false;
                        btn.textContent = prevText;
                        this.renderServiceError(
                            'service is running but port discovery timed out. reload the page at your usual address.',
                            () => void this.refreshService(),
                        );
                        return;
                    case 'keep-polling':
                        return;
                }
            }, pollInterval);
        } catch {
            modal.close();
            btn.disabled = false;
            btn.textContent = prevText;
            this.renderServiceError("couldn't reach server", () => void this.refreshService());
        }
    }

    private async onUninstallService(btn: HTMLButtonElement): Promise<void> {
        const isLinux = this.servicePlatform === 'linux';
        const isSystemScope = this.serviceScopeSystemRadio?.checked ?? false;

        if (isLinux && !isSystemScope) {
            // User scope on Linux: no elevation needed, proceed directly.
        } else {
            const opts: AdminConfirmOptions = { action: 'uninstall service' };
            if (this.servicePlatform) opts.platform = this.servicePlatform;
            const confirmed = await AdminConfirmModal.confirm(opts);
            if (!confirmed) return;
        }

        btn.disabled = true;
        const prevText = btn.textContent;
        btn.textContent = 'uninstalling…';

        const modal = new ServiceOperationModal({ operation: 'uninstall' });
        try {
            const r = await fetch('/api/service/uninstall', { method: 'POST' });
            const data = (await r.json().catch(() => null)) as ServiceUninstallResponse | null;
            if (!r.ok || !data || data.ok !== true) {
                const errMsg = data && data.ok === false
                    ? SettingsModal.reasonToUserMessage(data.reason, data.error)
                    : `uninstall failed (${r.status})`;
                modal.close();
                btn.disabled = false;
                btn.textContent = prevText;
                this.renderServiceError(errMsg, () => void this.refreshService());
                return;
            }
            if (data.status === 'shutting-down') {
                // Derive scope from the installMode field so we know whether a
                // local relaunch is coming (user scope) or not (system scope).
                const isSystemUninstall =
                    data.installMode === 'system' || data.installMode === 'system-service';
                if (isLinux && isSystemUninstall) {
                    // System scope on Linux: teardown helper stops the unit but
                    // does NOT relaunch a local instance. Nothing to poll for.
                    modal.close();
                    btn.disabled = false;
                    btn.textContent = prevText;
                    this.renderServiceInfo(uninstallFollowupMessage('system'));
                    return;
                }
                // User scope on Linux (or Windows): a fresh local instance is
                // relaunching. Fall through to the mtime poll / navigate path.
                // §39: mtime-based discovery via operation-server's /api/discover.
                // The service-Node is about to die. The operation-server takes over
                // the port. Poll /api/discover until config.json mtime changes
                // (fresh launcher wrote its bound port), then navigate.
                const baselineMtime = data.configMtime ?? 0;
                const pollInterval = 2000;
                const maxIterations = 30;
                let iterations = 0;
                let serverDied = false;

                const poll = setInterval(async () => {
                    iterations++;
                    if (iterations > maxIterations) {
                        clearInterval(poll);
                        modal.close();
                        btn.disabled = false;
                        btn.textContent = prevText;
                        this.renderServiceError(
                            'service uninstalled but fresh instance not detected. try reloading.',
                            () => void this.refreshService(),
                        );
                        return;
                    }
                    try {
                        const resp = await fetch('/api/discover', { signal: AbortSignal.timeout(5000) });
                        if (!resp.ok) return;
                        const discoverData = await resp.json() as { webPort?: number | null; configMtime?: number | null };
                        if (
                            discoverData.configMtime != null &&
                            discoverData.configMtime !== baselineMtime &&
                            discoverData.webPort != null
                        ) {
                            clearInterval(poll);
                            window.location.href = `http://localhost:${discoverData.webPort}/`;
                        }
                    } catch {
                        if (!serverDied) {
                            serverDied = true;
                        } else if (iterations > 5) {
                            clearInterval(poll);
                            window.location.reload();
                        }
                    }
                }, pollInterval);
                return;
            }
            // Non-shutting-down success (e.g., direct uninstall from user context)
            modal.close();
            btn.disabled = false;
            btn.textContent = prevText;
            await this.refreshService();
        } catch {
            modal.close();
            btn.disabled = false;
            btn.textContent = prevText;
            this.renderServiceError("couldn't reach server", () => void this.refreshService());
        }
    }

    private static reasonToUserMessage(reason: string | undefined, fallbackError: string): string {
        switch (reason) {
            case 'unsupported':
                return 'Service mode is not supported on this platform.';
            case 'uac-declined':
                return 'Administrative privileges were declined. Try again and approve the prompt.';
            case 'handoff-timeout':
                return "Couldn't reach the user session. Make sure ws-scrcpy-web is running for your user, then try again.";
            case 'handoff-no-target':
                return "Couldn't identify a user session to relay the action to.";
            case 'invalid-token':
                return 'Resume token is invalid or expired. Refresh the page and try again.';
            case 'servy-failure':
                return `Service install/uninstall failed: ${fallbackError}`;
            case 'service-start-failed':
                return 'The service was installed but did not start, so it was removed. The app is still running locally — check the service logs and try again.';
            case 'unknown':
            case undefined:
                return `An unexpected error occurred: ${fallbackError}`;
            default:
                return fallbackError;
        }
    }

    // ── App section ────────────────────────────────────────────────────────
    private buildAppSection(): HTMLElement {
        const { section, body } = this.buildSection('App');

        // §27 — stop the server and exit the app. Backs the existing
        // /api/server/shutdown endpoint (which now runs graceful teardown
        // before exiting 0 — a clean exit the launcher supervisor will NOT
        // restart). Gated off in service mode (the OS service manager owns the
        // lifecycle) by applyStopServerButtonState, driven from
        // renderServiceState once /api/service/status resolves.
        const stopBtn = document.createElement('button');
        stopBtn.type = 'button';
        stopBtn.className = 'settings-btn settings-btn-primary';
        stopBtn.textContent = 'stop server & exit';
        stopBtn.addEventListener('click', () => void this.onStopServerExit(stopBtn));
        this.stopServerButton = stopBtn;
        body.appendChild(this.buildRow('stop the server and close the app', stopBtn));

        const stopNote = document.createElement('p');
        stopNote.className = 'settings-status';
        stopNote.style.gridColumn = '1 / -1';
        stopNote.hidden = true;
        this.stopServerNote = stopNote;
        body.appendChild(stopNote);

        const resetBtn = document.createElement('button');
        resetBtn.type = 'button';
        resetBtn.className = 'settings-btn settings-btn-primary';
        resetBtn.textContent = 'reset';
        body.appendChild(this.buildRow('reset welcome and bookmark prompts', resetBtn));

        // Confirm panel — hidden by default, expands inside the grid below
        // the reset row when the button is clicked. Spans both columns.
        const confirmPanel = document.createElement('div');
        confirmPanel.className = 'settings-confirm-panel';

        const confirmText = document.createElement('p');
        confirmText.textContent =
            'this resets the welcome modal, service-mode modal, the per-port bookmark ' +
            'reminder, and the global bookmark dismissal. the page will reload so the ' +
            'appropriate modal can re-fire. it does not affect install mode, audio ' +
            'preferences, or scan history.';
        confirmPanel.appendChild(confirmText);

        const confirmButtons = document.createElement('div');
        confirmButtons.className = 'settings-confirm-buttons';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'settings-btn';
        cancelBtn.textContent = 'cancel';
        cancelBtn.addEventListener('click', () => {
            confirmPanel.classList.remove('expanded');
        });
        confirmButtons.appendChild(cancelBtn);

        const confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.className = 'settings-btn settings-btn-primary';
        confirmBtn.textContent = 'confirm reset';
        confirmBtn.addEventListener('click', () => {
            fetch('/api/config', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(resetPromptsPayload()),
            }).finally(() => {
                window.location.reload();
            });
        });
        confirmButtons.appendChild(confirmBtn);

        confirmPanel.appendChild(confirmButtons);
        body.appendChild(confirmPanel);

        resetBtn.addEventListener('click', () => {
            confirmPanel.classList.toggle('expanded');
        });

        return section;
    }

    /**
     * Reflect the (unit-tested) stopServerButtonState decision onto the App
     * section's button + note. Called from renderServiceState once
     * /api/service/status resolves, so the button is disabled with a note when
     * a service is installed (service mode) and enabled otherwise.
     */
    private applyStopServerButtonState(resp: ScopeRadioInputs): void {
        if (!this.stopServerButton) return;
        const state = stopServerButtonState(resp);
        this.stopServerButton.disabled = state.disabled;
        if (this.stopServerNote) {
            this.stopServerNote.textContent = state.note ?? '';
            this.stopServerNote.hidden = state.note === null;
        }
    }

    /**
     * Confirm, then POST /api/server/shutdown (graceful teardown + exit 0),
     * then try to self-close the tab. Falls back to a full-page "app stopped"
     * notice when the browser blocks window.close() (tabs not opened by script).
     */
    private async onStopServerExit(btn: HTMLButtonElement): Promise<void> {
        const confirmed = await ConfirmModal.confirm({
            title: 'stop server & exit',
            message:
                'the app will shut down and this browser tab will try to close. ' +
                'any active device connections will end. continue?',
        });
        if (!confirmed) return;

        btn.disabled = true;
        btn.textContent = 'stopping…';
        try {
            await fetch('/api/server/shutdown', { method: 'POST' });
        } catch {
            // The server drops the connection as it exits — expected, not an error.
        }
        // window.close() only succeeds for tabs the script itself opened;
        // otherwise it is a silent no-op. Show the notice regardless — if the
        // tab does close the overlay is moot, if not the user gets clear closure.
        window.close();
        this.showAppStoppedOverlay();
    }

    /** Blank the page with a centered "app stopped" notice (window.close fallback). */
    private showAppStoppedOverlay(): void {
        const overlay = document.createElement('div');
        overlay.style.cssText =
            'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
            'padding:1rem;text-align:center;opacity:0.85;';
        const msg = document.createElement('p');
        msg.textContent = 'app stopped — you can close this tab.';
        overlay.appendChild(msg);
        document.body.replaceChildren(overlay);
    }
}
