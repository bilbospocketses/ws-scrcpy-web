// Standalone test: single-connection ADB CNXN probe.
// Opens ONE TCP socket, sends CNXN, reads the reply. No double-connect.
// Usage: node scripts/test-probe-single.js <host> [port]
// Example: node scripts/test-probe-single.js 192.168.86.231
const net = require('net');

const host = process.argv[2];
const port = parseInt(process.argv[3] || '5555', 10);
if (!host) {
    console.error('usage: node scripts/test-probe-single.js <host> [port]');
    process.exit(1);
}

const A_CNXN = 0x4e584e43;
const ADB_VERSION = 0x01000001;
const ADB_MAX_DATA = 0x00100000;
const HEADER_SIZE = 24;

const BANNER =
    'host::features=shell_v2,cmd,stat_v2,ls_v2,fixed_push_mkdir,apex,abb,' +
    'fixed_push_symlink_timestamp,abb_exec,remount_shell,track_app,' +
    'sendrecv_v2,sendrecv_v2_brotli,sendrecv_v2_lz4,sendrecv_v2_zstd,' +
    'sendrecv_v2_dry_run_send,openscreen_mdns,devicetracker_proto_format,' +
    'devraw,app_info,server_status,track_mdns';

function buildCnxnPacket() {
    const payload = Buffer.from(BANNER, 'utf8');
    let sum = 0;
    for (let i = 0; i < payload.length; i++) sum = (sum + payload[i]) >>> 0;
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt32LE(A_CNXN, 0);
    header.writeUInt32LE(ADB_VERSION, 4);
    header.writeUInt32LE(ADB_MAX_DATA, 8);
    header.writeUInt32LE(payload.length, 12);
    header.writeUInt32LE(sum, 16);
    header.writeUInt32LE((A_CNXN ^ 0xffffffff) >>> 0, 20);
    return Buffer.concat([header, payload]);
}

const CONNECT_TIMEOUT_MS = 1000;
const REPLY_TIMEOUT_MS = 5000;

const socket = new net.Socket();
const chunks = [];
let settled = false;
let phase = 'connecting';
let timer;

function done(reason) {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    const all = Buffer.concat(chunks);
    console.log('--- RESULT ---');
    console.log('phase at resolution:', phase);
    console.log('reason:', reason);
    console.log('bytes received:', all.length);
    if (all.length > 0) console.log('hex:', all.toString('hex'));
    if (all.length >= HEADER_SIZE) {
        const cmd = all.readUInt32LE(0);
        console.log('reply command: 0x' + cmd.toString(16),
            cmd === A_CNXN ? '(CNXN)' : cmd === 0x48545541 ? '(AUTH)' : '(unknown)');
    }
    try { socket.destroy(); } catch {}
    process.exit(all.length >= HEADER_SIZE ? 0 : 1);
}

timer = setTimeout(() => done('connect timeout'), CONNECT_TIMEOUT_MS);

socket.on('error', (err) => done('error: ' + err.message));
socket.on('end', () => done('remote sent FIN'));
socket.on('close', () => done('socket closed'));
socket.on('data', (chunk) => {
    chunks.push(chunk);
    const all = Buffer.concat(chunks);
    console.log('[' + new Date().toISOString() + '] rx', chunk.length, 'bytes (total', all.length + ')');
});
socket.once('connect', () => {
    console.log('[' + new Date().toISOString() + '] TCP connected to', host + ':' + port);
    phase = 'waiting for reply';
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => done('reply timeout'), REPLY_TIMEOUT_MS);
    try { socket.setNoDelay(true); } catch {}
    const pkt = buildCnxnPacket();
    console.log('[' + new Date().toISOString() + '] sending', pkt.length, 'bytes CNXN');
    socket.write(pkt);
});

console.log('[' + new Date().toISOString() + '] connecting to', host + ':' + port, '...');
socket.connect(port, host);
