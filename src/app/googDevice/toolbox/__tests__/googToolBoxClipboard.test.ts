// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

/**
 * The toolbar's "copy device selection to host clipboard" button.
 *
 * It used to send GET_CLIPBOARD with copy_key NONE (`[0x08, 0x00]`). Upstream's
 * Controller.getClipboard only answers that when clipboard autosync is OFF, and
 * we leave autosync on, so the device said nothing and the button did nothing.
 * It now sends what upstream's own client sends for its MOD+c shortcut
 * (input_manager.c, `get_device_clipboard(im, SC_COPY_KEY_COPY)`; MOD is scrcpy's
 * shortcut modifier, and a plain Ctrl+C goes to the device as keys): the device
 * presses COPY on its selection, and autosync carries the text back. The device
 * only presses COPY on Android 7 and later.
 */

// The icons are SVG imports, which are irrelevant here and need a bundler.
vi.mock('../../../ui/SvgImage', () => ({
    default: {
        Icon: new Proxy({}, { get: (_target, key) => String(key) }),
        create: () => document.createElement('span'),
    },
}));

import { CommandControlMessage } from '../../../controlMessage/CommandControlMessage';
import { ControlMessage } from '../../../controlMessage/ControlMessage';
import type { BasePlayer } from '../../../player/BasePlayer';
import type { StreamClientScrcpy } from '../../client/StreamClientScrcpy';
import { GoogToolBox } from '../GoogToolBox';

describe('GET_CLIPBOARD encoding', () => {
    it('COPY_KEY_COPY is 1, the position of SC_COPY_KEY_COPY in upstream enum sc_copy_key', () => {
        // enum sc_copy_key { SC_COPY_KEY_NONE, SC_COPY_KEY_COPY, SC_COPY_KEY_CUT } (control_msg.h, v5.0)
        expect(CommandControlMessage.COPY_KEY_NONE).toBe(0);
        expect(CommandControlMessage.COPY_KEY_COPY).toBe(1);
        expect(CommandControlMessage.COPY_KEY_CUT).toBe(2);
    });

    it('encodes copy_key COPY as [0x08, 0x01]', () => {
        const bytes = CommandControlMessage.createGetClipboardCommand(
            CommandControlMessage.COPY_KEY_COPY,
        ).toUint8Array();
        expect(Array.from(bytes)).toEqual([ControlMessage.TYPE_GET_CLIPBOARD, 0x01]);
        expect(ControlMessage.TYPE_GET_CLIPBOARD).toBe(0x08);
    });
});

describe('GoogToolBox clipboard GET button', () => {
    function build() {
        const sent: ControlMessage[] = [];
        const client = {
            sendMessage: (m: ControlMessage) => sent.push(m),
            setHandleKeyboardEvents: () => undefined,
            toggleUhid: () => undefined,
            setDpadMode: () => undefined,
            refreshStream: () => undefined,
            getDeviceName: () => 'device',
        } as unknown as StreamClientScrcpy;
        const player = {
            getName: () => 'fake',
            supportsScreenshot: false,
            setShowQualityStats: () => undefined,
        } as unknown as BasePlayer;
        const holder = GoogToolBox.createToolBox('device-1', player, client, 'phone').getHolderElement();
        return { holder, sent };
    }

    function getButton(holder: HTMLElement): HTMLButtonElement {
        const button = holder.querySelector<HTMLButtonElement>(
            'button[title="copy device selection to host clipboard"]',
        );
        expect(button, 'the clipboard GET button should be in the toolbar').toBeTruthy();
        return button!;
    }

    it('sends GET_CLIPBOARD with copy_key COPY, the bytes upstream sends for MOD+c', () => {
        const { holder, sent } = build();

        getButton(holder).click();

        expect(sent).toHaveLength(1);
        expect(Array.from(sent[0]!.toUint8Array())).toEqual([0x08, 0x01]);
    });
});
