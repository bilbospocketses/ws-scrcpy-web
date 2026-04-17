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
    keyboard?: boolean;   // default true

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
