const CHEAT_SHEET_NOTE = 'See the subnet cheat sheet at /help/subnets.html for help.';

export interface ParsedSubnet {
    raw: string;
    normalized: string;
    hostCount: number;
    hosts(): Generator<string>;
}

export interface ParseError {
    reason: string;
}

export function parseSubnetInput(input: string): ParsedSubnet | ParseError {
    const raw = input.trim();
    if (!raw) return unrecognized();

    // Try CIDR
    if (raw.includes('/')) return parseCidr(raw);

    // Try range
    if (raw.includes('-')) return parseRange(raw);

    // Try bare IP
    if (isValidIp(raw)) {
        return {
            raw,
            normalized: `${raw}/32`,
            hostCount: 1,
            *hosts() {
                yield raw;
            },
        };
    }

    return unrecognized();
}

function parseCidr(input: string): ParsedSubnet | ParseError {
    if (input.split('/').length > 2) return unrecognized();
    const [ipPart, prefixPart] = input.split('/');
    if (!ipPart || !prefixPart) return unrecognized();
    if (!isValidIp(ipPart)) return { reason: `Invalid IP address "${ipPart}". ${CHEAT_SHEET_NOTE}` };

    const prefix = Number.parseInt(prefixPart, 10);
    if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) {
        return { reason: `Prefix must be between /16 and /32. ${CHEAT_SHEET_NOTE}` };
    }
    if (prefix < 16) {
        return {
            reason:
                'Subnet too large — maximum prefix is /16 (65,534 hosts). ' +
                'If you need to cover more than that, add multiple /16 entries ' +
                "(one per subnet) using the 'add subnet' button. " +
                CHEAT_SHEET_NOTE,
        };
    }
    const ipInt = ipToInt(ipPart);
    const maskBits = 32 - prefix;
    const netmask = maskBits === 32 ? 0 : (0xffffffff << maskBits) >>> 0;
    const networkInt = (ipInt & netmask) >>> 0;
    const normalizedIp = intToIp(networkInt);
    const normalized = `${normalizedIp}/${prefix}`;

    const hostCount = prefix === 32 ? 1 : 2 ** maskBits - 2;
    // /31 is unusual (2 hosts) but legal — we allow it.
    const effectiveHostCount = prefix === 32 ? 1 : prefix === 31 ? 2 : hostCount;

    return {
        raw: input,
        normalized,
        hostCount: effectiveHostCount,
        *hosts() {
            if (prefix === 32) {
                yield normalizedIp;
                return;
            }
            // Iterate: network+1 .. broadcast-1 (standard usable range)
            // For /31 the two addresses both count as usable.
            const start = prefix === 31 ? networkInt : networkInt + 1;
            const end = prefix === 31 ? networkInt + 1 : networkInt + 2 ** maskBits - 2;
            for (let i = start; i <= end; i++) {
                yield intToIp(i >>> 0);
            }
        },
    };
}

function parseRange(input: string): ParsedSubnet | ParseError {
    const dashIdx = input.indexOf('-');
    const startStr = input.slice(0, dashIdx).trim();
    const endStr = input.slice(dashIdx + 1).trim();

    if (!isValidIp(startStr)) return { reason: `Invalid start IP "${startStr}". ${CHEAT_SHEET_NOTE}` };

    // Shorthand: "192.168.1.10-20"
    let endIp: string;
    if (isValidIp(endStr)) {
        endIp = endStr;
    } else if (/^\d{1,3}$/.test(endStr)) {
        const startParts = startStr.split('.');
        endIp = `${startParts[0]}.${startParts[1]}.${startParts[2]}.${endStr}`;
        if (!isValidIp(endIp)) return { reason: `Invalid end octet "${endStr}". ${CHEAT_SHEET_NOTE}` };
    } else {
        return { reason: `Invalid end of range "${endStr}". ${CHEAT_SHEET_NOTE}` };
    }

    const startNorm = intToIp(ipToInt(startStr));
    const endNorm = intToIp(ipToInt(endIp));
    const startParts = startNorm.split('.');
    const endParts = endNorm.split('.');
    // Same /24 check
    if (startParts[0] !== endParts[0] || startParts[1] !== endParts[1] || startParts[2] !== endParts[2]) {
        return {
            reason:
                "Range must stay within the same /24 — that's a block of up to 254 hosts " +
                'where only the last number changes (e.g. 192.168.1.10-50). ' +
                'For anything larger, switch to CIDR notation like 192.168.1.0/24. ' +
                CHEAT_SHEET_NOTE,
        };
    }

    const startInt = ipToInt(startStr);
    const endInt = ipToInt(endIp);
    if (startInt > endInt) {
        return { reason: `Range start must be ≤ end (got ${startStr} > ${endIp}). ${CHEAT_SHEET_NOTE}` };
    }

    const hostCount = endInt - startInt + 1;
    return {
        raw: input,
        normalized: `${startNorm}-${endNorm}`,
        hostCount,
        *hosts() {
            for (let i = startInt; i <= endInt; i++) {
                yield intToIp(i >>> 0);
            }
        },
    };
}

function unrecognized(): ParseError {
    return {
        reason:
            'Unrecognized format. Try CIDR (192.168.1.0/24), a single IP (192.168.1.5), ' +
            `or a range (192.168.1.10-50). ${CHEAT_SHEET_NOTE}`,
    };
}

function isValidIp(s: string): boolean {
    const parts = s.split('.');
    if (parts.length !== 4) return false;
    for (const p of parts) {
        if (!/^\d{1,3}$/.test(p)) return false;
        const n = Number.parseInt(p, 10);
        if (n < 0 || n > 255) return false;
    }
    return true;
}

function ipToInt(ip: string): number {
    const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function intToIp(n: number): string {
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}
