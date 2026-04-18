import type { BaseDeviceDescriptor } from './BaseDeviceDescriptor';
import type { NetInterface } from './NetInterface';

export default interface GoogDeviceDescriptor extends BaseDeviceDescriptor {
    'ro.build.version.release': string;
    'ro.build.version.sdk': string;
    'ro.product.cpu.abi': string;
    'ro.product.manufacturer': string;
    'ro.product.model': string;
    'ro.serialno': string;
    'wifi.interface': string;
    interfaces: NetInterface[];
    pid: number;
    'last.update.timestamp': number;
    'screen.state': 'awake' | 'asleep' | 'unknown';
    deviceKind?: 'phone' | 'tablet' | 'tv';
}
