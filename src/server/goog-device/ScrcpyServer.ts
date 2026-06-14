import path from 'path';
import { DEVICE_SERVER_PATH, SERVER_PACKAGE, SERVER_PROCESS_NAME } from '../../common/Constants';
import type { Device } from './Device';

const FILE_DIR = path.join(__dirname, 'assets');
const FILE_NAME = 'scrcpy-server';

export class ScrcpyServer {
    /** Push the scrcpy-server binary to the device. */
    public static async pushServer(device: Device): Promise<void> {
        const src = path.join(FILE_DIR, FILE_NAME);
        return device.push(src, DEVICE_SERVER_PATH);
    }

    /** Check if scrcpy-server (app_process) is running on the device. */
    public static async getServerPid(device: Device): Promise<number | undefined> {
        if (!device.isConnected()) return;
        const list = await device.getPidOf(SERVER_PROCESS_NAME);
        if (!Array.isArray(list) || !list.length) return;

        for (const pid of list) {
            if (!Number.isInteger(pid) || pid <= 0) {
                continue;
            }
            const output = await device.runShellCommand(`cat /proc/${pid}/cmdline`);
            const args = output.split('\0');
            if (args.includes(SERVER_PACKAGE)) {
                return pid;
            }
        }
        return;
    }
}
