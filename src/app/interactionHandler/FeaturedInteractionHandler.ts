import type { ControlMessage } from '../controlMessage/ControlMessage';
import { KeyCodeControlMessage } from '../controlMessage/KeyCodeControlMessage';
import { ScrollControlMessage } from '../controlMessage/ScrollControlMessage';
import type { TouchControlMessage } from '../controlMessage/TouchControlMessage';
import KeyEvent from '../googDevice/android/KeyEvent';
import MotionEvent from '../MotionEvent';
import type { BasePlayer } from '../player/BasePlayer';
import type ScreenInfo from '../ScreenInfo';
import { type InteractionEvents, InteractionHandler, type KeyEventNames } from './InteractionHandler';

const TAG = '[FeaturedTouchHandler]';

export interface InteractionHandlerListener {
    sendMessage: (message: ControlMessage) => void;
}

export class FeaturedInteractionHandler extends InteractionHandler {
    private static readonly touchEventsNames: InteractionEvents[] = [
        'touchstart',
        'touchend',
        'touchmove',
        'touchcancel',
        'mousedown',
        'mouseup',
        'mousemove',
        'wheel',
    ];
    private static readonly keyEventsNames: KeyEventNames[] = ['keydown', 'keyup'];
    public static SCROLL_EVENT_THROTTLING_TIME = 30;
    public static DPAD_SCROLL_DEBOUNCE_TIME = 400; // cooldown after first fire, absorbs hardware burst
    private readonly storedFromMouseEvent = new Map<number, TouchControlMessage>();
    private readonly storedFromTouchEvent = new Map<number, TouchControlMessage>();
    private lastScrollEvent?: { time: number; hScroll: number; vScroll: number };
    private dpadScrollCooldown = false;
    private dpadScrollTimer?: ReturnType<typeof setTimeout>;
    private _dpadMode = true;

    constructor(
        player: BasePlayer,
        public readonly listener: InteractionHandlerListener,
    ) {
        super(player, FeaturedInteractionHandler.touchEventsNames, FeaturedInteractionHandler.keyEventsNames);
        this.tag.addEventListener('mouseleave', this.onMouseLeave);
        this.tag.addEventListener('mouseenter', this.onMouseEnter);
    }

    public setDpadMode(enabled: boolean): void {
        this._dpadMode = enabled;
    }

    public buildDpadScrollEvent(event: WheelEvent): ControlMessage[] {
        // Fire-then-debounce: fire immediately on first event, ignore the rest
        // of the hardware burst, reset after events stop for DPAD_SCROLL_DEBOUNCE_TIME
        if (this.dpadScrollCooldown) {
            // Still in cooldown — reset the timer (debounce) but don't fire
            clearTimeout(this.dpadScrollTimer);
            this.dpadScrollTimer = setTimeout(() => {
                this.dpadScrollCooldown = false;
            }, FeaturedInteractionHandler.DPAD_SCROLL_DEBOUNCE_TIME);
            return [];
        }

        // First event in burst — fire immediately, enter cooldown
        this.dpadScrollCooldown = true;
        this.dpadScrollTimer = setTimeout(() => {
            this.dpadScrollCooldown = false;
        }, FeaturedInteractionHandler.DPAD_SCROLL_DEBOUNCE_TIME);

        const messages: ControlMessage[] = [];
        // Shift+scroll → horizontal (DPAD_LEFT/RIGHT), normal scroll → vertical (DPAD_UP/DOWN)
        let vDir = 0;
        let hDir = 0;
        if (event.shiftKey) {
            hDir = event.deltaY > 0 ? -1 : event.deltaY < 0 ? 1 : 0;
        } else {
            vDir = event.deltaY > 0 ? -1 : event.deltaY < 0 ? 1 : 0;
        }
        if (event.deltaX !== 0 && !event.shiftKey) {
            hDir = event.deltaX > 0 ? -1 : event.deltaX < 0 ? 1 : 0;
        }
        if (vDir === -1) {
            messages.push(new KeyCodeControlMessage(MotionEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_DOWN, 0, 0));
            messages.push(new KeyCodeControlMessage(MotionEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_DOWN, 0, 0));
        } else if (vDir === 1) {
            messages.push(new KeyCodeControlMessage(MotionEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_UP, 0, 0));
            messages.push(new KeyCodeControlMessage(MotionEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_UP, 0, 0));
        }
        if (hDir === -1) {
            messages.push(new KeyCodeControlMessage(MotionEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_RIGHT, 0, 0));
            messages.push(new KeyCodeControlMessage(MotionEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_RIGHT, 0, 0));
        } else if (hDir === 1) {
            messages.push(new KeyCodeControlMessage(MotionEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_LEFT, 0, 0));
            messages.push(new KeyCodeControlMessage(MotionEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_LEFT, 0, 0));
        }
        return messages;
    }

    public buildScrollEvent(event: WheelEvent, screenInfo: ScreenInfo): ScrollControlMessage[] {
        const messages: ScrollControlMessage[] = [];
        const touchOnClient = InteractionHandler.buildTouchOnClient(event, screenInfo);
        if (touchOnClient) {
            const hScroll = event.deltaX > 0 ? -1 : event.deltaX < 0 ? 1 : 0;
            const vScroll = event.deltaY > 0 ? -1 : event.deltaY < 0 ? 1 : 0;
            const time = Date.now();
            if (
                !this.lastScrollEvent ||
                time - this.lastScrollEvent.time > FeaturedInteractionHandler.SCROLL_EVENT_THROTTLING_TIME ||
                this.lastScrollEvent.vScroll !== vScroll ||
                this.lastScrollEvent.hScroll !== hScroll
            ) {
                this.lastScrollEvent = { time, hScroll, vScroll };
                messages.push(new ScrollControlMessage(touchOnClient.touch.position, hScroll, vScroll, 0));
            }
        }
        return messages;
    }

    // Mouse button → Android keycode mapping (matches scrcpy desktop client defaults)
    private static readonly BUTTON_KEYCODE_MAP: Record<number, number> = {
        2: KeyEvent.KEYCODE_BACK, // right-click → BACK
        1: KeyEvent.KEYCODE_HOME, // middle-click → HOME
    };

    protected onInteraction(event: MouseEvent | TouchEvent): void {
        const screenInfo = this.player.getScreenInfo();
        if (!screenInfo) {
            return;
        }
        let messages: ControlMessage[];
        let storage: Map<number, TouchControlMessage>;
        if (event instanceof MouseEvent) {
            if (event.target !== this.tag) {
                return;
            }
            // Right-click → back, middle-click → home (always, both modes)
            const keycode = FeaturedInteractionHandler.BUTTON_KEYCODE_MAP[event.button];
            if (keycode !== undefined && (event.type === 'mousedown' || event.type === 'mouseup')) {
                const action = event.type === 'mousedown' ? MotionEvent.ACTION_DOWN : MotionEvent.ACTION_UP;
                this.listener.sendMessage(new KeyCodeControlMessage(action, keycode, 0, 0));
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            if (window['WheelEvent'] && event instanceof WheelEvent) {
                if (this._dpadMode) {
                    messages = this.buildDpadScrollEvent(event);
                } else {
                    messages = this.buildScrollEvent(event, screenInfo);
                }
            } else if (this._dpadMode && event.button === 0 && (event.type === 'mousedown' || event.type === 'mouseup')) {
                // D-pad mode: left-click → DPAD_CENTER
                const action = event.type === 'mousedown' ? MotionEvent.ACTION_DOWN : MotionEvent.ACTION_UP;
                this.listener.sendMessage(new KeyCodeControlMessage(action, KeyEvent.KEYCODE_DPAD_CENTER, 0, 0));
                event.preventDefault();
                event.stopPropagation();
                return;
            } else {
                storage = this.storedFromMouseEvent;
                messages = this.buildTouchEvent(event, screenInfo, storage);
            }
            if (this.over) {
                this.lastPosition = event;
            }
        } else if (window['TouchEvent'] && event instanceof TouchEvent) {
            // TODO: Research drag from out of the target inside it
            if (event.target !== this.tag) {
                return;
            }
            storage = this.storedFromTouchEvent;
            messages = this.formatTouchEvent(event, screenInfo, storage);
        } else {
            console.error(TAG, 'Unsupported event', event);
            return;
        }
        if (event.cancelable) {
            event.preventDefault();
        }
        event.stopPropagation();
        messages.forEach((message) => {
            this.listener.sendMessage(message);
        });
    }

    protected onKey(event: KeyboardEvent): void {
        if (!this.lastPosition) {
            return;
        }
        const screenInfo = this.player.getScreenInfo();
        if (!screenInfo) {
            return;
        }
        const { ctrlKey, shiftKey } = event;
        const { target, button, buttons, clientY, clientX } = this.lastPosition;
        const type = InteractionHandler.SIMULATE_MULTI_TOUCH;
        const props = { ctrlKey, shiftKey, type, target, button, buttons, clientX, clientY };
        this.buildTouchEvent(props, screenInfo, new Map());
    }

    private onMouseEnter = (): void => {
        this.over = true;
    };
    private onMouseLeave = (): void => {
        this.lastPosition = undefined;
        this.over = false;
        this.storedFromMouseEvent.forEach((message) => {
            this.listener.sendMessage(InteractionHandler.createEmulatedMessage(MotionEvent.ACTION_UP, message));
        });
        this.storedFromMouseEvent.clear();
        this.clearCanvas();
    };

    public release(): void {
        super.release();
        this.tag.removeEventListener('mouseleave', this.onMouseLeave);
        this.tag.removeEventListener('mouseenter', this.onMouseEnter);
        this.storedFromMouseEvent.clear();
    }
}
