import { isValidWebPort } from '../Config';
import { findAvailablePort as realFindAvailablePort } from '../PortPicker';
import { isLinuxSystemServiceInstance as realIsLinuxSystemServiceInstance } from '../siblingInstance';

/** Injectable seams; each defaults to the production implementation. */
export interface SystemServicePortGuardDeps {
    isLinuxSystemServiceInstance?: () => boolean;
    findAvailablePort?: (start: number, end: number) => Promise<number | null>;
}

/**
 * Why `requested` cannot become the web port, or null when it can.
 *
 * Only the Linux SYSTEM service ever refuses. It binds config.json's webPort
 * exactly, with no walk forward (reconcileWebPort.ts), so a port another program
 * holds would leave it failing its bind on every restart until systemd's start
 * limit gave up, and the service down. Every other install mode walks forward on
 * the restart, so for them a busy port is not a reason to refuse.
 *
 * The probe is the reconcile's own, `findAvailablePort(port, port)`, and it runs
 * BEFORE anything is written. Ports this process listens on (`ownPorts`: the
 * current web port, the Local HTTPS port) are not "another program" -- the
 * restart releases them -- so they are not probed. A value validation would
 * refuse is left to that 400.
 */
export async function systemServicePortRefusal(
    requested: unknown,
    ownPorts: readonly number[],
    deps: SystemServicePortGuardDeps = {},
): Promise<string | null> {
    const isSystemService = deps.isLinuxSystemServiceInstance ?? (() => realIsLinuxSystemServiceInstance());
    const findAvailablePort = deps.findAvailablePort ?? realFindAvailablePort;
    if (!isSystemService() || !isValidWebPort(requested) || ownPorts.includes(requested)) return null;
    if ((await findAvailablePort(requested, requested)) === requested) return null;
    return `port ${requested} is in use by another program; the system service binds its port exactly, so pick a free one`;
}
