/**
 * Public types for the WsScrcpy programmatic stream API.
 * Shipped as ws-scrcpy.d.ts alongside the UMD and ESM bundles.
 */

export interface StartStreamOptions {
    // Connection (optional — defaults to current location)
    host?: string;
    port?: number;
    secure?: boolean;
    pathname?: string;

    // Stream settings (optional — smart auto-selection if omitted)
    codec?: 'h264' | 'h265' | 'av1';
    encoder?: string;
    bitrate?: number;
    maxFps?: number;
    maxSize?: number;

    // Features
    audio?: boolean;      // default true
    /**
     * Where scrcpy captures audio from on the device:
     *   - `playback` (default on Android 13+) — captures playback AND keeps
     *     device audio playing via `--audio-dup`.
     *   - `output` — captures the whole output; silences device during session.
     *   - `mic` — captures the device microphone.
     */
    audioSource?: 'playback' | 'output' | 'mic';
    /**
     * Audio codec to request from scrcpy-server. `opus` is scrcpy's default;
     * `aac` is a common fallback when a device's Opus encoder fails.
     */
    audioCodec?: 'opus' | 'aac' | 'flac' | 'raw';
    keyboard?: boolean;   // default true

    /**
     * Android device kind. When provided, seeds the stream toolbar's
     * D-pad/Touch toggle to the appropriate default (D-pad for TV,
     * Touch for phone/tablet). When omitted, falls back to D-pad default.
     */
    deviceKind?: 'phone' | 'tablet' | 'tv';

    // Lifecycle callbacks
    onConnect?: (info: StreamInfo) => void;
    onDisconnect?: (reason?: string) => void;
    onError?: (err: Error) => void;
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
