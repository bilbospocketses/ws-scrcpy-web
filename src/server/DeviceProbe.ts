// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import type WS from 'ws';
import { ACTION } from '../common/Action';
import type { ProbeResult } from '../common/ProbeResult';
import { AdbClient } from './AdbClient';
import { Mw, type RequestParameters } from './mw/Mw';

const TAG = '[DeviceProbe]';

export class DeviceProbe extends Mw {
    private adbClient = new AdbClient();

    public static processRequest(ws: WS, params: RequestParameters): DeviceProbe | undefined {
        const { action, url } = params;
        if (action !== ACTION.PROBE_DEVICE) {
            return;
        }
        const udid = url.searchParams.get('udid');
        if (!udid) {
            ws.close(4003, `${TAG} Missing "udid" parameter`);
            return;
        }
        return new DeviceProbe(ws, udid);
    }

    private constructor(
        ws: WS,
        private readonly serial: string,
    ) {
        super(ws);
        this.probe().catch((err) => {
            console.error(TAG, `Probe failed for ${this.serial}:`, err.message);
            try {
                if (ws.readyState === ws.OPEN) {
                    ws.close(4005, err.message.slice(0, 123));
                }
            } catch (closeErr) {
                console.error(TAG, `Failed to close WebSocket for ${this.serial}:`, closeErr);
            }
        });
    }

    private async probe(): Promise<void> {
        console.log(TAG, `Probing ${this.serial}`);

        const [encoderOutput, sizeOutput, densityOutput] = await Promise.all([
            this.adbClient.shell(this.serial, 'dumpsys media.player'),
            this.adbClient.shell(this.serial, 'wm size'),
            this.adbClient.shell(this.serial, 'wm density'),
        ]);

        const videoEncoders = this.parseEncoders(encoderOutput, ['avc', 'hevc', 'av1']);
        const audioEncoders = this.parseEncoders(encoderOutput, ['opus', 'aac', 'flac']);
        const { width, height } = this.parseSize(sizeOutput);
        const density = this.parseDensity(densityOutput);

        const result: ProbeResult = { width, height, density, videoEncoders, audioEncoders };
        console.log(TAG, `Probe result for ${this.serial}:`, JSON.stringify(result));

        if (this.ws.readyState === this.ws.OPEN) {
            this.ws.send(JSON.stringify(result));
            this.ws.close(1000, 'Probe complete');
        }
    }

    private parseEncoders(output: string, codecs: string[]): string[] {
        const encoders: string[] = [];
        const regex = /Encoder "([^"]+)" supports/g;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(output)) !== null) {
            const name = match[1];
            if (codecs.some((c) => name.includes(`.${c}.`))) {
                encoders.push(name);
            }
        }
        return encoders;
    }

    private parseSize(output: string): { width: number; height: number } {
        const override = output.match(/Override size:\s*(\d+)x(\d+)/);
        if (override) {
            return { width: Number.parseInt(override[1], 10), height: Number.parseInt(override[2], 10) };
        }
        const physical = output.match(/Physical size:\s*(\d+)x(\d+)/);
        if (physical) {
            return { width: Number.parseInt(physical[1], 10), height: Number.parseInt(physical[2], 10) };
        }
        return { width: 1920, height: 1080 };
    }

    private parseDensity(output: string): number {
        const match = output.match(/(?:Override|Physical) density:\s*(\d+)/);
        return match ? Number.parseInt(match[1], 10) : 320;
    }

    protected onSocketMessage(): void {
        // Probe is one-shot server→client; no incoming messages expected
    }
}
