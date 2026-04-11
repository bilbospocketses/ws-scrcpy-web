/**
 * ADB sync protocol constants.
 * Replaces `@dead50f7/adbkit/lib/adb/protocol`.
 */
const AdbProtocol = {
    STAT: 'STAT',
    LIST: 'LIST',
    RECV: 'RECV',
    SEND: 'SEND',
    DATA: 'DATA',
    DONE: 'DONE',
    DENT: 'DENT',
    FAIL: 'FAIL',
    OKAY: 'OKAY',
} as const;

export default AdbProtocol;
