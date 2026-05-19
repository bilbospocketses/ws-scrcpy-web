// Resolves an IPv4 address to its MAC address by reading the OS's ARP cache.
// Meant to be called immediately after a successful TCP connection to the
// target (which populates the ARP cache as a side effect of L3 routing).
// Returns a normalized lowercase-colon MAC (e.g. "aa:bb:cc:dd:ee:ff") or null
// when the lookup fails or yields no match.

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface MacResolverDeps {
    runCommand: (bin: string, args: string[]) => Promise<string>;
    platform: NodeJS.Platform;
}

const DEFAULT_DEPS: MacResolverDeps = {
    runCommand: async (bin, args) => {
        const { stdout } = await execFileAsync(bin, args, { timeout: 2000, maxBuffer: 1024 * 1024 });
        return stdout;
    },
    platform: process.platform,
};

export async function resolveMac(ip: string, deps: MacResolverDeps = DEFAULT_DEPS): Promise<string | null> {
    try {
        if (deps.platform === 'win32') {
            const out = await deps.runCommand('arp', ['-a', ip]);
            return parseWindowsArp(out, ip);
        }
        if (deps.platform === 'linux') {
            const out = await deps.runCommand('ip', ['neigh', 'show', 'to', ip]);
            return parseLinuxIpNeigh(out);
        }
    } catch {
        return null;
    }
    return null;
}

export function parseWindowsArp(output: string, ip: string): string | null {
    // Expected row shape (tab- or space-delimited):
    //   192.168.86.231        aa-bb-cc-dd-ee-ff     dynamic
    for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith(ip)) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length < 2) continue;
        if (parts[0] !== ip) continue;
        const mac = parts[1]!;
        if (isMacString(mac)) {
            return normalizeMac(mac);
        }
    }
    return null;
}

export function parseLinuxIpNeigh(output: string): string | null {
    // Expected: "192.168.86.231 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE"
    const match = output.match(/lladdr\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i);
    return match ? normalizeMac(match[1]!) : null;
}

function isMacString(s: string): boolean {
    return /^[0-9a-f]{2}([-:][0-9a-f]{2}){5}$/i.test(s);
}

function normalizeMac(s: string): string {
    return s.toLowerCase().replace(/-/g, ':');
}

export const __internals = {
    parseWindowsArp,
    parseLinuxIpNeigh,
    normalizeMac,
    isMacString,
};
