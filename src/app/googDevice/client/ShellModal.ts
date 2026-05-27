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
    private term?: Terminal | undefined;
    private fitAddon?: FitAddon | undefined;
    private ws?: Multiplexer | undefined;
    private resizeObserver?: ResizeObserver | undefined;
    private shellStarted = false;
    private readonly udid: string;
    private readonly params: {
        hostname?: string | undefined;
        port?: number | undefined;
        secure?: boolean | undefined;
        pathname?: string | undefined;
    };

    constructor(
        udid: string,
        deviceName: string,
        params: {
            hostname?: string | undefined;
            port?: number | undefined;
            secure?: boolean | undefined;
            pathname?: string | undefined;
        },
    ) {
        super({ title: deviceName });

        // Add shell-modal class for sizing overrides
        this.dialog.classList.add('shell-modal');

        // Store instance fields after super()
        this.udid = udid;
        this.params = params;

        // Insert resize warning between header and body
        const warning = document.createElement('div');
        warning.className = 'shell-warning';
        warning.textContent = 'resizing the browser window after starting a session may cause display issues';
        this.frameEl.insertBefore(warning, this.bodyEl);

        // Get the terminal container created by buildBody
        const terminalContainer = this.bodyEl.querySelector('.terminal-container') as HTMLElement;

        // Start connection
        this.connect(terminalContainer);
    }

    protected buildBody(container: HTMLElement): void {
        const terminalContainer = document.createElement('div');
        terminalContainer.className = 'terminal-container';
        container.appendChild(terminalContainer);
    }

    protected override onEscapeKey(_event: Event): void {
        // no-op: Escape is a terminal key
    }

    protected override onBackdropClick(_event: MouseEvent): void {
        // no-op: protect session from accidental dismissal
    }

    protected override onCloseButtonClick(): void {
        if (!this.shellStarted) {
            this.close();
            return;
        }
        this.showCloseConfirm();
    }

    private showCloseConfirm(): void {
        const overlay = document.createElement('dialog');
        overlay.className = 'shell-close-confirm';
        overlay.style.cssText =
            'border: 1px solid var(--modal-border, rgba(255,255,255,0.15)); border-radius: 8px; ' +
            'padding: 32px 40px; background: var(--modal-bg, #1e1e2e); color: var(--text-primary, #cdd6f4); ' +
            'min-width: 420px; text-align: center;';

        const msg = document.createElement('p');
        msg.style.cssText = 'margin: 0 0 16px;';
        msg.textContent = 'end the shell session?';
        overlay.appendChild(msg);

        const buttons = document.createElement('div');
        buttons.style.cssText = 'display: flex; gap: 8px; justify-content: center;';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'settings-btn';
        cancelBtn.textContent = 'cancel';
        cancelBtn.addEventListener('click', () => {
            overlay.close();
            overlay.remove();
        });
        buttons.appendChild(cancelBtn);

        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'settings-btn settings-btn-primary';
        okBtn.textContent = 'ok';
        okBtn.addEventListener('click', () => {
            overlay.close();
            overlay.remove();
            this.close();
        });
        buttons.appendChild(okBtn);

        overlay.appendChild(buttons);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.close();
                overlay.remove();
            }
        });

        document.body.appendChild(overlay);
        overlay.showModal();
    }

    protected override onBeforeClose(): void {
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

        // Get or create a multiplexer for this URL
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

        // Create a channel for the shell
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

        // FitAddon requires the container to have real pixel dimensions.
        // In a dynamically created modal, the container may not be laid out
        // yet when open() is called. ResizeObserver fires when the container
        // actually gets dimensions, and on every subsequent resize.
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
            type: 'shell',
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
