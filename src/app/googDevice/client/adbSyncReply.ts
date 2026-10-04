import { Entry } from '../Entry';

// View-agnostic parsers for the ADB sync-protocol replies, used by ListFilesModal.
// They were split out when a second, full-page file browser (since removed)
// carried a byte-identical copy; the dispatch and view rendering stay in the
// modal. These pure helpers are unit-tested in isolation.

/** The 4-byte ascii reply code at the head of a sync reply (DENT/STAT/DATA/DONE/FAIL). */
export function readSyncReplyCode(data: Uint8Array): string {
    return new TextDecoder('ascii').decode(data.subarray(0, 4));
}

/** Parse a DENT (directory entry) reply body into an Entry. */
export function parseDentReply(data: Uint8Array): Entry {
    const stat = data.subarray(4);
    const view = new DataView(stat.buffer, stat.byteOffset);
    const mode = view.getUint32(0, true);
    const size = view.getUint32(4, true);
    const mtime = view.getUint32(8, true);
    const namelen = view.getUint32(12, true);
    const name = new TextDecoder().decode(stat.subarray(16, 16 + namelen));
    return new Entry(name, mode, size, mtime);
}

/** Parse a STAT reply body into its mode/size/mtime fields. */
export function parseStatReply(data: Uint8Array): { mode: number; size: number; mtime: number } {
    const stat = data.subarray(4);
    const view = new DataView(stat.buffer, stat.byteOffset);
    return {
        mode: view.getUint32(0, true),
        size: view.getUint32(4, true),
        mtime: view.getUint32(8, true),
    };
}

/** Parse a FAIL reply into its length-prefixed message string. */
export function parseFailReply(data: Uint8Array): string {
    const view = new DataView(data.buffer, data.byteOffset);
    const length = view.getUint32(4, true);
    return new TextDecoder().decode(data.subarray(8, 8 + length));
}

/** The payload bytes of a DATA reply (everything after the 4-byte code). */
export function parseDataChunk(data: Uint8Array): Uint8Array {
    return data.subarray(4);
}
