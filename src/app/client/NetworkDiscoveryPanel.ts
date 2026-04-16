// src/app/client/NetworkDiscoveryPanel.ts

interface MdnsDevice {
    name: string;
    service: string;
    address: string;
    port: number;
    serial: string;
    label: string;
}

interface ConnectResult {
    success: boolean;
    message: string;
}

export class NetworkDiscoveryPanel {
    private container: HTMLElement;
    private infoBox: HTMLElement;
    private resultsContainer: HTMLElement;

    constructor() {
        this.container = document.createElement('div');
        this.container.id = 'discovery-panel';
        this.container.className = 'home-section';
        this.container.innerHTML = `
            <div class="discovery-header">
                <h2>Available Network Devices</h2>
                <button class="dep-btn discovery-scan-btn">Scan Network</button>
            </div>
            <div class="discovery-results"></div>
            <div class="empty-state-card discovery-info">Click Scan Network to find devices. Make sure wireless debugging is enabled on the devices you wish to connect with.</div>
        `;
        this.infoBox = this.container.querySelector('.discovery-info')!;
        this.resultsContainer = this.container.querySelector('.discovery-results')!;
        this.container.querySelector('.discovery-scan-btn')!.addEventListener('click', () => this.scan());
    }

    getElement(): HTMLElement {
        return this.container;
    }

    private setInfoText(text: string, error = false): void {
        this.infoBox.textContent = text;
        this.infoBox.style.color = error ? '#f87171' : '';
    }

    private async scan(): Promise<void> {
        const btn = this.container.querySelector('.discovery-scan-btn') as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = 'Scanning...';
        this.setInfoText('Scanning local network for ADB devices...');
        this.resultsContainer.innerHTML = '';

        try {
            const res = await fetch('/api/devices/scan', { method: 'POST' });
            const devices: MdnsDevice[] = await res.json();
            this.renderResults(devices);
        } catch {
            this.setInfoText('Scan failed. Is ADB available?', true);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Scan Network';
        }
    }

    private renderResults(devices: MdnsDevice[]): void {
        if (devices.length === 0) {
            this.setInfoText('No new devices found on the network. Make sure wireless debugging is enabled on your devices.');
            return;
        }

        this.setInfoText('Click Scan Network to find devices. Make sure wireless debugging is enabled on the devices you wish to connect with.');
        this.resultsContainer.innerHTML = '';
        const grid = document.createElement('div');
        grid.className = 'discovery-grid';

        for (const device of devices) {
            const card = document.createElement('div');
            card.className = 'discovery-card';
            const addr = `${device.address}:${device.port}`;
            card.innerHTML = `
                <div class="discovery-card-info">
                    <div class="discovery-card-name">${device.name}</div>
                    <div class="discovery-card-address">${addr}</div>
                </div>
                <div class="discovery-card-actions">
                    <input type="text" class="discovery-name-input" placeholder="Name this device..." value="${device.label || ''}" />
                    <button class="dep-btn dep-update discovery-connect-btn" data-address="${addr}" data-serial="${device.serial}">Connect</button>
                </div>
            `;
            card.querySelector('.discovery-connect-btn')!.addEventListener('click', () =>
                this.connectDevice(addr, device.serial, card),
            );
            grid.appendChild(card);
        }
        this.resultsContainer.appendChild(grid);
    }

    private async connectDevice(address: string, serial: string, card: HTMLElement): Promise<void> {
        const btn = card.querySelector('.discovery-connect-btn') as HTMLButtonElement;
        const nameInput = card.querySelector('.discovery-name-input') as HTMLInputElement;
        const label = nameInput.value.trim();

        btn.disabled = true;
        btn.textContent = 'Connecting...';

        try {
            const res = await fetch('/api/devices/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address, serial, label: label || undefined }),
            });
            const result: ConnectResult = await res.json();
            if (result.success) {
                btn.textContent = 'Connected';
                btn.classList.remove('dep-update');
                btn.classList.add('dep-ok-btn');
                setTimeout(() => card.remove(), 1500);
            } else {
                btn.textContent = 'Failed';
                btn.disabled = false;
                setTimeout(() => {
                    btn.textContent = 'Connect';
                }, 2000);
            }
        } catch {
            btn.textContent = 'Error';
            btn.disabled = false;
            setTimeout(() => {
                btn.textContent = 'Connect';
            }, 2000);
        }
    }
}
