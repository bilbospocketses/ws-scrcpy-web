// src/server/ScrcpyOptions.ts
export interface ScrcpyOptions {
    scid: string;
    videoCodec?: 'h264' | 'h265' | 'av1';
    audioCodec?: 'opus';
    maxSize?: number;
    videoBitRate?: number;
    maxFps?: number;
    audio?: boolean;
    control?: boolean;
    displayId?: number;
    sendDeviceMeta?: boolean;
    sendCodecMeta?: boolean;
    sendFrameMeta?: boolean;
    tunnelForward?: boolean;
}

const DEFAULTS: Omit<Required<ScrcpyOptions>, 'scid'> = {
    videoCodec: 'h264',
    audioCodec: 'opus',
    maxSize: 0,
    videoBitRate: 8000000,
    maxFps: 0,
    audio: true,
    control: true,
    displayId: 0,
    sendDeviceMeta: true,
    sendCodecMeta: true,
    sendFrameMeta: true,
    tunnelForward: false,
};

function toSnakeCase(key: string): string {
    return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export function serializeOptions(options: ScrcpyOptions): string[] {
    const args: string[] = [];
    for (const [key, defaultValue] of Object.entries(DEFAULTS)) {
        const value = (options as Record<string, unknown>)[key];
        if (value !== undefined && value !== defaultValue) {
            args.push(`${toSnakeCase(key)}=${value}`);
        }
    }
    // scid is always emitted
    args.push(`scid=${options.scid}`);
    return args;
}
