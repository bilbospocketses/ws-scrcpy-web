import type VideoSettings from '../app/VideoSettings';
import type { ACTION } from '../common/Action';
import type { ParamsStream } from './ParamsStream';

export interface ParamsStreamScrcpy extends ParamsStream {
    action: ACTION.STREAM_SCRCPY;
    ws?: string | undefined;
    fitToScreen?: boolean | undefined;
    videoSettings?: VideoSettings | undefined;
    videoCodec?: string | undefined;
    audioCodec?: string | undefined;
    audioEnabled?: boolean | undefined;
    audioSource?: 'playback' | 'output' | 'mic' | undefined;
    encoderName?: string | undefined;
}
