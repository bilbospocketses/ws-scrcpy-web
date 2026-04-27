import { Modal } from '../ui/Modal';
import type { AppConfigEnvelope, AppConfigPatchResponse, UpdateChannel } from '../../common/ConfigEvents';
import type {
    ServiceStatusResponse,
    ServiceInstallResponse,
    ServiceUninstallResponse,
} from '../../common/ServiceEvents';
import type { UpdatesStatusResponse, UpdatesConfigPatchRequest } from '../../common/UpdateEvents';

export class SettingsModal extends Modal {
    private serviceSection!: HTMLElement;
    private webPortInput!: HTMLInputElement;
    private webPortStatus!: HTMLElement;
    private serverSaveBtn!: HTMLButtonElement;
    private currentWebPort: number | null = null;
    /** Linux scope chooser for the install action. Recreated each refresh. */
    private serviceScopeSystemRadio: HTMLInputElement | null = null;

    // ── Updates section state ─────────────────────────────────────────────
    private updatesSection!: HTMLElement;
    private updatesBody!: HTMLElement;
    private updatesStatusEl!: HTMLElement;
    private updatesAutoCheckbox: HTMLInputElement | null = null;
    private updatesIntervalInput: HTMLInputElement | null = null;
    private updatesChannelStableRadio: HTMLInputElement | null = null;
    private updatesChannelBetaRadio: HTMLInputElement | null = null;
    private updatesOwnerInput: HTMLInputElement | null = null;
    private updatesCheckNowBtn: HTMLButtonElement | null = null;
    private updatesIntervalDebounce: number | undefined;
    /** Last status snapshot so PATCH responses can update the inline message. */
    private updatesLastStatus: UpdatesStatusResponse | null = null;

    constructor() {
        super({ title: 'Settings' });
        this.dialog.classList.add('settings-modal');
        // Defer body fill past class-field init phase (ES2022 useDefineForClassFields).
        queueMicrotask(() => {
            this.fillBody(this.bodyEl);
            void this.refreshServer();
            void this.refreshService();
            void this.refreshUpdates();
        });
    }

    protected buildBody(_container: HTMLElement): void {
        // Body content rendered by fillBody() via queueMicrotask.
    }

    private fillBody(container: HTMLElement): void {
        container.appendChild(this.buildServerSection());
        container.appendChild(this.buildUpdatesSection());
        container.appendChild(this.buildServiceSection());
        container.appendChild(this.buildAppSection());
    }

    // ── Server section ─────────────────────────────────────────────────────
    private buildServerSection(): HTMLElement {
        const section = document.createElement('section');
        section.className = 'settings-section';

        const heading = document.createElement('h3');
        heading.className = 'settings-section-heading';
        heading.textContent = 'Server';
        section.appendChild(heading);

        const row = document.createElement('div');
        row.className = 'settings-row';

        const label = document.createElement('label');
        label.className = 'settings-label';
        label.textContent = 'web port';
        row.appendChild(label);

        this.webPortInput = document.createElement('input');
        this.webPortInput.type = 'number';
        this.webPortInput.min = '1024';
        this.webPortInput.max = '65535';
        this.webPortInput.className = 'settings-input';
        label.appendChild(this.webPortInput);

        this.serverSaveBtn = document.createElement('button');
        this.serverSaveBtn.type = 'button';
        this.serverSaveBtn.className = 'settings-btn settings-btn-primary';
        this.serverSaveBtn.textContent = 'save';
        this.serverSaveBtn.addEventListener('click', () => {
            void this.onSavePort();
        });
        row.appendChild(this.serverSaveBtn);

        section.appendChild(row);

        this.webPortStatus = document.createElement('p');
        this.webPortStatus.className = 'settings-status';
        section.appendChild(this.webPortStatus);

        return section;
    }

    private async refreshServer(): Promise<void> {
        try {
            const r = await fetch('/api/config');
            if (!r.ok) {
                this.setServerStatus("couldn't reach server", true);
                return;
            }
            const env = (await r.json()) as AppConfigEnvelope;
            this.currentWebPort = env.config.webPort;
            this.webPortInput.value = String(env.config.webPort);
            this.setServerStatus('');
        } catch {
            this.setServerStatus("couldn't reach server", true);
        }
    }

    private async onSavePort(): Promise<void> {
        const raw = this.webPortInput.value.trim();
        const port = Number.parseInt(raw, 10);
        if (!Number.isFinite(port) || port < 1024 || port > 65535) {
            this.setServerStatus('port must be between 1024 and 65535', true);
            return;
        }
        if (port === this.currentWebPort) {
            this.setServerStatus('no change.', false);
            return;
        }
        this.serverSaveBtn.disabled = true;
        this.setServerStatus('saving…', false);
        try {
            const r = await fetch('/api/config', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ webPort: port }),
            });
            if (!r.ok) {
                this.setServerStatus(`save failed (${r.status})`, true);
                this.serverSaveBtn.disabled = false;
                return;
            }
            const data = (await r.json()) as AppConfigPatchResponse;
            this.currentWebPort = data.config.webPort;
            if (data.restartRequired) {
                this.setServerStatus(
                    'server will restart on the new port. browser will redirect.',
                    false,
                );
            } else {
                this.setServerStatus('saved.', false);
            }
        } catch {
            this.setServerStatus("couldn't reach server", true);
        } finally {
            this.serverSaveBtn.disabled = false;
        }
    }

    private setServerStatus(msg: string, isError = false): void {
        this.webPortStatus.textContent = msg;
        this.webPortStatus.classList.toggle('settings-status-error', isError);
    }

    // ── Updates section ────────────────────────────────────────────────────
    private buildUpdatesSection(): HTMLElement {
        const section = document.createElement('section');
        section.className = 'settings-section settings-updates-section';

        const heading = document.createElement('h3');
        heading.className = 'settings-section-heading';
        heading.textContent = 'Updates';
        section.appendChild(heading);

        // Body — populated by refreshUpdates() once /api/updates/status returns.
        const body = document.createElement('div');
        body.className = 'settings-updates-body';
        const loading = document.createElement('p');
        loading.className = 'settings-status';
        loading.textContent = 'loading…';
        body.appendChild(loading);
        section.appendChild(body);

        this.updatesSection = section;
        this.updatesBody = body;
        return section;
    }

    private async refreshUpdates(): Promise<void> {
        let resp: UpdatesStatusResponse | null = null;
        try {
            const r = await fetch('/api/updates/status');
            if (!r.ok) {
                this.renderUpdatesError("couldn't reach server");
                return;
            }
            resp = (await r.json()) as UpdatesStatusResponse;
        } catch {
            this.renderUpdatesError("couldn't reach server");
            return;
        }
        this.updatesLastStatus = resp;
        this.renderUpdatesSection(resp);
    }

    private renderUpdatesError(msg: string): void {
        this.updatesBody.replaceChildren();
        const err = document.createElement('p');
        err.className = 'settings-status settings-status-error';
        err.textContent = msg;
        this.updatesBody.appendChild(err);

        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'settings-btn';
        retryBtn.textContent = 'retry';
        retryBtn.addEventListener('click', () => {
            void this.refreshUpdates();
        });
        this.updatesBody.appendChild(retryBtn);
    }

    private renderUpdatesSection(s: UpdatesStatusResponse): void {
        this.updatesBody.replaceChildren();

        // Reset cached element refs (rebuilt below).
        this.updatesAutoCheckbox = null;
        this.updatesIntervalInput = null;
        this.updatesChannelStableRadio = null;
        this.updatesChannelBetaRadio = null;
        this.updatesOwnerInput = null;
        this.updatesCheckNowBtn = null;

        if (!s.isInstalled) {
            // Dev mode — single inline note, no controls (per spec § E + contracts).
            const devNote = document.createElement('p');
            devNote.className = 'settings-stub-note';
            devNote.textContent = 'dev mode — packaging features disabled';
            this.updatesBody.appendChild(devNote);
            return;
        }

        // ── Current version + auto-download checkbox ──
        const autoRow = document.createElement('div');
        autoRow.className = 'settings-row';

        const autoLabel = document.createElement('label');
        autoLabel.className = 'settings-label';
        const autoCheckbox = document.createElement('input');
        autoCheckbox.type = 'checkbox';
        autoCheckbox.checked = s.autoUpdate;
        autoCheckbox.addEventListener('change', () => {
            void this.patchUpdatesConfig({ autoUpdate: autoCheckbox.checked });
        });
        autoLabel.appendChild(autoCheckbox);
        autoLabel.appendChild(document.createTextNode('automatically download updates'));
        autoRow.appendChild(autoLabel);
        this.updatesBody.appendChild(autoRow);
        this.updatesAutoCheckbox = autoCheckbox;

        // ── Update check interval ──
        const intervalRow = document.createElement('div');
        intervalRow.className = 'settings-row';
        const intervalLabel = document.createElement('label');
        intervalLabel.className = 'settings-label';
        intervalLabel.textContent = 'check interval (minutes)';
        const intervalInput = document.createElement('input');
        intervalInput.type = 'number';
        intervalInput.min = '5';
        intervalInput.max = '1440';
        intervalInput.step = '1';
        intervalInput.className = 'settings-input';
        intervalInput.value = String(s.updateCheckIntervalMinutes);
        intervalInput.addEventListener('input', () => {
            if (this.updatesIntervalDebounce !== undefined) {
                window.clearTimeout(this.updatesIntervalDebounce);
            }
            this.updatesIntervalDebounce = window.setTimeout(() => {
                this.commitIntervalChange(intervalInput);
            }, 500);
        });
        intervalInput.addEventListener('blur', () => {
            if (this.updatesIntervalDebounce !== undefined) {
                window.clearTimeout(this.updatesIntervalDebounce);
                this.updatesIntervalDebounce = undefined;
            }
            this.commitIntervalChange(intervalInput);
        });
        intervalLabel.appendChild(intervalInput);
        intervalRow.appendChild(intervalLabel);
        this.updatesBody.appendChild(intervalRow);
        this.updatesIntervalInput = intervalInput;

        // ── Channel radios ──
        const channelRow = document.createElement('div');
        channelRow.className = 'settings-row';
        const channelLabel = document.createElement('span');
        channelLabel.className = 'settings-label';
        channelLabel.textContent = 'channel';
        channelRow.appendChild(channelLabel);

        const stableLabel = document.createElement('label');
        stableLabel.className = 'settings-label';
        const stableRadio = document.createElement('input');
        stableRadio.type = 'radio';
        stableRadio.name = 'updates-channel';
        stableRadio.value = 'stable';
        stableRadio.checked = s.channel === 'stable';
        stableRadio.addEventListener('change', () => {
            if (stableRadio.checked) {
                void this.patchUpdatesConfig({ channel: 'stable' });
            }
        });
        stableLabel.appendChild(stableRadio);
        stableLabel.appendChild(document.createTextNode('stable'));
        channelRow.appendChild(stableLabel);

        const betaLabel = document.createElement('label');
        betaLabel.className = 'settings-label';
        const betaRadio = document.createElement('input');
        betaRadio.type = 'radio';
        betaRadio.name = 'updates-channel';
        betaRadio.value = 'beta';
        betaRadio.checked = s.channel === 'beta';
        betaRadio.addEventListener('change', () => {
            if (betaRadio.checked) {
                void this.patchUpdatesConfig({ channel: 'beta' });
            }
        });
        betaLabel.appendChild(betaRadio);
        betaLabel.appendChild(document.createTextNode('beta'));
        channelRow.appendChild(betaLabel);

        this.updatesBody.appendChild(channelRow);
        this.updatesChannelStableRadio = stableRadio;
        this.updatesChannelBetaRadio = betaRadio;

        // ── GitHub owner ──
        const ownerRow = document.createElement('div');
        ownerRow.className = 'settings-row';
        const ownerLabel = document.createElement('label');
        ownerLabel.className = 'settings-label';
        ownerLabel.textContent = 'github owner';
        const ownerInput = document.createElement('input');
        ownerInput.type = 'text';
        ownerInput.className = 'settings-input';
        ownerInput.value = s.githubOwner;
        ownerInput.addEventListener('blur', () => {
            const next = ownerInput.value.trim();
            // Send only if changed and non-empty (backend accepts any non-empty
            // string; we don't reject client-side per decision 7).
            if (next.length === 0) {
                ownerInput.value = this.updatesLastStatus?.githubOwner ?? '';
                return;
            }
            if (next === this.updatesLastStatus?.githubOwner) return;
            void this.patchUpdatesConfig({ githubOwner: next });
        });
        ownerLabel.appendChild(ownerInput);
        ownerRow.appendChild(ownerLabel);
        this.updatesBody.appendChild(ownerRow);
        this.updatesOwnerInput = ownerInput;

        // ── Manual check now button ──
        const checkRow = document.createElement('div');
        checkRow.className = 'settings-row';
        const checkBtn = document.createElement('button');
        checkBtn.type = 'button';
        checkBtn.className = 'settings-btn settings-btn-primary';
        checkBtn.textContent = 'check for updates now';
        checkBtn.addEventListener('click', () => {
            void this.onCheckNowClick();
        });
        checkRow.appendChild(checkBtn);
        this.updatesBody.appendChild(checkRow);
        this.updatesCheckNowBtn = checkBtn;

        // ── Inline status ──
        const status = document.createElement('p');
        status.className = 'settings-status settings-updates-status';
        this.updatesBody.appendChild(status);
        this.updatesStatusEl = status;
        this.applyUpdatesStatusText(s);

        // Disable Check Now while a check or download is in flight.
        this.applyButtonsDisabledState(s);
    }

    private applyUpdatesStatusText(s: UpdatesStatusResponse): void {
        if (!this.updatesStatusEl) return;
        let text = '';
        let isError = false;
        switch (s.status) {
            case 'idle':
                if (s.lastCheckedAt) {
                    text = `last checked ${this.formatRelative(s.lastCheckedAt)} — up to date (v${s.currentVersion})`;
                } else {
                    text = `current version: v${s.currentVersion}`;
                }
                break;
            case 'checking':
                text = 'checking for updates…';
                break;
            case 'downloading': {
                const pct = typeof s.progress === 'number' ? Math.round(s.progress) : 0;
                text = `downloading v${s.availableVersion ?? '?'} — ${pct}%`;
                break;
            }
            case 'ready':
                text = `v${s.availableVersion ?? '?'} ready to apply`;
                break;
            case 'error':
                text = `check failed: ${s.errorMessage ?? 'unknown error'}`;
                isError = true;
                break;
            default:
                text = '';
        }
        this.updatesStatusEl.textContent = text;
        this.updatesStatusEl.classList.toggle('settings-status-error', isError);
    }

    private formatRelative(iso: string): string {
        const t = Date.parse(iso);
        if (!Number.isFinite(t)) return 'just now';
        const diffSec = Math.max(0, Math.round((Date.now() - t) / 1000));
        if (diffSec < 30) return 'just now';
        if (diffSec < 60) return `${diffSec}s ago`;
        const diffMin = Math.round(diffSec / 60);
        if (diffMin < 60) return `${diffMin}m ago`;
        const diffHr = Math.round(diffMin / 60);
        if (diffHr < 24) return `${diffHr}h ago`;
        const diffDay = Math.round(diffHr / 24);
        return `${diffDay}d ago`;
    }

    private applyButtonsDisabledState(s: UpdatesStatusResponse): void {
        const busy = s.status === 'checking' || s.status === 'downloading';
        if (this.updatesCheckNowBtn) this.updatesCheckNowBtn.disabled = busy;
    }

    private commitIntervalChange(input: HTMLInputElement): void {
        const raw = input.value.trim();
        const n = Number.parseInt(raw, 10);
        if (!Number.isFinite(n) || n < 5 || n > 1440) {
            // Restore last known good value silently; surface in inline status.
            input.value = String(this.updatesLastStatus?.updateCheckIntervalMinutes ?? 60);
            if (this.updatesStatusEl) {
                this.updatesStatusEl.textContent = 'interval must be between 5 and 1440 minutes';
                this.updatesStatusEl.classList.add('settings-status-error');
            }
            return;
        }
        if (n === this.updatesLastStatus?.updateCheckIntervalMinutes) return;
        void this.patchUpdatesConfig({ updateCheckIntervalMinutes: n });
    }

    private async patchUpdatesConfig(body: UpdatesConfigPatchRequest): Promise<void> {
        if (this.updatesStatusEl) {
            this.updatesStatusEl.textContent = 'saving…';
            this.updatesStatusEl.classList.remove('settings-status-error');
        }
        try {
            const r = await fetch('/api/updates/config', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!r.ok) {
                if (this.updatesStatusEl) {
                    this.updatesStatusEl.textContent = `save failed (${r.status})`;
                    this.updatesStatusEl.classList.add('settings-status-error');
                }
                return;
            }
            const data = (await r.json()) as { status: UpdatesStatusResponse } | UpdatesStatusResponse;
            // Backend returns { config, status } per contracts; tolerate either.
            const status: UpdatesStatusResponse =
                'status' in data && (data as { status: UpdatesStatusResponse }).status
                    ? (data as { status: UpdatesStatusResponse }).status
                    : (data as UpdatesStatusResponse);
            this.updatesLastStatus = status;
            // Reflect the new server-side values into the controls (e.g.,
            // channel switch may have changed status; owner may have been
            // accepted as-is even if the resulting check failed).
            this.syncControlsToStatus(status);
            this.applyUpdatesStatusText(status);
            this.applyButtonsDisabledState(status);
        } catch {
            if (this.updatesStatusEl) {
                this.updatesStatusEl.textContent = "couldn't reach server";
                this.updatesStatusEl.classList.add('settings-status-error');
            }
        }
    }

    /** Push server-side config values back into the rendered controls without rebuilding. */
    private syncControlsToStatus(s: UpdatesStatusResponse): void {
        if (this.updatesAutoCheckbox && this.updatesAutoCheckbox.checked !== s.autoUpdate) {
            this.updatesAutoCheckbox.checked = s.autoUpdate;
        }
        if (
            this.updatesIntervalInput &&
            document.activeElement !== this.updatesIntervalInput &&
            this.updatesIntervalInput.value !== String(s.updateCheckIntervalMinutes)
        ) {
            this.updatesIntervalInput.value = String(s.updateCheckIntervalMinutes);
        }
        const channel: UpdateChannel = s.channel;
        if (this.updatesChannelStableRadio) {
            this.updatesChannelStableRadio.checked = channel === 'stable';
        }
        if (this.updatesChannelBetaRadio) {
            this.updatesChannelBetaRadio.checked = channel === 'beta';
        }
        if (
            this.updatesOwnerInput &&
            document.activeElement !== this.updatesOwnerInput &&
            this.updatesOwnerInput.value !== s.githubOwner
        ) {
            this.updatesOwnerInput.value = s.githubOwner;
        }
    }

    private async onCheckNowClick(): Promise<void> {
        if (!this.updatesCheckNowBtn) return;
        const btn = this.updatesCheckNowBtn;
        btn.disabled = true;
        const prev = btn.textContent;
        btn.textContent = 'checking…';
        if (this.updatesStatusEl) {
            this.updatesStatusEl.textContent = 'checking for updates…';
            this.updatesStatusEl.classList.remove('settings-status-error');
        }
        try {
            const r = await fetch('/api/updates/check', { method: 'POST' });
            if (!r.ok) {
                if (this.updatesStatusEl) {
                    this.updatesStatusEl.textContent = `check failed (${r.status})`;
                    this.updatesStatusEl.classList.add('settings-status-error');
                }
                return;
            }
            const s = (await r.json()) as UpdatesStatusResponse;
            this.updatesLastStatus = s;
            this.syncControlsToStatus(s);
            this.applyUpdatesStatusText(s);
            this.applyButtonsDisabledState(s);
        } catch {
            if (this.updatesStatusEl) {
                this.updatesStatusEl.textContent = "couldn't reach server";
                this.updatesStatusEl.classList.add('settings-status-error');
            }
        } finally {
            btn.textContent = prev;
            // applyButtonsDisabledState handles re-enable based on status.
            if (
                this.updatesLastStatus &&
                this.updatesLastStatus.status !== 'checking' &&
                this.updatesLastStatus.status !== 'downloading'
            ) {
                btn.disabled = false;
            }
        }
    }

    // ── Service section ────────────────────────────────────────────────────
    private buildServiceSection(): HTMLElement {
        const section = document.createElement('section');
        section.className = 'settings-section';

        const heading = document.createElement('h3');
        heading.className = 'settings-section-heading';
        heading.textContent = 'Service';
        section.appendChild(heading);

        const body = document.createElement('div');
        body.className = 'settings-service-body';
        body.textContent = 'loading…';
        section.appendChild(body);

        this.serviceSection = body;
        return section;
    }

    private async refreshService(): Promise<void> {
        this.serviceSection.replaceChildren();
        const loading = document.createElement('p');
        loading.className = 'settings-status';
        loading.textContent = 'loading…';
        this.serviceSection.appendChild(loading);

        let resp: ServiceStatusResponse | null = null;
        try {
            const r = await fetch('/api/service/status');
            if (!r.ok) {
                this.renderServiceError("couldn't reach server", () => void this.refreshService());
                return;
            }
            resp = (await r.json()) as ServiceStatusResponse;
        } catch {
            this.renderServiceError("couldn't reach server", () => void this.refreshService());
            return;
        }

        this.renderServiceState(resp);
    }

    private renderServiceState(resp: ServiceStatusResponse): void {
        this.serviceSection.replaceChildren();

        if (!resp.supported) {
            const notice = document.createElement('p');
            notice.className = 'settings-status';
            const reason =
                resp.unsupportedReason ||
                'service mode is currently windows-only. linux support arrives later in SP3.';
            notice.textContent = reason;
            this.serviceSection.appendChild(notice);
            return;
        }

        const status = resp.status ?? 'not-installed';

        const statusLine = document.createElement('p');
        statusLine.className = 'settings-status';
        statusLine.textContent = `status: ${status}`;
        this.serviceSection.appendChild(statusLine);

        if (status === 'not-installed') {
            // Linux: scope chooser before the install button. Windows leaves
            // it null and the install POST sends no body (Windows ignores).
            this.serviceScopeSystemRadio = null;
            if (resp.platform === 'linux') {
                const fieldset = document.createElement('fieldset');
                fieldset.className = 'settings-scope-fieldset';
                fieldset.style.cssText =
                    'margin: 8px 0; padding: 8px 12px; ' +
                    'border: 1px solid rgba(255,255,255,0.12); border-radius: 6px;';
                const legend = document.createElement('legend');
                legend.textContent = 'scope';
                legend.style.cssText =
                    'padding: 0 6px; font-size: 13px; color: var(--text-color-light);';
                fieldset.appendChild(legend);

                const userLabel = document.createElement('label');
                userLabel.style.cssText =
                    'display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer;';
                const userRadio = document.createElement('input');
                userRadio.type = 'radio';
                userRadio.name = 'settings-scope';
                userRadio.value = 'user';
                userRadio.checked = true;
                userLabel.appendChild(userRadio);
                userLabel.appendChild(document.createTextNode('just for me (no sudo)'));
                fieldset.appendChild(userLabel);

                const sysLabel = document.createElement('label');
                sysLabel.style.cssText =
                    'display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer;';
                const sysRadio = document.createElement('input');
                sysRadio.type = 'radio';
                sysRadio.name = 'settings-scope';
                sysRadio.value = 'system';
                sysLabel.appendChild(sysRadio);
                sysLabel.appendChild(document.createTextNode('all users (requires sudo)'));
                fieldset.appendChild(sysLabel);

                this.serviceSection.appendChild(fieldset);
                this.serviceScopeSystemRadio = sysRadio;
            }

            const installBtn = document.createElement('button');
            installBtn.type = 'button';
            installBtn.className = 'settings-btn settings-btn-primary';
            installBtn.textContent = 'install as service';
            installBtn.addEventListener('click', () => {
                void this.onInstallService(installBtn);
            });
            this.serviceSection.appendChild(installBtn);
        } else {
            const uninstallBtn = document.createElement('button');
            uninstallBtn.type = 'button';
            uninstallBtn.className = 'settings-btn settings-btn-danger';
            uninstallBtn.textContent = 'uninstall service';
            uninstallBtn.addEventListener('click', () => {
                void this.onUninstallService(uninstallBtn);
            });
            this.serviceSection.appendChild(uninstallBtn);
        }
    }

    private renderServiceError(msg: string, onRetry: () => void): void {
        this.serviceSection.replaceChildren();
        const err = document.createElement('p');
        err.className = 'settings-status settings-status-error';
        err.textContent = msg;
        this.serviceSection.appendChild(err);

        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'settings-btn';
        retryBtn.textContent = 'retry';
        retryBtn.addEventListener('click', onRetry);
        this.serviceSection.appendChild(retryBtn);
    }

    private async onInstallService(btn: HTMLButtonElement): Promise<void> {
        btn.disabled = true;
        const prevText = btn.textContent;
        btn.textContent = 'installing…';
        // Linux: include scope from the radio chooser. Windows: serviceScopeSystemRadio
        // is null, so the body stays empty and the API ignores it.
        const requestBody: { scope?: 'user' | 'system' } = {};
        if (this.serviceScopeSystemRadio) {
            requestBody.scope = this.serviceScopeSystemRadio.checked ? 'system' : 'user';
        }
        try {
            const r = await fetch('/api/service/install', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
            });
            const data = (await r.json().catch(() => null)) as ServiceInstallResponse | null;
            if (!r.ok || !data || data.ok !== true) {
                const errMsg =
                    data && data.ok === false
                        ? data.error
                        : `install failed (${r.status})`;
                this.renderServiceError(errMsg, () => void this.refreshService());
                return;
            }
            await this.refreshService();
        } catch {
            this.renderServiceError("couldn't reach server", () => void this.refreshService());
        } finally {
            btn.disabled = false;
            btn.textContent = prevText;
        }
    }

    private async onUninstallService(btn: HTMLButtonElement): Promise<void> {
        btn.disabled = true;
        const prevText = btn.textContent;
        btn.textContent = 'uninstalling…';
        try {
            const r = await fetch('/api/service/uninstall', { method: 'POST' });
            const data = (await r.json().catch(() => null)) as ServiceUninstallResponse | null;
            if (!r.ok || !data || data.ok !== true) {
                const errMsg =
                    data && data.ok === false
                        ? data.error
                        : `uninstall failed (${r.status})`;
                this.renderServiceError(errMsg, () => void this.refreshService());
                return;
            }
            await this.refreshService();
        } catch {
            this.renderServiceError("couldn't reach server", () => void this.refreshService());
        } finally {
            btn.disabled = false;
            btn.textContent = prevText;
        }
    }

    // ── App (stub) ─────────────────────────────────────────────────────────
    private buildAppSection(): HTMLElement {
        const section = document.createElement('section');
        section.className = 'settings-section';

        const heading = document.createElement('h3');
        heading.className = 'settings-section-heading';
        heading.textContent = 'App';
        section.appendChild(heading);

        const note = document.createElement('p');
        note.className = 'settings-stub-note';
        note.textContent = '(uninstall in P7)';
        section.appendChild(note);

        return section;
    }

}
