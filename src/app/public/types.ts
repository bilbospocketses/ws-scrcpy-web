/**
 * Public types for the WsScrcpy programmatic stream API.
 * Shipped as ws-scrcpy.d.ts alongside the UMD and ESM bundles.
 */

export interface StartStreamOptions {
    // Connection (optional — defaults to current location)
    host?: string | undefined;
    port?: number | undefined;
    secure?: boolean | undefined;
    pathname?: string | undefined;

    // Stream settings (optional — smart auto-selection if omitted)
    codec?: 'h264' | 'h265' | 'av1' | undefined;
    encoder?: string | undefined;
    bitrate?: number | undefined;
    maxFps?: number | undefined;
    maxSize?: number | undefined;

    // Features
    audio?: boolean | undefined;      // default true
    /**
     * Where scrcpy captures audio from on the device:
     *   - `playback` (default on Android 13+) — captures playback AND keeps
     *     device audio playing via `--audio-dup`.
     *   - `output` — captures the whole output; silences device during session.
     *   - `mic` — captures the device microphone.
     */
    audioSource?: 'playback' | 'output' | 'mic' | undefined;
    /**
     * Audio codec to request from scrcpy-server. `opus` is scrcpy's default;
     * `aac` is a common fallback when a device's Opus encoder fails.
     */
    audioCodec?: 'opus' | 'aac' | 'flac' | 'raw' | undefined;
    keyboard?: boolean | undefined;   // default true

    /**
     * Android device kind. When provided, seeds the stream toolbar's
     * D-pad/Touch toggle to the appropriate default (D-pad for TV,
     * Touch for phone/tablet). When omitted, falls back to D-pad default.
     */
    deviceKind?: 'phone' | 'tablet' | 'tv' | undefined;

    // Lifecycle callbacks
    onConnect?: ((info: StreamInfo) => void) | undefined;
    onDisconnect?: ((reason?: string) => void) | undefined;
    onError?: ((err: Error) => void) | undefined;
}

export interface StreamInfo {
    codec: string;
    encoder: string;
    resolution: string;
}

export interface StreamHandle {
    stop(): void;
    readonly isConnected: boolean;
    readonly deviceId: string;
}
