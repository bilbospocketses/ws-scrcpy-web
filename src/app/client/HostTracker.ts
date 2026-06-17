import { ACTION } from '../../common/Action';
import { ChannelCode } from '../../common/ChannelCode';
import { type MessageError, type MessageHosts, MessageType } from '../../common/HostTrackerMessage';
import type { HostItem } from '../../types/Configuration';
import type { Message } from '../../types/Message';
import type { ParamsBase } from '../../types/ParamsBase';
import { DeviceTracker as GoogDeviceTracker } from '../googDevice/client/DeviceTracker';
import { ManagerClient } from './ManagerClient';

const TAG = '[HostTracker]';

export interface HostTrackerEvents {
    // hosts: HostItem[];
    disconnected: CloseEvent;
    error: string;
}

export class HostTracker extends ManagerClient<ParamsBase, HostTrackerEvents> {
    private static instance?: HostTracker;

    public static override start(): void {
        this.getInstance();
    }

    public static getInstance(): HostTracker {
        if (!this.instance) {
            this.instance = new HostTracker();
        }
        return this.instance;
    }

    private trackers: GoogDeviceTracker[] = [];

    constructor() {
        super({ action: ACTION.LIST_HOSTS });
        this.openNewConnection();
        if (this.ws) {
            this.ws.binaryType = 'arraybuffer';
        }
    }

    protected onSocketClose(ev: CloseEvent): void {
        console.log(TAG, 'WS closed');
        this.emit('disconnected', ev);
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
            case MessageType.ERROR: {
                const msg = message as MessageError;
                console.error(TAG, msg.data);
                this.emit('error', msg.data);
                break;
            }
            case MessageType.HOSTS: {
                const msg = message as MessageHosts;
                // this.emit('hosts', msg.data);
                if (msg.data.local) {
                    msg.data.local.forEach(({ type }) => {
                        const secure = location.protocol === 'https:';
                        const port = location.port ? Number.parseInt(location.port, 10) : secure ? 443 : 80;
                        const { hostname, pathname } = location;
                        if (type !== 'android') {
                            console.warn(TAG, `Unsupported host type: "${type}"`);
                            return;
                        }
                        const hostItem: HostItem = { useProxy: false, secure, port, hostname, pathname, type };
                        this.startTracker(hostItem);
                    });
                }
                if (msg.data.remote) {
                    msg.data.remote.forEach((item) => {
                        this.startTracker(item);
                    });
                }
                break;
            }
            default:
                console.log(TAG, `Unknown message type: ${message.type}`);
        }
    }

    private startTracker(hostItem: HostItem): void {
        if (hostItem.type === 'android') {
            this.trackers.push(GoogDeviceTracker.start(hostItem));
        } else {
            console.warn(TAG, `Unsupported host type: "${hostItem.type}"`);
        }
    }

    protected onSocketOpen(): void {
        // do nothing
    }

    public override destroy(): void {
        super.destroy();
        this.trackers.forEach((tracker) => {
            tracker.destroy();
        });
        this.trackers.length = 0;
    }

    protected override supportMultiplexing(): boolean {
        return true;
    }

    protected override getChannelInitData(): Uint8Array {
        return new TextEncoder().encode(ChannelCode.HSTS);
    }
}
