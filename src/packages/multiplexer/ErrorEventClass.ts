// Polyfill for ErrorEvent on server runtimes. Node 24 still has not
// promoted ErrorEvent to a global (tracked at nodejs/node#49986) though
// Event, CloseEvent, and MessageEvent are all present. In browsers it's
// always available, so the export below picks native when defined.

class ErrorEventPolyfill extends Event {
    readonly colno: number;
    readonly error: unknown;
    readonly filename: string;
    readonly lineno: number;
    readonly message: string;

    constructor(type: string, { colno, error, filename, lineno, message }: ErrorEventInit = {}) {
        super(type);
        this.error = error;
        this.colno = colno ?? 0;
        this.filename = filename ?? '';
        this.lineno = lineno ?? 0;
        this.message = message ?? '';
    }
}

export const ErrorEventClass: typeof ErrorEvent =
    typeof ErrorEvent !== 'undefined' ? ErrorEvent : (ErrorEventPolyfill as unknown as typeof ErrorEvent);
