export type ChipState = 'scanning' | 'draining' | 'complete' | 'cancelled';

export interface ScanProgressChipOptions {
    parent: HTMLElement; // mounts inside this element
    onCancel: () => void;
}

export class ScanProgressChip {
    private readonly el: HTMLDivElement;
    private readonly label: HTMLSpanElement;
    private readonly cancelBtn: HTMLButtonElement;
    private readonly dismissBtn: HTMLButtonElement;
    private autoHideTimer?: number;

    constructor(private readonly opts: ScanProgressChipOptions) {
        this.el = document.createElement('div');
        this.el.className = 'scan-progress-chip';
        this.el.style.cssText =
            'display: flex; align-items: center; gap: 12px; padding: 6px 12px; margin: 6px 0; ' +
            'background: rgba(88,166,255,0.12); border: 1px solid #58a6ff; border-radius: 16px; ' +
            'font-size: 13px; font-family: var(--font-mono, monospace); color: var(--text, #e6edf3);';

        this.label = document.createElement('span');
        this.el.appendChild(this.label);

        this.cancelBtn = document.createElement('button');
        this.cancelBtn.textContent = 'cancel';
        this.cancelBtn.style.cssText = 'margin-left: auto;';
        this.cancelBtn.addEventListener('click', () => this.opts.onCancel());
        this.el.appendChild(this.cancelBtn);

        this.dismissBtn = document.createElement('button');
        this.dismissBtn.textContent = '×';
        this.dismissBtn.setAttribute('aria-label', 'dismiss');
        this.dismissBtn.style.cssText = 'margin-left: auto; background: none; border: none; color: var(--muted, #8b949e); cursor: pointer;';
        this.dismissBtn.addEventListener('click', () => this.dismiss());
        this.dismissBtn.hidden = true;
        this.el.appendChild(this.dismissBtn);

        this.opts.parent.insertBefore(this.el, this.opts.parent.firstChild);
        this.setScanning(0, 0, 0);
    }

    setScanning(checked: number, total: number, foundSoFar: number): void {
        this.setState('scanning');
        const counter = total > 0 ? ` · ${checked} / ${total}` : '';
        const found = foundSoFar > 0 ? ` · ${foundSoFar} found` : '';
        this.label.textContent = `Scanning network${counter}${found}`;
    }

    setDraining(): void {
        this.setState('draining');
        this.label.textContent = 'Finishing active scans…';
    }

    setComplete(found: number): void {
        this.setState('complete');
        this.label.textContent = `Scan complete · ${found} device${found === 1 ? '' : 's'} found`;
        this.scheduleAutoHide(5000);
    }

    setCancelled(found: number): void {
        this.setState('cancelled');
        this.label.textContent = `Scan cancelled · ${found} device${found === 1 ? '' : 's'} found`;
        this.scheduleAutoHide(10000);
    }

    dismiss(): void {
        if (this.autoHideTimer) clearTimeout(this.autoHideTimer);
        this.el.remove();
    }

    private setState(state: ChipState): void {
        this.cancelBtn.hidden = state !== 'scanning';
        this.dismissBtn.hidden = state !== 'complete' && state !== 'cancelled';
    }

    private scheduleAutoHide(ms: number): void {
        if (this.autoHideTimer) clearTimeout(this.autoHideTimer);
        this.autoHideTimer = setTimeout(() => this.dismiss(), ms) as unknown as number;
    }
}
