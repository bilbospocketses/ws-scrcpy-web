import { type DependencyInfo, DependencyStatus, type UpdateResult } from '../../common/DependencyTypes';
import { escapeHtml } from '../htmlEscape';
import { isStaleTokenRefusal } from './staleToken';

const POLL_INTERVAL_MS = 15_000;

/**
 * Dispatched (bubbling) from the panel's element after an install or update
 * succeeds, with `{ name }` as its detail. The Settings dialog listens for it
 * on itself and tells the Server tab, whose Local HTTPS panel keeps generate
 * disabled until mkcert is installed (0.5.1) -- without it, installing mkcert
 * here would leave generate greyed out until the dialog was reopened.
 */
export const DEPENDENCY_INSTALLED_EVENT = 'ws-dependency-installed';

/**
 * Whether the row offers **install** rather than **update**: a dependency
 * fetched on first use (`deferInstall`, mkcert) that is not installed. That
 * is the server's `not-installed` status, and also its `error` status when
 * the copy is still missing -- an install that failed -- so the same button
 * is the retry, rather than leaving a red badge with nothing to press.
 */
function offersInstall(dep: DependencyInfo): boolean {
    if (dep.status === DependencyStatus.NotInstalled) return true;
    return dep.status === DependencyStatus.Error && dep.deferInstall === true && dep.installedVersion === null;
}

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

    /**
     * Install and update are one request (`POST /api/dependencies/:name/update`
     * runs the same download, verification and install either way); `install`
     * only changes what the button and a failure say.
     */
    private async updateDep(name: string, install = false): Promise<void> {
        const btn = this.container.querySelector(`[data-update="${name}"]`) as HTMLButtonElement;
        if (btn) {
            btn.disabled = true;
            btn.textContent = install ? 'installing...' : 'Updating...';
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
                this.container.dispatchEvent(
                    new CustomEvent(DEPENDENCY_INSTALLED_EVENT, { bubbles: true, detail: { name } }),
                );
                if (result.requiresRestart) {
                    this.showRestartPrompt();
                }
            } else {
                alert(`${install ? 'Install' : 'Update'} failed: ${result.errorMessage}`);
                await this.load();
            }
        } catch {
            alert(`${install ? 'Install' : 'Update'} request failed`);
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
                // The restarted process mints a new instance token, so it
                // answers this page's old cookie with a stale-token 403. That
                // refusal proves the new process is up: reload for its token.
                if (res.ok || isStaleTokenRefusal(res.status, await res.json().catch(() => null))) {
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
                ${this.latestCell(dep)}
                <td class="dep-status">${this.statusLabel(dep)}</td>
                <td class="dep-action">${this.actionButton(dep)}</td>
            `;
            const updateBtn = row.querySelector('[data-update]') as HTMLButtonElement | null;
            if (updateBtn) {
                const install = updateBtn.hasAttribute('data-install');
                updateBtn.addEventListener('click', () => this.updateDep(dep.name, install));
            }
            this.tableBody.appendChild(row);
        }
    }

    /**
     * The Latest cell. A lookup the upstream REFUSED (api.github.com's rate
     * limit, typically) says so, with its status, rather than showing the same
     * dash as a lookup that has not run or that failed: the first is the
     * network's state and changes nothing about the installed copy.
     */
    private latestCell(dep: DependencyInfo): string {
        const lookup = dep.latestLookup;
        if (!dep.latestVersion && lookup?.outcome === 'refused') {
            const status = lookup.httpStatus !== undefined ? `HTTP ${lookup.httpStatus}` : 'HTTP error';
            const title =
                `The version lookup was refused (${status}), e.g. by GitHub's rate limit. ` +
                (dep.installedVersion ? 'The installed version still works. ' : '') +
                'Check for updates again later.';
            return `<td class="dep-version dep-latest-refused" title="${escapeHtml(title)}">${escapeHtml(`refused (${status})`)}</td>`;
        }
        return `<td class="dep-version">${escapeHtml(dep.latestVersion || '\u2014')}</td>`;
    }

    private statusLabel(dep: DependencyInfo): string {
        switch (dep.status) {
            case 'up-to-date':
                return '<span class="dep-badge dep-ok">Up to date</span>';
            case 'update-available':
                return '<span class="dep-badge dep-warn">Update available</span>';
            case 'checking':
                return '<span class="dep-badge dep-info">Checking...</span>';
            case 'updating':
                return dep.installedVersion === null
                    ? '<span class="dep-badge dep-info">Installing...</span>'
                    : '<span class="dep-badge dep-info">Updating...</span>';
            case 'error':
                return `<span class="dep-badge dep-error" title="${escapeHtml(dep.errorMessage || '')}">Error</span>`;
            case 'not-installed':
                // Neutral, not a warning: a first-use dependency nothing has
                // needed yet. The install button beside it is the action.
                return '<span class="dep-badge dep-not-installed">Not installed</span>';
            default:
                return '<span class="dep-badge dep-unknown">Unknown</span>';
        }
    }

    private actionButton(dep: DependencyInfo): string {
        const devTooltip =
            'In-app updates require an installed build. ' +
            'In dev mode, populate dependencies/ via scripts/fetch-node.mjs.';
        if (dep.status === 'update-available') {
            if (!dep.canUpdate) {
                return `<button class="dep-btn dep-update" disabled title="${devTooltip}">update (dev)</button>`;
            }
            return `<button class="dep-btn dep-update" data-update="${escapeHtml(dep.name)}">update</button>`;
        }
        if (offersInstall(dep)) {
            if (!dep.canUpdate) {
                return `<button class="dep-btn dep-update" disabled title="${devTooltip}">install (dev)</button>`;
            }
            // `data-update` wires it to the same request as update (see
            // `updateDep`); `data-install` is what tells the two apart.
            return `<button class="dep-btn dep-update" data-update="${escapeHtml(dep.name)}" data-install>install</button>`;
        }
        if (dep.status === 'updating') {
            return `<button class="dep-btn" disabled>${dep.installedVersion === null ? 'installing...' : 'updating...'}</button>`;
        }
        return '';
    }

    private renderError(message: string): void {
        if (!this.tableBody) return;
        this.tableBody.innerHTML = `<tr><td colspan="5" class="dep-error-msg">${message}</td></tr>`;
    }
}
