import { lookup as dnsLookup } from 'dns/promises';

/**
 * A scan probes IPv4 literals, so a hostname connect, or a hostname transport
 * the device tracker sees, is recorded at its IPv4 (`scanAddressFor`).
 */
export async function lookupIpv4(hostname: string): Promise<string | null> {
    const { address } = await dnsLookup(hostname, { family: 4 });
    return address;
}
