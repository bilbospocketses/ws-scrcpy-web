import { CA_ROOT_DOWNLOAD_FILE_NAME } from '../../../../common/CaDownload';
import { DependencyStatus } from '../../../../common/DependencyTypes';
import type { ServiceStatusResponse } from '../../../../common/ServiceEvents';
import { ConfirmModal } from '../../ConfirmModal';
import { type AskChild, askUnbound, type TabContext } from './EmbeddingTab';

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

// ---------------------------------------------------------------------------
// Local HTTPS panel (Settings → Local HTTPS; until 0.5.3 a section of the
// Server tab).
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
     * OR genuinely unrecognized. Every platform-gated notice below (5) treats "don't know" as "say nothing" rather
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
    /** The Settings dialog's `askChild`, for the revoke confirm; unbound when built on its own. */
    askChild?: AskChild;
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

/**
 * Where the panel sends a user for the per-device install steps. Relative, like
 * the subnet cheat sheet's link (AddSubnetModal.ts), so it follows the app's
 * own path. Since 0.5.3 the steps live on that page, not in the panel.
 */
export const TRUST_HELP_HREF = 'help/certificate-subject.html#4-installing-a-certificate-establishing-trust';

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

/**
 * Is mkcert installed, by `GET /api/dependencies`'s own record of it (the same
 * read the Dependencies tab makes)? `null` when that cannot be told -- the read
 * failed or was refused, or the list does not name mkcert -- and the panel
 * then FAILS OPEN, leaving generate enabled: `POST /api/tls/generate` still
 * installs a missing mkcert itself (createCertService.ts's backstop), so a
 * wrong "enabled" costs a slower first generate, while a wrong "disabled"
 * would lock a working feature behind a read that happened to fail.
 *
 * "Not installed" (false) needs the server to have SAID so: status
 * `not-installed`, or `error` with no installed version. A null
 * `installedVersion` alone is not enough: until the boot's `checkAll` reaches
 * mkcert, every dependency reads `unknown` with a null version
 * (DependencyManager's initial state), and treating that as missing disabled
 * generate while the Dependencies tab showed Unknown with no install button to
 * fix it. `unknown`, `checking` and the rest answer null, and the panel fails
 * open.
 */
export async function fetchMkcertInstalled(fetchFn: typeof fetch): Promise<boolean | null> {
    try {
        const res = await fetchFn('/api/dependencies');
        if (!res.ok) return null;
        const deps = (await res.json()) as unknown;
        if (!Array.isArray(deps)) return null;
        const mkcert = (deps as Array<{ name?: unknown; installedVersion?: unknown; status?: unknown }>).find(
            (d) => d !== null && typeof d === 'object' && d.name === 'mkcert',
        );
        if (!mkcert) return null;
        if (typeof mkcert.installedVersion === 'string' && mkcert.installedVersion.length > 0) return true;
        if (mkcert.status === DependencyStatus.NotInstalled) return false;
        if (mkcert.status === DependencyStatus.Error && (mkcert.installedVersion ?? null) === null) return false;
        return null;
    } catch {
        return null;
    }
}

/**
 * The orange note at the very top of the Local HTTPS tab while mkcert is not
 * installed (0.5.3; until then a line under the certificate controls).
 */
export const MKCERT_MISSING_NOTICE =
    'mkcert must be installed from the dependencies tab before https can be enabled and a certificate generated. until then, this section is unavailable.';

/**
 * Per-panel re-entry for "mkcert may have just been installed", keyed by the
 * section `buildLocalHttpsPanel` returned -- the same WeakMap shape as the tab
 * modules' `refreshers`, so the function keeps returning a plain HTMLElement.
 */
const mkcertRecheckers = new WeakMap<HTMLElement, () => Promise<void>>();

/**
 * Re-read mkcert's install state for a Local HTTPS panel and re-apply the
 * generate gating. A no-op for an element `buildLocalHttpsPanel` did not build.
 */
export async function recheckLocalHttpsMkcert(panel: HTMLElement): Promise<void> {
    await mkcertRecheckers.get(panel)?.();
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
    // Both reads go out together, but the panel waits for the TLS state only.
    // Blocking it on /api/dependencies as well would let a hung or slow
    // dependency read hide the whole panel, certificate controls and all. If
    // the mkcert read has answered by the time the state has (the usual case:
    // both are local reads), the gate is applied before the panel is returned;
    // otherwise it is applied when the read answers (see the end of this
    // function), and until then generate stays enabled -- the fail-open
    // direction, see fetchMkcertInstalled.
    const mkcertRead = fetchMkcertInstalled(deps.fetchFn);
    const initialState = await fetchTlsState(deps.fetchFn);
    const PENDING = Symbol('pending');
    const earlyMkcert = await Promise.race([mkcertRead, Promise.resolve(PENDING)]);
    let currentState: TlsCertState = initialState;
    // `true` only when the server SAYS mkcert is not installed.
    let mkcertMissing = earlyMkcert === false;
    // Bumped by every re-check, so the build-time read answering late cannot
    // overwrite a newer answer.
    let mkcertReadSeq = 0;
    const candidateIpsFor = (s: TlsCertState): string[] => s.candidateIps ?? deps.candidateIps;

    const { section, body } = buildSection('Local HTTPS');

    // 0.5.1: generate needs mkcert, and installing it is the Dependencies
    // tab's job (its install button). Until then generate and the subject
    // controls that only feed it are disabled (applyMkcertGate below), and this
    // says why. Since 0.5.3 the note sits at the very TOP of the tab, in the
    // warning (orange) tone, rather than as a line under the controls: it is
    // the first thing a user without mkcert needs to read. Revoke, the ca
    // download, the https port and the exposure modes need no mkcert, so they
    // stay as they are.
    const mkcertNotice = buildNoticeRow();
    mkcertNotice.setAttribute('data-tls-mkcert-notice', '');
    body.appendChild(mkcertNotice);

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

    // Notification 2 — ALWAYS shown, beside the subject controls: what each
    // subject choice means, in the terms of the two radios just above. Until
    // 0.5.1 this was a sentence about `allowedHosts`, a config.json key no
    // control in this dialog is labelled with, so it explained nothing to
    // anyone choosing between the radios. Not conditional on anything: it is
    // guidance for the choice, not a mistake state.
    const subjectGuideNotice = document.createElement('p');
    subjectGuideNotice.className = 'settings-status';
    subjectGuideNotice.style.gridColumn = '1 / -1';
    subjectGuideNotice.setAttribute('data-tls-subject-guide', '');
    subjectGuideNotice.textContent =
        'ip address: other devices reach this computer by its address on your network. ' +
        'hostname: use a name your network or dns resolves to this computer.';
    body.appendChild(subjectGuideNotice);

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

    // A generate in flight holds its button down; a re-check landing
    // meanwhile must not release it.
    let generating = false;
    function applyMkcertGate(): void {
        generateBtn.disabled = mkcertMissing || generating;
        ipRadio.disabled = mkcertMissing;
        hostRadio.disabled = mkcertMissing;
        subjectInput.disabled = mkcertMissing;
        candidateSelect.disabled = mkcertMissing;
        setNotice(mkcertNotice, mkcertMissing ? MKCERT_MISSING_NOTICE : null);
    }
    applyMkcertGate();

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

    // ---- download CA (a .crt holding the PEM, since 0.5.3) ----
    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'settings-btn';
    downloadBtn.textContent = 'download ca certificate';
    downloadBtn.setAttribute('data-tls-download', '');
    body.appendChild(buildRow('root ca', downloadBtn));

    // 0.5.3: the per-device install steps moved to the help page (section 4 of
    // certificate-subject.html), which has room for each OS's real steps and
    // the Firefox one. The panel keeps one line pointing there.
    const trustHelp = document.createElement('p');
    trustHelp.className = 'settings-status';
    trustHelp.style.gridColumn = '1 / -1';
    trustHelp.setAttribute('data-tls-trust-help', '');
    trustHelp.appendChild(
        document.createTextNode(
            'to trust the certificate, install it on each device that connects (firefox has its own store): ',
        ),
    );
    const trustHelpLink = document.createElement('a');
    trustHelpLink.className = 'settings-help-link';
    trustHelpLink.href = TRUST_HELP_HREF;
    trustHelpLink.target = '_blank';
    trustHelpLink.rel = 'noopener noreferrer';
    trustHelpLink.textContent = 'step-by-step install guide (opens in a new tab)';
    trustHelp.appendChild(trustHelpLink);
    body.appendChild(trustHelp);

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
        // The wording says what the registration DOES for the user: the
        // Host-header guard (`isHostAllowed`, security/originGuard.ts) lets
        // in requests addressed to that name. Until 0.5.1 it named `allowedHosts`, a config.json key
        // with no control anywhere in Settings.
        allowedHostPersistentNotice.textContent = '';
        if (state.kind === 'hostname' && state.subject) {
            const hostSpan = document.createElement('span');
            hostSpan.textContent = state.subject;
            allowedHostPersistentNotice.appendChild(
                document.createTextNode('this server accepts connections addressed to '),
            );
            allowedHostPersistentNotice.appendChild(hostSpan);
            allowedHostPersistentNotice.appendChild(document.createTextNode('.'));
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
            // The button is disabled while mkcert is missing; a click queued
            // before the gate applied must not send anyway.
            if (mkcertMissing) return;
            const kind: 'ip' | 'hostname' = hostRadio.checked ? 'hostname' : 'ip';
            const value = subjectInput.value.trim();
            if (!value) {
                showTransientAlert('error', 'enter an ip address or hostname first.');
                return;
            }
            generating = true;
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
                // the transient alert, not a persistent in-panel notice. It
                // says what the edit does for the user, not the config key's
                // name (no control in Settings is labelled allowedHosts).
                const allowedHostSuffix: Array<string | { echo: string }> =
                    data.allowedHostAdded && data.subject
                        ? [' this server now also accepts connections addressed to ', { echo: data.subject }, '.']
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
                generating = false;
                generateBtn.disabled = mkcertMissing;
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
            const confirmed = await (deps.askChild ?? askUnbound)(
                () =>
                    ConfirmModal.confirm({
                        title: 'revoke the local https certificate?',
                        message:
                            'this deletes the certificate AND the ca. every device that installed the ca to trust ' +
                            'this server will see a warning again, and streaming from other machines stops until you ' +
                            'generate a new certificate and they install the new ca. the running server keeps ' +
                            'answering https with the old material from memory until it restarts. continue?',
                    }),
                false,
            );
            if (!confirmed) return;
            revokeBtn.disabled = true;
            try {
                const res = await deps.fetchFn('/api/tls/revoke', { method: 'POST' });
                if (!res.ok) {
                    // The server's own reason when it gives one, as generate,
                    // exposure and port already show: an off-box caller in open
                    // mode is refused by requireOperator (item 153), and "(403)"
                    // alone reads as a bug rather than as "not from here".
                    const data = (await res.json().catch(() => null)) as { error?: string } | null;
                    showTransientAlert('error', data?.error ?? `could not revoke the certificate (${res.status}).`);
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
                // The same name the server's Content-Disposition carries (CaDownload.ts).
                a.download = CA_ROOT_DOWNLOAD_FILE_NAME;
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
    // Unknown (`null`) leaves the gate where it is: a failed read is no news.
    function applyMkcertAnswer(installed: boolean | null): void {
        if (installed === null) return;
        mkcertMissing = !installed;
        applyMkcertGate();
    }
    if (earlyMkcert === PENDING) {
        void mkcertRead.then((installed) => {
            if (mkcertReadSeq === 0) applyMkcertAnswer(installed);
        });
    }
    mkcertRecheckers.set(section, async () => {
        const seq = ++mkcertReadSeq;
        const installed = await fetchMkcertInstalled(deps.fetchFn);
        if (seq === mkcertReadSeq) applyMkcertAnswer(installed);
    });
    return section;
}

/**
 * What a container shows in place of the Local HTTPS panel. The copy names the
 * one supported way (a reverse proxy in front of the container), matching the
 * server's refusal of every `/api/tls/*` route in a container, reads included
 * (since beta.164). The panel is never built there, so nothing here asks.
 */
export function buildLocalHttpsContainerNote(): HTMLElement {
    const { section, body } = buildSection('Local HTTPS');
    section.setAttribute('data-local-https-container-note', '');
    const note = document.createElement('p');
    note.className = 'settings-status';
    note.style.gridColumn = '1 / -1';
    note.textContent =
        "local HTTPS doesn't apply in a container. serve HTTPS from a reverse proxy in front of the container — that is the only supported way to add HTTPS to the image.";
    body.appendChild(note);
    return section;
}

/**
 * Per-instance re-entry points, keyed by the element `buildLocalHttpsTab`
 * returned. Same shape — and the same reason — as ServerTab.ts's `refreshers`:
 * `SettingsModal` builds every tab eagerly, then learns LATER whether it is in a
 * container and what platform the server runs on. These maps let it drive this
 * tab from outside without `buildLocalHttpsTab` returning anything other than
 * the `HTMLElement` its signature promises.
 */
const serviceStatusAppliers = new WeakMap<HTMLElement, (resp: ServiceStatusResponse) => void>();
const containerModeAppliers = new WeakMap<HTMLElement, () => void>();
const dependencyInstalledAppliers = new WeakMap<HTMLElement, () => Promise<void>>();

/**
 * The Local HTTPS tab (admin-only; `/api/tls/*` is admin-gated server-side).
 * Until 0.5.3 this was a second section at the bottom of the Server tab.
 *
 * Builds synchronously and fires no network request of its own. What it shows
 * is decided from outside, once `SettingsModal` knows:
 * - on a host, `applyLocalHttpsServiceStatus()` builds the panel the first time
 *   a real `platform` arrives with the /api/service/status response the Service
 *   tab fetched (the panel's sub-1024 port notice needs the platform);
 * - in a container, `applyLocalHttpsContainerMode()` shows ONLY the
 *   reverse-proxy note (Local HTTPS is not supported there, user decision
 *   2026-09-30), and a later service status never builds the panel over it.
 *
 * Until either arrives the tab holds a placeholder section under the same
 * heading. The root is a plain `<div>`, not a `.settings-section`, so exactly one
 * `section.settings-section` with the "Local HTTPS" heading exists at any time.
 *
 * Registers nothing with a `StagedSettingsStore`: every control in the panel
 * saves through its own route (see `buildLocalHttpsPanel`'s doc comment).
 */
export function buildLocalHttpsTab(ctx: TabContext): HTMLElement {
    const root = document.createElement('div');
    // Stable hook for tests, in the spirit of the Dependencies tab's.
    root.dataset['settingsTab'] = 'local-https';

    const placeholder = buildSection('Local HTTPS');
    const loading = document.createElement('p');
    loading.className = 'settings-status';
    loading.style.gridColumn = '1 / -1';
    loading.textContent = 'loading…';
    placeholder.body.appendChild(loading);
    root.appendChild(placeholder.section);

    // Set once the panel or the container note has replaced the placeholder;
    // neither is ever rebuilt (a rebuild would re-fetch /api/tls/state and blow
    // away whatever the user is mid-typing in the subject/port fields).
    let decided = false;
    // The built panel, once `buildLocalHttpsPanel` has resolved; what a
    // dependency install re-checks mkcert on (applyDependencyInstalled).
    let panel: HTMLElement | null = null;

    function applyContainerMode(): void {
        if (decided) return;
        decided = true;
        root.replaceChildren(buildLocalHttpsContainerNote());
    }

    function applyServiceStatus(resp: ServiceStatusResponse): void {
        if (decided) return;
        decided = true;
        // M2: no guessed fallback. `resp.platform` SHOULD be populated by a
        // real /api/service/status response, but if it somehow isn't,
        // `undefined` is passed straight through -- every platform-gated
        // notice already treats "don't know" as "say nothing"
        // (subPrivilegedPortNotice). A `?? 'linux'`
        // fallback once fabricated a platform that was never observed, and
        // fired notification 5's sub-1024 warning on Windows.
        const platform = resp.platform as NodeJS.Platform | undefined;
        void buildLocalHttpsPanel({
            // C1: wrapped, not passed by reference -- an unbound `fetch` throws
            // "Illegal invocation" in Chrome (same precedent as
            // NetworkDiscoveryPanel.ts's renderPairingSection call).
            fetchFn: (...args: Parameters<typeof fetch>) => fetch(...args),
            // Always [] in production: GET /api/tls/state itself returns the
            // real candidateIps (Task 5's amendment (b)), which
            // buildLocalHttpsPanel prefers over this fallback.
            candidateIps: [],
            platform,
            askChild: ctx.askChild,
        }).then((built) => {
            panel = built;
            root.replaceChildren(built);
        });
    }

    /**
     * A dependency was just installed or updated from the Dependencies tab. The
     * panel re-reads mkcert's state, so an mkcert installed there enables
     * generate without reopening Settings. Nothing to do before the panel
     * exists: it reads mkcert's state when it is built.
     */
    async function applyDependencyInstalled(): Promise<void> {
        if (panel) await recheckLocalHttpsMkcert(panel);
    }

    serviceStatusAppliers.set(root, applyServiceStatus);
    containerModeAppliers.set(root, applyContainerMode);
    dependencyInstalledAppliers.set(root, applyDependencyInstalled);
    return root;
}

/**
 * Hand a Local HTTPS tab the /api/service/status response the SERVICE tab
 * fetched; the first one builds the panel. A no-op if `tab` was never built
 * through `buildLocalHttpsTab`, or once the tab has been decided.
 */
export function applyLocalHttpsServiceStatus(tab: HTMLElement, resp: ServiceStatusResponse): void {
    serviceStatusAppliers.get(tab)?.(resp);
}

/**
 * Tell a Local HTTPS tab it is running in a container: it shows only the
 * reverse-proxy note, and no later service status builds the panel. A no-op if
 * `tab` was never built through `buildLocalHttpsTab`.
 */
export function applyLocalHttpsContainerMode(tab: HTMLElement): void {
    containerModeAppliers.get(tab)?.();
}

/**
 * Tell a Local HTTPS tab that a dependency was installed or updated (the
 * Dependencies panel's `DEPENDENCY_INSTALLED_EVENT`), so its panel re-checks
 * whether mkcert is installed. A no-op if `tab` was never built through
 * `buildLocalHttpsTab`.
 */
export async function applyLocalHttpsDependencyInstalled(tab: HTMLElement): Promise<void> {
    await dependencyInstalledAppliers.get(tab)?.();
}
