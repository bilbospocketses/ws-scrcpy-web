import type GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import { AdbClient } from '../../AdbClient';
import type { Service } from '../../services/Service';
import { Device } from '../Device';
import Timeout = NodeJS.Timeout;
import * as crypto from 'crypto';
import * as os from 'os';
import { ControlCenterCommand } from '../../../common/ControlCenterCommand';
import { DeviceState } from '../../../common/DeviceState';
import { BaseControlCenter } from '../../services/BaseControlCenter';

export class ControlCenter extends BaseControlCenter<GoogDeviceDescriptor> implements Service {
    private static readonly POLL_INTERVAL = 2000;
    private static instance?: ControlCenter;

    private initialized = false;
    private adbClient = new AdbClient();
    private knownDevices = new Map<string, string>(); // serial -> state
    private pollIntervalId?: Timeout;
    private deviceMap: Map<string, Device> = new Map();
    private descriptors: Map<string, GoogDeviceDescriptor> = new Map();
    private readonly id: string;

    protected constructor() {
        super();
        const idString = `goog|${os.hostname()}|${os.uptime()}`;
        this.id = crypto.createHash('md5').update(idString).digest('hex');
    }

    public static getInstance(): ControlCenter {
        if (!this.instance) {
            this.instance = new ControlCenter();
        }
        return this.instance;
    }

    public static hasInstance(): boolean {
        return !!ControlCenter.instance;
    }

    private pollDevices = async (): Promise<void> => {
        try {
            const devices = await this.adbClient.devices();
            const currentSerials = new Set(devices.map((d) => d.serial));

            // Detect new or changed devices
            for (const device of devices) {
                const prevState = this.knownDevices.get(device.serial);
                if (prevState !== device.state) {
                    this.knownDevices.set(device.serial, device.state);
                    this.handleConnected(device.serial, device.state);
                }
            }

            // Detect removed devices
            for (const [serial] of this.knownDevices) {
                if (!currentSerials.has(serial)) {
                    this.knownDevices.delete(serial);
                    this.handleConnected(serial, DeviceState.DISCONNECTED);
                }
            }
        } catch (_e) {
            // ADB not running or error — retry on next poll
        }
    };

    private onDeviceUpdate = (device: Device): void => {
        const { udid, descriptor } = device;
        this.descriptors.set(udid, descriptor);
        this.emit('device', descriptor);
    };

    private handleConnected(udid: string, state: string): void {
        let device = this.deviceMap.get(udid);
        if (device) {
            device.setState(state);
        } else {
            device = new Device(udid, state);
            device.on('update', this.onDeviceUpdate);
            this.deviceMap.set(udid, device);
        }
    }

    public async init(): Promise<void> {
        if (this.initialized) {
            return;
        }
        // Initial device enumeration
        try {
            const list = await this.adbClient.devices();
            for (const device of list) {
                this.knownDevices.set(device.serial, device.state);
                this.handleConnected(device.serial, device.state);
            }
        } catch (e: any) {
            console.error('Failed to list initial devices:', e.message);
        }
        // Start polling for changes
        this.pollIntervalId = setInterval(this.pollDevices, ControlCenter.POLL_INTERVAL);
        this.initialized = true;
    }

    private stopTracking(): void {
        if (this.pollIntervalId) {
            clearInterval(this.pollIntervalId);
            this.pollIntervalId = undefined;
        }
        this.knownDevices.clear();
        this.initialized = false;
    }

    public getDevices(): GoogDeviceDescriptor[] {
        return Array.from(this.descriptors.values());
    }

    public getDevice(udid: string): Device | undefined {
        return this.deviceMap.get(udid);
    }

    public getId(): string {
        return this.id;
    }

    public getName(): string {
        return `aDevice Tracker [${os.hostname()}]`;
    }

    public start(): Promise<void> {
        return this.init().catch((e) => {
            console.error(`Error: Failed to init "${this.getName()}". ${e.message}`);
        });
    }

    public release(): void {
        this.stopTracking();
    }

    public async runCommand(command: ControlCenterCommand): Promise<void> {
        const udid = command.getUdid();
        const device = this.getDevice(udid);
        if (!device) {
            console.error(`Device with udid:"${udid}" not found`);
            return;
        }
        const type = command.getType();
        switch (type) {
            case ControlCenterCommand.KILL_SERVER:
                // Server lifecycle is now managed by ScrcpyConnection — no-op
                return;
            case ControlCenterCommand.START_SERVER:
                // Server lifecycle is now managed by ScrcpyConnection — no-op
                return;
            case ControlCenterCommand.UPDATE_INTERFACES:
                await device.updateInterfaces();
                return;
            default:
                throw new Error(`Unsupported command: "${type}"`);
        }
    }
}
