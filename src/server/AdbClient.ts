import { execFile, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface AdbDevice {
    serial: string;
    state: string;
}

export class AdbClient {
    constructor(private adbPath: string = 'adb') {}

    private async exec(args: string[]): Promise<string> {
        const { stdout } = await execFileAsync(this.adbPath, args, { maxBuffer: 10 * 1024 * 1024 });
        return stdout;
    }

    async devices(): Promise<AdbDevice[]> {
        const output = await this.exec(['devices']);
        return output
            .split('\n')
            .slice(1) // skip "List of devices attached" header
            .filter((line) => line.trim().length > 0)
            .map((line) => {
                const [serial, state] = line.trim().split(/\s+/);
                return { serial, state };
            });
    }

    async shell(serial: string, command: string): Promise<string> {
        const { stdout } = await execFileAsync(this.adbPath, ['-s', serial, 'shell', command], {
            maxBuffer: 10 * 1024 * 1024,
        });
        return stdout.trim();
    }

    async push(serial: string, local: string, remote: string): Promise<void> {
        await this.exec(['-s', serial, 'push', local, remote]);
    }

    async pull(serial: string, remote: string, local: string): Promise<void> {
        await this.exec(['-s', serial, 'pull', remote, local]);
    }

    async forward(serial: string, local: string, remote: string): Promise<void> {
        await this.exec(['-s', serial, 'forward', local, remote]);
    }

    async listForwards(serial: string): Promise<{ serial: string; local: string; remote: string }[]> {
        const output = await this.exec(['-s', serial, 'forward', '--list']);
        return output
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .map((line) => {
                const [serial, local, remote] = line.trim().split(/\s+/);
                return { serial, local, remote };
            });
    }

    async removeForward(serial: string, local: string): Promise<void> {
        await this.exec(['-s', serial, 'forward', '--remove', local]);
    }

    async reverse(serial: string, remote: string, local: string): Promise<void> {
        await this.exec(['-s', serial, 'reverse', remote, local]);
    }

    async getProperties(serial: string): Promise<Record<string, string>> {
        const output = await this.shell(serial, 'getprop');
        const props: Record<string, string> = {};
        const regex = /\[(.+?)\]: \[(.*)]/g;
        let match;
        while ((match = regex.exec(output)) !== null) {
            props[match[1]] = match[2];
        }
        return props;
    }

    /** Long-running shell command using spawn (doesn't wait for completion) */
    shellSpawn(serial: string, command: string): ChildProcess {
        return spawn(this.adbPath, ['-s', serial, 'shell', command], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    }
}
