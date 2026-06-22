import { Modal } from '../ui/Modal';
import { AddSubnetModal } from './AddSubnetModal';
import { LargeSubnetWarningModal } from './LargeSubnetWarningModal';
import type { SettingsService } from './SettingsService';

let nextRowId = 0;
function makeRowId(): string {
    return `row-${++nextRowId}`;
}

interface SubnetRow {
    id: string;
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
    // Captured during loadInitialRows; sync callers (saveSubnets) reach it without re-importing.
    private settings: SettingsService | undefined;

    constructor(options: ScanNetworkModalOptions) {
        super({ title: 'Scan Network for Devices' });
        this.opts = options;
        this.dialog.classList.add('scan-network-modal');
        // super()'s buildBody deferred rendering — now run initial population.
        // loadInitialRows is async (awaits loadGlobal); the microtask body is async
        // so the await lands correctly.
        queueMicrotask(async () => {
            await this.loadInitialRows();
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
        this.subnetListEl.style.cssText =
            'list-style: none; padding: 0; margin: 8px 0; font-family: var(--font-mono, monospace); font-size: 13px;';
        container.appendChild(this.subnetListEl);

        const addBtn = document.createElement('button');
        addBtn.textContent = 'add subnet';
        addBtn.style.cssText = 'margin: 4px 0 12px;';
        addBtn.addEventListener('click', () => this.openAddSubnet());
        container.appendChild(addBtn);

        const cheatLink = document.createElement('p');
        cheatLink.style.cssText = 'font-size: 12px; color: var(--text-color-light);';
        cheatLink.innerHTML =
            'New to CIDR? See the <a href="help/subnets.html" target="_blank" rel="noopener">subnet cheat sheet</a>.';
        container.appendChild(cheatLink);
    }

    protected override buildFooter(): HTMLElement | null {
        const footer = document.createElement('div');
        // Defer content so class-field init (after super) doesn't clobber this.startBtn.
        queueMicrotask(() => this.fillFooter(footer));
        return footer;
    }

    private fillFooter(footer: HTMLElement): void {
        const cancel = document.createElement('button');
        cancel.textContent = 'cancel';
        cancel.addEventListener('click', () => this.close());
        this.startBtn = document.createElement('button');
        this.startBtn.textContent = 'start scan';
        this.startBtn.disabled = true;
        this.startBtn.addEventListener('click', () => this.onStartClick());
        footer.appendChild(cancel);
        footer.appendChild(this.startBtn);
        // After the footer is populated, sync the disabled state with current rows.
        this.updateStartButton();
    }

    private async loadInitialRows(): Promise<void> {
        this.rows = [];
        if (this.opts.gatewaySubnet) {
            this.rows.push({
                id: makeRowId(),
                raw: this.opts.gatewaySubnet.cidr,
                normalized: this.opts.gatewaySubnet.cidr,
                hostCount: this.opts.gatewaySubnet.hostCount,
                annotation: 'detected gateway subnet',
                removable: false,
            });
        }
        // Capture the singleton into a private field so the synchronous saveSubnets
        // callers (addUserRow, updateUserRow, removeRowById) can reach it without
        // re-importing. The await below precedes any save call, so this.settings is
        // always populated before the first write.
        const { settingsService } = await import('./SettingsService');
        this.settings = settingsService;
        await settingsService.loadGlobal(); // cache hit after boot warm-up
        const v = settingsService.getGlobalCached()['scanSubnets'];
        const saved = Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
        for (const raw of saved) void this.addUserRow(raw);
    }

    private saveSubnets(): void {
        const raws = this.rows.filter((r) => r.removable).map((r) => r.raw);
        // Fire-and-forget: sync callers (addUserRow, updateUserRow, removeRowById)
        // run only after loadInitialRows has populated this.settings.
        void this.settings?.patchGlobal({ scanSubnets: raws }).catch((e) =>
            console.error('[ScanNetworkModal] patchGlobal scanSubnets failed', e),
        );
    }

    private async addUserRow(raw: string): Promise<void> {
        const { parseSubnetInput } = await import('../../common/SubnetParser');
        const r = parseSubnetInput(raw);
        if ('reason' in r) return; // Already validated by AddSubnetModal; defensive skip.
        this.rows.push({
            id: makeRowId(),
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

    private async updateUserRow(id: string, raw: string): Promise<void> {
        const idx = this.rows.findIndex((r) => r.id === id);
        if (idx === -1) return;
        const { parseSubnetInput } = await import('../../common/SubnetParser');
        const r = parseSubnetInput(raw);
        if ('reason' in r) return; // Already validated by AddSubnetModal.
        this.rows[idx] = {
            ...this.rows[idx]!,
            raw,
            normalized: r.normalized,
            hostCount: r.hostCount,
        };
        this.saveSubnets();
        this.renderSubnetList();
        this.updateStartButton();
    }

    private removeRowById(id: string): void {
        const idx = this.rows.findIndex((r) => r.id === id);
        if (idx === -1) return;
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
        for (const row of this.rows) {
            const li = document.createElement('li');
            li.style.cssText = 'padding: 4px 0; display: flex; justify-content: space-between; align-items: center;';
            const label = document.createElement('span');
            label.textContent = `${row.normalized} — ${row.hostCount.toLocaleString()} host${row.hostCount === 1 ? '' : 's'} (${row.annotation})`;
            li.appendChild(label);
            if (row.removable) {
                const actions = document.createElement('span');
                actions.style.cssText = 'display: inline-flex; align-items: center; gap: 4px;';

                const edit = document.createElement('button');
                edit.textContent = '✎';
                edit.setAttribute('aria-label', 'edit');
                edit.title = 'edit subnet';
                edit.style.cssText =
                    'background: none; border: none; color: #58a6ff; font-size: 14px; cursor: pointer;';
                edit.addEventListener('click', () => this.openEditSubnet(row.id, row.raw));
                actions.appendChild(edit);

                const x = document.createElement('button');
                x.textContent = '×';
                x.setAttribute('aria-label', 'remove');
                x.style.cssText = 'background: none; border: none; color: #f06c75; font-size: 16px; cursor: pointer;';
                x.addEventListener('click', () => this.removeRowById(row.id));
                actions.appendChild(x);

                li.appendChild(actions);
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
            onSubmit: (raw: string) => void this.addUserRow(raw),
        });
    }

    private openEditSubnet(id: string, currentRaw: string): void {
        new AddSubnetModal({
            mode: 'edit',
            initialValue: currentRaw,
            onSubmit: (raw: string) => void this.updateUserRow(id, raw),
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
