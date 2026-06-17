import { parseWmDensityStrict, parseWmSizeStrict } from './wmParsers';

export type DeviceKind = 'phone' | 'tablet' | 'tv';

/**
 * Classify an Android device as phone, tablet, or tv using four shell outputs.
 * Returns undefined when the inputs are insufficient to decide (e.g., all parsers fail),
 * so callers can retry on the next poll instead of committing a wrong answer.
 */
export function classifyDeviceKind(
    characteristics: string,
    leanback: string,
    wmSize: string,
    wmDensity: string,
): DeviceKind | undefined {
    if (/\btv\b/.test(characteristics) || leanback.trim() === 'true') {
        return 'tv';
    }
    const size = parseWmSizeStrict(wmSize);
    const density = parseWmDensityStrict(wmDensity);
    if (!size || !density) {
        return undefined;
    }
    const smallestDp = Math.min(size.width, size.height) / (density / 160);
    return smallestDp >= 600 ? 'tablet' : 'phone';
}
