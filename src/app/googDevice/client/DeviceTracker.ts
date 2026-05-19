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
import SvgImage from '../../ui/SvgImage';
import { StreamClientScrcpy } from './StreamClientScrcpy';
import { AudioSettingsStore } from '../../client/AudioSettingsStore';
import {
    audioCaptureSupported,
    audioEnabledDefault,
    defaultAudioSourceForSdk,
} from '../../../common/AudioDefaults';

// ---------- capability gating ----------

interface Capabilities {
    shell: boolean;
}

let capabilitiesCache: Capabilities | undefined;
let capabilitiesPromise: Promise<Capabilities> | undefined;

function getCapabilities(): Promise<Capabilities> {
    if (capabilitiesCache) return Promise.resolve(capabilitiesCache);
    if (capabilitiesPromise) return capabilitiesPromise;
    capabilitiesPromise = fetch('/api/capabilities')
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
        .then((data: Capabilities) => {
            capabilitiesCache = data;
            return data;
        })
        .catch(() => {
            // Fetch failed → fail open: shell button stays clickable; backend will
            // reject at click time anyway. Avoids disabling shell on network hiccups.
            capabilitiesCache = { shell: true };
            return capabilitiesCache as Capabilities;
        });
    return capabilitiesPromise;
}

function applyShellCapability(link: HTMLAnchorElement, available: boolean): void {
    if (available) return; // default state is enabled — nothing to do
    // Visually disable: pointer-events off, muted opacity, tooltip explaining why
    link.style.pointerEvents = 'none';
    link.style.opacity = '0.4';
    link.title =
        'Shell unavailable — no node-pty prebuilt matches your Node version. ' +
        'Update Node in the Dependencies panel or wait for the next prebuild release.';
    // Belt-and-suspenders: also block keyboard activation
    link.setAttribute('aria-disabled', 'true');
    link.setAttribute('tabindex', '-1');
}

// Kick off the fetch early so the result is ready when the first device renders.
// Brief flash-of-enabled is acceptable: button appears enabled, then is patched
// async. Any click before patch resolves opens ShellModal which will fail at the
// WebSocket layer — the same error path as a server-side rejection.
getCapabilities();

// ---------- end capability gating ----------

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

    private static iconForKind(kind: 'phone' | 'tablet' | 'tv' | undefined) {
        switch (kind) {
            case 'tv': return SvgImage.Icon.DEVICE_TV;
            case 'tablet': return SvgImage.Icon.DEVICE_TABLET;
            case 'phone': return SvgImage.Icon.DEVICE_PHONE;
            default: return undefined;
        }
    }

    private updateLink(params: { url: string; name: string; fullName: string; udid: string; deviceKind?: 'phone' | 'tablet' | 'tv' }): void {
        const { url, name, fullName, udid, deviceKind } = params;
        const playerTds = document.getElementsByName(
            encodeURIComponent(`${DeviceTracker.AttributePrefixPlayerFor}${fullName}`),
        );
        if (typeof udid !== 'string') {
            return;
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
            const iconType = DeviceTracker.iconForKind(deviceKind);
            if (iconType !== undefined) {
                const icon = SvgImage.create(iconType);
                icon.classList.add('kind-icon');
                link.appendChild(icon);
            }
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
        const deviceName = device['ro.product.model']?.startsWith(device['ro.product.manufacturer'])
            ? device['ro.product.model']
            : `${device['ro.product.manufacturer']} ${device['ro.product.model']}`;

        const overlayId = `device_overlay_${fullName}`;
        const isNetworkDevice = device.udid.includes(':');
        const row = html`<div class="device ${isActive ? 'active' : 'not-active'}">
            <table class="device-info">
                <tr class="device-name-row"><td class="device-label">Device Name:</td><td colspan="2"></td></tr>
                <tr><td class="device-label">Model:</td><td colspan="2">${deviceName}</td></tr>
                <tr><td class="device-label">Device ID:</td><td colspan="2" class="device-serial">${device.udid}</td></tr>
                <tr class="android-row"><td class="device-label">Android:</td><td>${(device['ro.build.version.release'] || '').split('.')[0]}</td></tr>
                <tr><td class="device-label">SDK:</td><td>${device['ro.build.version.sdk']}</td></tr>
            </table>
            <div id="${overlayId}" class="services">
                <div class="services-label">opens in modal</div>
            </div>
        </div>`.content;
        const overlaySection = row.getElementById(overlayId);

        // Build Device Name cell via DOM (interactive elements can't use html`` template)
        const nameRow = row.querySelector('.device-name-row');
        if (nameRow) {
            const nameCell = nameRow.querySelector('td:last-child') as HTMLTableCellElement;
            if (nameCell) {
                const serial = device['ro.serialno'] || '';
                DeviceTracker.buildLabelCell(nameCell, serial);
            }
        }

        if (!overlaySection) {
            return;
        }

        // Add action buttons cell (disconnect + sleep/wake) via DOM
        const androidRow = row.querySelector('.android-row');
        if (androidRow) {
            const td = document.createElement('td');
            td.rowSpan = 2;
            td.className = 'device-actions-cell';
            const wrapper = document.createElement('div');
            wrapper.className = 'device-actions-wrapper';

            // Disconnect button (network devices only) — left side
            if (isNetworkDevice) {
                const disconnectBtn = document.createElement('button');
                disconnectBtn.className = 'disconnect-btn';
                disconnectBtn.textContent = 'disconnect';
                disconnectBtn.addEventListener('click', async () => {
                    disconnectBtn.disabled = true;
                    try {
                        await fetch('/api/devices/disconnect', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ address: device.udid }),
                        });
                    } catch {
                        disconnectBtn.disabled = false;
                    }
                });
                wrapper.appendChild(disconnectBtn);
            }

            // Sleep/wake button (all devices) — right side
            // State comes from server via WebSocket (descriptor['screen.state'])
            const screenState = device['screen.state'] || 'unknown';
            const sleepBtn = document.createElement('button');

            if (screenState === 'unknown') {
                sleepBtn.className = 'sleep-wake-btn state-unknown';
                sleepBtn.textContent = 'checking...';
                sleepBtn.disabled = true;
            } else {
                const isAwake = screenState === 'awake';
                sleepBtn.className = `sleep-wake-btn ${isAwake ? 'state-on' : 'state-off'}`;
                sleepBtn.textContent = isAwake ? 'turn off' : 'turn on';
                sleepBtn.dataset.awake = String(isAwake);
            }

            sleepBtn.addEventListener('click', async () => {
                const isAwake = sleepBtn.dataset.awake === 'true';
                sleepBtn.disabled = true;
                // §25b — using-declaration replaces the prior try/finally that
                // re-enabled the button on every exit path. Captures sleepBtn
                // lexically; dispose fires on return or throw from the fetch.
                using _restoreBtn = {
                    [Symbol.dispose](): void {
                        sleepBtn.disabled = false;
                    },
                };
                try {
                    const res = await fetch('/api/devices/sleep-wake', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ udid: device.udid, action: isAwake ? 'sleep' : 'wake' }),
                    });
                    const result = await res.json();
                    sleepBtn.dataset.awake = String(result.awake);
                    sleepBtn.textContent = result.awake ? 'turn off' : 'turn on';
                    sleepBtn.className = `sleep-wake-btn ${result.awake ? 'state-on' : 'state-off'}`;
                } catch {
                    sleepBtn.dataset.awake = String(isAwake);
                    sleepBtn.textContent = isAwake ? 'turn off' : 'turn on';
                    sleepBtn.className = `sleep-wake-btn ${isAwake ? 'state-on' : 'state-off'}`;
                }
            });
            wrapper.appendChild(sleepBtn);

            td.appendChild(wrapper);
            androidRow.appendChild(td);
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

        // Overlay 2x2 grid filled column-first via CSS `grid-auto-flow: column`:
        // left column = [shell, list files], right column = [connect, configure stream]
        DeviceTracker.tools.forEach((tool) => {
            const entry = tool.createEntryForDeviceList(device, 'desc-block', this.params);
            if (entry) {
                if (Array.isArray(entry)) {
                    entry.forEach((item) => {
                        item && overlaySection.appendChild(item);
                    });
                } else {
                    overlaySection.appendChild(entry);
                }
            }
        });

        // Connect button — right column, top
        if (isActive && DeviceTracker.CREATE_DIRECT_LINKS) {
            const name = `${DeviceTracker.AttributePrefixPlayerFor}${fullName}`;
            StreamClientScrcpy.getPlayers().forEach((playerClass) => {
                const { playerCodeName, playerFullName } = playerClass;
                const connectBtn = document.createElement('div');
                connectBtn.classList.add('desc-block');
                connectBtn.setAttribute('name', encodeURIComponent(name));
                connectBtn.setAttribute(DeviceTracker.AttributePlayerFullName, encodeURIComponent(playerFullName));
                connectBtn.setAttribute(DeviceTracker.AttributePlayerCodeName, encodeURIComponent(playerCodeName));
                overlaySection.appendChild(connectBtn);
            });
        }

        // Configure stream — right column, bottom
        const streamEntry = StreamClientScrcpy.createEntryForDeviceList(device, 'desc-block', fullName, this.params);
        streamEntry && overlaySection.appendChild(streamEntry);

        // Intercept shell links — open modal instead of navigating to new tab
        const shellLink = overlaySection.querySelector('.shell a') as HTMLAnchorElement | null;
        if (shellLink) {
            shellLink.removeAttribute('target');
            shellLink.addEventListener('click', async (e) => {
                e.preventDefault();
                const nameEl = shellLink.closest('.device')?.querySelector('.device-name-text');
                const label = nameEl?.textContent || device['ro.product.model'] || device.udid;
                const { ShellModal } = await import('./ShellModal');
                new ShellModal(device.udid, label, this.params);
            });

            // Gate shell link on server-side node-pty availability.
            // If capabilities are already cached, apply immediately (no flash).
            // Otherwise patch once the in-flight fetch resolves.
            if (capabilitiesCache !== undefined) {
                applyShellCapability(shellLink, capabilitiesCache.shell);
            } else {
                getCapabilities().then((caps) => applyShellCapability(shellLink, caps.shell));
            }
        }

        // Intercept list files links — open ListFilesModal instead of navigating to new tab
        const listFilesLinks = overlaySection.querySelectorAll('a.link-list-files') as NodeListOf<HTMLAnchorElement>;
        listFilesLinks.forEach((link) => {
            link.removeAttribute('target');
            link.addEventListener('click', async (e) => {
                e.preventDefault();
                const nameEl = link.closest('.device')?.querySelector('.device-name-text');
                const label = nameEl?.textContent || device['ro.product.model'] || device.udid;
                const { ListFilesModal } = await import('./ListFilesModal');
                new ListFilesModal(device.udid, label, this.params);
            });
        });

        tbody.appendChild(row);

        // Populate connect link with auto-selected interface
        if (DeviceTracker.CREATE_DIRECT_LINKS && isActive && selectedInterfaceUrl) {
            this.updateLink({
                url: selectedInterfaceUrl,
                name: selectedInterfaceName,
                fullName,
                udid: device.udid,
                deviceKind: device.deviceKind,
            });
        }

        // Intercept connect links — open ConnectModal instead of navigating to new tab
        const connectLinks = overlaySection.querySelectorAll('a.link-stream') as NodeListOf<HTMLAnchorElement>;
        connectLinks.forEach((link) => {
            link.removeAttribute('target');
            link.addEventListener('click', async (e) => {
                e.preventDefault();
                const href = link.getAttribute('href');
                if (!href) return;

                // Parse stream params from the URL hash
                const url = new URL(href, location.origin);
                const hash = url.hash.startsWith('#!') ? url.hash.slice(2) : url.hash.slice(1);
                const query = new URLSearchParams(hash);
                const params = StreamClientScrcpy.parseParameters(query);

                // Apply audio prefs: saved-from-ConfigureScrcpy if present,
                // otherwise SDK-aware defaults so the connect-button respects
                // device capability (playback+dup on Android 13+, output below).
                const sdkInt = Number.parseInt(device['ro.build.version.sdk'], 10);
                const saved = AudioSettingsStore.load(device.udid);
                if (saved) {
                    params.audioEnabled = saved.enabled;
                    params.audioSource = saved.source;
                    params.audioCodec = saved.codec;
                } else {
                    params.audioEnabled =
                        audioCaptureSupported(sdkInt) && audioEnabledDefault(device.deviceKind);
                    params.audioSource = defaultAudioSourceForSdk(sdkInt);
                    // audioCodec left unset → server uses scrcpy's opus default
                }

                // Get device label from the card
                const nameEl = link.closest('.device')?.querySelector('.device-name-text');
                const label = nameEl?.textContent || device['ro.product.model'] || device.udid;

                // Create player and open ConnectModal with auto-detected settings
                const playerClass = StreamClientScrcpy.getPlayers()[0];
                if (!playerClass) return;
                const player = StreamClientScrcpy.createPlayer(playerClass.playerFullName, device.udid);
                if (!player) return;

                const videoSettings = player.getVideoSettings();
                const fitToScreen = playerClass.getFitToScreenStatus(device.udid);
                player.setVideoSettings(videoSettings, fitToScreen, false);

                const { ConnectModal } = await import('./ConnectModal');
                new ConnectModal(params, player, fitToScreen, videoSettings, label, device.deviceKind);
            });
        });
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

    private static buildLabelCell(cell: HTMLTableCellElement, serial: string): void {
        const renderDisplay = async () => {
            let label = '';
            if (serial) {
                try {
                    const res = await fetch('/api/devices/labels');
                    const labels: Record<string, string> = await res.json();
                    label = labels[serial] || '';
                } catch {
                    // Couldn't fetch labels — show unnamed
                }
            }

            cell.innerHTML = '';
            cell.className = 'device-name-cell';

            const span = document.createElement('span');
            span.className = label ? 'device-name-text' : 'device-name-text unnamed';
            span.textContent = label || 'Unnamed Device';
            cell.appendChild(span);

            const pencilBtn = document.createElement('button');
            pencilBtn.className = 'device-name-edit-btn';
            pencilBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.85 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
            pencilBtn.title = 'Edit device name';
            pencilBtn.addEventListener('click', () => renderEdit(label));
            cell.appendChild(pencilBtn);
        };

        const renderEdit = (currentLabel: string) => {
            cell.innerHTML = '';

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'device-name-input';
            input.value = currentLabel;
            input.placeholder = 'Name this device...';
            cell.appendChild(input);

            const saveBtn = document.createElement('button');
            saveBtn.className = 'device-name-edit-btn';
            saveBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
            saveBtn.title = 'Save';
            const save = async () => {
                const newLabel = input.value.trim();
                if (serial) {
                    try {
                        await fetch('/api/devices/labels', {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ serial, label: newLabel }),
                        });
                    } catch {
                        // Save failed — will show old label
                    }
                }
                renderDisplay();
            };
            saveBtn.addEventListener('click', save);
            cell.appendChild(saveBtn);

            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') save();
                if (e.key === 'Escape') renderDisplay();
            });

            input.focus();
            input.select();
        };

        renderDisplay();
    }
}
