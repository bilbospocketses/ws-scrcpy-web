import type { ParamsStreamScrcpy } from '../../../types/ParamsStreamScrcpy';
import type { BasePlayer } from '../../player/BasePlayer';
import type VideoSettings from '../../VideoSettings';
import { Modal } from '../../ui/Modal';
import { startStream } from '../../public/startStream';
import type { StreamHandle } from '../../public/types';

export class ConnectModal extends Modal {
    private handle?: StreamHandle;

    constructor(
        params: ParamsStreamScrcpy,
        _player: BasePlayer,
        _fitToScreen: boolean,
        videoSettings: VideoSettings,
        deviceLabel: string,
        deviceKind?: 'phone' | 'tablet' | 'tv',
    ) {
        super({ title: deviceLabel });
        this.dialog.classList.add('connect-modal');

        const bounds = videoSettings.bounds;
        const maxDim = bounds ? Math.max(bounds.width, bounds.height) : 0;
        const maxSize = maxDim > 0 ? maxDim : undefined;

        const codec = normalizeCodec(params.videoCodec);

        this.handle = startStream(this.bodyEl, params.udid, {
            host: params.hostname || undefined,
            port: params.port || undefined,
            secure: params.secure || undefined,
            pathname: params.pathname || undefined,
            codec,
            encoder: params.encoderName,
            bitrate: videoSettings.bitrate || undefined,
            maxFps: videoSettings.maxFps || undefined,
            maxSize,
            audio: params.audioEnabled,
            audioSource: params.audioSource,
            audioCodec: params.audioCodec as 'opus' | 'aac' | 'flac' | 'raw' | undefined,
            keyboard: true,
            deviceKind,
            onDisconnect: () => this.close(),
            onError: (err) => {
                console.error('[ConnectModal]', err);
                // Show the error inline for a few seconds so the user sees why the stream failed
                const errorEl = document.createElement('div');
                errorEl.className = 'connect-modal-error';
                errorEl.textContent = `stream failed: ${err.message}`;
                errorEl.style.cssText = 'padding: 24px; color: #f06c75; font-family: monospace; font-size: 14px; text-align: center;';
                this.bodyEl.innerHTML = '';
                this.bodyEl.appendChild(errorEl);
                // Close after 4s (long enough to read, short enough not to feel stuck)
                setTimeout(() => this.close(), 4000);
            },
        });
    }

    protected buildBody(_container: HTMLElement): void {
        // Empty — startStream populates the container after super() completes
    }

    protected override onEscapeKey(_event: Event): void {
        // Block — UHID keyboard capture needs Escape
    }

    protected override onBackdropClick(_event: MouseEvent): void {
        // Block — protect stream from accidental close
    }

    protected override onBeforeClose(): void {
        this.handle?.stop();
        this.handle = undefined;
    }
}

function normalizeCodec(codec: string | undefined): 'h264' | 'h265' | 'av1' | undefined {
    if (codec === 'h264' || codec === 'h265' || codec === 'av1') return codec;
    return undefined;
}
