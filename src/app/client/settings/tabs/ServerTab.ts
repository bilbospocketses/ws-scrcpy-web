import type { AppConfigEnvelope } from '../../../../common/ConfigEvents';
import type { ServiceStatusResponse } from '../../../../common/ServiceEvents';
import { authClient } from '../../AuthClient';
import { canSeeSection } from '../../adminGate';
import { ConfirmModal } from '../../ConfirmModal';
import { ResetConfirmModal } from '../../ResetConfirmModal';
import { settingsService } from '../../SettingsService';
import { UninstallConfirmModal } from '../../UninstallConfirmModal';
import type { StagedSettingsStore } from '../StagedSettingsStore';
import type { TabContext } from './EmbeddingTab';
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

/** The staged-field id and summary label for the web port — one definition, so
 *  the build-time registration and the post-read re-baseline cannot disagree. */
const WEB_PORT_ID = 'webPort';
const WEB_PORT_LABEL = 'Web port';

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

// ---------------------------------------------------------------------------
// Local HTTPS panel (Settings → Server → Local HTTPS).
//
// Consumes GET /api/tls/state, POST /api/tls/generate and GET /api/tls/ca-root
// exactly as Task 5's TlsApi.ts implements them (see the response-shape
// contract appended to this task's brief, dated 2026-09-19): `generate`
// answers `{ ...CertState, allowedHostAdded }`, `state` answers
// `{ ...CertState, candidateIps }`, and `ca-root` answers 404/429 with a JSON
// `{ error }` body read verbatim rather than assumed.
//
// NOT wired to a save/persist path for the port field or the exposure radios
// -- see the two "NOT WIRED" comments below for why, and the task-8 report for
// the follow-up this leaves for a later task.
// ---------------------------------------------------------------------------

/** The subset of CertState (+ the two additions layered on by Task 4/5) this panel reads. */
interface TlsCertState {
    status: 'none' | 'ready';
    subject?: string;
    kind?: 'ip' | 'hostname';
    /** ISO 8601. */
    notAfter?: string;
    caPresent?: boolean;
    /** Present on GET /api/tls/state; absent on POST /api/tls/generate's response. */
    candidateIps?: string[];
}

export interface LocalHttpsPanelDeps {
    /** Injected so the panel is testable without a real network stack. */
    fetchFn: typeof fetch;
    /**
     * Fallback candidate IPs, used only when the fetched state carries none
     * (e.g. a test stub that never set `candidateIps` on its response body).
     * Production always gets a real list back from `GET /api/tls/state`
     * (Task 5's amendment (b)), so this is effectively test-only there.
     */
    candidateIps: string[];
    platform: NodeJS.Platform;
    /**
     * Whether the browser's current origin already trusts the served
     * certificate's CA. There is no JS-observable signal for this -- a
     * click-through self-signed warning and a genuinely trusted CA both
     * report `isSecureContext: true` with nothing else distinguishing them
     * (the design doc's own measurement had to be done manually in a real
     * browser). So this is caller-supplied, and left `undefined` (never
     * shown) rather than guessed -- showing "this browser does not trust the
     * certificate" when it actually does would be a false claim, which is
     * worse than the notice never firing. Defaults to trusted (no notice).
     */
    caTrusted?: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const EXPIRY_WARNING_DAYS = 30;

/** Notification 4: the cert's IP subject no longer matches any local interface. */
export function certSubjectMismatchNotice(state: TlsCertState, candidateIps: string[]): string | null {
    if (state.status !== 'ready' || state.kind !== 'ip' || !state.subject) return null;
    if (candidateIps.includes(state.subject)) return null;
    return `this certificate names ${state.subject}, which is no longer an address of this machine. regenerate, or switch to a hostname.`;
}

/** Notification 9: warn inside 30 days of expiry; never regenerate silently (Resolved Decision 1). */
export function certExpiryNotice(state: TlsCertState, now: Date): string | null {
    if (state.status !== 'ready' || !state.notAfter) return null;
    const expires = new Date(state.notAfter);
    if (Number.isNaN(expires.getTime())) return null;
    const daysLeft = (expires.getTime() - now.getTime()) / MS_PER_DAY;
    if (daysLeft > EXPIRY_WARNING_DAYS) return null;
    return `this certificate expires on ${expires.toLocaleDateString()}. regenerate before then, or streaming stops working from other machines.`;
}

/** Notification 5: a sub-1024 port needs elevated privileges outside win32. */
export function subPrivilegedPortNotice(port: number, platform: NodeJS.Platform | string): string | null {
    if (platform === 'win32') return null;
    if (!Number.isFinite(port) || port <= 0 || port >= 1024) return null;
    return 'ports below 1024 need elevated privileges on this platform; the server may fail to start.';
}

/** Per-OS trust instructions for the accordion. Pure/exported so its text is unit-testable. */
export function trustInstructionsFor(platform: NodeJS.Platform | string): string {
    switch (platform) {
        case 'win32':
            return (
                'double-click the downloaded file, choose "install certificate", pick "local machine" ' +
                '(admin) or "current user", select "place all certificates in the following store", ' +
                'choose "trusted root certification authorities", then finish.'
            );
        case 'darwin':
            return (
                'open keychain access, drag the downloaded file into the "system" keychain, double-click ' +
                'it, expand "trust", and set "when using this certificate" to "always trust".'
            );
        case 'linux':
            return (
                'copy the downloaded file into /usr/local/share/ca-certificates/ (renamed to end in .crt) ' +
                'and run "sudo update-ca-certificates", or import it into your browser\'s certificate settings directly.'
            );
        default:
            return "import the downloaded certificate into your browser or operating system's trusted root store.";
    }
}

/** Local copy of the notice-row shape every other tab already uses for a status line. */
function buildNoticeRow(): HTMLParagraphElement {
    const p = document.createElement('p');
    p.className = 'settings-status settings-status-warning';
    p.style.gridColumn = '1 / -1';
    p.hidden = true;
    return p;
}

function setNotice(el: HTMLParagraphElement, text: string | null): void {
    el.textContent = text ?? '';
    el.hidden = text === null;
}

async function fetchTlsState(fetchFn: typeof fetch): Promise<TlsCertState> {
    try {
        const res = await fetchFn('/api/tls/state');
        if (!res.ok) return { status: 'none' };
        return (await res.json()) as TlsCertState;
    } catch {
        return { status: 'none' };
    }
}

/**
 * Build the Local HTTPS panel — a self-contained `<section>` covering subject
 * generation, the CA download + per-OS trust instructions, and the plain-HTTP
 * exposure radios. Async: it fetches `/api/tls/state` before returning so the
 * caller (and every test) gets a panel already reflecting the real cert state,
 * rather than a placeholder that fills in later.
 *
 * Deliberately does NOT touch `StagedSettingsStore`. Two controls here look
 * like they should stage into the dialog's batch Save the way `webPort` does,
 * and both are NOT wired that way on purpose:
 *
 * - The port field: `SettingsBatchApi.STAGEABLE_IDS` (an ALLOWLIST) has no
 *   `httpsPort` entry, and `POST /api/tls/generate` itself accepts only
 *   `{ kind, value }` -- no port. Registering it with `store` anyway would
 *   make an UNRELATED save fail: the batch endpoint rejects the whole batch
 *   on any single unknown id, so editing this field would silently break a
 *   legitimate `webPort` change bundled in the same Save. It is local-preview
 *   only (notification 5) until a real endpoint exists.
 * - The exposure "ok" button: Task 8's own Interfaces line lists exactly three
 *   consumed routes (`state`, `generate`, `ca-root`) -- no exposure-writing
 *   endpoint is in scope anywhere in this plan (verified: `TlsApi.ts` has no
 *   route for it, and `HTTP_EXPOSURE_KEY` is read-only today, in
 *   `HttpServer.ts`). The button still calls `POST /api/tls/exposure` on the
 *   chance a later task adds it, and renders whatever comes back (including a
 *   graceful "not supported yet" for the 404 every build without that route
 *   returns) rather than silently doing nothing on click.
 */
export async function buildLocalHttpsPanel(deps: LocalHttpsPanelDeps): Promise<HTMLElement> {
    const initialState = await fetchTlsState(deps.fetchFn);
    let currentState: TlsCertState = initialState;
    const candidateIpsFor = (s: TlsCertState): string[] => s.candidateIps ?? deps.candidateIps;

    const { section, body } = buildSection('Local HTTPS');

    // ---- subject: ip vs hostname, and the value itself ----
    const subjectInput = document.createElement('input');
    subjectInput.type = 'text';
    subjectInput.className = 'settings-input';
    subjectInput.setAttribute('data-tls-subject', '');

    const ipLabel = document.createElement('label');
    ipLabel.className = 'settings-radio-label';
    const ipRadio = document.createElement('input');
    ipRadio.type = 'radio';
    ipRadio.name = 'tls-subject-kind';
    ipRadio.value = 'ip';
    ipLabel.appendChild(ipRadio);
    ipLabel.appendChild(document.createTextNode('ip address'));

    const hostLabel = document.createElement('label');
    hostLabel.className = 'settings-radio-label';
    const hostRadio = document.createElement('input');
    hostRadio.type = 'radio';
    hostRadio.name = 'tls-subject-kind';
    hostRadio.value = 'hostname';
    hostLabel.appendChild(hostRadio);
    hostLabel.appendChild(document.createTextNode('hostname'));

    const initialCandidateIps = candidateIpsFor(initialState);
    const initialKind: 'ip' | 'hostname' = initialState.kind === 'hostname' ? 'hostname' : 'ip';
    ipRadio.checked = initialKind === 'ip';
    hostRadio.checked = initialKind === 'hostname';
    subjectInput.value = initialState.subject ?? (initialKind === 'ip' ? (initialCandidateIps[0] ?? '') : '');

    // Remembers each mode's last value across a radio flip, so switching kind
    // and back doesn't lose what was typed.
    let lastIpValue = initialKind === 'ip' ? subjectInput.value : (initialCandidateIps[0] ?? '');
    let lastHostValue = initialKind === 'hostname' ? subjectInput.value : '';
    // 'click', not 'change': a radio's activation behavior (flipping
    // `.checked`) runs before the click is dispatched, but jsdom only fires
    // 'change' for a radio connected to `document` -- a panel this test
    // suite builds and inspects standalone never is. 'click' fires either
    // way, and `.checked` already reflects the click by the time this runs
    // (measured in both jsdom and real browsers).
    ipRadio.addEventListener('click', () => {
        if (!ipRadio.checked) return;
        lastHostValue = subjectInput.value;
        subjectInput.value = lastIpValue;
    });
    hostRadio.addEventListener('click', () => {
        if (!hostRadio.checked) return;
        lastIpValue = subjectInput.value;
        subjectInput.value = lastHostValue;
    });

    const subjectFrag = document.createDocumentFragment();
    subjectFrag.appendChild(ipLabel);
    subjectFrag.appendChild(hostLabel);
    subjectFrag.appendChild(subjectInput);
    body.appendChild(buildRow('certificate subject', subjectFrag));

    // Notification 2 — ALWAYS shown, beside the subject controls (not
    // conditional on anything: it is a standing fact about allowedHosts, not
    // a mistake state).
    const allowedHostsNotice = document.createElement('p');
    allowedHostsNotice.className = 'settings-status';
    allowedHostsNotice.style.gridColumn = '1 / -1';
    allowedHostsNotice.textContent =
        'allowedHosts takes domain names only. raw ip addresses already work, and it does not affect streaming.';
    body.appendChild(allowedHostsNotice);

    // ---- port (local preview only -- see the class doc's "NOT WIRED" note) ----
    const portInput = document.createElement('input');
    portInput.type = 'number';
    portInput.className = 'settings-input';
    portInput.style.maxWidth = '120px';
    portInput.setAttribute('data-tls-port', '');
    portInput.value = '8443';
    body.appendChild(buildRow('https port', portInput));

    const portNotice = buildNoticeRow();
    body.appendChild(portNotice);
    portInput.addEventListener('input', () => {
        setNotice(portNotice, subPrivilegedPortNotice(Number(portInput.value), deps.platform));
    });

    // ---- generate ----
    const generateBtn = document.createElement('button');
    generateBtn.type = 'button';
    generateBtn.className = 'settings-btn settings-btn-primary';
    generateBtn.textContent = 'generate';
    body.appendChild(buildRow('certificate', generateBtn));

    const generateStatus = buildNoticeRow();
    body.appendChild(generateStatus);

    const allowedHostAddedNotice = document.createElement('p');
    allowedHostAddedNotice.className = 'settings-status';
    allowedHostAddedNotice.style.gridColumn = '1 / -1';
    allowedHostAddedNotice.hidden = true;
    body.appendChild(allowedHostAddedNotice);

    // ---- current-certificate summary + notifications 3, 4, 8, 9 ----
    const certSummary = document.createElement('p');
    certSummary.className = 'settings-status';
    certSummary.style.gridColumn = '1 / -1';
    body.appendChild(certSummary);

    const untrustedCaNotice = buildNoticeRow();
    body.appendChild(untrustedCaNotice);
    const mismatchNotice = buildNoticeRow();
    body.appendChild(mismatchNotice);
    const hostnameGuideNotice = buildNoticeRow();
    body.appendChild(hostnameGuideNotice);
    const expiryNotice = buildNoticeRow();
    body.appendChild(expiryNotice);
    const caRestoreNotice = buildNoticeRow();
    body.appendChild(caRestoreNotice);

    // ---- download CA + per-OS trust instructions ----
    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'settings-btn';
    downloadBtn.textContent = 'download ca certificate';
    body.appendChild(buildRow('root ca', downloadBtn));

    const downloadStatus = buildNoticeRow();
    body.appendChild(downloadStatus);

    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'how to trust this certificate on this device';
    details.appendChild(summary);
    const instructions = document.createElement('p');
    instructions.className = 'settings-status';
    instructions.textContent = trustInstructionsFor(deps.platform);
    details.appendChild(instructions);
    const detailsRow = buildRow('trust the ca', details);
    detailsRow.style.gridColumn = '1 / -1';
    body.appendChild(detailsRow);

    function renderCertState(state: TlsCertState): void {
        const candidateIps = candidateIpsFor(state);
        if (state.status !== 'ready') {
            certSummary.textContent = 'no certificate yet.';
            downloadBtn.disabled = true;
            setNotice(untrustedCaNotice, null);
            setNotice(mismatchNotice, null);
            setNotice(hostnameGuideNotice, null);
            setNotice(expiryNotice, null);
            setNotice(caRestoreNotice, null);
            return;
        }

        // Built from text nodes, never innerHTML/string interpolation into
        // markup — `subject` is server round-tripped user input (test:
        // "uses textContent for the subject").
        certSummary.textContent = '';
        certSummary.appendChild(document.createTextNode('current certificate: '));
        const subjectSpan = document.createElement('span');
        subjectSpan.textContent = state.subject ?? '(unknown)';
        certSummary.appendChild(subjectSpan);

        downloadBtn.disabled = state.caPresent === false;
        setNotice(caRestoreNotice, state.caPresent === false ? 'regenerate to restore the ca download.' : null);
        setNotice(
            untrustedCaNotice,
            deps.caTrusted === false
                ? 'this browser does not trust the certificate yet. install the ca below to remove the warning — streaming already works.'
                : null,
        );
        setNotice(mismatchNotice, certSubjectMismatchNotice(state, candidateIps));
        setNotice(
            hostnameGuideNotice,
            state.kind === 'hostname'
                ? 'this name must resolve on every machine that connects — add it to their hosts file or your local dns.'
                : null,
        );
        setNotice(expiryNotice, certExpiryNotice(state, new Date()));
    }

    function setAllowedHostAddedNotice(subject: string | undefined): void {
        allowedHostAddedNotice.textContent = '';
        if (!subject) {
            allowedHostAddedNotice.hidden = true;
            return;
        }
        allowedHostAddedNotice.appendChild(document.createTextNode('added '));
        const span = document.createElement('span');
        span.textContent = subject;
        allowedHostAddedNotice.appendChild(span);
        allowedHostAddedNotice.appendChild(
            document.createTextNode(' to allowedHosts so the server will answer to that name.'),
        );
        allowedHostAddedNotice.hidden = false;
    }

    generateBtn.addEventListener('click', () => {
        void (async () => {
            const kind: 'ip' | 'hostname' = hostRadio.checked ? 'hostname' : 'ip';
            const value = subjectInput.value.trim();
            if (!value) {
                setNotice(generateStatus, 'enter an ip address or hostname first.');
                return;
            }
            generateBtn.disabled = true;
            const prevText = generateBtn.textContent;
            generateBtn.textContent = 'generating…';
            setNotice(generateStatus, null);
            setAllowedHostAddedNotice(undefined);
            try {
                const res = await deps.fetchFn('/api/tls/generate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ kind, value }),
                });
                const data = (await res.json().catch(() => null)) as
                    | (TlsCertState & { allowedHostAdded?: boolean; error?: string })
                    | null;
                if (!res.ok || !data) {
                    setNotice(generateStatus, data?.error ?? 'that address could not be used for a certificate.');
                    return;
                }
                currentState = data;
                renderCertState(currentState);
                if (data.allowedHostAdded) {
                    setAllowedHostAddedNotice(data.subject);
                }
            } catch {
                setNotice(generateStatus, 'could not reach the server.');
            } finally {
                generateBtn.disabled = false;
                generateBtn.textContent = prevText;
            }
        })();
    });

    downloadBtn.addEventListener('click', () => {
        void (async () => {
            downloadBtn.disabled = true;
            setNotice(downloadStatus, null);
            try {
                const res = await deps.fetchFn('/api/tls/ca-root');
                if (!res.ok) {
                    // 404 (no cert yet) / 429 (rate limited) both answer JSON
                    // `{ error }` -- TlsApi.ts is the source of truth for the
                    // shape, read here rather than assumed.
                    const data = (await res.json().catch(() => null)) as { error?: string } | null;
                    setNotice(downloadStatus, data?.error ?? `could not download the ca certificate (${res.status}).`);
                    return;
                }
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                try {
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'ws-scrcpy-web-local-ca.pem';
                    a.click();
                } finally {
                    URL.revokeObjectURL(url);
                }
            } catch {
                setNotice(downloadStatus, 'could not reach the server.');
            } finally {
                downloadBtn.disabled = currentState.caPresent === false;
            }
        })();
    });

    // ---- plain-HTTP exposure (local preview only -- see the class doc's
    //      "NOT WIRED" note) ----
    const exposureFrag = document.createDocumentFragment();
    const exposureModes: Array<{ value: 'open' | 'httpsOnly' | 'redirect'; label: string }> = [
        { value: 'open', label: 'open (plain http answers every machine)' },
        { value: 'httpsOnly', label: 'https only' },
        { value: 'redirect', label: 'redirect http to https' },
    ];
    const exposureRadios: HTMLInputElement[] = [];
    for (const mode of exposureModes) {
        const label = document.createElement('label');
        label.className = 'settings-radio-label';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'tls-exposure';
        radio.value = mode.value;
        radio.setAttribute('data-exposure', mode.value);
        radio.checked = mode.value === 'open';
        label.appendChild(radio);
        label.appendChild(document.createTextNode(mode.label));
        exposureFrag.appendChild(label);
        exposureRadios.push(radio);
    }
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'settings-btn settings-btn-primary';
    okBtn.textContent = 'ok';
    exposureFrag.appendChild(okBtn);
    body.appendChild(buildRow('plain http exposure', exposureFrag));

    const exposureLockoutNotice = buildNoticeRow();
    body.appendChild(exposureLockoutNotice);
    const exposureRestartNotice = buildNoticeRow();
    body.appendChild(exposureRestartNotice);
    const exposureSaveStatus = buildNoticeRow();
    body.appendChild(exposureSaveStatus);

    for (const radio of exposureRadios) {
        // 'click', not 'change' -- see the subject radios' listeners above for why.
        radio.addEventListener('click', () => {
            if (!radio.checked) return;
            const narrowed = radio.value !== 'open';
            // Notifications 6 and 7 — shown together, BEFORE confirm, the
            // moment a narrowed mode is selected.
            setNotice(
                exposureLockoutNotice,
                narrowed
                    ? 'plain http will stop answering other machines. this machine keeps working over localhost, so you cannot lock yourself out.'
                    : null,
            );
            setNotice(
                exposureRestartNotice,
                narrowed ? 'the server will restart and any active streams will drop.' : null,
            );
        });
    }

    okBtn.addEventListener('click', () => {
        void (async () => {
            const mode = exposureRadios.find((r) => r.checked)?.value ?? 'open';
            okBtn.disabled = true;
            setNotice(exposureSaveStatus, null);
            try {
                // NOT WIRED (see the class doc): no task in this plan adds this
                // route. Calling it anyway means a build that DOES add it later
                // works with no further changes here, and one that doesn't yet
                // gets a clear, non-crashing message instead of a dead button.
                const res = await deps.fetchFn('/api/tls/exposure', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode }),
                });
                if (!res.ok) {
                    if (res.status === 404) {
                        setNotice(exposureSaveStatus, 'this server does not support saving this setting yet.');
                        return;
                    }
                    const data = (await res.json().catch(() => null)) as { error?: string } | null;
                    setNotice(
                        exposureSaveStatus,
                        data?.error ?? `could not change plain-http exposure (${res.status}).`,
                    );
                    return;
                }
            } catch {
                setNotice(exposureSaveStatus, 'could not reach the server.');
            } finally {
                okBtn.disabled = false;
            }
        })();
    });

    renderCertState(initialState);
    return section;
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
 *
 * Lives here rather than in ServiceTab.ts for the same reason as
 * buildInstallAllUsersControl: this tab's uninstall row is its only caller.
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
async function onStopServerExit(btn: HTMLButtonElement): Promise<void> {
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
const serviceStatusAppliers = new WeakMap<HTMLElement, (resp: ServiceStatusResponse) => void>();

/**
 * The Server tab — the consolidated app/server section (beta.62 folded the old
 * standalone "App" section into it).
 *
 * The web port is the first STAGED field in Settings: editing it calls
 * `store.set('webPort', …)` and nothing else. There is no per-field Save button
 * any more — the dialog's Save collects every staged change and sends one batch
 * to POST /api/settings/batch, which owns the restart and the redirect a port
 * change triggers. Everything else here is an ACTION (reset, change password,
 * log out, install for all users, stop & exit, uninstall): each fires
 * immediately on click and registers nothing with `store`, so none of them can
 * reach the change summary.
 *
 * Builds synchronously and fires no network request of its own. The current port
 * arrives via the externally-triggered `refreshServer()`, and the two
 * service-mode-dependent rows via `applyServerServiceStatus()` — both gated in
 * `SettingsModal` on decisions (role, admin reachability, container mode) that
 * resolve only after every tab has already been built.
 */
export function buildServerTab(ctx: TabContext, store: StagedSettingsStore): HTMLElement {
    const { section, body } = buildSection('Server');

    // Replaces the instance fields `SettingsModal` held for this section
    // (`this.webPortInput`, `this.stopServerButton`, …). Each stays null when its
    // row was never built (role-gated out), and every consumer below guards on
    // that exactly as the old `if (this.x)` checks did.
    let webPortInput: HTMLInputElement | null = null;
    let webPortStatus: HTMLElement | null = null;
    let stopServerButton: HTMLButtonElement | null = null;
    let stopServerNote: HTMLElement | null = null;
    let installAllUsersRow: HTMLElement | null = null;
    let installAllUsersButton: HTMLButtonElement | null = null;
    let installAllUsersNote: HTMLElement | null = null;
    let uninstallRow: HTMLElement | null = null;
    let uninstallButton: HTMLButtonElement | null = null;
    let localHttpsContainer: HTMLElement | null = null;
    // Built once the first real `platform` arrives via applyServiceStatus
    // (see its call below) -- platform isn't known synchronously at tab-build
    // time, same category as docker/adminReachable per TabContext's own doc.
    let localHttpsBuilt = false;

    // 1. reset all my settings — user-level, always visible. Opens
    //    ResetConfirmModal, then clears all user settings (theme, device
    //    names, per-device stream/audio prefs, icon size, scan subnets,
    //    dismissed prompts) and reloads so first-run re-triggers and all
    //    prefs are read fresh.
    const reset = buildResetControl({ reload: () => ctx.reload() });
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
        // 2. web port — a number input, and nothing else. Editing it STAGES the
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
        input.addEventListener('change', () => {
            // The range guard `onSavePort` used to run, re-homed onto the stage
            // rather than the save. `min`/`max` above are advisory: nothing
            // enforces them outside a validating form submit, so an out-of-range
            // or emptied field would otherwise stage a value that
            // `Config.validateField` rejects by THROWING — which the batch
            // endpoint answers as a 400 the user never asked for.
            //
            // `Number` + `isInteger`, NOT `parseInt`, so the test here is the
            // same one `validateField` applies. `parseInt` TRUNCATES: '8010.5'
            // would stage 8010 while the field still read 8010.5, silently
            // saving a port the user never typed. `Number` gives NaN for junk
            // and 0 for an emptied field, and both fail below.
            const port = Number(input.value);
            if (!Number.isInteger(port) || port < 1024 || port > 65535) {
                // Refuse the stage: whatever was last staged stands, and the
                // message stays up until a valid port replaces it.
                setServerStatus('port must be between 1024 and 65535', true);
                return;
            }
            setServerStatus('');
            store.set(WEB_PORT_ID, port);
        });
        webPortInput = input;

        // Registered with a null baseline because the real port is not knowable
        // synchronously — every tab is built before the /api/config read that
        // `refreshServer()` performs. That read re-registers the field with the
        // true value (see runRefresh), which is what stops the unknown → 8000
        // fill-in from being reported as a change the user never made.
        store.register({ id: WEB_PORT_ID, label: WEB_PORT_LABEL, initial: null });

        body.appendChild(buildRow('web port', input));

        const status = document.createElement('p');
        status.className = 'settings-status';
        status.style.gridColumn = '1 / -1';
        status.hidden = true;
        webPortStatus = status;
        body.appendChild(status);
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
        stopBtn.addEventListener('click', () => void onStopServerExit(stopBtn));
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
        const uninstall = buildUninstallControl({ onUninstalled: () => showUninstalledOverlay() });
        uninstallButton = uninstall.button;
        const row = buildRow('uninstall ws-scrcpy-web', uninstall.button);
        row.style.display = 'none';
        uninstallRow = row;
        body.appendChild(row);
    }

    // 6. Local HTTPS — its own admin-gated section (`/api/tls/*` is
    //    admin-gated server-side; an ungated panel here would 403-spam every
    //    control the moment a non-admin opened this tab, the same
    //    misreads-as-a-bug anti-pattern adminGate.ts's `dependencies` entry
    //    documents). Built lazily from applyServiceStatus below, once a real
    //    `platform` is known -- see localHttpsBuilt's comment above.
    if (canSeeSection(ctx.role, 'localHttps')) {
        const container = document.createElement('div');
        localHttpsContainer = container;
        section.appendChild(container);
    }

    function setServerStatus(msg: string, isError = false): void {
        const el = webPortStatus;
        if (!el) return; // web port row not built (non-admin)
        el.textContent = msg;
        // The status line lives BELOW the web-port row and is empty at rest —
        // hide it when there is no message so it doesn't reserve a blank row.
        el.hidden = msg.length === 0;
        el.classList.toggle('settings-status-error', isError);
    }

    async function runRefresh(): Promise<void> {
        const input = webPortInput;
        if (!input) return; // web port row not built (non-admin)
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
            // No at-rest hint: the status line below the web-port row stays empty
            // unless the read itself fails.
        } catch {
            setServerStatus("couldn't reach server", true);
        }
    }

    /**
     * Reflect the (unit-tested) stopServerButtonState and appSectionButtonsState
     * decisions onto this tab's rows, from the /api/service/status response the
     * SERVICE tab fetched. Disables "stop server & exit" with a note in service
     * mode; reveals the two Linux-only rows (an inline display overrides the
     * `.settings-row { display: contents }` rule), disables "install for all
     * users" with an explanatory note once the machine-wide /opt install exists,
     * and keeps the uninstall row enabled whenever it is shown.
     *
     * /api/service/status already reports container mode, so these rows read the
     * same fact the Service and Updates sections gate on (findings 20.4, 20.5).
     * Today they also happen to stay hidden in a container because this is only
     * reached after refreshService(), which container mode skips — but that is an
     * accident of ordering, not a decision, and it would break the moment
     * anything else called this.
     */
    function applyServiceStatus(resp: ServiceStatusResponse): void {
        if (stopServerButton) {
            const stop = stopServerButtonState(resp);
            stopServerButton.disabled = stop.disabled;
            if (stopServerNote) {
                stopServerNote.textContent = stop.note ?? '';
                stopServerNote.hidden = stop.note === null;
            }
        }

        const state = appSectionButtonsState(resp);
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

        // Local HTTPS panel: built once, the first time a real platform is
        // available. Rebuilding on every later service-status refresh would
        // needlessly re-fetch /api/tls/state and blow away whatever the user
        // is mid-typing in the subject/port fields.
        if (localHttpsContainer && !localHttpsBuilt) {
            localHttpsBuilt = true;
            const platform: NodeJS.Platform = (resp.platform as NodeJS.Platform | undefined) ?? 'linux';
            void buildLocalHttpsPanel({
                fetchFn: fetch,
                // Always [] in production: GET /api/tls/state itself returns
                // the real candidateIps (Task 5's amendment (b)), which
                // buildLocalHttpsPanel prefers over this fallback.
                candidateIps: [],
                platform,
            }).then((panel) => {
                localHttpsContainer?.replaceChildren(panel);
            });
        }
    }

    refreshers.set(section, runRefresh);
    serviceStatusAppliers.set(section, applyServiceStatus);
    return section;
}

/**
 * Externally trigger the /api/config read for a Server tab `buildServerTab`
 * already built — it fills the web-port input and baselines the staged field.
 * A no-op if `section` was never built through `buildServerTab`.
 */
export async function refreshServer(section: HTMLElement): Promise<void> {
    const run = refreshers.get(section);
    if (!run) return;
    await run();
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
