import type { DependencyInfo } from '../../common/DependencyTypes';
import { DependencyStatus } from '../../common/DependencyTypes';

// biome-ignore lint/correctness/noUnusedVariables: Declared for documentation purposes; response is discarded
interface RetryResponse {
    success: boolean;
    installed: string[];
    stillMissing: string[];
    errors: Record<string, string>;
}

export class FirstRunBanner {
    private container: HTMLElement;
    private retryButton: HTMLButtonElement | null = null;

    constructor() {
        this.container = document.createElement('div');
        this.container.className = 'first-run-banner';
        this.container.style.display = 'none';
    }

    static async create(): Promise<FirstRunBanner> {
        const banner = new FirstRunBanner();
        await banner.refresh();
        return banner;
    }

    getElement(): HTMLElement {
        return this.container;
    }

    private async refresh(): Promise<void> {
        try {
            const res = await fetch('/api/dependencies');
            const deps: DependencyInfo[] = await res.json();
            const pending = FirstRunBanner.pendingDeps(deps);
            if (pending.length === 0) {
                this.container.style.display = 'none';
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
                d.status === DependencyStatus.Error ||
                (d.status === DependencyStatus.Unknown && d.installedVersion === null),
        );
    }

    private render(pending: DependencyInfo[]): void {
        const names = pending.map((d) => d.displayName).join(', ');
        this.container.innerHTML = `
            <div class="first-run-banner-inner">
                <span class="first-run-banner-icon">⚠</span>
                <span class="first-run-banner-text">
                    Setup incomplete — ${names} failed to download. Check your network connection.
                </span>
                <button class="first-run-banner-retry" type="button">Retry</button>
            </div>
        `;
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
