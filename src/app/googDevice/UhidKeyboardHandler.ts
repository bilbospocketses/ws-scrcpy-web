// src/app/googDevice/UhidKeyboardHandler.ts
import type { UhidManager } from './UhidManager';
import { CODE_TO_HID, MODIFIER_CODES } from './hid-usage-tables';

export class UhidKeyboardHandler {
    private pressedKeys = new Set<number>();
    private modifierState = 0;

    constructor(private readonly manager: UhidManager) {
        this.onKeyDown = this.onKeyDown.bind(this);
        this.onKeyUp = this.onKeyUp.bind(this);
    }

    attach(): void {
        document.addEventListener('keydown', this.onKeyDown);
        document.addEventListener('keyup', this.onKeyUp);
    }

    detach(): void {
        document.removeEventListener('keydown', this.onKeyDown);
        document.removeEventListener('keyup', this.onKeyUp);
        // Release all keys
        this.pressedKeys.clear();
        this.modifierState = 0;
        this.manager.sendKeyReport(0, []);
    }

    private onKeyDown(event: KeyboardEvent): void {
        event.preventDefault();

        const modBit = MODIFIER_CODES[event.code];
        if (modBit) {
            this.modifierState |= modBit;
            this.sendReport();
            return;
        }

        const hid = CODE_TO_HID[event.code];
        if (hid && !this.pressedKeys.has(hid)) {
            this.pressedKeys.add(hid);
            this.sendReport();
        }
    }

    private onKeyUp(event: KeyboardEvent): void {
        event.preventDefault();

        const modBit = MODIFIER_CODES[event.code];
        if (modBit) {
            this.modifierState &= ~modBit;
            this.sendReport();
            return;
        }

        const hid = CODE_TO_HID[event.code];
        if (hid) {
            this.pressedKeys.delete(hid);
            this.sendReport();
        }
    }

    private sendReport(): void {
        const keycodes = Array.from(this.pressedKeys).slice(0, 6);
        this.manager.sendKeyReport(this.modifierState, keycodes);
    }
}
