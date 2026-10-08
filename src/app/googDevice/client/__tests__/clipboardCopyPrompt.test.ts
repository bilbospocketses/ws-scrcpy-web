// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClipboardCopyPrompt } from '../ClipboardCopyPrompt';

/**
 * The device's clipboard reaches the browser as a WebSocket message, outside any
 * click, and Safari and Firefox may refuse to write the clipboard then. When
 * they do, a prompt offers the text and its button does the write inside the
 * click. Visibility is asserted on `hidden`, not text: jsdom reports the text of
 * a hidden element too.
 */

function stubClipboard(writeText: ((text: string) => Promise<void>) | undefined) {
    vi.stubGlobal('navigator', { ...navigator, clipboard: writeText ? { writeText } : undefined });
}

function copyButton(prompt: ClipboardCopyPrompt): HTMLButtonElement {
    return prompt.element.querySelector<HTMLButtonElement>('.stream-clipboard-prompt-copy')!;
}

/** Let the clipboard promise settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('ClipboardCopyPrompt', () => {
    it('writes the text and shows no prompt when the browser allows it', async () => {
        const writeText = vi.fn(async () => undefined);
        stubClipboard(writeText);
        const prompt = new ClipboardCopyPrompt();

        prompt.deliver('copied on the device');
        await settle();

        expect(writeText).toHaveBeenCalledWith('copied on the device');
        expect(prompt.element.hidden).toBe(true);
        expect(prompt.getPendingText()).toBeUndefined();
    });

    it('shows the prompt with the text pending when the browser refuses the write', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        stubClipboard(vi.fn(async () => Promise.reject(new DOMException('not allowed', 'NotAllowedError'))));
        const prompt = new ClipboardCopyPrompt();

        prompt.deliver('refused text');
        await settle();

        expect(prompt.element.hidden).toBe(false);
        expect(prompt.getPendingText()).toBe('refused text');
        expect(prompt.element.textContent).toContain('Device clipboard ready');
        expect(copyButton(prompt).textContent).toBe('click to copy');
    });

    it('clicking the prompt writes the pending text and dismisses it', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const writeText = vi
            .fn<(text: string) => Promise<void>>()
            .mockRejectedValueOnce(new DOMException('not allowed', 'NotAllowedError'))
            .mockResolvedValue(undefined);
        stubClipboard(writeText);
        const prompt = new ClipboardCopyPrompt();
        prompt.deliver('click me');
        await settle();
        expect(prompt.element.hidden).toBe(false);

        copyButton(prompt).click();
        // The write must start inside the click, before any await.
        expect(writeText).toHaveBeenCalledTimes(2);
        expect(writeText).toHaveBeenLastCalledWith('click me');
        await settle();

        expect(prompt.element.hidden).toBe(true);
        expect(prompt.getPendingText()).toBeUndefined();
    });

    it('a newer device clipboard replaces the pending text', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        stubClipboard(vi.fn(async () => Promise.reject(new Error('refused'))));
        const prompt = new ClipboardCopyPrompt();

        prompt.deliver('older');
        await settle();
        prompt.deliver('newer');
        await settle();

        expect(prompt.getPendingText()).toBe('newer');
    });

    it('a newer clipboard that copies fine hides a prompt still offering an older one', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const writeText = vi
            .fn<(text: string) => Promise<void>>()
            .mockRejectedValueOnce(new Error('refused'))
            .mockResolvedValue(undefined);
        stubClipboard(writeText);
        const prompt = new ClipboardCopyPrompt();

        prompt.deliver('older');
        await settle();
        expect(prompt.element.hidden).toBe(false);
        prompt.deliver('newer');
        await settle();

        expect(prompt.element.hidden).toBe(true);
    });

    it('the dismiss button hides it', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        stubClipboard(vi.fn(async () => Promise.reject(new Error('refused'))));
        const prompt = new ClipboardCopyPrompt();
        prompt.deliver('dismiss me');
        await settle();

        prompt.element.querySelector<HTMLButtonElement>('.stream-clipboard-prompt-dismiss')!.click();

        expect(prompt.element.hidden).toBe(true);
        expect(prompt.getPendingText()).toBeUndefined();
    });

    it('hides itself after a while', async () => {
        vi.useFakeTimers();
        stubClipboard(undefined);
        const prompt = new ClipboardCopyPrompt();
        prompt.deliver('fades');
        expect(prompt.element.hidden).toBe(false);

        vi.advanceTimersByTime(ClipboardCopyPrompt.AUTO_HIDE_MS - 1);
        expect(prompt.element.hidden).toBe(false);
        vi.advanceTimersByTime(1);
        expect(prompt.element.hidden).toBe(true);
    });

    it('with no async clipboard API (plain HTTP) it prompts, and the click falls back to the copy command', () => {
        stubClipboard(undefined);
        const execCommand = vi.fn(() => true);
        Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
        const prompt = new ClipboardCopyPrompt();

        prompt.deliver('no api');
        expect(prompt.element.hidden).toBe(false);

        copyButton(prompt).click();

        expect(execCommand).toHaveBeenCalledWith('copy');
        expect(prompt.element.hidden).toBe(true);
        delete (document as unknown as { execCommand?: unknown }).execCommand;
    });
});
