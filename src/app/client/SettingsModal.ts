import { Modal } from '../ui/Modal';
import type { AppConfigEnvelope, AppConfigPatchResponse } from '../../common/ConfigEvents';
import type {
    ServiceStatusResponse,
    ServiceInstallResponse,
    ServiceUninstallResponse,
} from '../../common/ServiceEvents';

export class SettingsModal extends Modal {
    private serviceSection!: HTMLElement;
    private webPortInput!: HTMLInputElement;
    private webPortStatus!: HTMLElement;
    private serverSaveBtn!: HTMLButtonElement;
    private currentWebPort: number | null = null;

    constructor() {
        super({ title: 'Settings' });
        this.dialog.classList.add('settings-modal');
        // Defer body fill past class-field init phase (ES2022 useDefineForClassFields).
        queueMicrotask(() => {
            this.fillBody(this.bodyEl);
            void this.refreshServer();
            void this.refreshService();
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

    // ── Updates (stub) ─────────────────────────────────────────────────────
    private buildUpdatesSection(): HTMLElement {
        const section = document.createElement('section');
        section.className = 'settings-section';

        const heading = document.createElement('h3');
        heading.className = 'settings-section-heading';
        heading.textContent = 'Updates';
        section.appendChild(heading);

        const note = document.createElement('p');
        note.className = 'settings-stub-note';
        note.textContent = '(configurable in P5)';
        section.appendChild(note);

        return section;
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
        try {
            const r = await fetch('/api/service/install', { method: 'POST' });
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
