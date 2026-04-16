import type { DependencyInfo, UpdateResult } from '../../common/DependencyTypes';

export class DependencyPanel {
    private container: HTMLElement;
    private tableBody: HTMLTableSectionElement | null = null;

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
        return panel;
    }

    getElement(): HTMLElement {
        return this.container;
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
        try {
            const res = await fetch('/api/dependencies/check', { method: 'POST' });
            const deps: DependencyInfo[] = await res.json();
            this.render(deps);
        } catch {
            this.renderError('Check failed');
        } finally {
            btn.disabled = false;
            btn.textContent = 'check for updates';
        }
    }

    private async updateDep(name: string): Promise<void> {
        const btn = this.container.querySelector(`[data-update="${name}"]`) as HTMLButtonElement;
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Updating...';
        }
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
                    <strong>${dep.displayName}</strong>
                    ${dep.pairedWith ? `<span class="dep-paired">+ ${dep.pairedWith}</span>` : ''}
                    <div class="dep-description">${dep.description}</div>
                </td>
                <td class="dep-version">${dep.installedVersion || 'Not installed'}</td>
                <td class="dep-version">${dep.latestVersion || '\u2014'}</td>
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
            case 'error': return `<span class="dep-badge dep-error" title="${dep.errorMessage || ''}">Error</span>`;
            default: return '<span class="dep-badge dep-unknown">Unknown</span>';
        }
    }

    private actionButton(dep: DependencyInfo): string {
        if (dep.status === 'update-available') {
            return `<button class="dep-btn dep-update" data-update="${dep.name}">Update</button>`;
        }
        if (dep.status === 'updating') {
            return '<button class="dep-btn" disabled>Updating...</button>';
        }
        return '';
    }

    private renderError(message: string): void {
        if (!this.tableBody) return;
        this.tableBody.innerHTML = `<tr><td colspan="5" class="dep-error-msg">${message}</td></tr>`;
    }
}
