import { Modal } from '../ui/Modal';
import { setServiceFirstRunDismissed } from './firstRunGate';

/**
 * One-shot informational modal shown on the FIRST page load of a
 * service-mode instance. Tells the user "this is the URL you want to
 * bookmark; the service runs at boot so this URL stays valid even
 * across reboots." Single dismiss button. Persists `serviceFirstRunSeen
 * = true` so the modal never shows again on subsequent loads.
 *
 * Triggered by `maybeShowServiceFirstRunModal()` in `src/app/index.ts`
 * when the GET /api/config envelope reports:
 *   - installMode is 'user-service' or 'system-service' (we are a
 *     service instance), AND
 *   - serviceFirstRunSeen is false (the user hasn't dismissed it yet)
 *
 * Deliberately separate from WelcomeModal — that modal's purpose is
 * "pick install mode," which doesn't apply on a service instance
 * (the service IS already installed). v0.1.8 had a bug where the
 * service instance showed WelcomeModal because firstRunComplete was
 * still false in its in-memory config; v0.1.9 gates WelcomeModal on
 * installMode and routes the service-instance path here instead.
 */
export interface ServiceFirstRunModalOptions {
    webPort: number;
    /** Notified after the modal is dismissed and the flag is persisted. */
    onDismissed?: () => void;
}

export class ServiceFirstRunModal extends Modal {
    private opts!: ServiceFirstRunModalOptions;
    private dismissBtn: HTMLButtonElement | null = null;
    private dontShowCheckbox: HTMLInputElement | null = null;

    constructor(options: ServiceFirstRunModalOptions) {
        super({ title: 'ws-scrcpy-web is running as a service' });
        this.opts = options;
        // Defer body fill past class-field init phase
        // (ES2022 useDefineForClassFields). Same pattern as
        // WelcomeModal. The footer is set up via buildFooter() which
        // the base class invokes at construction; the dismiss button
        // is captured into this.dismissBtn there.
        queueMicrotask(() => {
            this.fillBody(this.bodyEl);
        });
    }

    protected buildBody(_container: HTMLElement): void {
        // Body content is rendered by fillBody() from the constructor.
    }

    protected buildFooter(): HTMLElement | null {
        const footer = document.createElement('div');
        const btn = document.createElement('button');
        btn.textContent = 'got it';
        btn.className = 'modal-button modal-button-primary';
        btn.addEventListener('click', () => void this.dismiss());
        footer.appendChild(btn);
        this.dismissBtn = btn;
        return footer;
    }

    private fillBody(container: HTMLElement): void {
        const intro = document.createElement('p');
        intro.style.cssText = 'margin: 0 0 12px;';
        intro.appendChild(document.createTextNode('the service is installed and will start automatically every time your computer boots.'));
        container.appendChild(intro);

        const url = `http://localhost:${this.opts.webPort}`;
        const urlPara = document.createElement('p');
        urlPara.style.cssText = 'margin: 0 0 12px;';
        urlPara.appendChild(document.createTextNode('this page lives at: '));
        const urlAnchor = document.createElement('a');
        urlAnchor.href = url;
        urlAnchor.target = '_blank';
        urlAnchor.rel = 'noopener';
        urlAnchor.textContent = url;
        urlAnchor.style.cssText = 'color: #5b9aff;';
        urlPara.appendChild(urlAnchor);
        container.appendChild(urlPara);

        const tip = document.createElement('p');
        tip.style.cssText =
            'margin: 0 0 12px; padding: 8px 12px; ' +
            'background: rgba(91, 154, 255, 0.08); border-left: 3px solid #5b9aff; ' +
            'color: var(--text-color-light); font-size: 13px; line-height: 1.5;';
        tip.textContent =
            'tip: bookmark this URL now. the service keeps it valid across reboots, ' +
            'so you can return here any time without reopening the desktop app.';
        container.appendChild(tip);

        // v0.1.10 don't-show-again checkbox. Only the box+button combo
        // persists the dismissal — without the checkbox, the modal will
        // re-appear on the next page load. Pre-v0.1.10 dismissal was
        // tracked server-side as serviceFirstRunSeen, which got reset
        // by uninstall/reinstall cycles. localStorage survives those.
        const dontShowLabel = document.createElement('label');
        dontShowLabel.style.cssText =
            'display: flex; align-items: center; gap: 8px; margin: 0; ' +
            'font-size: 13px; color: var(--text-color-light); cursor: pointer;';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        dontShowLabel.appendChild(checkbox);
        dontShowLabel.appendChild(
            document.createTextNode("don't show this again on this browser"),
        );
        this.dontShowCheckbox = checkbox;
        container.appendChild(dontShowLabel);
    }

    private async dismiss(): Promise<void> {
        if (this.dismissBtn) this.dismissBtn.disabled = true;
        if (this.dontShowCheckbox?.checked) {
            setServiceFirstRunDismissed();
        }
        // Keep persisting serviceFirstRunSeen on the server too — other
        // code paths (e.g., the resume-token UX overlay) may still read
        // it for reasons unrelated to modal-gating. localStorage is now
        // the modal authority; the server flag is non-load-bearing for
        // gating but harmless to maintain.
        try {
            await fetch('/api/config', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ serviceFirstRunSeen: true }),
            });
        } catch {
            /* fall-through: still close */
        }
        this.opts.onDismissed?.();
        this.close();
    }
}
