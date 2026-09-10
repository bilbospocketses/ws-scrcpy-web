import type { FirstRunStatus } from '../../common/ConfigEvents';

const POLL_INTERVAL_MS = 30_000;

export type BannerState = 'hidden' | 'local-actionable' | 'local-readonly' | 'remote-warning';

/**
 * Which banner, if any, this envelope calls for.
 *
 * `adminScope` absent means a server older than the guard: show nothing rather than claim a posture
 * we cannot verify. Pure and exported so the decision is testable without a DOM.
 */
export function bannerStateFor(runtime: FirstRunStatus): BannerState {
    switch (runtime.adminScope) {
        case 'authenticated':
            return 'hidden';
        case 'remote':
            return 'remote-warning';
        case 'local':
            return runtime.callerIsLocal ? 'local-actionable' : 'local-readonly';
        default:
            return 'hidden';
    }
}

/**
 * Tells the user which admin posture the server is in, and offers the two ways out.
 *
 * Informational to everyone, actionable only from loopback. In open mode there is no auth, so a
 * card with a working "enable" button would render for an attacker too — a switch that turns off
 * the lock, mounted on the outside of the door. Remote callers get the same wording and no buttons.
 *
 * Every node is built with createElement/textContent, never innerHTML: the envelope is
 * server-supplied and FirstRunBanner already carries an XSS test for the same reason.
 */
export class AdminScopeBanner {
    private container: HTMLElement;
    private pollHandle: ReturnType<typeof setInterval> | null = null;

    constructor() {
        this.container = document.createElement('div');
        this.container.className = 'admin-scope-banner';
        this.container.style.display = 'none';
    }

    static async create(): Promise<AdminScopeBanner> {
        const banner = new AdminScopeBanner();
        await banner.refresh();
        banner.startPolling();
        return banner;
    }

    /**
     * Mount-friendly sibling of `create()`: kicks off the first refresh and the poll without making
     * the caller await. `index.ts` inserts the element synchronously so the two banners' order is
     * deterministic, then calls this.
     */
    start(): void {
        void this.refresh();
        this.startPolling();
    }

    getElement(): HTMLElement {
        return this.container;
    }

    destroy(): void {
        if (this.pollHandle !== null) {
            clearInterval(this.pollHandle);
            this.pollHandle = null;
        }
    }

    private startPolling(): void {
        if (this.pollHandle !== null) return;
        this.pollHandle = setInterval(() => {
            void this.refresh();
        }, POLL_INTERVAL_MS);
    }

    private async refresh(): Promise<void> {
        try {
            const res = await fetch('/api/config');
            if (!res.ok) return;
            const envelope = (await res.json()) as { runtime: FirstRunStatus };
            this.render(envelope.runtime);
        } catch {
            // A transient fetch failure leaves the previous render in place.
        }
    }

    /** Exported behaviour for tests: render the banner for one envelope. */
    render(runtime: FirstRunStatus): void {
        const state = bannerStateFor(runtime);
        this.container.replaceChildren();
        if (state === 'hidden') {
            this.container.style.display = 'none';
            return;
        }
        this.container.style.display = '';
        this.container.dataset['state'] = state;

        const title = document.createElement('strong');
        const body = document.createElement('p');

        if (state === 'remote-warning') {
            this.container.classList.add('admin-scope-banner--warning');
            title.textContent = 'Remote admin is enabled without sign-in.';
            body.textContent = 'Any device that can reach this server can administer it. Set up sign-in to close this.';
            this.container.append(title, body);
            return;
        }

        this.container.classList.remove('admin-scope-banner--warning');

        if (state === 'local-readonly') {
            title.textContent = 'Admin actions are disabled for remote clients.';
            body.textContent =
                'This server has no sign-in configured. To manage it, open this page on the machine ' +
                'running the server — or set WS_SCRCPY_ALLOW_REMOTE_ADMIN=1.';
            this.container.append(title, body);
            return;
        }

        title.textContent = 'Admin actions are limited to this machine.';
        body.textContent =
            'No sign-in is configured, so anyone on your network can reach this server. Admin ' +
            'actions — users, configuration, shutdown — are restricted to this machine as a result.';

        const actions = document.createElement('div');
        actions.className = 'admin-scope-banner__actions';

        const signIn = document.createElement('button');
        signIn.type = 'button';
        signIn.className = 'admin-scope-banner__primary';
        signIn.textContent = 'Set up sign-in';

        signIn.addEventListener('click', () => {
            void this.onSetUpSignIn();
        });

        const allow = document.createElement('button');
        allow.type = 'button';
        allow.className = 'admin-scope-banner__secondary';
        allow.textContent = 'Allow remote admin without sign-in';
        allow.addEventListener('click', () => {
            void this.onAllowRemoteAdmin();
        });

        actions.append(signIn, allow);
        this.container.append(title, body, actions);
    }

    /**
     * Open the surface that owns sign-in setup.
     *
     * The Users section is that surface: creating the first admin WITH a password is what runs
     * lockdown and flips `authEnabled` (see UsersApi). There is no direct per-section entry point
     * on SettingsModal yet, so this opens Settings and the user lands one scroll away.
     *
     * POST /api/auth/enable is operator-gated, so a remote caller could not complete this even if
     * the button were forged into their page.
     */
    private async onSetUpSignIn(): Promise<void> {
        const { SettingsModal } = await import('./SettingsModal');
        new SettingsModal();
    }

    /**
     * Declining the warning is not a dead end — it routes to the recommended path. The card exists
     * to move people toward sign-in; someone who backs out of the risky option is exactly who
     * should be shown the safe one.
     */
    private async onAllowRemoteAdmin(): Promise<void> {
        const { RemoteAdminWarningModal } = await import('./RemoteAdminWarningModal');
        const accepted = await RemoteAdminWarningModal.confirm();
        if (!accepted) {
            void this.onSetUpSignIn();
            return;
        }
        await fetch('/api/config', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ allowRemoteAdmin: true }),
        });
        await this.refresh();
    }
}
