export interface ParamsBase {
    action: string;
    secure?: boolean | undefined;
    hostname?: string | undefined;
    port?: number | undefined;
    pathname?: string | undefined;
}
