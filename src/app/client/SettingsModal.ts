import type { AppConfigEnvelope, AppConfigPatchResponse, UpdateChannel } from '../../common/ConfigEvents';
import type {
    ServiceInstallResponse,
    ServiceStatusResponse,
    ServiceUninstallResponse,
} from '../../common/ServiceEvents';
import type { UpdatesConfigPatchRequest, UpdatesStatusResponse } from '../../common/UpdateEvents';
import { Modal } from '../ui/Modal';
import { AdminConfirmModal, type AdminConfirmOptions } from './AdminConfirmModal';
import { authClient, type Role } from './AuthClient';
import { canSeeSection } from './adminGate';
import { ConfirmModal } from './ConfirmModal';
import { pollServiceUninstalled } from './pollServiceUninstalled';
import { ResetConfirmModal } from './ResetConfirmModal';
import { ServiceOperationModal } from './ServiceOperationModal';
import { settingsService } from './SettingsService';
import { UninstallConfirmModal } from './UninstallConfirmModal';
import { runUpgradingHandoff } from './UpgradingOverlay';
import { UsersModal } from './UsersModal';

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
 * timers) so it is unit-testable. After a service install the web port is handed
 * off to the service-Node, which identifies itself via `servedByService` (the
 * WS_SCRCPY_SERVICE env set on its unit):
 * - reachable AND servedByService -> the service has taken over. Same port (no
 *   config.json mtime change) -> reconnect (reload the current URL); a different
 *   bound port (mtime changed + known disk port) -> navigate there.
 * - otherwise (the local instance is still answering, or the brief hand-off dead
 *   window where nothing holds the port) -> keep polling until the cap, then
 *   timeout.
 *
 * Keying success on the POSITIVE servedByService signal — rather than catching a
 * transient unreachable tick (a race against the 2s poll) or a config.json mtime
 * change a same-port rebind never produces — removes the intermittent
 * "port discovery timed out" failure (beta.47).
 */
export type PollOutcome =
    | { kind: 'keep-polling' }
    | { kind: 'navigate'; port: number }
    | { kind: 'reconnect' }
    | { kind: 'timeout' };

export function classifyInstallPoll(args: {
    reachable: boolean;
    servedByService: boolean;
    configMtime: number | null;
    baselineMtime: number;
    diskWebPort: number | null;
    iterations: number;
    maxIterations: number;
}): PollOutcome {
    // Success requires a POSITIVE signal: the instance answering /api/service/status
    // is the service itself (WS_SCRCPY_SERVICE on its unit), not the exiting local
    // instance and not a transient dead port.
    if (args.reachable && args.servedByService) {
        // Different bound port -> navigate there; same port -> reload in place.
        if (args.configMtime != null && args.configMtime !== args.baselineMtime && args.diskWebPort != null) {
            return { kind: 'navigate', port: args.diskWebPort };
        }
        return { kind: 'reconnect' };
    }
    // Still the local instance answering, or the brief hand-off dead window:
    // keep waiting until the service identifies itself, then cap out.
    if (args.iterations > args.maxIterations) return { kind: 'timeout' };
    return { kind: 'keep-polling' };
}

/**
 * The /api/config patch sent by "reset welcome and bookmark prompts" — clears
 * only `firstRunComplete`, which is the sole prompt-related boot-trio field.
 * The three per-user prompt-dismissal flags (`serviceFirstRunSeen`,
 * `bookmarkDismissedForPort`, `bookmarkDismissedGlobally`) are reset separately
 * via `settingsService.patchGlobal()` inside buildResetControl. Exported (pure)
 * for testing. (v0.1.30-beta.31 #5d moved global bookmark flag to user_settings.)
 */
export function resetPromptsPayload(): Record<string, boolean | null> {
    return {
        firstRunComplete: false,
    };
}

/**
 * The per-user prompt flags reset by "reset welcome and bookmark prompts" —
 * clears the three flags that live in user_settings (SettingsApi). Exported
 * (pure) for testing; applied alongside resetPromptsPayload() in buildResetControl.
 */
export function resetPromptSettingsPayload(): Record<string, boolean | null> {
    return {
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

/**
 * Derive visibility/enabled state for the two Linux-only App-section rows —
 * "install for all users" and "uninstall ws-scrcpy-web". Pure (no DOM) so it is
 * unit-testable; mirrors stopServerButtonState's shape and is driven from
 * renderServiceState once /api/service/status resolves.
 *
 * - "install for all users" is Linux-only (hidden on win32/other).
 * - "uninstall" shows on Linux AND win32 (hidden on other platforms).
 * - "install for all users" is disabled once the shared /opt machine-wide
 *   install already exists (the root service execs that binary; re-installing it
 *   is a no-op), with an explanatory note in that state.
 * - "uninstall" is ALWAYS enabled when shown (unlike "stop server & exit" it is
 *   NOT gated on service mode — uninstalling is exactly how you tear a service
 *   down). Fields admit `undefined` so the full ServiceStatusResponse is
 *   assignable under exactOptionalPropertyTypes.
 */
export function appSectionButtonsState(resp: {
    platform?: string | null | undefined;
    machineWideInstalled?: boolean | undefined;
}): {
    showInstallAllUsers: boolean;
    installAllUsersDisabled: boolean;
    installAllUsersNote: string | null;
    showUninstall: boolean;
} {
    const linux = resp.platform === 'linux';
    const machineWide = resp.machineWideInstalled === true;
    return {
        showInstallAllUsers: linux,
        installAllUsersDisabled: linux && machineWide,
        installAllUsersNote: linux && machineWide ? 'already installed for all users (/opt)' : null,
        showUninstall: linux || resp.platform === 'win32',
    };
}

export interface SystemServiceInstallGate {
    enabled: boolean;
    note: string | null;
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
 * Build the Linux-only "install for all users" control: an "install" button
 * plus its full-width status note. Clicking POSTs /api/service/install-system-wide
 * (the server runs pkexec, relocates to /opt, and re-execs — the OS pkexec prompt
 * IS the confirmation, so there is no extra modal); on success the server is
 * about to re-exec, so the page reloads; on failure the note shows an inline
 * error. `reload` is injected so the unit test can observe it without navigating.
 * Self-contained DOM + wiring (no network until clicked) so it is unit-testable
 * like buildServiceInfoRow. Show/hide + the machine-wide disabled+note state are
 * applied separately via appSectionButtonsState (from renderServiceState).
 */
export function buildInstallAllUsersControl(opts: { reload: () => void }): {
    button: HTMLButtonElement;
    note: HTMLElement;
} {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'settings-btn settings-btn-primary';
    button.textContent = 'install';

    const note = document.createElement('p');
    note.className = 'settings-status';
    note.style.gridColumn = '1 / -1';
    note.hidden = true;

    button.addEventListener('click', () => {
        button.disabled = true;
        button.textContent = 'installing…';
        note.hidden = true;
        void (async () => {
            try {
                const res = await fetch('/api/service/install-system-wide', { method: 'POST' });
                if (res.ok) {
                    // The server is re-execing from /opt — reload onto the new instance.
                    opts.reload();
                    return;
                }
                note.textContent = 'install failed — see the server logs and try again.';
            } catch {
                note.textContent = 'install failed — could not reach the server.';
            }
            note.hidden = false;
            button.disabled = false;
            button.textContent = 'install';
        })();
    });

    return { button, note };
}

/**
 * Build the "uninstall ws-scrcpy-web" trigger button. When clicked, opens
 * UninstallConfirmModal (a top-layer <dialog>) instead of an inline panel.
 * On confirmation, POSTs /api/service/uninstall-app with { keep } and calls
 * opts.onUninstalled on success. Self-contained DOM + wiring; no network call
 * until the modal is confirmed.
 */
export function buildUninstallControl(opts: { onUninstalled: () => void }): {
    button: HTMLButtonElement;
} {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'settings-btn settings-btn-danger';
    button.textContent = 'uninstall…';

    button.addEventListener('click', () => {
        void (async () => {
            const r = await UninstallConfirmModal.confirm();
            if (!r.confirmed) return;
            button.disabled = true;
            button.textContent = 'uninstalling…';
            await fetch('/api/service/uninstall-app', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ keep: r.keep }),
            });
            opts.onUninstalled();
        })();
    });

    return { button };
}

/**
 * Build the "reset all my settings" trigger button. When clicked, opens
 * ResetConfirmModal (a top-layer <dialog>). On confirmation, calls
 * settingsService.reset() (POST /api/settings/reset — clears all user_settings,
 * device_labels, and device_settings for the current user: theme, icon size,
 * scan subnets, dismissed prompts, device names, and per-device stream/audio
 * prefs) and also PATCHes /api/config with resetPromptsPayload() (clearing
 * firstRunComplete, the boot-trio field that re-triggers first-run on reload).
 * Both calls are fire-and-forget; the page reload re-reads both endpoints
 * either way. Self-contained DOM + wiring; no network call until confirmed.
 */
export function buildResetControl(opts: { reload: () => void }): {
    button: HTMLButtonElement;
} {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'settings-btn settings-btn-primary';
    button.textContent = 'reset';

    button.addEventListener('click', () => {
        void (async () => {
            const confirmed = await ResetConfirmModal.confirm();
            if (!confirmed) return;
            // Full user-settings reset: all user_settings + device_labels +
            // device_settings via settingsService.reset(); and firstRunComplete
            // → /api/config (boot-trio field, re-triggers first-run on reload).
            // Both fire-and-forget; the page reload re-reads both endpoints.
            await Promise.all([
                settingsService.reset().catch(() => undefined),
                fetch('/api/config', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(resetPromptsPayload()),
                }).catch(() => undefined),
            ]);
            opts.reload();
        })();
    });

    return { button };
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
    private role: Role | null = null;
    private authEnabled = false;
    private serviceSection!: HTMLElement;
    private webPortInput: HTMLInputElement | null = null;
    private webPortStatus: HTMLElement | null = null;
    private serverSaveBtn: HTMLButtonElement | null = null;
    private currentWebPort: number | null = null;
    private serviceScopeSystemRadio: HTMLInputElement | null = null;
    private servicePlatform: 'win32' | 'linux' | null = null;

    // ── Server section (folded App) state ────────────────────────────────
    private stopServerButton: HTMLButtonElement | null = null;
    private stopServerNote: HTMLElement | null = null;
    // Linux-only rows (hidden on win32). Shown/disabled via appSectionButtonsState
    // from renderServiceState once /api/service/status resolves.
    private installAllUsersRow: HTMLElement | null = null;
    private installAllUsersButton: HTMLButtonElement | null = null;
    private installAllUsersNote: HTMLElement | null = null;
    private uninstallRow: HTMLElement | null = null;
    private uninstallButton: HTMLButtonElement | null = null;

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
                if (canSeeSection(role, 'service')) void this.refreshService();
                if (canSeeSection(role, 'updates')) void this.refreshUpdates();
                void this.refreshServer(); // server section always present (has the user-level reset row)
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
        if (canSeeSection(this.role, 'users')) container.appendChild(this.buildUsersSection());
        if (canSeeSection(this.role, 'updates')) container.appendChild(this.buildUpdatesSection());
        if (canSeeSection(this.role, 'service')) container.appendChild(this.buildServiceSection());
        container.appendChild(this.buildServerSection()); // always (contains the user-level reset row)
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

    // ── Users section (admin-only) ─────────────────────────────────────────
    private buildUsersSection(): HTMLElement {
        const { section, body } = this.buildSection('Users');

        // 1. Manage users button — opens UsersModal (admin-only action).
        const manageBtn = document.createElement('button');
        manageBtn.type = 'button';
        manageBtn.className = 'modal-button';
        manageBtn.textContent = 'manage users';
        manageBtn.addEventListener('click', () => {
            new UsersModal();
        });
        body.appendChild(this.buildRow('user accounts', manageBtn));

        // 2. Auth toggle — disable login (authEnabled=true) or enable login
        //    (authEnabled=false). window.location.reload() on success.
        const toggleStatus = document.createElement('p');
        toggleStatus.className = 'settings-status';
        toggleStatus.style.gridColumn = '1 / -1';
        toggleStatus.hidden = true;

        if (this.authEnabled) {
            const disableBtn = document.createElement('button');
            disableBtn.type = 'button';
            disableBtn.className = 'modal-button';
            disableBtn.textContent = 'disable login (return to open mode)';
            disableBtn.addEventListener('click', () => {
                disableBtn.disabled = true;
                void (async () => {
                    try {
                        await authClient.disableAuth();
                        window.location.reload();
                    } catch {
                        toggleStatus.textContent = 'failed to disable login — see server logs.';
                        toggleStatus.hidden = false;
                        disableBtn.disabled = false;
                    }
                })();
            });
            body.appendChild(this.buildRow('login', disableBtn));
        } else {
            const enableBtn = document.createElement('button');
            enableBtn.type = 'button';
            enableBtn.className = 'modal-button';
            enableBtn.textContent = 'enable login';
            enableBtn.addEventListener('click', () => {
                enableBtn.disabled = true;
                void (async () => {
                    try {
                        const res = await authClient.enableAuth();
                        if (res.ok) {
                            window.location.reload();
                            return;
                        }
                        if (res.status === 409) {
                            toggleStatus.textContent = 'Add a user with an admin password first (Users → manage users)';
                        } else {
                            toggleStatus.textContent = `failed to enable login (${res.status})`;
                        }
                        toggleStatus.hidden = false;
                        enableBtn.disabled = false;
                    } catch {
                        toggleStatus.textContent = 'failed to enable login — could not reach server.';
                        toggleStatus.hidden = false;
                        enableBtn.disabled = false;
                    }
                })();
            });
            body.appendChild(this.buildRow('login', enableBtn));
        }

        body.appendChild(toggleStatus);
        return section;
    }

    // ── Server section ─────────────────────────────────────────────────────
    private buildServerSection(): HTMLElement {
        const { section, body } = this.buildSection('Server');

        // 1. reset all my settings — user-level, always visible. Opens
        //    ResetConfirmModal, then clears all user settings (theme, device
        //    names, per-device stream/audio prefs, icon size, scan subnets,
        //    dismissed prompts) and reloads so first-run re-triggers and all
        //    prefs are read fresh.
        const reset = buildResetControl({ reload: () => window.location.reload() });
        body.appendChild(this.buildRow('reset all my settings', reset.button));

        // 1b. change password — user-level, only shown when auth is enabled
        //     (in open mode there is no password to change). Reveals an inline
        //     form with current + new password inputs, each with an eye toggle.
        //     On save → authClient.changePassword(); on success collapse the form;
        //     on failure show inline status. Never throws.
        if (this.authEnabled) {
            const cpStatus = document.createElement('p');
            cpStatus.className = 'settings-status';
            cpStatus.style.gridColumn = '1 / -1';
            cpStatus.hidden = true;

            const cpForm = document.createElement('div');
            cpForm.style.cssText = 'display:none; flex-direction:column; gap:6px; margin-top:4px;';

            // Current password row
            const curRow = document.createElement('div');
            curRow.style.cssText = 'display:flex; align-items:center; gap:4px;';
            const curInput = document.createElement('input');
            curInput.type = 'password';
            curInput.placeholder = 'current password';
            curInput.className = 'settings-input';
            curInput.setAttribute('data-field', 'cp-current');
            const curEye = document.createElement('button');
            curEye.type = 'button';
            curEye.className = 'modal-button';
            curEye.textContent = '👁';
            curEye.title = 'show/hide';
            curEye.addEventListener('click', () => {
                curInput.type = curInput.type === 'password' ? 'text' : 'password';
            });
            curRow.appendChild(curInput);
            curRow.appendChild(curEye);
            cpForm.appendChild(curRow);

            // New password row
            const newRow = document.createElement('div');
            newRow.style.cssText = 'display:flex; align-items:center; gap:4px;';
            const newInput = document.createElement('input');
            newInput.type = 'password';
            newInput.placeholder = 'new password';
            newInput.className = 'settings-input';
            newInput.setAttribute('data-field', 'cp-new');
            const newEye = document.createElement('button');
            newEye.type = 'button';
            newEye.className = 'modal-button';
            newEye.textContent = '👁';
            newEye.title = 'show/hide';
            newEye.addEventListener('click', () => {
                newInput.type = newInput.type === 'password' ? 'text' : 'password';
            });
            newRow.appendChild(newInput);
            newRow.appendChild(newEye);
            cpForm.appendChild(newRow);

            // Save / cancel
            const cpBtnRow = document.createElement('div');
            cpBtnRow.style.cssText = 'display:flex; gap:6px;';
            const saveBtn = document.createElement('button');
            saveBtn.type = 'button';
            saveBtn.className = 'modal-button';
            saveBtn.textContent = 'save';
            saveBtn.addEventListener('click', () => {
                void (async () => {
                    saveBtn.disabled = true;
                    cpStatus.textContent = 'saving…';
                    cpStatus.hidden = false;
                    try {
                        const ok = await authClient.changePassword(curInput.value, newInput.value);
                        if (ok) {
                            cpStatus.textContent = 'password changed';
                            cpForm.style.display = 'none';
                            cpBtn.style.display = '';
                            curInput.value = '';
                            newInput.value = '';
                        } else {
                            cpStatus.textContent = 'current password incorrect';
                        }
                    } catch {
                        cpStatus.textContent = 'could not reach server';
                    }
                    saveBtn.disabled = false;
                })();
            });
            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'modal-button';
            cancelBtn.textContent = 'cancel';
            cancelBtn.addEventListener('click', () => {
                cpForm.style.display = 'none';
                cpBtn.style.display = '';
                cpStatus.hidden = true;
                curInput.value = '';
                newInput.value = '';
            });
            cpBtnRow.appendChild(saveBtn);
            cpBtnRow.appendChild(cancelBtn);
            cpForm.appendChild(cpBtnRow);

            // The trigger button (shown by default, hides when form is open)
            const cpBtn = document.createElement('button');
            cpBtn.type = 'button';
            cpBtn.className = 'modal-button';
            cpBtn.textContent = 'change password';
            cpBtn.setAttribute('data-action', 'change-password');
            cpBtn.addEventListener('click', () => {
                cpBtn.style.display = 'none';
                cpStatus.hidden = true;
                cpForm.style.display = 'flex';
            });

            const cpControl = document.createDocumentFragment();
            cpControl.appendChild(cpBtn);
            cpControl.appendChild(cpForm);
            body.appendChild(this.buildRow('password', cpControl));
            body.appendChild(cpStatus);
        }

        // 2–5 below are admin-only. Skip building + storing them entirely for
        //    non-admin users so no DOM or ref is created. The refresh methods
        //    (refreshServer, applyStopServerButtonState, applyAppSectionButtonsState)
        //    are all null-safe on their stored refs — they guard with `if (this.x)`.
        if (canSeeSection(this.role, 'webPort')) {
            // 2. web port — number input with the SAVE button INLINE to its right
            //    (same control cell). The status line below the row is EMPTY at rest
            //    and only fills on save (saving → restarting/redirecting, "no change",
            //    or an error) via setServerStatus / onSavePort.
            this.webPortInput = document.createElement('input');
            this.webPortInput.type = 'number';
            this.webPortInput.min = '1024';
            this.webPortInput.max = '65535';
            this.webPortInput.className = 'settings-input';
            this.webPortInput.style.maxWidth = '120px';

            this.serverSaveBtn = document.createElement('button');
            this.serverSaveBtn.type = 'button';
            this.serverSaveBtn.className = 'settings-btn settings-btn-primary';
            this.serverSaveBtn.textContent = 'save';
            this.serverSaveBtn.style.marginLeft = '0.5rem';
            this.serverSaveBtn.addEventListener('click', () => {
                void this.onSavePort();
            });

            const portControl = document.createDocumentFragment();
            portControl.appendChild(this.webPortInput);
            portControl.appendChild(this.serverSaveBtn);
            body.appendChild(this.buildRow('web port', portControl));

            this.webPortStatus = document.createElement('p');
            this.webPortStatus.className = 'settings-status';
            this.webPortStatus.style.gridColumn = '1 / -1';
            this.webPortStatus.hidden = true;
            body.appendChild(this.webPortStatus);
        }

        if (canSeeSection(this.role, 'serverControls')) {
            // 3. install for all users (Linux-only) — hidden until
            //    applyAppSectionButtonsState reveals it on Linux. POSTs
            //    /api/service/install-system-wide (pkexec → /opt → re-exec); the OS
            //    pkexec dialog is the confirmation, so on success just reload.
            const install = buildInstallAllUsersControl({ reload: () => window.location.reload() });
            this.installAllUsersButton = install.button;
            this.installAllUsersNote = install.note;
            const installRow = this.buildRow('install for all users', install.button);
            installRow.style.display = 'none';
            this.installAllUsersRow = installRow;
            body.appendChild(installRow);
            body.appendChild(install.note);

            // 4. stop the server and close the app — §27 graceful shutdown (exit 0,
            //    the launcher supervisor will NOT restart it). Gated off in service
            //    mode by applyStopServerButtonState once /api/service/status resolves.
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

            // 5. uninstall ws-scrcpy-web (Linux + win32) — hidden until revealed.
            //    Always enabled when shown (uninstalling is how you remove a
            //    service). Opens UninstallConfirmModal; confirm POSTs
            //    /api/service/uninstall-app { keep }.
            const uninstall = buildUninstallControl({ onUninstalled: () => this.showUninstalledOverlay() });
            this.uninstallButton = uninstall.button;
            const uninstallRow = this.buildRow('uninstall ws-scrcpy-web', uninstall.button);
            uninstallRow.style.display = 'none';
            this.uninstallRow = uninstallRow;
            body.appendChild(uninstallRow);
        }

        return section;
    }

    private async refreshServer(): Promise<void> {
        if (!this.webPortInput) return; // web port row not built (non-admin)
        try {
            const r = await fetch('/api/config');
            if (!r.ok) {
                this.setServerStatus("couldn't reach server", true);
                return;
            }
            const env = (await r.json()) as AppConfigEnvelope;
            this.currentWebPort = env.config.webPort;
            this.webPortInput.value = String(env.config.webPort);
            // No at-rest hint: the status line below the web-port row stays
            // empty until a save (then: saving → restarting/redirecting, a
            // "no change" note, or an error).
        } catch {
            this.setServerStatus("couldn't reach server", true);
        }
    }

    private async onSavePort(): Promise<void> {
        if (!this.webPortInput || !this.serverSaveBtn) return; // not built (non-admin)
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
        const saveBtn = this.serverSaveBtn;
        using _restoreBtn = {
            [Symbol.dispose]: (): void => {
                saveBtn.disabled = false;
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
                this.setServerStatus('restarting → redirecting…', false);
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
        if (!this.webPortStatus) return; // web port row not built (non-admin)
        this.webPortStatus.textContent = msg;
        // The status line lives BELOW the web-port row and is empty at rest —
        // hide it when there is no message so it doesn't reserve a blank row.
        this.webPortStatus.hidden = msg.length === 0;
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
        // Reveal/disable the Linux-only "install for all users" + "uninstall" rows.
        this.applyAppSectionButtonsState(resp);

        if (!resp.supported) {
            const notice = document.createElement('p');
            notice.className = 'settings-status';
            notice.style.gridColumn = '1 / -1';
            notice.textContent =
                resp.unsupportedReason || 'service mode is currently windows-only. linux support arrives later in SP3.';
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
        this.serviceSection.appendChild(this.buildRow('installs/uninstalls server service', btn));

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
                const errMsg =
                    data && data.ok === false
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
            // §7 (system-service takeover): update the visible copy to
            // reflect the hand-off window — local instance is exiting,
            // systemd is restarting, service will bind the same port.
            if (isSystemScope) {
                btn.textContent = 'switching to the system service…';
            }
            const poll = setInterval(async () => {
                iterations++;
                // A thrown/aborted fetch means whoever was answering has dropped —
                // the local instance exiting, or the brief hand-off dead window. We
                // do NOT treat that as success: we wait for the service to answer with
                // servedByService=true (below) before reconnecting/navigating.
                let reachable = true;
                let servedByService = false;
                let configMtime: number | null = null;
                let diskWebPort: number | null = null;
                try {
                    const statusResp = await fetch('/api/service/status', { signal: AbortSignal.timeout(5000) });
                    if (statusResp.ok) {
                        const statusData = (await statusResp.json()) as {
                            configMtime?: number;
                            diskWebPort?: number;
                            servedByService?: boolean;
                        };
                        configMtime = statusData.configMtime ?? null;
                        diskWebPort = statusData.diskWebPort ?? null;
                        servedByService = statusData.servedByService === true;
                    }
                } catch {
                    reachable = false;
                }
                const outcome = classifyInstallPoll({
                    reachable,
                    servedByService,
                    configMtime,
                    baselineMtime,
                    diskWebPort,
                    iterations,
                    maxIterations,
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
                        setTimeout(() => {
                            window.location.reload();
                        }, 2500);
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
                const errMsg =
                    data && data.ok === false
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
                const isSystemUninstall = data.installMode === 'system' || data.installMode === 'system-service';
                if (isLinux && isSystemUninstall) {
                    // System scope on Linux: the out-of-cgroup teardown helper runs
                    // ASYNCHRONOUSLY. Do NOT claim success blindly — beta.60 #9 5.1: the
                    // helper could core-dump (missing DATA_ROOT) while ServiceApi already
                    // returned `shutting-down`, leaving the service running but the UI
                    // saying "removed". Poll /api/service/status until the service is
                    // actually gone, and surface a failure if it never does.
                    modal.close();
                    this.renderServiceInfo('removing the system service…');
                    const outcome = await pollServiceUninstalled();
                    btn.disabled = false;
                    btn.textContent = prevText;
                    if (outcome === 'uninstalled') {
                        this.renderServiceInfo(uninstallFollowupMessage('system'));
                    } else {
                        this.renderServiceError(
                            'the system service is still running — uninstall may not have completed. check the service logs and try again.',
                            () => void this.refreshService(),
                        );
                    }
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
                        const discoverData = (await resp.json()) as {
                            webPort?: number | null;
                            configMtime?: number | null;
                        };
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

    // The former "App" section (reset, install-for-all-users, stop & exit,
    // uninstall) was folded into the Server section — see buildServerSection (beta.62).

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
     * Reflect the (unit-tested) appSectionButtonsState decision onto the two
     * Linux-only App-section rows. Called from renderServiceState once
     * /api/service/status resolves: reveals the rows on Linux (inline display
     * overrides the .settings-row { display: contents } rule), disables the
     * "install for all users" button with an explanatory note once the machine-wide
     * /opt install exists, and keeps the uninstall row always enabled on Linux.
     */
    private applyAppSectionButtonsState(resp: ServiceStatusResponse): void {
        const state = appSectionButtonsState(resp);
        if (this.installAllUsersRow) {
            this.installAllUsersRow.style.display = state.showInstallAllUsers ? '' : 'none';
        }
        if (this.installAllUsersButton) {
            this.installAllUsersButton.disabled = state.installAllUsersDisabled;
        }
        if (this.installAllUsersNote) {
            this.installAllUsersNote.textContent = state.installAllUsersNote ?? '';
            this.installAllUsersNote.hidden = state.installAllUsersNote === null;
        }
        if (this.uninstallRow) {
            this.uninstallRow.style.display = state.showUninstall ? '' : 'none';
        }
        if (this.uninstallButton) {
            // Uninstall is ALWAYS enabled on Linux — never gated on service mode
            // (unlike "stop server & exit"); uninstalling is how you tear a service
            // down. Asserting it here documents and enforces that invariant.
            this.uninstallButton.disabled = false;
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

    /** Blank the page with a terminal "uninstalled" notice after uninstall succeeds. */
    private showUninstalledOverlay(): void {
        const overlay = document.createElement('div');
        overlay.style.cssText =
            'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
            'padding:1rem;text-align:center;opacity:0.85;';
        const msg = document.createElement('p');
        msg.textContent = 'ws-scrcpy-web uninstalled — you can close this tab.';
        overlay.appendChild(msg);
        document.body.replaceChildren(overlay);
    }
}
