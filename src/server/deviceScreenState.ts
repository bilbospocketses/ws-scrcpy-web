/**
 * Device screen state, as reported by `dumpsys`.
 *
 * `locked` is the field that matters for streaming: **Android will not let
 * anything capture the screen while the keyguard is up.** scrcpy receives a
 * black surface, encodes it faithfully, and the browser decodes and paints
 * black — measured at 13 bytes per frame at a steady 15fps, next to 30-50KB
 * once unlocked. The device's own `screencap` returns black under the same
 * conditions, which is how we know the capture path is not at fault.
 *
 * Without this, a locked phone is indistinguishable from a broken stream. That
 * cost issue #498 several rounds: every "this codec is black" result was really
 * "the phone locked itself", and the codec matrix built on top was meaningless.
 */
export interface DeviceScreenState {
    /** The display is on (`mWakefulness=Awake`). */
    awake: boolean;
    /** The keyguard is up, so screen capture yields black. */
    locked: boolean;
}

/**
 * One shell round trip for both readings. `grep` runs on the device, so only
 * the matched lines cross the wire rather than the whole dumpsys output.
 */
export const SCREEN_STATE_COMMAND =
    'dumpsys power 2>/dev/null | grep -m1 mWakefulness; dumpsys window 2>/dev/null | grep -m1 -i isKeyguardShowing';

/**
 * Parse the combined output of {@link SCREEN_STATE_COMMAND}.
 *
 * Both fields default to a "nothing is wrong" reading when absent, because
 * this drives a warning banner: a device whose dumpsys we cannot parse should
 * not be reported as locked. A false "your phone is locked" on a working
 * stream is worse than saying nothing.
 */
export function parseScreenState(output: string): DeviceScreenState {
    const awakeMatch = /mWakefulness=(\w+)/i.exec(output);
    const keyguardMatch = /isKeyguardShowing=(true|false)/i.exec(output);
    return {
        awake: awakeMatch ? awakeMatch[1]!.toLowerCase() === 'awake' : true,
        locked: keyguardMatch ? keyguardMatch[1]!.toLowerCase() === 'true' : false,
    };
}
