export default class Util {
    private static SUFFIX: Record<number, string> = {
        0: 'B',
        1: 'KiB',
        2: 'MiB',
        3: 'GiB',
        4: 'TiB',
    };
    private static supportsPassiveValue: boolean | undefined;

    public static filterTrailingZeroes(bytes: Uint8Array): Uint8Array {
        let b = 0;
        return bytes
            .reverse()
            .filter((i) => b || (b = i))
            .reverse();
    }

    public static prettyBytes(value: number): string {
        let suffix = 0;
        while (value >= 512) {
            suffix++;
            value /= 1024;
        }
        return `${value.toFixed(suffix ? 1 : 0)}${Util.SUFFIX[suffix]}`;
    }

    public static escapeUdid(udid: string): string {
        return 'udid_' + udid.replace(/[. :]/g, '_');
    }

    public static parse(params: URLSearchParams, name: string, required?: boolean): string | null {
        const value = params.get(name);
        if (required && value === null) {
            throw TypeError(`Missing required parameter "${name}"`);
        }
        return value;
    }

    public static parseString(params: URLSearchParams, name: string, required?: boolean): string {
        const value = params.get(name);
        if (required && value === null) {
            throw TypeError(`Missing required parameter "${name}"`);
        }
        return value || '';
    }

    public static parseBoolean(params: URLSearchParams, name: string, required?: boolean): boolean {
        const value = this.parse(params, name, required);
        return value === '1' || (!!value && value.toString() === 'true');
    }

    public static parseInt(params: URLSearchParams, name: string, required?: boolean): number {
        const value = this.parse(params, name, required);
        if (value === null) {
            return 0;
        }
        const int = Number.parseInt(value, 10);
        if (isNaN(int)) {
            return 0;
        }
        return int;
    }

    public static parseBooleanEnv(input: string | string[] | boolean | undefined | null): boolean | undefined {
        if (typeof input === 'boolean') {
            return input;
        }
        if (typeof input === 'undefined' || input === null) {
            return undefined;
        }
        if (Array.isArray(input)) {
            input = input[input.length - 1];
        }
        return input === '1' || input.toLowerCase() === 'true';
    }

    public static parseStringEnv(input: string | string[] | undefined | null): string | undefined {
        if (typeof input === 'undefined' || input === null) {
            return undefined;
        }
        if (Array.isArray(input)) {
            input = input[input.length - 1];
        }
        return input;
    }
    public static parseIntEnv(input: string | string[] | number | undefined | null): number | undefined {
        if (typeof input === 'number') {
            return input;
        }
        if (typeof input === 'undefined' || input === null) {
            return undefined;
        }
        if (Array.isArray(input)) {
            input = input[input.length - 1];
        }
        const int = Number.parseInt(input, 10);
        if (isNaN(int)) {
            return undefined;
        }
        return int;
    }

    // https://github.com/google/closure-library/blob/51e5a5ac373aefa354a991816ec418d730e29a7e/closure/goog/crypt/crypt.js#L117
    // https://github.com/WICG/EventListenerOptions/blob/gh-pages/explainer.md
    static supportsPassive(): boolean {
        if (typeof Util.supportsPassiveValue === 'boolean') {
            return Util.supportsPassiveValue;
        }

        // Test via a getter in the options object to see if the passive property is accessed
        let supportsPassive = false;
        try {
            const opts = Object.defineProperty({}, 'passive', {
                get: () => {
                    supportsPassive = true;
                },
            });

            // @ts-expect-error
            window.addEventListener('testPassive', null, opts);
            // @ts-expect-error
            window.removeEventListener('testPassive', null, opts);
        } catch (error: any) {}

        return (Util.supportsPassiveValue = supportsPassive);

        // Use our detect's results. passive applied if supported, capture will be false either way.
        // elem.addEventListener('touchstart', fn, supportsPassive ? { passive: true } : false);
    }

    static setImmediate(fn: () => any): void {
        Promise.resolve().then(fn);
    }
}
