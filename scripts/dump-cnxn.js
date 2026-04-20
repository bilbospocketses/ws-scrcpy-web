// Standalone script that builds the exact CNXN packet our scanner's
// AdbHandshakeProbe emits, and prints it as hex so we can diff against
// what real adb sends on the wire. Run: node scripts/dump-cnxn.js
const A_CNXN = 0x4e584e43;
const ADB_VERSION = 0x01000001;
const ADB_MAX_DATA = 0x00100000;

const BANNER =
    'host::features=shell_v2,cmd,stat_v2,ls_v2,fixed_push_mkdir,apex,abb,' +
    'fixed_push_symlink_timestamp,abb_exec,remount_shell,track_app,' +
    'sendrecv_v2,sendrecv_v2_brotli,sendrecv_v2_lz4,sendrecv_v2_zstd,' +
    'sendrecv_v2_dry_run_send,openscreen_mdns,devicetracker_proto_format,' +
    'devraw,app_info,server_status,track_mdns';

const payload = Buffer.from(BANNER, 'utf8');
let sum = 0;
for (let i = 0; i < payload.length; i++) sum = (sum + payload[i]) >>> 0;

const header = Buffer.alloc(24);
header.writeUInt32LE(A_CNXN, 0);
header.writeUInt32LE(ADB_VERSION, 4);
header.writeUInt32LE(ADB_MAX_DATA, 8);
header.writeUInt32LE(payload.length, 12);
header.writeUInt32LE(sum, 16);
header.writeUInt32LE((A_CNXN ^ 0xffffffff) >>> 0, 20);

const packet = Buffer.concat([header, payload]);
console.log('length:', packet.length);
console.log('hex:   ', packet.toString('hex'));
