import { reconnectAfterApply } from './reconnectAfterApply';

type OverlayState = 'applying' | 'reconnecting' | 'timeout';

/**
 * Full-viewport, non-dismissible overlay shown during a Linux in-app update.
 * Pure DOM; it survives the server exiting during the Velopack swap (no network
 * needed to render). Lowercase copy per the app motif.
 */
export class UpgradingOverlay {
    private root: HTMLDialogElement | null = null;
    private msg: HTMLParagraphElement | null = null;

    mount(): void {
        if (this.root) return;
        const root = document.createElement('dialog');
        root.className = 'upgrading-overlay';
        // Inline critical styles so it renders even if the stylesheet is mid-reload.
        // It's a <dialog> in the top layer (via showModal), so it sits above the
        // Settings <dialog> regardless of z-index. Fill the viewport; kill default
        // dialog chrome.
        root.style.cssText =
            'position:fixed;inset:0;width:100vw;height:100vh;max-width:100vw;max-height:100vh;' +
            'box-sizing:border-box;border:none;margin:0;padding:2rem;display:flex;' +
            'flex-direction:column;align-items:center;justify-content:center;gap:1rem;' +
            'background:rgba(0,0,0,0.85);color:#fff;font:14px/1.5 system-ui,sans-serif;text-align:center;';
        const spinner = document.createElement('div');
        spinner.className = 'upgrading-overlay-spinner';
        const msg = document.createElement('p');
        msg.className = 'upgrading-overlay-msg';
        root.append(spinner, msg);
        document.body.appendChild(root);
        // showModal() promotes the dialog to the browser top layer, above any other
        // open modal (e.g. the Settings <dialog>) regardless of z-index. Guard for
        // jsdom/older engines where showModal may be absent.
        if (typeof root.showModal === 'function') {
            root.showModal();
        }
        this.root = root;
        this.msg = msg;
        this.setState('applying');
    }

    setState(state: OverlayState, url?: string): void {
        if (!this.msg) return;
        if (state === 'applying') {
            this.msg.textContent = 'updating — applying the new version…';
        } else if (state === 'reconnecting') {
            this.msg.textContent = 'updating — restarting and reconnecting…';
        } else {
            this.msg.textContent =
                `update applied. if this page doesn't return on its own, reopen ${url ?? 'the app url'}.`;
        }
    }

    remove(): void {
        if (this.root) {
            if (this.root.open && typeof this.root.close === 'function') {
                this.root.close();
            }
            this.root.remove();
        }
        this.root = null;
        this.msg = null;
    }
}

/**
 * Mount the overlay, poll-reconnect to the relaunched app, then reload on the
 * new version (or show the bookmark-URL fallback on timeout). DOM-coupled; the
 * apply handlers call this when the server returns mode:'reconnect' (Linux).
 */
export async function runUpgradingHandoff(previousVersion: string): Promise<void> {
    const overlay = new UpgradingOverlay();
    overlay.mount();
    overlay.setState('reconnecting');
    const result = await reconnectAfterApply({ previousVersion });
    if (result === 'updated') {
        window.location.reload();
    } else {
        overlay.setState('timeout', `${window.location.origin}/`);
    }
}
