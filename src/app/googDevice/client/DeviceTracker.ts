import '../../../style/devicelist.css';
import { ACTION } from '../../../common/Action';
import { ChannelCode } from '../../../common/ChannelCode';
import { SERVER_PORT } from '../../../common/Constants';
import { DeviceState } from '../../../common/DeviceState';
import type { HostItem } from '../../../types/Configuration';
import type GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import type { ParamsDeviceTracker } from '../../../types/ParamsDeviceTracker';
import { BaseDeviceTracker } from '../../client/BaseDeviceTracker';
import type { Tool } from '../../client/Tool';
import Util from '../../Util';
import { html } from '../../ui/HtmlTag';
import { StreamClientScrcpy } from './StreamClientScrcpy';


export class DeviceTracker extends BaseDeviceTracker<GoogDeviceDescriptor, never> {
    public static readonly ACTION = ACTION.GOOG_DEVICE_LIST;
    public static readonly CREATE_DIRECT_LINKS = true;
    private static instancesByUrl: Map<string, DeviceTracker> = new Map();
    protected static tools: Set<Tool> = new Set();
    protected tableId = 'goog_device_list';

    public static start(hostItem: HostItem): DeviceTracker {
        const url = this.buildUrlForTracker(hostItem).toString();
        let instance = this.instancesByUrl.get(url);
        if (!instance) {
            instance = new DeviceTracker(hostItem, url);
        }
        return instance;
    }

    public static getInstance(hostItem: HostItem): DeviceTracker {
        return this.start(hostItem);
    }

    protected constructor(params: HostItem, directUrl: string) {
        super({ ...params, action: DeviceTracker.ACTION }, directUrl);
        DeviceTracker.instancesByUrl.set(directUrl, this);
        this.buildDeviceTable();
        this.openNewConnection();
    }

    protected onSocketOpen(): void {
        // nothing here;
    }

    protected setIdAndHostName(id: string, hostName: string): void {
        super.setIdAndHostName(id, hostName);
        for (const value of DeviceTracker.instancesByUrl.values()) {
            if (value.id === id && value !== this) {
                console.warn(
                    `Tracker with url: "${this.url}" has the same id(${this.id}) as tracker with url "${value.url}"`,
                );
                console.warn('This tracker will shut down');
                this.destroy();
            }
        }
    }

    private updateLink(params: { url: string; name: string; fullName: string; udid: string; store: boolean }): void {
        const { url, name, fullName, udid, store } = params;
        const playerTds = document.getElementsByName(
            encodeURIComponent(`${DeviceTracker.AttributePrefixPlayerFor}${fullName}`),
        );
        if (typeof udid !== 'string') {
            return;
        }
        if (store) {
            const localStorageKey = DeviceTracker.getLocalStorageKey(fullName || '');
            if (localStorage && name) {
                localStorage.setItem(localStorageKey, name);
            }
        }
        const action = ACTION.STREAM_SCRCPY;
        playerTds.forEach((item) => {
            item.innerHTML = '';
            const playerFullName = item.getAttribute(DeviceTracker.AttributePlayerFullName);
            const playerCodeName = item.getAttribute(DeviceTracker.AttributePlayerCodeName);
            if (!playerFullName || !playerCodeName) {
                return;
            }
            const link = DeviceTracker.buildLink(
                {
                    action,
                    udid,
                    player: decodeURIComponent(playerCodeName),
                    ws: url,
                },
                decodeURIComponent(playerFullName),
                this.params,
            );
            item.appendChild(link);
        });
    }

    protected static createUrl(params: ParamsDeviceTracker, udid = ''): URL {
        const secure = !!params.secure;
        const hostname = params.hostname || location.hostname;
        const port = typeof params.port === 'number' ? params.port : secure ? 443 : 80;
        const pathname = params.pathname || location.pathname;
        const urlObject = this.buildUrl({ ...params, secure, hostname, port, pathname });
        if (udid) {
            urlObject.searchParams.set('action', ACTION.PROXY_ADB);
            urlObject.searchParams.set('remote', `tcp:${SERVER_PORT.toString(10)}`);
            urlObject.searchParams.set('udid', udid);
        }
        return urlObject;
    }

    protected buildDeviceRow(tbody: Element, device: GoogDeviceDescriptor): void {
        const fullName = `${this.id}_${Util.escapeUdid(device.udid)}`;
        const isActive = device.state === DeviceState.DEVICE;
        const servicesId = `device_services_${fullName}`;
        const deviceName = device['ro.product.model']?.startsWith(device['ro.product.manufacturer'])
            ? device['ro.product.model']
            : `${device['ro.product.manufacturer']} ${device['ro.product.model']}`;

        const row = html`<div class="device ${isActive ? 'active' : 'not-active'}">
            <table class="device-info">
                <tr><td class="device-label">Model</td><td>${deviceName}</td></tr>
                <tr><td class="device-label">Device ID</td><td class="device-serial">${device.udid}</td></tr>
                <tr><td class="device-label">Android</td><td>${device['ro.build.version.release']}</td></tr>
                <tr><td class="device-label">SDK</td><td>${device['ro.build.version.sdk']}</td></tr>
            </table>
            <div id="${servicesId}" class="services">
                <div class="services-label">Opens in new tab</div>
            </div>
        </div>`.content;
        const services = row.getElementById(servicesId);
        if (!services) {
            return;
        }

        // Auto-select best interface: prefer wifi/direct IP, fallback to proxy
        let selectedInterfaceUrl = '';
        let selectedInterfaceName = '';
        if (isActive) {
            const wifiInterface = device.interfaces.find((i) => i.name === device['wifi.interface']);
            const firstInterface = device.interfaces[0];
            const bestInterface = wifiInterface || firstInterface;
            if (bestInterface) {
                const params = {
                    ...this.params,
                    secure: false,
                    hostname: bestInterface.ipv4,
                    port: SERVER_PORT,
                };
                selectedInterfaceUrl = DeviceTracker.createUrl(params).toString();
                selectedInterfaceName = bestInterface.name;
            }
            if (!selectedInterfaceUrl) {
                selectedInterfaceUrl = DeviceTracker.createUrl(this.params, device.udid).toString();
                selectedInterfaceName = 'proxy';
            }
        }

        // Add Connect button (replaces WebCodecs link) — opens stream in new tab
        if (isActive && DeviceTracker.CREATE_DIRECT_LINKS) {
            const name = `${DeviceTracker.AttributePrefixPlayerFor}${fullName}`;
            StreamClientScrcpy.getPlayers().forEach((playerClass) => {
                const { playerCodeName, playerFullName } = playerClass;
                const connectBtn = document.createElement('div');
                connectBtn.classList.add('desc-block');
                connectBtn.setAttribute('name', encodeURIComponent(name));
                connectBtn.setAttribute(DeviceTracker.AttributePlayerFullName, encodeURIComponent(playerFullName));
                connectBtn.setAttribute(DeviceTracker.AttributePlayerCodeName, encodeURIComponent(playerCodeName));
                services.appendChild(connectBtn);
            });
        }

        // Add Configure Stream button
        const streamEntry = StreamClientScrcpy.createEntryForDeviceList(device, 'desc-block', fullName, this.params);
        streamEntry && services.appendChild(streamEntry);

        // Add Shell and Files buttons (from registered tools)
        DeviceTracker.tools.forEach((tool) => {
            const entry = tool.createEntryForDeviceList(device, 'desc-block', this.params);
            if (entry) {
                if (Array.isArray(entry)) {
                    entry.forEach((item) => {
                        item && services.appendChild(item);
                    });
                } else {
                    services.appendChild(entry);
                }
            }
        });

        tbody.appendChild(row);

        // Populate connect link with auto-selected interface
        if (DeviceTracker.CREATE_DIRECT_LINKS && isActive && selectedInterfaceUrl) {
            this.updateLink({
                url: selectedInterfaceUrl,
                name: selectedInterfaceName,
                fullName,
                udid: device.udid,
                store: false,
            });
        }
    }

    protected getChannelCode(): string {
        return ChannelCode.GTRC;
    }

    public destroy(): void {
        super.destroy();
        DeviceTracker.instancesByUrl.delete(this.url.toString());
        if (!DeviceTracker.instancesByUrl.size) {
            const holder = document.getElementById(BaseDeviceTracker.HOLDER_ELEMENT_ID);
            if (holder && holder.parentElement) {
                holder.parentElement.removeChild(holder);
            }
        }
    }
}
