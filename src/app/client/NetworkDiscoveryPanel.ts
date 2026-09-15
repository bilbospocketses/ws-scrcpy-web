// src/app/client/NetworkDiscoveryPanel.ts

import type { PairingState, PairingStatus } from '../../common/PairingStatus';
import { SCAN_WS_PATH, type ScanServerMessage } from '../../common/ScanMessage';
import { ScanNetworkModal } from './ScanNetworkModal';
import { ScanProgressChip } from './ScanProgressChip';

interface ConnectResult {
    success: boolean;
    message: string;
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * What to show on a scan card's top line: the live name if the probe produced
 * one, else the model remembered from a previous sighting, else nothing (an
 * empty top line is hidden by CSS via .discovery-card-name:empty).
 */
export function scanHitDisplayName(hit: { name?: string | undefined; model?: string | undefined }): string {
    return hit.name || hit.model || '';
}

// ---------------------------------------------------------------------------
// Wireless pairing
//
// The browser drives a pairing session entirely through `/api/devices/pair/*`.
// It never sees the pairing password: the QR route renders the payload to markup
// server-side and returns only the markup, and `PairingStatus` has no field that
// could carry the secret in any state. Nothing here reconstructs it.
// ---------------------------------------------------------------------------

/** How often the browser polls a live pairing session, matching the server's own cadence. */
const PAIR_POLL_INTERVAL_MS = 1_000;

/**
 * The states a session never leaves.
 *
 * `expired` is one of them. Expiry applies ONLY while a session is
 * `awaiting-scan` — the TTL bounds the window in which a human can scan, because
 * the phone advertises its pairing service only while its pairing screen is
 * open — so a session that has reached `pairing` or `connecting` never reports
 * it. There is no expired→paired flip to defend against, which is why the client
 * may stop polling and offer a restart the moment it sees one.
 */
const TERMINAL_PAIRING_STATES: readonly PairingState[] = ['paired', 'paired-not-connected', 'failed', 'expired'];

export function isTerminalPairingState(state: PairingState): boolean {
    return TERMINAL_PAIRING_STATES.includes(state);
}

/**
 * The copy for one pairing state, plus the action (if any) the user should be
 * offered next. Pure on purpose: the interesting judgements — that
 * `paired-not-connected` is a partial success and that `expired` is recoverable
 * — are then assertable without any DOM or timer choreography.
 */
export function pairingStatusText(status: PairingStatus): { text: string; action?: 'connect' | 'restart' } {
    switch (status.state) {
        case 'awaiting-scan':
            return { text: 'Scan this code on the phone: Wireless debugging → Pair device with QR code.' };
        case 'pairing':
            return { text: 'Pairing…' };
        case 'connecting':
            return { text: 'Paired. Connecting…' };
        case 'paired':
            return { text: 'Paired and connected.' };
        case 'paired-not-connected':
            // Deliberately NOT phrased as a failure, and deliberately not styled
            // as one either. The pairing is durable and survives; only the
            // auto-connect leg fell short. Calling this "failed" makes the user
            // re-pair a device the server already trusts.
            return {
                text: `Paired, but not connected yet — ${status.message ?? 'no connect service found'}.`,
                action: 'connect',
            };
        case 'expired':
            return { text: 'The pairing window closed. Start again to get a fresh code.', action: 'restart' };
        case 'failed':
            return { text: status.message ?? 'Pairing failed.', action: 'restart' };
        default: {
            // Unreachable for a known state; the `never` binding makes adding a
            // state to PairingState a compile error here rather than a silent
            // `undefined` at runtime if the server ever ships one we predate.
            const unhandled: never = status.state;
            return { text: `Pairing reported an unknown state (${String(unhandled)}).`, action: 'restart' };
        }
    }
}

export interface PairingSectionDeps {
    fetchFn: typeof fetch;
    /** A session reached `paired`. The device tracker picks the device up over its own socket; this is for the surrounding UI. */
    onPaired?: (status: PairingStatus) => void;
    /** The user took the Connect action but the server never learned an address, so it has to be done by hand. */
    onConnectByHand?: (status: PairingStatus) => void;
}

/** One pairing session as the browser tracks it. */
interface PairingSession {
    id: string;
    mode: 'qr' | 'code';
    /** Bumped whenever a new session starts, so a late response for an old one is discarded. */
    generation: number;
    /** The user cancelled it — a 404 from the status route is now the CONFIRMATION, not an error. */
    cancelled: boolean;
    /** It reached a terminal state, so there is nothing left to cancel. */
    settled: boolean;
}

/**
 * Builds the "Pair a new device" section: a QR mode and a typed-pairing-code
 * mode, a status line, and at most one follow-up action.
 */
export function renderPairingSection(deps: PairingSectionDeps): HTMLElement {
    const section = document.createElement('div');
    section.className = 'discovery-pairing';
    // Static markup — nothing here is interpolated from input.
    section.innerHTML = `
        <div class="discovery-pairing-header">
            <span class="discovery-pairing-title">Pair a new device</span>
            <div class="discovery-pairing-modes">
                <button class="dep-btn" data-pair-mode="qr" aria-pressed="false">scan QR code</button>
                <button class="dep-btn" data-pair-mode="code" aria-pressed="false">pairing code</button>
                <button class="dep-btn discovery-pairing-cancel" data-pair-cancel>cancel</button>
            </div>
        </div>
        <div class="discovery-pairing-qr" data-pair-qr></div>
        <div class="discovery-pairing-code" data-pair-code-form>
            <input type="text" data-pair-address placeholder="192.168.86.190:41415" autocomplete="off" spellcheck="false" aria-label="pairing address shown on the phone" />
            <input type="text" data-pair-code placeholder="123456" inputmode="numeric" maxlength="10" autocomplete="off" spellcheck="false" aria-label="pairing code shown on the phone" />
            <button class="dep-btn" data-pair-submit disabled>pair</button>
        </div>
        <div class="discovery-pairing-status" data-pair-status role="status"></div>
        <button class="dep-btn discovery-pairing-action" data-pair-action></button>
    `;

    const qrBtn = section.querySelector<HTMLButtonElement>('[data-pair-mode="qr"]')!;
    const codeBtn = section.querySelector<HTMLButtonElement>('[data-pair-mode="code"]')!;
    const cancelBtn = section.querySelector<HTMLButtonElement>('[data-pair-cancel]')!;
    const qrBox = section.querySelector<HTMLElement>('[data-pair-qr]')!;
    const codeForm = section.querySelector<HTMLElement>('[data-pair-code-form]')!;
    const addressInput = section.querySelector<HTMLInputElement>('[data-pair-address]')!;
    const codeInput = section.querySelector<HTMLInputElement>('[data-pair-code]')!;
    const submitBtn = section.querySelector<HTMLButtonElement>('[data-pair-submit]')!;
    const statusEl = section.querySelector<HTMLElement>('[data-pair-status]')!;
    const actionBtn = section.querySelector<HTMLButtonElement>('[data-pair-action]')!;
    qrBox.hidden = true;
    codeForm.hidden = true;
    cancelBtn.hidden = true;
    actionBtn.hidden = true;

    let generation = 0;
    let current: PairingSession | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pendingAction: { kind: 'connect' | 'restart'; status: PairingStatus } | null = null;

    /** True while `session` is the one the status line is speaking for. */
    function isCurrent(session: PairingSession): boolean {
        return current !== null && current.generation === session.generation;
    }

    function setStatus(text: string, kind: 'info' | 'error' | 'success' = 'info'): void {
        statusEl.textContent = text;
        statusEl.classList.toggle('error', kind === 'error');
        statusEl.classList.toggle('success', kind === 'success');
    }

    function showAction(kind: 'connect' | 'restart', status: PairingStatus): void {
        pendingAction = { kind, status };
        actionBtn.textContent = kind === 'connect' ? 'connect' : 'start again';
        actionBtn.hidden = false;
    }

    function hideAction(): void {
        pendingAction = null;
        actionBtn.hidden = true;
    }

    function stopPolling(): void {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
    }

    function clearQr(): void {
        qrBox.textContent = '';
        qrBox.hidden = true;
    }

    function schedulePoll(session: PairingSession): void {
        stopPolling();
        timer = setTimeout(() => {
            void poll(session);
        }, PAIR_POLL_INTERVAL_MS);
    }

    /** The server's own wording for a rejection, which is written to be read by a user. */
    async function serverError(res: Response, fallback: string): Promise<string> {
        if (res.status === 403) {
            // All four pairing routes are admin-gated, and deliberately stricter
            // than /api/devices/connect: pairing establishes a persistent trust
            // relationship with a NEW device on the whole server's behalf.
            return 'Pairing needs an admin account. Ask an administrator to pair this device.';
        }
        try {
            const body = (await res.json()) as { error?: unknown };
            if (typeof body.error === 'string' && body.error) {
                return body.error;
            }
        } catch {
            // Non-JSON body — fall through to the caller's wording.
        }
        return fallback;
    }

    /**
     * How long the code stays scannable, stated once rather than ticked down: a
     * poll surfaces `expired` within a second of it happening anyway.
     */
    function validityNote(expiresAt: unknown): string {
        if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
            return '';
        }
        const seconds = Math.round((expiresAt - Date.now()) / 1000);
        if (seconds <= 0) {
            return '';
        }
        return seconds < 90
            ? ` It stops working in about ${seconds} seconds.`
            : ` It stops working in about ${Math.round(seconds / 60)} minutes.`;
    }

    function render(status: PairingStatus): void {
        const { text, action } = pairingStatusText(status);
        // `paired-not-connected` is NOT styled as an error — see pairingStatusText.
        const kind = status.state === 'failed' ? 'error' : status.state === 'paired' ? 'success' : 'info';
        setStatus(text, kind);
        if (action) {
            showAction(action, status);
        } else {
            hideAction();
        }
        if (isTerminalPairingState(status.state)) {
            if (current) {
                current.settled = true;
            }
            cancelBtn.hidden = true;
            clearQr();
        }
        if (status.state === 'paired') {
            deps.onPaired?.(status);
        }
    }

    async function poll(session: PairingSession): Promise<void> {
        let res: Response;
        try {
            res = await deps.fetchFn(`/api/devices/pair/status?sessionId=${encodeURIComponent(session.id)}`);
        } catch {
            if (isCurrent(session)) {
                setStatus('Lost contact with the server while pairing.', 'error');
                showAction('restart', { state: 'failed' });
            }
            return;
        }

        if (res.status === 404) {
            // Cancelling drops the session server-side, so the very next status
            // poll is a miss — for a session WE cancelled, this 404 is the
            // confirmation that it is gone, not a failure. Telling the user
            // pairing broke because they stopped it themselves is a bug.
            if (session.cancelled) {
                if (isCurrent(session)) {
                    setStatus('Pairing cancelled.');
                    hideAction();
                }
                return;
            }
            if (isCurrent(session)) {
                cancelBtn.hidden = true;
                clearQr();
                setStatus('That pairing session is no longer available.', 'error');
                showAction('restart', { state: 'failed' });
            }
            return;
        }

        if (!res.ok) {
            const message = await serverError(res, 'Could not read the pairing status.');
            if (isCurrent(session)) {
                cancelBtn.hidden = true;
                clearQr();
                setStatus(message, 'error');
                showAction('restart', { state: 'failed' });
            }
            return;
        }

        const status = (await res.json()) as PairingStatus;
        if (!isCurrent(session)) {
            return;
        }
        render(status);
        // Stop here on a terminal state: nothing after it changes, so another
        // poll would only be noise.
        if (!isTerminalPairingState(status.state)) {
            schedulePoll(session);
        }
    }

    /** Tears down whatever is running and claims the next generation for a new session. */
    function beginSession(): number {
        stopPolling();
        hideAction();
        cancelBtn.hidden = true;
        current = null;
        return ++generation;
    }

    function cancelSession(): void {
        const session = current;
        stopPolling();
        cancelBtn.hidden = true;
        clearQr();
        hideAction();
        if (!session || session.settled || session.cancelled) {
            return;
        }
        session.cancelled = true;
        setStatus('Pairing cancelled.');
        void deps
            .fetchFn('/api/devices/pair/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: session.id }),
            })
            .catch(() => {
                // The route is idempotent and the session expires on its own;
                // there is nothing useful to tell the user here.
            });
    }

    async function startQr(): Promise<void> {
        const gen = beginSession();
        codeForm.hidden = true;
        qrBtn.setAttribute('aria-pressed', 'true');
        codeBtn.setAttribute('aria-pressed', 'false');
        clearQr();
        setStatus('Requesting a pairing code…');

        let res: Response;
        try {
            res = await deps.fetchFn('/api/devices/pair/qr', { method: 'POST' });
        } catch {
            if (gen === generation) setStatus('Could not reach the server to start pairing.', 'error');
            return;
        }
        if (gen !== generation) {
            return;
        }
        if (!res.ok) {
            setStatus(await serverError(res, 'Could not start a pairing session.'), 'error');
            return;
        }
        const body = (await res.json()) as { sessionId?: unknown; svg?: unknown; expiresAt?: unknown };
        if (gen !== generation) {
            return;
        }
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
        const svg = typeof body.svg === 'string' ? body.svg : '';
        if (!sessionId || !svg) {
            setStatus('The server did not return a pairing code.', 'error');
            return;
        }
        // SAFE HERE, AND ONLY HERE: `svg` comes from our own `encodeQrSvg`, which
        // emits a <rect> and a <path> built from a numeric module matrix and
        // never interpolates the payload text into the markup. Do not copy this
        // to markup from a source you do not control.
        qrBox.innerHTML = svg;
        qrBox.hidden = false;
        setStatus(pairingStatusText({ state: 'awaiting-scan' }).text + validityNote(body.expiresAt));
        current = { id: sessionId, mode: 'qr', generation: gen, cancelled: false, settled: false };
        cancelBtn.hidden = false;
        schedulePoll(current);
    }

    function syncSubmit(): void {
        submitBtn.disabled = addressInput.value.trim() === '' || codeInput.value.trim() === '';
    }

    function showCodeForm(): void {
        codeForm.hidden = false;
        qrBtn.setAttribute('aria-pressed', 'false');
        codeBtn.setAttribute('aria-pressed', 'true');
        syncSubmit();
    }

    async function submitCode(): Promise<void> {
        const address = addressInput.value.trim();
        const code = codeInput.value.trim();
        if (!address || !code) {
            return;
        }
        const gen = beginSession();
        clearQr();
        submitBtn.disabled = true;
        setStatus(pairingStatusText({ state: 'pairing' }).text);

        let res: Response;
        try {
            res = await deps.fetchFn('/api/devices/pair/code', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address, code }),
            });
        } catch {
            if (gen === generation) {
                setStatus('Could not reach the server to start pairing.', 'error');
                syncSubmit();
            }
            return;
        }
        if (gen !== generation) {
            return;
        }
        if (!res.ok) {
            // The server's 400s name which half is wrong and are written for a
            // user to read, so they beat any wording invented here. The address
            // and code shapes are checked there rather than duplicated into the
            // client, where the two copies would drift.
            setStatus(await serverError(res, 'Could not start a pairing session.'), 'error');
            syncSubmit();
            return;
        }
        const body = (await res.json()) as { sessionId?: unknown };
        if (gen !== generation) {
            return;
        }
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
        if (!sessionId) {
            setStatus('The server did not start a pairing session.', 'error');
            syncSubmit();
            return;
        }
        // The pairing code is single-use and is a secret while it lives: take it
        // off the screen the moment it has been spent.
        codeInput.value = '';
        syncSubmit();
        current = { id: sessionId, mode: 'code', generation: gen, cancelled: false, settled: false };
        cancelBtn.hidden = false;
        schedulePoll(current);
    }

    async function connectPaired(status: PairingStatus): Promise<void> {
        const address = status.address;
        if (!address) {
            // `paired-not-connected` without an address means the connect service
            // was never found. The pairing still stands; the user finishes it
            // with the address from the phone's wireless-debugging screen.
            setStatus(`${pairingStatusText(status).text} Use “manually add” with the address shown on the phone.`);
            hideAction();
            deps.onConnectByHand?.(status);
            return;
        }
        actionBtn.disabled = true;
        try {
            const res = await deps.fetchFn('/api/devices/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address, serial: status.serial }),
            });
            const result = (await res.json()) as { success?: unknown; message?: unknown };
            if (result.success === true) {
                setStatus(`Connected to ${address}.`, 'success');
                hideAction();
                deps.onPaired?.(status);
            } else {
                // Still not an error about the PAIRING — that survives either way.
                setStatus(
                    typeof result.message === 'string' && result.message
                        ? result.message
                        : `Paired, but could not connect to ${address}.`,
                    'error',
                );
            }
        } catch {
            setStatus(`Paired, but could not connect to ${address}.`, 'error');
        } finally {
            actionBtn.disabled = false;
        }
    }

    function restart(): void {
        const mode = current?.mode ?? 'qr';
        hideAction();
        if (mode === 'code') {
            beginSession();
            showCodeForm();
            codeInput.value = '';
            syncSubmit();
            setStatus('Enter the new pairing code shown on the phone.');
            codeInput.focus();
            return;
        }
        void startQr();
    }

    qrBtn.addEventListener('click', () => {
        cancelSession();
        void startQr();
    });
    codeBtn.addEventListener('click', () => {
        cancelSession();
        beginSession();
        clearQr();
        showCodeForm();
        setStatus('');
    });
    cancelBtn.addEventListener('click', () => cancelSession());
    submitBtn.addEventListener('click', () => void submitCode());
    actionBtn.addEventListener('click', () => {
        const pending = pendingAction;
        if (!pending) {
            return;
        }
        if (pending.kind === 'restart') {
            restart();
            return;
        }
        void connectPaired(pending.status);
    });
    for (const input of [addressInput, codeInput]) {
        input.addEventListener('input', syncSubmit);
        input.addEventListener('keydown', (e) => {
            if ((e as KeyboardEvent).key === 'Enter' && !submitBtn.disabled) void submitCode();
        });
    }

    return section;
}

export class NetworkDiscoveryPanel {
    private container: HTMLElement;
    private infoBox: HTMLElement;
    private resultsContainer: HTMLElement;
    private chip?: ScanProgressChip | undefined;
    private scanWs?: WebSocket | undefined;
    private scanSessionHits = new Map<string, HTMLElement>();
    private defaultInfoText = '';

    constructor() {
        this.container = document.createElement('div');
        this.container.id = 'discovery-panel';
        this.container.className = 'home-section';
        this.container.innerHTML = `
            <div class="discovery-header">
                <h2>Available Network Devices</h2>
                <div class="discovery-header-actions">
                    <button class="dep-btn discovery-quick-scan-btn" title="mDNS-only — finds modern Android devices with wireless debugging enabled">quick scan</button>
                    <button class="dep-btn discovery-scan-btn">scan network</button>
                    <button class="dep-btn discovery-manual-btn">manually add</button>
                </div>
            </div>
            <div class="discovery-manual-form" hidden>
                <input type="text" class="discovery-manual-address" placeholder="192.168.86.50" />
                <input type="text" class="discovery-manual-port" placeholder="5555" value="5555" />
                <input type="text" class="discovery-manual-label" placeholder="optional name" />
                <button class="dep-btn discovery-connect-btn discovery-manual-connect">connect</button>
                <button class="discovery-manual-close" aria-label="close" title="close">×</button>
                <div class="discovery-manual-result" hidden></div>
            </div>
            <div class="discovery-pairing-mount"></div>
            <div class="discovery-results"></div>
            <div class="empty-state-card discovery-info">Click quick scan for modern Android devices on your network, or scan network to probe a full subnet. Make sure wireless debugging is enabled on the devices you wish to connect with.</div>
        `;
        this.infoBox = this.container.querySelector('.discovery-info')!;
        this.defaultInfoText = this.infoBox.textContent ?? '';
        this.resultsContainer = this.container.querySelector('.discovery-results')!;
        this.container.querySelector('.discovery-scan-btn')!.addEventListener('click', () => this.scan());
        this.container.querySelector('.discovery-quick-scan-btn')!.addEventListener('click', () => this.quickScan());
        this.container.querySelector('.discovery-manual-btn')!.addEventListener('click', () => this.toggleManualForm());
        this.container
            .querySelector('.discovery-manual-close')!
            .addEventListener('click', () => this.toggleManualForm(false));
        this.container
            .querySelector('.discovery-manual-connect')!
            .addEventListener('click', () => this.manualConnect());
        for (const selector of ['.discovery-manual-address', '.discovery-manual-port', '.discovery-manual-label']) {
            const input = this.container.querySelector(selector) as HTMLInputElement;
            input.addEventListener('keydown', (e) => {
                if ((e as KeyboardEvent).key === 'Enter') this.manualConnect();
            });
        }

        // Pairing sits alongside the scan and manual-add controls: a scan can
        // only find a device that already trusts this server, so pairing is the
        // step that comes BEFORE the other two for a device it has never met.
        //
        // `fetch` is wrapped rather than passed by reference — an unbound
        // `fetch` throws "Illegal invocation" in Chrome.
        this.container.querySelector('.discovery-pairing-mount')!.appendChild(
            renderPairingSection({
                fetchFn: (...args: Parameters<typeof fetch>) => fetch(...args),
                // Nothing to refresh by hand: `adb connect` changes the device
                // list, and the tracker is already pushed that over its own
                // socket. What is left is to put the panel's own copy back.
                onPaired: () => this.restoreInfoText(),
                onConnectByHand: (status) => {
                    this.toggleManualForm(true);
                    const [ip = '', port = ''] = (status.address ?? '').split(':');
                    if (ip) (this.container.querySelector('.discovery-manual-address') as HTMLInputElement).value = ip;
                    if (port) (this.container.querySelector('.discovery-manual-port') as HTMLInputElement).value = port;
                },
            }),
        );
    }

    getElement(): HTMLElement {
        return this.container;
    }

    private setInfoText(text: string, error = false): void {
        this.infoBox.textContent = text;
        this.infoBox.style.color = error ? '#f87171' : '';
    }

    private restoreInfoText(): void {
        // If a scan error already swapped in error text, don't overwrite it on chip dismiss.
        if (this.infoBox.style.color === 'rgb(248, 113, 113)') return;
        this.infoBox.textContent = this.defaultInfoText;
        this.infoBox.style.color = '';
    }

    private async scan(): Promise<void> {
        // Fetch detected gateway subnet first
        let gateway: { cidr: string; hostCount: number } | null = null;
        try {
            const res = await fetch('/api/devices/scan/subnet');
            const detected = await res.json();
            if (detected?.cidr) {
                gateway = { cidr: detected.cidr, hostCount: detected.hostCount };
            }
        } catch {
            gateway = null;
        }

        new ScanNetworkModal({
            gatewaySubnet: gateway,
            onStartScan: (rawSubnets: string[]) => this.startScanWs(rawSubnets),
        });
    }

    private quickScan(): void {
        this.startScanWs([], { mdnsOnly: true });
    }

    private startScanWs(rawSubnets: string[], options: { mdnsOnly?: boolean } = {}): void {
        const mdnsOnly = options.mdnsOnly === true;

        // Clear the panel before a new scan (matches existing behavior)
        this.resultsContainer.innerHTML = '';
        this.scanSessionHits.clear();
        const grid = document.createElement('div');
        grid.className = 'discovery-grid';
        this.resultsContainer.appendChild(grid);

        // Full scan mounts the progress chip into the info box; quick scan uses lightweight inline status.
        this.chip?.dismiss();
        this.chip = undefined;
        this.infoBox.textContent = '';
        this.infoBox.style.color = '';
        if (mdnsOnly) {
            this.infoBox.textContent = 'scanning over mDNS…';
        } else {
            this.chip = new ScanProgressChip({
                parent: this.infoBox,
                onCancel: () => {
                    if (this.scanWs?.readyState === WebSocket.OPEN) {
                        this.scanWs.send(JSON.stringify({ type: 'scan.cancel' }));
                    }
                },
                onDismiss: () => this.restoreInfoText(),
            });
        }

        // Open the WS
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${proto}//${location.host}${SCAN_WS_PATH}`);
        this.scanWs = ws;

        ws.addEventListener('open', () => {
            const startMsg: { type: 'scan.start'; subnets: string[]; mdnsOnly?: boolean } = {
                type: 'scan.start',
                subnets: rawSubnets,
            };
            if (mdnsOnly) startMsg.mdnsOnly = true;
            ws.send(JSON.stringify(startMsg));
        });
        let terminalReceived = false;
        ws.addEventListener('message', (ev: MessageEvent) => {
            const msg: ScanServerMessage = JSON.parse(ev.data);
            if (msg.type === 'scan.complete' || msg.type === 'scan.cancelled' || msg.type === 'scan.error') {
                terminalReceived = true;
            }
            this.handleScanMessage(msg, grid, mdnsOnly);
        });
        ws.addEventListener('close', () => {
            this.scanWs = undefined;
            if (!terminalReceived) {
                this.setInfoText('Scan connection lost before completion.', true);
                this.chip?.dismiss();
            }
        });
        ws.addEventListener('error', () => {
            this.setInfoText('Scan connection failed.', true);
            this.chip?.dismiss();
        });
    }

    private handleScanMessage(msg: ScanServerMessage, grid: HTMLElement, mdnsOnly = false): void {
        switch (msg.type) {
            case 'scan.started':
                this.chip?.setScanning(0, msg.totalHosts, 0);
                break;
            case 'scan.progress':
                this.chip?.setScanning(msg.checked, msg.total, msg.foundSoFar);
                break;
            case 'scan.hit':
                this.renderHit(msg, grid);
                break;
            case 'scan.draining':
                this.chip?.setDraining();
                break;
            case 'scan.complete':
                if (mdnsOnly) {
                    if (msg.found === 0) {
                        this.setInfoText('No devices advertising over mDNS. Try scan network for a full subnet probe.');
                    } else {
                        this.restoreInfoText();
                    }
                } else {
                    this.chip?.setComplete(msg.found);
                }
                break;
            case 'scan.cancelled':
                this.chip?.setCancelled(msg.found);
                break;
            case 'scan.error':
                this.setInfoText(`Scan error: ${msg.reason}`, true);
                this.chip?.dismiss();
                break;
        }
    }

    private renderHit(
        hit: { address: string; serial: string; name: string; label: string; model?: string },
        grid: HTMLElement,
    ): void {
        if (this.scanSessionHits.has(hit.address)) return;
        const card = document.createElement('div');
        card.className = 'discovery-card';
        // Top line shows hit.name (adb-SERIAL for mDNS, the live handshake
        // banner for TCP), falling back to the model remembered from a previous
        // sighting. A device that answers the probe without a banner used to
        // render a blank top line even when the app knew perfectly well what it
        // was (finding 7.6).
        const displayName = scanHitDisplayName(hit);
        card.innerHTML = `
            <div class="discovery-card-info">
                <div class="discovery-card-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</div>
                <div class="discovery-card-address" title="${escapeHtml(hit.address)}">${escapeHtml(hit.address)}</div>
            </div>
            <div class="discovery-card-actions">
                <input type="text" class="discovery-name-input" placeholder="Name this device..." value="${escapeHtml(hit.label || '')}" />
                <button class="dep-btn discovery-connect-btn" data-address="${escapeHtml(hit.address)}" data-serial="${escapeHtml(hit.serial)}">connect</button>
                <button class="dep-btn discovery-dismiss-btn" aria-label="dismiss" title="dismiss">close</button>
            </div>
            <div class="discovery-card-result" hidden></div>
        `;
        card.querySelector('.discovery-connect-btn')!.addEventListener('click', () =>
            this.connectDevice(hit.address, hit.serial, card),
        );
        card.querySelector('.discovery-dismiss-btn')!.addEventListener('click', () => {
            this.scanSessionHits.delete(hit.address);
            card.remove();
        });
        grid.appendChild(card);
        this.scanSessionHits.set(hit.address, card);
    }

    private toggleManualForm(show?: boolean): void {
        const form = this.container.querySelector('.discovery-manual-form') as HTMLElement;
        const shouldShow = show !== undefined ? show : form.hasAttribute('hidden');
        if (shouldShow) {
            form.removeAttribute('hidden');
            (this.container.querySelector('.discovery-manual-address') as HTMLInputElement).focus();
        } else {
            form.setAttribute('hidden', '');
            this.clearManualForm();
        }
    }

    private clearManualForm(): void {
        (this.container.querySelector('.discovery-manual-address') as HTMLInputElement).value = '';
        (this.container.querySelector('.discovery-manual-port') as HTMLInputElement).value = '5555';
        (this.container.querySelector('.discovery-manual-label') as HTMLInputElement).value = '';
        const resultEl = this.container.querySelector('.discovery-manual-result') as HTMLElement;
        resultEl.setAttribute('hidden', '');
        resultEl.textContent = '';
        resultEl.classList.remove('error', 'success');
    }

    private showManualResult(text: string, kind: 'success' | 'error'): void {
        const resultEl = this.container.querySelector('.discovery-manual-result') as HTMLElement;
        resultEl.textContent = text;
        resultEl.classList.toggle('success', kind === 'success');
        resultEl.classList.toggle('error', kind === 'error');
        resultEl.removeAttribute('hidden');
    }

    private async manualConnect(): Promise<void> {
        const addressInput = this.container.querySelector('.discovery-manual-address') as HTMLInputElement;
        const portInput = this.container.querySelector('.discovery-manual-port') as HTMLInputElement;
        const labelInput = this.container.querySelector('.discovery-manual-label') as HTMLInputElement;
        const btn = this.container.querySelector('.discovery-manual-connect') as HTMLButtonElement;

        const ip = addressInput.value.trim();
        const port = portInput.value.trim() || '5555';
        const label = labelInput.value.trim();

        if (!ip) {
            this.showManualResult('Address is required', 'error');
            addressInput.focus();
            return;
        }

        const address = `${ip}:${port}`;
        btn.disabled = true;
        btn.textContent = 'Connecting...';
        const resultEl = this.container.querySelector('.discovery-manual-result') as HTMLElement;
        resultEl.setAttribute('hidden', '');
        resultEl.textContent = '';
        resultEl.classList.remove('error', 'success');
        // §25b — using-declaration replaces the prior try/finally restoring
        // the manual-connect button. Captures `btn`.
        using _restoreBtn = {
            [Symbol.dispose](): void {
                btn.disabled = false;
                btn.textContent = 'connect';
            },
        };

        try {
            const res = await fetch('/api/devices/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address, label: label || undefined }),
            });
            const result: ConnectResult = await res.json();
            if (result.success) {
                this.showManualResult(`Connected to ${address}`, 'success');
                setTimeout(() => this.toggleManualForm(false), 2000);
            } else {
                this.showManualResult(result.message || `Failed to connect to ${address}`, 'error');
            }
        } catch (err: any) {
            this.showManualResult(err?.message || 'Request failed', 'error');
        }
    }

    private async connectDevice(address: string, serial: string, card: HTMLElement): Promise<void> {
        const btn = card.querySelector('.discovery-connect-btn') as HTMLButtonElement;
        const nameInput = card.querySelector('.discovery-name-input') as HTMLInputElement;
        const resultEl = card.querySelector('.discovery-card-result') as HTMLElement;
        const label = nameInput.value.trim();

        btn.disabled = true;
        resultEl.setAttribute('hidden', '');
        resultEl.textContent = '';
        resultEl.classList.remove('error', 'success');

        try {
            const res = await fetch('/api/devices/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address, serial, label: label || undefined }),
            });
            const result: ConnectResult = await res.json();
            if (result.success) {
                setTimeout(() => card.remove(), 1500);
            } else {
                btn.disabled = false;
                this.showCardResult(resultEl, result.message || `Failed to connect to ${address}`, 'error');
            }
        } catch (err: any) {
            btn.disabled = false;
            this.showCardResult(resultEl, err?.message || 'Request failed', 'error');
        }
    }

    private showCardResult(resultEl: HTMLElement, text: string, kind: 'success' | 'error'): void {
        resultEl.textContent = text;
        resultEl.classList.toggle('success', kind === 'success');
        resultEl.classList.toggle('error', kind === 'error');
        resultEl.removeAttribute('hidden');
    }
}
