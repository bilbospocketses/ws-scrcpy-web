import net from 'net';
import { describe, expect, it } from 'vitest';
import { AUDIO_DISABLED } from '../../common/ScrcpyCodec';
import {
    assembleReverseTunnelSockets,
    createAudioDisabledSocket,
    expectedTunnelSocketCount,
} from '../scrcpyTunnelSockets';

// Finding 8.13 — with audio=false the reverse-tunnel path still waited for
// three TCP connections and closed the WebSocket with
// `4005 Timeout waiting for 3 TCP connections (got 2)`. scrcpy-server skips the
// audio connect when audio is off, so only video and control arrive. The
// forward-tunnel path already got this right; the reverse path is what the app
// prefers.
describe('reverse-tunnel socket expectations', () => {
    it('expects three sockets with audio on and two with audio off', () => {
        expect(expectedTunnelSocketCount(true)).toBe(3);
        expect(expectedTunnelSocketCount(false)).toBe(2);
    });

    it('passes the accepted sockets straight through when audio is on', () => {
        const accepted = [new net.Socket(), new net.Socket(), new net.Socket()];
        expect(assembleReverseTunnelSockets(accepted, true)).toEqual(accepted);
    });

    it('splices the synthetic audio socket between video and control when audio is off', () => {
        const video = new net.Socket();
        const control = new net.Socket();

        const sockets = assembleReverseTunnelSockets([video, control], false);

        // parseMetadata reads the triple positionally, so the synthetic socket
        // has to land in slot 1 — handing it the control socket there would
        // desynchronise the whole stream.
        expect(sockets).toHaveLength(3);
        expect(sockets[0]).toBe(video);
        expect(sockets[2]).toBe(control);
        expect(sockets[1]).not.toBe(control);
    });

    it('gives the synthetic socket a readable 4-byte AUDIO_DISABLED status', () => {
        const socket = createAudioDisabledSocket();
        const status = socket.read(4) as Buffer;
        expect(status).toHaveLength(4);
        expect(status.readUInt32BE(0)).toBe(AUDIO_DISABLED);
    });
});
