import { Modal } from '../ui/Modal';

export interface LargeSubnetWarningOptions {
    totalHosts: number;
    subnetBreakdown: { normalized: string; hostCount: number; annotation: string }[];
    onContinue: () => void;
}

export class LargeSubnetWarningModal extends Modal {
    private readonly data: LargeSubnetWarningOptions;

    constructor(options: LargeSubnetWarningOptions) {
        super({ title: 'Large Scan — Confirm' });
        this.data = options;
        this.dialog.classList.add('large-subnet-warning-modal');
    }

    protected buildBody(container: HTMLElement): void {
        // The Modal base's buildBody is called DURING super() — at that point
        // this.data is not yet set. We fill in content via a one-shot microtask
        // that runs after the constructor returns and this.data is populated.
        queueMicrotask(() => this.fillBody(container));
    }

    private fillBody(container: HTMLElement): void {
        const summary = document.createElement('p');
        summary.innerHTML =
            `The scan covers <strong>${this.data.totalHosts.toLocaleString()} hosts</strong> ` +
            `across <strong>${this.data.subnetBreakdown.length} subnet${this.data.subnetBreakdown.length === 1 ? '' : 's'}</strong>. ` +
            `At roughly 30 seconds per 1,000 hosts, this will take about <strong>${formatDuration(this.data.totalHosts)}</strong>.`;
        container.appendChild(summary);

        const list = document.createElement('ul');
        list.style.cssText = 'font-family: var(--font-mono, monospace); font-size: 13px; padding-left: 20px;';
        for (const row of this.data.subnetBreakdown) {
            const li = document.createElement('li');
            li.textContent = `${row.normalized} — ${row.hostCount.toLocaleString()} host${row.hostCount === 1 ? '' : 's'} (${row.annotation})`;
            list.appendChild(li);
        }
        container.appendChild(list);

        const advice = document.createElement('p');
        advice.textContent = 'To narrow the scan, cancel and edit subnets. Otherwise continue.';
        advice.style.cssText = 'margin-top: 12px; color: var(--muted, #8b949e); font-size: 13px;';
        container.appendChild(advice);
    }

    protected buildFooter(): HTMLElement | null {
        const footer = document.createElement('div');
        const cancel = document.createElement('button');
        cancel.textContent = 'cancel';
        cancel.addEventListener('click', () => this.close());
        const cont = document.createElement('button');
        cont.textContent = 'continue scan';
        cont.addEventListener('click', () => {
            this.data.onContinue();
            this.close();
        });
        footer.appendChild(cancel);
        footer.appendChild(cont);
        return footer;
    }
}

function formatDuration(totalHosts: number): string {
    const seconds = Math.round((totalHosts / 1000) * 30);
    if (seconds < 60) return `${seconds} seconds`;
    const minutes = Math.round(seconds / 60);
    return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}
