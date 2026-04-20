import { execFile } from 'child_process';
import * as os from 'os';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface DetectedSubnet {
    cidr: string;
    hostCount: number;
    source: 'gateway' | 'interface';
    interfaceName?: string;
}

export interface DetectorDeps {
    getInterfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
    runCommand: (cmd: string) => Promise<string>;
    platform: NodeJS.Platform;
}

const DEFAULT_DEPS: DetectorDeps = {
    getInterfaces: () => os.networkInterfaces(),
    runCommand: async (cmd: string) => {
        const [bin, ...args] = splitCommand(cmd);
        const { stdout } = await execFileAsync(bin, args, { timeout: 3000, maxBuffer: 1024 * 1024 });
        return stdout;
    },
    platform: process.platform,
};

export async function detectSubnet(deps: DetectorDeps = DEFAULT_DEPS): Promise<DetectedSubnet | null> {
    try {
        const gw = await detectViaGateway(deps);
        if (gw) return gw;
    } catch {
        // fall through
    }

    const iface = detectViaInterfaces(deps.getInterfaces());
    if (iface) return iface;

    return null;
}

async function detectViaGateway(deps: DetectorDeps): Promise<DetectedSubnet | null> {
    if (deps.platform === 'linux') {
        const route = await deps.runCommand('ip route show default');
        const m = route.match(/default via [\d.]+ dev (\S+)/);
        if (!m) return null;
        const ifaceName = m[1];
        // Hygiene: interface names are typically [a-zA-Z0-9:._-]; reject anything weirder
        // to avoid any surprises in how the name is passed to execFile.
        if (!/^[\w:.\-]+$/.test(ifaceName)) return null;
        const addr = await deps.runCommand(`ip -o -4 addr show dev ${ifaceName}`);
        const cidrM = addr.match(/inet (\d+\.\d+\.\d+\.\d+\/\d+)/);
        if (!cidrM) return null;
        return fromCidrString(cidrM[1], 'gateway', ifaceName);
    }

    if (deps.platform === 'win32') {
        const output = await deps.runCommand('route print -4');
        const m = output.match(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+\S+\s+(\S+)\s+\d+/m);
        if (!m) return null;
        const gatewayIfaceIp = m[1];
        const interfaces = deps.getInterfaces();
        for (const [name, entries] of Object.entries(interfaces)) {
            for (const entry of entries ?? []) {
                if (entry.family === 'IPv4' && !entry.internal && entry.address === gatewayIfaceIp) {
                    const prefix = __internals.netmaskToPrefix(entry.netmask);
                    if (prefix === null) return null;
                    const network = __internals.cidrNetwork(entry.address, prefix);
                    return buildDetected(`${network}/${prefix}`, 'gateway', name);
                }
            }
        }
    }

    return null;
}

function detectViaInterfaces(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): DetectedSubnet | null {
    const candidates: { name: string; entry: os.NetworkInterfaceInfo; prefix: number }[] = [];
    for (const [name, entries] of Object.entries(interfaces)) {
        for (const entry of entries ?? []) {
            if (entry.family !== 'IPv4' || entry.internal) continue;
            if (!isRfc1918(entry.address)) continue;
            const prefix = __internals.netmaskToPrefix(entry.netmask);
            if (prefix === null || prefix < 16 || prefix > 32) continue;
            candidates.push({ name, entry, prefix });
        }
    }
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => a.prefix - b.prefix);
    const best = candidates[0];
    const network = __internals.cidrNetwork(best.entry.address, best.prefix);
    return buildDetected(`${network}/${best.prefix}`, 'interface', best.name);
}

function fromCidrString(cidr: string, source: 'gateway' | 'interface', ifaceName?: string): DetectedSubnet | null {
    const [ip, prefixStr] = cidr.split('/');
    const prefix = Number.parseInt(prefixStr, 10);
    if (!Number.isFinite(prefix)) return null;
    const network = __internals.cidrNetwork(ip, prefix);
    return buildDetected(`${network}/${prefix}`, source, ifaceName);
}

function buildDetected(cidr: string, source: 'gateway' | 'interface', ifaceName?: string): DetectedSubnet {
    const prefix = Number.parseInt(cidr.split('/')[1], 10);
    const hostCount = prefix === 32 ? 1 : 2 ** (32 - prefix) - 2;
    return { cidr, hostCount, source, interfaceName: ifaceName };
}

function isRfc1918(ip: string): boolean {
    const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    return false;
}

function splitCommand(cmd: string): string[] {
    return cmd.split(/\s+/).filter(Boolean);
}

export const __internals = {
    netmaskToPrefix(mask: string): number | null {
        const parts = mask.split('.');
        if (parts.length !== 4) return null;
        let bits = 0;
        let seenZero = false;
        for (const p of parts) {
            const n = Number.parseInt(p, 10);
            if (!Number.isFinite(n) || n < 0 || n > 255) return null;
            const octetBits = (n.toString(2).match(/1/g) || []).length;
            if (seenZero && octetBits > 0) return null;
            if (octetBits < 8) seenZero = true;
            bits += octetBits;
        }
        return bits;
    },
    cidrNetwork(ip: string, prefix: number): string {
        const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
        const ipInt = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
        const maskBits = 32 - prefix;
        const netmask = maskBits === 32 ? 0 : (0xffffffff << maskBits) >>> 0;
        const networkInt = (ipInt & netmask) >>> 0;
        return [
            (networkInt >>> 24) & 0xff,
            (networkInt >>> 16) & 0xff,
            (networkInt >>> 8) & 0xff,
            networkInt & 0xff,
        ].join('.');
    },
};
