import { Modal } from '../ui/Modal';
import { parseSubnetInput } from '../../common/SubnetParser';

export type AddSubnetMode = 'add' | 'edit';

export interface AddSubnetModalOptions {
    onSubmit: (rawSubnet: string) => void;
    mode?: AddSubnetMode;
    initialValue?: string;
}

export class AddSubnetModal extends Modal {
    private input!: HTMLInputElement;
    private status!: HTMLDivElement;
    private addBtn!: HTMLButtonElement;
    private readonly submitCallback: (rawSubnet: string) => void;
    private readonly mode: AddSubnetMode;
    private readonly initialValue: string;

    constructor(options: AddSubnetModalOptions) {
        super({ title: options.mode === 'edit' ? 'Edit Subnet' : 'Add Subnet to Scan' });
        this.submitCallback = options.onSubmit;
        this.mode = options.mode ?? 'add';
        this.initialValue = options.initialValue ?? '';
        this.dialog.classList.add('add-subnet-modal');
    }

    protected buildBody(container: HTMLElement): void {
        // Defer so class-field init (after super) doesn't clobber assignments made here.
        queueMicrotask(() => this.fillBody(container));
    }

    private fillBody(container: HTMLElement): void {
        const help = document.createElement('p');
        help.textContent = 'Accepted formats: CIDR (192.168.2.0/24), single IP (192.168.2.5), or range (192.168.2.10-50).';
        help.style.cssText = 'margin: 0 0 12px; color: var(--muted, #8b949e); font-size: 13px;';
        container.appendChild(help);

        this.input = document.createElement('input');
        this.input.type = 'text';
        this.input.placeholder = '192.168.2.0/24 or 192.168.2.5 or 192.168.2.10-50';
        this.input.style.cssText = 'width: 100%; padding: 8px; font-family: var(--font-mono, monospace); box-sizing: border-box;';
        this.input.addEventListener('input', () => this.revalidate());
        this.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && this.addBtn && !this.addBtn.disabled) this.submit();
        });
        container.appendChild(this.input);

        this.status = document.createElement('div');
        this.status.style.cssText = 'min-height: 18px; margin-top: 8px; font-size: 13px; word-wrap: break-word;';
        container.appendChild(this.status);

        if (this.initialValue) {
            this.input.value = this.initialValue;
            this.revalidate();
        }
    }

    protected buildFooter(): HTMLElement | null {
        const footer = document.createElement('div');
        // Defer content so class-field init doesn't clobber this.addBtn.
        queueMicrotask(() => this.fillFooter(footer));
        return footer;
    }

    private fillFooter(footer: HTMLElement): void {
        const cancel = document.createElement('button');
        cancel.textContent = 'cancel';
        cancel.addEventListener('click', () => this.close());
        this.addBtn = document.createElement('button');
        this.addBtn.textContent = this.mode === 'edit' ? 'save' : 'add';
        this.addBtn.disabled = true;
        this.addBtn.addEventListener('click', () => this.submit());
        footer.appendChild(cancel);
        footer.appendChild(this.addBtn);
        // Edit mode starts with a valid pre-filled value — re-run validation so the save button enables.
        if (this.initialValue) this.revalidate();
    }

    private revalidate(): void {
        if (!this.input || !this.status || !this.addBtn) return;
        const raw = this.input.value.trim();
        if (!raw) {
            this.status.replaceChildren();
            this.addBtn.disabled = true;
            return;
        }
        const r = parseSubnetInput(raw);
        if ('reason' in r) {
            this.status.style.color = '#f06c75';
            this.renderErrorWithCheatSheetLink(r.reason);
            this.addBtn.disabled = true;
        } else {
            const label = r.normalized.includes('/32')
                ? `✓ single host`
                : r.normalized.includes('-')
                    ? `✓ range, ${r.hostCount} host${r.hostCount === 1 ? '' : 's'}`
                    : `✓ CIDR, ${r.hostCount} host${r.hostCount === 1 ? '' : 's'}`;
            this.status.style.color = '#8ad67a';
            this.status.textContent = label;
            this.addBtn.disabled = false;
        }
    }

    private renderErrorWithCheatSheetLink(message: string): void {
        // The parser embeds this exact sentence for cheat-sheet references.
        // We replace it with DOM that includes a clickable link.
        const CHEAT_SHEET_NOTE = 'See the subnet cheat sheet at /help/subnets.html for help.';
        this.status.replaceChildren();

        const prefix = document.createTextNode('✗ ');
        this.status.appendChild(prefix);

        const idx = message.indexOf(CHEAT_SHEET_NOTE);
        if (idx === -1) {
            // No cheat-sheet sentence — just plain text
            this.status.appendChild(document.createTextNode(message));
            return;
        }

        const before = message.slice(0, idx);
        const after = message.slice(idx + CHEAT_SHEET_NOTE.length);
        if (before) this.status.appendChild(document.createTextNode(before));
        this.status.appendChild(document.createTextNode('See the '));
        const link = document.createElement('a');
        link.href = 'help/subnets.html';
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'subnet cheat sheet';
        link.style.cssText = 'color: #58a6ff; text-decoration: underline;';
        this.status.appendChild(link);
        this.status.appendChild(document.createTextNode(' for help.'));
        if (after) this.status.appendChild(document.createTextNode(after));
    }

    private submit(): void {
        if (!this.input) return;
        const raw = this.input.value.trim();
        if (!raw) return;
        this.submitCallback(raw);
        this.close();
    }
}
