import { execFile } from 'child_process';
import * as os from 'os';
import { promisify } from 'util';
import { resolveSystemTool } from '../service/systemTools';

const execFileAsync = promisify(execFile);

export interface DetectedSubnet {
    cidr: string;
    hostCount: number;
    source: 'gateway' | 'interface';
    interfaceName?: string | undefined;
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
        if (!bin) throw new Error('empty command');
        // Resolve the OS tool (ip/route) to an absolute path so it can't be
        // hijacked via $PATH / %PATH% (#20).
        const { stdout } = await execFileAsync(resolveSystemTool(bin), args, { timeout: 3000, maxBuffer: 1024 * 1024 });
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
        // `ip route show default` may emit multiple lines on multi-homed hosts.
        // Skip any line whose gateway is 0.0.0.0 (not a real gateway — the adapter
        // is not truly connected to anything routable). Pick lowest-metric survivor.
        const route = await deps.runCommand('ip route show default');
        let bestIface: string | null = null;
        let bestMetric = Number.POSITIVE_INFINITY;
        for (const line of route.split('\n')) {
            const lineMatch = line.match(/default\s+via\s+(\d+\.\d+\.\d+\.\d+)\s+dev\s+(\S+)/);
            if (!lineMatch) continue;
            const gateway = lineMatch[1]!;
            const ifaceName = lineMatch[2]!;
            if (gateway === '0.0.0.0') continue;
            if (!/^[\w:.\-]+$/.test(ifaceName)) continue;
            const metricMatch = line.match(/\bmetric\s+(\d+)/);
            const metric = metricMatch ? Number.parseInt(metricMatch[1]!, 10) : 0;
            if (metric < bestMetric) {
                bestMetric = metric;
                bestIface = ifaceName;
            }
        }
        if (!bestIface) return null;
        const addr = await deps.runCommand(`ip -o -4 addr show dev ${bestIface}`);
        const cidrM = addr.match(/inet (\d+\.\d+\.\d+\.\d+\/\d+)/);
        if (!cidrM) return null;
        return fromCidrString(cidrM[1]!, 'gateway', bestIface);
    }

    if (deps.platform === 'win32') {
        // `route print -4` lists a default route (0.0.0.0/0) for every adapter —
        // even those without a real gateway, which show "On-link" in the gateway
        // column. Only accept rows whose gateway is a real IP (not On-link,
        // not 0.0.0.0), then pick the lowest-metric survivor.
        const output = await deps.runCommand('route print -4');
        const defaultRouteRe = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\S+)\s+(\S+)\s+(\d+)/gm;
        const candidates: { ifaceIp: string; metric: number }[] = [];
        let m: RegExpExecArray | null;
        while ((m = defaultRouteRe.exec(output)) !== null) {
            const gateway = m[1]!;
            const ifaceIp = m[2]!;
            const metric = Number.parseInt(m[3]!, 10);
            if (gateway === 'On-link' || gateway === '0.0.0.0') continue;
            if (!/^\d+\.\d+\.\d+\.\d+$/.test(gateway)) continue;
            candidates.push({ ifaceIp, metric });
        }
        if (candidates.length === 0) return null;
        candidates.sort((a, b) => a.metric - b.metric);
        const best = candidates[0]!;
        const interfaces = deps.getInterfaces();
        for (const [name, entries] of Object.entries(interfaces)) {
            for (const entry of entries ?? []) {
                if (entry.family === 'IPv4' && !entry.internal && entry.address === best.ifaceIp) {
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
    const best = candidates[0]!;
    const network = __internals.cidrNetwork(best.entry.address, best.prefix);
    return buildDetected(`${network}/${best.prefix}`, 'interface', best.name);
}

function fromCidrString(cidr: string, source: 'gateway' | 'interface', ifaceName?: string): DetectedSubnet | null {
    const [ip, prefixStr] = cidr.split('/');
    if (!ip || !prefixStr) return null;
    const prefix = Number.parseInt(prefixStr, 10);
    if (!Number.isFinite(prefix)) return null;
    const network = __internals.cidrNetwork(ip, prefix);
    return buildDetected(`${network}/${prefix}`, source, ifaceName);
}

function buildDetected(cidr: string, source: 'gateway' | 'interface', ifaceName?: string): DetectedSubnet {
    const prefix = Number.parseInt(cidr.split('/')[1]!, 10);
    const hostCount = prefix === 32 ? 1 : 2 ** (32 - prefix) - 2;
    return { cidr, hostCount, source, interfaceName: ifaceName };
}

function isRfc1918(ip: string): boolean {
    const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) return true;
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
        const ipInt = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
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
