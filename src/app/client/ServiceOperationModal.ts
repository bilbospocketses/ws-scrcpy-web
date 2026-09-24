import { Modal } from '../ui/Modal';

export interface ServiceOperationModalOptions {
    operation: 'install' | 'uninstall';
}

const OPERATION_TEXT: Record<ServiceOperationModalOptions['operation'], { title: string; body: string }> = {
    // "a couple of minutes" is measured, not padding: on a fresh Windows
    // machine the elevated install spent 75–104 s end to end (2026-09-24),
    // most of it Defender checking Servy's unpacked DLLs for the first time.
    // Without saying so, a spinner that long reads as a hang.
    install: {
        title: 'installing service',
        body: 'please wait while the service is installed. the first install on a machine can take a couple of minutes.',
    },
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
