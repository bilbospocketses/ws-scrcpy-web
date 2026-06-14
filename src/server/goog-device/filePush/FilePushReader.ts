import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CommandControlMessage, FilePushState } from '../../../app/controlMessage/CommandControlMessage';
import { FilePushResponseStatus } from '../../../app/googDevice/filePush/FilePushResponseStatus';
import { AdbClient } from '../../AdbClient';
import { Config } from '../../Config';
import { Logger } from '../../Logger';
import { assertSafeRemotePath } from '../../security/deviceInput';

enum State {
    INITIAL = 0,
    NEW = 1,
    START = 2,
    APPEND = 3,
    FINISH = 4,
    CANCEL = 5,
}

export class FilePushReader {
    private static fileId = 1;
    private static maxId = 4294967295; // 2^32 - 1

    public static handle(serial: string, channel: WebSocket): FilePushReader {
        return new FilePushReader(serial, channel);
    }

    public static getNextId(): number {
        this.fileId++;
        if (this.fileId > this.maxId) {
            this.fileId = 1;
        }
        return this.fileId;
    }

    private static createResponse(id: number, code: number): Buffer {
        const buffer = Buffer.alloc(3);
        let offset = 0;
        offset = buffer.writeInt16BE(id, offset);
        buffer.writeInt8(code, offset);
        return buffer;
    }

    private adbClient = new AdbClient(Config.getInstance().adbPath);
    private fileName = '';
    private pushId = -1;
    private state: State = State.INITIAL;
    private tempFilePath = '';
    private writeStream?: fs.WriteStream | undefined;
    private disposed = false;

    constructor(
        private readonly serial: string,
        private readonly channel: WebSocket,
    ) {
        channel.addEventListener('message', this.onMessage);
        channel.addEventListener('close', this.onClose);
    }

    private verifyId(id: number): boolean {
        if (id !== this.pushId) {
            this.closeWithError(FilePushResponseStatus.ERROR_UNKNOWN_ID);
            return false;
        }
        return true;
    }

    private sendResponse(status: FilePushResponseStatus): void {
        if (this.channel.readyState === this.channel.CLOSING || this.channel.readyState === this.channel.CLOSED) {
            return;
        }
        this.channel.send(FilePushReader.createResponse(this.pushId, status) as unknown as BufferSource);
    }

    private closeWithError(code: number, message?: string): void {
        this.channel.removeEventListener('message', this.onMessage);
        this.channel.removeEventListener('close', this.onClose);
        this.channel.close(4000 - code, message);
        this.release();
    }

    private onMessage = async (event: MessageEvent): Promise<void> => {
        const command = CommandControlMessage.pushFileCommandFromData(new Uint8Array(event.data as ArrayBuffer));

        const { id, state } = command;
        switch (state) {
            case FilePushState.NEW:
                if (this.state !== State.INITIAL) {
                    this.closeWithError(FilePushResponseStatus.ERROR_INVALID_STATE);
                    return;
                }
                this.state = State.NEW;
                this.pushId = FilePushReader.getNextId();
                this.sendResponse(FilePushResponseStatus.NEW_PUSH_ID);
                break;
            case FilePushState.START: {
                if (!this.verifyId(id)) {
                    return;
                }
                if (this.state !== State.NEW) {
                    this.closeWithError(FilePushResponseStatus.ERROR_INVALID_STATE);
                    return;
                }
                const { fileName, fileSize } = command;
                // The destination is passed to `adb push` as an argv element, so
                // reject an empty/NUL value or a leading "-" (adb option injection)
                // before using it.
                let safeFileName: string;
                try {
                    safeFileName = assertSafeRemotePath(fileName);
                } catch {
                    this.closeWithError(FilePushResponseStatus.ERROR_INVALID_NAME);
                    return;
                }
                if (!fileSize) {
                    this.closeWithError(FilePushResponseStatus.ERROR_INCORRECT_SIZE);
                    return;
                }
                this.fileName = safeFileName;
                this.state = State.START;
                // Create a temp file to accumulate chunks
                this.tempFilePath = path.join(os.tmpdir(), `adb_push_${this.pushId}_${Date.now()}`);
                this.writeStream = fs.createWriteStream(this.tempFilePath);
                this.sendResponse(FilePushResponseStatus.NO_ERROR);
                break;
            }
            case FilePushState.APPEND: {
                if (!this.verifyId(id)) {
                    return;
                }
                const { chunk } = command;
                if (!chunk || !chunk.length) {
                    this.closeWithError(FilePushResponseStatus.ERROR_INCORRECT_SIZE);
                    return;
                }
                if (this.state === State.START) {
                    this.state = State.APPEND;
                } else if (this.state !== State.APPEND) {
                    this.closeWithError(FilePushResponseStatus.ERROR_INVALID_STATE);
                    return;
                }
                if (this.writeStream) {
                    this.writeStream.write(chunk);
                }
                this.sendResponse(FilePushResponseStatus.NO_ERROR);
                break;
            }
            case FilePushState.FINISH:
                if (!this.verifyId(id)) {
                    return;
                }
                if (this.state !== State.APPEND) {
                    this.closeWithError(FilePushResponseStatus.ERROR_INVALID_STATE);
                    return;
                }
                this.state = State.FINISH;
                if (this.writeStream) {
                    await new Promise<void>((resolve) => {
                        this.writeStream!.end(() => resolve());
                    });
                    this.writeStream = undefined;
                }
                // Push temp file to device. §25 — using-declaration replaces
                // the prior try/finally cleanupTempFile. Inline because
                // cleanupTempFile is an existing instance method we don't
                // want to surface as a public Disposable on the reader; the
                // dispose fires on every exit path including the early
                // `return` inside the catch.
                {
                    using _tempFileCleanup = {
                        [Symbol.dispose]: (): void => {
                            this.cleanupTempFile();
                        },
                    };
                    try {
                        await this.adbClient.push(this.serial, this.tempFilePath, this.fileName);
                        this.sendResponse(FilePushResponseStatus.NO_ERROR);
                    } catch (error: any) {
                        Logger.for('FilePushReader').error(`Push error (${this.serial} | ${this.fileName}):`, error.message);
                        this.closeWithError(FilePushResponseStatus.ERROR_OTHER, error.message);
                        return;
                    }
                }
                this.release();
                break;
            case FilePushState.CANCEL:
                if (!this.verifyId(id)) {
                    return;
                }
                this.state = State.CANCEL;
                if (this.writeStream) {
                    this.writeStream.end();
                    this.writeStream = undefined;
                }
                this.cleanupTempFile();
                this.sendResponse(FilePushResponseStatus.NO_ERROR);
                this.release();
                break;
            default:
                if (!this.verifyId(id)) {
                    return;
                }
                this.closeWithError(FilePushResponseStatus.ERROR_INVALID_STATE);
        }
    };

    private cleanupTempFile(): void {
        if (this.tempFilePath) {
            try {
                fs.unlinkSync(this.tempFilePath);
            } catch {
                // ignore
            }
            this.tempFilePath = '';
        }
    }

    private onClose = (): void => {
        this.release();
    };

    public release(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        if (this.writeStream) {
            this.writeStream.end();
            this.writeStream = undefined;
        }
        this.cleanupTempFile();
        this.channel.removeEventListener('message', this.onMessage);
        this.channel.removeEventListener('close', this.onClose);
        const { readyState, CLOSED, CLOSING } = this.channel;
        if (readyState !== CLOSED && readyState !== CLOSING) {
            this.channel.close();
        }
    }
}
