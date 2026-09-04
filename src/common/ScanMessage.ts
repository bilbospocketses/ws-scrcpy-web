// Client → server

export interface ScanStartMessage {
    type: 'scan.start';
    subnets: string[]; // raw user-typed strings
    mdnsOnly?: boolean; // when true, skip TCP probe track; subnets may be empty
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
    /** Model remembered from a previous sighting, when the app has seen this
     *  address before. Absent for a device it has never observed. The mDNS REST
     *  route has always enriched hits this way; the /ws-scan path the scan UI
     *  actually uses did not (finding 7.6). */
    model?: string;
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
