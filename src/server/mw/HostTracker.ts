import type WS from 'ws';
import { ChannelCode } from '../../common/ChannelCode';
import { type MessageError, type MessageHosts, MessageType } from '../../common/HostTrackerMessage';
import type { Multiplexer } from '../../packages/multiplexer/Multiplexer';
import { Mw } from './Mw';

export interface TrackerClass {
    type: string;
}

export class HostTracker extends Mw {
    public static readonly TAG = 'HostTracker';
    private static localTrackers: Set<TrackerClass> = new Set<TrackerClass>();

    public static override processChannel(ws: Multiplexer, code: string): Mw | undefined {
        if (code !== ChannelCode.HSTS) {
            return;
        }
        return new HostTracker(ws);
    }

    public static registerLocalTracker(tracker: TrackerClass): void {
        this.localTrackers.add(tracker);
    }

    constructor(ws: Multiplexer) {
        super(ws);

        const local: { type: string }[] = Array.from(HostTracker.localTrackers.keys()).map((tracker) => {
            return { type: tracker.type };
        });
        const message: MessageHosts = {
            id: -1,
            type: MessageType.HOSTS,
            data: {
                local,
            },
        };
        this.sendMessage(message);
    }

    protected onSocketMessage(event: WS.MessageEvent): void {
        const message: MessageError = {
            id: -1,
            type: MessageType.ERROR,
            data: `Unsupported message: "${event.data.toString()}"`,
        };
        this.sendMessage(message);
    }

    public override release(): void {
        super.release();
    }
}
