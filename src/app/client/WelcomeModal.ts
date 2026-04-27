import { Modal } from '../ui/Modal';
import type { ServiceStatusResponse, ServiceInstallResponse } from '../../common/ServiceEvents';

export type WelcomeChoice = 'service' | 'on-demand';

export interface WelcomeModalOptions {
    webPort: number;
    portWasAutoShifted: boolean;
    /**
     * Notified after the modal has successfully persisted the user's decision
     * (either via POST /api/service/install or PATCH /api/config). The caller
     * does NOT need to issue any further requests — the modal owns first-run
     * completion to keep the install/PATCH ordering correct.
     */
    onDecision: (choice: WelcomeChoice) => void;
}

export class WelcomeModal extends Modal {
    private opts!: WelcomeModalOptions;
    private yesBtn!: HTMLButtonElement;
    private noBtn!: HTMLButtonElement;
    private statusEl!: HTMLElement;
    /**
     * Cached platform from the first /api/service/status fetch. We render
     * with windows-style copy synchronously (matches existing flow), then
     * patch the heading/scope chooser after the async fetch resolves.
     */
    private platform: NodeJS.Platform | null = null;
    /** Linux-only: scope chooser fieldset. Hidden on Windows. */
    private scopeFieldset: HTMLFieldSetElement | null = null;
    private scopeUserRadio: HTMLInputElement | null = null;
    private scopeSystemRadio: HTMLInputElement | null = null;
    private headingEl: HTMLElement | null = null;
    private descEl: HTMLElement | null = null;

    constructor(options: WelcomeModalOptions) {
        super({ title: 'Welcome to ws-scrcpy-web' });
        this.opts = options;
        this.dialog.classList.add('welcome-modal');
        // Defer body/footer fill past class-field init phase (ES2022 useDefineForClassFields).
        queueMicrotask(() => {
            this.fillBody(this.bodyEl);
            // Probe platform asynchronously so we can morph copy / show the
            // Linux scope chooser. Failure is silent — the modal still works
            // with the default Windows-style copy and the install POST will
            // surface any platform-specific error inline.
            void this.probePlatform();
        });
    }

    protected buildBody(_container: HTMLElement): void {
        // Body content is rendered by fillBody() from the constructor via queueMicrotask
        // so that this.opts and any subclass fields are initialized before they're read.
    }

    private fillBody(container: HTMLElement): void {
        const intro = document.createElement('p');
        intro.style.cssText = 'margin: 0 0 8px;';
        intro.appendChild(document.createTextNode('server is running on '));
        const link = document.createElement('a');
        const url = `http://localhost:${this.opts.webPort}`;
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = url;
        link.style.cssText = 'color: #5b9aff;';
        intro.appendChild(link);
        container.appendChild(intro);

        if (this.opts.portWasAutoShifted) {
            const shifted = document.createElement('p');
            shifted.style.cssText = 'margin: 0 0 8px; color: var(--text-color-light); font-size: 13px;';
            shifted.textContent =
                `default port 8000 was in use; we auto-picked ${this.opts.webPort}. ` +
                'change anytime in settings.';
            container.appendChild(shifted);
        } else {
            const note = document.createElement('p');
            note.style.cssText = 'margin: 0 0 8px; color: var(--text-color-light); font-size: 13px;';
            note.textContent = 'you can change the port anytime in settings.';
            container.appendChild(note);
        }

        const divider = document.createElement('hr');
        divider.style.cssText =
            'border: none; border-top: 1px solid rgba(255,255,255,0.08); margin: 16px 0;';
        container.appendChild(divider);

        const heading = document.createElement('p');
        heading.style.cssText = 'margin: 0 0 8px; font-weight: 600; font-size: 14px;';
        heading.textContent = 'run as a service?';
        this.headingEl = heading;
        container.appendChild(heading);

        const desc = document.createElement('p');
        desc.style.cssText = 'margin: 0 0 8px;';
        desc.textContent =
            'recommended for always-on access (headless servers, multi-user setups). ' +
            'the server starts at login and runs in the background.';
        this.descEl = desc;
        container.appendChild(desc);

        // Linux-only scope chooser. Created hidden — probePlatform() unhides it
        // when status.platform === 'linux' && supported. Windows leaves it
        // hidden so the existing yes/no flow is bit-for-bit identical to P3/P4a.
        const fieldset = document.createElement('fieldset');
        fieldset.style.cssText =
            'margin: 0 0 12px; padding: 8px 12px; ' +
            'border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; display: none;';
        const legend = document.createElement('legend');
        legend.textContent = 'scope';
        legend.style.cssText = 'padding: 0 6px; font-size: 13px; color: var(--text-color-light);';
        fieldset.appendChild(legend);

        const userLabel = document.createElement('label');
        userLabel.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer;';
        const userRadio = document.createElement('input');
        userRadio.type = 'radio';
        userRadio.name = 'welcome-scope';
        userRadio.value = 'user';
        userRadio.checked = true;
        userLabel.appendChild(userRadio);
        userLabel.appendChild(document.createTextNode('just for me (no sudo)'));
        fieldset.appendChild(userLabel);

        const sysLabel = document.createElement('label');
        sysLabel.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer;';
        const sysRadio = document.createElement('input');
        sysRadio.type = 'radio';
        sysRadio.name = 'welcome-scope';
        sysRadio.value = 'system';
        sysLabel.appendChild(sysRadio);
        sysLabel.appendChild(document.createTextNode('all users (requires sudo)'));
        fieldset.appendChild(sysLabel);

        this.scopeFieldset = fieldset;
        this.scopeUserRadio = userRadio;
        this.scopeSystemRadio = sysRadio;
        container.appendChild(fieldset);

        const later = document.createElement('p');
        later.style.cssText = 'margin: 0 0 16px; color: var(--text-color-light); font-size: 13px;';
        later.textContent = 'you can change this later in settings.';
        container.appendChild(later);

        this.statusEl = document.createElement('p');
        this.statusEl.style.cssText =
            'margin: 0 0 12px; color: var(--text-color-light); font-size: 13px; min-height: 1em;';
        container.appendChild(this.statusEl);

        const buttons = document.createElement('div');
        buttons.style.cssText = 'display: flex; gap: 12px; justify-content: flex-end; flex-wrap: wrap;';

        this.yesBtn = document.createElement('button');
        this.yesBtn.textContent = 'yes, install service';
        this.yesBtn.style.cssText =
            'border: 0.5px solid var(--text-color, #ddd); border-radius: 6px; ' +
            'background: transparent; color: #5b9aff; padding: 8px 16px; cursor: pointer;';
        this.yesBtn.addEventListener('click', () => {
            void this.onYes();
        });
        buttons.appendChild(this.yesBtn);

        this.noBtn = document.createElement('button');
        this.noBtn.textContent = 'no, run on demand';
        this.noBtn.style.cssText =
            'border: 0.5px solid var(--text-color, #ddd); border-radius: 6px; ' +
            'background: transparent; color: #5b9aff; padding: 8px 16px; cursor: pointer;';
        this.noBtn.addEventListener('click', () => {
            void this.onNo();
        });
        buttons.appendChild(this.noBtn);

        container.appendChild(buttons);
    }

    private setStatus(msg: string, isError = false): void {
        this.statusEl.textContent = msg;
        this.statusEl.style.color = isError
            ? 'var(--error-color, #ff6b6b)'
            : 'var(--text-color-light)';
    }

    private setBusy(busy: boolean): void {
        this.yesBtn.disabled = busy;
        this.noBtn.disabled = busy;
    }

    /**
     * One-shot platform probe driven from the constructor's queueMicrotask.
     * On Linux+supported, surface the scope chooser and morph the copy to
     * mention systemd. Windows path is bit-for-bit identical to P3/P4a.
     */
    private async probePlatform(): Promise<void> {
        let statusResp: ServiceStatusResponse | null = null;
        try {
            const r = await fetch('/api/service/status');
            if (r.ok) {
                statusResp = (await r.json()) as ServiceStatusResponse;
            }
        } catch {
            // Probe failure: leave default copy in place. onYes() will surface
            // any real error when the install POST fails.
        }
        if (!statusResp) return;
        this.platform = statusResp.platform;

        if (statusResp.platform === 'linux' && statusResp.supported) {
            if (this.headingEl) this.headingEl.textContent = 'run as a systemd service?';
            if (this.descEl) {
                this.descEl.textContent =
                    'recommended for always-on access. the server starts at login ' +
                    '(or boot, for system scope).';
            }
            if (this.scopeFieldset) {
                this.scopeFieldset.style.display = '';
            }
        } else if (statusResp.platform === 'win32') {
            if (this.headingEl) this.headingEl.textContent = 'run as a windows service?';
            if (this.descEl) {
                this.descEl.textContent =
                    'recommended for always-on access (headless servers, multi-user setups). ' +
                    'the server starts with windows and runs in the background.';
            }
        }
    }

    /** "Yes, install service" — try real service install; on Linux, fall back to user mode. */
    private async onYes(): Promise<void> {
        this.setBusy(true);
        this.setStatus('checking service support…');

        let statusResp: ServiceStatusResponse | null = null;
        try {
            const r = await fetch('/api/service/status');
            if (r.ok) {
                statusResp = (await r.json()) as ServiceStatusResponse;
            }
        } catch {
            // fall through with statusResp=null
        }

        if (!statusResp) {
            this.setStatus("couldn't reach server. try again?", true);
            this.setBusy(false);
            return;
        }

        if (!statusResp.supported) {
            // Linux (or other unsupported platform): show notice + fall back to user mode.
            const reason =
                statusResp.unsupportedReason ||
                'service mode is not supported on this platform.';
            this.setStatus(`${reason} falling back to on-demand mode…`);
            const ok = await this.patchConfig({ installMode: 'user', firstRunComplete: true });
            if (!ok) {
                this.setStatus("couldn't save preference. try again?", true);
                this.setBusy(false);
                return;
            }
            this.opts.onDecision('on-demand');
            this.close();
            return;
        }

        // Supported. Linux: include scope in the body. Windows: empty body
        // (the API ignores the body entirely on Windows).
        this.setStatus('installing service…');
        const requestBody: { scope?: 'user' | 'system' } = {};
        if (statusResp.platform === 'linux') {
            requestBody.scope = this.scopeSystemRadio?.checked ? 'system' : 'user';
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
                this.setStatus(errMsg, true);
                this.setBusy(false);
                return;
            }
            // Server has updated installMode on success. Defensively also PATCH
            // firstRunComplete so the welcome modal does not re-appear on next
            // load even if the backend's /install handler omits that flag.
            // Failure here is non-fatal — install itself succeeded.
            await this.patchConfig({ firstRunComplete: true });
            this.opts.onDecision('service');
            this.close();
        } catch {
            this.setStatus("couldn't reach server. try again?", true);
            this.setBusy(false);
        }
    }

    /** "No, run on demand" — PATCH config to lock in user mode + complete first-run. */
    private async onNo(): Promise<void> {
        this.setBusy(true);
        this.setStatus('saving…');
        const ok = await this.patchConfig({ installMode: 'user', firstRunComplete: true });
        if (!ok) {
            this.setStatus("couldn't save preference. try again?", true);
            this.setBusy(false);
            return;
        }
        this.opts.onDecision('on-demand');
        this.close();
    }

    private async patchConfig(body: Record<string, unknown>): Promise<boolean> {
        try {
            const r = await fetch('/api/config', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            return r.ok;
        } catch {
            return false;
        }
    }

    /** No-op: Modal base shows the dialog from its constructor. Provided for caller ergonomics. */
    public show(): void {
        if (!this.dialog.open) {
            this.dialog.showModal();
        }
    }
}
