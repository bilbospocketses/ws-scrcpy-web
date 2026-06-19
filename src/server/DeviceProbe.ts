import path from 'path';
import type WS from 'ws';
import { ACTION } from '../common/Action';
import { DEVICE_SERVER_PATH, SERVER_PACKAGE } from '../common/Constants';
import type { ProbeResult } from '../common/ProbeResult';
import { AdbClient } from './AdbClient';
import { Config } from './Config';
import { ensureScrcpyServerPushed } from './ensureScrcpyServerPushed';
import { ControlCenter } from './goog-device/services/ControlCenter';
import { parseWmDensity, parseWmSize } from './goog-device/wmParsers';
import { Logger } from './Logger';
import { Mw, type RequestParameters } from './mw/Mw';
import { parseScrcpyEncoderList } from './scrcpyEncoderList';
import { getInstalledScrcpyServerVersion } from './scrcpyServerVersion';

const log = Logger.for('DeviceProbe');

/**
 * v0.1.9: scrcpy-server lives in the local-deps folder, NOT in
 * dist/assets/. Same architectural pattern as the v0.1.4 adb fix and
 * v0.1.6 launcher-binPath fix — runtime dependencies are managed by
 * DependencyManager and live under <deps>/scrcpy-server/scrcpy-server.
 *
 * Previously the file was bundled into dist/assets/scrcpy-server via
 * the webpack `import '../../assets/scrcpy-server'` directive, which
 * meant Velopack updates would overwrite the user's dep-updater-fetched
 * version with whatever was bundled at build time. The dep updater
 * "scrcpy-server update" button updated a path that nothing read, and
 * was load-bearing-but-broken: silent.
 *
 * v0.1.9 removes the webpack import, computes the path lazily from
 * Config.dependenciesPath, and lets DependencyManager.autoInstallMissing
 * fetch the binary on first run if missing (the launcher's seed/
 * promotion handles offline-first-run).
 */
function serverFile(): string {
    return path.join(Config.getInstance().dependenciesPath, 'scrcpy-server', 'scrcpy-server');
}

function installedVersion(): string {
    return getInstalledScrcpyServerVersion(Config.getInstance().dependenciesPath);
}

export class DeviceProbe extends Mw {
    private adbClient = new AdbClient(Config.getInstance().adbPath);

    public static override processRequest(ws: WS, params: RequestParameters): DeviceProbe | undefined {
        const { action, url } = params;
        if (action !== ACTION.PROBE_DEVICE) {
            return;
        }
        const udid = url.searchParams.get('udid');
        if (!udid) {
            ws.close(4003, '[DeviceProbe] Missing "udid" parameter');
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
            log.error(`Probe failed for ${this.serial}:`, err.message);
            try {
                if (ws.readyState === ws.OPEN) {
                    ws.close(4005, err.message.slice(0, 123));
                }
            } catch (closeErr) {
                log.error(`Failed to close WebSocket for ${this.serial}:`, closeErr);
            }
        });
    }

    private async probe(): Promise<void> {
        log.info(`Probing ${this.serial}`);

        // `dumpsys media.player` on pre-Android 10 devices doesn't emit encoder
        // entries (and can take a minute+ to respond on older hardware like the
        // SM-T550). Query scrcpy-server's own MediaCodecList enumeration
        // (`list_encoders=true`) in that case. It runs server-side Java so it
        // bootstraps scrcpy-server once, but with cleanup=false the JAR stays
        // on the device — the subsequent stream session reuses the warm dex
        // cache instead of rebuilding it.
        const sdkInt = this.getCachedSdkInt();
        const useScrcpyList = sdkInt > 0 && sdkInt < 28;

        const [sizeOutput, densityOutput, encoders] = await Promise.all([
            this.adbClient.shell(this.serial, 'wm size'),
            this.adbClient.shell(this.serial, 'wm density'),
            useScrcpyList ? this.listEncodersViaScrcpyServer() : this.listEncodersViaDumpsys(),
        ]);

        const { width, height } = parseWmSize(sizeOutput);
        const density = parseWmDensity(densityOutput);

        const result: ProbeResult = {
            width,
            height,
            density,
            sdkInt,
            videoEncoders: encoders.videoEncoders,
            audioEncoders: encoders.audioEncoders,
        };
        log.info(`Probe result for ${this.serial}:`, JSON.stringify(result));

        if (this.ws.readyState === this.ws.OPEN) {
            this.ws.send(JSON.stringify(result));
            this.ws.close(1000, 'Probe complete');
        }
    }

    private getCachedSdkInt(): number {
        if (!ControlCenter.hasInstance()) return 0;
        const device = ControlCenter.getInstance().getDevice(this.serial);
        if (!device) return 0;
        const raw = device.descriptor['ro.build.version.sdk'];
        const n = Number.parseInt(raw, 10);
        return Number.isFinite(n) ? n : 0;
    }

    private async listEncodersViaDumpsys(): Promise<{ videoEncoders: string[]; audioEncoders: string[] }> {
        const output = await this.adbClient.shell(this.serial, 'dumpsys media.player');
        const regex = /Encoder "([^"]+)" supports/g;
        const videoCodecs = ['avc', 'hevc', 'av1'];
        const audioCodecs = ['opus', 'aac', 'flac'];
        const videoEncoders: string[] = [];
        const audioEncoders: string[] = [];
        let match: RegExpExecArray | null;
        while ((match = regex.exec(output)) !== null) {
            const name = match[1];
            if (name === undefined) continue;
            if (videoCodecs.some((c) => name.includes(`.${c}.`))) videoEncoders.push(name);
            else if (audioCodecs.some((c) => name.includes(`.${c}.`))) audioEncoders.push(name);
        }
        return { videoEncoders, audioEncoders };
    }

    private async listEncodersViaScrcpyServer(): Promise<{ videoEncoders: string[]; audioEncoders: string[] }> {
        await ensureScrcpyServerPushed(this.adbClient, this.serial, serverFile());
        // cleanup=false leaves the JAR on-device so the subsequent stream session
        // hits a warm dex cache and skips the ~15s dexopt re-run.
        const cmd = `CLASSPATH=${DEVICE_SERVER_PATH} app_process / ${SERVER_PACKAGE} ${installedVersion()} cleanup=false list_encoders=true 2>&1`;
        const output = await this.adbClient.shell(this.serial, cmd);
        return parseScrcpyEncoderList(output);
    }

    protected onSocketMessage(): void {
        // Probe is one-shot server→client; no incoming messages expected
    }
}
