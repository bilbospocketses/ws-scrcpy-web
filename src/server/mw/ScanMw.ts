import type WS from 'ws';
import type { ScanClientMessage, ScanServerMessage } from '../../common/ScanMessage';
import { type ParsedSubnet, type ParseError, parseSubnetInput } from '../../common/SubnetParser';
import type { NetworkScanner } from '../network/NetworkScanner';

// Scan control messages (a small list of subnets) are tiny; cap them so a
// hostile client cannot drive memory via the JSON.parse below. The WS server's
// maxPayload bounds the frame, but it is shared with the (large) device streams,
// so we cap per-message here. (#22)
const MAX_SCAN_MESSAGE_BYTES = 256 * 1024;

function rawDataByteLength(data: WS.RawData): number {
    if (Buffer.isBuffer(data)) {
        return data.length;
    }
    if (Array.isArray(data)) {
        return data.reduce((n, b) => n + b.length, 0);
    }
    if (data instanceof ArrayBuffer) {
        return data.byteLength;
    }
    return 0;
}

export class ScanMw {
    private static scanner: NetworkScanner | null = null;

    public static setScanner(scanner: NetworkScanner): void {
        ScanMw.scanner = scanner;
    }

    public static attach(ws: WS): void {
        const scanner = ScanMw.scanner;
        if (!scanner) {
            ScanMw.send(ws, { type: 'scan.error', reason: 'scanner not initialized' });
            return;
        }

        if (scanner.isScanning()) {
            scanner.attachSpectator(ws);
            // Subsequent messages from a spectator are ignored except cancel.
        }

        const onMessage = (data: WS.RawData): void => {
            if (rawDataByteLength(data) > MAX_SCAN_MESSAGE_BYTES) {
                ScanMw.send(ws, { type: 'scan.error', reason: 'message too large' });
                return;
            }
            let msg: ScanClientMessage;
            try {
                msg = JSON.parse(data.toString());
            } catch {
                ScanMw.send(ws, { type: 'scan.error', reason: 'invalid JSON' });
                return;
            }
            if (msg.type === 'scan.start') {
                if (scanner.isScanning()) {
                    ScanMw.send(ws, { type: 'scan.error', reason: 'scan already in progress' });
                    return;
                }
                const mdnsOnly = msg.mdnsOnly === true;
                const parsed: ParsedSubnet[] = [];
                const errors: { subnet: string; error: string }[] = [];
                for (const raw of msg.subnets) {
                    const r = parseSubnetInput(raw);
                    if ('reason' in r) {
                        errors.push({ subnet: raw, error: (r as ParseError).reason });
                    } else if (!r.isPrivate) {
                        // SSRF / internal port-scan guard: only private (RFC1918)
                        // targets may be scanned. The auto-detect path only ever
                        // yields the local subnet; this gates the user-supplied one.
                        errors.push({
                            subnet: raw,
                            error: `"${r.normalized}" is outside the private (RFC1918) ranges (10/8, 172.16/12, 192.168/16); scanning public addresses is not allowed.`,
                        });
                    } else {
                        parsed.push(r);
                    }
                }
                if (errors.length > 0) {
                    ScanMw.send(ws, { type: 'scan.error', reason: 'invalid subnets', details: errors });
                    return;
                }
                // Fire and forget — scanner drives the WS directly.
                scanner.start(parsed, ws, { mdnsOnly }).catch(() => {});
                return;
            }
            if (msg.type === 'scan.cancel') {
                scanner.cancel();
                return;
            }
        };

        ws.on('message', onMessage);
        ws.once('close', () => {
            ws.removeListener('message', onMessage);
        });
        // Client disconnect does NOT cancel the scan (per spec).
    }

    private static send(ws: WS, msg: ScanServerMessage): void {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(JSON.stringify(msg));
    }
}
