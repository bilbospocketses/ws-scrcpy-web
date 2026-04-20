import { Modal } from '../ui/Modal';
import { AddSubnetModal } from './AddSubnetModal';
import { LargeSubnetWarningModal } from './LargeSubnetWarningModal';

const LS_KEY = 'ws-scrcpy-web:scan-subnets';

interface SubnetRow {
    raw: string;
    normalized: string;
    hostCount: number;
    annotation: string; // 'detected gateway subnet' | 'manually added'
    removable: boolean;
}

export interface ScanNetworkModalOptions {
    gatewaySubnet: {
        cidr: string;
        hostCount: number;
    } | null;
    onStartScan: (rawSubnets: string[]) => void;
}

export class ScanNetworkModal extends Modal {
    private readonly opts: ScanNetworkModalOptions;
    private rows: SubnetRow[] = [];
    private subnetListEl!: HTMLElement;
    private startBtn!: HTMLButtonElement;
    private emptyNotice!: HTMLElement;

    constructor(options: ScanNetworkModalOptions) {
        super({ title: 'Scan Network for Devices' });
        this.opts = options;
        this.dialog.classList.add('scan-network-modal');
        // super()'s buildBody deferred rendering — now run initial population
        queueMicrotask(() => {
            this.loadInitialRows();
            this.renderSubnetList();
            this.updateStartButton();
        });
    }

    protected buildBody(container: HTMLElement): void {
        queueMicrotask(() => this.fillBody(container));
    }

    private fillBody(container: HTMLElement): void {
        const explain = document.createElement('p');
        explain.textContent =
            'This scans your local network for Android devices with wireless debugging enabled. ' +
            'It checks mDNS broadcasts (modern devices) and probes port 5555 on each host in the ' +
            'selected subnets (older devices).';
        container.appendChild(explain);

        const warning = document.createElement('div');
        warning.style.cssText =
            'background: rgba(240,108,117,0.12); border: 1px solid #f06c75; color: #f06c75; ' +
            'padding: 10px 12px; border-radius: 4px; margin: 12px 0; font-size: 13px;';
        warning.innerHTML =
            '⚠ Scanning sends connection attempts to every host on the selected subnet(s). ' +
            'On managed or corporate networks this may trigger intrusion-detection alerts. ' +
            'Only scan networks you own or administer.';
        container.appendChild(warning);

        const listHeader = document.createElement('div');
        listHeader.textContent = 'Subnets to scan:';
        listHeader.style.cssText = 'margin-top: 8px; font-weight: 600;';
        container.appendChild(listHeader);

        this.emptyNotice = document.createElement('div');
        this.emptyNotice.style.cssText = 'color: #d0a050; font-size: 13px; padding: 6px 0;';
        this.emptyNotice.textContent = "Couldn't detect your gateway subnet. Add at least one subnet below to scan.";
        container.appendChild(this.emptyNotice);

        this.subnetListEl = document.createElement('ul');
        this.subnetListEl.style.cssText = 'list-style: none; padding: 0; margin: 8px 0; font-family: var(--font-mono, monospace); font-size: 13px;';
        container.appendChild(this.subnetListEl);

        const addBtn = document.createElement('button');
        addBtn.textContent = 'add subnet';
        addBtn.style.cssText = 'margin: 4px 0 12px;';
        addBtn.addEventListener('click', () => this.openAddSubnet());
        container.appendChild(addBtn);

        const cheatLink = document.createElement('p');
        cheatLink.style.cssText = 'font-size: 12px; color: var(--muted, #8b949e);';
        cheatLink.innerHTML = 'New to CIDR? See the <a href="help/subnets.html" target="_blank" rel="noopener">subnet cheat sheet</a>.';
        container.appendChild(cheatLink);
    }

    protected buildFooter(): HTMLElement | null {
        const footer = document.createElement('div');
        const cancel = document.createElement('button');
        cancel.textContent = 'cancel';
        cancel.addEventListener('click', () => this.close());
        this.startBtn = document.createElement('button');
        this.startBtn.textContent = 'start scan';
        this.startBtn.disabled = true;
        this.startBtn.addEventListener('click', () => this.onStartClick());
        footer.appendChild(cancel);
        footer.appendChild(this.startBtn);
        return footer;
    }

    private loadInitialRows(): void {
        this.rows = [];
        if (this.opts.gatewaySubnet) {
            this.rows.push({
                raw: this.opts.gatewaySubnet.cidr,
                normalized: this.opts.gatewaySubnet.cidr,
                hostCount: this.opts.gatewaySubnet.hostCount,
                annotation: 'detected gateway subnet',
                removable: false,
            });
        }
        const saved = this.loadSavedSubnets();
        for (const raw of saved) {
            void this.addUserRow(raw);
        }
    }

    private loadSavedSubnets(): string[] {
        try {
            const v = localStorage.getItem(LS_KEY);
            if (!v) return [];
            const arr = JSON.parse(v);
            return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
        } catch {
            return [];
        }
    }

    private saveSubnets(): void {
        const raws = this.rows.filter((r) => r.removable).map((r) => r.raw);
        try {
            localStorage.setItem(LS_KEY, JSON.stringify(raws));
        } catch {
            // Storage full or disabled — ignore
        }
    }

    private async addUserRow(raw: string): Promise<void> {
        const { parseSubnetInput } = await import('../../common/SubnetParser');
        const r = parseSubnetInput(raw);
        if ('reason' in r) return; // Already validated by AddSubnetModal; defensive skip.
        this.rows.push({
            raw,
            normalized: r.normalized,
            hostCount: r.hostCount,
            annotation: 'manually added',
            removable: true,
        });
        this.saveSubnets();
        this.renderSubnetList();
        this.updateStartButton();
    }

    private removeRow(idx: number): void {
        this.rows.splice(idx, 1);
        this.saveSubnets();
        this.renderSubnetList();
        this.updateStartButton();
    }

    private renderSubnetList(): void {
        if (!this.subnetListEl) return; // deferred render not yet populated
        this.subnetListEl.innerHTML = '';
        const hasAny = this.rows.length > 0;
        this.emptyNotice.style.display = hasAny ? 'none' : '';
        for (let i = 0; i < this.rows.length; i++) {
            const row = this.rows[i];
            const li = document.createElement('li');
            li.style.cssText = 'padding: 4px 0; display: flex; justify-content: space-between; align-items: center;';
            const label = document.createElement('span');
            label.textContent = `${row.normalized} — ${row.hostCount.toLocaleString()} host${row.hostCount === 1 ? '' : 's'} (${row.annotation})`;
            li.appendChild(label);
            if (row.removable) {
                const x = document.createElement('button');
                x.textContent = '×';
                x.setAttribute('aria-label', 'remove');
                x.style.cssText = 'background: none; border: none; color: #f06c75; font-size: 16px; cursor: pointer;';
                const idx = i;
                x.addEventListener('click', () => this.removeRow(idx));
                li.appendChild(x);
            }
            this.subnetListEl.appendChild(li);
        }
    }

    private updateStartButton(): void {
        if (!this.startBtn) return;
        const total = this.rows.reduce((s, r) => s + r.hostCount, 0);
        this.startBtn.disabled = total === 0;
    }

    private openAddSubnet(): void {
        new AddSubnetModal({
            onAdded: (raw: string) => void this.addUserRow(raw),
        });
    }

    private onStartClick(): void {
        const total = this.rows.reduce((s, r) => s + r.hostCount, 0);
        const rawSubnets = this.rows.map((r) => r.raw);
        if (total > 2048) {
            new LargeSubnetWarningModal({
                totalHosts: total,
                subnetBreakdown: this.rows.map((r) => ({
                    normalized: r.normalized,
                    hostCount: r.hostCount,
                    annotation: r.annotation,
                })),
                onContinue: () => {
                    this.close();
                    this.opts.onStartScan(rawSubnets);
                },
            });
            return;
        }
        this.close();
        this.opts.onStartScan(rawSubnets);
    }
}
