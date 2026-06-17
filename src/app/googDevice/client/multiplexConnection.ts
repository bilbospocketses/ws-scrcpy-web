import { ACTION } from '../../../common/Action';
import { ChannelCode } from '../../../common/ChannelCode';
import { BinaryWriter } from '../../BinaryWriter';

// Shared multiplex-WebSocket helpers. ListFilesModal and ShellModal previously
// each carried a byte-identical copy of the URL builder (and ListFilesModal /
// FileListingClient a copy of the FSLS channel-init builder); centralising them
// removes the duplication and gives the security-sensitive URL construction a
// single place to validate its inputs.

export interface MultiplexUrlParams {
    hostname?: string | undefined;
    port?: number | undefined;
    secure?: boolean | undefined;
    pathname?: string | undefined;
}

/**
 * A hostname is only safe to interpolate into a `ws(s)://<host>:<port>…` URL if
 * it can't smuggle in a scheme, credentials, path, query, or fragment. Accept a
 * DNS name / IPv4 (`[A-Za-z0-9._-]`) or a bracketed IPv6 literal; reject
 * anything containing `/ \ @ ? # :` or whitespace. The device hostname is
 * user-influenced (manual entry / scan reply), so this is the SSRF guard for the
 * `new WebSocket(url)` sink (CodeQL js/request-forgery).
 */
export function isValidWsHostname(hostname: string): boolean {
    if (!hostname) {
        return false;
    }
    return /^[A-Za-z0-9._-]+$/.test(hostname) || /^\[[0-9A-Fa-f:]+\]$/.test(hostname);
}

/**
 * Build the multiplexer WebSocket URL. With an explicit device host/port the
 * inputs are validated (see isValidWsHostname); otherwise the URL targets the
 * current origin (`location.host`), which is trusted.
 */
export function buildMultiplexUrl(params: MultiplexUrlParams): string {
    const { hostname, port, secure, pathname } = params;
    let urlString: string;
    if (typeof hostname === 'string' && typeof port === 'number') {
        if (!isValidWsHostname(hostname)) {
            throw new Error(`refusing to open WebSocket to invalid hostname: ${JSON.stringify(hostname)}`);
        }
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error(`refusing to open WebSocket to invalid port: ${port}`);
        }
        const protocol = secure ? 'wss:' : 'ws:';
        urlString = `${protocol}//${hostname}:${port}${pathname ?? location.pathname}`;
    } else {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        // location.host includes hostname and port and is the trusted origin.
        urlString = `${protocol}//${location.host}${pathname ?? location.pathname}`;
    }
    const url = new URL(urlString);
    url.searchParams.set('action', ACTION.MULTIPLEX);
    return url.toString();
}

/**
 * Build the FSLS (file-system listing) channel-init payload: the channel code,
 * the serial byte length (LE u32), then the serial bytes.
 */
export function buildFslsInitData(serial: string): Uint8Array {
    const bytes = new TextEncoder().encode(serial);
    return new BinaryWriter(4 + 4 + bytes.byteLength)
        .writeString(ChannelCode.FSLS)
        .writeUInt32LE(bytes.length)
        .writeBytes(bytes)
        .toUint8Array();
}
