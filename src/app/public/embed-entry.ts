/**
 * embed.html entry script. Parses URL params and calls WsScrcpy.startStream.
 * Built as a standalone IIFE bundle and shipped as embed.js.
 */

import { startStream } from './startStream';
import type { StartStreamOptions } from './types';

const CODECS = new Set(['h264', 'h265', 'av1']);

export function parseEmbedParams(params: URLSearchParams): {
    deviceId: string | null;
    options: StartStreamOptions;
} {
    const deviceId = params.get('device');
    const options: StartStreamOptions = {};

    const readStr = (key: keyof StartStreamOptions) => {
        const v = params.get(key as string);
        if (v) (options as Record<string, unknown>)[key] = v;
    };
    const readInt = (key: keyof StartStreamOptions) => {
        const v = params.get(key as string);
        if (!v) return;
        const n = parseInt(v, 10);
        if (!Number.isNaN(n)) (options as Record<string, unknown>)[key] = n;
    };
    const readBool = (key: keyof StartStreamOptions) => {
        const v = params.get(key as string);
        if (v === 'true') (options as Record<string, unknown>)[key] = true;
        else if (v === 'false') (options as Record<string, unknown>)[key] = false;
    };

    readStr('host');
    readStr('encoder');
    readStr('pathname');

    const codec = params.get('codec');
    if (codec && CODECS.has(codec)) options.codec = codec as StartStreamOptions['codec'];

    readInt('port');
    readInt('bitrate');
    readInt('maxFps');
    readInt('maxSize');

    readBool('secure');
    readBool('audio');
    readBool('keyboard');

    return { deviceId: deviceId ?? null, options };
}

// Only run the bootstrap when this script is loaded by embed.html.
// embed.html sets <body data-embed-entry> as an explicit opt-in marker;
// tests and any other importer never set it, so bootstrap stays dormant.
function shouldBootstrap(): boolean {
    return typeof document !== 'undefined'
        && document.body?.hasAttribute('data-embed-entry') === true;
}

if (typeof document !== 'undefined' && document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () => {
        if (shouldBootstrap()) bootstrap();
    });
} else if (shouldBootstrap()) {
    bootstrap();
}

function bootstrap(): void {
    const statusEl = document.getElementById('status');
    const show = (msg: string, isError = false) => {
        if (!statusEl) return;
        statusEl.textContent = msg;
        statusEl.classList.remove('hidden');
        statusEl.style.color = isError ? '#f06c75' : '#ddd';
    };
    const hide = () => statusEl?.classList.add('hidden');

    const { deviceId, options } = parseEmbedParams(new URLSearchParams(location.search));
    if (!deviceId) {
        show('missing required "device" param', true);
        return;
    }

    options.onConnect = (info) => {
        show(`connected \u00b7 ${info.codec} \u00b7 ${info.resolution}`);
        setTimeout(hide, 2000);
    };
    options.onDisconnect = (reason) => show(`disconnected${reason ? ` (${reason})` : ''}`, true);
    options.onError = (err) => show(`error: ${err.message}`, true);

    try {
        startStream(document.body, deviceId, options);
    } catch (err) {
        show(`error: ${err instanceof Error ? err.message : String(err)}`, true);
    }
}
