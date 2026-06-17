import ArrowBackSVG from '../../public/images/buttons/arrow_back.svg';
import BarChartSVG from '../../public/images/buttons/bar_chart.svg';
import CancelSVG from '../../public/images/buttons/cancel.svg';
import ClipboardGetSVG from '../../public/images/buttons/clipboard_get.svg';
import ClipboardSetSVG from '../../public/images/buttons/clipboard_set.svg';
import DevicePhoneSVG from '../../public/images/buttons/device_phone.svg';
import DeviceTabletSVG from '../../public/images/buttons/device_tablet.svg';
import DeviceTvSVG from '../../public/images/buttons/device_tv.svg';
import DpadSVG from '../../public/images/buttons/dpad.svg';
import MenuSVG from '../../public/images/buttons/menu.svg';
import OfflineSVG from '../../public/images/buttons/offline.svg';
import RefreshSVG from '../../public/images/buttons/refresh.svg';
import SettingsSVG from '../../public/images/buttons/settings.svg';
import ToggleOffSVG from '../../public/images/buttons/toggle_off.svg';
import ToggleOnSVG from '../../public/images/buttons/toggle_on.svg';
import TouchSVG from '../../public/images/buttons/touch.svg';
import KeyboardSVG from '../../public/images/skin-light/ic_keyboard_678_48dp.svg';
import MoreSVG from '../../public/images/skin-light/ic_more_horiz_678_48dp.svg';
import CameraSVG from '../../public/images/skin-light/ic_photo_camera_678_48dp.svg';
import PowerSVG from '../../public/images/skin-light/ic_power_settings_new_678_48px.svg';
import VolumeDownSVG from '../../public/images/skin-light/ic_volume_down_678_48px.svg';
import VolumeUpSVG from '../../public/images/skin-light/ic_volume_up_678_48px.svg';
import BackSVG from '../../public/images/skin-light/System_Back_678.svg';
import HomeSVG from '../../public/images/skin-light/System_Home_678.svg';
import OverviewSVG from '../../public/images/skin-light/System_Overview_678.svg';
import { removeSvgTitles } from './svgTitles';

export enum Icon {
    BACK = 0,
    HOME = 1,
    OVERVIEW = 2,
    POWER = 3,
    VOLUME_UP = 4,
    VOLUME_DOWN = 5,
    MORE = 6,
    CAMERA = 7,
    KEYBOARD = 8,
    CANCEL = 9,
    OFFLINE = 10,
    REFRESH = 11,
    SETTINGS = 12,
    MENU = 13,
    ARROW_BACK = 14,
    TOGGLE_ON = 15,
    TOGGLE_OFF = 16,
    BAR_CHART = 17,
    DPAD = 18,
    TOUCH_HAND = 19,
    CLIPBOARD_GET = 20,
    CLIPBOARD_SET = 21,
    DEVICE_TV = 22,
    DEVICE_TABLET = 23,
    DEVICE_PHONE = 24,
}

export default class SvgImage {
    static Icon = Icon;
    private static getSvgString(type: Icon): string {
        switch (type) {
            case Icon.KEYBOARD:
                return KeyboardSVG;
            case Icon.MORE:
                return MoreSVG;
            case Icon.CAMERA:
                return CameraSVG;
            case Icon.POWER:
                return PowerSVG;
            case Icon.VOLUME_DOWN:
                return VolumeDownSVG;
            case Icon.VOLUME_UP:
                return VolumeUpSVG;
            case Icon.BACK:
                return BackSVG;
            case Icon.HOME:
                return HomeSVG;
            case Icon.OVERVIEW:
                return OverviewSVG;
            case Icon.CANCEL:
                return CancelSVG;
            case Icon.OFFLINE:
                return OfflineSVG;
            case Icon.REFRESH:
                return RefreshSVG;
            case Icon.SETTINGS:
                return SettingsSVG;
            case Icon.MENU:
                return MenuSVG;
            case Icon.ARROW_BACK:
                return ArrowBackSVG;
            case Icon.TOGGLE_ON:
                return ToggleOnSVG;
            case Icon.TOGGLE_OFF:
                return ToggleOffSVG;
            case Icon.BAR_CHART:
                return BarChartSVG;
            case Icon.DPAD:
                return DpadSVG;
            case Icon.TOUCH_HAND:
                return TouchSVG;
            case Icon.CLIPBOARD_GET:
                return ClipboardGetSVG;
            case Icon.CLIPBOARD_SET:
                return ClipboardSetSVG;
            case Icon.DEVICE_TV:
                return DeviceTvSVG;
            case Icon.DEVICE_TABLET:
                return DeviceTabletSVG;
            case Icon.DEVICE_PHONE:
                return DevicePhoneSVG;
            default:
                return '';
        }
    }
    public static create(type: Icon): Element {
        const dummy = document.createElement('div');
        dummy.innerHTML = this.getSvgString(type);
        const svg = dummy.children[0]!;
        removeSvgTitles(svg);
        return svg;
    }
}
