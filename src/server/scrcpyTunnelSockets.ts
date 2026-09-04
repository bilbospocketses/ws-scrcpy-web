import net from 'net';
import { AUDIO_DISABLED } from '../common/ScrcpyCodec';

/**
 * scrcpy-server opens its sockets in a fixed order — video, then audio (only
 * when audio is enabled), then control — and the rest of the pipeline reads
 * that triple positionally. These helpers keep the forward and reverse tunnel
 * paths agreeing on both halves of that: how many connections to expect, and
 * how to present a consistent [video, audio, control] triple when audio is off.
 */

/** How many TCP connections scrcpy-server will make for these options. */
export function expectedTunnelSocketCount(audioEnabled: boolean): number {
    return audioEnabled ? 3 : 2;
}

/**
 * A synthetic audio socket carrying a 4-byte AUDIO_DISABLED status, so
 * parseMetadata keeps the same shape without needing an audio-off special case.
 */
export function createAudioDisabledSocket(): net.Socket {
    const socket = new net.Socket();
    const status = Buffer.alloc(4);
    status.writeUInt32BE(AUDIO_DISABLED, 0);
    socket.unshift(status);
    return socket;
}

/**
 * Normalise the sockets accepted on the reverse tunnel to the positional
 * [video, audio, control] triple. With audio off only video and control arrive,
 * so the synthetic status socket is spliced into slot 1 — the same substitution
 * the forward path makes inline.
 */
export function assembleReverseTunnelSockets(accepted: net.Socket[], audioEnabled: boolean): net.Socket[] {
    if (audioEnabled) return accepted;
    const [videoSocket, controlSocket] = accepted;
    if (!videoSocket || !controlSocket) return accepted;
    return [videoSocket, createAudioDisabledSocket(), controlSocket];
}
