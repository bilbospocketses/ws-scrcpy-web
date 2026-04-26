/**
 * Linux ServiceClient stub for SP3 P3.
 *
 * Per the SP3 plan, Linux Velopack + systemd service mode are in-scope for
 * SP3 as a later sub-phase. P3 lays the architectural groundwork so the Linux
 * sub-phase is purely additive — no churn on ServiceApi.ts, SettingsModal.ts,
 * or WelcomeModal.ts when this stub gets replaced with a real implementation.
 *
 * Every method throws the same sentinel string. Tests assert the throws to
 * pin the contract; replacing the stub later means deleting the throws and
 * filling in the systemctl invocations.
 */

import type {
    ServiceClient,
    ServiceInstallOptions,
    ServiceStatus,
} from './ServiceClient';

export const SYSTEMD_NOT_IMPLEMENTED_MESSAGE = 'Linux service mode lands later in SP3';

export class SystemdClient implements ServiceClient {
    public async install(_opts: ServiceInstallOptions): Promise<void> {
        throw new Error(SYSTEMD_NOT_IMPLEMENTED_MESSAGE);
    }

    public async uninstall(_name: string): Promise<void> {
        throw new Error(SYSTEMD_NOT_IMPLEMENTED_MESSAGE);
    }

    public async status(_name: string): Promise<ServiceStatus> {
        throw new Error(SYSTEMD_NOT_IMPLEMENTED_MESSAGE);
    }

    public async restart(_name: string): Promise<void> {
        throw new Error(SYSTEMD_NOT_IMPLEMENTED_MESSAGE);
    }

    public async stop(_name: string): Promise<void> {
        throw new Error(SYSTEMD_NOT_IMPLEMENTED_MESSAGE);
    }
}
