import { BinaryReader } from './BinaryReader';
import { BinaryWriter } from './BinaryWriter';
import Rect from './Rect';
import Size from './Size';
import Util from './Util';

interface Settings {
    crop?: Rect | null;
    bitrate: number;
    bounds?: Size | null;
    maxFps: number;
    iFrameInterval: number;
    sendFrameMeta?: boolean;
    lockedVideoOrientation?: number;
    displayId?: number;
    codecOptions?: string;
    encoderName?: string;
}

export default class VideoSettings {
    public static readonly BASE_BUFFER_LENGTH: number = 35;
    public readonly crop?: Rect | null = null;
    public readonly bitrate: number = 0;
    public readonly bounds?: Size | null = null;
    public readonly maxFps: number = 0;
    public readonly iFrameInterval: number = 0;
    public readonly sendFrameMeta: boolean = false;
    public readonly lockedVideoOrientation: number = -1;
    public readonly displayId: number = 0;
    public readonly codecOptions?: string;
    public readonly encoderName?: string;

    constructor(
        data?: Settings,
        public readonly bytesLength: number = VideoSettings.BASE_BUFFER_LENGTH,
    ) {
        if (data) {
            this.crop = data.crop;
            this.bitrate = data.bitrate;
            this.bounds = data.bounds;
            this.maxFps = data.maxFps;
            this.iFrameInterval = data.iFrameInterval;
            this.sendFrameMeta = data.sendFrameMeta || false;
            this.lockedVideoOrientation = data.lockedVideoOrientation || -1;
            if (typeof data.displayId === 'number' && !isNaN(data.displayId) && data.displayId >= 0) {
                this.displayId = data.displayId;
            }
            if (data.codecOptions) {
                this.codecOptions = data.codecOptions.trim();
            }
            if (data.encoderName) {
                this.encoderName = data.encoderName.trim();
            }
        }
    }

    public static fromUint8Array(data: Uint8Array): VideoSettings {
        const reader = new BinaryReader(data);
        const bitrate = reader.readInt32BE();
        const maxFps = reader.readInt32BE();
        const iFrameInterval = reader.readInt8();
        const width = reader.readInt16BE();
        const height = reader.readInt16BE();
        const left = reader.readInt16BE();
        const top = reader.readInt16BE();
        const right = reader.readInt16BE();
        const bottom = reader.readInt16BE();
        const sendFrameMeta = !!reader.readInt8();
        const lockedVideoOrientation = reader.readInt8();
        const displayId = reader.readInt32BE();
        let bounds: Size | null = null;
        let crop: Rect | null = null;
        if (width !== 0 && height !== 0) {
            bounds = new Size(width, height);
        }
        if (left || top || right || bottom) {
            crop = new Rect(left, top, right, bottom);
        }
        let codecOptions;
        let encoderName;
        const codecOptionsLength = reader.readInt32BE();
        if (codecOptionsLength) {
            const codecOptionsBytes = reader.readBytes(codecOptionsLength);
            codecOptions = Util.utf8ByteArrayToString(codecOptionsBytes);
        }
        const encoderNameLength = reader.readInt32BE();
        if (encoderNameLength) {
            const encoderNameBytes = reader.readBytes(encoderNameLength);
            encoderName = Util.utf8ByteArrayToString(encoderNameBytes);
        }
        return new VideoSettings(
            {
                crop,
                bitrate,
                bounds,
                maxFps,
                iFrameInterval,
                lockedVideoOrientation,
                displayId,
                sendFrameMeta,
                codecOptions,
                encoderName,
            },
            reader.offset,
        );
    }

    public static copy(a: VideoSettings): VideoSettings {
        return new VideoSettings(
            {
                bitrate: a.bitrate,
                crop: Rect.copy(a.crop),
                bounds: Size.copy(a.bounds),
                maxFps: a.maxFps,
                iFrameInterval: a.iFrameInterval,
                lockedVideoOrientation: a.lockedVideoOrientation,
                displayId: a.displayId,
                sendFrameMeta: a.sendFrameMeta,
                codecOptions: a.codecOptions,
                encoderName: a.encoderName,
            },
            a.bytesLength,
        );
    }

    public equals(o?: VideoSettings | null): boolean {
        if (!o) {
            return false;
        }
        return (
            this.encoderName === o.encoderName &&
            this.codecOptions === o.codecOptions &&
            Rect.equals(this.crop, o.crop) &&
            this.lockedVideoOrientation === o.lockedVideoOrientation &&
            this.displayId === o.displayId &&
            Size.equals(this.bounds, o.bounds) &&
            this.bitrate === o.bitrate &&
            this.maxFps === o.maxFps &&
            this.iFrameInterval === o.iFrameInterval
        );
    }

    public toUint8Array(): Uint8Array {
        let additionalLength = 0;
        let codecOptionsBytes;
        let encoderNameBytes;
        if (this.codecOptions) {
            codecOptionsBytes = Util.stringToUtf8ByteArray(this.codecOptions);
            additionalLength += codecOptionsBytes.length;
        }
        if (this.encoderName) {
            encoderNameBytes = Util.stringToUtf8ByteArray(this.encoderName);
            additionalLength += encoderNameBytes.length;
        }
        const writer = new BinaryWriter(VideoSettings.BASE_BUFFER_LENGTH + additionalLength);
        const { width = 0, height = 0 } = this.bounds || {};
        const { left = 0, top = 0, right = 0, bottom = 0 } = this.crop || {};
        writer
            .writeInt32BE(this.bitrate)
            .writeInt32BE(this.maxFps)
            .writeInt8(this.iFrameInterval)
            .writeInt16BE(width)
            .writeInt16BE(height)
            .writeInt16BE(left)
            .writeInt16BE(top)
            .writeInt16BE(right)
            .writeInt16BE(bottom)
            .writeInt8(this.sendFrameMeta ? 1 : 0)
            .writeInt8(this.lockedVideoOrientation)
            .writeInt32BE(this.displayId);
        if (codecOptionsBytes) {
            writer.writeInt32BE(codecOptionsBytes.length).writeBytes(codecOptionsBytes);
        } else {
            writer.writeInt32BE(0);
        }
        if (encoderNameBytes) {
            writer.writeInt32BE(encoderNameBytes.length).writeBytes(encoderNameBytes);
        } else {
            writer.writeInt32BE(0);
        }
        return writer.toUint8Array();
    }

    public toString(): string {
        // prettier-ignore
        return `VideoSettings{bitrate=${this.bitrate}, maxFps=${this.maxFps}, iFrameInterval=${
            this.iFrameInterval
        }, bounds=${this.bounds}, crop=${this.crop}, metaFrame=${this.sendFrameMeta}, lockedVideoOrientation=${
            this.lockedVideoOrientation
        }, displayId=${this.displayId}, codecOptions=${this.codecOptions}, encoderName=${this.encoderName}}`;
    }

    public toJSON(): Settings {
        return {
            bitrate: this.bitrate,
            maxFps: this.maxFps,
            iFrameInterval: this.iFrameInterval,
            bounds: this.bounds,
            crop: this.crop,
            sendFrameMeta: this.sendFrameMeta,
            lockedVideoOrientation: this.lockedVideoOrientation,
            displayId: this.displayId,
            codecOptions: this.codecOptions,
            encoderName: this.encoderName,
        };
    }
}
