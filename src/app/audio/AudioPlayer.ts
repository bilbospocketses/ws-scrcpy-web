// src/app/audio/AudioPlayer.ts
import { PCM_WORKLET_NAME, PCM_WORKLET_SOURCE } from './PcmWorklet';

export class AudioPlayer {
    private audioContext?: AudioContext;
    private decoder?: AudioDecoder;
    private workletNode?: AudioWorkletNode;
    private gainNode?: GainNode;
    private started = false;
    private workletReady = false;
    private configData?: Uint8Array;

    constructor(private readonly codec: string) {}

    async start(): Promise<void> {
        if (this.started) return;
        this.started = true;

        this.audioContext = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });

        // Load worklet via Blob URL
        const blob = new Blob([PCM_WORKLET_SOURCE], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        await this.audioContext.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);

        this.workletNode = new AudioWorkletNode(this.audioContext, PCM_WORKLET_NAME, {
            outputChannelCount: [2],
        });
        this.gainNode = this.audioContext.createGain();
        this.workletNode.connect(this.gainNode);
        this.gainNode.connect(this.audioContext.destination);
        this.workletReady = true;

        // Raw PCM doesn't need a decoder
        if (this.codec === 'raw') return;

        // Configure audio decoder
        this.decoder = new AudioDecoder({
            output: (audioData: AudioData) => {
                this.postDecodedAudio(audioData);
            },
            error: (err: DOMException) => {
                console.error('[AudioPlayer] Decoder error:', err.message);
            },
        });

        this.configureDecoder();
    }

    private configureDecoder(): void {
        if (!this.decoder) return;

        const config: AudioDecoderConfig = {
            codec: this.webCodecsCodecString(),
            sampleRate: 48000,
            numberOfChannels: 2,
        };

        // AAC and FLAC need the config packet as description
        if ((this.codec === 'aac' || this.codec === 'flac') && this.configData) {
            config.description = this.configData;
        }

        // Opus is self-contained; configure immediately
        // AAC/FLAC configure after receiving config packet (configureDecoder called from pushFrame)
        if (this.codec === 'opus' || this.configData) {
            this.decoder.configure(config);
        }
    }

    private webCodecsCodecString(): string {
        switch (this.codec) {
            case 'opus':
                return 'opus';
            case 'aac':
                return 'mp4a.40.2';
            case 'flac':
                return 'flac';
            default:
                return this.codec;
        }
    }

    private postDecodedAudio(audioData: AudioData): void {
        if (!this.workletReady) {
            audioData.close();
            return;
        }
        const numChannels = audioData.numberOfChannels;
        const numFrames = audioData.numberOfFrames;
        const channels: Float32Array[] = [];
        for (let ch = 0; ch < numChannels; ch++) {
            const channelData = new Float32Array(numFrames);
            audioData.copyTo(channelData, { planeIndex: ch, format: 'f32-planar' });
            channels.push(channelData);
        }
        audioData.close();
        this.workletNode!.port.postMessage(
            { channels, numFrames },
            channels.map((c) => c.buffer),
        );
    }

    pushFrame(data: Uint8Array, pts: bigint, isConfig: boolean): void {
        if (this.codec === 'raw') {
            this.pushRawPcm(data);
            return;
        }

        if (isConfig) {
            this.configData = new Uint8Array(data);
            // For AAC/FLAC, (re)configure decoder now that we have the config
            if (this.codec === 'aac' || this.codec === 'flac') {
                this.configureDecoder();
            }
            return;
        }

        if (!this.decoder || this.decoder.state !== 'configured') return;

        this.decoder.decode(
            new EncodedAudioChunk({
                type: 'key',
                timestamp: Number(pts),
                data,
            }),
        );
    }

    /** Raw PCM: convert S16LE samples to Float32 and post directly to worklet. */
    private pushRawPcm(data: Uint8Array): void {
        if (!this.workletReady) return;

        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const sampleCount = (data.byteLength / 2) | 0;
        const channelCount = 2;
        const framesPerChannel = (sampleCount / channelCount) | 0;

        const channels: Float32Array[] = [];
        for (let ch = 0; ch < channelCount; ch++) {
            channels.push(new Float32Array(framesPerChannel));
        }

        for (let i = 0; i < framesPerChannel; i++) {
            for (let ch = 0; ch < channelCount; ch++) {
                const sampleIndex = i * channelCount + ch;
                const int16 = view.getInt16(sampleIndex * 2, true);
                channels[ch][i] = int16 / 32768;
            }
        }

        this.workletNode!.port.postMessage(
            { channels, numFrames: framesPerChannel },
            channels.map((c) => c.buffer),
        );
    }

    async resume(): Promise<void> {
        if (this.audioContext?.state === 'suspended') {
            await this.audioContext.resume();
        }
    }

    setVolume(volume: number): void {
        if (this.gainNode) {
            this.gainNode.gain.value = Math.max(0, Math.min(1, volume));
        }
    }

    stop(): void {
        if (this.decoder && this.decoder.state !== 'closed') {
            this.decoder.close();
        }
        this.workletNode?.disconnect();
        this.gainNode?.disconnect();
        this.audioContext?.close();
        this.started = false;
        this.workletReady = false;
        this.configData = undefined;
    }
}
