import { Modal } from '../../ui/Modal';
import type { Change } from './StagedSettingsStore';

/**
 * The change summary shown before a staged batch is applied.
 *
 * Renders straight from `store.changes()`, so it cannot disagree with what will
 * actually be sent. Every node is built with createElement/textContent, never
 * innerHTML -- the values are user- and server-supplied.
 */
export class SettingsSummaryModal extends Modal {
    private resolveFn: ((v: boolean) => void) | null = null;
    private resolved = false;
    private readonly changes: Change[];

    public static confirm(changes: Change[]): Promise<boolean> {
        return new Promise((resolve) => {
            // The base Modal constructor already appends the dialog AND calls
            // showModal(). Doing either again throws InvalidStateError, which
            // rejects this promise and silently breaks the buttons while leaving
            // the dialog visible (AdminConfirmModal.ts:25-41).
            new SettingsSummaryModal(changes, resolve);
        });
    }

    private constructor(changes: Change[], resolve: (v: boolean) => void) {
        super({ title: 'Review changes' });
        this.changes = changes;
        this.resolveFn = resolve;
        // Called synchronously here, NOT deferred: unlike buildBody() below (which
        // the base constructor invokes mid-super(), before this.changes exists),
        // this call sits after super() has returned and this.changes is already
        // assigned, so there's nothing left to wait a microtask for. Deferring it
        // would leave the dialog's textContent empty for any caller (or test)
        // that inspects it synchronously right after confirm() returns.
        this.fillBody(this.bodyEl);
    }

    protected buildBody(_container: HTMLElement): void {
        // Left empty: the base constructor calls this during super(), before
        // this.changes exists. Real content is rendered by fillBody(), called
        // from this subclass's own constructor body once super() has returned.
    }

    private fillBody(container: HTMLElement): void {
        const list = document.createElement('ul');
        list.className = 'settings-summary__list';
        for (const c of this.changes) {
            const li = document.createElement('li');
            // Display text when the field has a formatter, the raw value
            // otherwise. The store no longer formats `from`/`to` themselves --
            // doing so put `'off'` on the wire for `autoUpdate` and every save
            // of it was refused -- so rendering is this modal's job now.
            li.textContent = `${c.label}: ${c.fromText ?? String(c.from)} → ${c.toText ?? String(c.to)}`;
            list.appendChild(li);
        }
        container.appendChild(list);

        if (this.changes.some((c) => c.id === 'webPort')) {
            const warning = document.createElement('p');
            warning.className = 'settings-summary__restart';
            warning.textContent =
                'Changing the web port will restart the server. This page will reload on the new port ' +
                'automatically — the app is not crashing.';
            container.appendChild(warning);
        }
    }

    protected override buildFooter(): HTMLElement | null {
        const footer = document.createElement('div');
        footer.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'modal-button';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => this.resolveAndClose(false));
        footer.appendChild(cancel);

        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'modal-button';
        save.textContent = 'Save';
        save.addEventListener('click', () => this.resolveAndClose(true));
        footer.appendChild(save);

        return footer;
    }

    protected override onEscapeKey(): void {
        this.resolveAndClose(false);
    }

    protected override onBackdropClick(): void {
        this.resolveAndClose(false);
    }

    protected override onCloseButtonClick(): void {
        this.resolveAndClose(false);
    }

    private resolveAndClose(value: boolean): void {
        if (this.resolved) return;
        this.resolved = true;
        this.resolveFn?.(value);
        this.resolveFn = null;
        this.close(value);
    }
}
