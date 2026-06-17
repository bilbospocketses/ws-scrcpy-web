import type { DependencyInfo, UpdateResult } from '../../common/DependencyTypes';
import { escapeHtml } from '../htmlEscape';

const POLL_INTERVAL_MS = 15_000;

export class DependencyPanel {
    private container: HTMLElement;
    private tableBody: HTMLTableSectionElement | null = null;
    private pollHandle: ReturnType<typeof setInterval> | null = null;
    private busy = false;
    private restarting = false;

    constructor() {
        this.container = document.createElement('div');
        this.container.id = 'dependency-panel';
        this.container.className = 'home-section';
        this.container.innerHTML = `
            <div class="dep-header">
                <h2>Dependencies</h2>
                <button class="dep-btn dep-check-all">check for updates</button>
            </div>
            <div class="section-card">
                <table class="dep-table">
                    <thead>
                        <tr>
                            <th>Dependency</th>
                            <th>Installed</th>
                            <th>Latest</th>
                            <th>Status</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody></tbody>
                </table>
            </div>
        `;
        this.tableBody = this.container.querySelector('tbody');
        this.container.querySelector('.dep-check-all')!.addEventListener('click', () => this.checkAll());
    }

    static async create(): Promise<DependencyPanel> {
        const panel = new DependencyPanel();
        await panel.load();
        panel.startPolling();
        return panel;
    }

    getElement(): HTMLElement {
        return this.container;
    }

    /**
     * Tear down: stop the background poll interval so it doesn't keep firing
     * (and keep this instance alive) after the panel is removed from the DOM.
     */
    destroy(): void {
        this.stopPolling();
    }

    private startPolling(): void {
        if (this.pollHandle !== null) return;
        this.pollHandle = setInterval(() => {
            if (this.busy || this.restarting) return;
            void this.load();
        }, POLL_INTERVAL_MS);
    }

    private stopPolling(): void {
        if (this.pollHandle !== null) {
            clearInterval(this.pollHandle);
            this.pollHandle = null;
        }
    }

    private async load(): Promise<void> {
        try {
            const res = await fetch('/api/dependencies');
            const deps: DependencyInfo[] = await res.json();
            this.render(deps);
        } catch {
            this.renderError('Failed to load dependencies');
        }
    }

    private async checkAll(): Promise<void> {
        const btn = this.container.querySelector('.dep-check-all') as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = 'Checking...';
        this.busy = true;
        // §25b — using-declaration replaces the prior try/finally restoring
        // instance busy-flag + button state. Captures `this` and `btn`.
        using _restore = {
            [Symbol.dispose]: (): void => {
                this.busy = false;
                btn.disabled = false;
                btn.textContent = 'check for updates';
            },
        };
        try {
            const res = await fetch('/api/dependencies/check', { method: 'POST' });
            const deps: DependencyInfo[] = await res.json();
            this.render(deps);
        } catch {
            this.renderError('Check failed');
        }
    }

    private async updateDep(name: string): Promise<void> {
        const btn = this.container.querySelector(`[data-update="${name}"]`) as HTMLButtonElement;
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Updating...';
        }
        this.busy = true;
        // §25b — using-declaration replaces the prior try/finally clearing
        // the busy flag. Inline because the only cleanup is a single instance
        // field reset; no button state to capture here (the per-dep button
        // is left in 'Updating...' state on success — the row re-renders).
        using _restoreBusy = {
            [Symbol.dispose]: (): void => {
                this.busy = false;
            },
        };
        try {
            const res = await fetch(`/api/dependencies/${name}/update`, { method: 'POST' });
            const result: UpdateResult = await res.json();
            if (result.success) {
                await this.load();
                if (result.requiresRestart) {
                    this.showRestartPrompt();
                }
            } else {
                alert(`Update failed: ${result.errorMessage}`);
                await this.load();
            }
        } catch {
            alert('Update request failed');
            await this.load();
        }
    }

    private async requestRestart(): Promise<void> {
        this.restarting = true;
        this.stopPolling();
        try {
            await fetch('/api/dependencies/restart', { method: 'POST' });
        } catch {
            // Expected — server shut down
        }
        this.container.innerHTML = `
            <div class="dep-restarting">
                <h2>Restarting...</h2>
                <p>The server is restarting. This page will reload automatically.</p>
            </div>
        `;
        this.pollForRestart();
    }

    private pollForRestart(): void {
        const check = async () => {
            try {
                const res = await fetch('/api/dependencies');
                if (res.ok) {
                    window.location.reload();
                    return;
                }
            } catch {
                // Server not yet back up
            }
            setTimeout(check, 2000);
        };
        setTimeout(check, 3000);
    }

    private showRestartPrompt(): void {
        const existing = this.container.querySelector('.dep-restart-prompt');
        if (existing) return;
        const prompt = document.createElement('div');
        prompt.className = 'dep-restart-prompt';
        prompt.innerHTML = `
            <p>A dependency was updated that requires a restart.</p>
            <button class="dep-btn dep-restart-btn">Restart Now</button>
        `;
        prompt.querySelector('.dep-restart-btn')!.addEventListener('click', () => this.requestRestart());
        this.container.querySelector('.dep-header')!.after(prompt);
    }

    private render(deps: DependencyInfo[]): void {
        if (!this.tableBody) return;
        const prompt = this.container.querySelector('.dep-restart-prompt');
        if (prompt) prompt.remove();

        this.tableBody.innerHTML = '';
        for (const dep of deps) {
            const row = document.createElement('tr');
            row.className = `dep-row dep-status-${dep.status}`;
            row.innerHTML = `
                <td>
                    <strong>${escapeHtml(dep.displayName)}</strong>
                    ${dep.pairedWith ? `<span class="dep-paired">+ ${escapeHtml(dep.pairedWith)}</span>` : ''}
                    <div class="dep-description">${escapeHtml(dep.description)}</div>
                </td>
                <td class="dep-version">${escapeHtml(dep.installedVersion || 'Not installed')}</td>
                <td class="dep-version">${escapeHtml(dep.latestVersion || '\u2014')}</td>
                <td class="dep-status">${this.statusLabel(dep)}</td>
                <td class="dep-action">${this.actionButton(dep)}</td>
            `;
            const updateBtn = row.querySelector('[data-update]') as HTMLButtonElement | null;
            if (updateBtn) {
                updateBtn.addEventListener('click', () => this.updateDep(dep.name));
            }
            this.tableBody.appendChild(row);
        }
    }

    private statusLabel(dep: DependencyInfo): string {
        switch (dep.status) {
            case 'up-to-date': return '<span class="dep-badge dep-ok">Up to date</span>';
            case 'update-available': return '<span class="dep-badge dep-warn">Update available</span>';
            case 'checking': return '<span class="dep-badge dep-info">Checking...</span>';
            case 'updating': return '<span class="dep-badge dep-info">Updating...</span>';
            case 'error': return `<span class="dep-badge dep-error" title="${escapeHtml(dep.errorMessage || '')}">Error</span>`;
            default: return '<span class="dep-badge dep-unknown">Unknown</span>';
        }
    }

    private actionButton(dep: DependencyInfo): string {
        if (dep.status === 'update-available') {
            if (!dep.canUpdate) {
                const tooltip = 'In-app updates require an installed build. ' +
                    'In dev mode, populate dependencies/ via scripts/fetch-node.mjs.';
                return `<button class="dep-btn dep-update" disabled title="${tooltip}">` +
                    `update (dev)</button>`;
            }
            return `<button class="dep-btn dep-update" data-update="${escapeHtml(dep.name)}">update</button>`;
        }
        if (dep.status === 'updating') {
            return '<button class="dep-btn" disabled>updating...</button>';
        }
        return '';
    }

    private renderError(message: string): void {
        if (!this.tableBody) return;
        this.tableBody.innerHTML = `<tr><td colspan="5" class="dep-error-msg">${message}</td></tr>`;
    }
}
