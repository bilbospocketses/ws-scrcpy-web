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
// Consumes GET /api/tls/state, POST /api/tls/generate, GET /api/tls/ca-root,
// POST /api/tls/revoke, POST /api/tls/https-port and POST /api/tls/exposure,
// all implemented in `src/server/api/TlsApi.ts` -- read THAT file for the
// authoritative response shape of each, rather than a summary here that
// would drift the moment that file's contract changes without this comment
// changing too (an already-repeated finding on this branch). Every field
// this panel reads from a response is declared as optional on
// `TlsCertState` below and handled defensively when absent -- that
// interface, not a paragraph here, is the up-to-date contract this code
// actually depends on.
//
// The port field and the exposure radios each save through their OWN route
// (`POST /api/tls/https-port`, `POST /api/tls/exposure` -- task 11), not
// through `StagedSettingsStore`; see `buildLocalHttpsPanel`'s own doc comment
// below for why.
// ---------------------------------------------------------------------------

/** The subset of CertState (+ the two additions layered on by Task 4/5) this panel reads. */
interface TlsCertState {
    status: 'none' | 'ready';
    subject?: string;
    kind?: 'ip' | 'hostname';
    /** ISO 8601. */
    notAfter?: string;
    caPresent?: boolean;
    /**
     * Not every response this panel reads is guaranteed to carry this --
     * `candidateIpsFor()` below falls back to `deps.candidateIps` whenever
     * it's absent, so a response that omits it degrades to the build-time
     * fallback rather than losing the mismatch check (notification 4) or
     * the subject picker's (I7) option list.
     */
    candidateIps?: string[];
    /**
     * Returned by `GET /api/tls/state` since commit `861a5902` (the read side
     * of I5 -- task 11 had wired the write, `POST /api/tls/exposure`, first).
     * Read defensively below (`?? 'open'`, matching the server's own
     * `readHttpExposure()` default) so a server older than that commit still
     * degrades to the same default the server itself uses for an unset key,
     * rather than crashing on a missing field.
     */
    httpExposure?: 'open' | 'httpsOnly' | 'redirect';
    /**
     * Returned by `GET /api/tls/state` as `httpsSnapshot.configuredPort`
     * (`TlsApi.ts`, I2/C1's server half) -- the CONFIGURED port, always a
     * number even in advanced-config mode, independent of
     * `httpsListener.port` (the actually-BOUND port, present only when
     * `httpsListener.bound` is true and potentially different). Read
     * defensively below (`?? 8443`, the same `DEFAULT_HTTPS_PORT` `Config.ts`
     * itself falls back to) so an older server or a genuinely missing field
     * degrades to the server's own default rather than crashing.
     */
    httpsPort?: number;
    /**
     * C1's server half, in `TlsApi.ts` (coordinating through team-lead per
     * instruction, not editing that file myself) -- this exact nested shape
     * is pinned by that file's own test suite (`tlsApi.test.ts`'s
     * "httpsListener + httpsPort on GET /api/tls/state (C1, exact
     * contract)"), the source to re-check if this ever looks wrong, read
     * directly rather than guessed a second time after an earlier flat-field
     * version of this comment turned out to not match. Whether an HTTPS
     * listener is actually BOUND right now,
     * distinct from whether a certificate merely exists on disk -- they
     * diverge in at least four real states (right after `generate`, before a
     * restart; an advanced `server` array in config.json overriding the
     * generated entry; `httpsPort === webPort`; a bind failure), and in
     * every one, `status: 'ready'` was previously enough for this panel to
     * claim "streaming already works", which was false in all four.
     *
     * `undefined` (an older server, or before this field lands) is treated
     * as UNKNOWN, never as bound -- read `listenerStatusNotice`'s own doc
     * comment for why that default direction is the safe one.
     *
     * NF-1 (re-review): `reason` is NOT exclusive to `bound: false` -- it can
     * accompany `bound: true` too, when the socket is genuinely accepting
     * connections but is still serving the OLD leaf from before the last
     * regenerate (nothing rebinds it in-process). `bound` is a literal fact
     * about the socket; `reason`, when present, is why it is nonetheless not
     * fully usable, checked independently of `bound`'s value everywhere this
     * field is read.
     */
    httpsListener?: {
        bound: boolean;
        /** Present only when `bound` is true. */
        port?: number;
        /** Present when the listener isn't fully usable -- see this field's own doc comment for why that is independent of `bound`. */
        reason?: 'restart-required' | 'config-override' | 'port-collision' | 'bind-failed';
    };
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
    /**
     * `undefined` when not yet known (M2 -- the caller learns this from
     * `/api/service/status`, which resolves after this tab is already built)
     * OR genuinely unrecognised. Every platform-gated notice below (5, and
     * `trustInstructionsFor`) treats "don't know" as "say nothing" rather
     * than guessing a specific OS: a hardcoded fallback here previously
     * defaulted to `'linux'`, which fired notification 5's sub-1024 warning
     * on Windows whenever the real platform hadn't arrived yet.
     */
    platform: NodeJS.Platform | undefined;
    /**
     * Vestigial (I6): notification 3 no longer branches on this -- there is
     * no JS-observable signal for "does this browser actually trust the
     * served CA" (a click-through self-signed warning and a genuinely
     * trusted CA both report `isSecureContext: true` with nothing else
     * distinguishing them; the design doc's own measurement had to be done
     * manually in a real browser). Reworded the notice to an unconditional
     * line instead of trying to detect trust. Field kept, and still accepted,
     * only so the brief's fixed test (which passes `caTrusted: false`)
     * type-checks; nothing reads it any more.
     */
    caTrusted?: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const EXPIRY_WARNING_DAYS = 30;

// This repo's established convention for transient save/status feedback: ONE
// bottom-of-panel alert, never scattered inline next to whichever control
// caused it (a user who just clicked something looks in one place for the
// result). Success auto-hides sooner than an error, which may need reading
// and acting on.
const TRANSIENT_ALERT_SUCCESS_MS = 5_000;
const TRANSIENT_ALERT_ERROR_MS = 10_000;

/**
 * `candidateLanIps()` (the source of `candidateIps`, via TlsApi's
 * `getCandidateIps`) enumerates ONLY RFC1918 IPv4 addresses. It can positively
 * confirm "not present" for an address in that same range, but says nothing
 * about loopback, IPv6, CGNAT/Tailscale (100.64.0.0/10) or a public IP --
 * those are never in the list even when they ARE still bound to this
 * machine. Gates `certSubjectMismatchNotice` below (I4): only an RFC1918
 * subject enters the comparison at all.
 */
function isRfc1918Ipv4(value: string): boolean {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
    if (!m) return false;
    const octets = m.slice(1, 5).map(Number);
    if (octets.some((o) => o < 0 || o > 255)) return false;
    const [a, b] = octets as [number, number, number, number];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
}

/**
 * Notification 4: the cert's IP subject no longer matches any local
 * interface -- but ONLY when the oracle (`candidateIps`, RFC1918-IPv4-only)
 * can actually answer that question. A subject outside that range (loopback,
 * IPv6, CGNAT/Tailscale, public) is NEVER in the candidate list even when it
 * IS still a real address of this machine, so firing here for one would be a
 * permanent false positive (I4). When the oracle can't answer, say nothing --
 * the same rule notification 3 already follows for `caTrusted`.
 */
export function certSubjectMismatchNotice(state: TlsCertState, candidateIps: string[]): string | null {
    if (state.status !== 'ready' || state.kind !== 'ip' || !state.subject) return null;
    if (!isRfc1918Ipv4(state.subject)) return null;
    if (candidateIps.includes(state.subject)) return null;
    return `this certificate names ${state.subject}, which is no longer an address of this machine. regenerate, or switch to a hostname.`;
}

/**
 * Notification 9: warn inside 30 days of expiry; never regenerate silently
 * (Resolved Decision 1). M1: an already-expired cert gets its own past-tense
 * copy -- "expires on <date>. regenerate before then" reads backwards once
 * that date is in the past, since there is no "before then" left.
 */
export function certExpiryNotice(state: TlsCertState, now: Date): string | null {
    if (state.status !== 'ready' || !state.notAfter) return null;
    const expires = new Date(state.notAfter);
    if (Number.isNaN(expires.getTime())) return null;
    const daysLeft = (expires.getTime() - now.getTime()) / MS_PER_DAY;
    if (daysLeft > EXPIRY_WARNING_DAYS) return null;
    if (daysLeft <= 0) {
        return `this certificate expired on ${expires.toLocaleDateString()}. regenerate it, or streaming has stopped working from other machines.`;
    }
    return `this certificate expires on ${expires.toLocaleDateString()}. regenerate before then, or streaming stops working from other machines.`;
}

/**
 * Notification 5: a sub-1024 port needs elevated privileges outside win32.
 * M2: an ALLOWLIST (only linux/darwin fire), not a win32-denylist -- an
 * unknown/undefined platform (the caller hasn't learned it yet, or it is
 * genuinely unrecognised) must not fire this, the same "don't know, don't
 * claim" rule applied elsewhere in this file. The previous denylist shape
 * fired for anything that WASN'T literally `'win32'`, which included
 * `undefined` -- exactly the case `buildServerTab`'s wiring hit before this
 * fix, since a hardcoded `?? 'linux'` fallback there manufactured a platform
 * that was never actually known.
 */
export function subPrivilegedPortNotice(port: number, platform: NodeJS.Platform | string | undefined): string | null {
    if (platform !== 'linux' && platform !== 'darwin') return null;
    if (!Number.isFinite(port) || port <= 0 || port >= 1024) return null;
    return 'ports below 1024 need elevated privileges on this platform; the server may fail to start.';
}

/**
 * C1: the honest listener-state message, replacing the panel's previous
 * unconditional "streaming already works" the moment a certificate exists on
 * disk. `status: 'ready'` says a certificate was minted; it says nothing
 * about whether an HTTPS listener is actually bound -- those diverge right
 * after a fresh `generate` (no restart has happened), under an advanced
 * `server` array in config.json, on a `httpsPort`/`webPort` collision, and
 * after a bind failure. In every one of those, the previous copy was false,
 * and the only remedy the panel offered was `regenerate`, which destroys the
 * CA a device may have already installed -- never the right fix for any of
 * these, because the certificate was never the problem.
 *
 * `httpsListener === undefined` (the field hasn't landed on the server yet,
 * or is genuinely unknown) returns `null` -- SAY NOTHING rather than guess
 * either way, the same rule notification 3/4 already apply to their own
 * unknowns. This is the direction that cannot make the false claim this
 * finding is about: a wrongly-silent notice is a missed opportunity, a
 * wrongly-positive one is the bug being fixed.
 */
export function listenerStatusNotice(state: TlsCertState): string | null {
    if (state.status !== 'ready') return null;
    const listener = state.httpsListener;
    // NF-1: `reason` is the thing to check, not `bound`. A listener can be
    // genuinely bound (accepting connections) while still serving the OLD
    // leaf -- the socket was handed that PEM at boot and nothing rebinds it
    // in-process, so a regenerate leaves it serving a certificate signed by
    // the CA that regenerate just deleted. `bound` alone cannot see that;
    // `reason` carries it regardless of `bound`'s value. `reason === undefined`
    // (whether or not `bound` is true) means no basis for any claim --
    // fail-safe, matching how an unparseable certificate already behaves --
    // so this returns null, not a false "all good".
    if (listener === undefined || listener.reason === undefined) return null;
    if (listener.bound) {
        // The only reason that can accompany `bound: true` today.
        return 'the https listener is running, but it is still serving the certificate from before your last regenerate — including a ca that no longer exists. restart the server so it serves the new one; until then, a device using the new ca will not match what is actually being served.';
    }
    switch (listener.reason) {
        case 'restart-required':
            return 'certificate ready, but the https listener has not started yet. restart the server to begin serving https — regenerating will not help, and destroys any ca a device has already installed.';
        case 'config-override':
            return "this certificate exists, but an advanced server configuration in config.json is overriding it. https will not start until that configuration changes — regenerating won't help.";
        case 'port-collision':
            return 'the https port is the same as the plain http port, so https could not start. change the https port below to a different value, then restart.';
        case 'bind-failed':
            return 'the https listener failed to start, possibly because its port is already in use. check the server logs, free the port if needed, and restart.';
    }
}

/** A device the trust-instructions accordion (I5) covers. Not `NodeJS.Platform` -- a phone is never the Node process's own platform. */
export type TrustDevicePlatform = NodeJS.Platform | 'android' | 'ios';

/**
 * Per-device trust instructions for the accordion. Pure/exported so its text
 * is unit-testable.
 *
 * I5: this used to be called ONCE, with `deps.platform` -- the SERVER's
 * platform, from `/api/service/status`. The accordion's own summary promises
 * instructions for "this device", and the device that needs the CA installed
 * is whichever one is BROWSING the panel, which has no relationship to what
 * the server happens to run on (a Linux server browsed from a Windows
 * laptop printed Linux instructions). The phone is the device this whole
 * feature exists to serve, and it was never covered at all. Fixed by not
 * gating on any single platform: the caller now renders every entry in
 * `TRUST_DEVICE_PLATFORMS` unconditionally, and this function stays a pure
 * per-key lookup so each entry's text is independently testable.
 */
export function trustInstructionsFor(platform: TrustDevicePlatform | string | undefined): string {
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
        case 'android':
            return (
                'copy the downloaded file to the device (or open it directly if you downloaded it there), ' +
                'then settings → security → encryption & credentials → install a certificate → ca certificate, ' +
                'and confirm the warning. some android versions require a screen lock (pin/pattern/password) ' +
                'to be set before this option appears.'
            );
        case 'ios':
            return (
                'airdrop or email the downloaded file to the device and open it to install the profile ' +
                '(settings → general → vpn & device management), then go to settings → general → about → ' +
                'certificate trust settings and enable full trust for the new root certificate -- ios does ' +
                'not trust a manually installed ca until this second step.'
            );
        default:
            return "import the downloaded certificate into your browser or operating system's trusted root store.";
    }
}

/**
 * The fixed device list the accordion renders, in order. `key` feeds
 * `trustInstructionsFor`; `label` is the lowercase heading shown above it.
 * Exported so the panel-building code and any future test iterate the same
 * list rather than risking two hand-kept copies drifting apart.
 */
export const TRUST_DEVICE_PLATFORMS: ReadonlyArray<{ key: TrustDevicePlatform; label: string }> = [
    { key: 'win32', label: 'windows' },
    { key: 'darwin', label: 'macos' },
    { key: 'linux', label: 'linux' },
    { key: 'android', label: 'android' },
    { key: 'ios', label: 'ios / ipados' },
];

/**
 * Firefox keeps its own certificate store on every OS and does not consult
 * the one the steps above install into -- spec §7 requires this as its own
 * note, not folded into any one platform's steps, because it applies
 * regardless of which OS entry above a Firefox user just followed.
 */
export function firefoxTrustNote(): string {
    return (
        "using firefox? firefox keeps its own certificate store and ignores the operating system's -- " +
        "install the ca separately via firefox's settings → privacy & security → certificates → " +
        'view certificates → import, instead of (or in addition to) the steps above.'
    );
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
 * and NEITHER is wired that way -- each has its OWN dedicated "ok" button and
 * route instead (task 11), for the same underlying reason: `httpsPort` and
 * the exposure mode are both deliberately kept OUT of `AppConfig` (see
 * Config.ts's `FlatConfig` doc comment), so `SettingsBatchApi.STAGEABLE_IDS`
 * (an ALLOWLIST backed by `updateAppConfig`) is the wrong path for either --
 * routing them through it would mean either exposing them via
 * GET/PATCH /api/config (the thing that comment says never to do) or teaching
 * the batch endpoint two fields it cannot validate the same way as everything
 * else there.
 *
 * - The port field's "ok" button POSTs `{ port }` to `POST /api/tls/https-port`
 *   (validated by `validateHttpsPortInput`, Config.ts). The listener set is
 *   built once at boot (`Config.buildServers`) and nothing rebinds it
 *   in-process, so a save ALWAYS schedules a restart (`scheduleRestartForPortChange`,
 *   the same helper and exit-75 signal `SettingsBatchApi` uses for `webPort`)
 *   -- see the always-visible restart notice beside it.
 * - The exposure "ok" button POSTs `{ mode }` to `POST /api/tls/exposure`,
 *   which writes `HTTP_EXPOSURE_KEY` straight to `app_settings`.
 *   `HttpServer.ts`'s `readHttpExposure()` reads that key FRESH on every
 *   plain-HTTP request, so this takes effect for the very next request --
 *   no restart, unlike the port field above. (It still handles a 404
 *   gracefully below, from before this route existed -- harmless now, and
 *   cheap insurance against a client talking to an older server.)
 *
 * Every notice in here is one of two kinds, and each renders differently
 * (this repo's convention -- see TRANSIENT_ALERT_*_MS above):
 * - TRANSIENT OUTCOMES (a generate/download/exposure-save result) -- one
 *   shared alert at the bottom of this panel, auto-hiding after 5s/10s.
 * - PERSISTENT CONDITIONS and PRE-ACTION WARNINGS (notifications 2-9 from the
 *   spec table) -- rendered in place, beside the control they describe, and
 *   stay up for exactly as long as the condition holds (2/3/4/8/9) or until
 *   the choice is made (5/6/7). A toast is wrong for these: nobody wants a
 *   5-second flash for "your certificate expires in three weeks".
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

    // I7 (client half): show EVERY candidate, not an arbitrary single guess.
    // This machine can have far more than one IPv4 address (VPN, Docker,
    // WSL, VirtualBox adapters all show up here too), and only one is
    // reachable from the phone that needs the certificate -- prefilling
    // `[0]` with no way to see or pick another issues a cert nobody on the
    // LAN can use, exactly the failure spec §6 warns about. Selecting an
    // option here only fills `subjectInput`, which stays the single source
    // of truth for generate/validation/notification 4, so nothing
    // downstream changes.
    //
    // This code makes NO assumption about the ORDER `candidateIps` arrives
    // in -- it renders whatever order it receives and defaults to the first
    // entry (matching the existing pre-I7 prefill behaviour). Which
    // candidate is preferred (spec §6: the default-route interface) is
    // decided server-side, wherever `candidateIps` is actually resolved for
    // the response this panel reads (see `TlsCertState.candidateIps`'s own
    // doc comment) -- that can change its ordering with zero changes needed
    // here.
    const candidateSelect = document.createElement('select');
    candidateSelect.className = 'settings-input';
    candidateSelect.setAttribute('data-tls-candidate-select', '');
    for (const ip of initialCandidateIps) {
        const opt = document.createElement('option');
        opt.value = ip;
        opt.textContent = ip;
        candidateSelect.appendChild(opt);
    }
    if (initialCandidateIps.includes(subjectInput.value)) {
        candidateSelect.value = subjectInput.value;
    }
    candidateSelect.addEventListener('change', () => {
        subjectInput.value = candidateSelect.value;
        lastIpValue = candidateSelect.value;
    });

    function updateCandidateSelectVisibility(): void {
        candidateSelect.hidden = !ipRadio.checked || initialCandidateIps.length === 0;
    }
    updateCandidateSelectVisibility();

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
        updateCandidateSelectVisibility();
    });
    hostRadio.addEventListener('click', () => {
        if (!hostRadio.checked) return;
        lastIpValue = subjectInput.value;
        subjectInput.value = lastHostValue;
        updateCandidateSelectVisibility();
    });

    const subjectFrag = document.createDocumentFragment();
    subjectFrag.appendChild(ipLabel);
    subjectFrag.appendChild(hostLabel);
    subjectFrag.appendChild(subjectInput);
    subjectFrag.appendChild(candidateSelect);
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

    // ---- port -- POSTs to POST /api/tls/https-port (task 11); see the class
    //      doc's port-field paragraph for why this is its own route rather
    //      than a staged webPort-style field ----
    const portInput = document.createElement('input');
    portInput.type = 'number';
    portInput.className = 'settings-input';
    portInput.style.maxWidth = '120px';
    portInput.setAttribute('data-tls-port', '');
    // I2: read the SERVER's configured port, not a hardcoded guess -- a user
    // who set 9443 previously opened this panel to a lying "8443" display,
    // and one click on this field's own "ok" button would have reset their
    // port AND restarted the server. Falls back to the app's own
    // DEFAULT_HTTPS_PORT only when the field is missing (older server) or
    // genuinely unset.
    portInput.value = String(initialState.httpsPort ?? 8443);

    const portOkBtn = document.createElement('button');
    portOkBtn.type = 'button';
    portOkBtn.className = 'settings-btn settings-btn-primary';
    portOkBtn.textContent = 'ok';
    portOkBtn.setAttribute('data-tls-port-ok', '');

    const portFrag = document.createDocumentFragment();
    portFrag.appendChild(portInput);
    portFrag.appendChild(portOkBtn);
    body.appendChild(buildRow('https port', portFrag));

    const portNotice = buildNoticeRow();
    portNotice.setAttribute('data-tls-port-notice', '');
    body.appendChild(portNotice);
    portInput.addEventListener('input', () => {
        setNotice(portNotice, subPrivilegedPortNotice(Number(portInput.value), deps.platform));
    });

    // Always visible, unlike the exposure notices below (which appear only
    // once a narrowed mode is picked): there is no in-process rebind for the
    // HTTPS listener (see Config.setHttpsPort's doc comment), so EVERY save
    // here restarts the server -- unlike the exposure mode, which
    // HttpServer.ts re-reads fresh on every request and needs no restart.
    const portRestartNotice = document.createElement('p');
    portRestartNotice.className = 'settings-status';
    portRestartNotice.style.gridColumn = '1 / -1';
    portRestartNotice.setAttribute('data-tls-port-restart-note', '');
    portRestartNotice.textContent = 'changing this restarts the server; any active streams will drop.';
    body.appendChild(portRestartNotice);

    portOkBtn.addEventListener('click', () => {
        void (async () => {
            const port = Number(portInput.value);
            // Same bounds as validateHttpsPortInput (Config.ts) -- checked
            // here so an obviously-bad value never reaches the network.
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
                showTransientAlert('error', 'port must be an integer between 1 and 65535.');
                return;
            }
            portOkBtn.disabled = true;
            try {
                const res = await deps.fetchFn('/api/tls/https-port', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ port }),
                });
                const data = (await res.json().catch(() => null)) as { error?: string } | null;
                if (!res.ok) {
                    showTransientAlert('error', data?.error ?? `could not save the https port (${res.status}).`);
                    return;
                }
                showTransientAlert(
                    'success',
                    'https port saved. the server is restarting for the change to take effect.',
                );
            } catch {
                showTransientAlert('error', 'could not reach the server.');
            } finally {
                portOkBtn.disabled = false;
            }
        })();
    });

    // ---- generate / revoke ----
    const generateBtn = document.createElement('button');
    generateBtn.type = 'button';
    generateBtn.className = 'settings-btn settings-btn-primary';
    generateBtn.textContent = 'generate';
    generateBtn.setAttribute('data-tls-generate', '');

    // I1: enabling local HTTPS was previously one-way from this panel --
    // `POST /api/tls/revoke` existed and was admin-gated, but nothing in the
    // client ever called it. Disabled until a certificate exists (nothing to
    // revoke otherwise); `renderCertState` below is what flips this.
    const revokeBtn = document.createElement('button');
    revokeBtn.type = 'button';
    revokeBtn.className = 'settings-btn settings-btn-danger';
    revokeBtn.textContent = 'revoke…';
    revokeBtn.setAttribute('data-tls-revoke', '');
    revokeBtn.disabled = true;

    const certActionsFrag = document.createDocumentFragment();
    certActionsFrag.appendChild(generateBtn);
    certActionsFrag.appendChild(revokeBtn);
    body.appendChild(buildRow('certificate', certActionsFrag));

    // ---- current-certificate summary + notifications 3, 4, 8, 9 ----
    const certSummary = document.createElement('p');
    certSummary.className = 'settings-status';
    certSummary.style.gridColumn = '1 / -1';
    body.appendChild(certSummary);

    // C1: listener truth, ahead of everything else about the certificate --
    // this is the thing that was silently wrong. See listenerStatusNotice's
    // own doc comment for the four cases it covers and why 'unknown' says
    // nothing rather than guessing.
    const listenerStatusNoticeEl = buildNoticeRow();
    listenerStatusNoticeEl.setAttribute('data-tls-listener-notice', '');
    body.appendChild(listenerStatusNoticeEl);

    const untrustedCaNotice = buildNoticeRow();
    untrustedCaNotice.setAttribute('data-tls-ca-trust-notice', '');
    body.appendChild(untrustedCaNotice);
    const mismatchNotice = buildNoticeRow();
    mismatchNotice.setAttribute('data-tls-mismatch-notice', '');
    body.appendChild(mismatchNotice);
    const hostnameGuideNotice = buildNoticeRow();
    hostnameGuideNotice.setAttribute('data-tls-hostname-notice', '');
    body.appendChild(hostnameGuideNotice);
    // I9: the allowedHosts write (Resolved Decision 2) is a STANDING fact
    // about the current cert, not a one-time event -- the transient alert
    // below confirms the edit happened at generate time, but a user who
    // reopens Settings later needs to see it too, the same reasoning that
    // put notifications 2/3/4/9 in-panel rather than in a toast. Neutral
    // tone (plain `.settings-status`, not `-warning`): this confirms an
    // expected, working state, not a mistake to fix.
    const allowedHostPersistentNotice = document.createElement('p');
    allowedHostPersistentNotice.className = 'settings-status';
    allowedHostPersistentNotice.style.gridColumn = '1 / -1';
    allowedHostPersistentNotice.setAttribute('data-tls-allowed-host-notice', '');
    allowedHostPersistentNotice.hidden = true;
    body.appendChild(allowedHostPersistentNotice);
    const expiryNotice = buildNoticeRow();
    expiryNotice.setAttribute('data-tls-expiry-notice', '');
    body.appendChild(expiryNotice);
    const caRestoreNotice = buildNoticeRow();
    caRestoreNotice.setAttribute('data-tls-ca-restore-notice', '');
    body.appendChild(caRestoreNotice);

    // ---- download CA + per-OS trust instructions ----
    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'settings-btn';
    downloadBtn.textContent = 'download ca certificate';
    downloadBtn.setAttribute('data-tls-download', '');
    body.appendChild(buildRow('root ca', downloadBtn));

    // I5: every device this feature exists to serve gets its own entry --
    // not just whichever platform the server happens to run on. The phone
    // installing the CA is never the server, so gating this on
    // `deps.platform` (the server's OS) was wrong regardless of which value
    // it held.
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'how to trust this certificate on your device';
    details.appendChild(summary);
    for (const { key, label } of TRUST_DEVICE_PLATFORMS) {
        const entry = document.createElement('p');
        entry.className = 'settings-status';
        const labelStrong = document.createElement('strong');
        labelStrong.textContent = `${label}: `;
        entry.appendChild(labelStrong);
        entry.appendChild(document.createTextNode(trustInstructionsFor(key)));
        details.appendChild(entry);
    }
    const firefoxNote = document.createElement('p');
    firefoxNote.className = 'settings-status';
    firefoxNote.textContent = firefoxTrustNote();
    details.appendChild(firefoxNote);
    const detailsRow = buildRow('trust the ca', details);
    detailsRow.style.gridColumn = '1 / -1';
    body.appendChild(detailsRow);

    function renderCertState(state: TlsCertState): void {
        const candidateIps = candidateIpsFor(state);
        if (state.status !== 'ready') {
            certSummary.textContent = 'no certificate yet.';
            downloadBtn.disabled = true;
            revokeBtn.disabled = true;
            setNotice(listenerStatusNoticeEl, null);
            setNotice(untrustedCaNotice, null);
            setNotice(mismatchNotice, null);
            setNotice(hostnameGuideNotice, null);
            setNotice(expiryNotice, null);
            setNotice(caRestoreNotice, null);
            allowedHostPersistentNotice.textContent = '';
            allowedHostPersistentNotice.hidden = true;
            updateExposureAvailability();
            return;
        }

        // Built from text nodes, never innerHTML/string interpolation into
        // markup — `subject` is server round-tripped user input (test:
        // "uses textContent for the subject").
        certSummary.textContent = '';
        certSummary.appendChild(document.createTextNode('current certificate: '));
        const subjectSpan = document.createElement('span');
        subjectSpan.setAttribute('data-tls-current-subject', '');
        subjectSpan.textContent = state.subject ?? '(unknown)';
        certSummary.appendChild(subjectSpan);

        revokeBtn.disabled = false;
        const caPresent = state.caPresent !== false;
        downloadBtn.disabled = !caPresent;
        // Mutually exclusive (M4): a failed-regenerate leaf (caPresent false)
        // gets the restore note, never "install the ca below" -- that call to
        // action is meaningless while the download button it points at is
        // disabled.
        setNotice(caRestoreNotice, !caPresent ? 'regenerate to restore the ca download.' : null);

        // C1: the listener-truth notice, ahead of the CA-trust claim below.
        setNotice(listenerStatusNoticeEl, listenerStatusNotice(state));

        // I6: unconditional whenever the CA is actually downloadable, rather
        // than trying to detect whether THIS browser already trusts it --
        // there is no signal for that (see caTrusted's doc comment on
        // LocalHttpsPanelDeps). Worded as forward-looking guidance ("will not
        // trust ... until") instead of a live status claim ("does not trust
        // ... yet"), so it stays true whether or not the CA happens to
        // already be installed.
        //
        // C1/NF-1: this whole notice -- including "streaming already works
        // either way" -- presumes an HTTPS listener exists AND is actually
        // serving the current certificate. Suppressed whenever
        // `listenerStatusNoticeEl` above has anything to say
        // (`httpsListener.reason` present, regardless of `bound` -- NF-1: a
        // listener can be bound and still serving a stale leaf from before
        // the last regenerate), since that element already carries the
        // accurate, more specific message for every one of those cases.
        // Genuinely unknown (`httpsListener === undefined`, an older server)
        // or confirmed bound with NO reason keep the original claim, which
        // is the measured, true one whenever a listener both exists and
        // matches the certificate just generated.
        const listenerHasKnownProblem = state.httpsListener?.reason !== undefined;
        setNotice(
            untrustedCaNotice,
            caPresent && !listenerHasKnownProblem
                ? 'browsers will not trust this certificate until the ca is installed. install it below to remove the warning — streaming already works either way.'
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

        // I9: a STANDING fact, not the one-time confirmation the transient
        // alert already gives at generate time -- a hostname-kind cert
        // NECESSARILY has its subject in allowedHosts (Resolved Decision 2),
        // whether that happened just now or in an earlier session, so this
        // reflects the CURRENT state every time, not just right after a
        // generate. Text-node + span, same pattern as `certSummary`'s
        // subject -- `state.subject` is round-tripped user input.
        allowedHostPersistentNotice.textContent = '';
        if (state.kind === 'hostname' && state.subject) {
            const hostSpan = document.createElement('span');
            hostSpan.textContent = state.subject;
            allowedHostPersistentNotice.appendChild(hostSpan);
            allowedHostPersistentNotice.appendChild(
                document.createTextNode(' is registered in allowedHosts, so this server answers to that name.'),
            );
            allowedHostPersistentNotice.hidden = false;
        } else {
            allowedHostPersistentNotice.hidden = true;
        }

        updateExposureAvailability();
    }

    // One shared bottom-of-panel alert for every transient outcome (generate
    // succeeded/failed, CA download succeeded/failed, exposure save
    // succeeded/failed) -- see the class doc above for why this is one
    // element rather than a status line per button.
    const transientAlert = document.createElement('p');
    transientAlert.className = 'settings-status';
    transientAlert.style.gridColumn = '1 / -1';
    transientAlert.setAttribute('data-tls-alert', '');
    transientAlert.hidden = true;
    let transientAlertTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * `parts` are text nodes, or `{ echo }` for a value round-tripped from the
     * server (the generated subject) -- appended via a `<span>.textContent`
     * exactly like `renderCertState`'s subject span, never string
     * interpolation into markup.
     */
    function showTransientAlert(kind: 'success' | 'error', ...parts: Array<string | { echo: string }>): void {
        transientAlert.textContent = '';
        for (const part of parts) {
            if (typeof part === 'string') {
                transientAlert.appendChild(document.createTextNode(part));
            } else {
                const span = document.createElement('span');
                span.textContent = part.echo;
                transientAlert.appendChild(span);
            }
        }
        transientAlert.hidden = false;
        transientAlert.classList.toggle('settings-status-error', kind === 'error');
        transientAlert.classList.toggle('settings-status-ready', kind === 'success');
        if (transientAlertTimer !== null) clearTimeout(transientAlertTimer);
        transientAlertTimer = setTimeout(
            () => {
                transientAlert.hidden = true;
                transientAlertTimer = null;
            },
            kind === 'success' ? TRANSIENT_ALERT_SUCCESS_MS : TRANSIENT_ALERT_ERROR_MS,
        );
    }

    generateBtn.addEventListener('click', () => {
        void (async () => {
            const kind: 'ip' | 'hostname' = hostRadio.checked ? 'hostname' : 'ip';
            const value = subjectInput.value.trim();
            if (!value) {
                showTransientAlert('error', 'enter an ip address or hostname first.');
                return;
            }
            generateBtn.disabled = true;
            const prevText = generateBtn.textContent;
            generateBtn.textContent = 'generating…';
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
                    showTransientAlert('error', data?.error ?? 'that address could not be used for a certificate.');
                    return;
                }
                // NF-3: MERGE, don't replace. `POST /api/tls/generate`'s
                // response doesn't carry every field `GET /api/tls/state`
                // does (no `httpsPort`/`httpExposure` today) -- a wholesale
                // `currentState = data` would silently drop whatever the
                // initial `/state` fetch populated. Harmless today only
                // because nothing currently re-reads those two fields off
                // `currentState` after build time; the standing rule (stated
                // on both server routes: any field the panel branches on
                // must be present on every response that could change what
                // it should show) only holds on THIS side if the panel
                // doesn't discard fields it already has.
                currentState = { ...currentState, ...data };
                renderCertState(currentState);
                // Resolved Decision 2: state the allowedHosts edit plainly
                // rather than mutate it silently. This is a one-time outcome
                // of THIS generate, not a standing condition, so it belongs in
                // the transient alert, not a persistent in-panel notice.
                const allowedHostSuffix: Array<string | { echo: string }> =
                    data.allowedHostAdded && data.subject
                        ? [
                              ' added ',
                              { echo: data.subject },
                              ' to allowedHosts so the server will answer to that name.',
                          ]
                        : [];
                // C1/NF-1: the review's headline case -- a fresh certificate
                // with no restart yet has no HTTPS listener genuinely
                // serving it, and this used to be the moment the panel
                // started claiming streaming already worked.
                // `renderCertState(currentState)` just above already
                // re-evaluates `listenerStatusNoticeEl` and the CA-trust
                // suppression generically from whatever `data.httpsListener`
                // holds, keyed on `reason` rather than `bound` (NF-1: the
                // MOST common real case right after a generate is a listener
                // that was already bound from before, still serving the
                // stale leaf -- `bound: true` alongside
                // `reason: 'restart-required'`, not `bound: false`). This
                // branch mirrors that same check for the immediate transient
                // confirmation, wording it differently depending on whether
                // HTTPS was never up at all or is up but stale, since
                // "restart to START serving https" is the wrong sentence for
                // the second case.
                //
                // The test pinning this branch
                // ("mentions the restart in the SAME transient alert...")
                // proves the CLIENT's reaction to a mocked response of this
                // shape -- it cannot prove the server route actually sends
                // it, which is `tlsApi.test.ts`'s own job, not this
                // comment's. Read that file, not this one, for whether
                // `POST /api/tls/generate` currently includes the field.
                if (data.httpsListener?.reason === 'restart-required') {
                    showTransientAlert(
                        'success',
                        data.httpsListener.bound
                            ? 'certificate generated. restart the server so it serves the new certificate.'
                            : 'certificate generated. restart the server to start serving https.',
                        ...allowedHostSuffix,
                    );
                } else {
                    showTransientAlert('success', 'certificate generated.', ...allowedHostSuffix);
                }
            } catch {
                showTransientAlert('error', 'could not reach the server.');
            } finally {
                generateBtn.disabled = false;
                generateBtn.textContent = prevText;
            }
        })();
    });

    // I1: the only way back. `POST /api/tls/revoke` already existed and was
    // admin-gated (`TlsApi.ts`); nothing in the client ever called it, so
    // enabling local HTTPS was one-way from this panel. The confirmation
    // states plainly what it destroys -- the CA every device on the LAN was
    // asked to trust -- rather than a generic "are you sure?".
    revokeBtn.addEventListener('click', () => {
        void (async () => {
            const confirmed = await ConfirmModal.confirm({
                title: 'revoke the local https certificate?',
                message:
                    'this deletes the certificate AND the ca. every device that installed the ca to trust ' +
                    'this server will see a warning again, and streaming from other machines stops until you ' +
                    'generate a new certificate and they install the new ca. the running server keeps ' +
                    'answering https with the old material from memory until it restarts. continue?',
            });
            if (!confirmed) return;
            revokeBtn.disabled = true;
            try {
                const res = await deps.fetchFn('/api/tls/revoke', { method: 'POST' });
                if (!res.ok) {
                    showTransientAlert('error', `could not revoke the certificate (${res.status}).`);
                    revokeBtn.disabled = false;
                    return;
                }
                // NF-3: preserve `httpsPort`/`httpExposure`/`candidateIps` --
                // revoke doesn't touch the port or the exposure mode, only
                // the cert lifecycle. A wholesale `{ status: 'none' }` would
                // discard them from `currentState`, same latent issue as the
                // generate handler above. Destructured OUT (not set to
                // `undefined`) so `exactOptionalPropertyTypes` is satisfied --
                // these become genuinely absent, not explicitly undefined.
                const {
                    subject: _subject,
                    kind: _kind,
                    notAfter: _notAfter,
                    caPresent: _caPresent,
                    httpsListener: _httpsListener,
                    ...preserved
                } = currentState;
                currentState = { ...preserved, status: 'none' };
                renderCertState(currentState);
                showTransientAlert(
                    'success',
                    'certificate and ca revoked. restart the server to fully stop the https listener.',
                );
            } catch {
                showTransientAlert('error', 'could not reach the server.');
                revokeBtn.disabled = false;
            }
        })();
    });

    downloadBtn.addEventListener('click', () => {
        void (async () => {
            downloadBtn.disabled = true;
            try {
                const res = await deps.fetchFn('/api/tls/ca-root');
                if (!res.ok) {
                    // 404 (no cert yet) / 429 (rate limited) both answer JSON
                    // `{ error }` -- TlsApi.ts is the source of truth for the
                    // shape, read here rather than assumed.
                    const data = (await res.json().catch(() => null)) as { error?: string } | null;
                    showTransientAlert(
                        'error',
                        data?.error ?? `could not download the ca certificate (${res.status}).`,
                    );
                    return;
                }
                // I7: matches this repo's own precedent exactly
                // (ListFilesModal.ts's finishFileDownload) -- create the
                // anchor, set its blob-URL href, click, revoke. No
                // try/finally around the click: the precedent doesn't have
                // one either, and none of the three calls here can throw.
                const blob = await res.blob();
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'ws-scrcpy-web-local-ca.pem';
                a.click();
                URL.revokeObjectURL(a.href);
                showTransientAlert('success', 'ca certificate downloaded.');
            } catch {
                showTransientAlert('error', 'could not reach the server.');
            } finally {
                downloadBtn.disabled = currentState.caPresent === false;
            }
        })();
    });

    // ---- plain-HTTP exposure -- POSTs to POST /api/tls/exposure (task 11) ----
    const exposureFrag = document.createDocumentFragment();
    const exposureModes: Array<{ value: 'open' | 'httpsOnly' | 'redirect'; label: string }> = [
        { value: 'open', label: 'open (plain http answers every machine)' },
        { value: 'httpsOnly', label: 'https only' },
        { value: 'redirect', label: 'redirect http to https' },
    ];
    // I5: pre-select the radio matching the SERVER's current mode (read from
    // `GET /api/tls/state`'s `httpExposure`, commit `861a5902`), not a
    // hardcoded 'open'. Without this, a user who opens the panel to change
    // something else and clicks "ok" would silently widen their exposure
    // back to 'open' -- whatever they actually had gets overwritten by
    // whatever the radios happened to default to. Falls back to 'open' only
    // for an older server / a missing field, matching `HttpServer.ts`'s own
    // `readHttpExposure()` default for an unset key.
    const initialExposureMode = initialState.httpExposure ?? 'open';
    const exposureRadios: HTMLInputElement[] = [];
    for (const mode of exposureModes) {
        const label = document.createElement('label');
        label.className = 'settings-radio-label';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'tls-exposure';
        radio.value = mode.value;
        radio.setAttribute('data-exposure', mode.value);
        radio.checked = mode.value === initialExposureMode;
        label.appendChild(radio);
        label.appendChild(document.createTextNode(mode.label));
        exposureFrag.appendChild(label);
        exposureRadios.push(radio);
    }
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'settings-btn settings-btn-primary';
    okBtn.textContent = 'ok';
    okBtn.setAttribute('data-exposure-ok', '');
    exposureFrag.appendChild(okBtn);
    body.appendChild(buildRow('plain http exposure', exposureFrag));

    const exposureLockoutNotice = buildNoticeRow();
    exposureLockoutNotice.setAttribute('data-exposure-lockout-notice', '');
    body.appendChild(exposureLockoutNotice);
    const exposureRestartNotice = buildNoticeRow();
    exposureRestartNotice.setAttribute('data-exposure-restart-notice', '');
    body.appendChild(exposureRestartNotice);
    // I11: narrowing plain HTTP toward an HTTPS listener that does not exist
    // yet does nothing at runtime (`findHttpsPort()` returns `undefined` and
    // every mode fails open -- the correct, deliberate lockout guarantee,
    // ruling E2) -- but the panel still told the user their server WAS now
    // HTTPS-only. `updateExposureAvailability` below disables httpsOnly/
    // redirect (never 'open', which is always safe) until a certificate
    // exists, and this note explains why.
    const exposureUnavailableNotice = buildNoticeRow();
    exposureUnavailableNotice.setAttribute('data-exposure-unavailable-notice', '');
    body.appendChild(exposureUnavailableNotice);

    /**
     * I11: disable the narrowing exposure modes (not 'open', which is always
     * safe with or without a certificate) until a certificate actually
     * exists to serve HTTPS. Called from `renderCertState` -- defined as a
     * hoisted function so the ordering there doesn't matter.
     */
    function updateExposureAvailability(): void {
        // N2 (re-review): gated on `status === 'ready'` alone, a certificate
        // that exists but has no BOUND listener (any of C1's four down-cases
        // -- most commonly right after `generate`, before a restart) still
        // let the user narrow plain HTTP toward an HTTPS listener that isn't
        // running. Gate on the listener itself, which `httpsListener.bound`
        // now reports directly -- the same "the panel must not infer
        // listener state" rule C1 is about, not composed from `status` here.
        const hasCert = currentState.status === 'ready';
        const listenerBound = currentState.httpsListener?.bound === true;
        for (const radio of exposureRadios) {
            if (radio.value !== 'open') radio.disabled = !listenerBound;
        }
        setNotice(
            exposureUnavailableNotice,
            listenerBound
                ? null
                : hasCert
                  ? 'restart the server first — https only and redirect only take effect once the https listener is actually running.'
                  : 'generate a certificate first — https only and redirect only take effect once an https listener can exist.',
        );
    }

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
            // Corrected (review addendum): this is NOT the port field's
            // restart notice. `HttpServer.ts`'s `readHttpExposure()` re-reads
            // `HTTP_EXPOSURE_KEY` fresh on every plain-HTTP request -- there
            // is no listener to rebind and nothing to restart, so a save here
            // takes effect for the very next connection attempt. An ALREADY
            // established stream (its socket already past the HTTP request
            // that started it) is untouched -- only new connection attempts
            // see the new mode.
            setNotice(
                exposureRestartNotice,
                narrowed
                    ? 'this takes effect immediately for new connections. streams already running are not affected.'
                    : null,
            );
        });
    }

    okBtn.addEventListener('click', () => {
        void (async () => {
            const mode = exposureRadios.find((r) => r.checked)?.value ?? 'open';
            // I11/N2, defense in depth: the disabled radios already prevent
            // SELECTING a narrowed mode without a bound listener, but a stale
            // click queued before `renderCertState` last ran (or a radio
            // pre-selected 'httpsOnly'/'redirect' from the server before the
            // listener's absence was known) must not still submit it. Gated
            // on the listener itself, not `status`, for the same reason
            // `updateExposureAvailability` above is.
            if (mode !== 'open' && currentState.httpsListener?.bound !== true) {
                showTransientAlert(
                    'error',
                    currentState.status === 'ready'
                        ? 'restart the server first — this mode has no https listener to apply to yet.'
                        : 'generate a certificate first — this mode has no https listener to apply to.',
                );
                return;
            }
            okBtn.disabled = true;
            try {
                // Wired since task 11 (`POST /api/tls/exposure`, commit
                // 5e8be349). The 404 branch below predates that route and is
                // now just cheap insurance against an older server.
                const res = await deps.fetchFn('/api/tls/exposure', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode }),
                });
                if (!res.ok) {
                    if (res.status === 404) {
                        showTransientAlert('error', 'this server does not support saving this setting yet.');
                        return;
                    }
                    const data = (await res.json().catch(() => null)) as { error?: string } | null;
                    showTransientAlert('error', data?.error ?? `could not change plain-http exposure (${res.status}).`);
                    return;
                }
                showTransientAlert('success', 'plain-http exposure updated.');
            } catch {
                showTransientAlert('error', 'could not reach the server.');
            } finally {
                okBtn.disabled = false;
            }
        })();
    });

    // Bottom-of-panel: appended LAST so it always sits below every control,
    // per this repo's convention for transient outcomes (see the class doc).
    //
    // M5: appended DIRECTLY into `body`, never through `buildRow()` --
    // deliberately, not by accident. `modal.css`'s
    // `.settings-row:has(.settings-status-error) { display: flex; ... }`
    // targets `.settings-row`, and `transientAlert` toggles
    // `.settings-status-error` on itself (see `showTransientAlert`). Wrapping
    // this element in a `.settings-row` the way every other control here is
    // wrapped would make that rule match it on an error, overriding this
    // row's normal `display: contents` and changing its layout -- a
    // near-miss on the same "a rule silently starts matching an element it
    // wasn't written for" class of bug the `[hidden]` reassertion above
    // guards against. If a future change wraps this in a row, that CSS rule
    // needs handling at the same time, not discovered by an unexplained
    // layout shift the next time an error fires.
    body.appendChild(transientAlert);

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
            // M2: no guessed fallback. `resp.platform` SHOULD be populated by
            // a real /api/service/status response, but if it somehow isn't,
            // `undefined` is passed straight through -- every platform-gated
            // notice already treats "don't know" as "say nothing"
            // (subPrivilegedPortNotice, trustInstructionsFor). The previous
            // `?? 'linux'` fabricated a platform that was never actually
            // observed, and fired notification 5's sub-1024 warning on
            // Windows whenever this ran before the real value arrived.
            const platform = resp.platform as NodeJS.Platform | undefined;
            void buildLocalHttpsPanel({
                // C1: wrapped, not passed by reference -- an unbound `fetch`
                // throws "Illegal invocation" in Chrome (same precedent as
                // NetworkDiscoveryPanel.ts's renderPairingSection call).
                fetchFn: (...args: Parameters<typeof fetch>) => fetch(...args),
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
