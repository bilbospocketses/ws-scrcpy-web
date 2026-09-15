import type { FirstRunStatus } from '../../common/ConfigEvents';
import { type DependencyInfo, DependencyStatus } from '../../common/DependencyTypes';
import type { Role } from './AuthClient';
import { adminApiReachable, canSeeSection } from './adminGate';
import { SettingsModal } from './SettingsModal';

const POLL_INTERVAL_MS = 15_000;

/**
 * The home page's dependency notice, all that is left there now the panel
 * itself lives in Settings → Dependencies.
 *
 * It is an ALERT, not a list: it stays hidden until something actually needs
 * updating, and says only which dependency that is plus a way to go and do it.
 * A permanent table of up-to-date versions is what the tab is for.
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

    constructor() {
        this.container = document.createElement('div');
        this.container.className = 'home-section dependency-alert';
        this.container.hidden = true;

        const heading = document.createElement('h2');
        heading.textContent = 'Dependencies';
        this.container.appendChild(heading);

        const card = document.createElement('div');
        card.className = 'section-card';

        this.text = document.createElement('span');
        this.text.className = 'dependency-alert-text';
        card.appendChild(this.text);

        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'dep-btn dependency-alert-open';
        openBtn.textContent = 'open dependencies';
        // Opens the dialog ON the Dependencies tab. Dropping the user on
        // whichever tab happens to be first and letting them hunt for the one
        // the card just told them about is the whole difference between a link
        // and a signpost.
        openBtn.addEventListener('click', () => {
            new SettingsModal({ initialTab: 'dependencies' });
        });
        card.appendChild(openBtn);

        this.container.appendChild(card);
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
     * Dependencies is replaced by a note saying so. An alert card offering to
     * open a tab that cannot act would be a signpost to a dead end, and its
     * "open dependencies" button lands on exactly that note.
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
        // textContent, never innerHTML: displayName is server-supplied.
        this.text.textContent =
            pending.length === 1 ? `${names} has an update available. ` : `${names} have updates available. `;
        this.container.hidden = false;
    }
}
