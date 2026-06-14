import { execFile } from 'child_process';
import { promisify } from 'util';

import AdbProtocol from '../../common/AdbProtocol';
import type { Multiplexer } from '../../packages/multiplexer/Multiplexer';
import type { FileStats } from '../../types/FileStats';
import { AdbClient } from '../AdbClient';
import { Config } from '../Config';
import { shArg } from '../security/deviceInput';

const execFileAsync = promisify(execFile);

const adbClient = new AdbClient(Config.getInstance().adbPath);

export class AdbUtils {
    public static async push(serial: string, localPath: string, remotePath: string): Promise<void> {
        return adbClient.push(serial, localPath, remotePath);
    }

    /**
     * Stat a remote file via `adb shell stat`.
     * Returns { mode, size, mtime } matching the old adbkit Stats shape.
     */
    private static async statRemote(
        serial: string,
        pathString: string,
    ): Promise<{ mode: number; size: number; mtime: number }> {
        // Use stat with format: mode (octal), size, mtime (epoch)
        const output = await adbClient.shell(
            serial,
            `stat -c '%f %s %Y' ${shArg(pathString)} 2>/dev/null || stat -c '%a %s %Y' ${shArg(pathString)} 2>/dev/null`,
        );
        const parts = output.trim().split(/\s+/);
        if (parts.length >= 3) {
            const mode = Number.parseInt(parts[0]!, 16) || Number.parseInt(parts[0]!, 8) || 0;
            const size = Number.parseInt(parts[1]!, 10) || 0;
            const mtime = Number.parseInt(parts[2]!, 10) || 0;
            return { mode, size, mtime };
        }
        throw new Error(`Failed to stat "${pathString}"`);
    }

    public static async readdir(serial: string, pathString: string): Promise<FileStats[]> {
        // Use ls -la to list directory contents
        const output = await adbClient.shell(serial, `ls -la ${shArg(pathString)}`);
        const entries: FileStats[] = [];
        for (const line of output.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('total')) continue;
            // Parse ls -la output: permissions links owner group size date time name
            const parts = trimmed.split(/\s+/);
            if (parts.length < 7) continue;
            const permissions = parts[0]!;
            // parts.length >= 7 gate confirms parts[3] also exists
            const size = Number.parseInt(parts[3]!, 10) || 0;
            const name = parts.slice(6).join(' ');
            if (name === '.' || name === '..') continue;
            const isDir = permissions.startsWith('d') ? 1 : 0;
            // Try to get mtime
            let dateModified = 0;
            try {
                const dateStr = `${parts[4]} ${parts[5]}`;
                dateModified = new Date(dateStr).getTime();
            } catch {
                // ignore
            }
            entries.push({ name, isDir, size, dateModified });
        }
        return entries;
    }

    /**
     * Pipe stat result to a Multiplexer channel using the ADB sync protocol format.
     * Sends: STAT + 12 bytes (mode:u32le, size:u32le, mtime:u32le)
     */
    public static async pipeStatToStream(serial: string, pathString: string, stream: Multiplexer): Promise<void> {
        try {
            const stat = await this.statRemote(serial, pathString);
            const buf = Buffer.alloc(4 + 12);
            buf.write(AdbProtocol.STAT, 0, 'ascii');
            buf.writeUInt32LE(stat.mode, 4);
            buf.writeUInt32LE(stat.size, 8);
            buf.writeUInt32LE(stat.mtime, 12);
            stream.send(buf);
            stream.close(1000);
        } catch (error: any) {
            const message = error?.message || 'stat failed';
            this.sendError(message, stream);
        }
    }

    /**
     * Pipe directory listing to a Multiplexer channel using the ADB sync protocol format.
     * Sends DENT entries then closes the channel.
     */
    public static async pipeReadDirToStream(serial: string, pathString: string, stream: Multiplexer): Promise<void> {
        try {
            // Use ls -la for listing, then stat each entry for mode/size/mtime
            const output = await adbClient.shell(serial, `ls -1a ${shArg(pathString)}`);
            const names = output
                .split('\n')
                .map((n) => n.trim())
                .filter((n) => n.length > 0);

            for (const name of names) {
                try {
                    const entryPath = pathString.endsWith('/') ? `${pathString}${name}` : `${pathString}/${name}`;
                    let mode = 0;
                    let size = 0;
                    let mtime = 0;
                    try {
                        const stat = await this.statRemote(serial, entryPath);
                        mode = stat.mode;
                        size = stat.size;
                        mtime = stat.mtime;
                    } catch {
                        // If stat fails, try to determine if it's a directory from ls -la
                        const laOutput = await adbClient.shell(serial, `ls -lad ${shArg(entryPath)} 2>/dev/null`);
                        if (laOutput.startsWith('d')) {
                            mode = 0o40755; // directory
                        } else {
                            mode = 0o100644; // regular file
                        }
                    }

                    const nameBytes = Buffer.from(name, 'utf-8');
                    const statBuf = Buffer.alloc(16);
                    statBuf.writeUInt32LE(mode, 0);
                    statBuf.writeUInt32LE(size, 4);
                    statBuf.writeUInt32LE(mtime, 8);
                    statBuf.writeUInt32LE(nameBytes.length, 12);
                    stream.send(Buffer.concat([Buffer.from(AdbProtocol.DENT, 'ascii'), statBuf, nameBytes]));
                } catch {
                    // Skip entries that fail
                }
            }
            stream.close(0);
        } catch (error: any) {
            const message = error?.message || 'readdir failed';
            this.sendError(message, stream);
        }
    }

    /**
     * Pipe file contents to a Multiplexer channel using the ADB sync protocol format.
     * Sends DATA chunks then DONE.
     */
    public static async pipePullFileToStream(serial: string, pathString: string, stream: Multiplexer): Promise<void> {
        try {
            // Use adb exec-out to stream binary file content
            const { stdout } = await execFileAsync(Config.getInstance().adbPath, ['-s', serial, 'exec-out', `cat ${shArg(pathString)}`], {
                maxBuffer: 50 * 1024 * 1024,
                encoding: 'buffer',
            });
            const data = stdout as unknown as Buffer;
            // Send in chunks of 64KB (matches ADB sync protocol typical chunk size)
            const CHUNK_SIZE = 64 * 1024;
            for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
                const chunk = data.slice(offset, Math.min(offset + CHUNK_SIZE, data.length));
                stream.send(Buffer.concat([Buffer.from(AdbProtocol.DATA, 'ascii'), chunk]));
            }
            stream.send(Buffer.from(AdbProtocol.DONE, 'ascii'));
            stream.close();
        } catch (error: any) {
            const message = error?.message || 'pull failed';
            this.sendError(message, stream);
        }
    }

    private static sendError(message: string, stream: Multiplexer): void {
        const msgBuf = Buffer.from(message, 'utf-8');
        const buf = Buffer.alloc(4 + 4 + msgBuf.length);
        let offset = buf.write(AdbProtocol.FAIL, 0, 'ascii');
        offset = buf.writeUInt32LE(msgBuf.length, offset);
        msgBuf.copy(buf, offset);
        stream.send(buf);
        stream.close();
    }

    public static async getDeviceName(serial: string): Promise<string> {
        const props = await adbClient.getProperties(serial);
        return props['ro.product.model'] || 'Unknown device';
    }
}
