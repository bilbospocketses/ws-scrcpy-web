import type { ServiceInstallResponse, ServiceStatusResponse } from '../../common/ServiceEvents';
import { Modal } from '../ui/Modal';
import { ServiceOperationModal } from './ServiceOperationModal';
import { settingsService } from './SettingsService';

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
    private dontShowCheckbox!: HTMLInputElement;
    private statusEl!: HTMLElement;
    /** Linux-only: scope chooser fieldset. Hidden on Windows. */
    private scopeFieldset: HTMLFieldSetElement | null = null;
    private scopeSystemRadio: HTMLInputElement | null = null;
    private headingEl: HTMLElement | null = null;
    private descEl: HTMLElement | null = null;

    constructor(options: WelcomeModalOptions) {
        super({ title: 'Welcome to ws-scrcpy-web' });
        this.opts = options;
        this.dialog.classList.add('welcome-modal');
        // No eager bookmarkDismissedForPort stamp here (removed — bug #35).
        // It was redundant: index.ts already gates modal priority on the same
        // load (WelcomeModal shows; PortChangeModal early-returns), and the
        // decision-completion path below stamps the port legitimately. The
        // eager stamp also clobbered "reset welcome and bookmark prompts" —
        // the reset re-shows this modal (firstRunComplete=false), which
        // re-stamped the current port over the reset's null.
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

        // The intro line above already shows the actual bound URL
        // (including any auto-shifted port). Pre-2026-05-21 the
        // auto-shifted path also rendered a verbose "default port 8000 was
        // in use; we auto-picked NNNN" sentence, which duplicated info the
        // intro already conveyed. Now both code paths render the same
        // brief hint about where to change the port later.
        const note = document.createElement('p');
        note.style.cssText = 'margin: 0 0 8px; color: var(--text-color-light); font-size: 13px;';
        note.textContent = 'you can change the port anytime in settings.';
        container.appendChild(note);

        const divider = document.createElement('hr');
        divider.style.cssText = 'border: none; border-top: 1px solid rgba(255,255,255,0.08); margin: 16px 0;';
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
        this.scopeSystemRadio = sysRadio;
        container.appendChild(fieldset);

        const later = document.createElement('p');
        later.style.cssText = 'margin: 0 0 16px; color: var(--text-color-light); font-size: 13px;';
        later.textContent = 'you can install/uninstall the service later in settings.';
        container.appendChild(later);

        // v0.1.9 bookmark hint. ws-scrcpy-web is a web app served from
        // a local port — users naturally want to bookmark it. We tell
        // them to wait until after they've made the install-mode
        // decision because picking "service" shifts the port.
        const bookmarkHint = document.createElement('p');
        bookmarkHint.style.cssText =
            'margin: 0 0 16px; padding: 8px 12px; ' +
            'background: rgba(91, 154, 255, 0.08); border-left: 3px solid #5b9aff; ' +
            'color: var(--text-color-light); font-size: 13px; line-height: 1.5;';
        bookmarkHint.textContent =
            'tip: bookmark this page once you’ve picked an install mode. ' +
            'choosing "yes install service" shifts the server to a different port, ' +
            'so wait until after the redirect to bookmark the new URL.';
        container.appendChild(bookmarkHint);

        // v0.1.17 dependency-warning note. On first launch the dep manager
        // fetches Node, ADB, and scrcpy-server in the background — this can
        // run up to ~3 minutes on slower networks. During that window the
        // FirstRunBanner shows "installing dependencies…" with errors-in-
        // progress that look alarming but resolve themselves. Without this
        // note users assume something's wrong and start clicking around.
        const depHint = document.createElement('p');
        depHint.style.cssText =
            'margin: 0 0 16px; padding: 8px 12px; ' +
            'background: rgba(255, 191, 73, 0.08); border-left: 3px solid #ffbf49; ' +
            'color: var(--text-color-light); font-size: 13px; line-height: 1.5;';
        depHint.textContent =
            'heads up: on first launch we fetch Node, ADB, and scrcpy-server in the background. ' +
            'this can take up to ~3 minutes on slower networks, and you may see "missing dependency" ' +
            'warnings near the top of the page during that window. they clear themselves once ' +
            'the downloads finish — no action needed.';
        container.appendChild(depHint);

        this.statusEl = document.createElement('p');
        this.statusEl.style.cssText =
            'margin: 0 0 12px; color: var(--text-color-light); font-size: 13px; min-height: 1em;';
        container.appendChild(this.statusEl);

        // v0.1.10 don't-show-again checkbox. Only persists the dismissal
        // flag when the user clicks "no, run on demand" — the install-service
        // path redirects to the service instance which has its own modal.
        const dontShowLabel = document.createElement('label');
        dontShowLabel.style.cssText =
            'display: flex; align-items: center; gap: 8px; margin: 0 0 12px; ' +
            'font-size: 13px; color: var(--text-color-light); cursor: pointer;';
        this.dontShowCheckbox = document.createElement('input');
        this.dontShowCheckbox.type = 'checkbox';
        dontShowLabel.appendChild(this.dontShowCheckbox);
        dontShowLabel.appendChild(document.createTextNode("don't show this again on this browser"));
        container.appendChild(dontShowLabel);

        const buttons = document.createElement('div');
        buttons.style.cssText = 'display: flex; gap: 12px; justify-content: flex-end; flex-wrap: wrap;';

        this.yesBtn = document.createElement('button');
        this.yesBtn.textContent = 'yes, install service';
        this.yesBtn.style.cssText =
            'border: 0.5px solid var(--text-color, #ddd); border-radius: 6px; ' +
            'background: transparent; color: var(--text-color, #ddd); padding: 8px 16px; cursor: pointer;';
        this.yesBtn.addEventListener('click', () => {
            void this.onYes();
        });
        buttons.appendChild(this.yesBtn);

        this.noBtn = document.createElement('button');
        this.noBtn.textContent = 'no, run on demand';
        this.noBtn.style.cssText =
            'border: 0.5px solid var(--text-color, #ddd); border-radius: 6px; ' +
            'background: transparent; color: var(--text-color, #ddd); padding: 8px 16px; cursor: pointer;';
        this.noBtn.addEventListener('click', () => {
            void this.onNo();
        });
        buttons.appendChild(this.noBtn);

        container.appendChild(buttons);
    }

    private setStatus(msg: string, isError = false): void {
        this.statusEl.textContent = msg;
        this.statusEl.style.color = isError ? 'var(--error-color, #ff6b6b)' : 'var(--text-color-light)';
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

        if (statusResp.platform === 'linux' && statusResp.supported) {
            if (this.headingEl) this.headingEl.textContent = 'run as a systemd service?';
            if (this.descEl) {
                this.descEl.textContent =
                    'recommended for always-on access. the server starts at login ' + '(or boot, for system scope).';
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
            const reason = statusResp.unsupportedReason || 'service mode is not supported on this platform.';
            this.setStatus(`${reason} falling back to on-demand mode…`);
            const patch: Record<string, unknown> = { installMode: 'user' };
            if (this.dontShowCheckbox.checked) patch['firstRunComplete'] = true;
            const ok = await this.patchConfig(patch);
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
        const modal = new ServiceOperationModal({ operation: 'install' });
        try {
            const r = await fetch('/api/service/install', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
            });
            const data = (await r.json().catch(() => null)) as ServiceInstallResponse | null;
            if (!r.ok || !data || data.ok !== true) {
                const errMsg = data && data.ok === false ? data.error : `install failed (${r.status})`;
                this.setStatus(errMsg, true);
                this.setBusy(false);
                return;
            }
            if (this.dontShowCheckbox.checked) {
                await this.patchConfig({ firstRunComplete: true });
            }

            // §39: mtime-based discovery.
            const baselineMtime = data.configMtime ?? 0;
            const pollInterval = 2000;
            const maxIterations = 30;
            let iterations = 0;
            this.setStatus('service installed. waiting for it to start…');
            const poll = setInterval(async () => {
                iterations++;
                if (iterations > maxIterations) {
                    clearInterval(poll);
                    modal.close();
                    this.setStatus(
                        'service is running but port discovery timed out. reload at your usual address.',
                        true,
                    );
                    this.setBusy(false);
                    return;
                }
                try {
                    const statusResp = await fetch('/api/service/status', { signal: AbortSignal.timeout(5000) });
                    if (!statusResp.ok) return;
                    const statusData = (await statusResp.json()) as { configMtime?: number; diskWebPort?: number };
                    if (
                        statusData.configMtime != null &&
                        statusData.configMtime !== baselineMtime &&
                        statusData.diskWebPort != null
                    ) {
                        clearInterval(poll);
                        modal.close();
                        this.setStatus('service mode active. switching you over…');
                        setTimeout(() => {
                            window.location.href = `http://localhost:${statusData.diskWebPort}/`;
                        }, 500);
                    }
                } catch {
                    clearInterval(poll);
                    modal.close();
                    this.setStatus('lost connection during handoff. reload at the service port.', true);
                    this.setBusy(false);
                }
            }, pollInterval);
        } catch {
            this.setStatus("couldn't reach server. try again?", true);
            this.setBusy(false);
        }
    }

    /** "No, run on demand" — dismiss without persisting unless checkbox is checked. */
    private async onNo(): Promise<void> {
        if (this.dontShowCheckbox.checked) {
            this.setBusy(true);
            this.setStatus('saving…');
            // installMode + firstRunComplete are boot-trio fields → /api/config.
            // bookmarkDismissedForPort is a per-user prompt flag → /api/settings.
            const configOk = await this.patchConfig({
                installMode: 'user',
                firstRunComplete: true,
            });
            if (!configOk) {
                this.setStatus("couldn't save preference. try again?", true);
                this.setBusy(false);
                return;
            }
            // Fire-and-forget bookmark stamp — close succeeds even on network hiccup.
            void settingsService.patchGlobal({ bookmarkDismissedForPort: this.opts.webPort }).catch(() => {});
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
