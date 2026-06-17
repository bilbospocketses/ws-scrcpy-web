/**
 * WsScrcpy public library entry.
 * Exposes startStream + version via both UMD (window.WsScrcpy) and ESM (named exports).
 */

/// <reference path="../../types/assets.d.ts" />
/// <reference types="node" />

import '../../style/ws-scrcpy.css';
import { StreamClientScrcpy } from '../googDevice/client/StreamClientScrcpy';
import { WebCodecsPlayer } from '../player/WebCodecsPlayer';

// Register the default player so startStream works standalone
// (the home page also registers it, but a pure library consumer might not)
StreamClientScrcpy.registerPlayer(WebCodecsPlayer);

export { startStream } from './startStream';
export type { Theme, ThemeEmbedOptions } from './themeEmbed';

export {
    getTheme,
    installThemeEmbedListener,
    notifyThemeChanged,
    notifyThemeReady,
    setTheme,
} from './themeEmbed';
export type { StartStreamOptions, StreamHandle, StreamInfo } from './types';

// Injected at build time via webpack DefinePlugin
declare const __WSSCRCPY_VERSION__: string;
export const version: string = __WSSCRCPY_VERSION__;
