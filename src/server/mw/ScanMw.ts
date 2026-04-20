import type WS from 'ws';
import { parseSubnetInput, type ParsedSubnet, type ParseError } from '../../common/SubnetParser';
import { NetworkScanner } from '../network/NetworkScanner';
import type { ScanClientMessage, ScanServerMessage } from '../../common/ScanMessage';

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
                const parsed: ParsedSubnet[] = [];
                const errors: { subnet: string; error: string }[] = [];
                for (const raw of msg.subnets) {
                    const r = parseSubnetInput(raw);
                    if ('reason' in r) {
                        errors.push({ subnet: raw, error: (r as ParseError).reason });
                    } else {
                        parsed.push(r);
                    }
                }
                if (errors.length > 0) {
                    ScanMw.send(ws, { type: 'scan.error', reason: 'invalid subnets', details: errors });
                    return;
                }
                // Fire and forget — scanner drives the WS directly.
                scanner.start(parsed, ws).catch(() => {});
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
