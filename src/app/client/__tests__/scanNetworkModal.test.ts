// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScanNetworkModal } from '../ScanNetworkModal';

beforeEach(() => {
    vi.restoreAllMocks();
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
    localStorage.clear();
});

afterEach(() => {
    document.body.querySelectorAll('dialog').forEach((d) => {
        d.remove();
    });
    localStorage.clear();
});

async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ScanNetworkModal — gateway detection UI', () => {
    it("renders the 'couldn't detect' notice visible when gatewaySubnet is null", async () => {
        const modal = new ScanNetworkModal({
            gatewaySubnet: null,
            onStartScan: vi.fn(),
        });
        await flush();

        const notice = modal['emptyNotice'];
        expect(notice).toBeDefined();
        expect(notice.textContent).toContain("Couldn't detect your gateway subnet");
        expect(notice.style.display).not.toBe('none');

        modal.close();
    });

    it('hides the notice when a gatewaySubnet is provided', async () => {
        const modal = new ScanNetworkModal({
            gatewaySubnet: { cidr: '192.168.1.0/24', hostCount: 254 },
            onStartScan: vi.fn(),
        });
        await flush();

        const notice = modal['emptyNotice'];
        expect(notice).toBeDefined();
        expect(notice.style.display).toBe('none');

        modal.close();
    });

    it('start-scan button is disabled when gateway is null and no user subnets', async () => {
        const onStartScan = vi.fn();
        const modal = new ScanNetworkModal({
            gatewaySubnet: null,
            onStartScan,
        });
        await flush();

        const startBtn = modal['startBtn'];
        expect(startBtn).toBeDefined();
        expect(startBtn.disabled).toBe(true);
        expect(onStartScan).not.toHaveBeenCalled();

        modal.close();
    });
});

describe('ScanNetworkModal — row editing', () => {
    it('renders a pencil (edit) button on every user-added row', async () => {
        localStorage.setItem('ws-scrcpy-web:scan-subnets', JSON.stringify(['10.0.0.0/24']));
        const modal = new ScanNetworkModal({
            gatewaySubnet: { cidr: '192.168.1.0/24', hostCount: 254 },
            onStartScan: vi.fn(),
        });
        await flush();
        await flush(); // second flush for the async addUserRow

        const list = modal['subnetListEl'];
        const userRow = [...list.children].find((li) => li.textContent?.includes('10.0.0.0/24')) as HTMLElement;
        expect(userRow).toBeDefined();
        const editBtn = userRow.querySelector<HTMLButtonElement>('button[aria-label="edit"]');
        const removeBtn = userRow.querySelector<HTMLButtonElement>('button[aria-label="remove"]');
        expect(editBtn).not.toBeNull();
        expect(removeBtn).not.toBeNull();

        modal.close();
    });

    it('does NOT render a pencil on the non-removable gateway row', async () => {
        const modal = new ScanNetworkModal({
            gatewaySubnet: { cidr: '192.168.1.0/24', hostCount: 254 },
            onStartScan: vi.fn(),
        });
        await flush();

        const list = modal['subnetListEl'];
        const gatewayRow = [...list.children].find((li) => li.textContent?.includes('detected gateway')) as HTMLElement;
        expect(gatewayRow).toBeDefined();
        expect(gatewayRow.querySelector('button[aria-label="edit"]')).toBeNull();

        modal.close();
    });

    it('updateUserRow replaces a row in place and persists the new value', async () => {
        localStorage.setItem('ws-scrcpy-web:scan-subnets', JSON.stringify(['10.0.0.0/24', '172.16.0.0/24']));
        const modal = new ScanNetworkModal({
            gatewaySubnet: null,
            onStartScan: vi.fn(),
        });
        await flush();
        await flush();

        const rowsBefore: Array<{ id: string; raw: string }> = modal['rows'].map((r: { id: string; raw: string }) => ({
            id: r.id,
            raw: r.raw,
        }));
        const firstUserRow = rowsBefore.find((r) => r.raw === '10.0.0.0/24');
        expect(firstUserRow).toBeDefined();
        const targetId = firstUserRow!.id;
        expect(typeof targetId).toBe('string');

        await modal['updateUserRow'](targetId, '192.168.99.0/24');

        const rowsAfter = modal['rows'];
        // Same position, new value
        const positionBefore = rowsBefore.findIndex((r) => r.raw === '10.0.0.0/24');
        expect(rowsAfter[positionBefore]!.raw).toBe('192.168.99.0/24');
        expect(rowsAfter.length).toBe(rowsBefore.length);
        // localStorage persists the new list
        const persisted = JSON.parse(localStorage.getItem('ws-scrcpy-web:scan-subnets')!);
        expect(persisted).toEqual(['192.168.99.0/24', '172.16.0.0/24']);

        modal.close();
    });
});
