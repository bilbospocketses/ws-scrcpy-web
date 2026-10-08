// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { ClipboardCopyPrompt } from '../ClipboardCopyPrompt';

/**
 * The device's clipboard reaches the browser as a WebSocket message, outside any
 * click, and Safari, Firefox and an iframe embed without `clipboard-write` may
 * refuse to write the clipboard then. When they do, a prompt offers the text and
 * its button does the write inside the click. Visibility is asserted on
 * `hidden`, not text: jsdom reports the text of a hidden element too.
 */

function stubClipboard(writeText: ((text: string) => Promise<void>) | undefined) {
    vi.stubGlobal('navigator', { ...navigator, clipboard: writeText ? { writeText } : undefined });
}

/**
 * Replace `document.execCommand` for one test (removed again in afterEach).
 * `undefined` stands for a browser without the legacy command.
 */
function stubExecCommand(impl: ((command: string) => boolean) | undefined): Mock<(command: string) => boolean> {
    const fn = vi.fn<(command: string) => boolean>(impl ?? (() => false));
    Object.defineProperty(document, 'execCommand', { value: impl ? fn : undefined, configurable: true });
    return fn;
}

function copyButton(prompt: ClipboardCopyPrompt): HTMLButtonElement {
    return prompt.element.querySelector<HTMLButtonElement>('.stream-clipboard-prompt-copy')!;
}

/** A promise the test settles by hand, to order a write's outcome against later events. */
function deferred() {
    let resolve!: () => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** Let the clipboard promise settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const refused = () => new DOMException('not allowed', 'NotAllowedError');

/** A prompt already showing `text`: the automatic write was refused. */
async function shownPrompt(text: string, writeText: Mock<(text: string) => Promise<void>>) {
    writeText.mockRejectedValueOnce(refused());
    stubClipboard(writeText);
    const prompt = new ClipboardCopyPrompt();
    prompt.deliver(text);
    await settle();
    expect(prompt.element.hidden, 'precondition: the prompt is showing').toBe(false);
    return prompt;
}

beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // The legacy command refuses unless a test says otherwise.
    stubExecCommand(() => false);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (document as unknown as { execCommand?: unknown }).execCommand;
    document.body.replaceChildren();
});

describe('ClipboardCopyPrompt — the automatic write', () => {
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
        stubClipboard(vi.fn(async () => Promise.reject(refused())));
        const prompt = new ClipboardCopyPrompt();

        prompt.deliver('refused text');
        await settle();

        expect(prompt.element.hidden).toBe(false);
        expect(prompt.getPendingText()).toBe('refused text');
        expect(prompt.element.textContent).toContain('Device clipboard ready');
        expect(copyButton(prompt).textContent).toBe('click to copy');
    });

    it('prompts straight away when the page has no async Clipboard API', () => {
        stubClipboard(undefined);
        const prompt = new ClipboardCopyPrompt();

        prompt.deliver('no api');

        expect(prompt.element.hidden).toBe(false);
        expect(prompt.getPendingText()).toBe('no api');
    });

    it('a newer device clipboard replaces the pending text', async () => {
        stubClipboard(vi.fn(async () => Promise.reject(new Error('refused'))));
        const prompt = new ClipboardCopyPrompt();

        prompt.deliver('older');
        await settle();
        prompt.deliver('newer');
        await settle();

        expect(prompt.getPendingText()).toBe('newer');
    });

    it('a newer clipboard that copies fine hides a prompt still offering an older one', async () => {
        const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
        const prompt = await shownPrompt('older', writeText);

        prompt.deliver('newer');
        await settle();

        expect(prompt.element.hidden).toBe(true);
    });

    it("an older write's late REFUSAL does not replace the newer offer", async () => {
        const first = deferred();
        const writeText = vi
            .fn<(text: string) => Promise<void>>()
            .mockReturnValueOnce(first.promise)
            .mockRejectedValueOnce(refused());
        stubClipboard(writeText);
        const prompt = new ClipboardCopyPrompt();

        prompt.deliver('A');
        prompt.deliver('B');
        await settle();
        expect(prompt.getPendingText()).toBe('B');

        first.reject(refused());
        await settle();

        expect(prompt.getPendingText(), "A's refusal settled late and must not re-offer A").toBe('B');
        expect(prompt.element.hidden).toBe(false);
    });

    it("an older write's late SUCCESS does not hide the newer offer", async () => {
        const first = deferred();
        const writeText = vi
            .fn<(text: string) => Promise<void>>()
            .mockReturnValueOnce(first.promise)
            .mockRejectedValueOnce(refused());
        stubClipboard(writeText);
        const prompt = new ClipboardCopyPrompt();

        prompt.deliver('A');
        prompt.deliver('B');
        await settle();

        first.resolve();
        await settle();

        expect(prompt.element.hidden, "A's success says nothing about B, which is still uncopied").toBe(false);
        expect(prompt.getPendingText()).toBe('B');
    });
});

describe('ClipboardCopyPrompt — the click', () => {
    it('tries the copy command first, inside the click; when it works the async API is not used', async () => {
        const writeText = vi.fn<(text: string) => Promise<void>>();
        const prompt = await shownPrompt('click me', writeText);
        let copied: string | undefined;
        const execCommand = stubExecCommand(() => {
            copied = document.querySelector('textarea')?.value;
            return true;
        });

        copyButton(prompt).click();

        expect(execCommand).toHaveBeenCalledWith('copy');
        expect(copied, 'the command copies a textarea holding the pending text').toBe('click me');
        expect(writeText, 'only the automatic write, none from the click').toHaveBeenCalledTimes(1);
        expect(prompt.element.hidden).toBe(true);
        expect(prompt.getPendingText()).toBeUndefined();
    });

    it('falls back to the async API, still inside the click, when the copy command refuses', async () => {
        const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
        const prompt = await shownPrompt('click me', writeText);
        const execCommand = stubExecCommand(() => false);

        copyButton(prompt).click();
        // The write must start inside the click, before any await.
        expect(execCommand).toHaveBeenCalledWith('copy');
        expect(writeText).toHaveBeenCalledTimes(2);
        expect(writeText).toHaveBeenLastCalledWith('click me');
        await settle();

        expect(prompt.element.hidden).toBe(true);
        expect(prompt.getPendingText()).toBeUndefined();
    });

    it('falls back to the async API when the copy command throws', async () => {
        const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
        const prompt = await shownPrompt('click me', writeText);
        stubExecCommand(() => {
            throw new Error('SecurityError');
        });

        copyButton(prompt).click();
        expect(writeText).toHaveBeenCalledTimes(2);
        await settle();

        expect(prompt.element.hidden).toBe(true);
    });

    it('keeps the prompt and logs when both the copy command and the async API fail', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const writeText = vi.fn<(text: string) => Promise<void>>().mockRejectedValue(refused());
        const prompt = await shownPrompt('stuck', writeText);
        stubExecCommand(() => false);

        copyButton(prompt).click();
        await settle();

        expect(writeText).toHaveBeenCalledTimes(2);
        expect(prompt.element.hidden).toBe(false);
        expect(prompt.getPendingText()).toBe('stuck');
        expect(error).toHaveBeenCalledTimes(1);
    });

    it('keeps the prompt and logs when the page has neither the copy command nor the async API', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        stubClipboard(undefined);
        stubExecCommand(undefined);
        const prompt = new ClipboardCopyPrompt();
        prompt.deliver('nowhere to go');

        copyButton(prompt).click();

        expect(prompt.element.hidden).toBe(false);
        expect(error).toHaveBeenCalledTimes(1);
    });

    it('a delivery that arrives while the click write is pending keeps its own prompt', async () => {
        const clickWrite = deferred();
        const writeText = vi.fn<(text: string) => Promise<void>>();
        const prompt = await shownPrompt('A', writeText);
        writeText.mockReturnValueOnce(clickWrite.promise).mockRejectedValueOnce(refused());

        copyButton(prompt).click();
        prompt.deliver('B');
        await settle();
        expect(prompt.getPendingText()).toBe('B');

        clickWrite.resolve();
        await settle();

        expect(prompt.element.hidden, 'copying A does not put B on the clipboard').toBe(false);
        expect(prompt.getPendingText()).toBe('B');
    });

    describe('the copy command leaves no textarea behind', () => {
        const outcomes: Array<[string, () => boolean]> = [
            ['it succeeds', () => true],
            ['it refuses', () => false],
            [
                'it throws',
                () => {
                    throw new Error('SecurityError');
                },
            ],
        ];
        for (const [when, impl] of outcomes) {
            it(`when ${when}`, async () => {
                const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
                const prompt = await shownPrompt('temporary', writeText);
                let during: HTMLTextAreaElement | null = null;
                stubExecCommand(() => {
                    during = document.querySelector('textarea');
                    return impl();
                });

                copyButton(prompt).click();

                expect(during, 'the textarea exists while the command runs').not.toBeNull();
                expect(document.querySelector('textarea')).toBeNull();
                await settle();
            });
        }

        it('pins the textarea to the viewport corner, out of sight', async () => {
            const writeText = vi.fn<(text: string) => Promise<void>>();
            const prompt = await shownPrompt('styled', writeText);
            let style: CSSStyleDeclaration | undefined;
            stubExecCommand(() => {
                style = document.querySelector('textarea')?.style;
                return true;
            });

            copyButton(prompt).click();

            expect(style?.position).toBe('fixed');
            expect(style?.top).toBe('0px');
            expect(style?.left).toBe('0px');
            expect(style?.opacity).toBe('0');
        });
    });

    describe('the copy command gives focus back', () => {
        /**
         * A browser's `select()` focuses the textarea, and removing it leaves
         * focus on the body; jsdom's `select()` does not focus, so the spy
         * restores that half of the browser's behaviour.
         */
        function selectFocuses() {
            const select = HTMLTextAreaElement.prototype.select;
            vi.spyOn(HTMLTextAreaElement.prototype, 'select').mockImplementation(function (this: HTMLTextAreaElement) {
                this.focus();
                select.call(this);
            });
        }

        const outcomes: Array<[string, () => boolean]> = [
            ['it succeeds', () => true],
            [
                'it throws',
                () => {
                    throw new Error('SecurityError');
                },
            ],
        ];
        for (const [when, impl] of outcomes) {
            it(`to the element that had it, when ${when}`, async () => {
                const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
                const prompt = await shownPrompt('focus', writeText);
                const input = document.createElement('input');
                document.body.append(input, prompt.element);
                input.focus();
                selectFocuses();
                let focusedDuring: Element | null = null;
                stubExecCommand(() => {
                    focusedDuring = document.activeElement;
                    return impl();
                });

                copyButton(prompt).click();

                expect(focusedDuring, 'precondition: the textarea took focus').toBeInstanceOf(HTMLTextAreaElement);
                expect(document.querySelector('textarea')).toBeNull();
                expect(document.activeElement).toBe(input);
                await settle();
            });
        }
    });
});

describe('ClipboardCopyPrompt — dismissal and lifetime', () => {
    it('the dismiss button hides it', async () => {
        stubClipboard(vi.fn(async () => Promise.reject(new Error('refused'))));
        const prompt = new ClipboardCopyPrompt();
        prompt.deliver('dismiss me');
        await settle();

        prompt.element.querySelector<HTMLButtonElement>('.stream-clipboard-prompt-dismiss')!.click();

        expect(prompt.element.hidden).toBe(true);
        expect(prompt.getPendingText()).toBeUndefined();
    });

    it('hides itself after a while', () => {
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

    it("a newer offer gets its full time: the older offer's timer does not hide it early", () => {
        vi.useFakeTimers();
        stubClipboard(undefined);
        const prompt = new ClipboardCopyPrompt();
        prompt.deliver('first');
        vi.advanceTimersByTime(20_000);
        prompt.deliver('second');

        vi.advanceTimersByTime(ClipboardCopyPrompt.AUTO_HIDE_MS - 1);
        expect(prompt.element.hidden, "the first offer's 30 s ran out 20 s ago").toBe(false);
        expect(prompt.getPendingText()).toBe('second');
        vi.advanceTimersByTime(1);
        expect(prompt.element.hidden).toBe(true);
    });

    it('dispose() stops the timer', () => {
        vi.useFakeTimers();
        stubClipboard(undefined);
        const prompt = new ClipboardCopyPrompt();
        prompt.deliver('shown');
        expect(vi.getTimerCount()).toBe(1);

        prompt.dispose();

        expect(vi.getTimerCount()).toBe(0);
    });

    it('a write refused after dispose() neither shows the prompt nor arms a timer', async () => {
        vi.useFakeTimers();
        const write = deferred();
        stubClipboard(vi.fn<(text: string) => Promise<void>>().mockReturnValueOnce(write.promise));
        const prompt = new ClipboardCopyPrompt();
        prompt.deliver('in flight at stop');

        prompt.dispose();
        write.reject(refused());
        // Settles after deliver()'s own handler, which was attached first.
        await Promise.allSettled([write.promise]);

        expect(console.warn, "precondition: deliver()'s refusal handler ran").toHaveBeenCalled();
        expect(prompt.element.hidden).toBe(true);
        expect(vi.getTimerCount(), 'no 30 s timer on a detached prompt').toBe(0);
    });
});
