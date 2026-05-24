import { Modal } from '../ui/Modal';

export interface ServiceOperationModalOptions {
    operation: 'install' | 'uninstall';
}

const OPERATION_TEXT: Record<ServiceOperationModalOptions['operation'], { title: string; body: string }> = {
    install: { title: 'installing service', body: 'please wait while the service is installed...' },
    uninstall: { title: 'uninstalling service', body: 'please wait while the service is uninstalled...' },
};

// Module-scoped staging variable. buildBody() runs during super() — before
// subclass fields are initialized (useDefineForClassFields). Set this before
// super() so buildBody() can read the body text.
let _pendingBody = '';

export class ServiceOperationModal extends Modal {
    constructor(opts: ServiceOperationModalOptions) {
        const text = OPERATION_TEXT[opts.operation];
        _pendingBody = text.body;
        super({ title: text.title });
    }

    protected override buildBody(container: HTMLElement): void {
        this.dialog.classList.add('service-operation-modal');

        const spinner = document.createElement('div');
        spinner.className = 'service-operation-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        container.appendChild(spinner);

        const p = document.createElement('p');
        p.textContent = _pendingBody;
        container.appendChild(p);
    }

    protected override onEscapeKey(): void {}
    protected override onBackdropClick(): void {}
    protected override onCloseButtonClick(): void {}
}
