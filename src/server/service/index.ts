/**
 * Factory entry point for the cross-platform ServiceClient.
 *
 * Selects the right implementation for `process.platform`:
 *   - 'win32'   -> ServyClient   (real, supported=true)
 *   - 'linux'   -> SystemdClient (real, supported=true; SP3 P4b)
 *   - other     -> throwing stub (supported=false; service mode unsupported)
 *
 * The factory always returns a ServiceClient (never null) so callers don't
 * need null-checking — `supported=false` is the gate. Methods on the
 * unsupported clients throw, which the API layer treats as a 501 surface.
 */

import type { ServiceClient, ServiceClientFactoryResult, ServiceInstallOptions, ServiceStatus } from './ServiceClient';
import { ServyClient } from './ServyClient';
import { SystemdClient } from './SystemdClient';

class UnsupportedPlatformClient implements ServiceClient {
    constructor(private readonly reason: string) {}
    public async install(_opts: ServiceInstallOptions): Promise<void> {
        throw new Error(this.reason);
    }
    public async uninstall(_name: string): Promise<void> {
        throw new Error(this.reason);
    }
    public async status(_name: string): Promise<ServiceStatus> {
        throw new Error(this.reason);
    }
    public async restart(_name: string): Promise<void> {
        throw new Error(this.reason);
    }
    public async stop(_name: string): Promise<void> {
        throw new Error(this.reason);
    }
}

/**
 * Resolve a ServiceClient appropriate for the host platform plus metadata
 * the API layer needs to render the supported / unsupported UX.
 *
 * The `platform` argument is exposed for tests. Production callers omit it
 * and the factory consults `process.platform`.
 */
export function getServiceClient(platform: NodeJS.Platform = process.platform): ServiceClientFactoryResult {
    if (platform === 'win32') {
        return {
            client: new ServyClient(),
            supported: true,
            platform,
        };
    }
    if (platform === 'linux') {
        return {
            client: new SystemdClient(),
            supported: true,
            platform,
        };
    }
    return {
        client: new UnsupportedPlatformClient('Service mode unsupported on this platform'),
        supported: false,
        platform,
        unsupportedReason: 'Service mode unsupported on this platform',
    };
}

export type {
    ServiceClient,
    ServiceClientFactoryResult,
    ServiceInstallOptions,
    ServiceStatus,
} from './ServiceClient';
