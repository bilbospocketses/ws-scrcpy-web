import type { DependencyInfo } from '../../common/DependencyTypes';
import { DependencyStatus } from '../../common/DependencyTypes';

const POLL_INTERVAL_MS = 15_000;

export class FirstRunBanner {
    private container: HTMLElement;
    private retryButton: HTMLButtonElement | null = null;
    private pollHandle: ReturnType<typeof setInterval> | null = null;

    constructor() {
        this.container = document.createElement('div');
        this.container.className = 'first-run-banner';
        this.container.style.display = 'none';
    }

    static async create(): Promise<FirstRunBanner> {
        const banner = new FirstRunBanner();
        await banner.refresh();
        banner.startPolling();
        return banner;
    }

    getElement(): HTMLElement {
        return this.container;
    }

    private startPolling(): void {
        if (this.pollHandle !== null) return;
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
            const deps: DependencyInfo[] = await res.json();
            const pending = FirstRunBanner.pendingDeps(deps);
            if (pending.length === 0) {
                this.container.style.display = 'none';
                this.stopPolling();
                return;
            }
            this.render(pending);
        } catch {
            this.container.style.display = 'none';
        }
    }

    private static pendingDeps(deps: DependencyInfo[]): DependencyInfo[] {
        return deps.filter(
            (d) =>
                d.installedVersion === null &&
                (d.status === DependencyStatus.Error || d.status === DependencyStatus.Unknown),
        );
    }

    private render(pending: DependencyInfo[]): void {
        const names = pending.map((d) => d.displayName).join(', ');
        this.container.innerHTML = `
            <div class="first-run-banner-inner">
                <span class="first-run-banner-icon">⚠</span>
                <span class="first-run-banner-text"></span>
                <button class="first-run-banner-retry" type="button">Retry</button>
            </div>
        `;
        // Inject the (server-supplied) dependency names as text, never as markup.
        const textEl = this.container.querySelector('.first-run-banner-text');
        if (textEl) {
            textEl.textContent = `Setup incomplete — ${names} failed to download. Check your network connection.`;
        }
        this.retryButton = this.container.querySelector('.first-run-banner-retry');
        this.retryButton?.addEventListener('click', () => this.onRetry());
        this.container.style.display = 'block';
    }

    private async onRetry(): Promise<void> {
        if (!this.retryButton) return;
        const btn = this.retryButton;
        const originalText = btn.textContent ?? 'Retry';
        btn.disabled = true;
        btn.textContent = 'Retrying…';
        try {
            await fetch('/api/dependencies/retry-install', { method: 'POST' });
        } catch {
            // Swallow fetch errors — we refresh below and re-render from truth.
        }
        btn.disabled = false;
        btn.textContent = originalText;
        await this.refresh();
    }
}
