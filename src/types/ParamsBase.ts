export interface ParamsBase {
    action: string;
    useProxy?: boolean | undefined;
    secure?: boolean | undefined;
    hostname?: string | undefined;
    port?: number | undefined;
    pathname?: string | undefined;
}
