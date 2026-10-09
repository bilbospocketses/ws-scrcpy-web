import type { AppConfigEnvelope } from '../../../../common/ConfigEvents';
import type { ServiceStatusResponse } from '../../../../common/ServiceEvents';
import { authClient } from '../../AuthClient';
import { canSeeSection } from '../../adminGate';
import { ConfirmModal } from '../../ConfirmModal';
import { ResetConfirmModal } from '../../ResetConfirmModal';
import { settingsService } from '../../SettingsService';
import { isElevationDeclined, reasonToUserMessage } from '../../serviceFailureMessage';
import { UninstallConfirmModal } from '../../UninstallConfirmModal';
import type { StagedSettingsStore } from '../StagedSettingsStore';
import { type AskChild, askUnbound, type TabContext } from './EmbeddingTab';
import { fetchMkcertInstalled } from './LocalHttpsTab';
// Type-only, so it is erased at build time and adds no runtime dependency on the
// sibling tab. `ScopeRadioInputs` is the three-field subset of
// /api/service/status that BOTH tabs derive state from (Service: the scope
// radios; Server: the stop-server button), and re-declaring it here would mean
// two descriptions of one wire shape free to drift apart.
import type { ScopeRadioInputs } from './ServiceTab';

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

/** The staged-field id and summary label for the http port — one definition, so
 *  the build-time registration and the post-read re-baseline cannot disagree.
 *  The id stays `webPort`, the config key's name, so nothing on disk moves. */
const WEB_PORT_ID = 'webPort';
const WEB_PORT_LABEL = 'HTTP port';

/** The staged-field id and summary label for the https port (`SettingsBatchApi`'s `httpsPort`). */
export const HTTPS_PORT_ID = 'httpsPort';
const HTTPS_PORT_LABEL = 'HTTPS port';

/** `Config.ts`'s DEFAULT_HTTPS_PORT, for a /api/tls/state that does not name one. */
const DEFAULT_HTTPS_PORT = 8443;

/** Under the https port while it is unavailable: no mkcert, or no certificate yet. */
export const HTTPS_PORT_GATE_NOTE =
    'applies to the certificate local https generates; install mkcert and generate one first.';

/** Below both port rows, always: saving either one restarts the server (SettingsBatchApi). */
export const PORT_RESTART_NOTE = 'changing either port restarts the server; any active streams will drop.';

/** The inline refusal on whichever port row was just edited onto the other's value. */
export const PORT_COLLISION_ERROR = 'the http and https ports must differ.';

/**
 * Notification 5: a sub-1024 port needs elevated privileges outside win32.
 * It moved here from the Local HTTPS tab with the https port it is about.
 *
 * M2: an ALLOWLIST (only linux/darwin fire), not a win32-denylist -- an
 * unknown/undefined platform (this tab hasn't learned it yet, or it is
 * genuinely unrecognized) must not fire this. The previous denylist shape
 * fired for anything that WASN'T literally `'win32'`, which included
 * `undefined` -- exactly what a hardcoded `?? 'linux'` fallback once
 * manufactured before the real platform had arrived.
 */
export function subPrivilegedPortNotice(port: number, platform: NodeJS.Platform | string | undefined): string | null {
    if (platform !== 'linux' && platform !== 'darwin') return null;
    if (!Number.isFinite(port) || port <= 0 || port >= 1024) return null;
    return 'ports below 1024 need elevated privileges on this platform; the server may fail to start.';
}

/** Ids for the port rows' labels and notes, unique across every dialog opened on the page. */
let portDomSeq = 0;
function nextPortDomId(): string {
    portDomSeq += 1;
    return `settings-port-${portDomSeq}`;
}

/**
 * Name a row's input after its row label (`aria-labelledby`): the label is a
 * `<span>` in the grid's other column, so it does not name the input by itself.
 */
function labelInputByRow(row: HTMLElement, input: HTMLInputElement): void {
    const label = row.querySelector<HTMLElement>('.settings-label');
    if (!label) return;
    if (!label.id) label.id = nextPortDomId();
    input.setAttribute('aria-labelledby', label.id);
}

/**
 * Point `aria-describedby` at whichever of `notes` are showing, or drop it:
 * a hidden note named there would still be read out.
 */
function describeBy(input: HTMLInputElement | null, notes: Array<HTMLElement | null>): void {
    if (!input) return;
    const ids = notes.filter((n): n is HTMLElement => n !== null && !n.hidden).map((n) => n.id);
    if (ids.length > 0) input.setAttribute('aria-describedby', ids.join(' '));
    else input.removeAttribute('aria-describedby');
}

/**
 * What the https port row needs from `GET /api/tls/state` (admin-only, like
 * this row): whether a certificate exists, and the configured port. `port` is
 * null when the read failed, so the row keeps whatever it had rather than
 * showing a guess; a reply that names no port gets the server's own default.
 */
async function readTlsPortState(): Promise<{ ready: boolean; port: number | null }> {
    try {
        const res = await fetch('/api/tls/state');
        if (!res.ok) return { ready: false, port: null };
        const state = (await res.json()) as { status?: unknown; httpsPort?: unknown };
        return {
            ready: state.status === 'ready',
            port: typeof state.httpsPort === 'number' ? state.httpsPort : DEFAULT_HTTPS_PORT,
        };
    } catch {
        return { ready: false, port: null };
    }
}

/**
 * Copy for the overlay shown once the app uninstall has been handed off.
 *
 * It is deliberately about what STARTED, not what finished. `POST
 * /api/service/uninstall-app` answers 200 as soon as the detached helper is
 * spawned — before the cleaner runs, before the app exits, before anything is
 * deleted — so the page renders this at a moment when the outcome does not yet
 * exist. It can never learn the outcome either: the server it would ask is gone
 * by then. The previous copy asserted "ws-scrcpy-web uninstalled", which was
 * plainly false whenever a running adb blocked the delete (item 131), and is the
 * same class of unearned success claim as #120.
 */
export function appUninstallStartedMessage(): string {
    return 'uninstall started — ws-scrcpy-web is shutting down and removing itself. you can close this tab.';
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
 * clears the four flags that live in user_settings (SettingsApi). Exported
 * (pure) for testing; applied alongside resetPromptsPayload() in buildResetControl.
 *
 * A "don't show again" flag that is NOT listed here becomes one-way: Reset
 * Prompts cannot bring it back, and the only way out is editing the database.
 * That trap is already documented for PortChangeModal; `adminScopeBannerDismissed`
 * (item 81) joins the list for the same reason.
 */
export function resetPromptSettingsPayload(): Record<string, boolean | null> {
    return {
        serviceFirstRunSeen: false,
        bookmarkDismissedForPort: null,
        bookmarkDismissedGlobally: false,
        adminScopeBannerDismissed: false,
    };
}

/**
 * Gate the Server tab's "stop server & exit" button by service mode. When a
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
 * Derive visibility/enabled state for the two Linux-only Server-tab rows —
 * "install for all users" and "uninstall ws-scrcpy-web". Pure (no DOM) so it is
 * unit-testable; mirrors stopServerButtonState's shape and is driven from the
 * Service tab's /api/service/status response.
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
    /** True when the server reports container mode. Both install-lifecycle rows
     *  are hidden then: "install for all users" POSTs a route that runs pkexec,
     *  relocates the app to /opt and re-execs — a container has no polkit and
     *  relocating inside the image is meaningless — and "uninstall" tears down a
     *  service and an install that do not exist there. The container's
     *  equivalent is `docker rm`, and its lifecycle belongs to docker, not to
     *  the app (findings 20.4 and 20.5). Task 5 gated Settings → Service and
     *  Settings → Updates the same way; the Server section was missed. */
    docker?: boolean | undefined;
}): {
    showInstallAllUsers: boolean;
    installAllUsersDisabled: boolean;
    installAllUsersNote: string | null;
    showUninstall: boolean;
} {
    const linux = resp.platform === 'linux';
    const machineWide = resp.machineWideInstalled === true;
    const container = resp.docker === true;
    return {
        showInstallAllUsers: linux && !container,
        installAllUsersDisabled: linux && machineWide,
        installAllUsersNote: linux && machineWide ? 'already installed for all users (/opt)' : null,
        showUninstall: (linux || resp.platform === 'win32') && !container,
    };
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
 *
 * An ACTION, deliberately not staged: it destroys data the moment it is
 * confirmed, so there is nothing for a later Save to apply.
 *
 * `sendFirstRunReset` is asked at click time, not build time, because container
 * mode is only known after the tab is built. It answers false in a container:
 * there is no first-run to go back to (the image is the install, and the server
 * refuses the field), so the per-user reset is sent alone.
 */
export function buildResetControl(opts: {
    reload: () => void;
    sendFirstRunReset?: () => boolean;
    /** The Settings dialog's `askChild`; unbound when the row is built on its own. */
    askChild?: AskChild;
}): {
    button: HTMLButtonElement;
} {
    const askChild = opts.askChild ?? askUnbound;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'settings-btn settings-btn-primary';
    button.textContent = 'reset';

    button.addEventListener('click', () => {
        void (async () => {
            const confirmed = await askChild(() => ResetConfirmModal.confirm(), false);
            if (!confirmed) return;
            // Full user-settings reset: all user_settings + device_labels +
            // device_settings via settingsService.reset(); and firstRunComplete
            // → /api/config (boot-trio field, re-triggers first-run on reload).
            // Both fire-and-forget; the page reload re-reads both endpoints.
            const sendFirstRunReset = opts.sendFirstRunReset?.() ?? true;
            await Promise.all([
                settingsService.reset().catch(() => undefined),
                sendFirstRunReset
                    ? fetch('/api/config', {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(resetPromptsPayload()),
                      }).catch(() => undefined)
                    : undefined,
            ]);
            opts.reload();
        })();
    });

    return { button };
}

/**
 * Build the Linux-only "install for all users" control: an "install" button
 * plus its full-width status note. Clicking POSTs /api/service/install-system-wide
 * (the server runs pkexec, relocates to /opt, and re-execs — the OS pkexec prompt
 * IS the confirmation, so there is no extra modal); on success the server is
 * about to re-exec, so the page reloads; on failure the note shows an inline
 * error. `reload` is injected so the unit test can observe it without navigating.
 * Self-contained DOM + wiring (no network until clicked) so it is unit-testable.
 * Show/hide + the machine-wide disabled+note state are applied separately via
 * appSectionButtonsState, from `applyServerServiceStatus` below.
 *
 * Lives here rather than in ServiceTab.ts: its only call site is this tab's
 * "install for all users" row. Task 7 filed it under Service in error.
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
                // A cancelled polkit prompt is a decline, not a failure (smoke 14.10).
                note.textContent = (await isElevationDeclined(res))
                    ? reasonToUserMessage('uac-declined', '')
                    : 'install failed — see the server logs and try again.';
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
 *
 * Lives here rather than in ServiceTab.ts for the same reason as
 * buildInstallAllUsersControl: this tab's uninstall row is its only caller.
 *
 * `platform` is read at click time, because the tab builds this row before the
 * /api/service/status response that carries the platform arrives. The modal
 * uses it for its Windows-only note about the kept certificate authority.
 */
export function buildUninstallControl(opts: {
    onUninstalled: () => void;
    platform?: () => NodeJS.Platform | undefined;
    /** The Settings dialog's `askChild`; unbound when the row is built on its own. */
    askChild?: AskChild;
}): {
    button: HTMLButtonElement;
} {
    const askChild = opts.askChild ?? askUnbound;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'settings-btn settings-btn-danger';
    button.textContent = 'uninstall…';

    button.addEventListener('click', () => {
        void (async () => {
            const r = await askChild(() => UninstallConfirmModal.confirm({ platform: opts.platform?.() }), {
                confirmed: false,
                keep: true,
            });
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

/** Blank the page with a centered "app stopped" notice (window.close fallback). */
function showAppStoppedOverlay(): void {
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
function showUninstalledOverlay(): void {
    const overlay = document.createElement('div');
    overlay.style.cssText =
        'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
        'padding:1rem;text-align:center;opacity:0.85;';
    const msg = document.createElement('p');
    msg.textContent = appUninstallStartedMessage();
    overlay.appendChild(msg);
    document.body.replaceChildren(overlay);
}

/**
 * Confirm, then POST /api/server/shutdown (graceful teardown + exit 0),
 * then try to self-close the tab. Falls back to a full-page "app stopped"
 * notice when the browser blocks window.close() (tabs not opened by script).
 */
async function onStopServerExit(btn: HTMLButtonElement, askChild: AskChild): Promise<void> {
    const confirmed = await askChild(
        () =>
            ConfirmModal.confirm({
                title: 'stop server & exit',
                message:
                    'the app will shut down and this browser tab will try to close. ' +
                    'any active device connections will end. continue?',
            }),
        false,
    );
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
    showAppStoppedOverlay();
}

/**
 * Per-instance re-entry points, keyed by the section `buildServerTab` returned.
 * Same shape — and the same reason — as ServiceTab.ts's `refreshers`:
 * `SettingsModal` builds every tab eagerly, then decides LATER when to fire the
 * /api/config read, and separately learns the /api/service/status response the
 * Service tab fetched. These maps are what let it drive a specific tab's
 * internals from outside without `buildServerTab` returning anything other than
 * the `HTMLElement` its signature promises.
 */
const refreshers = new WeakMap<HTMLElement, () => Promise<void>>();
const httpsRefreshers = new WeakMap<HTMLElement, () => Promise<void>>();
const serviceStatusAppliers = new WeakMap<HTMLElement, (resp: ServiceStatusResponse) => void>();
const containerModeAppliers = new WeakMap<HTMLElement, () => void>();
const hostModeAppliers = new WeakMap<HTMLElement, () => void>();

/**
 * The Server tab — the consolidated app/server section (beta.62 folded the old
 * standalone "App" section into it).
 *
 * The http port is the first STAGED field in Settings: editing it calls
 * `store.set('webPort', …)` and nothing else. There is no per-field Save button
 * any more — the dialog's Save collects every staged change and sends one batch
 * to POST /api/settings/batch, which owns the restart and the redirect a port
 * change triggers. The https port, right below it, is staged the same way
 * (`httpsPort`); it moved here from the Local HTTPS tab, where it had its own
 * "ok" button, and it stays disabled until mkcert is installed and a
 * certificate exists (`refreshServerHttps`). Everything else here is an ACTION (reset, change password,
 * log out, install for all users, stop & exit, uninstall): each fires
 * immediately on click and registers nothing with `store`, so none of them can
 * reach the change summary.
 *
 * Builds synchronously and fires no network request of its own. The current port
 * arrives via the externally-triggered `refreshServer()`, and the two
 * service-mode-dependent rows via `applyServerServiceStatus()` — both gated in
 * `SettingsModal` on decisions (role, admin reachability, container mode) that
 * resolve only after every tab has already been built.
 *
 * Local HTTPS is no longer part of this tab: since 0.5.3 it is its own tab,
 * right after this one (LocalHttpsTab.ts).
 */
export function buildServerTab(ctx: TabContext, store: StagedSettingsStore): HTMLElement {
    const { section, body } = buildSection('Server');

    // Replaces the instance fields `SettingsModal` held for this section
    // (`this.webPortInput`, `this.stopServerButton`, …). Each stays null when its
    // row was never built (role-gated out), and every consumer below guards on
    // that exactly as the old `if (this.x)` checks did.
    let webPortInput: HTMLInputElement | null = null;
    let webPortRow: HTMLElement | null = null;
    let webPortStatus: HTMLElement | null = null;
    let httpsPortInput: HTMLInputElement | null = null;
    let httpsPortRow: HTMLElement | null = null;
    let httpsPortStatus: HTMLElement | null = null;
    let httpsPortGateNote: HTMLElement | null = null;
    let httpsPortPrivilegeNotice: HTMLElement | null = null;
    let portRestartNote: HTMLElement | null = null;
    // What the https port's gate was last told (refreshServerHttps). Starts
    // closed: until /api/tls/state has said a certificate exists, there is
    // nothing for the port to apply to.
    let httpsMkcertInstalled: boolean | null = null;
    let httpsCertReady = false;
    // Bumped by every https read, so a slow earlier read cannot overwrite a newer one.
    let httpsReadSeq = 0;
    // Which row's status line currently shows PORT_COLLISION_ERROR (M9): when
    // the other row moves off the shared value, that row is re-staged.
    let httpCollision = false;
    let httpsCollision = false;
    // Set once SettingsModal has learned this is a host (applyServerHostMode):
    // until then the port rows stay hidden, so none of their copy flashes in a
    // container before the probe answers.
    let hostMode = false;
    let stopServerButton: HTMLButtonElement | null = null;
    let stopServerNote: HTMLElement | null = null;
    let installAllUsersRow: HTMLElement | null = null;
    let installAllUsersButton: HTMLButtonElement | null = null;
    let installAllUsersNote: HTMLElement | null = null;
    let uninstallRow: HTMLElement | null = null;
    let uninstallButton: HTMLButtonElement | null = null;
    // Set by applyContainerMode. Read at click time by the reset control, which
    // is built before container mode is known.
    let containerMode = false;
    // Set by applyServiceStatus. Read at click time by the uninstall control,
    // for the same reason.
    let servicePlatform: NodeJS.Platform | undefined;

    // 1. reset all my settings — user-level, always visible. Opens
    //    ResetConfirmModal, then clears all user settings (theme, device
    //    names, per-device stream/audio prefs, icon size, scan subnets,
    //    dismissed prompts) and reloads so first-run re-triggers and all
    //    prefs are read fresh. In a container only the per-user half is sent.
    const reset = buildResetControl({
        reload: () => ctx.reload(),
        sendFirstRunReset: () => !containerMode,
        askChild: ctx.askChild,
    });
    body.appendChild(buildRow('reset all my settings', reset.button));

    // 1b. change password — user-level, only shown when auth is enabled
    //     (in open mode there is no password to change). Reveals an inline
    //     form with current + new password inputs, each with an eye toggle.
    //     On save → authClient.changePassword(); on success collapse the form;
    //     on failure show inline status. Never throws.
    if (ctx.authEnabled) {
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
                if (!curInput.value || !newInput.value) {
                    cpStatus.textContent = 'enter your current and new password';
                    cpStatus.hidden = false;
                    return;
                }
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
        body.appendChild(buildRow('password', cpControl));
        body.appendChild(cpStatus);

        // Logout — user-level, only when authEnabled (you're only logged in when
        // auth is enabled). Placed adjacent to change-password. Not admin-gated.
        const logoutStatus = document.createElement('p');
        logoutStatus.className = 'settings-status';
        logoutStatus.style.gridColumn = '1 / -1';
        logoutStatus.hidden = true;

        const logoutBtn = document.createElement('button');
        logoutBtn.type = 'button';
        logoutBtn.className = 'modal-button';
        logoutBtn.textContent = 'log out';
        logoutBtn.setAttribute('data-action', 'logout');
        logoutBtn.addEventListener('click', () => {
            void (async () => {
                try {
                    await authClient.logout();
                } catch {
                    logoutStatus.textContent = 'logout request failed — reloading anyway.';
                    logoutStatus.hidden = false;
                }
                ctx.reload();
            })();
        });
        body.appendChild(buildRow('session', logoutBtn));
        body.appendChild(logoutStatus);
    }

    // 2–5 below are admin-only. Skip building + storing them entirely for
    //    non-admin users so no DOM or ref is created. The external re-entry
    //    points (refreshServer, applyServerServiceStatus) are null-safe on every
    //    ref above — they guard with `if (!x) return;`.
    if (canSeeSection(ctx.role, 'webPort')) {
        // 2. http port — a number input, and nothing else. Editing it STAGES the
        //    value; the dialog's Save sends the whole batch. The status line below
        //    the row is empty at rest and carries either a read error or the
        //    range message below — the save states it used to show ("saving…",
        //    "restarting → redirecting…", "no change.") left with the button that
        //    produced them.
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '1024';
        input.max = '65535';
        input.className = 'settings-input';
        input.style.maxWidth = '120px';
        // The range guard `onSavePort` used to run, re-homed onto the stage
        // rather than the save (`commitHttpPort`). `min`/`max` above are
        // advisory: nothing enforces them outside a validating form submit.
        input.addEventListener('change', () => commitHttpPort());
        webPortInput = input;

        // Registered with a null baseline because the real port is not knowable
        // synchronously — every tab is built before the /api/config read that
        // `refreshServer()` performs. That read re-registers the field with the
        // true value (see runRefresh), which is what stops the unknown → 8000
        // fill-in from being reported as a change the user never made.
        store.register({ id: WEB_PORT_ID, label: WEB_PORT_LABEL, initial: null });

        webPortRow = buildRow('http port', input);
        labelInputByRow(webPortRow, input);
        body.appendChild(webPortRow);

        const status = document.createElement('p');
        status.className = 'settings-status';
        status.style.gridColumn = '1 / -1';
        status.id = nextPortDomId();
        status.hidden = true;
        webPortStatus = status;
        body.appendChild(status);

        // 2b. https port — the port the Local HTTPS listener binds. Staged like
        //     the http port (`httpsPort`, saved by the dialog's Save), with the
        //     server's range (1-65535: it is not held to the http port's 1024
        //     floor). Editable once a certificate exists and mkcert is installed
        //     or its state cannot be told (user decision): before that there is
        //     no listener for it to move, and the note below says what to do.
        const httpsInput = document.createElement('input');
        httpsInput.type = 'number';
        httpsInput.min = '1';
        httpsInput.max = '65535';
        httpsInput.className = 'settings-input';
        httpsInput.style.maxWidth = '120px';
        httpsInput.setAttribute('data-tls-port', '');
        httpsInput.disabled = true;
        httpsInput.addEventListener('input', () => updateHttpsPrivilegeNotice());
        httpsInput.addEventListener('change', () => commitHttpsPort());
        httpsPortInput = httpsInput;
        // A null baseline for the same reason as the http port: the configured
        // port arrives later, on the /api/tls/state read refreshServerHttps makes.
        store.register({ id: HTTPS_PORT_ID, label: HTTPS_PORT_LABEL, initial: null });

        httpsPortRow = buildRow('https port', httpsInput);
        labelInputByRow(httpsPortRow, httpsInput);
        body.appendChild(httpsPortRow);

        const httpsStatus = document.createElement('p');
        httpsStatus.className = 'settings-status';
        httpsStatus.style.gridColumn = '1 / -1';
        httpsStatus.id = nextPortDomId();
        httpsStatus.setAttribute('data-https-port-status', '');
        httpsStatus.hidden = true;
        httpsPortStatus = httpsStatus;
        body.appendChild(httpsStatus);

        const gateNote = document.createElement('p');
        gateNote.className = 'settings-status';
        gateNote.style.gridColumn = '1 / -1';
        gateNote.id = nextPortDomId();
        gateNote.setAttribute('data-https-port-gate-note', '');
        gateNote.textContent = HTTPS_PORT_GATE_NOTE;
        gateNote.hidden = true;
        httpsPortGateNote = gateNote;
        body.appendChild(gateNote);

        // Notification 5, moved here with the port it is about.
        const privilegeNotice = document.createElement('p');
        privilegeNotice.className = 'settings-status settings-status-warning';
        privilegeNotice.style.gridColumn = '1 / -1';
        privilegeNotice.id = nextPortDomId();
        privilegeNotice.setAttribute('data-tls-port-notice', '');
        privilegeNotice.hidden = true;
        httpsPortPrivilegeNotice = privilegeNotice;
        body.appendChild(privilegeNotice);

        // Below both rows: either port's save restarts the server
        // (SettingsBatchApi schedules one restart for a moved http port, a moved
        // https port, or both). Shown whenever the rows are.
        const restartNote = document.createElement('p');
        restartNote.className = 'settings-status';
        restartNote.style.gridColumn = '1 / -1';
        restartNote.id = nextPortDomId();
        restartNote.setAttribute('data-port-restart-note', '');
        restartNote.textContent = PORT_RESTART_NOTE;
        portRestartNote = restartNote;
        body.appendChild(restartNote);

        // Hidden until the host/container probe has answered (applyHostMode /
        // applyContainerMode), so a container never shows any of it, even for
        // the moment before the probe resolves (M6).
        for (const row of [webPortRow, httpsPortRow]) row.style.display = 'none';
        restartNote.hidden = true;
        updatePortDescriptions();
    }

    if (canSeeSection(ctx.role, 'serverControls')) {
        // 3. install for all users (Linux-only) — hidden until
        //    applyServerServiceStatus reveals it on Linux. POSTs
        //    /api/service/install-system-wide (pkexec → /opt → re-exec); the OS
        //    pkexec dialog is the confirmation, so on success just reload.
        const install = buildInstallAllUsersControl({ reload: () => ctx.reload() });
        installAllUsersButton = install.button;
        installAllUsersNote = install.note;
        const installRow = buildRow('install for all users', install.button);
        installRow.style.display = 'none';
        installAllUsersRow = installRow;
        body.appendChild(installRow);
        body.appendChild(install.note);

        // 4. stop the server and close the app — §27 graceful shutdown (exit 0,
        //    the launcher supervisor will NOT restart it). Gated off in service
        //    mode by applyServerServiceStatus once /api/service/status resolves.
        const stopBtn = document.createElement('button');
        stopBtn.type = 'button';
        stopBtn.className = 'settings-btn settings-btn-primary';
        stopBtn.textContent = 'stop server & exit';
        stopBtn.addEventListener('click', () => void onStopServerExit(stopBtn, ctx.askChild));
        stopServerButton = stopBtn;
        body.appendChild(buildRow('stop the server and close the app', stopBtn));

        const stopNote = document.createElement('p');
        stopNote.className = 'settings-status';
        stopNote.style.gridColumn = '1 / -1';
        stopNote.hidden = true;
        stopServerNote = stopNote;
        body.appendChild(stopNote);

        // 5. uninstall ws-scrcpy-web (Linux + win32) — hidden until revealed.
        //    Always enabled when shown (uninstalling is how you remove a
        //    service). Opens UninstallConfirmModal; confirm POSTs
        //    /api/service/uninstall-app { keep }.
        const uninstall = buildUninstallControl({
            onUninstalled: () => showUninstalledOverlay(),
            platform: () => servicePlatform,
            askChild: ctx.askChild,
        });
        uninstallButton = uninstall.button;
        const row = buildRow('uninstall ws-scrcpy-web', uninstall.button);
        row.style.display = 'none';
        uninstallRow = row;
        body.appendChild(row);
    }

    function setServerStatus(msg: string, isError = false): void {
        const el = webPortStatus;
        if (!el) return; // http port row not built (non-admin)
        el.textContent = msg;
        // The status line lives BELOW the http port row and is empty at rest —
        // hide it when there is no message so it doesn't reserve a blank row.
        el.hidden = msg.length === 0;
        el.classList.toggle('settings-status-error', isError);
        httpCollision = msg === PORT_COLLISION_ERROR;
        updatePortDescriptions();
    }

    /** The https port's own status line — the http port's, one row down. */
    function setHttpsStatus(msg: string, isError = false): void {
        const el = httpsPortStatus;
        if (!el) return;
        el.textContent = msg;
        el.hidden = msg.length === 0 || containerMode;
        el.classList.toggle('settings-status-error', isError);
        httpsCollision = msg === PORT_COLLISION_ERROR;
        updatePortDescriptions();
    }

    /** Each port input's description: whichever of its notes are showing (M8). */
    function updatePortDescriptions(): void {
        describeBy(webPortInput, [webPortStatus, portRestartNote]);
        describeBy(httpsPortInput, [httpsPortStatus, httpsPortGateNote, httpsPortPrivilegeNotice, portRestartNote]);
    }

    /**
     * The two listeners cannot share a port, but only while a certificate
     * exists: without one there is no https listener, and an http port of 8443
     * (the default https port) is fine, as it always was (user decision after
     * 0.5.3; the server applies the same rule, portCollision.ts).
     */
    function portsCollide(httpPort: unknown, httpsPort: unknown): boolean {
        return httpsCertReady && typeof httpPort === 'number' && httpPort === httpsPort;
    }

    /**
     * Stage the http box's value, or say why not. `Number` + `isInteger`, NOT
     * `parseInt`, so the test is the one `validateField` applies: `parseInt`
     * TRUNCATES ('8010.5' would stage 8010), while `Number` gives NaN for junk
     * and 0 for an emptied field, and both fail. A refused value stages nothing:
     * whatever was last staged stands, and the message stays up until a valid
     * port replaces it. Returns whether it staged.
     */
    function commitHttpPort(): boolean {
        const input = webPortInput;
        if (!input) return false;
        const port = Number(input.value);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
            setServerStatus('port must be between 1024 and 65535', true);
            return false;
        }
        // Compared with the https port as staged, so a pair of edits that swap
        // the ports is judged on the result.
        if (portsCollide(port, store.get(HTTPS_PORT_ID))) {
            setServerStatus(PORT_COLLISION_ERROR, true);
            return false;
        }
        setServerStatus('');
        store.set(WEB_PORT_ID, port);
        // M9: the https row was refused for sitting on this row's old value;
        // now that this one moved, stage what it holds without a re-edit.
        if (httpsCollision && httpsPortInput && !httpsPortInput.disabled) commitHttpsPort();
        return true;
    }

    /** As `commitHttpPort`, for the https box, with `validateHttpsPortInput`'s bounds (Config.ts). */
    function commitHttpsPort(): boolean {
        const input = httpsPortInput;
        if (!input) return false;
        const port = Number(input.value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            setHttpsStatus('port must be between 1 and 65535', true);
            return false;
        }
        if (portsCollide(store.get(WEB_PORT_ID), port)) {
            setHttpsStatus(PORT_COLLISION_ERROR, true);
            return false;
        }
        setHttpsStatus('');
        store.set(HTTPS_PORT_ID, port);
        if (httpCollision) commitHttpPort();
        return true;
    }

    /** Notification 5 for the value in the https box, once the platform is known. */
    function updateHttpsPrivilegeNotice(): void {
        const el = httpsPortPrivilegeNotice;
        const input = httpsPortInput;
        if (!el || !input) return;
        const text = subPrivilegedPortNotice(Number(input.value), servicePlatform);
        el.textContent = text ?? '';
        el.hidden = text === null || !hostMode;
        updatePortDescriptions();
    }

    /**
     * Is the https port usable? A certificate must exist, and mkcert must not
     * be known to be missing. An mkcert state the server cannot report (`null`)
     * does not hold the row shut on its own -- the same fail-open reading the
     * Local HTTPS tab gives that answer (`fetchMkcertInstalled`): a certificate
     * on disk is the stronger fact, and nothing re-reads mkcert until a
     * dependency install, so a read that happened to fail would otherwise
     * lock the port for the rest of the session (user decision after 0.5.3).
     */
    function httpsGateOpen(): boolean {
        return httpsCertReady && httpsMkcertInstalled !== false;
    }

    function applyHttpsGate(): void {
        const open = httpsGateOpen();
        if (httpsPortInput) httpsPortInput.disabled = !open;
        if (httpsPortGateNote) httpsPortGateNote.hidden = open || !hostMode;
        updatePortDescriptions();
    }

    /**
     * The probe says this is a host (SettingsModal's non-container path): show
     * the port rows and their notes, which are built hidden so a container
     * never flashes them (M6). Idempotent; a no-op once container mode is set.
     */
    function applyHostMode(): void {
        if (containerMode || hostMode) return;
        hostMode = true;
        if (webPortRow) webPortRow.style.display = '';
        if (httpsPortRow) httpsPortRow.style.display = '';
        if (portRestartNote) portRestartNote.hidden = false;
        applyHttpsGate();
        updateHttpsPrivilegeNotice();
    }

    /**
     * Read what the https port's gate depends on -- mkcert, from
     * /api/dependencies (the Local HTTPS tab's read), and the certificate and
     * configured port, from /api/tls/state -- and apply it. Re-run whenever
     * either can have changed (a dependency install, a generate or a revoke).
     *
     * The port is re-baselined from the server unless the user has an edit
     * staged on a row that is still open: a re-read must not throw away what
     * they typed. A staged value on a row that is closed -- the certificate
     * was revoked, or the read failed and nothing says one exists -- is
     * dropped, since a disabled box can no longer show or change what Save
     * would send (M3).
     */
    async function runHttpsRefresh(): Promise<void> {
        const input = httpsPortInput;
        if (!input || containerMode) return;
        const seq = ++httpsReadSeq;
        const [installed, tls] = await Promise.all([
            // Wrapped, not passed by reference: an unbound `fetch` throws
            // "Illegal invocation" in Chrome.
            fetchMkcertInstalled((...args: Parameters<typeof fetch>) => fetch(...args)),
            readTlsPortState(),
        ]);
        if (seq !== httpsReadSeq || containerMode) return;
        httpsMkcertInstalled = installed;
        httpsCertReady = tls.ready;
        const open = httpsGateOpen();
        const staged = store.changes().find((c) => c.id === HTTPS_PORT_ID);
        if (tls.port !== null && (!staged || !open)) {
            store.register({ id: HTTPS_PORT_ID, label: HTTPS_PORT_LABEL, initial: tls.port });
            input.value = String(tls.port);
            setHttpsStatus('');
        } else if (staged && !open) {
            // No port to re-baseline from: put the staged field back on its own baseline.
            store.set(HTTPS_PORT_ID, staged.from);
            input.value = typeof staged.from === 'number' ? String(staged.from) : '';
            setHttpsStatus('');
        } else if (!open) {
            setHttpsStatus('');
        }
        updateHttpsPrivilegeNotice();
        applyHttpsGate();
        // The equal-ports rule follows the certificate: a refusal on the http
        // row may no longer hold (or may now), so judge it again.
        if (httpCollision) commitHttpPort();
    }

    async function runRefresh(): Promise<void> {
        const input = webPortInput;
        if (!input) return; // http port row not built (non-admin)
        try {
            const r = await fetch('/api/config');
            if (!r.ok) {
                setServerStatus("couldn't reach server", true);
                return;
            }
            const env = (await r.json()) as AppConfigEnvelope;
            // Re-register rather than `set`: this is the first moment the true
            // current port is known, and it has to become the BASELINE. Leaving
            // the null placeholder as the baseline would make an untouched dialog
            // permanently dirty and push a webPort write into every batch save.
            store.register({ id: WEB_PORT_ID, label: WEB_PORT_LABEL, initial: env.config.webPort });
            input.value = String(env.config.webPort);
            // No at-rest hint: the status line below the http port row stays empty
            // unless the read itself fails.
        } catch {
            setServerStatus("couldn't reach server", true);
        }
    }

    /**
     * Apply one `appSectionButtonsState` decision to the two install-lifecycle
     * rows (an inline display overrides the `.settings-row { display: contents }`
     * rule), and record WHICH path decided on the section as
     * `data-app-rows-decided`. The rows are built hidden; the attribute is what
     * tells "decided hidden" apart from "never decided", which the container spec
     * relies on (findings 20.4, 20.5).
     */
    function applyAppRows(
        state: ReturnType<typeof appSectionButtonsState>,
        decidedBy: 'service-status' | 'container',
    ): void {
        if (installAllUsersRow) {
            installAllUsersRow.style.display = state.showInstallAllUsers ? '' : 'none';
        }
        if (installAllUsersButton) {
            installAllUsersButton.disabled = state.installAllUsersDisabled;
        }
        if (installAllUsersNote) {
            installAllUsersNote.textContent = state.installAllUsersNote ?? '';
            installAllUsersNote.hidden = state.installAllUsersNote === null;
        }
        if (uninstallRow) {
            uninstallRow.style.display = state.showUninstall ? '' : 'none';
        }
        if (uninstallButton) {
            // Uninstall is ALWAYS enabled on Linux — never gated on service mode
            // (unlike "stop server & exit"); uninstalling is how you tear a service
            // down. Asserting it here documents and enforces that invariant.
            uninstallButton.disabled = false;
        }
        section.dataset['appRowsDecided'] = decidedBy;
    }

    /**
     * Container mode's decision for the install-lifecycle rows, made explicitly.
     * A container never fetches /api/service/status (SettingsModal gates Service
     * and Updates first and returns), so `applyServiceStatus` is never reached
     * there; the rows used to stay hidden only because they are built hidden.
     * This asks `appSectionButtonsState` the question a Linux host would ask
     * (the image is Linux by construction) with `docker: true`, so removing its
     * container check would reveal the rows, and the container spec would see it.
     * "stop server & exit" is left alone: it is correct in a container (row 20.6).
     *
     * Two more container decisions live here (row 20.19):
     * - the http port row is hidden: the port inside the image is always 8000,
     *   docker's port mapping picks the one users reach, and the server refuses
     *   the field. The https port row goes with it, notes and all: Local HTTPS
     *   is not supported in a container, and the server refuses that field too;
     * - "reset all my settings" stops sending the first-run reset (see
     *   buildResetControl).
     * The third, Local HTTPS shown as a reverse-proxy note, belongs to the Local
     * HTTPS tab since 0.5.3 (LocalHttpsTab.ts's `applyLocalHttpsContainerMode`).
     */
    function applyContainerMode(): void {
        containerMode = true;
        applyAppRows(appSectionButtonsState({ platform: 'linux', docker: true }), 'container');
        if (webPortRow) webPortRow.style.display = 'none';
        if (webPortStatus) webPortStatus.hidden = true;
        if (httpsPortRow) httpsPortRow.style.display = 'none';
        for (const note of [httpsPortStatus, httpsPortGateNote, httpsPortPrivilegeNotice, portRestartNote]) {
            if (note) note.hidden = true;
        }
    }

    /**
     * Reflect the (unit-tested) stopServerButtonState and appSectionButtonsState
     * decisions onto this tab's rows, from the /api/service/status response the
     * SERVICE tab fetched (desktop and host installs; a container decides through
     * `applyContainerMode` instead). Disables "stop server & exit" with a note in
     * service mode; reveals the two Linux-only rows, disables "install for all
     * users" with an explanatory note once the machine-wide /opt install exists,
     * and keeps the uninstall row enabled whenever it is shown.
     */
    function applyServiceStatus(resp: ServiceStatusResponse): void {
        servicePlatform = resp.platform;
        // The https port's sub-1024 notice waits on the platform (M2).
        updateHttpsPrivilegeNotice();
        if (stopServerButton) {
            const stop = stopServerButtonState(resp);
            stopServerButton.disabled = stop.disabled;
            if (stopServerNote) {
                stopServerNote.textContent = stop.note ?? '';
                stopServerNote.hidden = stop.note === null;
            }
        }

        applyAppRows(appSectionButtonsState(resp), 'service-status');
    }

    refreshers.set(section, runRefresh);
    httpsRefreshers.set(section, runHttpsRefresh);
    serviceStatusAppliers.set(section, applyServiceStatus);
    containerModeAppliers.set(section, applyContainerMode);
    hostModeAppliers.set(section, applyHostMode);
    return section;
}

/**
 * Externally trigger the /api/config read for a Server tab `buildServerTab`
 * already built — it fills the http port input and baselines the staged field.
 * A no-op if `section` was never built through `buildServerTab`.
 */
export async function refreshServer(section: HTMLElement): Promise<void> {
    const run = refreshers.get(section);
    if (!run) return;
    await run();
}

/**
 * Re-read what the Server tab's https port depends on -- whether mkcert is
 * installed and whether a certificate exists -- and enable or disable the row
 * to match, prefilling it with the configured port. `SettingsModal` calls it
 * once container mode is known (never in a container), after a dependency
 * install, and after Local HTTPS generates or revokes a certificate. A no-op if
 * `section` was never built through `buildServerTab`, or has no https row.
 */
export async function refreshServerHttps(section: HTMLElement): Promise<void> {
    await httpsRefreshers.get(section)?.();
}

/**
 * Hand a Server tab the /api/service/status response the SERVICE tab fetched, so
 * the service-mode-dependent rows (stop & exit, install for all users,
 * uninstall) can react to it. A no-op if `section` was never built through
 * `buildServerTab`.
 */
export function applyServerServiceStatus(section: HTMLElement, resp: ServiceStatusResponse): void {
    const apply = serviceStatusAppliers.get(section);
    if (!apply) return;
    apply(resp);
}

/**
 * Tell a Server tab it is running in a container, so its install-lifecycle rows
 * are hidden by an explicit container decision rather than left at their built
 * default (findings 20.4, 20.5). SettingsModal's container branch calls this in
 * place of the service-status path. A no-op if `section` was never built through
 * `buildServerTab`.
 */
export function applyServerContainerMode(section: HTMLElement): void {
    containerModeAppliers.get(section)?.();
}

/**
 * Tell a Server tab it is on a host, not in a container: it shows its http and
 * https port rows and their notes, which are built hidden so that none of them
 * flashes in a container before the probe answers. SettingsModal calls it on
 * its non-container path, before `refreshServerHttps`. A no-op if `section`
 * was never built through `buildServerTab`, or after container mode.
 */
export function applyServerHostMode(section: HTMLElement): void {
    hostModeAppliers.get(section)?.();
}
