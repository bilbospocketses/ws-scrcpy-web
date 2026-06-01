import { reconnectAfterApply } from './reconnectAfterApply';

type OverlayState = 'applying' | 'reconnecting' | 'timeout';

/**
 * Full-viewport, non-dismissible overlay shown during a Linux in-app update.
 * Pure DOM; it survives the server exiting during the Velopack swap (no network
 * needed to render). Lowercase copy per the app motif.
 */
export class UpgradingOverlay {
    private root: HTMLDivElement | null = null;
    private msg: HTMLParagraphElement | null = null;

    mount(): void {
        if (this.root) return;
        const root = document.createElement('div');
        root.className = 'upgrading-overlay';
        // Inline the few critical styles so the overlay renders even if the
        // stylesheet is mid-reload. Visual polish belongs in the stylesheet.
        root.style.cssText =
            'position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;' +
            'align-items:center;justify-content:center;gap:1rem;background:rgba(0,0,0,0.85);' +
            'color:#fff;font:14px/1.5 system-ui,sans-serif;text-align:center;padding:2rem;';
        const spinner = document.createElement('div');
        spinner.className = 'upgrading-overlay-spinner';
        const msg = document.createElement('p');
        msg.className = 'upgrading-overlay-msg';
        root.append(spinner, msg);
        document.body.appendChild(root);
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
        this.root?.remove();
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
