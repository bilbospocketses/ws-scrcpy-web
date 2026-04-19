// Client → server

export interface ScanStartMessage {
    type: 'scan.start';
    subnets: string[]; // raw user-typed strings
}

export interface ScanCancelMessage {
    type: 'scan.cancel';
}

export type ScanClientMessage = ScanStartMessage | ScanCancelMessage;

// Server → client

export interface ScanStartedMessage {
    type: 'scan.started';
    totalHosts: number;
    totalSubnets: number;
    startedAt: number; // epoch ms
}

export interface ScanErrorMessage {
    type: 'scan.error';
    reason: string;
    details?: { subnet: string; error: string }[];
}

export interface ScanProgressMessage {
    type: 'scan.progress';
    checked: number;
    total: number;
    foundSoFar: number;
}

export interface ScanHitMessage {
    type: 'scan.hit';
    source: 'mdns' | 'tcp';
    address: string; // 'IP:port'
    serial: string;
    name: string;
    label: string;
}

export interface ScanDrainingMessage {
    type: 'scan.draining';
}

export interface ScanCompleteMessage {
    type: 'scan.complete';
    found: number;
}

export interface ScanCancelledMessage {
    type: 'scan.cancelled';
    found: number;
}

export type ScanServerMessage =
    | ScanStartedMessage
    | ScanErrorMessage
    | ScanProgressMessage
    | ScanHitMessage
    | ScanDrainingMessage
    | ScanCompleteMessage
    | ScanCancelledMessage;

export const SCAN_WS_PATH = '/ws-scan';
