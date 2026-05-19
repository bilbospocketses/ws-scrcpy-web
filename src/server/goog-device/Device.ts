import { TypedEmitter } from '../../common/TypedEmitter';
import type GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';
import type { NetInterface } from '../../types/NetInterface';
import { AdbClient } from '../AdbClient';
import { Config } from '../Config';
import { Logger } from '../Logger';
import { classifyDeviceKind } from './deviceKind';
import { Properties } from './Properties';

import Timeout = NodeJS.Timeout;

enum PID_DETECTION {
    UNKNOWN = 0,
    PIDOF = 1,
    GREP_PS = 2,
    GREP_PS_A = 3,
    LS_PROC = 4,
}

export interface DeviceEvents {
    update: Device;
}

export class Device extends TypedEmitter<DeviceEvents> {
    private static readonly INITIAL_UPDATE_TIMEOUT = 1500;
    private static readonly MAX_UPDATES_COUNT = 7;
    private connected = true;
    private pidDetectionVariant: PID_DETECTION = PID_DETECTION.UNKNOWN;
    private adbClient: AdbClient;
    private properties?: Record<string, string>;
    private updateTimeoutId?: Timeout;
    private updateTimeout = Device.INITIAL_UPDATE_TIMEOUT;
    private updateCount = 0;
    private throttleTimeoutId?: Timeout;
    private lastEmit = 0;
    public readonly TAG: string;
    public readonly descriptor: GoogDeviceDescriptor;

    constructor(
        public readonly udid: string,
        state: string,
    ) {
        super();
        this.TAG = `[${udid}]`;
        this.descriptor = {
            udid,
            state,
            interfaces: [],
            pid: -1,
            'wifi.interface': '',
            'ro.build.version.release': '',
            'ro.build.version.sdk': '',
            'ro.product.manufacturer': '',
            'ro.product.model': '',
            'ro.product.cpu.abi': '',
            'ro.serialno': '',
            'last.update.timestamp': 0,
            'screen.state': 'unknown',
        };
        this.adbClient = new AdbClient(Config.getInstance().adbPath);
        this.setState(state);
    }

    public setState(state: string): void {
        if (state === 'device') {
            this.connected = true;
            this.properties = undefined;
            this.descriptor.pid = 0; // No persistent server — stream buttons always shown
        } else {
            this.connected = false;
            this.descriptor.pid = -1;
        }
        this.descriptor.state = state;
        this.emitUpdate();
        this.fetchDeviceInfo();
    }

    public isConnected(): boolean {
        return this.connected;
    }

    public async getPidOf(processName: string): Promise<number[] | undefined> {
        if (!this.connected) {
            return;
        }
        if (this.pidDetectionVariant === PID_DETECTION.UNKNOWN) {
            this.pidDetectionVariant = await this.findDetectionVariant();
        }
        switch (this.pidDetectionVariant) {
            case PID_DETECTION.PIDOF:
                return this.pidOf(processName);
            case PID_DETECTION.GREP_PS:
                return this.grepPs(processName);
            case PID_DETECTION.GREP_PS_A:
                return this.grepPs_A(processName);
            default:
                return this.listProc(processName);
        }
    }

    public killProcess(pid: number): Promise<string> {
        const command = `kill ${pid}`;
        return this.runShellCommand(command);
    }

    public async runShellCommand(command: string): Promise<string> {
        return this.adbClient.shell(this.udid, command);
    }

    /** Long-running shell command via spawn (for processes that shouldn't block). */
    public runShellCommandSpawn(command: string): import('child_process').ChildProcess {
        return this.adbClient.shellSpawn(this.udid, command);
    }

    public async push(local: string, remote: string): Promise<void> {
        return this.adbClient.push(this.udid, local, remote);
    }

    public async getProperties(): Promise<Record<string, string> | undefined> {
        if (this.properties) {
            return this.properties;
        }
        if (!this.connected) {
            return;
        }
        this.properties = await this.adbClient.getProperties(this.udid);
        return this.properties;
    }

    private interfacesSort = (a: NetInterface, b: NetInterface): number => {
        if (a.name > b.name) {
            return 1;
        }
        if (a.name < b.name) {
            return -1;
        }
        return 0;
    };

    public async getNetInterfaces(): Promise<NetInterface[]> {
        if (!this.connected) {
            return [];
        }
        const list: NetInterface[] = [];
        const output = await this.runShellCommand(`ip -4 -f inet -o a | grep 'scope global'`);
        const lines = output.split('\n').filter((i: string) => !!i);
        lines.forEach((value: string) => {
            const temp = value.split(' ').filter((i: string) => !!i);
            const name = temp[1];
            const ipAndMask = temp[3];
            const ipv4 = ipAndMask.split('/')[0];
            list.push({ name, ipv4 });
        });
        return list.sort(this.interfacesSort);
    }

    private async pidOf(processName: string): Promise<number[]> {
        return this.runShellCommand(`pidof ${processName}`)
            .then((output) => {
                return output
                    .split(' ')
                    .map((pid) => Number.parseInt(pid, 10))
                    .filter((num) => !isNaN(num));
            })
            .catch(() => {
                return [];
            });
    }

    private filterPsOutput(processName: string, output: string): number[] {
        const list: number[] = [];
        const processes = output.split('\n');
        processes.map((line) => {
            const cols = line
                .trim()
                .split(' ')
                .filter((item) => item.length);
            if (cols[cols.length - 1] === processName) {
                const pid = Number.parseInt(cols[1], 10);
                if (!isNaN(pid)) {
                    list.push(pid);
                }
            }
        });
        return list;
    }

    private async grepPs_A(processName: string): Promise<number[]> {
        return this.runShellCommand(`ps -A | grep ${processName}`)
            .then((output) => {
                return this.filterPsOutput(processName, output);
            })
            .catch(() => {
                return [];
            });
    }

    private async grepPs(processName: string): Promise<number[]> {
        return this.runShellCommand(`ps | grep ${processName}`)
            .then((output) => {
                return this.filterPsOutput(processName, output);
            })
            .catch(() => {
                return [];
            });
    }

    private async listProc(processName: string): Promise<number[]> {
        const find = 'find /proc -maxdepth 2 -name cmdline  2>/dev/null';
        const lines = await this.runShellCommand(
            `for L in \`${find}\`; do grep -sae '^${processName}' $L 2>&1 >/dev/null && echo $L; done`,
        );
        const re = /\/proc\/([0-9]+)\/cmdline/;
        const list: number[] = [];
        lines.split('\n').map((line) => {
            const trim = line.trim();
            const m = trim.match(re);
            if (m) {
                list.push(Number.parseInt(m[1], 10));
            }
        });
        return list;
    }

    private async executedWithoutError(command: string): Promise<boolean> {
        return this.runShellCommand(command)
            .then((output) => {
                const err = Number.parseInt(output, 10);
                return err === 0;
            })
            .catch(() => {
                return false;
            });
    }

    private async hasPs(): Promise<boolean> {
        return this.executedWithoutError('ps | grep init 2>&1 >/dev/null; echo $?');
    }

    private async hasPs_A(): Promise<boolean> {
        return this.executedWithoutError('ps -A | grep init 2>&1 >/dev/null; echo $?');
    }

    private async hasPidOf(): Promise<boolean> {
        const ok = await this.executedWithoutError('which pidof 2>&1 >/dev/null && echo $?');
        if (!ok) {
            return false;
        }
        return this.runShellCommand('echo $PPID; pidof init')
            .then((output) => {
                const pids = output.split('\n').filter((a) => a.length);
                if (pids.length < 2) {
                    return false;
                }
                const parentPid = pids[0].replaceAll('\r', '');
                const list = pids[1].split(' ');
                if (list.includes(parentPid)) {
                    return false;
                }
                return list.includes('1');
            })
            .catch(() => {
                return false;
            });
    }

    private async findDetectionVariant(): Promise<PID_DETECTION> {
        if (await this.hasPidOf()) {
            return PID_DETECTION.PIDOF;
        }
        if (await this.hasPs_A()) {
            return PID_DETECTION.GREP_PS_A;
        }
        if (await this.hasPs()) {
            return PID_DETECTION.GREP_PS;
        }
        return PID_DETECTION.LS_PROC;
    }

    private scheduleInfoUpdate(): void {
        if (this.updateTimeoutId) {
            return;
        }
        if (++this.updateCount > Device.MAX_UPDATES_COUNT) {
            Logger.for(this.TAG).error('The maximum number of attempts to fetch device info has been reached.');
            return;
        }
        this.updateTimeoutId = setTimeout(this.fetchDeviceInfo, this.updateTimeout);
        this.updateTimeout *= 2;
    }

    private fetchDeviceInfo = (): void => {
        if (this.connected) {
            const propsPromise = this.getProperties().then((props) => {
                if (!props) return false;
                let changed = false;
                Properties.forEach((propName: keyof GoogDeviceDescriptor) => {
                    if (props[propName] !== this.descriptor[propName]) {
                        changed = true;
                        (this.descriptor[propName] as any) = props[propName];
                    }
                });
                if (changed) this.emitUpdate();
                return true;
            });
            const netIntPromise = this.updateInterfaces().then((interfaces) => {
                return !!interfaces.length;
            });
            Promise.all([propsPromise, netIntPromise])
                .then((results) => {
                    this.updateTimeoutId = undefined;
                    const failedCount = results.filter((result) => !result).length;
                    if (!failedCount) {
                        this.updateCount = 0;
                        this.updateTimeout = Device.INITIAL_UPDATE_TIMEOUT;
                    } else {
                        this.scheduleInfoUpdate();
                    }
                })
                .catch(() => {
                    this.updateTimeoutId = undefined;
                    this.scheduleInfoUpdate();
                });
        } else {
            this.updateCount = 0;
            this.updateTimeout = Device.INITIAL_UPDATE_TIMEOUT;
            this.updateTimeoutId = undefined;
            this.emitUpdate();
        }
    };

    private emitUpdate(setUpdateTime = true): void {
        const THROTTLE = 300;
        const now = Date.now();
        const time = now - this.lastEmit;
        if (setUpdateTime) {
            this.descriptor['last.update.timestamp'] = now;
        }
        if (time > THROTTLE) {
            this.lastEmit = now;
            this.emit('update', this);
            return;
        }
        if (!this.throttleTimeoutId) {
            this.throttleTimeoutId = setTimeout(() => {
                delete this.throttleTimeoutId;
                this.emitUpdate(false);
            }, THROTTLE - time);
        }
    }

    public async checkScreenState(): Promise<void> {
        if (!this.connected) return;
        try {
            const output = await this.runShellCommand('dumpsys power 2>/dev/null | grep mWakefulness');
            const newState: 'awake' | 'asleep' = output.includes('Awake') ? 'awake' : 'asleep';
            if (this.descriptor['screen.state'] !== newState) {
                this.descriptor['screen.state'] = newState;
                this.emitUpdate();
            }
        } catch {
            // Device not responding — leave state unchanged
        }
    }

    public async detectDeviceKind(): Promise<void> {
        if (this.descriptor.deviceKind) return;
        if (!this.connected) return;
        // Each shell is wrapped individually because some commands exit non-zero
        // even when they produce a valid answer (e.g. `pm has-feature` returns 1
        // when the feature is absent on some Android versions). Swallowing per-call
        // means one ignorable exit doesn't scuttle the whole detection pass.
        const safe = (cmd: string) => this.runShellCommand(cmd).catch(() => '');
        const [characteristics, leanback, sizeOut, densityOut] = await Promise.all([
            safe('getprop ro.build.characteristics'),
            safe('pm has-feature android.software.leanback'),
            safe('wm size'),
            safe('wm density'),
        ]);
        const kind = classifyDeviceKind(characteristics, leanback, sizeOut, densityOut);
        if (kind) {
            this.descriptor.deviceKind = kind;
            this.emitUpdate();
        }
    }

    public async updateInterfaces(): Promise<NetInterface[]> {
        return this.getNetInterfaces().then((interfaces) => {
            let changed = false;
            const old = this.descriptor.interfaces;
            if (old.length !== interfaces.length) {
                changed = true;
            } else {
                old.forEach((value, idx) => {
                    if (value.name !== interfaces[idx].name || value.ipv4 !== interfaces[idx].ipv4) {
                        changed = true;
                    }
                });
            }
            if (changed) {
                this.descriptor.interfaces = interfaces;
                this.emitUpdate();
            }
            return this.descriptor.interfaces;
        });
    }
}
