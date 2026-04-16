export enum XtermServiceActions {
    start = 0,
    stop = 1,
    resize = 2,
}

export interface XtermServiceParameters {
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: { [key: string]: string };
    udid: string;
}

export interface XtermClientMessage extends XtermServiceParameters {
    type: keyof typeof XtermServiceActions;
    pid?: number;
}
