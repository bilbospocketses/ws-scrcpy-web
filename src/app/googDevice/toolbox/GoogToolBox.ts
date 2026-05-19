import { CommandControlMessage } from '../../controlMessage/CommandControlMessage';
import { KeyCodeControlMessage } from '../../controlMessage/KeyCodeControlMessage';
import type { BasePlayer } from '../../player/BasePlayer';
import { ToolBox } from '../../toolbox/ToolBox';
import { ToolBoxButton } from '../../toolbox/ToolBoxButton';
import { ToolBoxCheckbox } from '../../toolbox/ToolBoxCheckbox';
import type { ToolBoxElement } from '../../toolbox/ToolBoxElement';
import SvgImage from '../../ui/SvgImage';
import KeyEvent from '../android/KeyEvent';
import type { StreamClientScrcpy } from '../client/StreamClientScrcpy';

const BUTTONS = [
    {
        title: 'Power',
        code: KeyEvent.KEYCODE_POWER,
        icon: SvgImage.Icon.POWER,
    },
    {
        title: 'Volume up',
        code: KeyEvent.KEYCODE_VOLUME_UP,
        icon: SvgImage.Icon.VOLUME_UP,
    },
    {
        title: 'Volume down',
        code: KeyEvent.KEYCODE_VOLUME_DOWN,
        icon: SvgImage.Icon.VOLUME_DOWN,
    },
    {
        title: 'Back',
        code: KeyEvent.KEYCODE_BACK,
        icon: SvgImage.Icon.BACK,
    },
    {
        title: 'Home',
        code: KeyEvent.KEYCODE_HOME,
        icon: SvgImage.Icon.HOME,
    },
    {
        title: 'Overview',
        code: KeyEvent.KEYCODE_APP_SWITCH,
        icon: SvgImage.Icon.OVERVIEW,
    },
];

export class GoogToolBox extends ToolBox {
    protected constructor(list: ToolBoxElement<any>[]) {
        super(list);
    }

    public static createToolBox(
        udid: string,
        player: BasePlayer,
        client: StreamClientScrcpy,
        deviceKind?: 'phone' | 'tablet' | 'tv',
    ): GoogToolBox {
        const playerName = player.getName();
        const list = BUTTONS.slice();
        const handler = <K extends keyof HTMLElementEventMap, T extends HTMLElement>(
            type: K,
            element: ToolBoxElement<T>,
        ) => {
            if (!element.optional?.['code']) {
                return;
            }
            const { code } = element.optional;
            const action = type === 'mousedown' ? KeyEvent.ACTION_DOWN : KeyEvent.ACTION_UP;
            const event = new KeyCodeControlMessage(action, code, 0, 0);
            client.sendMessage(event);
        };
        const elements: ToolBoxElement<any>[] = list.map((item) => {
            const button = new ToolBoxButton(item.title, item.icon, {
                code: item.code,
            });
            button.addEventListener('mousedown', handler);
            button.addEventListener('mouseup', handler);
            return button;
        });
        if (player.supportsScreenshot) {
            const screenshot = new ToolBoxButton('Take screenshot', SvgImage.Icon.CAMERA);
            screenshot.addEventListener('click', () => {
                player.createScreenshot(client.getDeviceName());
            });
            elements.push(screenshot);
        }

        const keyboard = new ToolBoxCheckbox(
            'Capture keyboard',
            SvgImage.Icon.KEYBOARD,
            `capture_keyboard_${udid}_${playerName}`,
        );
        keyboard.getElement().checked = true;
        keyboard.addEventListener('click', (_, el) => {
            const element = el.getElement();
            client.setHandleKeyboardEvents(element.checked);
        });
        elements.push(keyboard);

        const uhid = new ToolBoxCheckbox(
            'UHID Input (keyboard + mouse)',
            SvgImage.Icon.KEYBOARD,
            `uhid_input_${udid}_${playerName}`,
        );
        uhid.addEventListener('click', (_, el) => {
            const element = el.getElement();
            client.toggleUhid(element.checked);
        });
        elements.push(uhid);

        const stats = new ToolBoxCheckbox(
            'Display quality stats',
            SvgImage.Icon.BAR_CHART,
            `quality_stats_${udid}_${playerName}`,
        );
        stats.addEventListener('click', (_, el) => {
            player.setShowQualityStats(el.getElement().checked);
        });
        elements.push(stats);

        // D-pad mode (default/unchecked) vs Touch mode (checked)
        const DPAD_TITLE = 'D-pad mode (click for Touch mode)';
        const TOUCH_TITLE = 'Touch mode (click for D-pad mode)';
        const inputMode = new ToolBoxCheckbox(
            DPAD_TITLE,
            { off: SvgImage.Icon.DPAD, on: SvgImage.Icon.TOUCH_HAND },
            `input_mode_${udid}_${playerName}`,
        );
        const inputModeLabel = inputMode.getAllElements()[1]!;

        // Seed default from deviceKind: phone/tablet → Touch; tv/undefined → D-pad.
        const startInTouch = deviceKind === 'phone' || deviceKind === 'tablet';
        if (startInTouch) {
            inputMode.getElement().checked = true;
            client.setDpadMode(false);
            inputModeLabel.title = TOUCH_TITLE;
        }

        inputMode.addEventListener('click', (_, el) => {
            const touchMode = el.getElement().checked;
            client.setDpadMode(!touchMode);
            inputModeLabel.title = touchMode ? TOUCH_TITLE : DPAD_TITLE;
        });
        elements.push(inputMode);

        const refresh = new ToolBoxButton('Refresh stream', SvgImage.Icon.REFRESH);
        refresh.addEventListener('click', () => {
            client.refreshStream();
        });
        elements.push(refresh);

        // GET: pull device clipboard to host
        const clipGet = new ToolBoxButton('copy device clipboard to host', SvgImage.Icon.CLIPBOARD_GET);
        clipGet.addEventListener('click', () => {
            client.sendMessage(CommandControlMessage.createGetClipboardCommand());
        });
        elements.push(clipGet);

        // SET: push host clipboard to device
        const clipSet = new ToolBoxButton('push host clipboard to device', SvgImage.Icon.CLIPBOARD_SET);
        clipSet.addEventListener('click', async () => {
            if (!navigator.clipboard?.readText) {
                console.error('[GoogToolBox] navigator.clipboard.readText unavailable');
                return;
            }
            try {
                const text = await navigator.clipboard.readText();
                if (text) {
                    client.sendMessage(CommandControlMessage.createSetClipboardCommand(text));
                }
            } catch (err) {
                console.error('[GoogToolBox] clipboard read failed:', err);
            }
        });
        elements.push(clipSet);

        return new GoogToolBox(elements);
    }
}
