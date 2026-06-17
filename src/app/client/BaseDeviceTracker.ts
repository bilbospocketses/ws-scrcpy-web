import type { EventMap } from '../../common/TypedEmitter';
import { DeviceState } from '../../common/DeviceState';
import type { BaseDeviceDescriptor } from '../../types/BaseDeviceDescriptor';
import type { HostItem } from '../../types/Configuration';
import type { DeviceTrackerEvent } from '../../types/DeviceTrackerEvent';
import type { DeviceTrackerEventList } from '../../types/DeviceTrackerEventList';
import type { Message } from '../../types/Message';
import type { ParamsDeviceTracker } from '../../types/ParamsDeviceTracker';
import Util from '../Util';
import { html } from '../ui/HtmlTag';
import { ManagerClient } from './ManagerClient';
import type { Tool } from './Tool';

const TAG = '[BaseDeviceTracker]';

export abstract class BaseDeviceTracker<DD extends BaseDeviceDescriptor, TE extends EventMap> extends ManagerClient<
    ParamsDeviceTracker,
    TE
> {
    public static readonly ACTION_LIST = 'devicelist';
    public static readonly ACTION_DEVICE = 'device';
    public static readonly HOLDER_ELEMENT_ID = 'devices';
    public static readonly AttributePrefixInterfaceSelectFor = 'interface_select_for_';
    public static readonly AttributePlayerFullName = 'data-player-full-name';
    public static readonly AttributePlayerCodeName = 'data-player-code-name';
    public static readonly AttributePrefixPlayerFor = 'player_for_';
    protected static tools: Set<Tool> = new Set();
    protected static instanceId = 0;

    public static registerTool(tool: Tool): void {
        this.tools.add(tool);
    }

    public static buildUrl(item: {
        secure: boolean;
        hostname: string;
        port: number;
        pathname?: string | undefined;
    }): URL {
        const { secure, port, hostname } = item;
        const pathname = item.pathname ?? '/';
        const protocol = secure ? 'wss:' : 'ws:';
        const url = new URL(`${protocol}//${hostname}${pathname}`);
        if (port) {
            url.port = port.toString();
        }
        return url;
    }

    public static buildUrlForTracker(params: HostItem): URL {
        const wsUrl = this.buildUrl(params);
        wsUrl.searchParams.set('action', this.ACTION);
        return wsUrl;
    }

    public static buildLink(q: any, text: string, params: ParamsDeviceTracker): HTMLAnchorElement {
        let { hostname } = params;
        let port: string | number | undefined = params.port;
        let pathname = params.pathname ?? location.pathname;
        let protocol = params.secure ? 'https:' : 'http:';
        if (params.useProxy) {
            q.hostname = hostname;
            q.port = port;
            q.pathname = pathname;
            q.secure = params.secure;
            q.useProxy = true;
            protocol = location.protocol;
            hostname = location.hostname;
            port = location.port;
            pathname = location.pathname;
        }
        const hash = `#!${new URLSearchParams(q).toString()}`;
        const a = document.createElement('a');
        a.setAttribute('href', `${protocol}//${hostname}:${port}${pathname}${hash}`);
        a.setAttribute('rel', 'noopener noreferrer');
        a.setAttribute('target', '_blank');
        a.classList.add(`link-${q.action}`);
        a.innerText = text;
        return a;
    }

    protected tableId = 'base_device_list';
    protected descriptors: DD[] = [];
    protected elementId: string;
    protected trackerName = '';
    protected id = '';
    private created = false;
    private messageId = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    // §34: tracks the last-rendered serialized descriptor per udid so a refresh
    // can skip rebuilding rows whose descriptor is unchanged (diff/patch instead
    // of clear-and-rebuild). Cleared on destroy with the row nodes.
    private lastRenderedByUdid: Map<string, string> = new Map();
    // §34: coalescing guard for the now-async refresh. `refreshing` = a refresh
    // is in flight; `refreshPending` = at least one more refresh was requested
    // while it ran (collapsed into a single re-run).
    private refreshing = false;
    private refreshPending = false;

    protected constructor(
        params: ParamsDeviceTracker,
        protected readonly directUrl: string,
    ) {
        super(params);
        this.elementId = `tracker_instance${++BaseDeviceTracker.instanceId}`;
        this.trackerName = `Unavailable. Host: ${params.hostname}, type: ${params.type}`;
        this.setBodyClass('list');
    }

    public static override parseParameters(params: URLSearchParams): ParamsDeviceTracker {
        const typedParams = super.parseParameters(params);
        const type = Util.parseString(params, 'type', true);
        if (type !== 'android') {
            throw Error('Incorrect type');
        }
        return { ...typedParams, type };
    }

    protected getNextId(): number {
        return ++this.messageId;
    }

    /**
     * §34: fire-and-forget entry point kept for the many synchronous callers
     * (constructors, onSocketMessage). Delegates to the async diff/patch
     * refresh, which fetches per-refresh row context (e.g. the device-label map)
     * exactly once instead of once per row.
     */
    protected buildDeviceTable(): void {
        void this.refreshDeviceTable();
    }

    /**
     * §34: coalescing wrapper. refreshDeviceTable is async (it awaits the
     * per-refresh row-context fetch), so rapid WS messages could otherwise
     * interleave two diff passes over the same DOM. If a refresh is already in
     * flight, mark a re-run pending and return; the in-flight pass loops once
     * more after it finishes, capturing the latest descriptors. At most one
     * extra pass runs no matter how many refreshes pile up while one is active.
     */
    protected async refreshDeviceTable(): Promise<void> {
        if (this.refreshing) {
            this.refreshPending = true;
            return;
        }
        this.refreshing = true;
        try {
            do {
                this.refreshPending = false;
                await this.doRefreshDeviceTable();
            } while (this.refreshPending);
        } finally {
            this.refreshing = false;
        }
    }

    /**
     * §34: build the device list by DIFFING the existing DOM rows (keyed by
     * udid via data-udid) against this.descriptors rather than tearing the whole
     * block down and rebuilding every row on every WebSocket message:
     *  - rows for new udids are built and appended,
     *  - rows for gone udids are removed,
     *  - rows whose descriptor is unchanged are left as the SAME node
     *    (preserves scroll/focus and avoids a per-message rebuild storm),
     *  - changed rows are rebuilt in place,
     *  - finally the surviving/new rows are reordered to match descriptor order.
     *
     * Row context (the label map) is fetched ONCE here and passed into each
     * buildDeviceRow call — eliminating the prior per-row /api/devices/labels
     * request storm.
     */
    private async doRefreshDeviceTable(): Promise<void> {
        const data = this.descriptors;
        const devices = this.getOrCreateTableHolder();
        const tbody = this.getOrBuildTableBody(devices);
        const block = this.getTrackerBlock(tbody);
        this.setNameValue(block, this.trackerName);

        const context = await this.fetchRowContext();

        if (data.length === 0) {
            this.removeAllDeviceRows(block);
            this.lastRenderedByUdid.clear();
            if (!block.querySelector('.empty-state-card')) {
                const empty = document.createElement('div');
                empty.className = 'empty-state-card';
                empty.textContent = 'No devices connected.';
                block.appendChild(empty);
            }
            return;
        }

        // Devices present — drop any empty-state card.
        block.querySelector('.empty-state-card')?.remove();

        const desiredUdids = new Set(data.map((d) => d.udid));

        // Remove rows for devices that are gone.
        this.getDeviceRows(block).forEach((el) => {
            const udid = el.getAttribute('data-udid');
            if (udid !== null && !desiredUdids.has(udid)) {
                el.remove();
                this.lastRenderedByUdid.delete(udid);
            }
        });

        // Add new rows / rebuild changed rows. New nodes are appended to the end
        // of the block by buildDeviceRow; we reorder afterwards.
        for (const device of data) {
            const udid = device.udid;
            const serialized = BaseDeviceTracker.serializeDescriptor(device);
            const existing = this.getDeviceRow(block, udid);
            if (existing && this.lastRenderedByUdid.get(udid) === serialized) {
                continue; // unchanged — keep the existing node
            }
            const newRow = this.buildAndTagRow(block, device, udid, context);
            if (existing && newRow) {
                existing.replaceWith(newRow);
            } else if (existing && !newRow) {
                // buildDeviceRow produced nothing (defensive) — drop stale node.
                existing.remove();
            }
            this.lastRenderedByUdid.set(udid, serialized);
        }

        // Reorder surviving device rows to match descriptor order. appendChild
        // MOVES existing nodes (preserving identity), so unchanged rows keep
        // their node while ending up in the right position.
        for (const device of data) {
            const row = this.getDeviceRow(block, device.udid);
            if (row) {
                block.appendChild(row);
            }
        }
    }

    /**
     * §34: per-refresh context passed to buildDeviceRow. Default: none.
     * DeviceTracker overrides this to fetch the device-label map a single time
     * for the whole refresh.
     */
    protected fetchRowContext(): Promise<unknown> {
        return Promise.resolve(undefined);
    }

    /**
     * §34: invoke the subclass row builder (which appends its row to `block`),
     * then capture and tag that row with data-udid so the diff can find it next
     * refresh. Returns the tagged row, or undefined if no row was appended.
     */
    private buildAndTagRow(block: Element, device: DD, udid: string, context: unknown): Element | undefined {
        const before = block.lastElementChild;
        this.buildDeviceRow(block, device, context);
        const appended = block.lastElementChild;
        if (!appended || appended === before) {
            return undefined;
        }
        appended.setAttribute('data-udid', udid);
        return appended;
    }

    private getDeviceRows(block: Element): Element[] {
        return Array.from(block.querySelectorAll('[data-udid]'));
    }

    private getDeviceRow(block: Element, udid: string): Element | null {
        // Match by attribute selector. udids can contain ':' and other chars, so
        // escape the quote/backslash that would break the selector string. (We
        // avoid the global CSS.escape since it isn't present in every test env.)
        const escaped = udid.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return block.querySelector(`[data-udid="${escaped}"]`);
    }

    private removeAllDeviceRows(block: Element): void {
        this.getDeviceRows(block).forEach((el) => el.remove());
    }

    private static serializeDescriptor(device: BaseDeviceDescriptor): string {
        // Stable-enough change key: JSON with sorted keys so property order
        // can't cause spurious rebuilds.
        const source = device as unknown as Record<string, unknown>;
        const keys = Object.keys(source).sort();
        const ordered: Record<string, unknown> = {};
        for (const k of keys) {
            ordered[k] = source[k];
        }
        return JSON.stringify(ordered);
    }

    private setNameValue(parent: Element | null, name: string): void {
        if (!parent) {
            return;
        }
        const nameBlockId = `${this.elementId}_name`;
        let nameEl = document.getElementById(nameBlockId);
        if (!nameEl) {
            nameEl = document.createElement('div');
            nameEl.id = nameBlockId;
            nameEl.className = 'tracker-name';
        }
        nameEl.innerText = name;
        parent.insertBefore(nameEl, parent.firstChild);
    }

    /**
     * §34: get-or-create the tracker block WITHOUT clearing its children — the
     * diff/patch refresh manages row lifecycle itself. (Previously this cleared
     * all children on every call, forcing a full rebuild.)
     */
    private getTrackerBlock(parent: Element): Element {
        let el = document.getElementById(this.elementId);
        if (!el) {
            el = document.createElement('div');
            el.id = this.elementId;
            parent.appendChild(el);
            this.created = true;
        }
        return el;
    }

    /**
     * @param tbody   the tracker block the row should be appended to
     * @param device  the descriptor to render
     * @param context §34 per-refresh context (e.g. the device-label map),
     *                fetched once by refreshDeviceTable. Optional so existing
     *                callers/overrides compile; DeviceTracker uses it.
     */
    protected abstract buildDeviceRow(tbody: Element, device: DD, context?: unknown): void;

    protected onSocketClose(event: CloseEvent): void {
        if (this.destroyed) {
            return;
        }
        console.log(TAG, `Connection closed: ${event.reason}`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            // Re-check destroyed: destroy() may have run between scheduling and
            // firing (e.g. the user navigated away during the 2s window).
            if (this.destroyed) {
                return;
            }
            this.openNewConnection();
        }, 2000);
    }

    protected onSocketMessage(event: MessageEvent): void {
        let message: Message;
        try {
            message = JSON.parse(event.data);
        } catch (error: any) {
            console.error(TAG, error.message);
            console.log(TAG, error.data);
            return;
        }
        switch (message.type) {
            case BaseDeviceTracker.ACTION_LIST: {
                const event = message.data as DeviceTrackerEventList<DD>;
                this.descriptors = event.list;
                this.setIdAndHostName(event.id, event.name);
                this.buildDeviceTable();
                break;
            }
            case BaseDeviceTracker.ACTION_DEVICE: {
                const event = message.data as DeviceTrackerEvent<DD>;
                this.setIdAndHostName(event.id, event.name);
                this.updateDescriptor(event.device);
                this.buildDeviceTable();
                break;
            }
            default:
                console.log(TAG, `Unknown message type: ${message.type}`);
        }
    }

    protected setIdAndHostName(id: string, trackerName: string): void {
        if (this.id === id && this.trackerName === trackerName) {
            return;
        }
        this.id = id;
        this.trackerName = trackerName;
        this.setNameValue(document.getElementById(this.elementId), trackerName);
    }

    protected getOrCreateTableHolder(): HTMLElement {
        const id = BaseDeviceTracker.HOLDER_ELEMENT_ID;
        let devices = document.getElementById(id);
        if (!devices) {
            devices = document.createElement('div');
            devices.id = id;
            devices.className = 'table-wrapper';
            document.body.appendChild(devices);
        }
        return devices;
    }

    protected updateDescriptor(descriptor: DD): void {
        const idx = this.descriptors.findIndex((item: DD) => {
            return item.udid === descriptor.udid;
        });
        if (descriptor.state === DeviceState.DISCONNECTED) {
            if (idx !== -1) {
                this.descriptors.splice(idx, 1);
            }
            return;
        }
        if (idx !== -1) {
            this.descriptors[idx] = descriptor;
        } else {
            this.descriptors.push(descriptor);
        }
    }

    protected getOrBuildTableBody(parent: HTMLElement): Element {
        const className = 'device-list';
        let tbody = document.querySelector(
            `#${BaseDeviceTracker.HOLDER_ELEMENT_ID} #${this.tableId}.${className}`,
        ) as Element;
        if (!tbody) {
            const fragment = html`<div id="${this.tableId}" class="${className}"></div>`.content;
            parent.appendChild(fragment);
            const last = parent.children.item(parent.children.length - 1);
            if (last) {
                tbody = last;
            }
        }
        return tbody;
    }

    public getDescriptorByUdid(udid: string): DD | undefined {
        if (!this.descriptors.length) {
            return;
        }
        return this.descriptors.find((descriptor: DD) => {
            return descriptor.udid === udid;
        });
    }

    public override destroy(): void {
        super.destroy();
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.lastRenderedByUdid.clear();
        if (this.created) {
            const el = document.getElementById(this.elementId);
            if (el) {
                const { parentElement } = el;
                el.remove();
                if (parentElement && !parentElement.children.length) {
                    parentElement.remove();
                }
            }
        }
        const holder = document.getElementById(BaseDeviceTracker.HOLDER_ELEMENT_ID);
        if (holder && !holder.children.length) {
            holder.remove();
        }
    }

    protected override supportMultiplexing(): boolean {
        return true;
    }

    protected getChannelCode(): string {
        throw Error('Not implemented. Must override');
    }

    protected override getChannelInitData(): Uint8Array {
        return new TextEncoder().encode(this.getChannelCode());
    }
}
