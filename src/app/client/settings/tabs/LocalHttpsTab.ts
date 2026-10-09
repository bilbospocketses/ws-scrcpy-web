import { CA_ROOT_DOWNLOAD_FILE_NAME } from '../../../../common/CaDownload';
import { DependencyStatus } from '../../../../common/DependencyTypes';
import { isPublicSuffix } from '../../../../common/publicSuffix';
import { refusedSubjectMessage } from '../../../../common/refusedSubject';
import type { ServiceStatusResponse } from '../../../../common/ServiceEvents';
import { ConfirmModal } from '../../ConfirmModal';
import { themeHelpLink } from '../../helpLink';
import { buildCombobox } from '../Combobox';
import { addCard, buildItem, buildRow, buildSection, buildSplitSection } from '../settingsLayout';
import { type AskChild, askUnbound, type TabContext } from './EmbeddingTab';

// ---------------------------------------------------------------------------
// Local HTTPS panel (Settings → Local HTTPS; until 0.5.3 a section of the
// Server tab).
//
// Consumes GET /api/tls/state, POST /api/tls/generate, GET /api/tls/ca-root,
// POST /api/tls/revoke and POST /api/tls/exposure, all implemented in
// `src/server/api/TlsApi.ts` (the https port, and its POST
// /api/tls/https-port, moved to the Server tab's batch-staged row after
// 0.5.3) -- read THAT file for the
// authoritative response shape of each, rather than a summary here that
// would drift the moment that file's contract changes without this comment
// changing too (an already-repeated finding on this branch). Every field
// this panel reads from a response is declared as optional on
// `TlsCertState` below and handled defensively when absent -- that
// interface, not a paragraph here, is the up-to-date contract this code
// actually depends on.
//
// The exposure radios save through their OWN route (`POST /api/tls/exposure`
// -- task 11), not through `StagedSettingsStore`; see `buildLocalHttpsPanel`'s
// own doc comment below for why.
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
     * (`TlsApi.ts`, I2/C1's server half) -- the CONFIGURED port. The panel
     * no longer reads it: the https port moved to the Server tab, whose row
     * makes its own /api/tls/state read (ServerTab.ts). Kept here so the
     * generate/revoke merges below keep carrying it, as they always have.
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
    /**
     * Switch the Settings dialog to another tab (`TabContext.showTab`): the
     * mkcert callout's "dependencies tab" link calls it with `dependencies`.
     * Absent when the panel is built on its own, and the link then does nothing.
     */
    showTab?: (id: string) => void;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const EXPIRY_WARNING_DAYS = 30;

// This repo's established convention for transient save/status feedback: ONE
// alert in one place at the bottom of the tab, never scattered inline next to
// whichever control caused it (a user who just clicked something looks in one
// place for the result). Since 0.5.5 that place is below and outside the
// cards, so it never reads as part of the last one. Success auto-hides after
// 5 s, an error after 10 s: it may need reading and acting on.
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
            return 'the https port is the same as the plain http port, so https could not start. change the https port on the server tab to a different value; saving it restarts the server.';
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

/** The certificate-subject explainer the subject radios link to (0.5.3); same page, from the top. */
export const SUBJECT_HELP_HREF = 'help/certificate-subject.html';

/**
 * The always-shown guide under the certificate subject, which follows the
 * chosen kind (0.5.5): what has to match is the ADDRESS the other device types
 * in ip mode, and the NAME in hostname mode. SUBJECT_HELP_LINK_TEXT follows it.
 */
export const SUBJECT_GUIDE_IP_TEXT = 'must match the address you type on the other device to reach this server. ';
export const SUBJECT_GUIDE_HOSTNAME_TEXT = 'must match the name you type on the other device to reach this server. ';

/** The guide's link to SUBJECT_HELP_HREF. */
export const SUBJECT_HELP_LINK_TEXT = 'how this works ↗';

/** The line under the root ca download; TRUST_HELP_LINK_TEXT follows it. */
export const TRUST_HELP_TEXT = 'install it on each device that connects (firefox has its own store). ';

/** The trust line's link to TRUST_HELP_HREF. */
export const TRUST_HELP_LINK_TEXT = 'install guide ↗';

/**
 * Said to a screen reader at the end of each help link's name. Not on screen
 * since 0.5.5: the ↗ says it to the eye, and the words made both lines long.
 */
const NEW_TAB_SUFFIX = ' (opens in a new tab)';

/**
 * A link to a help page, in a new tab, carrying the app's theme (helpLink.ts).
 * Its accessible name is the visible text without the ↗ glyph, which a screen
 * reader would read out as "north east arrow", plus NEW_TAB_SUFFIX.
 */
function buildHelpLink(href: string, text: string): HTMLAnchorElement {
    const link = document.createElement('a');
    link.className = 'settings-help-link';
    themeHelpLink(link, href);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = text;
    link.setAttribute('aria-label', `${text.replace(/\s*↗$/, '')}${NEW_TAB_SUFFIX}`);
    return link;
}

/**
 * The warning under the subject guide while hostname mode holds a real
 * internet TLD or public suffix (0.5.5; the lists are `src/common/publicSuffix.ts`,
 * which the server refuses from too). It offers the same word under `.lan`,
 * which is not delegated. `value` is what the user typed, trimmed; it only
 * ever reaches the page as text.
 */
export function publicSuffixWarning(value: string): string {
    return `"${value}" is an internet domain ending, not a computer's name, so it can't be used. use something like ${value}.lan, or the name your devices use to reach this computer.`;
}

/** The exposure-unavailable notice (I11) with no certificate, and with one but no https listener yet. */
export const EXPOSURE_NEEDS_CERTIFICATE = 'needs a certificate first.';
export const EXPOSURE_NEEDS_RESTART = 'restart the server first.';

/** The Dependencies tab's id in the Settings dialog (SettingsModal.ts), where mkcert is installed. */
export const DEPENDENCIES_TAB_ID = 'dependencies';

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
 * The orange callout at the very top of the Local HTTPS tab, above its
 * heading, while mkcert is not installed (0.5.3 put it at the top of the
 * section; after 0.5.3 it is a boxed callout above the heading, with
 * "dependencies tab" a link to that tab). It names only what mkcert gates --
 * generate and the subject controls (applyMkcertGate) -- since the exposure
 * modes, revoke and the ca download all work without it. This is the
 * callout's whole textContent, link included.
 */
export const MKCERT_MISSING_NOTICE =
    'install mkcert from the dependencies tab to generate a certificate, which is what turns https on. until then, the certificate controls below are unavailable; the other settings on this tab still work.';

/** The words of MKCERT_MISSING_NOTICE that are the link to the Dependencies tab. */
const MKCERT_NOTICE_LINK_TEXT = 'dependencies tab';

/**
 * Build the mkcert callout: MKCERT_MISSING_NOTICE with its "dependencies tab"
 * words as an in-page link, a `<button>` (it acts in the dialog rather than
 * navigating) styled as a link, so it is reachable from the keyboard.
 */
function buildMkcertCallout(showTab: ((id: string) => void) | undefined): HTMLParagraphElement {
    const callout = document.createElement('p');
    callout.className = 'settings-callout';
    callout.setAttribute('data-tls-mkcert-notice', '');
    callout.hidden = true;
    const at = MKCERT_MISSING_NOTICE.indexOf(MKCERT_NOTICE_LINK_TEXT);
    callout.appendChild(document.createTextNode(MKCERT_MISSING_NOTICE.slice(0, at)));
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'settings-inline-link';
    link.setAttribute('data-tls-mkcert-link', '');
    link.textContent = MKCERT_NOTICE_LINK_TEXT;
    link.addEventListener('click', () => showTab?.(DEPENDENCIES_TAB_ID));
    callout.appendChild(link);
    callout.appendChild(document.createTextNode(MKCERT_MISSING_NOTICE.slice(at + MKCERT_NOTICE_LINK_TEXT.length)));
    return callout;
}

/**
 * Dispatched (bubbling) from the panel's section after a certificate is
 * generated or revoked. The Settings dialog listens for it on itself and has
 * the Server tab re-read /api/tls/state, whose https port is enabled only while
 * a certificate exists -- the same shape as DependencyPanel.ts's
 * DEPENDENCY_INSTALLED_EVENT.
 */
export const TLS_CERT_CHANGED_EVENT = 'ws-tls-cert-changed';

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
 * Deliberately does NOT touch `StagedSettingsStore`. The exposure mode has
 * its OWN dedicated "ok" button and route (task 11) rather than staging into
 * the dialog's batch Save: it takes effect at once and needs no restart, so
 * holding it for Save would only delay it. The https port, which this panel
 * also held until after 0.5.3, is a staged field on the Server tab now
 * (`httpsPort`, SettingsBatchApi), beside the http port it must not equal.
 *
 * - The exposure "ok" button POSTs `{ mode }` to `POST /api/tls/exposure`,
 *   which writes `HTTP_EXPOSURE_KEY` straight to `app_settings`.
 *   `HttpServer.ts`'s `readHttpExposure()` reads that key FRESH on every
 *   plain-HTTP request, so this takes effect for the very next request --
 *   no restart. (It still handles a 404 gracefully below, from before this
 *   route existed -- harmless now, and cheap insurance against a client
 *   talking to an older server.)
 *
 * Three cards since 0.5.5, under their own headings in place of the tab
 * title: Certificate (the subject, then the certificate and every notice about
 * it), Trust (the root ca download and its help line) and Exposure (the
 * plain-http mode and its notices). The mkcert callout stays above them all.
 *
 * Every notice in here is one of two kinds, and each renders differently
 * (this repo's convention -- see TRANSIENT_ALERT_*_MS above):
 * - TRANSIENT OUTCOMES (a generate/download/exposure-save result) -- one
 *   shared alert at the bottom of the tab, below the cards, auto-hiding
 *   after 5s/10s.
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

    const { section } = buildSplitSection('Local HTTPS');
    const certificateCard = addCard(section, 'Certificate');
    const trustCard = addCard(section, 'Trust');
    const exposureCard = addCard(section, 'Exposure');

    // 0.5.1: generate needs mkcert, and installing it is the Dependencies
    // tab's job (its install button). Until then generate and the subject
    // controls that only feed it are disabled (applyMkcertGate below), and this
    // says why. It is the first thing a user without mkcert needs to read, so
    // it is the tab's FIRST element: a boxed callout above the cards (and the
    // tab's hidden title), in the warning (orange) tone, whose "dependencies
    // tab" words take them to that tab. Revoke, the ca download and the
    // exposure modes need no mkcert, so they stay as they are.
    const mkcertNotice = buildMkcertCallout(deps.showTab);
    section.insertBefore(mkcertNotice, section.firstChild);

    // ---- subject: ip vs hostname, and the value itself ----
    const subjectInput = document.createElement('input');
    subjectInput.type = 'text';
    subjectInput.className = 'settings-input';
    subjectInput.setAttribute('data-tls-subject', '');
    // Its small visible label went with the subject's second line (0.5.5);
    // the row's "certificate subject" names it to the eye, this to everyone.
    subjectInput.setAttribute('aria-label', 'certificate subject');
    subjectInput.spellcheck = false;

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
    // LAN can use, exactly the failure spec §6 warns about. Picking an
    // option only fills `subjectInput`, which stays the single source of
    // truth for generate/validation/notification 4, so nothing downstream
    // changes.
    //
    // Since 0.5.5 the box itself is the picker: a combobox whose ▾ lists every
    // candidate, whatever the box holds (Combobox.ts says why a native
    // datalist would not do), in place of a separate select on a second line.
    //
    // This code makes NO assumption about the ORDER `candidateIps` arrives
    // in -- it renders whatever order it receives and defaults to the first
    // entry (matching the existing pre-I7 prefill behavior). Which
    // candidate is preferred (spec §6: the default-route interface) is
    // decided server-side, wherever `candidateIps` is actually resolved for
    // the response this panel reads (see `TlsCertState.candidateIps`'s own
    // doc comment) -- that can change its ordering with zero changes needed
    // here.
    const subjectCombo = buildCombobox({ input: subjectInput, buttonLabel: "this computer's addresses" });
    subjectCombo.list.setAttribute('data-tls-candidate-list', '');
    subjectCombo.button.setAttribute('data-tls-candidate-button', '');
    subjectCombo.setOptions(initialCandidateIps);

    // Remembers each mode's last value across a radio flip, so switching kind
    // and back doesn't lose what was typed (or picked).
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
        updateSubjectMode();
    });
    hostRadio.addEventListener('click', () => {
        if (!hostRadio.checked) return;
        lastIpValue = subjectInput.value;
        subjectInput.value = lastHostValue;
        updateSubjectMode();
    });
    subjectInput.addEventListener('input', () => updateSubjectCheck());

    // One line since 0.5.5: the radios, then the one box beside them.
    const subjectFrag = document.createDocumentFragment();
    subjectFrag.append(ipLabel, hostLabel, subjectCombo.root);
    const subjectRow = buildRow('certificate subject', subjectFrag);

    // Notification 2 — ALWAYS shown, beside the subject controls: what each
    // subject choice means, in the terms of the two radios just above. Until
    // 0.5.1 this was a sentence about `allowedHosts`, a config.json key no
    // control in this dialog is labeled with, so it explained nothing to
    // anyone choosing between the radios. Not conditional on anything: it is
    // guidance for the choice, not a mistake state.
    const subjectGuideNotice = document.createElement('p');
    subjectGuideNotice.className = 'settings-status';
    subjectGuideNotice.style.gridColumn = '1 / -1';
    subjectGuideNotice.setAttribute('data-tls-subject-guide', '');
    // 0.5.3: one short line and a link to a page with room to explain it
    // (public/help/certificate-subject.html), instead of a two-sentence
    // summary squeezed under the radios. Relative, like TRUST_HELP_HREF. Its
    // lead follows the chosen kind (updateSubjectMode).
    const subjectGuideLead = document.createTextNode(SUBJECT_GUIDE_IP_TEXT);
    subjectGuideNotice.append(subjectGuideLead, buildHelpLink(SUBJECT_HELP_HREF, SUBJECT_HELP_LINK_TEXT));

    // 0.5.5: one-word names are allowed unless they are a real internet TLD;
    // a TLD, or a public suffix like co.uk, is the one name the server refuses
    // for being too broad (src/common/publicSuffix.ts, the lists the server
    // uses). Said while it is typed, and generate waits for a usable name,
    // rather than a round trip ending in "that name could not be used" with no
    // reason given.
    const subjectSuffixWarning = buildNoticeRow();
    subjectSuffixWarning.setAttribute('data-tls-subject-suffix-warning', '');
    // Set by updateSubjectCheck; one of generate's three gates (applyGenerateGate).
    let subjectRefused = false;

    certificateCard.appendChild(buildItem(subjectRow, subjectGuideNotice, subjectSuffixWarning));

    // The https port that sat here until after 0.5.3 is on the Server tab now,
    // staged for the dialog's Save beside the http port (ServerTab.ts).

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
    // The certificate's item: the row, then every notice about the certificate
    // (appended below as each is built).
    const certificateItem = buildItem(buildRow('certificate', certActionsFrag));
    certificateCard.appendChild(certificateItem);

    // A generate in flight holds its button down; a re-check landing
    // meanwhile must not release it.
    let generating = false;
    /**
     * Generate's three gates in ONE expression -- mkcert missing, a generate
     * in flight, a public-suffix name -- so lifting one can never re-enable a
     * button another still holds. Every path that changes any of them ends
     * here rather than setting `disabled` itself.
     */
    function applyGenerateGate(): void {
        generateBtn.disabled = mkcertMissing || generating || subjectRefused;
    }
    function applyMkcertGate(): void {
        applyGenerateGate();
        ipRadio.disabled = mkcertMissing;
        hostRadio.disabled = mkcertMissing;
        subjectInput.disabled = mkcertMissing;
        subjectCombo.button.disabled = mkcertMissing;
        if (mkcertMissing) subjectCombo.close();
        // Shown and hidden, never emptied: its text, link and all, is fixed.
        mkcertNotice.hidden = !mkcertMissing;
    }

    /**
     * Show or clear the public-suffix warning for what the box holds now
     * (never in ip mode: an address is no suffix), and re-apply generate's gates.
     */
    function updateSubjectCheck(): void {
        const value = subjectInput.value.trim();
        const refused = hostRadio.checked && isPublicSuffix(value);
        subjectRefused = refused;
        setNotice(subjectSuffixWarning, refused ? publicSuffixWarning(value) : null);
        applyGenerateGate();
    }

    /**
     * Fit the subject to the chosen kind: with ip address, the box offers this
     * computer's addresses (its ▾, when there are any) and asks for an
     * address; with hostname, a plain box asking for a name. The guide's lead
     * and the public-suffix check follow.
     */
    function updateSubjectMode(): void {
        const ip = ipRadio.checked;
        subjectCombo.setListAvailable(ip);
        subjectInput.placeholder = ip ? 'ip address' : 'hostname or domain name';
        subjectGuideLead.textContent = ip ? SUBJECT_GUIDE_IP_TEXT : SUBJECT_GUIDE_HOSTNAME_TEXT;
        updateSubjectCheck();
    }
    updateSubjectMode();
    applyMkcertGate();

    // ---- current-certificate summary + notifications 3, 4, 8, 9 ----
    const certSummary = document.createElement('p');
    certSummary.className = 'settings-status';
    certSummary.style.gridColumn = '1 / -1';
    certificateItem.appendChild(certSummary);

    // C1: listener truth, ahead of everything else about the certificate --
    // this is the thing that was silently wrong. See listenerStatusNotice's
    // own doc comment for the four cases it covers and why 'unknown' says
    // nothing rather than guessing.
    const listenerStatusNoticeEl = buildNoticeRow();
    listenerStatusNoticeEl.setAttribute('data-tls-listener-notice', '');
    certificateItem.appendChild(listenerStatusNoticeEl);

    const untrustedCaNotice = buildNoticeRow();
    untrustedCaNotice.setAttribute('data-tls-ca-trust-notice', '');
    certificateItem.appendChild(untrustedCaNotice);
    const mismatchNotice = buildNoticeRow();
    mismatchNotice.setAttribute('data-tls-mismatch-notice', '');
    certificateItem.appendChild(mismatchNotice);
    const hostnameGuideNotice = buildNoticeRow();
    hostnameGuideNotice.setAttribute('data-tls-hostname-notice', '');
    certificateItem.appendChild(hostnameGuideNotice);
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
    certificateItem.appendChild(allowedHostPersistentNotice);
    const expiryNotice = buildNoticeRow();
    expiryNotice.setAttribute('data-tls-expiry-notice', '');
    certificateItem.appendChild(expiryNotice);
    const caRestoreNotice = buildNoticeRow();
    caRestoreNotice.setAttribute('data-tls-ca-restore-notice', '');
    certificateItem.appendChild(caRestoreNotice);

    // ---- download CA (a .crt holding the PEM, since 0.5.3) ----
    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'settings-btn';
    downloadBtn.textContent = 'download ca certificate';
    downloadBtn.setAttribute('data-tls-download', '');

    // 0.5.3: the per-device install steps moved to the help page (section 4 of
    // certificate-subject.html), which has room for each OS's real steps and
    // the Firefox one. The panel keeps one line pointing there.
    const trustHelp = document.createElement('p');
    trustHelp.className = 'settings-status';
    trustHelp.style.gridColumn = '1 / -1';
    trustHelp.setAttribute('data-tls-trust-help', '');
    trustHelp.append(TRUST_HELP_TEXT, buildHelpLink(TRUST_HELP_HREF, TRUST_HELP_LINK_TEXT));
    const trustItem = buildItem(buildRow('root ca', downloadBtn), trustHelp);
    trustCard.appendChild(trustItem);

    function renderCertState(state: TlsCertState): void {
        const candidateIps = candidateIpsFor(state);
        if (state.status !== 'ready') {
            // Nothing to say without a certificate: the line is for one's
            // details, and "no certificate yet." told the user nothing the
            // disabled revoke and download did not (0.5.5).
            certSummary.textContent = '';
            certSummary.hidden = true;
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
        certSummary.hidden = false;
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

    // One shared alert for every transient outcome (generate succeeded/failed,
    // revoke, CA download succeeded/failed, exposure save succeeded/failed) --
    // see the class doc above for why this is one element rather than a
    // status line per button. It sits in ONE fixed place, the bottom of the
    // tab, below and outside all three cards, so it never reads as part of the
    // last card (Exposure) whichever action raised it.
    //
    // M5: appended DIRECTLY into the section, never through `buildRow()` --
    // deliberately, not by accident. `modal.css`'s
    // `.settings-row:has(.settings-status-error) { display: flex; ... }`
    // targets `.settings-row`, and `transientAlert` toggles
    // `.settings-status-error` on itself (see `showTransientAlert`). Wrapping
    // this element in a `.settings-row` the way every control here is wrapped
    // would make that rule match it on an error, overriding the row's normal
    // `display: contents` and changing its layout -- a near-miss on the same
    // "a rule silently starts matching an element it wasn't written for" class
    // of bug the `[hidden]` reassertion in modal.css guards against. If a
    // future change wraps this in a row, that CSS rule needs handling at the
    // same time, not discovered by an unexplained layout shift the next time
    // an error fires.
    const transientAlert = document.createElement('p');
    transientAlert.className = 'settings-status settings-tab-alert';
    transientAlert.setAttribute('data-tls-alert', '');
    transientAlert.hidden = true;
    // Last: every card is already in the section (they are added above, before any is filled).
    section.appendChild(transientAlert);
    let transientAlertTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Show the tab's one alert for `TRANSIENT_ALERT_SUCCESS_MS` (5 s) after a
     * success and `TRANSIENT_ALERT_ERROR_MS` (10 s) after an error; a new one
     * replaces the old one and restarts the clock.
     *
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
            // The button is disabled while mkcert is missing or the name is a
            // public suffix; a click queued before the gate applied must not
            // send anyway.
            if (mkcertMissing || subjectRefused) return;
            const kind: 'ip' | 'hostname' = hostRadio.checked ? 'hostname' : 'ip';
            const value = subjectInput.value.trim();
            if (!value) {
                showTransientAlert('error', 'enter an ip address or hostname first.');
                return;
            }
            generating = true;
            applyGenerateGate();
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
                    // The server's own reason, which names a name or an address
                    // by `kind`; when it gave none, the very copy it sends for a
                    // refused subject (src/common/refusedSubject.ts).
                    showTransientAlert('error', data?.error ?? refusedSubjectMessage(kind));
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
                section.dispatchEvent(new CustomEvent(TLS_CERT_CHANGED_EVENT, { bubbles: true }));
                // Resolved Decision 2: state the allowedHosts edit plainly
                // rather than mutate it silently. This is a one-time outcome
                // of THIS generate, not a standing condition, so it belongs in
                // the transient alert, not a persistent in-panel notice. It
                // says what the edit does for the user, not the config key's
                // name (no control in Settings is labeled allowedHosts).
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
                applyGenerateGate();
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
                section.dispatchEvent(new CustomEvent(TLS_CERT_CHANGED_EVENT, { bubbles: true }));
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
        // One line each (0.5.5): the row's label and the notices below say the rest.
        { value: 'open', label: 'open' },
        { value: 'httpsOnly', label: 'https only' },
        { value: 'redirect', label: 'redirect to https' },
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
    // The exposure's item: the row and its three notices.
    const exposureItem = buildItem(buildRow('plain http exposure', exposureFrag));
    exposureCard.appendChild(exposureItem);

    const exposureLockoutNotice = buildNoticeRow();
    exposureLockoutNotice.setAttribute('data-exposure-lockout-notice', '');
    exposureItem.appendChild(exposureLockoutNotice);
    const exposureRestartNotice = buildNoticeRow();
    exposureRestartNotice.setAttribute('data-exposure-restart-notice', '');
    exposureItem.appendChild(exposureRestartNotice);
    // I11: narrowing plain HTTP toward an HTTPS listener that does not exist
    // yet does nothing at runtime (`findHttpsPort()` returns `undefined` and
    // every mode fails open -- the correct, deliberate lockout guarantee,
    // ruling E2) -- but the panel still told the user their server WAS now
    // HTTPS-only. `updateExposureAvailability` below disables httpsOnly/
    // redirect (never 'open', which is always safe) until a certificate
    // exists, and this note explains why.
    const exposureUnavailableNotice = buildNoticeRow();
    exposureUnavailableNotice.setAttribute('data-exposure-unavailable-notice', '');
    exposureItem.appendChild(exposureUnavailableNotice);

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
        // Short since 0.5.5: the radios it explains are right above it, disabled.
        setNotice(
            exposureUnavailableNotice,
            listenerBound ? null : hasCert ? EXPOSURE_NEEDS_RESTART : EXPOSURE_NEEDS_CERTIFICATE,
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
    const { section, card } = buildSection('Local HTTPS');
    section.setAttribute('data-local-https-container-note', '');
    const note = document.createElement('p');
    note.className = 'settings-status';
    note.style.gridColumn = '1 / -1';
    note.textContent =
        "local HTTPS doesn't apply in a container. serve HTTPS from a reverse proxy in front of the container — that is the only supported way to add HTTPS to the image.";
    card.appendChild(buildItem(note));
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
const serviceStatusFailureAppliers = new WeakMap<HTMLElement, (retry: () => void) => void>();
const containerModeAppliers = new WeakMap<HTMLElement, () => void>();
const dependencyInstalledAppliers = new WeakMap<HTMLElement, () => Promise<void>>();

/**
 * The Local HTTPS tab (admin-only; `/api/tls/*` is admin-gated server-side).
 * Until 0.5.3 this was a second section at the bottom of the Server tab.
 *
 * Builds synchronously and fires no network request of its own. What it shows
 * is decided from outside, once `SettingsModal` knows:
 * - on a host, `applyLocalHttpsServiceStatus()` builds the panel the first time
 *   the /api/service/status response the Service tab fetched arrives -- the
 *   moment SettingsModal knows this is not a container (the panel's sub-1024
 *   port notice, which also needed that response's platform, left with the
 *   https port for the Server tab);
 * - in a container, `applyLocalHttpsContainerMode()` shows ONLY the
 *   reverse-proxy note (Local HTTPS is not supported there, user decision
 *   2026-09-30), and a later service status never builds the panel over it.
 *
 * Until either arrives the tab holds a placeholder section under the same
 * heading; if the status read fails, `applyLocalHttpsServiceStatusFailed()`
 * turns that placeholder into "couldn't reach server" with a retry button. The root is a plain `<div>`, not a `.settings-section`, so exactly one
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
    const loadingItem = buildItem(loading);
    placeholder.card.appendChild(loadingItem);
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

    // The response itself is not read: its arrival is the signal (a host, not
    // a container). Its platform fed the sub-1024 port notice, which left with
    // the https port for the Server tab after 0.5.3.
    function applyServiceStatus(_resp: ServiceStatusResponse): void {
        if (decided) return;
        decided = true;
        void buildLocalHttpsPanel({
            // C1: wrapped, not passed by reference -- an unbound `fetch` throws
            // "Illegal invocation" in Chrome (same precedent as
            // NetworkDiscoveryPanel.ts's renderPairingSection call).
            fetchFn: (...args: Parameters<typeof fetch>) => fetch(...args),
            // Always [] in production: GET /api/tls/state itself returns the
            // real candidateIps (Task 5's amendment (b)), which
            // buildLocalHttpsPanel prefers over this fallback.
            candidateIps: [],
            askChild: ctx.askChild,
            // The mkcert callout's link to the Dependencies tab.
            ...(ctx.showTab ? { showTab: ctx.showTab } : {}),
        }).then((built) => {
            panel = built;
            root.replaceChildren(built);
        });
    }

    /**
     * The /api/service/status read this tab waits on failed (0.5.3 review, M3).
     * Until then the placeholder said "loading…" forever. Shows what the
     * Service tab shows for the same failure -- "couldn't reach server" in the
     * error tone, with a retry button -- and the retry re-runs that same shared
     * read (`retry`, from the Service tab), whose success builds the panel here
     * through `applyServiceStatus` and whose failure lands back here. A no-op
     * once the tab has been decided.
     */
    function applyServiceStatusFailed(retry: () => void): void {
        if (decided) return;
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'settings-btn';
        retryBtn.textContent = 'retry';
        retryBtn.setAttribute('data-local-https-retry', '');
        retryBtn.addEventListener('click', () => {
            placeholder.card.replaceChildren(loadingItem);
            retry();
        });
        const row = buildRow("couldn't reach server", retryBtn);
        row.querySelector('.settings-label')?.classList.add('settings-status-error');
        placeholder.card.replaceChildren(buildItem(row));
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
    serviceStatusFailureAppliers.set(root, applyServiceStatusFailed);
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
 * Tell a Local HTTPS tab that the /api/service/status read it waits on failed:
 * it shows "couldn't reach server" with a retry button that calls `retry` (the
 * Service tab's refresh), instead of "loading…" forever. A no-op if `tab` was
 * never built through `buildLocalHttpsTab`, or once the tab has been decided.
 */
export function applyLocalHttpsServiceStatusFailed(tab: HTMLElement, retry: () => void): void {
    serviceStatusFailureAppliers.get(tab)?.(retry);
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
