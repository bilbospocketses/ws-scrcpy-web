# Modal Base Class Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a shared `Modal` abstract base class wrapping native `<dialog>` with glassmorphism styling, then convert ConfigureScrcpy and ShellModal to use it.

**Architecture:** Abstract base class with `<dialog>.showModal()`. Subclasses override `buildBody()` to fill content and dismiss hooks to control close behavior. New `modal.css` replaces `dialog.css` with `@starting-style` transitions.

**Tech Stack:** TypeScript 6.x, native `<dialog>` API, CSS `@starting-style`, Vitest, webpack 5 + MiniCssExtractPlugin

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/app/ui/Modal.ts` | Abstract base class — `<dialog>` lifecycle, header, dismiss hooks, close callback |
| Create | `src/style/modal.css` | `<dialog>` + `::backdrop` glassmorphism styles, `@starting-style` transitions, per-modal sizing |
| Create | `src/app/ui/__tests__/modal.test.ts` | Unit tests for Modal base class |
| Modify | `src/app/googDevice/client/ConfigureScrcpy.ts` | Drop `extends BaseClient`, become `extends Modal` |
| Modify | `src/app/googDevice/client/ShellModal.ts` | Become `extends Modal`, add close confirmation |
| Modify | `src/app/googDevice/client/StreamClientScrcpy.ts:685-694` | Change event listener to callback |
| Delete | `src/style/dialog.css` | Replaced by `modal.css` after both conversions |

---

### Task 1: Create `modal.css`

**Files:**
- Create: `src/style/modal.css`

- [ ] **Step 1: Create the new stylesheet**

```css
/* ── Native <dialog> modal system ── */

/* The <dialog> itself is an invisible full-screen positioning layer.
   padding:0 is critical: clicks on ::backdrop bubble to the <dialog> element,
   and we detect backdrop clicks by checking event.target === dialog.
   All visible content lives inside .modal-frame. */
dialog.modal {
    padding: 0;
    border: none;
    background: transparent;
    max-width: 100vw;
    max-height: 100vh;
    overflow: visible;
}

/* ── Backdrop ── */
dialog.modal::backdrop {
    background: rgba(0, 0, 0, 0.45);
}

/* ── Glassmorphism frame ── */
dialog.modal .modal-frame {
    font-family: monospace;
    width: clamp(400px, 50vw, 650px);
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    background: rgba(30, 35, 45, 0.80);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    overflow: hidden;
}

[data-theme="light"] dialog.modal .modal-frame {
    background: rgba(245, 248, 252, 0.87);
    border: 1px solid rgba(0, 0, 0, 0.1);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
}

dialog.modal .modal-frame button,
dialog.modal .modal-frame select,
dialog.modal .modal-frame input {
    font-family: monospace;
    font-size: var(--font-size);
}

dialog.modal .modal-frame select {
    text-overflow: ellipsis;
}

/* ── Open/close transitions via @starting-style ──
   How this works:
   - Base state (no [open]) = exit-end values (invisible)
   - [open] state = visible values
   - @starting-style = entry-start values (invisible, same as base)
   - allow-discrete on display/overlay keeps dialog rendered during exit transition
*/

/* Dialog element: transparent container, stays rendered during exit */
dialog.modal {
    opacity: 0;
    transition: opacity 0.2s ease-out,
                display 0.2s ease-out allow-discrete,
                overlay 0.2s ease-out allow-discrete;
}

dialog.modal[open] {
    opacity: 1;
}

/* Frame: exit-end state (invisible, scaled down) */
dialog.modal .modal-frame {
    opacity: 0;
    transform: scale(0.96) translateY(8px);
    transition: opacity 0.2s ease-out, transform 0.2s ease-out;
}

/* Frame: visible state when open */
dialog.modal[open] .modal-frame {
    opacity: 1;
    transform: scale(1) translateY(0);
}

/* Backdrop: exit-end state */
dialog.modal::backdrop {
    background: rgba(0, 0, 0, 0.45);
    opacity: 0;
    transition: opacity 0.2s ease-out,
                display 0.2s ease-out allow-discrete;
}

/* Backdrop: visible state when open */
dialog.modal[open]::backdrop {
    opacity: 1;
}

/* Entry animation: these are the "from" values when [open] is first applied */
@starting-style {
    dialog.modal[open] {
        opacity: 0;
    }
    dialog.modal[open] .modal-frame {
        opacity: 0;
        transform: scale(0.96) translateY(8px);
    }
    dialog.modal[open]::backdrop {
        opacity: 0;
    }
}

/* ── Header ── */
dialog.modal .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    flex-shrink: 0;
}

[data-theme="light"] dialog.modal .modal-header {
    border-bottom-color: rgba(0, 0, 0, 0.08);
}

dialog.modal .modal-title {
    font-size: 15px;
    font-weight: 600;
}

dialog.modal .modal-close {
    background: transparent;
    border: none;
    color: var(--text-color-light, #888);
    cursor: pointer;
    padding: 4px;
    line-height: 1;
    font-size: 18px;
}

dialog.modal .modal-close:hover {
    color: var(--text-color, #ddd);
}

/* ── Body (scrollable) ── */
dialog.modal .modal-body {
    padding: 1rem;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
}

/* ── Footer ── */
dialog.modal .modal-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    flex-shrink: 0;
}

[data-theme="light"] dialog.modal .modal-footer {
    border-top-color: rgba(0, 0, 0, 0.08);
}

/* ── Controls grid (used by ConfigureScrcpy) ── */
dialog.modal .modal-controls {
    display: grid;
    grid-template-columns: [labels] 35% [controls] 1fr;
    gap: 0.5rem 0.75rem;
    align-items: center;
    padding-right: 0.5rem;
}

dialog.modal .modal-controls .label {
    grid-column: labels;
    color: var(--text-color-light, #888);
    font-size: 13px;
}

dialog.modal .modal-controls .input,
dialog.modal .modal-controls select,
dialog.modal .modal-controls input:not([type="checkbox"]) {
    grid-column: controls;
    box-sizing: border-box;
    background: var(--stream-bg-color, #1a1a2e);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    color: var(--text-color, #ddd);
    padding: 4px 8px;
}

[data-theme="light"] dialog.modal .modal-controls select,
[data-theme="light"] dialog.modal .modal-controls input:not([type="checkbox"]) {
    background: #fff;
    border-color: rgba(0, 0, 0, 0.15);
    color: #333;
}

dialog.modal .modal-controls select:focus,
dialog.modal .modal-controls input:focus {
    outline: none;
    border-color: #5b9aff;
}

dialog.modal .modal-controls input:disabled,
dialog.modal .modal-controls select:disabled,
dialog.modal .modal-advanced input:disabled,
dialog.modal .modal-advanced select:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    background: rgba(255, 255, 255, 0.03);
}

[data-theme="light"] dialog.modal .modal-controls input:disabled,
[data-theme="light"] dialog.modal .modal-controls select:disabled,
[data-theme="light"] dialog.modal .modal-advanced input:disabled,
[data-theme="light"] dialog.modal .modal-advanced select:disabled {
    background: #eee;
}

/* ── Slider ── */
dialog.modal .modal-controls input[type="range"] {
    grid-column: controls;
    width: 100%;
    cursor: pointer;
    accent-color: #5b9aff;
}

/* ── Advanced toggle ── */
dialog.modal .modal-advanced-separator {
    grid-column: 1 / -1;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    margin-top: 0.5rem;
    padding-top: 0.5rem;
}

[data-theme="light"] dialog.modal .modal-advanced-separator {
    border-top-color: rgba(0, 0, 0, 0.08);
}

dialog.modal .modal-advanced-toggle {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: pointer;
    padding: 0.25rem 0;
    color: var(--text-color-light, #888);
    font-size: 13px;
    user-select: none;
    background: transparent;
    border: none;
    width: 100%;
    font-family: monospace;
}

dialog.modal .modal-advanced-toggle:hover {
    color: var(--text-color, #ddd);
}

dialog.modal .modal-advanced-toggle .chevron {
    transition: transform 0.3s ease;
    font-size: 12px;
}

dialog.modal .modal-advanced-toggle .chevron.expanded {
    transform: rotate(180deg);
}

/* ── Advanced section (animated reveal) ── */
dialog.modal .modal-advanced {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: [labels] 35% [controls] 1fr;
    gap: 0.5rem 0.75rem;
    align-items: center;
    padding-right: 0.5rem;
    overflow: hidden;
    max-height: 0;
    opacity: 0;
    transition: max-height 0.3s ease, opacity 0.3s ease, margin 0.3s ease;
    margin-top: 0;
}

dialog.modal .modal-advanced.expanded {
    max-height: 300px;
    opacity: 1;
    margin-top: 0.5rem;
}

dialog.modal .modal-advanced .label {
    grid-column: labels;
    color: var(--text-color-light, #888);
    font-size: 13px;
}

dialog.modal .modal-advanced .input,
dialog.modal .modal-advanced select,
dialog.modal .modal-advanced input:not([type="checkbox"]) {
    grid-column: controls;
    box-sizing: border-box;
    width: 100%;
    background: var(--stream-bg-color, #1a1a2e);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    color: var(--text-color, #ddd);
    padding: 4px 8px;
}

dialog.modal .modal-advanced input[type="checkbox"] {
    grid-column: controls;
    justify-self: start;
    width: 16px;
    height: 16px;
    cursor: pointer;
    accent-color: #5b9aff;
}

[data-theme="light"] dialog.modal .modal-advanced select,
[data-theme="light"] dialog.modal .modal-advanced input:not([type="checkbox"]) {
    background: #fff;
    border-color: rgba(0, 0, 0, 0.15);
    color: #333;
}

/* ── Settings buttons ── */
dialog.modal .modal-settings {
    display: flex;
    gap: 8px;
    justify-content: center;
    margin-top: 1rem;
    padding-top: 0.75rem;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
}

[data-theme="light"] dialog.modal .modal-settings {
    border-top-color: rgba(0, 0, 0, 0.08);
}

dialog.modal .modal-settings button {
    border: 0.5px solid var(--text-color, #ddd);
    border-radius: 6px;
    background: transparent;
    color: #5b9aff;
    padding: 6px 16px;
    cursor: pointer;
    white-space: nowrap;
}

dialog.modal .modal-settings button:hover {
    background: var(--device-list-hover-color, hsl(218, 17%, 18%));
}

/* ── Status text (footer) ── */
dialog.modal .status-text {
    font-size: 13px;
}

dialog.modal .status-text.status-probing {
    color: #f06c75;
}

dialog.modal .status-text.status-ready {
    color: #4ade80;
}

dialog.modal .status-text.status-error {
    color: #f06c75;
}

/* ── Connect button (footer) ── */
dialog.modal .connect-btn {
    border: 0.5px solid var(--text-color, #ddd);
    border-radius: 6px;
    background: transparent;
    color: #5b9aff;
    padding: 6px 20px;
    cursor: pointer;
    white-space: nowrap;
}

dialog.modal .connect-btn:hover:not(:disabled) {
    background: var(--device-list-hover-color, hsl(218, 17%, 18%));
}

dialog.modal .connect-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}

/* ── Shell modal overrides ── */
dialog.modal.shell-modal .modal-frame {
    width: clamp(500px, 90vw, 1600px);
    max-height: 90vh;
}

dialog.modal .shell-warning {
    padding: 4px 1rem;
    font-size: 11px;
    color: #f06c75;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    flex-shrink: 0;
}

[data-theme="light"] dialog.modal .shell-warning {
    border-bottom-color: rgba(0, 0, 0, 0.08);
}

dialog.modal.shell-modal .modal-body {
    padding: 0;
    background: #000;
    min-height: 600px;
    position: relative;
    overflow: hidden;
}

dialog.modal .terminal-container {
    position: absolute;
    inset: 0;
    overflow: hidden;
}
```

- [ ] **Step 2: Verify the file was created at the correct path**

Run: `ls src/style/modal.css`
Expected: file exists

- [ ] **Step 3: Commit**

```bash
git add src/style/modal.css
git commit -m "feat: add modal.css for native <dialog> element styling"
```

---

### Task 2: Create `Modal` abstract base class

**Files:**
- Create: `src/app/ui/Modal.ts`

- [ ] **Step 1: Create the Modal class**

```typescript
import '../../style/modal.css';

export interface ModalOptions {
    title: string;
    onClose?: (result: unknown) => void;
}

export abstract class Modal {
    protected readonly dialog: HTMLDialogElement;
    protected readonly frameEl: HTMLElement;
    protected readonly bodyEl: HTMLElement;
    private readonly options: ModalOptions;

    constructor(options: ModalOptions) {
        this.options = options;

        // Create <dialog>
        this.dialog = document.createElement('dialog');
        this.dialog.classList.add('modal');

        // Create .modal-frame (the visible glassmorphism box)
        this.frameEl = document.createElement('div');
        this.frameEl.classList.add('modal-frame');

        // Header
        const header = document.createElement('div');
        header.classList.add('modal-header');

        const title = document.createElement('span');
        title.classList.add('modal-title');
        title.textContent = options.title;
        header.appendChild(title);

        const closeBtn = document.createElement('button');
        closeBtn.classList.add('modal-close');
        closeBtn.textContent = '\u00d7';
        closeBtn.addEventListener('click', () => this.onCloseButtonClick());
        header.appendChild(closeBtn);

        // Body
        this.bodyEl = document.createElement('div');
        this.bodyEl.classList.add('modal-body');
        this.buildBody(this.bodyEl);

        // Assemble frame
        this.frameEl.appendChild(header);
        this.frameEl.appendChild(this.bodyEl);

        // Optional footer
        const footer = this.buildFooter();
        if (footer) {
            footer.classList.add('modal-footer');
            this.frameEl.appendChild(footer);
        }

        this.dialog.appendChild(this.frameEl);

        // Event listeners
        this.dialog.addEventListener('cancel', (e) => {
            e.preventDefault();
            this.onEscapeKey(e);
        });

        this.dialog.addEventListener('click', (e) => {
            if (e.target === this.dialog) {
                this.onBackdropClick(e as MouseEvent);
            }
        });

        // Show
        document.body.appendChild(this.dialog);
        this.dialog.showModal();
    }

    /** Required. Subclass fills the modal body content. */
    protected abstract buildBody(container: HTMLElement): void;

    /** Optional. Override to return a footer element (modal-footer class is added automatically). */
    protected buildFooter(): HTMLElement | null {
        return null;
    }

    /** Override to handle Escape key. Default: close the modal. */
    protected onEscapeKey(_event: Event): void {
        this.close();
    }

    /** Override to handle backdrop click. Default: close the modal. */
    protected onBackdropClick(_event: MouseEvent): void {
        this.close();
    }

    /** Override to handle X button click. Default: close the modal. */
    protected onCloseButtonClick(): void {
        this.close();
    }

    /** Override for cleanup before DOM removal (dispose terminals, close sockets, etc.). */
    protected onBeforeClose(): void {}

    /** Close the modal. Calls onBeforeClose, triggers exit animation, removes from DOM, fires callback. */
    public close(result?: unknown): void {
        this.onBeforeClose();
        this.dialog.close();
        // Remove from DOM after exit transition completes (200ms matches CSS)
        this.dialog.addEventListener('transitionend', () => this.dialog.remove(), { once: true });
        // Fallback: remove after 250ms if transitionend doesn't fire (e.g., reduced motion)
        setTimeout(() => { if (this.dialog.parentElement) this.dialog.remove(); }, 250);
        this.options.onClose?.(result);
    }
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `npx tsc --noEmit src/app/ui/Modal.ts`

If this fails due to CSS import, that's expected (tsc doesn't handle CSS imports — webpack does). Verify it's only the CSS import error.

- [ ] **Step 3: Commit**

```bash
git add src/app/ui/Modal.ts
git commit -m "feat: add Modal abstract base class wrapping native <dialog>"
```

---

### Task 3: Write unit tests for Modal base class

**Files:**
- Create: `src/app/ui/__tests__/modal.test.ts`

The Modal class uses DOM APIs (`document.createElement`, `HTMLDialogElement.showModal`). Vitest runs in Node by default. We need `jsdom` or `happy-dom` environment. Check current vitest config first.

- [ ] **Step 1: Check vitest config for DOM environment**

Run: `cat <repo>/vitest.config.ts 2>/dev/null || cat <repo>/vite.config.ts 2>/dev/null || echo "no config"`

If no DOM environment is configured, the test file will use a `// @vitest-environment jsdom` directive. Install `jsdom` as a dev dependency if not present:

Run: `npm ls jsdom 2>/dev/null || echo "not installed"`

If not installed: `npm install -D jsdom`

- [ ] **Step 2: Create the test file**

```typescript
// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Modal, type ModalOptions } from '../Modal';

// jsdom doesn't implement showModal/close — stub them
beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
});

// Concrete test subclass with default dismiss behavior
class TestModal extends Modal {
    public buildBodyCalled = false;
    protected buildBody(container: HTMLElement): void {
        this.buildBodyCalled = true;
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

    protected onEscapeKey(_event: Event): void {
        this.escapeCalled = true;
        // no-op: don't close
    }

    protected onBackdropClick(_event: MouseEvent): void {
        this.backdropCalled = true;
        // no-op: don't close
    }

    protected onCloseButtonClick(): void {
        this.closeButtonCalled = true;
        // simulate confirmation: close only if confirmed
        this.close();
    }
}

// Subclass with a footer
class FooterModal extends Modal {
    protected buildBody(container: HTMLElement): void {
        container.textContent = 'body';
    }

    protected buildFooter(): HTMLElement | null {
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
        expect(modal.buildBodyCalled).toBe(true);
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
        const closeBtn = modal['dialog'].querySelector('.modal-close');
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
        modal.close(); // cleanup
    });

    it('subclass can block backdrop click', () => {
        const onClose = vi.fn();
        const modal = new StickyModal({ title: 'test', onClose });
        const clickEvent = new MouseEvent('click', { bubbles: true });
        Object.defineProperty(clickEvent, 'target', { value: modal['dialog'] });
        modal['dialog'].dispatchEvent(clickEvent);
        expect(modal.backdropCalled).toBe(true);
        expect(onClose).not.toHaveBeenCalled();
        modal.close(); // cleanup
    });

    it('subclass can override X button behavior', () => {
        const modal = new StickyModal({ title: 'test' });
        const closeBtn = modal['dialog'].querySelector('.modal-close') as HTMLElement;
        closeBtn.click();
        expect(modal.closeButtonCalled).toBe(true);
        // StickyModal's override still calls close, so dialog is removed
    });
});

describe('Modal onBeforeClose', () => {
    it('calls onBeforeClose before removing from DOM', () => {
        const order: string[] = [];

        class TrackingModal extends Modal {
            protected buildBody(container: HTMLElement): void {
                container.textContent = 'track';
            }
            protected onBeforeClose(): void {
                // At this point, dialog should still be in the DOM
                order.push(document.body.contains(this.dialog) ? 'cleanup-while-attached' : 'cleanup-while-detached');
            }
        }

        const modal = new TrackingModal({ title: 'test' });
        modal.close();
        expect(order).toEqual(['cleanup-while-attached']);
    });
});
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run src/app/ui/__tests__/modal.test.ts`

Expected: All tests pass. If CSS import fails in test environment, add a vitest config alias or mock for `.css` imports.

- [ ] **Step 4: Commit**

```bash
git add src/app/ui/__tests__/modal.test.ts
git commit -m "test: add unit tests for Modal base class"
```

---

### Task 4: Convert ConfigureScrcpy to extend Modal

**Files:**
- Modify: `src/app/googDevice/client/ConfigureScrcpy.ts`
- Modify: `src/app/googDevice/client/StreamClientScrcpy.ts:685-694`

This is the biggest task. ConfigureScrcpy drops `extends BaseClient` and becomes `extends Modal`. The `createUI()` method becomes `buildBody()` + `buildFooter()`. The `removeUI()` method is replaced by `onBeforeClose()`. The event emission becomes a callback.

- [ ] **Step 1: Update StreamClientScrcpy to pass a callback instead of using events**

In `src/app/googDevice/client/StreamClientScrcpy.ts`, replace lines 685-694:

```typescript
// Before (lines 685-694):
const dialog = new ConfigureScrcpy(tracker, descriptor, options);
dialog.on('closed', StreamClientScrcpy.onConfigureDialogClosed);
```

```typescript
// After:
new ConfigureScrcpy(tracker, descriptor, options, (result: boolean) => {
    if (result) {
        HostTracker.getInstance().destroy();
    }
});
```

Also delete the `onConfigureDialogClosed` static method (lines 689-694):

```typescript
// Delete this entire method:
private static onConfigureDialogClosed = (event: { dialog: ConfigureScrcpy; result: boolean }): void => {
    event.dialog.off('closed', StreamClientScrcpy.onConfigureDialogClosed);
    if (event.result) {
        HostTracker.getInstance().destroy();
    }
};
```

- [ ] **Step 2: Rewrite ConfigureScrcpy to extend Modal**

Replace the class definition and imports. Key changes:

1. Remove `import '../../../style/dialog.css'` — Modal.ts imports `modal.css`
2. Remove `import { BaseClient }` and `ConfigureScrcpyEvents` interface
3. Change `export class ConfigureScrcpy extends BaseClient<ParamsStreamScrcpy, ConfigureScrcpyEvents>` to `export class ConfigureScrcpy extends Modal`
4. Constructor: call `super({ title: deviceName, onClose: callback })` instead of `super(params)`
5. Store `params` as a regular property: `private readonly params: ParamsStreamScrcpy`
6. Move UI creation from `createUI()` to `buildBody(container)` and `buildFooter()`
7. Replace `this.emit('closed', { dialog: this, result: false })` with `this.close(false)`
8. Replace `this.emit('closed', { dialog: this, result: true })` with `this.close(true)` — but the `openStream` method needs to do its work BEFORE calling close, since `close()` removes the DOM (and the select elements it reads from)
9. Delete `removeUI()`, `onBackgroundClick`, `onEscapeKey`, `cancel` methods — handled by Modal base class
10. Delete `this.background` property — no longer needed

The constructor signature becomes:
```typescript
constructor(
    private readonly tracker: DeviceTracker,
    descriptor: GoogDeviceDescriptor,
    private readonly params: ParamsStreamScrcpy,
    onClose?: (result: boolean) => void,
)
```

And calls:
```typescript
super({ title: descriptor['ro.product.model'], onClose: onClose as ((result: unknown) => void) | undefined });
```

The `buildBody(container: HTMLElement)` method contains the body of the old `createUI()` — everything between creating the `dialogBody` div and assembling it. Instead of creating a new `dialogBody` div, it appends directly to the `container` parameter.

The `buildFooter()` method returns a `<div>` containing the status text and connect button (the old footer creation code).

The `openStream` method: must read all form values and build the stream params BEFORE calling `this.close(true)`, because close removes the dialog from DOM.

The `cancel` method is gone — default `onEscapeKey` and `onBackdropClick` hooks call `this.close()`, and `this.close(false)` is the cancel path.

- [ ] **Step 3: Update CSS class references**

In the `buildBody` method, update all CSS class names from old to new:
- `dialog-controls` → `modal-controls`
- `dialog-settings` → `modal-settings`
- `advanced-section` → `modal-advanced`
- `advanced-separator` → `modal-advanced-separator`
- `advanced-toggle` → `modal-advanced-toggle`

The `label`, `input`, `chevron`, `status-text`, `status-probing`, `status-ready`, `status-error`, `connect-btn` classes stay the same (they're not prefixed with `dialog-`).

- [ ] **Step 4: Build and verify**

Run: `npm run build`

Expected: Build succeeds with no errors. The compiled output includes both `modal.css` (from Modal.ts import) and `dialog.css` (from ShellModal.ts import, not yet converted).

- [ ] **Step 5: Run all tests**

Run: `npm test`

Expected: All existing tests pass (none test ConfigureScrcpy directly — they test control messages, dependency definitions, device labels, and adb client). The new Modal tests from Task 3 also pass.

- [ ] **Step 6: Manual smoke test**

Run: `npm run build && node dist/index.js`

Open browser to `http://localhost:8000`. Click "configure stream" on a device card. Verify:
- Modal appears with glassmorphism styling, centered, dimmed backdrop
- Open animation plays (scale + fade)
- Escape key closes the modal
- Clicking outside the modal closes it
- X button closes the modal
- "connect" button opens the stream
- Close animation plays (reverse of open)

- [ ] **Step 7: Commit**

```bash
git add src/app/googDevice/client/ConfigureScrcpy.ts src/app/googDevice/client/StreamClientScrcpy.ts
git commit -m "refactor: convert ConfigureScrcpy to extend Modal base class"
```

---

### Task 5: Convert ShellModal to extend Modal

**Files:**
- Modify: `src/app/googDevice/client/ShellModal.ts`

- [ ] **Step 1: Rewrite ShellModal to extend Modal**

Key changes:

1. Remove `import '../../../style/dialog.css'` — Modal.ts imports `modal.css`
2. Change `export class ShellModal` to `export class ShellModal extends Modal`
3. Constructor calls `super({ title: deviceName })` (no onClose callback — fire-and-forget)
4. Add `this.dialog.classList.add('shell-modal')` after super() for sizing override
5. Move DOM creation into `buildBody(container)`:
   - Create the resize warning div and append to `container` (warning goes inside body, above terminal)
     - Wait — in the old code, warning is between header and body. In the new Modal, header and body are siblings inside `.modal-frame`. To keep the warning between header and body, `buildBody` needs to insert it before the body content. Actually, looking at the current structure: the warning is a sibling of header and body inside the container div. With Modal, the frame contains header → body → footer. The warning needs to go inside body as the first child, OR we insert it into the frame between header and body.
     - Best approach: in `buildBody()`, insert the warning as the first child of the body container, then the terminal container after it. But the body has `padding: 0` for shell modal and the warning has its own padding. This works — warning at top of body, terminal container fills the rest.
     - Actually, the current `.dialog-container.shell-modal .dialog-body` has `padding: 0`, `min-height: 600px`, `position: relative`, `overflow: hidden`. The terminal container is `position: absolute; inset: 0`. If we put the warning inside the body, it gets covered by the absolute-positioned terminal.
     - Better: insert the warning into `this.frameEl` between header and body. The `buildBody` method runs during `super()`, so `this.frameEl` is accessible. After `super()` completes, insert the warning: `this.frameEl.insertBefore(warningEl, this.bodyEl)`.

6. Remove the old `this.background` property and all manual DOM construction for background/container/header/closeBtn
7. The `close()` method becomes `onBeforeClose()` for cleanup, and the actual close delegates to `super.close()`
8. Override `onEscapeKey` to no-op
9. Override `onBackdropClick` to no-op
10. Override `onCloseButtonClick` to show confirmation before closing

```typescript
import '@xterm/xterm/css/xterm.css';
import { AttachAddon } from '@xterm/addon-attach';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { ACTION } from '../../../common/Action';
import { ChannelCode } from '../../../common/ChannelCode';
import type { MessageXtermClient } from '../../../types/MessageXtermClient';
import { Multiplexer } from '../../../packages/multiplexer/Multiplexer';
import { ManagerClient } from '../../client/ManagerClient';
import { Modal } from '../../ui/Modal';

const TAG = '[ShellModal]';

export class ShellModal extends Modal {
    private term?: Terminal;
    private fitAddon?: FitAddon;
    private ws?: Multiplexer;
    private resizeObserver?: ResizeObserver;
    private shellStarted = false;

    constructor(
        private readonly udid: string,
        deviceName: string,
        private readonly params: {
            hostname?: string;
            port?: number;
            secure?: boolean;
            pathname?: string;
        },
    ) {
        super({ title: deviceName });
        this.dialog.classList.add('shell-modal');

        // Insert resize warning between header and body
        const warning = document.createElement('div');
        warning.className = 'shell-warning';
        warning.textContent = 'resizing the browser window after starting a session may cause display issues';
        this.frameEl.insertBefore(warning, this.bodyEl);

        // Start connection
        const terminalContainer = this.bodyEl.querySelector('.terminal-container') as HTMLElement;
        this.connect(terminalContainer);
    }

    protected buildBody(container: HTMLElement): void {
        const terminalContainer = document.createElement('div');
        terminalContainer.className = 'terminal-container';
        container.appendChild(terminalContainer);
    }

    // Block Escape — it's a valid terminal key
    protected onEscapeKey(_event: Event): void {}

    // Block backdrop click — protect the session
    protected onBackdropClick(_event: MouseEvent): void {}

    // Confirm before closing — terminal session is destroyed on close
    protected onCloseButtonClick(): void {
        if (this.shellStarted && !confirm('end session? terminal output will be lost.')) {
            return;
        }
        this.close();
    }

    protected onBeforeClose(): void {
        // Send stop message
        if (this.ws && this.ws.readyState === this.ws.OPEN) {
            const message: MessageXtermClient = {
                id: 1,
                type: 'shell',
                data: {
                    type: 'stop',
                    udid: this.udid,
                },
            };
            this.ws.send(JSON.stringify(message));
            this.ws.close();
        }
        this.ws = undefined;

        // Dispose terminal
        if (this.term) {
            this.term.dispose();
            this.term = undefined;
        }
        this.fitAddon = undefined;

        // Stop observing resize
        this.resizeObserver?.disconnect();
        this.resizeObserver = undefined;
    }

    // --- The rest of the methods stay unchanged ---
    // buildWebSocketUrl(), connect(), initTerminal(), startShell(), sendResize()
    // Copy them verbatim from the current ShellModal.ts (lines 80-193)

    private buildWebSocketUrl(): string {
        const { hostname, port, secure, pathname } = this.params;
        let urlString: string;
        if (typeof hostname === 'string' && typeof port === 'number') {
            const protocol = secure ? 'wss:' : 'ws:';
            urlString = `${protocol}//${hostname}:${port}${pathname ?? location.pathname}`;
        } else {
            const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            urlString = `${protocol}//${location.host}${pathname ?? location.pathname}`;
        }
        const url = new URL(urlString);
        url.searchParams.set('action', ACTION.MULTIPLEX);
        return url.toString();
    }

    private connect(terminalContainer: HTMLElement): void {
        const url = this.buildWebSocketUrl();

        let multiplexer = ManagerClient.sockets.get(url);
        if (!multiplexer) {
            const ws = new WebSocket(url);
            ws.addEventListener('close', () => {
                ManagerClient.sockets.delete(url);
            });
            const newMultiplexer = Multiplexer.wrap(ws);
            newMultiplexer.on('empty', () => {
                newMultiplexer.close();
            });
            ManagerClient.sockets.set(url, newMultiplexer);
            multiplexer = newMultiplexer;
        }

        const channelData = new TextEncoder().encode(ChannelCode.SHEL);
        this.ws = multiplexer.createChannel(channelData);

        this.ws.addEventListener('open', () => {
            this.initTerminal(terminalContainer);
        });

        this.ws.addEventListener('close', (event: CloseEvent) => {
            console.log(TAG, `Connection closed: ${event.reason}`);
            if (this.term) {
                this.term.dispose();
                this.term = undefined;
            }
        });
    }

    private initTerminal(container: HTMLElement): void {
        if (!this.ws) {
            return;
        }
        this.term = new Terminal();
        this.term.loadAddon(new AttachAddon(this.ws));
        this.fitAddon = new FitAddon();
        this.term.loadAddon(this.fitAddon);
        this.term.open(container);

        this.resizeObserver = new ResizeObserver(() => {
            if (!this.fitAddon || !container.clientWidth || !container.clientHeight) return;
            this.fitAddon.fit();
            if (!this.shellStarted) {
                this.shellStarted = true;
                this.term?.focus();
                this.startShell();
            } else {
                this.sendResize();
            }
        });
        this.resizeObserver.observe(container);
    }

    private startShell(): void {
        if (!this.ws || this.ws.readyState !== this.ws.OPEN || !this.fitAddon) {
            return;
        }
        const dims = this.fitAddon.proposeDimensions();
        const rows = dims?.rows ?? 24;
        const cols = dims?.cols ?? 80;
        const message: MessageXtermClient = {
            id: 1,
            type: 'shell',
            data: {
                type: 'start',
                rows,
                cols,
                udid: this.udid,
            },
        };
        this.ws.send(JSON.stringify(message));
    }

    private sendResize(): void {
        if (!this.ws || this.ws.readyState !== this.ws.OPEN || !this.fitAddon) return;
        const dims = this.fitAddon.proposeDimensions();
        if (!dims) return;
        const message: MessageXtermClient = {
            id: 1,
            type: 'resize',
            data: {
                type: 'resize',
                rows: dims.rows,
                cols: dims.cols,
                udid: this.udid,
            },
        };
        this.ws.send(JSON.stringify(message));
    }
}
```

- [ ] **Step 2: Remove the old public close() method**

The old `ShellModal.close()` is now split:
- Cleanup → `onBeforeClose()` (called by `Modal.close()`)
- DOM removal → handled by `Modal.close()`

Make sure there's no remaining `public close()` method that would shadow `Modal.close()`.

- [ ] **Step 3: Build and verify**

Run: `npm run build`

Expected: Build succeeds. Both `modal.css` and `dialog.css` no longer needed — but `dialog.css` may still be imported if any other file references it. Check:

Run: `grep -r "dialog\.css" src/`

Expected: No results — both ConfigureScrcpy and ShellModal now import through Modal.ts → `modal.css`.

- [ ] **Step 4: Run all tests**

Run: `npm test`

Expected: All tests pass.

- [ ] **Step 5: Manual smoke test**

Run: `npm run build && node dist/index.js`

Open browser to `http://localhost:8000`. Click "shell" on a device card. Verify:
- Shell modal appears with glassmorphism styling, wider sizing
- Resize warning visible between header and terminal
- Escape key does NOT close the modal (terminal receives it)
- Clicking outside does NOT close the modal
- X button shows "end session?" confirmation
- Terminal connects and is functional
- After confirming close, exit animation plays

- [ ] **Step 6: Commit**

```bash
git add src/app/googDevice/client/ShellModal.ts
git commit -m "refactor: convert ShellModal to extend Modal base class"
```

---

### Task 6: Delete `dialog.css` and clean up

**Files:**
- Delete: `src/style/dialog.css`

- [ ] **Step 1: Verify no remaining references to dialog.css**

Run: `grep -r "dialog\.css" src/`

Expected: No results. If any file still imports it, fix that file first.

- [ ] **Step 2: Delete the file**

Run: `rm src/style/dialog.css`

- [ ] **Step 3: Build and verify**

Run: `npm run build`

Expected: Build succeeds with no missing CSS errors.

- [ ] **Step 4: Run all tests**

Run: `npm test`

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: delete dialog.css, replaced by modal.css"
```

---

### Task 7: Final integration test

**Files:** None (manual verification only)

- [ ] **Step 1: Full build from clean state**

Run: `rm -rf dist && npm run build && node dist/index.js`

- [ ] **Step 2: Test ConfigureScrcpy modal**

Open `http://localhost:8000`. Click "configure stream" on a device card:
- [ ] Modal opens with animation
- [ ] Display, codec, encoder, bitrate, fps controls visible
- [ ] Advanced section expands/collapses
- [ ] Settings save/load/reset work
- [ ] Escape closes
- [ ] Backdrop click closes
- [ ] X button closes
- [ ] "connect" button starts stream
- [ ] Light theme toggle works (modal styling adapts)

- [ ] **Step 3: Test ShellModal**

Click "shell" on a device card:
- [ ] Modal opens with animation, wider sizing
- [ ] Resize warning visible
- [ ] Terminal connects and accepts input
- [ ] Escape key goes to terminal (doesn't close modal)
- [ ] Backdrop click does nothing
- [ ] X button shows "end session?" confirmation
- [ ] Cancelling confirmation keeps modal open
- [ ] Confirming closes modal with animation
- [ ] Light theme toggle works

- [ ] **Step 4: Test both modals in sequence**

- [ ] Open configure → close → open shell → close (no stale DOM, no z-index issues)
- [ ] Open configure → connect → stream starts (modal closes properly before stream begins)
