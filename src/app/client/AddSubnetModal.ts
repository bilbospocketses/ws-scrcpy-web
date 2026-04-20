import { Modal } from '../ui/Modal';

export interface AddSubnetModalOptions {
    onAdded: (rawSubnet: string) => void;
}

export class AddSubnetModal extends Modal {
    private input!: HTMLInputElement;
    private status!: HTMLDivElement;
    private addBtn!: HTMLButtonElement;
    private readonly addedCallback: (rawSubnet: string) => void;

    constructor(options: AddSubnetModalOptions) {
        super({ title: 'Add Subnet to Scan' });
        this.addedCallback = options.onAdded;
        this.dialog.classList.add('add-subnet-modal');
    }

    protected buildBody(container: HTMLElement): void {
        const help = document.createElement('p');
        help.textContent = 'Accepted formats: CIDR (192.168.2.0/24), single IP (192.168.2.5), or range (192.168.2.10-50).';
        help.style.cssText = 'margin: 0 0 12px; color: var(--muted, #8b949e); font-size: 13px;';
        container.appendChild(help);

        this.input = document.createElement('input');
        this.input.type = 'text';
        this.input.placeholder = '192.168.2.0/24 or 192.168.2.5 or 192.168.2.10-50';
        this.input.style.cssText = 'width: 100%; padding: 8px; font-family: var(--font-mono, monospace);';
        this.input.addEventListener('input', () => this.revalidate());
        this.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !this.addBtn.disabled) this.submit();
        });
        container.appendChild(this.input);

        this.status = document.createElement('div');
        this.status.style.cssText = 'min-height: 18px; margin-top: 8px; font-size: 13px;';
        container.appendChild(this.status);
    }

    protected buildFooter(): HTMLElement | null {
        const footer = document.createElement('div');
        const cancel = document.createElement('button');
        cancel.textContent = 'cancel';
        cancel.addEventListener('click', () => this.close());
        this.addBtn = document.createElement('button');
        this.addBtn.textContent = 'add';
        this.addBtn.disabled = true;
        this.addBtn.addEventListener('click', () => this.submit());
        footer.appendChild(cancel);
        footer.appendChild(this.addBtn);
        return footer;
    }

    private revalidate(): void {
        const raw = this.input.value.trim();
        if (!raw) {
            this.status.textContent = '';
            this.addBtn.disabled = true;
            return;
        }
        // Client-side validation mirrors the server-side parser for instant feedback.
        import('../../common/SubnetParser').then(({ parseSubnetInput }) => {
            const r = parseSubnetInput(raw);
            if ('reason' in r) {
                this.status.textContent = `✗ ${r.reason}`;
                this.status.style.color = '#f06c75';
                this.addBtn.disabled = true;
            } else {
                const label = r.normalized.includes('/32')
                    ? `✓ single host`
                    : r.normalized.includes('-')
                        ? `✓ range, ${r.hostCount} host${r.hostCount === 1 ? '' : 's'}`
                        : `✓ CIDR, ${r.hostCount} host${r.hostCount === 1 ? '' : 's'}`;
                this.status.textContent = label;
                this.status.style.color = '#8ad67a';
                this.addBtn.disabled = false;
            }
        });
    }

    private submit(): void {
        const raw = this.input.value.trim();
        if (!raw) return;
        this.addedCallback(raw);
        this.close();
    }
}
