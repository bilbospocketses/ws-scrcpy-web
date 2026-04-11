// src/app/audio/AudioPlayer.ts
import { PCM_WORKLET_NAME, PCM_WORKLET_SOURCE } from './PcmWorklet';

export class AudioPlayer {
    private audioContext?: AudioContext;
    private decoder?: AudioDecoder;
    private workletNode?: AudioWorkletNode;
    private gainNode?: GainNode;
    private started = false;
    private workletReady = false;

    constructor(private readonly codec = 'opus') {}

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

        // Configure audio decoder
        this.decoder = new AudioDecoder({
            output: (audioData: AudioData) => {
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
            },
            error: (err: DOMException) => {
                console.error('[AudioPlayer] Decoder error:', err.message);
            },
        });

        this.decoder.configure({
            codec: this.codec,
            sampleRate: 48000,
            numberOfChannels: 2,
        });
    }

    pushFrame(data: Uint8Array, pts: bigint, isConfig: boolean): void {
        if (isConfig || !this.decoder || this.decoder.state !== 'configured') {
            return; // Skip config packets; Opus frames are self-contained
        }
        this.decoder.decode(
            new EncodedAudioChunk({
                type: 'key', // All Opus frames are independent
                timestamp: Number(pts),
                data,
            }),
        );
    }

    /** Resume AudioContext after user interaction (autoplay policy). */
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
    }
}
