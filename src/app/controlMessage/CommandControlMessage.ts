import { BinaryReader } from '../BinaryReader';
import { BinaryWriter } from '../BinaryWriter';
import type VideoSettings from '../VideoSettings';
import { ControlMessage } from './ControlMessage';

export enum FilePushState {
    NEW = 0,
    START = 1,
    APPEND = 2,
    FINISH = 3,
    CANCEL = 4,
}

type FilePushParams = {
    id: number;
    state: FilePushState;
    chunk?: Uint8Array;
    fileName?: string;
    fileSize?: number;
};

export class CommandControlMessage extends ControlMessage {
    public static PAYLOAD_LENGTH = 0;

    public static Commands: Map<number, string> = new Map([
        [ControlMessage.TYPE_EXPAND_NOTIFICATION_PANEL, 'Expand notifications'],
        [ControlMessage.TYPE_EXPAND_SETTINGS_PANEL, 'Expand settings'],
        [ControlMessage.TYPE_COLLAPSE_PANELS, 'Collapse panels'],
        [ControlMessage.TYPE_GET_CLIPBOARD, 'Get clipboard'],
        [ControlMessage.TYPE_SET_CLIPBOARD, 'Set clipboard'],
        [ControlMessage.TYPE_ROTATE_DEVICE, 'Rotate device'],
        [ControlMessage.TYPE_CHANGE_STREAM_PARAMETERS, 'Change video settings'],
    ]);

    public static createSetVideoSettingsCommand(videoSettings: VideoSettings): CommandControlMessage {
        const temp = videoSettings.toUint8Array();
        const event = new CommandControlMessage(ControlMessage.TYPE_CHANGE_STREAM_PARAMETERS);
        const size = CommandControlMessage.PAYLOAD_LENGTH + 1 + temp.length;
        event.buffer = new BinaryWriter(size).writeUInt8(event.type).writeBytes(temp).toUint8Array();
        return event;
    }

    // scrcpy GET_CLIPBOARD requires a copy_key byte after the type byte —
    // see scrcpy's ControlMessageReader.parseGetClipboard (reads 1 unsigned byte).
    // Sending the bare type alone (1 byte) leaves the server blocked waiting
    // for the copy_key, which then gets consumed from the next control message
    // and silently misaligns the whole stream until it crashes the session.
    public static COPY_KEY_NONE = 0;
    public static COPY_KEY_COPY = 1;
    public static COPY_KEY_CUT = 2;

    public static createGetClipboardCommand(copyKey = CommandControlMessage.COPY_KEY_NONE): CommandControlMessage {
        const event = new CommandControlMessage(ControlMessage.TYPE_GET_CLIPBOARD);
        event.buffer = new BinaryWriter(1 + 1).writeUInt8(event.type).writeUInt8(copyKey).toUint8Array();
        return event;
    }

    public static createSetClipboardCommand(text: string, paste = false, sequence = 0n): CommandControlMessage {
        const event = new CommandControlMessage(ControlMessage.TYPE_SET_CLIPBOARD);
        const textBytes: Uint8Array | null = text ? new TextEncoder().encode(text) : null;
        const textLength = textBytes ? textBytes.length : 0;
        // type(1) + sequence(8) + paste(1) + textLength(4) + text
        const writer = new BinaryWriter(1 + 8 + 1 + 4 + textLength)
            .writeInt8(event.type)
            .writeBigUInt64BE(BigInt(sequence))
            .writeUInt8(paste ? 1 : 0)
            .writeInt32BE(textLength);
        if (textBytes) {
            writer.writeBytes(textBytes);
        }
        event.buffer = writer.toUint8Array();
        return event;
    }

    public static createSetScreenPowerModeCommand(mode: boolean): CommandControlMessage {
        const event = new CommandControlMessage(ControlMessage.TYPE_SET_SCREEN_POWER_MODE);
        event.buffer = new BinaryWriter(1 + 1)
            .writeInt8(event.type)
            .writeUInt8(mode ? 1 : 0)
            .toUint8Array();
        return event;
    }

    public static createPushFileCommand(params: FilePushParams): CommandControlMessage {
        const { id, fileName, fileSize, chunk, state } = params;

        if (state === FilePushState.START) {
            return this.createPushFileStartCommand(id, fileName as string, fileSize as number);
        }
        if (state === FilePushState.APPEND) {
            if (!chunk) {
                throw TypeError('Invalid type');
            }
            return this.createPushFileChunkCommand(id, chunk);
        }
        if (state === FilePushState.CANCEL || state === FilePushState.FINISH || state === FilePushState.NEW) {
            return this.createPushFileOtherCommand(id, state);
        }

        throw TypeError(`Unsupported state: "${state}"`);
    }

    private static createPushFileStartCommand(id: number, fileName: string, fileSize: number): CommandControlMessage {
        const event = new CommandControlMessage(ControlMessage.TYPE_PUSH_FILE);
        const text = new TextEncoder().encode(fileName);
        const typeField = 1;
        const idField = 2;
        const stateField = 1;
        const sizeField = 4;
        const textLengthField = 2;
        const textLength = text.length;
        const totalSize =
            CommandControlMessage.PAYLOAD_LENGTH +
            typeField +
            idField +
            stateField +
            sizeField +
            textLengthField +
            textLength;
        event.buffer = new BinaryWriter(totalSize)
            .writeUInt8(event.type)
            .writeInt16BE(id)
            .writeInt8(FilePushState.START)
            .writeUInt32BE(fileSize)
            .writeUInt16BE(textLength)
            .writeBytes(text)
            .toUint8Array();
        return event;
    }

    private static createPushFileChunkCommand(id: number, chunk: Uint8Array): CommandControlMessage {
        const event = new CommandControlMessage(ControlMessage.TYPE_PUSH_FILE);
        const typeField = 1;
        const idField = 2;
        const stateField = 1;
        const chunkLengthField = 4;
        const chunkLength = chunk.byteLength;
        const totalSize =
            CommandControlMessage.PAYLOAD_LENGTH + typeField + idField + stateField + chunkLengthField + chunkLength;
        event.buffer = new BinaryWriter(totalSize)
            .writeUInt8(event.type)
            .writeInt16BE(id)
            .writeInt8(FilePushState.APPEND)
            .writeUInt32BE(chunkLength)
            .writeBytes(chunk)
            .toUint8Array();
        return event;
    }

    private static createPushFileOtherCommand(id: number, state: FilePushState): CommandControlMessage {
        const event = new CommandControlMessage(ControlMessage.TYPE_PUSH_FILE);
        const typeField = 1;
        const idField = 2;
        const stateField = 1;
        const totalSize = CommandControlMessage.PAYLOAD_LENGTH + typeField + idField + stateField;
        event.buffer = new BinaryWriter(totalSize)
            .writeUInt8(event.type)
            .writeInt16BE(id)
            .writeInt8(state)
            .toUint8Array();
        return event;
    }

    public static pushFileCommandFromData(data: Uint8Array): {
        id: number;
        state: FilePushState;
        chunk?: Uint8Array;
        fileSize?: number;
        fileName?: string;
    } {
        const reader = new BinaryReader(data);
        const type = reader.readUInt8();
        if (type !== CommandControlMessage.TYPE_PUSH_FILE) {
            throw TypeError(`Incorrect type: "${type}"`);
        }
        const id = reader.readInt16BE();
        const state = reader.readInt8();
        let chunk: Uint8Array | undefined;
        let fileSize: number | undefined;
        let fileName: string | undefined;
        if (state === FilePushState.APPEND) {
            const chunkLength = reader.readUInt32BE();
            chunk = reader.readBytes(chunkLength);
        } else if (state === FilePushState.START) {
            fileSize = reader.readUInt32BE();
            const textLength = reader.readUInt16BE();
            fileName = new TextDecoder().decode(reader.readBytes(textLength));
        }
        return { id, state, chunk, fileName, fileSize };
    }

    private buffer?: Uint8Array;

    constructor(override readonly type: number) {
        super(type);
    }

    /**
     * @override
     */
    public override toUint8Array(): Uint8Array {
        if (!this.buffer) {
            this.buffer = new BinaryWriter(CommandControlMessage.PAYLOAD_LENGTH + 1)
                .writeUInt8(this.type)
                .toUint8Array();
        }
        return this.buffer;
    }

    public override toString(): string {
        const buffer = this.buffer ? `, buffer=[${Array.from(this.buffer).join(',')}]` : '';
        return `CommandControlMessage{action=${this.type}${buffer}}`;
    }
}
