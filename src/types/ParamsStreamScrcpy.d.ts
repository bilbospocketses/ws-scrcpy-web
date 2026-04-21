import type VideoSettings from '../app/VideoSettings';
import type { ACTION } from '../common/Action';
import type { ParamsStream } from './ParamsStream';

export interface ParamsStreamScrcpy extends ParamsStream {
    action: ACTION.STREAM_SCRCPY;
    ws?: string;
    fitToScreen?: boolean;
    videoSettings?: VideoSettings;
    videoCodec?: string;
    audioCodec?: string;
    audioEnabled?: boolean;
    audioSource?: 'playback' | 'output' | 'mic';
    encoderName?: string;
}
