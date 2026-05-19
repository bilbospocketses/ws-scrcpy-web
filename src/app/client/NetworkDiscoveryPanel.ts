// src/app/client/NetworkDiscoveryPanel.ts

import { ScanNetworkModal } from './ScanNetworkModal';
import { ScanProgressChip } from './ScanProgressChip';
import { SCAN_WS_PATH, type ScanServerMessage } from '../../common/ScanMessage';

interface ConnectResult {
    success: boolean;
    message: string;
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export class NetworkDiscoveryPanel {
    private container: HTMLElement;
    private infoBox: HTMLElement;
    private resultsContainer: HTMLElement;
    private chip?: ScanProgressChip | undefined;
    private scanWs?: WebSocket | undefined;
    private scanSessionHits = new Map<string, HTMLElement>();
    private defaultInfoText = '';

    constructor() {
        this.container = document.createElement('div');
        this.container.id = 'discovery-panel';
        this.container.className = 'home-section';
        this.container.innerHTML = `
            <div class="discovery-header">
                <h2>Available Network Devices</h2>
                <div class="discovery-header-actions">
                    <button class="dep-btn discovery-quick-scan-btn" title="mDNS-only — finds modern Android devices with wireless debugging enabled">quick scan</button>
                    <button class="dep-btn discovery-scan-btn">scan network</button>
                    <button class="dep-btn discovery-manual-btn">manually add</button>
                </div>
            </div>
            <div class="discovery-manual-form" hidden>
                <input type="text" class="discovery-manual-address" placeholder="192.168.86.50" />
                <input type="text" class="discovery-manual-port" placeholder="5555" value="5555" />
                <input type="text" class="discovery-manual-label" placeholder="optional name" />
                <button class="dep-btn discovery-connect-btn discovery-manual-connect">connect</button>
                <button class="discovery-manual-close" aria-label="close" title="close">×</button>
                <div class="discovery-manual-result" hidden></div>
            </div>
            <div class="discovery-results"></div>
            <div class="empty-state-card discovery-info">Click quick scan for modern Android devices on your network, or scan network to probe a full subnet. Make sure wireless debugging is enabled on the devices you wish to connect with.</div>
        `;
        this.infoBox = this.container.querySelector('.discovery-info')!;
        this.defaultInfoText = this.infoBox.textContent ?? '';
        this.resultsContainer = this.container.querySelector('.discovery-results')!;
        this.container.querySelector('.discovery-scan-btn')!.addEventListener('click', () => this.scan());
        this.container.querySelector('.discovery-quick-scan-btn')!.addEventListener('click', () => this.quickScan());
        this.container.querySelector('.discovery-manual-btn')!.addEventListener('click', () => this.toggleManualForm());
        this.container.querySelector('.discovery-manual-close')!.addEventListener('click', () =>
            this.toggleManualForm(false),
        );
        this.container.querySelector('.discovery-manual-connect')!.addEventListener('click', () => this.manualConnect());
        for (const selector of ['.discovery-manual-address', '.discovery-manual-port', '.discovery-manual-label']) {
            const input = this.container.querySelector(selector) as HTMLInputElement;
            input.addEventListener('keydown', (e) => {
                if ((e as KeyboardEvent).key === 'Enter') this.manualConnect();
            });
        }
    }

    getElement(): HTMLElement {
        return this.container;
    }

    private setInfoText(text: string, error = false): void {
        this.infoBox.textContent = text;
        this.infoBox.style.color = error ? '#f87171' : '';
    }

    private restoreInfoText(): void {
        // If a scan error already swapped in error text, don't overwrite it on chip dismiss.
        if (this.infoBox.style.color === 'rgb(248, 113, 113)') return;
        this.infoBox.textContent = this.defaultInfoText;
        this.infoBox.style.color = '';
    }

    private async scan(): Promise<void> {
        // Fetch detected gateway subnet first
        let gateway: { cidr: string; hostCount: number } | null = null;
        try {
            const res = await fetch('/api/devices/scan/subnet');
            const detected = await res.json();
            if (detected && detected.cidr) {
                gateway = { cidr: detected.cidr, hostCount: detected.hostCount };
            }
        } catch {
            gateway = null;
        }

        new ScanNetworkModal({
            gatewaySubnet: gateway,
            onStartScan: (rawSubnets: string[]) => this.startScanWs(rawSubnets),
        });
    }

    private quickScan(): void {
        this.startScanWs([], { mdnsOnly: true });
    }

    private startScanWs(rawSubnets: string[], options: { mdnsOnly?: boolean } = {}): void {
        const mdnsOnly = options.mdnsOnly === true;

        // Clear the panel before a new scan (matches existing behavior)
        this.resultsContainer.innerHTML = '';
        this.scanSessionHits.clear();
        const grid = document.createElement('div');
        grid.className = 'discovery-grid';
        this.resultsContainer.appendChild(grid);

        // Full scan mounts the progress chip into the info box; quick scan uses lightweight inline status.
        this.chip?.dismiss();
        this.chip = undefined;
        this.infoBox.textContent = '';
        this.infoBox.style.color = '';
        if (mdnsOnly) {
            this.infoBox.textContent = 'scanning over mDNS…';
        } else {
            this.chip = new ScanProgressChip({
                parent: this.infoBox,
                onCancel: () => {
                    if (this.scanWs?.readyState === WebSocket.OPEN) {
                        this.scanWs.send(JSON.stringify({ type: 'scan.cancel' }));
                    }
                },
                onDismiss: () => this.restoreInfoText(),
            });
        }

        // Open the WS
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${proto}//${location.host}${SCAN_WS_PATH}`);
        this.scanWs = ws;

        ws.addEventListener('open', () => {
            const startMsg: { type: 'scan.start'; subnets: string[]; mdnsOnly?: boolean } = {
                type: 'scan.start',
                subnets: rawSubnets,
            };
            if (mdnsOnly) startMsg.mdnsOnly = true;
            ws.send(JSON.stringify(startMsg));
        });
        let terminalReceived = false;
        ws.addEventListener('message', (ev: MessageEvent) => {
            const msg: ScanServerMessage = JSON.parse(ev.data);
            if (msg.type === 'scan.complete' || msg.type === 'scan.cancelled' || msg.type === 'scan.error') {
                terminalReceived = true;
            }
            this.handleScanMessage(msg, grid, mdnsOnly);
        });
        ws.addEventListener('close', () => {
            this.scanWs = undefined;
            if (!terminalReceived) {
                this.setInfoText('Scan connection lost before completion.', true);
                this.chip?.dismiss();
            }
        });
        ws.addEventListener('error', () => {
            this.setInfoText('Scan connection failed.', true);
            this.chip?.dismiss();
        });
    }

    private handleScanMessage(msg: ScanServerMessage, grid: HTMLElement, mdnsOnly = false): void {
        switch (msg.type) {
            case 'scan.started':
                this.chip?.setScanning(0, msg.totalHosts, 0);
                break;
            case 'scan.progress':
                this.chip?.setScanning(msg.checked, msg.total, msg.foundSoFar);
                break;
            case 'scan.hit':
                this.renderHit(msg, grid);
                break;
            case 'scan.draining':
                this.chip?.setDraining();
                break;
            case 'scan.complete':
                if (mdnsOnly) {
                    if (msg.found === 0) {
                        this.setInfoText('No devices advertising over mDNS. Try scan network for a full subnet probe.');
                    } else {
                        this.restoreInfoText();
                    }
                } else {
                    this.chip?.setComplete(msg.found);
                }
                break;
            case 'scan.cancelled':
                this.chip?.setCancelled(msg.found);
                break;
            case 'scan.error':
                this.setInfoText(`Scan error: ${msg.reason}`, true);
                this.chip?.dismiss();
                break;
        }
    }

    private renderHit(hit: { address: string; serial: string; name: string; label: string }, grid: HTMLElement): void {
        if (this.scanSessionHits.has(hit.address)) return;
        const card = document.createElement('div');
        card.className = 'discovery-card';
        // Top line shows hit.name (adb-SERIAL for mDNS, model for TCP).
        // Empty name hides the top line via CSS .discovery-card-name:empty.
        const displayName = hit.name || '';
        card.innerHTML = `
            <div class="discovery-card-info">
                <div class="discovery-card-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</div>
                <div class="discovery-card-address" title="${escapeHtml(hit.address)}">${escapeHtml(hit.address)}</div>
            </div>
            <div class="discovery-card-actions">
                <input type="text" class="discovery-name-input" placeholder="Name this device..." value="${escapeHtml(hit.label || '')}" />
                <button class="dep-btn discovery-connect-btn" data-address="${escapeHtml(hit.address)}" data-serial="${escapeHtml(hit.serial)}">connect</button>
                <button class="dep-btn discovery-dismiss-btn" aria-label="dismiss" title="dismiss">close</button>
            </div>
            <div class="discovery-card-result" hidden></div>
        `;
        card.querySelector('.discovery-connect-btn')!.addEventListener('click', () =>
            this.connectDevice(hit.address, hit.serial, card),
        );
        card.querySelector('.discovery-dismiss-btn')!.addEventListener('click', () => {
            this.scanSessionHits.delete(hit.address);
            card.remove();
        });
        grid.appendChild(card);
        this.scanSessionHits.set(hit.address, card);
    }

    private toggleManualForm(show?: boolean): void {
        const form = this.container.querySelector('.discovery-manual-form') as HTMLElement;
        const shouldShow = show !== undefined ? show : form.hasAttribute('hidden');
        if (shouldShow) {
            form.removeAttribute('hidden');
            (this.container.querySelector('.discovery-manual-address') as HTMLInputElement).focus();
        } else {
            form.setAttribute('hidden', '');
            this.clearManualForm();
        }
    }

    private clearManualForm(): void {
        (this.container.querySelector('.discovery-manual-address') as HTMLInputElement).value = '';
        (this.container.querySelector('.discovery-manual-port') as HTMLInputElement).value = '5555';
        (this.container.querySelector('.discovery-manual-label') as HTMLInputElement).value = '';
        const resultEl = this.container.querySelector('.discovery-manual-result') as HTMLElement;
        resultEl.setAttribute('hidden', '');
        resultEl.textContent = '';
        resultEl.classList.remove('error', 'success');
    }

    private showManualResult(text: string, kind: 'success' | 'error'): void {
        const resultEl = this.container.querySelector('.discovery-manual-result') as HTMLElement;
        resultEl.textContent = text;
        resultEl.classList.toggle('success', kind === 'success');
        resultEl.classList.toggle('error', kind === 'error');
        resultEl.removeAttribute('hidden');
    }

    private async manualConnect(): Promise<void> {
        const addressInput = this.container.querySelector('.discovery-manual-address') as HTMLInputElement;
        const portInput = this.container.querySelector('.discovery-manual-port') as HTMLInputElement;
        const labelInput = this.container.querySelector('.discovery-manual-label') as HTMLInputElement;
        const btn = this.container.querySelector('.discovery-manual-connect') as HTMLButtonElement;

        const ip = addressInput.value.trim();
        const port = portInput.value.trim() || '5555';
        const label = labelInput.value.trim();

        if (!ip) {
            this.showManualResult('Address is required', 'error');
            addressInput.focus();
            return;
        }

        const address = `${ip}:${port}`;
        btn.disabled = true;
        btn.textContent = 'Connecting...';
        const resultEl = this.container.querySelector('.discovery-manual-result') as HTMLElement;
        resultEl.setAttribute('hidden', '');
        resultEl.textContent = '';
        resultEl.classList.remove('error', 'success');
        // §25b — using-declaration replaces the prior try/finally restoring
        // the manual-connect button. Captures `btn`.
        using _restoreBtn = {
            [Symbol.dispose](): void {
                btn.disabled = false;
                btn.textContent = 'connect';
            },
        };

        try {
            const res = await fetch('/api/devices/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address, label: label || undefined }),
            });
            const result: ConnectResult = await res.json();
            if (result.success) {
                this.showManualResult(`Connected to ${address}`, 'success');
                setTimeout(() => this.toggleManualForm(false), 2000);
            } else {
                this.showManualResult(result.message || `Failed to connect to ${address}`, 'error');
            }
        } catch (err: any) {
            this.showManualResult(err?.message || 'Request failed', 'error');
        }
    }

    private async connectDevice(address: string, serial: string, card: HTMLElement): Promise<void> {
        const btn = card.querySelector('.discovery-connect-btn') as HTMLButtonElement;
        const nameInput = card.querySelector('.discovery-name-input') as HTMLInputElement;
        const resultEl = card.querySelector('.discovery-card-result') as HTMLElement;
        const label = nameInput.value.trim();

        btn.disabled = true;
        resultEl.setAttribute('hidden', '');
        resultEl.textContent = '';
        resultEl.classList.remove('error', 'success');

        try {
            const res = await fetch('/api/devices/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address, serial, label: label || undefined }),
            });
            const result: ConnectResult = await res.json();
            if (result.success) {
                setTimeout(() => card.remove(), 1500);
            } else {
                btn.disabled = false;
                this.showCardResult(resultEl, result.message || `Failed to connect to ${address}`, 'error');
            }
        } catch (err: any) {
            btn.disabled = false;
            this.showCardResult(resultEl, err?.message || 'Request failed', 'error');
        }
    }

    private showCardResult(resultEl: HTMLElement, text: string, kind: 'success' | 'error'): void {
        resultEl.textContent = text;
        resultEl.classList.toggle('success', kind === 'success');
        resultEl.classList.toggle('error', kind === 'error');
        resultEl.removeAttribute('hidden');
    }
}
