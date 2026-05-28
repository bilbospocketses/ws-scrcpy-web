import { Modal } from '../ui/Modal';

/**
 * v0.1.10: bookmark reminder shown whenever the page loads on a port
 * the user has not yet acknowledged via the "don't show again" gate.
 *
 * Each port the user might land on (default 8000, an auto-shifted
 * port from a clash, a service-mode reassignment, a manual port
 * change in settings) needs its own bookmark — the URL changes when
 * the port changes, and the user's existing bookmark would 404
 * after a port change.
 *
 * Gating rule: config.json's `bookmarkDismissedForPort` stores the
 * port number that was last acknowledged. On every page load we
 * compare against the current port and re-show the modal if they
 * differ. The modal can only be permanently dismissed for the CURRENT
 * port — the user must check "don't show again" AND click "got it."
 * Closing without the checkbox leaves the flag unchanged, so the
 * modal will return on the next page load.
 *
 * v0.1.30-beta.8: migrated from localStorage to config.json. The
 * localStorage version was unreliable on Linux AppImage where the
 * browser may treat each launch as a different origin.
 *
 * Distinct from WelcomeModal/ServiceFirstRunModal: those are about
 * pick-an-install-mode and service-mode-orientation respectively.
 * This one is purely about "your URL just changed; bookmark it."
 */
export interface PortChangeModalOptions {
    webPort: number;
    /** Notified after the modal closes (regardless of checkbox state). */
    onDismissed?: () => void;
}

export class PortChangeModal extends Modal {
    private opts!: PortChangeModalOptions;
    private dismissBtn: HTMLButtonElement | null = null;
    private dontShowCheckbox: HTMLInputElement | null = null;

    constructor(options: PortChangeModalOptions) {
        super({ title: 'bookmark this URL' });
        this.opts = options;
        // Same deferred-fill pattern as WelcomeModal/ServiceFirstRunModal:
        // queueMicrotask so this.opts is set before fillBody reads it.
        queueMicrotask(() => {
            this.fillBody(this.bodyEl);
        });
    }

    protected buildBody(_container: HTMLElement): void {
        // Body content is rendered by fillBody() from the constructor.
    }

    protected override buildFooter(): HTMLElement | null {
        const footer = document.createElement('div');
        const btn = document.createElement('button');
        btn.textContent = 'got it';
        btn.className = 'modal-button modal-button-primary';
        btn.addEventListener('click', () => this.dismiss());
        footer.appendChild(btn);
        this.dismissBtn = btn;
        return footer;
    }

    private fillBody(container: HTMLElement): void {
        const url = `http://localhost:${this.opts.webPort}`;

        const lead = document.createElement('p');
        lead.style.cssText = 'margin: 0 0 12px;';
        lead.textContent = 'this app lives at:';
        container.appendChild(lead);

        const urlPara = document.createElement('p');
        urlPara.style.cssText = 'margin: 0 0 12px;';
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
            'bookmark this URL so you can return to the app any time. ' +
            'if the port ever changes (e.g., a service install or settings tweak), ' +
            'this reminder will return so you can update your bookmark.';
        container.appendChild(tip);

        const dontShowLabel = document.createElement('label');
        dontShowLabel.style.cssText =
            'display: flex; align-items: center; gap: 8px; margin: 0; ' +
            'font-size: 13px; color: var(--text-color-light); cursor: pointer;';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        dontShowLabel.appendChild(checkbox);
        dontShowLabel.appendChild(
            document.createTextNode("don't show this again for this port"),
        );
        this.dontShowCheckbox = checkbox;
        container.appendChild(dontShowLabel);
    }

    private dismiss(): void {
        if (this.dismissBtn) this.dismissBtn.disabled = true;
        if (this.dontShowCheckbox?.checked) {
            // Fire-and-forget; modal closes regardless of network outcome.
            void fetch('/api/config', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bookmarkDismissedForPort: this.opts.webPort }),
            }).catch(() => { /* network hiccup — modal will re-show next load */ });
        }
        this.opts.onDismissed?.();
        this.close();
    }
}
