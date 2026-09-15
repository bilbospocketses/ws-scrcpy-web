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
    /**
     * The device advertises `_adb-tls-connect._tcp`, so it speaks the Android
     * 11+ TLS transport and refuses any client it has not paired with.
     *
     * Derived from the SERVICE TYPE, which is the only place the information is
     * actually available. The STLS handshake reply says the same thing, but the
     * TCP probe only ever knocks on port 5555, where an Android 11+ device
     * answers AUTH or nothing at all — so nothing ever reaches that branch.
     *
     * "May", not "does": the service type says the device pairs over TLS, not
     * whether THIS server has already paired with it. An already-paired device
     * advertises exactly the same thing and connects fine.
     */
    mayNeedPairing?: boolean;
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
