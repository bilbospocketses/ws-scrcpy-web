// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Modal } from '../Modal';

// jsdom doesn't implement showModal/close — stub them
beforeEach(() => {
    vi.restoreAllMocks();
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
});

afterEach(() => {
    // Clean up any dialogs left in the DOM
    document.body.querySelectorAll('dialog').forEach((d) => {
        d.remove();
    });
    vi.useRealTimers();
});

// Concrete test subclass with default dismiss behavior
class TestModal extends Modal {
    // NOTE: class field initializers run AFTER super(), so we use a method-level
    // side effect visible in the DOM instead of a simple boolean flag.
    protected buildBody(container: HTMLElement): void {
        const p = document.createElement('p');
        p.textContent = 'test content';
        container.appendChild(p);
    }
}

// Subclass that blocks escape and backdrop, confirms on X
class StickyModal extends Modal {
    public escapeCalled = false;
    public backdropCalled = false;
    public closeButtonCalled = false;

    protected buildBody(container: HTMLElement): void {
        container.textContent = 'sticky';
    }

    protected override onEscapeKey(_event: Event): void {
        this.escapeCalled = true;
    }

    protected override onBackdropClick(_event: MouseEvent): void {
        this.backdropCalled = true;
    }

    protected override onCloseButtonClick(): void {
        this.closeButtonCalled = true;
        this.close();
    }
}

// Subclass with a footer
class FooterModal extends Modal {
    protected buildBody(container: HTMLElement): void {
        container.textContent = 'body';
    }

    protected override buildFooter(): HTMLElement | null {
        const footer = document.createElement('div');
        footer.textContent = 'footer content';
        return footer;
    }
}

describe('Modal base class', () => {
    it('creates a <dialog> element with modal class', () => {
        const modal = new TestModal({ title: 'test' });
        expect(modal['dialog'].tagName).toBe('DIALOG');
        expect(modal['dialog'].classList.contains('modal')).toBe(true);
        modal.close();
    });

    it('calls showModal() on construction', () => {
        const modal = new TestModal({ title: 'test' });
        expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalled();
        modal.close();
    });

    it('calls buildBody during construction', () => {
        const modal = new TestModal({ title: 'test' });
        // buildBody appends a <p> to the body — verify it's present
        const body = modal['dialog'].querySelector('.modal-body');
        expect(body?.querySelector('p')?.textContent).toBe('test content');
        modal.close();
    });

    it('sets the title text', () => {
        const modal = new TestModal({ title: 'my device' });
        const titleEl = modal['dialog'].querySelector('.modal-title');
        expect(titleEl?.textContent).toBe('my device');
        modal.close();
    });

    it('has a close button in the header', () => {
        const modal = new TestModal({ title: 'test' });
        // Close button is the last .modal-close element (theme toggle is first)
        const closeBtns = modal['dialog'].querySelectorAll('.modal-close');
        const closeBtn = closeBtns[closeBtns.length - 1];
        expect(closeBtn).not.toBeNull();
        expect(closeBtn?.textContent).toBe('\u00d7');
        modal.close();
    });

    it('builds DOM structure: dialog > modal-frame > header + body', () => {
        const modal = new TestModal({ title: 'test' });
        const frame = modal['dialog'].querySelector('.modal-frame');
        expect(frame).not.toBeNull();
        expect(frame?.querySelector('.modal-header')).not.toBeNull();
        expect(frame?.querySelector('.modal-body')).not.toBeNull();
        modal.close();
    });

    it('appends footer when buildFooter returns an element', () => {
        const modal = new FooterModal({ title: 'test' });
        const footer = modal['dialog'].querySelector('.modal-footer');
        expect(footer).not.toBeNull();
        expect(footer?.textContent).toBe('footer content');
        modal.close();
    });

    it('does not append footer when buildFooter returns null', () => {
        const modal = new TestModal({ title: 'test' });
        const footer = modal['dialog'].querySelector('.modal-footer');
        expect(footer).toBeNull();
        modal.close();
    });
});

describe('Modal dismiss behavior — defaults', () => {
    it('close() calls dialog.close()', () => {
        const modal = new TestModal({ title: 'test' });
        modal.close();
        expect(HTMLDialogElement.prototype.close).toHaveBeenCalled();
    });

    it('close() removes dialog from DOM after transition', () => {
        vi.useFakeTimers();
        const modal = new TestModal({ title: 'test' });
        const dialog = modal['dialog'];
        expect(document.body.contains(dialog)).toBe(true);
        modal.close();
        // Still in DOM immediately (waiting for transition)
        expect(document.body.contains(dialog)).toBe(true);
        // After fallback timeout, removed
        vi.advanceTimersByTime(250);
        expect(document.body.contains(dialog)).toBe(false);
        vi.useRealTimers();
    });

    it('close() fires the onClose callback with the result', () => {
        const onClose = vi.fn();
        const modal = new TestModal({ title: 'test', onClose });
        modal.close(true);
        expect(onClose).toHaveBeenCalledWith(true);
    });

    it('close() fires onClose with undefined when no result given', () => {
        const onClose = vi.fn();
        const modal = new TestModal({ title: 'test', onClose });
        modal.close();
        expect(onClose).toHaveBeenCalledWith(undefined);
    });

    it('cancel event (Escape) fires onClose callback', () => {
        const onClose = vi.fn();
        const modal = new TestModal({ title: 'test', onClose });
        const cancelEvent = new Event('cancel', { cancelable: true });
        modal['dialog'].dispatchEvent(cancelEvent);
        expect(cancelEvent.defaultPrevented).toBe(true);
        expect(onClose).toHaveBeenCalledWith(undefined);
    });

    it('backdrop click fires onClose callback', () => {
        const onClose = vi.fn();
        const modal = new TestModal({ title: 'test', onClose });
        const clickEvent = new MouseEvent('click', { bubbles: true });
        Object.defineProperty(clickEvent, 'target', { value: modal['dialog'] });
        modal['dialog'].dispatchEvent(clickEvent);
        expect(onClose).toHaveBeenCalledWith(undefined);
    });

    it('click inside modal-frame does NOT trigger backdrop close', () => {
        const onClose = vi.fn();
        const modal = new TestModal({ title: 'test', onClose });
        const clickEvent = new MouseEvent('click', { bubbles: true });
        Object.defineProperty(clickEvent, 'target', { value: modal['frameEl'] });
        modal['dialog'].dispatchEvent(clickEvent);
        expect(onClose).not.toHaveBeenCalled();
        modal.close();
    });
});

describe('Modal dismiss behavior — overrides', () => {
    it('subclass can block Escape key', () => {
        const onClose = vi.fn();
        const modal = new StickyModal({ title: 'test', onClose });
        const cancelEvent = new Event('cancel', { cancelable: true });
        modal['dialog'].dispatchEvent(cancelEvent);
        expect(modal.escapeCalled).toBe(true);
        expect(onClose).not.toHaveBeenCalled();
        modal.close();
    });

    it('subclass can block backdrop click', () => {
        const onClose = vi.fn();
        const modal = new StickyModal({ title: 'test', onClose });
        const clickEvent = new MouseEvent('click', { bubbles: true });
        Object.defineProperty(clickEvent, 'target', { value: modal['dialog'] });
        modal['dialog'].dispatchEvent(clickEvent);
        expect(modal.backdropCalled).toBe(true);
        expect(onClose).not.toHaveBeenCalled();
        modal.close();
    });

    it('subclass can override X button behavior', () => {
        const modal = new StickyModal({ title: 'test' });
        // Close button is the last .modal-close (theme toggle is first)
        const closeBtns = modal['dialog'].querySelectorAll('.modal-close');
        const closeBtn = closeBtns[closeBtns.length - 1] as HTMLElement;
        closeBtn.click();
        expect(modal.closeButtonCalled).toBe(true);
    });
});

describe('Modal onBeforeClose', () => {
    it('calls onBeforeClose before removing from DOM', () => {
        const order: string[] = [];

        class TrackingModal extends Modal {
            protected buildBody(container: HTMLElement): void {
                container.textContent = 'track';
            }
            protected override onBeforeClose(): void {
                order.push(
                    document.body.contains(this['dialog']) ? 'cleanup-while-attached' : 'cleanup-while-detached',
                );
            }
        }

        const modal = new TrackingModal({ title: 'test' });
        modal.close();
        expect(order).toEqual(['cleanup-while-attached']);
    });
});
