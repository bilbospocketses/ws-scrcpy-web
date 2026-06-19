import '../../../style/listfiles.css';
import Protocol from '../../../common/AdbProtocol';
import { Multiplexer } from '../../../packages/multiplexer/Multiplexer';
import { BinaryWriter } from '../../BinaryWriter';
import { ManagerClient } from '../../client/ManagerClient';
import { basename, resolve } from '../../pathUtils';
import { Modal } from '../../ui/Modal';
import { debugLog } from '../../util/debugLog';
import { Entry } from '../Entry';
import { AdbkitFilePushStream } from '../filePush/AdbkitFilePushStream';
import FilePushHandler, { type DragAndPushListener, type PushUpdateParams } from '../filePush/FilePushHandler';
import { parseDataChunk, parseDentReply, parseFailReply, parseStatReply, readSyncReplyCode } from './adbSyncReply';
import { createFileIconForEntry } from './FileIconUtils';
import { attachFsChannelKeepAlive } from './fsChannelKeepAlive';
import { buildFslsInitData, buildMultiplexUrl } from './multiplexConnection';

const TAG = '[ListFilesModal]';
const ICON_SIZE_KEY = 'file-browser-icon-size';
const DEFAULT_ICON_SIZE = 24;
const ICON_SIZES = [16, 20, 24, 28, 32];
const REMOVE_ROW_TIMEOUT = 2000;

type SortField = 'name' | 'size' | 'date';
type SortDir = 'asc' | 'desc';

type Download = {
    cmd: string;
    receivedBytes: number;
    entry?: Entry | undefined;
    progressEl?: HTMLElement | undefined;
    chunks: Uint8Array[];
    path: string;
    pathToLoadAfter: string;
};

type Upload = {
    row: HTMLElement;
    progressEl: HTMLElement;
    timeout: number | null;
};

function formatSize(bytes: number): string {
    if (bytes === 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1073741824).toFixed(1)} GB`;
}

function formatDate(date: Date): string {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const year = String(date.getFullYear()).slice(2);
    const day = String(date.getDate()).padStart(2, '0');
    return `${months[date.getMonth()]} ${day} ${year}`;
}

export class ListFilesModal extends Modal implements DragAndPushListener {
    private readonly udid: string;
    private readonly params: {
        hostname?: string | undefined;
        port?: number | undefined;
        secure?: boolean | undefined;
        pathname?: string | undefined;
    };

    private iconSize = DEFAULT_ICON_SIZE;
    private currentPath = '/data/local/tmp';
    private entries: Entry[] = [];
    private filteredEntries: Entry[] = [];
    private selectedPaths: Set<string> = new Set();
    private sortField: SortField = 'name';
    private sortDir: SortDir = 'asc';
    private filterText = '';

    // WebSocket state
    private multiplexer?: Multiplexer | undefined;
    private wsUrl = '';
    private channels: Set<Multiplexer> = new Set();
    private downloads: Map<Multiplexer, Download> = new Map();
    private uploads: Map<string, Upload> = new Map();
    private activeDownloads = 0;
    private activeUploads = 0;
    private reloadTimeout?: number | undefined;

    // Upload infrastructure
    private filePushHandler?: FilePushHandler | undefined;
    private enterCount = 0;

    // DOM references
    private breadcrumbBar?: HTMLElement;
    private filterInput?: HTMLInputElement;
    private headerCheck?: HTMLInputElement;
    private fileListBody?: HTMLElement;
    private rowsContainer?: HTMLElement;
    // Footer elements are NOT stored during buildFooter() — ES2022 field initializers
    // clobber values set during super(). Query from DOM instead via getFooterEl().
    private dropZone?: HTMLElement;
    // uploadInput also queried from DOM (same ES2022 reason)

    constructor(
        udid: string,
        deviceLabel: string,
        params: {
            hostname?: string | undefined;
            port?: number | undefined;
            secure?: boolean | undefined;
            pathname?: string | undefined;
        },
    ) {
        super({ title: deviceLabel });
        this.dialog.classList.add('list-files-modal');

        this.udid = udid;
        this.params = params;

        // Add size picker button to header (left of X)
        const sizeBtn = document.createElement('button');
        sizeBtn.className = 'modal-close';
        sizeBtn.textContent = '\u229e'; // ⊞
        sizeBtn.title = 'icon size preference';
        sizeBtn.addEventListener('click', () => this.showSizePicker());
        this.addHeaderButton(sizeBtn);

        // Check localStorage for saved size preference
        const savedSize = localStorage.getItem(ICON_SIZE_KEY);
        if (savedSize) {
            this.iconSize = parseInt(savedSize, 10);
            this.dialog.style.setProperty('--file-icon-size', `${this.iconSize}px`);
            this.initFileBrowser();
        } else {
            this.showSizePicker();
        }
    }

    // ── Modal overrides ──

    protected buildBody(_container: HTMLElement): void {
        // Empty — content is built after super() completes
    }

    protected override buildFooter(): HTMLElement | null {
        const footer = document.createElement('div');
        footer.className = 'list-files-footer';

        // Left: action buttons
        const actions = document.createElement('div');
        actions.className = 'list-files-footer-actions';

        const uploadBtn = document.createElement('button');
        uploadBtn.className = 'list-files-footer-btn lf-upload-btn';
        uploadBtn.textContent = 'upload';
        uploadBtn.addEventListener('click', () => this.triggerUpload());
        actions.appendChild(uploadBtn);

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'list-files-footer-btn delete lf-delete-btn';
        deleteBtn.textContent = 'delete';
        deleteBtn.disabled = true;
        deleteBtn.addEventListener('click', () => this.deleteSelected());
        actions.appendChild(deleteBtn);

        const downloadBtn = document.createElement('button');
        downloadBtn.className = 'list-files-footer-btn lf-download-btn';
        downloadBtn.textContent = 'download';
        downloadBtn.disabled = true;
        downloadBtn.addEventListener('click', () => this.downloadSelected());
        actions.appendChild(downloadBtn);

        footer.appendChild(actions);

        // Right: info
        const info = document.createElement('span');
        info.className = 'list-files-footer-info lf-footer-info';
        footer.appendChild(info);

        // Hidden file input for upload button
        const uploadInput = document.createElement('input');
        uploadInput.type = 'file';
        uploadInput.multiple = true;
        uploadInput.style.display = 'none';
        uploadInput.addEventListener('change', () => this.handleUploadInput());
        footer.appendChild(uploadInput);

        return footer;
    }

    protected override onEscapeKey(_event: Event): void {
        if (this.confirmClose()) this.close();
    }

    protected override onBackdropClick(_event: MouseEvent): void {
        if (this.confirmClose()) this.close();
    }

    protected override onCloseButtonClick(): void {
        if (this.confirmClose()) this.close();
    }

    protected override onBeforeClose(): void {
        // Clean up upload handler
        if (this.filePushHandler) {
            this.filePushHandler.release();
            this.filePushHandler = undefined;
        }

        // Close all open channels
        this.channels.forEach((ch) => {
            if (ch.readyState === ch.OPEN || ch.readyState === ch.CONNECTING) {
                ch.close();
            }
        });
        this.channels.clear();
        this.downloads.clear();
        this.uploads.clear();

        // Detach the keep-alive 'empty' handler before closing the FSLS channel
        // so the listener (and its hold on the channel) is released. (#38)
        if (this.detachFsChannelKeepAlive) {
            this.detachFsChannelKeepAlive();
            this.detachFsChannelKeepAlive = undefined;
        }

        // Close the FSLS channel
        if (
            this.fsChannel &&
            (this.fsChannel.readyState === this.fsChannel.OPEN ||
                this.fsChannel.readyState === this.fsChannel.CONNECTING)
        ) {
            this.fsChannel.close();
        }
        this.fsChannel = undefined;
    }

    // ── Transfer confirmation ──

    private hasActiveTransfers(): boolean {
        return this.activeDownloads > 0 || this.activeUploads > 0;
    }

    private confirmClose(): boolean {
        if (this.hasActiveTransfers()) {
            return confirm('transfers in progress \u2014 close anyway?');
        }
        return true;
    }

    // ── Size picker ──

    private showSizePicker(): void {
        this.bodyEl.innerHTML = '';

        const picker = document.createElement('div');
        picker.className = 'list-files-size-picker';

        const heading = document.createElement('h3');
        heading.textContent = 'icon size';
        picker.appendChild(heading);

        const options = document.createElement('div');
        options.className = 'list-files-size-options';

        let selectedSize = this.iconSize;

        ICON_SIZES.forEach((size) => {
            const opt = document.createElement('div');
            opt.className = 'list-files-size-option';
            if (size === selectedSize) opt.classList.add('selected');

            const preview = document.createElement('div');
            preview.innerHTML =
                '<svg viewBox="0 0 24 24" style="fill:currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6z"/></svg>';
            const svg = preview.querySelector('svg') as SVGElement;
            svg.style.width = `${size}px`;
            svg.style.height = `${size}px`;
            opt.appendChild(preview);

            const label = document.createElement('div');
            label.className = 'size-label';
            label.textContent = `${size}px`;
            opt.appendChild(label);

            opt.addEventListener('click', () => {
                options.querySelectorAll('.list-files-size-option').forEach((el) => {
                    el.classList.remove('selected');
                });
                opt.classList.add('selected');
                selectedSize = size;
            });

            options.appendChild(opt);
        });

        picker.appendChild(options);

        // Controls row
        const controls = document.createElement('div');
        controls.className = 'list-files-size-picker-controls';

        const saveLabel = document.createElement('label');
        const saveCheck = document.createElement('input');
        saveCheck.type = 'checkbox';
        const hasSavedPref = localStorage.getItem(ICON_SIZE_KEY) !== null;
        saveCheck.checked = hasSavedPref;
        saveLabel.appendChild(saveCheck);
        saveLabel.appendChild(document.createTextNode(' save preference (skip this dialog next time)'));
        controls.appendChild(saveLabel);

        const note = document.createElement('div');
        note.className = 'list-files-size-picker-note';
        const updateNote = (): void => {
            note.textContent = saveCheck.checked ? 'uncheck and click ok to clear saved preference' : '';
        };
        saveCheck.addEventListener('change', updateNote);
        updateNote();

        const okBtn = document.createElement('button');
        okBtn.className = 'list-files-footer-btn';
        okBtn.textContent = 'ok';
        okBtn.addEventListener('click', () => {
            this.iconSize = selectedSize;
            this.dialog.style.setProperty('--file-icon-size', `${this.iconSize}px`);
            if (saveCheck.checked) {
                localStorage.setItem(ICON_SIZE_KEY, String(this.iconSize));
            } else {
                localStorage.removeItem(ICON_SIZE_KEY);
            }
            this.initFileBrowser();
        });
        controls.appendChild(okBtn);

        picker.appendChild(controls);
        picker.appendChild(note);

        this.bodyEl.appendChild(picker);
    }

    // ── File browser initialization ──

    private initFileBrowser(): void {
        this.bodyEl.innerHTML = '';

        // Breadcrumb bar
        this.breadcrumbBar = document.createElement('div');
        this.breadcrumbBar.className = 'list-files-breadcrumbs';
        this.bodyEl.appendChild(this.breadcrumbBar);

        // Column headers
        const headerRow = document.createElement('div');
        headerRow.className = 'list-files-header';

        this.headerCheck = document.createElement('input');
        this.headerCheck.type = 'checkbox';
        this.headerCheck.className = 'list-files-header-check';
        this.headerCheck.addEventListener('change', () => this.toggleSelectAll());
        headerRow.appendChild(this.headerCheck);

        // Spacer for icon column — matches file icon width so columns align
        const iconSpacer = document.createElement('span');
        iconSpacer.className = 'list-files-header-icon-spacer';
        headerRow.appendChild(iconSpacer);

        const nameHeader = document.createElement('span');
        nameHeader.className = 'list-files-header-name';
        nameHeader.textContent = 'name';
        nameHeader.addEventListener('click', () => this.toggleSort('name'));
        headerRow.appendChild(nameHeader);

        // Spacer reserves the actions column width so size/date stay aligned
        // whether actions are visible (hover) or hidden (non-hover, folder rows)
        const actionsSpacer = document.createElement('span');
        actionsSpacer.className = 'list-files-header-actions-spacer';
        headerRow.appendChild(actionsSpacer);

        const sizeHeader = document.createElement('span');
        sizeHeader.className = 'list-files-header-size';
        sizeHeader.textContent = 'size';
        sizeHeader.addEventListener('click', () => this.toggleSort('size'));
        headerRow.appendChild(sizeHeader);

        const dateHeader = document.createElement('span');
        dateHeader.className = 'list-files-header-date';
        dateHeader.textContent = 'date';
        dateHeader.addEventListener('click', () => this.toggleSort('date'));
        headerRow.appendChild(dateHeader);

        // Scrollable file list — header is placed INSIDE this scroll container as
        // a sticky element so header and rows share the same viewport width when
        // a scrollbar appears (otherwise size/date columns would mis-align).
        this.fileListBody = document.createElement('div');
        this.fileListBody.className = 'list-files-body';
        this.fileListBody.appendChild(headerRow);
        this.rowsContainer = document.createElement('div');
        this.rowsContainer.className = 'list-files-rows';
        this.fileListBody.appendChild(this.rowsContainer);
        this.bodyEl.appendChild(this.fileListBody);

        // Drop zone overlay (hidden by default)
        this.dropZone = document.createElement('div');
        this.dropZone.className = 'list-files-dropzone';
        this.dropZone.textContent = 'drop files here';
        this.dropZone.style.display = 'none';
        this.bodyEl.appendChild(this.dropZone);

        // Set up drag-and-drop on the body element
        this.bodyEl.style.position = 'relative';

        // Connect WebSocket and load initial directory
        this.connectAndLoad();
    }

    // ── WebSocket connection ──

    private buildWebSocketUrl(): string {
        const { hostname, port, secure, pathname } = this.params;
        return buildMultiplexUrl({ hostname, port, secure, pathname });
    }

    // buildMultiplexUrl throws on a malformed device hostname/port; show a
    // friendly inline message and close instead of letting the throw abort the
    // modal open with an uncaught error. Mirrors ConnectModal's onError UI.
    private showConnectError(err: unknown): void {
        console.error('[ListFilesModal]', err);
        const errorEl = document.createElement('div');
        errorEl.className = 'list-files-modal-error';
        errorEl.textContent = `connection failed: ${err instanceof Error ? err.message : String(err)}`;
        errorEl.style.cssText =
            'padding: 24px; color: #f06c75; font-family: monospace; font-size: 14px; text-align: center;';
        this.bodyEl.innerHTML = '';
        this.bodyEl.appendChild(errorEl);
        // Close after 4s (long enough to read, short enough not to feel stuck).
        setTimeout(() => this.close(), 4000);
    }

    // The FSLS channel — a sub-multiplexer on the shared WebSocket multiplexer.
    // ManagerClient creates this via createChannel(getChannelInitData()).
    // loadDirectory creates command sub-channels on THIS channel, not on the root multiplexer.
    private fsChannel?: Multiplexer | undefined;
    // Disposer that removes the FSLS channel's keep-alive 'empty' handler.
    // Stored so onBeforeClose can detach it (the handler closes over nothing,
    // but leaving it registered keeps the listener — and the channel ref —
    // around). See attachFsChannelKeepAlive. (#38)
    private detachFsChannelKeepAlive?: (() => void) | undefined;

    private connectAndLoad(): void {
        try {
            this.wsUrl = this.buildWebSocketUrl();
        } catch (err) {
            this.showConnectError(err);
            return;
        }

        // Get or create the shared root multiplexer (same pattern as ManagerClient/ShellModal)
        let mux = ManagerClient.sockets.get(this.wsUrl);
        if (!mux) {
            const ws = new WebSocket(this.wsUrl);
            ws.addEventListener('close', () => {
                ManagerClient.sockets.delete(this.wsUrl);
            });
            const newMux = Multiplexer.wrap(ws);
            newMux.on('empty', () => {
                newMux.close();
            });
            ManagerClient.sockets.set(this.wsUrl, newMux);
            mux = newMux;
        }
        this.multiplexer = mux;

        // Create the FSLS channel on the root multiplexer (like ManagerClient does for FileListingClient).
        // This gives us a sub-multiplexer that the server routes to the FileListing handler.
        // Command sub-channels (STAT/LIST/RECV) are created on THIS channel.
        const initChannel = (): void => {
            const initData = this.getChannelInitData();
            debugLog(TAG, 'wsUrl:', this.wsUrl, 'mux readyState:', this.multiplexer?.readyState, 'sockets:', [
                ...ManagerClient.sockets.keys(),
            ]);
            this.fsChannel = this.multiplexer!.createChannel(initData);

            debugLog(TAG, 'FSLS channel created, readyState:', this.fsChannel.readyState);

            this.fsChannel.addEventListener('open', () => {
                debugLog(TAG, 'FSLS channel opened, readyState:', this.fsChannel?.readyState);
                // Set up upload handler (needs the FSLS channel for AdbkitFilePushStream)
                const pushStream = new AdbkitFilePushStream(this.fsChannel!, this);
                this.filePushHandler = new FilePushHandler(this.bodyEl, pushStream);
                this.filePushHandler.addEventListener(this);

                this.loadDirectory(this.currentPath);
            });

            // Prevent the FSLS channel from being cleaned up by the root multiplexer's
            // 'empty' handler when it temporarily has no sub-channels (e.g., between STAT
            // finishing and LIST starting). We control the lifecycle via onBeforeClose.
            // The disposer detaches this exact handler when the modal closes so it
            // doesn't leak (an inline arrow here would be unremovable).
            this.detachFsChannelKeepAlive = attachFsChannelKeepAlive(this.fsChannel);

            this.fsChannel.addEventListener('close', (ev) => {
                const ce = ev as CloseEvent;
                debugLog(TAG, 'FSLS channel closed, code:', ce.code, 'reason:', ce.reason);
            });
        };

        this.showLoading();

        if (this.multiplexer.readyState === this.multiplexer.OPEN) {
            initChannel();
        } else {
            const onOpen = (): void => {
                this.multiplexer?.removeEventListener('open', onOpen);
                initChannel();
            };
            this.multiplexer.addEventListener('open', onOpen);
        }
    }

    // Required by AdbkitFilePushStream (duck-typed as FileListingClient)
    public getPath(): string {
        return this.currentPath;
    }

    // ── Footer element accessors (query from DOM to avoid ES2022 field clobbering) ──

    private getDeleteBtn(): HTMLButtonElement | null {
        return this.frameEl.querySelector('.lf-delete-btn') as HTMLButtonElement | null;
    }
    private getDownloadBtn(): HTMLButtonElement | null {
        return this.frameEl.querySelector('.lf-download-btn') as HTMLButtonElement | null;
    }
    private getFooterInfo(): HTMLElement | null {
        return this.frameEl.querySelector('.lf-footer-info');
    }
    private getUploadInput(): HTMLInputElement | null {
        return this.frameEl.querySelector('input[type="file"]') as HTMLInputElement | null;
    }

    // ── Directory listing protocol ──

    private getChannelInitData(): Uint8Array {
        return buildFslsInitData(this.udid);
    }

    private loadDirectory(path: string): void {
        debugLog(
            TAG,
            'loadDirectory:',
            path,
            'fsChannel:',
            !!this.fsChannel,
            'readyState:',
            this.fsChannel?.readyState,
        );
        if (!this.fsChannel || this.fsChannel.readyState !== this.fsChannel.OPEN) {
            debugLog(TAG, 'loadDirectory BAILED — fsChannel not ready');
            return;
        }
        this.showLoading();
        this.entries = [];
        this.selectedPaths.clear();
        this.filterText = '';
        if (this.filterInput) this.filterInput.value = '';

        // Use STAT first to determine if it's a dir
        this.sendCommand(Protocol.STAT, path, undefined, '');
    }

    private downloadFile(path: string, entry: Entry): void {
        if (!this.fsChannel || this.fsChannel.readyState !== this.fsChannel.OPEN) {
            return;
        }
        this.activeDownloads++;
        this.sendCommand(Protocol.RECV, path, entry, '');
    }

    private sendCommand(cmd: string, path: string, entry?: Entry, pathToLoadAfter = ''): void {
        debugLog(
            TAG,
            'sendCommand:',
            cmd,
            path,
            'fsChannel:',
            !!this.fsChannel,
            'readyState:',
            this.fsChannel?.readyState,
        );
        if (!this.fsChannel) {
            debugLog(TAG, 'sendCommand BAILED — no fsChannel');
            return;
        }

        // Build command payload (STAT/LIST/RECV + path length + path)
        const pathBytes = new TextEncoder().encode(path);
        const cmdBytes = new TextEncoder().encode(cmd);
        const payload = new BinaryWriter(cmdBytes.length + 4 + pathBytes.length)
            .writeBytes(cmdBytes)
            .writeUInt32LE(pathBytes.length)
            .writeBytes(pathBytes)
            .toUint8Array();

        // Create a sub-channel on the FSLS channel with the command as channel init data
        // (same pattern as FileListingClient.loadContent — this.ws.createChannel(payload))
        try {
            const channel = this.fsChannel.createChannel(payload);
            debugLog(TAG, 'Sub-channel created for', cmd, 'readyState:', channel.readyState);
            this.channels.add(channel);

            const download: Download = {
                cmd,
                receivedBytes: 0,
                path,
                entry,
                chunks: [],
                pathToLoadAfter,
            };
            this.downloads.set(channel, download);

            const onMessage = (event: MessageEvent): void => {
                this.handleReply(channel, event);
            };
            const onClose = (): void => {
                const dl = this.downloads.get(channel);
                this.channels.delete(channel);
                this.downloads.delete(channel);
                channel.removeEventListener('message', onMessage);
                channel.removeEventListener('close', onClose);

                // For directory listings (LIST command), the server closes the channel after
                // all DENT entries (no DONE message). Render the listing — even if empty.
                // Only trigger for LIST, not STAT (STAT close is just a transition step).
                if (dl?.cmd === Protocol.LIST) {
                    this.entries = this.pendingEntries.slice();
                    this.pendingEntries = [];
                    this.currentPath = dl?.path ?? this.currentPath;
                    debugLog(
                        TAG,
                        'Channel closed: directory listing complete,',
                        this.entries.length,
                        'entries for path:',
                        this.currentPath,
                    );
                    this.applyFilterAndSort();
                    this.renderBreadcrumbs();
                    this.renderFileList();
                    this.updateFooterInfo();
                }
            };
            channel.addEventListener('message', onMessage);
            channel.addEventListener('close', onClose);
        } catch (err) {
            console.error(TAG, 'Failed to create sub-channel:', err);
        }
    }

    private pendingEntries: Entry[] = [];

    private handleReply(channel: Multiplexer, e: MessageEvent): void {
        const data = new Uint8Array(e.data);
        const reply = readSyncReplyCode(data);
        debugLog(TAG, 'handleReply:', reply, 'dataLen:', data.length);

        switch (reply) {
            case Protocol.DENT: {
                const entry = parseDentReply(data);
                // Skip '.' and '..'
                if (entry.name !== '.' && entry.name !== '..') {
                    this.pendingEntries.push(entry);
                }
                return;
            }
            case Protocol.DONE: {
                const download = this.downloads.get(channel);
                if (download && download.entry && download.entry.isFile()) {
                    // File download complete
                    this.finishFileDownload(channel);
                } else {
                    // Directory listing complete
                    this.entries = this.pendingEntries.slice();
                    this.pendingEntries = [];
                    debugLog(
                        TAG,
                        'DONE: directory listing complete,',
                        this.entries.length,
                        'entries for path:',
                        download?.path,
                    );
                    this.currentPath = download?.path ?? this.currentPath;
                    this.applyFilterAndSort();
                    this.renderBreadcrumbs();
                    this.renderFileList();
                    this.updateFooterInfo();
                }
                return;
            }
            case Protocol.STAT: {
                const download = this.downloads.get(channel);
                if (!download) return;

                const { mode, size, mtime } = parseStatReply(data);
                const nameString = basename(download.path);

                if (mode === 0) {
                    console.error(TAG, `no entity "${download.path}"`);
                    // Fall back to /data/local/tmp
                    this.channels.delete(channel);
                    this.downloads.delete(channel);
                    this.loadDirectory('/data/local/tmp');
                    return;
                }

                const entry = new Entry(nameString, mode, size, mtime);
                if (entry.isDirectory()) {
                    // It's a directory — send LIST
                    this.channels.delete(channel);
                    this.downloads.delete(channel);
                    this.sendCommand(Protocol.LIST, download.path, entry, '');
                } else if (entry.isFile()) {
                    // It's a file — download it
                    this.channels.delete(channel);
                    this.downloads.delete(channel);
                    this.downloadFile(download.path, entry);
                }
                break;
            }
            case Protocol.FAIL: {
                const message = parseFailReply(data);
                console.error(TAG, `FAIL: ${message}`);
                return;
            }
            case Protocol.DATA: {
                const download = this.downloads.get(channel);
                if (!download) return;

                const chunk = parseDataChunk(data);
                download.chunks.push(chunk);
                download.receivedBytes += chunk.length;

                // Update progress bar in the file row
                if (download.entry) {
                    const rowEl = this.fileListBody?.querySelector(
                        `[data-path="${CSS.escape(download.path)}"]`,
                    ) as HTMLElement;
                    if (rowEl) {
                        let progressEl = rowEl.querySelector('.list-files-progress') as HTMLElement;
                        if (!progressEl) {
                            progressEl = document.createElement('div');
                            progressEl.className = 'list-files-progress';
                            rowEl.appendChild(progressEl);
                        }
                        const percent = (download.receivedBytes * 100) / download.entry.size;
                        progressEl.style.width = `${percent}%`;
                    }
                }
                return;
            }
            default:
                console.error(TAG, `unexpected reply "${reply}"`);
        }
    }

    private finishFileDownload(channel: Multiplexer): void {
        const download = this.downloads.get(channel);
        if (!download) return;
        this.downloads.delete(channel);
        this.activeDownloads--;

        // Clean progress bar
        if (download.entry) {
            const rowEl = this.fileListBody?.querySelector(`[data-path="${CSS.escape(download.path)}"]`) as HTMLElement;
            if (rowEl) {
                const progressEl = rowEl.querySelector('.list-files-progress') as HTMLElement;
                if (progressEl) {
                    progressEl.classList.add('finished');
                    setTimeout(() => progressEl.remove(), 300);
                }
            }
        }

        const name = download.entry?.name ?? basename(download.path);
        const file = new File(download.chunks as BlobPart[], name, { type: 'application/octet-stream' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(file);
        a.download = name;
        a.click();
        URL.revokeObjectURL(a.href);

        this.updateFooterState();
    }

    // ── Sorting and filtering ──

    private applyFilterAndSort(): void {
        let filtered = this.entries;

        // Apply filter
        if (this.filterText) {
            const lower = this.filterText.toLowerCase();
            filtered = filtered.filter((e) => e.name.toLowerCase().includes(lower));
        }

        // Sort: directories always first
        filtered.sort((a, b) => {
            const aIsDir = a.isDirectory() ? 0 : 1;
            const bIsDir = b.isDirectory() ? 0 : 1;
            if (aIsDir !== bIsDir) return aIsDir - bIsDir;

            const dir = this.sortDir === 'asc' ? 1 : -1;
            switch (this.sortField) {
                case 'name':
                    return a.name.localeCompare(b.name) * dir;
                case 'size':
                    return (a.size - b.size) * dir;
                case 'date':
                    return (a.mtime.getTime() - b.mtime.getTime()) * dir;
                default:
                    return 0;
            }
        });

        this.filteredEntries = filtered;
    }

    private toggleSort(field: SortField): void {
        if (this.sortField === field) {
            this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortField = field;
            this.sortDir = 'asc';
        }
        this.applyFilterAndSort();
        this.renderFileList();
        this.updateSortArrows();
    }

    private updateSortArrows(): void {
        const headerRow = this.bodyEl.querySelector('.list-files-header');
        if (!headerRow) return;
        headerRow.querySelectorAll('.list-files-sort-arrow').forEach((el) => {
            el.remove();
        });

        const selector =
            this.sortField === 'name'
                ? '.list-files-header-name'
                : this.sortField === 'size'
                  ? '.list-files-header-size'
                  : '.list-files-header-date';
        const headerEl = headerRow.querySelector(selector);
        if (headerEl) {
            const arrow = document.createElement('span');
            arrow.className = 'list-files-sort-arrow';
            arrow.textContent = this.sortDir === 'asc' ? ' \u25b2' : ' \u25bc';
            headerEl.appendChild(arrow);
        }
    }

    // ── Breadcrumbs ──

    private renderBreadcrumbs(): void {
        if (!this.breadcrumbBar) return;
        this.breadcrumbBar.innerHTML = '';

        const parts = this.currentPath.split('/').filter(Boolean);

        // Root segment
        const rootSeg = document.createElement('span');
        rootSeg.className = 'list-files-breadcrumb-segment';
        rootSeg.textContent = '/';
        rootSeg.addEventListener('click', () => this.loadDirectory('/'));
        this.breadcrumbBar.appendChild(rootSeg);

        parts.forEach((part, i) => {
            const sep = document.createElement('span');
            sep.className = 'list-files-breadcrumb-separator';
            sep.textContent = '/';
            this.breadcrumbBar!.appendChild(sep);

            const isLast = i === parts.length - 1;
            const seg = document.createElement('span');
            if (isLast) {
                seg.className = 'list-files-breadcrumb-current';
                seg.textContent = part;
            } else {
                seg.className = 'list-files-breadcrumb-segment';
                seg.textContent = part;
                const targetPath = '/' + parts.slice(0, i + 1).join('/');
                seg.addEventListener('click', () => this.loadDirectory(targetPath));
            }
            this.breadcrumbBar!.appendChild(seg);
        });

        // Filter input (right side)
        const filterWrap = document.createElement('span');
        filterWrap.className = 'list-files-filter';
        this.filterInput = document.createElement('input');
        this.filterInput.type = 'text';
        this.filterInput.placeholder = 'filter...';
        this.filterInput.value = this.filterText;
        this.filterInput.addEventListener('input', () => {
            this.filterText = this.filterInput?.value ?? '';
            this.applyFilterAndSort();
            this.renderFileList();
            this.updateFooterInfo();
        });
        filterWrap.appendChild(this.filterInput);
        this.breadcrumbBar.appendChild(filterWrap);
    }

    // ── File list rendering ──

    private renderFileList(): void {
        if (!this.rowsContainer) return;
        this.rowsContainer.innerHTML = '';

        if (this.filteredEntries.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'list-files-loading';
            empty.textContent = this.filterText ? 'no matching files' : 'empty directory';
            this.rowsContainer.appendChild(empty);
            return;
        }

        this.filteredEntries.forEach((entry) => {
            const row = this.createFileRow(entry);
            this.rowsContainer!.appendChild(row);
        });

        this.updateHeaderCheck();
        this.updateSortArrows();
    }

    private createFileRow(entry: Entry): HTMLElement {
        const row = document.createElement('div');
        row.className = 'list-files-row';
        const entryPath = resolve(this.currentPath, entry.name);
        row.setAttribute('data-path', entryPath);

        if (entry.isDirectory()) {
            row.classList.add('directory');
        }

        if (this.selectedPaths.has(entryPath)) {
            row.classList.add('selected');
        }

        // Checkbox
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'list-files-row-check';
        check.checked = this.selectedPaths.has(entryPath);
        check.addEventListener('change', (e) => {
            e.stopPropagation();
            if (check.checked) {
                this.selectedPaths.add(entryPath);
                row.classList.add('selected');
            } else {
                this.selectedPaths.delete(entryPath);
                row.classList.remove('selected');
            }
            this.updateHeaderCheck();
            this.updateFooterState();
        });
        check.addEventListener('click', (e) => e.stopPropagation());
        row.appendChild(check);

        // Icon
        const icon = createFileIconForEntry(entry.name, entry.isDirectory(), entry.isSymbolicLink());
        row.appendChild(icon);

        // Name
        const nameSpan = document.createElement('span');
        nameSpan.className = 'list-files-row-name';
        nameSpan.textContent = entry.name;
        row.appendChild(nameSpan);

        // Hover actions (reserved column — always takes space, visibility toggled on hover)
        const actions = document.createElement('div');
        actions.className = 'list-files-row-actions';

        if (entry.isFile()) {
            const dlBtn = document.createElement('button');
            dlBtn.className = 'list-files-action-btn list-files-action-download';
            dlBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';
            dlBtn.title = 'download';
            dlBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.downloadFile(entryPath, entry);
            });
            actions.appendChild(dlBtn);
        }

        const delBtn = document.createElement('button');
        delBtn.className = 'list-files-action-btn list-files-action-delete';
        delBtn.innerHTML =
            '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
        delBtn.title = 'delete';
        delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm(`delete "${entry.name}"?`)) {
                this.deleteFiles([entryPath]);
            }
        });
        actions.appendChild(delBtn);

        row.appendChild(actions);

        // Size
        const sizeSpan = document.createElement('span');
        sizeSpan.className = 'list-files-row-size';
        sizeSpan.textContent = entry.isDirectory() ? '' : formatSize(entry.size);
        row.appendChild(sizeSpan);

        // Date
        const dateSpan = document.createElement('span');
        dateSpan.className = 'list-files-row-date';
        dateSpan.textContent = formatDate(entry.mtime);
        row.appendChild(dateSpan);

        // Row click: navigate into directories
        row.addEventListener('click', () => {
            if (entry.isDirectory()) {
                this.loadDirectory(entryPath);
            }
        });

        return row;
    }

    private showLoading(): void {
        if (!this.rowsContainer) return;
        this.rowsContainer.innerHTML = '';
        const loading = document.createElement('div');
        loading.className = 'list-files-loading';
        loading.textContent = 'loading...';
        this.rowsContainer.appendChild(loading);
    }

    // ── Selection ──

    private toggleSelectAll(): void {
        if (!this.headerCheck) return;
        const selectAll = this.headerCheck.checked;

        if (selectAll) {
            this.filteredEntries.forEach((entry) => {
                this.selectedPaths.add(resolve(this.currentPath, entry.name));
            });
        } else {
            this.selectedPaths.clear();
        }

        // Update all visible checkboxes
        this.fileListBody?.querySelectorAll('.list-files-row').forEach((row) => {
            const check = row.querySelector('.list-files-row-check') as HTMLInputElement;
            if (check) check.checked = selectAll;
            row.classList.toggle('selected', selectAll);
        });

        this.updateFooterState();
    }

    private updateHeaderCheck(): void {
        if (!this.headerCheck) return;
        const total = this.filteredEntries.length;
        const selected = this.selectedPaths.size;
        this.headerCheck.checked = total > 0 && selected === total;
        this.headerCheck.indeterminate = selected > 0 && selected < total;
    }

    // ── Footer state ──

    private updateFooterState(): void {
        const hasSelection = this.selectedPaths.size > 0;
        const hasDirSelection = this.filteredEntries.some(
            (e) => e.isDirectory() && this.selectedPaths.has(resolve(this.currentPath, e.name)),
        );
        // Download disabled when ANY directory is selected (can't download dirs over ADB)
        const canDownload = hasSelection && !hasDirSelection;

        const delBtn = this.getDeleteBtn();
        if (delBtn) delBtn.disabled = !hasSelection;
        const dlBtn = this.getDownloadBtn();
        if (dlBtn) dlBtn.disabled = !canDownload;

        this.updateFooterInfo();
    }

    private updateFooterInfo(): void {
        const info = this.getFooterInfo();
        if (!info) return;

        const selectedCount = this.selectedPaths.size;
        const totalCount = this.filteredEntries.length;

        if (selectedCount > 0) {
            info.textContent = `${selectedCount} selected / ${totalCount} items`;
        } else {
            info.textContent = `${totalCount} items`;
        }
    }

    // ── Download ──

    private downloadSelected(): void {
        this.filteredEntries.forEach((entry) => {
            if (entry.isFile()) {
                const path = resolve(this.currentPath, entry.name);
                if (this.selectedPaths.has(path)) {
                    this.downloadFile(path, entry);
                }
            }
        });
    }

    // ── Upload ──

    private triggerUpload(): void {
        this.getUploadInput()?.click();
    }

    private handleUploadInput(): void {
        const input = this.getUploadInput();
        if (!input?.files) return;
        const files = Array.from(input.files);
        if (files.length === 0) return;

        // Use the FilePushHandler directly
        if (this.filePushHandler) {
            this.filePushHandler.onFilesDrop(files);
        }

        // Reset input so the same file can be uploaded again
        if (input) input.value = '';
    }

    // DragAndPushListener interface
    public onDragEnter(): boolean {
        if (this.enterCount === 0 && this.dropZone) {
            this.dropZone.style.display = 'flex';
        }
        this.enterCount++;
        return true;
    }

    public onDragLeave(): boolean {
        this.enterCount--;
        if (this.enterCount < 0) this.enterCount = 0;
        if (this.enterCount === 0 && this.dropZone) {
            this.dropZone.style.display = 'none';
        }
        return true;
    }

    public onDrop(): boolean {
        this.enterCount = 0;
        if (this.dropZone) this.dropZone.style.display = 'none';
        return true;
    }

    public onFilePushUpdate(data: PushUpdateParams): void {
        const { fileName, progress, error, message, finished } = data;
        let upload = this.uploads.get(fileName);

        if (!upload) {
            // Create an upload row in the file list
            const row = document.createElement('div');
            row.className = 'list-files-row';
            row.id = `upload-${fileName}`;

            const spacer = document.createElement('input');
            spacer.type = 'checkbox';
            spacer.className = 'list-files-row-check';
            spacer.disabled = true;
            row.appendChild(spacer);

            const icon = createFileIconForEntry(fileName, false, false);
            row.appendChild(icon);

            const nameSpan = document.createElement('span');
            nameSpan.className = 'list-files-row-name';
            nameSpan.textContent = `${fileName}: ${message}`;
            row.appendChild(nameSpan);

            const progressEl = document.createElement('div');
            progressEl.className = 'list-files-progress';
            row.appendChild(progressEl);

            upload = { row, progressEl, timeout: null };
            this.uploads.set(fileName, upload);
            this.activeUploads++;

            // Insert at top of file list (rows container, not the scroll body,
            // so the row doesn't appear above the sticky header)
            if (this.rowsContainer) {
                this.rowsContainer.insertBefore(row, this.rowsContainer.firstChild);
            }
        }

        const { row, progressEl } = upload;
        const nameSpan = row.querySelector('.list-files-row-name');

        if (error) {
            this.uploads.delete(fileName);
            this.activeUploads--;
            progressEl.style.width = '100%';
            progressEl.classList.add('error');
            if (nameSpan) nameSpan.textContent = `${fileName}: ${message}`;
            if (!upload.timeout) {
                upload.timeout = window.setTimeout(() => {
                    row.remove();
                    this.loadDirectory(this.currentPath);
                }, REMOVE_ROW_TIMEOUT);
            }
        } else {
            if (nameSpan) nameSpan.textContent = `${fileName}: ${message}`;
            progressEl.style.width = `${progress}%`;
        }

        if (finished && !error) {
            this.uploads.delete(fileName);
            this.activeUploads--;
            // Debounce reload — multiple files finishing rapidly should trigger one reload
            if (this.reloadTimeout) clearTimeout(this.reloadTimeout);
            this.reloadTimeout = window.setTimeout(() => {
                this.reloadTimeout = undefined;
                this.loadDirectory(this.currentPath);
            }, 500);
        }
    }

    public onError(error: string | Error): void {
        console.error(TAG, 'upload error:', error);
    }

    // ── Delete ──

    private deleteSelected(): void {
        const paths = Array.from(this.selectedPaths);
        if (paths.length === 0) return;
        const count = paths.length;
        if (!confirm(`delete ${count} item${count > 1 ? 's' : ''}?`)) return;
        this.deleteFiles(paths);
    }

    private async deleteFiles(paths: string[]): Promise<void> {
        try {
            const resp = await fetch('/api/devices/files/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ udid: this.udid, paths }),
            });
            const result = await resp.json();
            if (!result.success && result.errors) {
                const errorMsg = result.errors.join('\n');
                console.error(TAG, 'delete errors:', errorMsg);
                // Show error briefly in footer
                const infoEl = this.getFooterInfo();
                if (infoEl) {
                    infoEl.textContent = `delete failed: ${result.errors[0]}`;
                    setTimeout(() => this.updateFooterInfo(), 10000);
                }
            }
        } catch (err) {
            console.error(TAG, 'delete request failed:', err);
            const infoEl2 = this.getFooterInfo();
            if (infoEl2) {
                infoEl2.textContent = 'delete request failed';
                setTimeout(() => this.updateFooterInfo(), 10000);
            }
        }
        // Reload current directory
        this.loadDirectory(this.currentPath);
    }
}
