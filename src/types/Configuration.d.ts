import type * as https from 'https';

export type OperatingSystem = 'android';

export interface HostItem {
    type: OperatingSystem;
    secure: boolean;
    hostname: string;
    port: number;
    pathname?: string | undefined;
    useProxy?: boolean | undefined;
}

export interface HostsItem {
    type: OperatingSystem | OperatingSystem[];
    secure: boolean;
    hostname: string;
    port: number;
    pathname?: string | undefined;
    useProxy?: boolean | undefined;
}

export type ExtendedServerOption = https.ServerOptions & {
    certPath?: string;
    keyPath?: string;
};

export interface ServerItem {
    secure: boolean;
    port: number;
    options?: ExtendedServerOption;
    redirectToSecure?:
        | {
              port?: number;
              host?: string;
          }
        | boolean;
}

// The configuration file must contain a single object with this structure
export interface Configuration {
    server?: ServerItem[];
    runGoogTracker?: boolean;
    announceGoogTracker?: boolean;
    remoteHostList?: HostsItem[];
}
