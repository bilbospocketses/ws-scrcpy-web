import { isUniqueSerial } from '../../../common/deviceSerial';
import type GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import type { SettingsService } from '../../client/SettingsService';

/**
 * Bind the device card's stream settings to the device, not its adb transport
 * (M11): every settings read and write for `device.udid`, on the card, in
 * ConfigureScrcpy and in the player, goes under the serial the descriptor
 * carries. A serial not read yet, or one many devices share (`isUniqueSerial`),
 * drops the binding, so the server keys the transport itself.
 */
export function bindDeviceSettings(
    service: Pick<SettingsService, 'bindSerial'>,
    device: Pick<GoogDeviceDescriptor, 'udid' | 'ro.serialno'>,
): void {
    const serial = device['ro.serialno'] || '';
    service.bindSerial(device.udid, isUniqueSerial(serial) ? serial : '');
}
