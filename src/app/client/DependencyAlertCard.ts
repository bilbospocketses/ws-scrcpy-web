import type { FirstRunStatus } from '../../common/ConfigEvents';
import { type DependencyInfo, DependencyStatus } from '../../common/DependencyTypes';
import type { Role } from './AuthClient';
import { adminApiReachable, canSeeSection } from './adminGate';
import { SettingsModal } from './SettingsModal';

const POLL_INTERVAL_MS = 15_000;

/**
 * Hardcoded package icon (constant string, no user input), following the
 * GEAR_SVG_MARKUP pattern in `SettingsHeader.ts` and SUN_SVG / MOON_SVG in
 * `ThemeToggle.ts`. 24x24 viewBox, `currentColor` so it inherits the theme.
 *
 * A BOX rather than the download arrow an app update would suggest: these are
 * the bundled tools the app ships around — adb, scrcpy, node-pty — not a new
 * version of the app itself.
 */
const PACKAGE_SVG_MARKUP = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" ',
    'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ',
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
    '<path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8',
    'a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>',
    '<polyline points="3.27 6.96 12 12.01 20.73 6.96"/>',
    '<line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
].join('');

/**
 * The dependency-update indicator, all that is left on the home page now the
 * panel itself lives in Settings → Dependencies.
 *
 * It is an ALERT, not a list: it stays hidden until something actually needs
 * updating, and says only which dependency that is plus a way to go and do it.
 * A permanent table of up-to-date versions is what the tab is for.
 *
 * It lives in the TOP BAR, beside the app-update pill, and is shaped unlike it
 * on purpose — an icon circle against a text pill. It used to be a
 * `home-section` card appended after the device list and the discovery panel,
 * which put it at the bottom of the page while app updates announced themselves
 * at the top, so a user watching the top bar never learned a dependency needed
 * updating at all. The two kinds of update now sit together and still read as
 * two different things.
 *
 * Modelled on `FirstRunBanner` — same admin gate, same poll interval, same
 * "an error hides the notice rather than replacing it with an error" posture.
 * The two are complementary and never say the same thing: the banner reports a
 * dependency that never downloaded, this reports one that has a newer version.
 */
export class DependencyAlertCard {
    private readonly container: HTMLElement;
    private readonly text: HTMLElement;
    private pollHandle: ReturnType<typeof setInterval> | null = null;

    private readonly button: HTMLButtonElement;

    constructor() {
        this.container = document.createElement('div');
        // NOT `home-section`: this is a top-bar indicator, sharing the fixed
        // cluster with the theme toggle, the gear and the app-update pill. It
        // kept a wrapper rather than becoming the button itself so `hidden`
        // still belongs to one element the mount site can reason about.
        this.container.className = 'dependency-alert-badge';
        this.container.hidden = true;

        this.button = document.createElement('button');
        this.button.type = 'button';
        this.button.className = 'dependency-alert-open';
        // Safe: PACKAGE_SVG_MARKUP is a hardcoded constant with no
        // interpolation — the same argument SettingsHeader makes for its gear.
        this.button.innerHTML = PACKAGE_SVG_MARKUP;

        // The icon carries the meaning visually; this carries it for a screen
        // reader and for `title`. It is visually hidden rather than absent
        // because an icon-only control that says "dependencies need updating"
        // to nobody is an accessibility regression, and because WHICH
        // dependency is the only detail the badge has to give.
        this.text = document.createElement('span');
        this.text.className = 'visually-hidden';
        this.button.appendChild(this.text);

        // Opens the dialog ON the Dependencies tab. Dropping the user on
        // whichever tab happens to be first and letting them hunt for the one
        // the badge just told them about is the whole difference between a link
        // and a signpost.
        this.button.addEventListener('click', () => {
            new SettingsModal({ initialTab: 'dependencies' });
        });

        this.container.appendChild(this.button);
    }

    /**
     * `runtime` is the envelope from GET /api/config.
     *
     * THREE independent questions. `canSeeSection` asks whether this ROLE may
     * use the section; `adminApiReachable` asks whether the admin API will
     * answer THIS caller at all. GET /api/dependencies is gated at the top
     * of its handler, so failing either means mounting inert -- no fetch, no
     * interval. Polling anyway 403-spams a healthy app and renders an error
     * to a user who has done nothing wrong: finding 9.6.
     *
     * `runtime.docker` is the third (item 135), and it is not an admin question
     * at all: in a container the image owns the dependency set, so Settings ->
     * Dependencies is replaced by a note saying so. An indicator offering to
     * open a tab that cannot act would be a signpost to a dead end, and its
     * button lands on exactly that note.
     *
     * Kept here rather than at the mount site in index.ts so there is still
     * exactly ONE copy of the decision (finding 9.6's whole point), and read off
     * the same `/api/config` runtime envelope `SettingsModal.probeRuntime()`
     * uses -- the flag is an env implication the server never persists to
     * config.json, so the envelope is the only source.
     *
     * Fails OPEN on an absent flag, like the two above and like
     * `SettingsModal`: `docker` is optional on the envelope, an old server does
     * not send it, and the answer that shows MORE is the right one for a
     * transient failure.
     */
    static async create(
        runtime: Pick<FirstRunStatus, 'adminScope' | 'callerIsLocal' | 'docker'>,
        role: Role | null,
    ): Promise<DependencyAlertCard> {
        const card = new DependencyAlertCard();
        if (!canSeeSection(role, 'dependencies') || !adminApiReachable(runtime)) return card;
        if (runtime.docker === true) return card;
        await card.refresh();
        card.startPolling();
        return card;
    }

    getElement(): HTMLElement {
        return this.container;
    }

    /**
     * Tear down: stop the background poll interval so it doesn't keep firing
     * (and keep this instance alive) after the card is removed from the DOM.
     */
    destroy(): void {
        this.stopPolling();
    }

    private startPolling(): void {
        if (this.pollHandle !== null) return;
        // Deliberately unconditional, unlike FirstRunBanner's self-stopping
        // poll: a dependency that is up to date now grows an update later, and
        // this card is the only place the home page would ever say so.
        this.pollHandle = setInterval(() => {
            void this.refresh();
        }, POLL_INTERVAL_MS);
    }

    private stopPolling(): void {
        if (this.pollHandle !== null) {
            clearInterval(this.pollHandle);
            this.pollHandle = null;
        }
    }

    private async refresh(): Promise<void> {
        try {
            const res = await fetch('/api/dependencies');
            // `fetch` resolves normally for a 403 — the same trap Task 10 fixed in
            // `runSave`. Without this the card hid a refused read only because
            // `.filter` threw on the error object below, which is correctness by
            // accident: a server that answered 403 with a JSON array would render
            // an alert out of it.
            if (!res.ok) {
                this.container.hidden = true;
                return;
            }
            const deps: DependencyInfo[] = await res.json();
            this.render(deps.filter((d) => d.status === DependencyStatus.UpdateAvailable));
        } catch {
            // Hide rather than report. An unreachable dependency API says
            // nothing about whether an update is waiting, and an error box on
            // the home page reads as a broken app (finding 9.6 again).
            this.container.hidden = true;
        }
    }

    private render(pending: DependencyInfo[]): void {
        if (pending.length === 0) {
            this.container.hidden = true;
            return;
        }
        const names = pending.map((d) => d.displayName).join(', ');
        const label = pending.length === 1 ? `${names} has an update available` : `${names} have updates available`;
        // textContent and setAttribute, never innerHTML: displayName is
        // server-supplied. (The icon above is the only markup here, and it is a
        // constant.)
        this.text.textContent = label;
        // `title` for the pointer, `aria-label` for assistive tech. Both name
        // the dependency: an indicator that only says "something needs
        // updating" makes the user open the dialog to find out what, which is
        // the click this badge exists to make unnecessary.
        this.button.title = label;
        this.button.setAttribute('aria-label', label);
        this.container.hidden = false;
    }
}
