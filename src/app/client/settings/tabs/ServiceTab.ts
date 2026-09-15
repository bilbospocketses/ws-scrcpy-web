import type {
    ServiceInstallResponse,
    ServiceStatusResponse,
    ServiceUninstallResponse,
} from '../../../../common/ServiceEvents';
import { sameOriginUrl } from '../../../sameOriginUrl';
import { AdminConfirmModal, type AdminConfirmOptions } from '../../AdminConfirmModal';
import { pollServiceUninstalled } from '../../pollServiceUninstalled';
import { ServiceOperationModal } from '../../ServiceOperationModal';
import type { StagedSettingsStore } from '../StagedSettingsStore';
import type { TabContext } from './EmbeddingTab';

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
    /** The port the browser is actually on, so a shift can be detected. */
    currentPort: number | null;
    /** Sticky: any answering instance has reported the SERVICE as running. */
    serviceSeenRunning: boolean;
    iterations: number;
    maxIterations: number;
}): PollOutcome {
    // A PORT SHIFT is its own positive signal, and it is the one case
    // servedByService can never deliver. MEASURED 2026-09-07 (qa-harness Arc 1b row
    // 4.3): the service could not bind 8000 because the exiting local instance still
    // held it, so it took 8001. This poll is SAME-ORIGIN, so it kept asking 8000 —
    // where servedByService is false by construction, since that flag is only ever
    // true inside the service process. The branch below written for "a different
    // bound port" was therefore unreachable in exactly the situation it exists for,
    // and the user sat on a dying instance until the timeout.
    //
    // The exiting local instance can answer both halves of the question: its
    // readDiskConfig reports diskWebPort from config.json, and its `status` comes
    // from an sc.exe/systemctl query about the SERVICE, not about itself. So once
    // the service is known to be running and the disk port differs from ours, we
    // know where to go — whoever is answering.
    const portMoved = args.diskWebPort != null && args.currentPort != null && args.diskWebPort !== args.currentPort;
    if (portMoved && (args.servedByService || args.serviceSeenRunning)) {
        return { kind: 'navigate', port: args.diskWebPort as number };
    }
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

function reasonToUserMessage(reason: string | undefined, fallbackError: string): string {
    switch (reason) {
        case 'unsupported':
            return 'Service mode is not supported on this platform.';
        case 'uac-declined':
            return 'Administrative privileges were declined. Try again and approve the prompt.';
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

/** Local copy — see EmbeddingTab.ts's `buildSection` for why it isn't shared. */
function buildSection(title: string): { section: HTMLElement; body: HTMLElement } {
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

/** Local copy — see EmbeddingTab.ts's `buildRow` for why it isn't shared. */
function buildRow(labelText: string, control: HTMLElement | DocumentFragment): HTMLElement {
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
 * Local copy — same shape as `buildRow` but exposes the label element for live
 * updates (status text that changes underneath a retry button). See
 * EmbeddingTab.ts's `buildSection` for why these are not shared; `UpdatesTab`
 * carries the only other copy of this one.
 */
function buildDynamicLabelRow(
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
 * The Service tab's hooks back into `SettingsModal` — the one seam this move
 * couldn't close. `renderServiceState` (below) is the single place that learns
 * a fresh `ServiceStatusResponse`, and that response ALSO drives two rows that
 * live in the Server tab: the "stop server & exit" button (service mode means
 * the OS owns the app's lifecycle) and the Linux-only "install for all
 * users"/"uninstall" rows. This tab holds no reference to that one, so it hands
 * the response back through this callback; `SettingsModal` owns both tab
 * elements and forwards it to `ServerTab`'s `applyServerServiceStatus()`.
 */
export interface ServiceTabCallbacks {
    onServiceStatus(resp: ServiceStatusResponse): void;
}

/**
 * Per-instance refresh trigger, keyed by the section `buildServiceTab`
 * returned. `SettingsModal` builds every tab eagerly (before the docker probe
 * resolves) but must not fire `/api/service/status` until the probe says this
 * isn't a container and the role/reachability gate (`canUse('service')`)
 * passes — both post-probe decisions that stay in `SettingsModal`. This map is
 * what lets it re-enter a specific tab's refresh from outside, once it's ready,
 * without `buildServiceTab` itself returning anything other than the
 * `HTMLElement` its signature promises.
 */
const refreshers = new WeakMap<HTMLElement, (callbacks: ServiceTabCallbacks) => Promise<void>>();

/**
 * The Service tab (admin-only) — install/uninstall the OS service, plus the
 * Linux scope radios.
 *
 * Registers nothing with `store`: installing and uninstalling a service are
 * actions (they fire UAC/pkexec and tear down a running process), not values
 * to stage and save later.
 *
 * Builds synchronously with a "loading…" placeholder and fires no network
 * request itself — the refresh is triggered externally via the exported
 * `refreshService()`, exactly like the class method it replaces, so the
 * container-mode and role/reachability gating in `SettingsModal` (which decide
 * WHEN to call it) keep working unchanged.
 */
export function buildServiceTab(_ctx: TabContext, _store: StagedSettingsStore): HTMLElement {
    const { section, body } = buildSection('Service');
    const placeholder = document.createElement('p');
    placeholder.className = 'settings-status';
    placeholder.style.gridColumn = '1 / -1';
    // Was a bare "loading…" pre-move. Reworded (not just relabeled — this row IS
    // what install/uninstall status is loading for) so the tab names its own
    // subject even before the network answers, since refreshService() firing is
    // now entirely external/gated (see the class doc above) and this placeholder
    // is genuinely the only thing `buildServiceTab` can render synchronously.
    placeholder.textContent = 'loading install/uninstall status…';
    body.appendChild(placeholder);

    // Replaces the instance fields `this.servicePlatform` / `this.serviceScopeSystemRadio`
    // used to hold. Set by renderServiceState, read by onInstallService/onUninstallService —
    // all three are nested here so they share this closure instead of `this`.
    let servicePlatform: 'win32' | 'linux' | null = null;
    let serviceScopeSystemRadio: HTMLInputElement | null = null;

    function renderServiceError(msg: string, onRetry: () => void): void {
        body.replaceChildren();
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'settings-btn';
        retryBtn.textContent = 'retry';
        retryBtn.addEventListener('click', onRetry);
        const { row, labelEl } = buildDynamicLabelRow(msg, retryBtn);
        labelEl.classList.add('settings-status-error');
        body.appendChild(row);
    }

    /**
     * Render a neutral informational message in the service section (no error
     * styling, no retry button) — for informational follow-ups like the
     * system-scope uninstall success message. See buildServiceInfoRow (item 40b).
     */
    function renderServiceInfo(msg: string): void {
        body.replaceChildren();
        body.appendChild(buildServiceInfoRow(msg));
    }

    function renderServiceState(resp: ServiceStatusResponse, callbacks: ServiceTabCallbacks): void {
        body.replaceChildren();
        servicePlatform = (resp.platform as 'win32' | 'linux') ?? null;
        // Gate the App-section "stop server & exit" button off in service mode,
        // and reveal/disable the Linux-only "install for all users" + "uninstall"
        // rows — both live in the Server tab; see ServiceTabCallbacks.
        callbacks.onServiceStatus(resp);

        if (!resp.supported) {
            const notice = document.createElement('p');
            notice.className = 'settings-status';
            notice.style.gridColumn = '1 / -1';
            notice.textContent =
                resp.unsupportedReason || 'service mode is currently windows-only. linux support arrives later in SP3.';
            body.appendChild(notice);
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
        serviceScopeSystemRadio = null;
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

            body.appendChild(buildRow('service scope', scopeFrag));
            // serviceScopeSystemRadio feeds the install request body; null it
            // out when locked so the install handler (unreachable in that state
            // anyway) can't accidentally consume a stale value.
            serviceScopeSystemRadio = st.locked ? null : sysRadio;
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
                void onInstallService(btn, callbacks);
            });
        } else {
            btn.className = 'settings-btn settings-btn-danger';
            btn.textContent = `${status} — uninstall?`;
            btn.addEventListener('click', () => {
                void onUninstallService(btn, callbacks);
            });
        }
        body.appendChild(buildRow('installs/uninstalls server service', btn));

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
            body.appendChild(gateNote);
            const applyGate = (): void =>
                applySystemInstallGate(btn, gateNote, systemRadio.checked, machineWideInstalled);
            systemRadio.addEventListener('change', applyGate);
            scopeUserRadio?.addEventListener('change', applyGate);
            applyGate();
        }
    }

    async function runRefresh(callbacks: ServiceTabCallbacks): Promise<void> {
        body.replaceChildren();
        const loading = document.createElement('p');
        loading.className = 'settings-status';
        loading.style.gridColumn = '1 / -1';
        // Matches the build-time placeholder's wording — see the comment there.
        loading.textContent = 'loading install/uninstall status…';
        body.appendChild(loading);

        let resp: ServiceStatusResponse | null = null;
        try {
            const r = await fetch('/api/service/status');
            if (!r.ok) {
                renderServiceError("couldn't reach server", () => void runRefresh(callbacks));
                return;
            }
            resp = (await r.json()) as ServiceStatusResponse;
        } catch {
            renderServiceError("couldn't reach server", () => void runRefresh(callbacks));
            return;
        }
        renderServiceState(resp, callbacks);
    }

    async function onInstallService(btn: HTMLButtonElement, callbacks: ServiceTabCallbacks): Promise<void> {
        const isLinux = servicePlatform === 'linux';
        const isSystemScope = serviceScopeSystemRadio?.checked ?? false;

        if (isLinux && !isSystemScope) {
            // User scope on Linux: no elevation needed, proceed directly.
        } else {
            const opts: AdminConfirmOptions = { action: 'install service' };
            if (servicePlatform) opts.platform = servicePlatform;
            const confirmed = await AdminConfirmModal.confirm(opts);
            if (!confirmed) return;
        }

        btn.disabled = true;
        const prevText = btn.textContent;
        btn.textContent = 'installing…';

        const requestBody: { scope?: 'user' | 'system' } = {};
        if (serviceScopeSystemRadio) {
            requestBody.scope = serviceScopeSystemRadio.checked ? 'system' : 'user';
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
                        ? reasonToUserMessage(data.reason, data.error)
                        : `install failed (${r.status})`;
                modal.close();
                btn.disabled = false;
                btn.textContent = prevText;
                renderServiceError(errMsg, () => void runRefresh(callbacks));
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
            // Sticky across ticks: the origin dies mid-hand-off, so what we learned
            // while the local instance was still answering has to outlive it.
            let sawServiceRunning = false;
            let lastDiskWebPort: number | null = null;
            const browserPort = Number(window.location.port) || null;
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
                            status?: string;
                        };
                        configMtime = statusData.configMtime ?? null;
                        diskWebPort = statusData.diskWebPort ?? null;
                        servedByService = statusData.servedByService === true;
                        // `status` is the SERVICE's state (sc.exe / systemctl), not the
                        // answering process's, so the local instance can tell us the
                        // service came up even though it is not the service.
                        if (statusData.status === 'running') {
                            sawServiceRunning = true;
                        }
                        if (diskWebPort != null) {
                            lastDiskWebPort = diskWebPort;
                        }
                    }
                } catch {
                    reachable = false;
                }
                const outcome = classifyInstallPoll({
                    reachable,
                    servedByService,
                    configMtime,
                    baselineMtime,
                    // The last port we saw on disk, not just this tick's: an
                    // unreachable tick carries no body, and that is precisely the
                    // tick after the local instance exits.
                    diskWebPort: diskWebPort ?? lastDiskWebPort,
                    currentPort: browserPort,
                    serviceSeenRunning: sawServiceRunning,
                    iterations,
                    maxIterations,
                });
                switch (outcome.kind) {
                    case 'navigate':
                        clearInterval(poll);
                        // Same host the browser is on, new port. A literal
                        // localhost here sent every off-box client to its
                        // own machine (qa-harness Arc 1b, rows 4.3 / 12.2).
                        window.location.href = sameOriginUrl(outcome.port);
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
                        renderServiceError(
                            'service is running but port discovery timed out. reload the page at your usual address.',
                            () => void runRefresh(callbacks),
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
            renderServiceError("couldn't reach server", () => void runRefresh(callbacks));
        }
    }

    async function onUninstallService(btn: HTMLButtonElement, callbacks: ServiceTabCallbacks): Promise<void> {
        const isLinux = servicePlatform === 'linux';
        const isSystemScope = serviceScopeSystemRadio?.checked ?? false;

        if (isLinux && !isSystemScope) {
            // User scope on Linux: no elevation needed, proceed directly.
        } else {
            const opts: AdminConfirmOptions = { action: 'uninstall service' };
            if (servicePlatform) opts.platform = servicePlatform;
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
                        ? reasonToUserMessage(data.reason, data.error)
                        : `uninstall failed (${r.status})`;
                modal.close();
                btn.disabled = false;
                btn.textContent = prevText;
                renderServiceError(errMsg, () => void runRefresh(callbacks));
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
                    renderServiceInfo('removing the system service…');
                    const outcome = await pollServiceUninstalled();
                    btn.disabled = false;
                    btn.textContent = prevText;
                    if (outcome === 'uninstalled') {
                        renderServiceInfo(uninstallFollowupMessage('system'));
                    } else {
                        renderServiceError(
                            'the system service is still running — uninstall may not have completed. check the service logs and try again.',
                            () => void runRefresh(callbacks),
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
                        renderServiceError(
                            'service uninstalled but fresh instance not detected. try reloading.',
                            () => void runRefresh(callbacks),
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
                            window.location.href = sameOriginUrl(discoverData.webPort);
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
            await runRefresh(callbacks);
        } catch {
            modal.close();
            btn.disabled = false;
            btn.textContent = prevText;
            renderServiceError("couldn't reach server", () => void runRefresh(callbacks));
        }
    }

    refreshers.set(section, runRefresh);
    return section;
}

/**
 * Externally trigger the refresh for a Service tab `buildServiceTab` already
 * built. A no-op if `section` was never built through `buildServiceTab` (e.g.
 * role-gated out entirely) — same defensive shape as the
 * `if (!this.serviceSection) return;` guard this replaces.
 */
export async function refreshService(section: HTMLElement, callbacks: ServiceTabCallbacks): Promise<void> {
    const run = refreshers.get(section);
    if (!run) return;
    await run(callbacks);
}
