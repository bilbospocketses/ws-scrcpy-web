// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceOperationModal } from '../ServiceOperationModal';

beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
        if (this.hasAttribute('open')) {
            throw new DOMException(
                "Failed to execute 'showModal' on 'HTMLDialogElement': The element already has an 'open' attribute, and therefore cannot be opened modally.",
                'InvalidStateError',
            );
        }
        this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute('open');
    });
});

afterEach(() => {
    document.body.replaceChildren();
});

describe('ServiceOperationModal', () => {
    it('install: title is "installing service"', () => {
        new ServiceOperationModal({ operation: 'install' });
        expect(document.querySelector('.modal-title')!.textContent).toBe('installing service');
    });

    it('uninstall: title is "uninstalling service"', () => {
        new ServiceOperationModal({ operation: 'uninstall' });
        expect(document.querySelector('.modal-title')!.textContent).toBe('uninstalling service');
    });

    it('body contains "please wait" text', () => {
        new ServiceOperationModal({ operation: 'install' });
        expect(document.querySelector('.modal-body')!.textContent).toContain('please wait');
    });

    it('close() closes the dialog', () => {
        const modal = new ServiceOperationModal({ operation: 'install' });
        const dialog = document.querySelector('dialog')!;
        expect(dialog.hasAttribute('open')).toBe(true);
        modal.close();
        expect(dialog.hasAttribute('open')).toBe(false);
    });

    it('escape key does not dismiss the modal', () => {
        new ServiceOperationModal({ operation: 'install' });
        const dialog = document.querySelector('dialog')!;
        const event = new Event('cancel', { cancelable: true });
        dialog.dispatchEvent(event);
        expect(dialog.hasAttribute('open')).toBe(true);
    });

    it('dialog has service-operation-modal class', () => {
        new ServiceOperationModal({ operation: 'install' });
        expect(document.querySelector('dialog')!.classList.contains('service-operation-modal')).toBe(true);
    });
});
