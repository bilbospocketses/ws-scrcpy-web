// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AddSubnetModal } from '../AddSubnetModal';

beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
});

afterEach(() => {
    document.body.querySelectorAll('dialog').forEach((d) => {
        d.remove();
    });
});

async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

function titleOf(dialog: HTMLElement): string {
    return dialog.querySelector('.modal-title')?.textContent ?? '';
}

function submitBtnOf(dialog: HTMLElement): HTMLButtonElement | null {
    // The submit button is the second/last button in the footer (cancel is first)
    const footer = dialog.querySelector('.modal-footer');
    const buttons = footer?.querySelectorAll('button');
    return buttons ? (buttons[buttons.length - 1] as HTMLButtonElement) : null;
}

function inputOf(dialog: HTMLElement): HTMLInputElement | null {
    return dialog.querySelector('input[type="text"]');
}

describe('AddSubnetModal — add mode (default)', () => {
    it('renders with "Add Subnet to Scan" title and "add" button', async () => {
        new AddSubnetModal({ onSubmit: vi.fn() });
        await flush();
        const dialog = document.querySelector('dialog.add-subnet-modal') as HTMLElement;
        expect(titleOf(dialog)).toContain('Add Subnet');
        expect(submitBtnOf(dialog)?.textContent).toBe('add');
        expect(inputOf(dialog)?.value ?? '').toBe('');
    });
});

describe('AddSubnetModal — edit mode', () => {
    it('renders with "Edit Subnet" title and "save" button', async () => {
        new AddSubnetModal({
            mode: 'edit',
            initialValue: '10.0.0.0/24',
            onSubmit: vi.fn(),
        });
        await flush();
        const dialog = document.querySelector('dialog.add-subnet-modal') as HTMLElement;
        expect(titleOf(dialog)).toContain('Edit Subnet');
        expect(submitBtnOf(dialog)?.textContent).toBe('save');
    });

    it('pre-populates the input with the initial value and enables the save button', async () => {
        new AddSubnetModal({
            mode: 'edit',
            initialValue: '10.0.0.0/24',
            onSubmit: vi.fn(),
        });
        await flush();
        const dialog = document.querySelector('dialog.add-subnet-modal') as HTMLElement;
        const input = inputOf(dialog)!;
        expect(input.value).toBe('10.0.0.0/24');
        // Valid initial value should leave the submit button enabled (not disabled on open)
        expect(submitBtnOf(dialog)?.disabled).toBe(false);
    });

    it('calls onSubmit with the edited value when save is clicked', async () => {
        const onSubmit = vi.fn();
        new AddSubnetModal({
            mode: 'edit',
            initialValue: '10.0.0.0/24',
            onSubmit,
        });
        await flush();
        const dialog = document.querySelector('dialog.add-subnet-modal') as HTMLElement;
        const input = inputOf(dialog)!;
        input.value = '192.168.1.0/24';
        input.dispatchEvent(new Event('input'));
        submitBtnOf(dialog)!.click();
        expect(onSubmit).toHaveBeenCalledWith('192.168.1.0/24');
    });
});
