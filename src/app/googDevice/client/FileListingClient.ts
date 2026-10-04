import { ACTION } from '../../../common/Action';
import type GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import type { ParamsDeviceTracker } from '../../../types/ParamsDeviceTracker';
import { BaseDeviceTracker } from '../../client/BaseDeviceTracker';
import type { Tool } from '../../client/Tool';

const tempPath = '/data/local/tmp';

/**
 * The device card's "list files" entry. DeviceTracker intercepts the anchor's
 * click and opens ListFilesModal, which owns the listing and its FSLS channel.
 *
 * This used to be a full-page client as well, reached through a
 * `#!action=list-files` deep link. The anchor still carries that href (it is
 * what buildLink makes), but the click handler prevents the navigation, so
 * nothing in the app followed it once the modal replaced the page. The page
 * went; the card entry is what is left.
 */
export const FileListingClient: Tool = {
    createEntryForDeviceList(
        descriptor: GoogDeviceDescriptor,
        blockClass: string,
        params: ParamsDeviceTracker,
    ): HTMLElement | undefined {
        if (descriptor.state !== 'device') {
            return;
        }
        const entry = document.createElement('div');
        entry.classList.add('file-listing', blockClass);
        entry.appendChild(
            BaseDeviceTracker.buildLink(
                {
                    action: ACTION.FILE_LISTING,
                    udid: descriptor.udid,
                    path: `${tempPath}/`,
                },
                'list files',
                params,
            ),
        );
        return entry;
    },
};
