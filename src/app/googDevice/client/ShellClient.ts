import { ACTION } from '../../../common/Action';
import type GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import type { ParamsDeviceTracker } from '../../../types/ParamsDeviceTracker';
import { BaseDeviceTracker } from '../../client/BaseDeviceTracker';
import type { Tool } from '../../client/Tool';

/**
 * The device card's "shell" entry. DeviceTracker intercepts the anchor's click
 * and opens ShellModal, which owns the terminal and its RemoteShell channel.
 *
 * This used to be a full-page client as well, reached through a
 * `#!action=shell&udid=` deep link. The anchor still carries that href (it is
 * what buildLink makes), but the click handler prevents the navigation, so
 * nothing in the app followed it once the modal replaced the page. The page
 * went; the card entry is what is left.
 */
export const ShellClient: Tool = {
    createEntryForDeviceList(
        descriptor: GoogDeviceDescriptor,
        blockClass: string,
        params: ParamsDeviceTracker,
    ): HTMLElement | undefined {
        if (descriptor.state !== 'device') {
            return;
        }
        const entry = document.createElement('div');
        entry.classList.add('shell', blockClass);
        entry.appendChild(
            BaseDeviceTracker.buildLink(
                {
                    action: ACTION.SHELL,
                    udid: descriptor.udid,
                },
                'shell',
                params,
            ),
        );
        return entry;
    },
};
