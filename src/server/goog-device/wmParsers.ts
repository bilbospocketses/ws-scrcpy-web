export function parseWmSizeStrict(output: string): { width: number; height: number } | undefined {
    const override = output.match(/Override size:\s*(\d+)x(\d+)/);
    if (override) {
        return { width: Number.parseInt(override[1]!, 10), height: Number.parseInt(override[2]!, 10) };
    }
    const physical = output.match(/Physical size:\s*(\d+)x(\d+)/);
    if (physical) {
        return { width: Number.parseInt(physical[1]!, 10), height: Number.parseInt(physical[2]!, 10) };
    }
    return undefined;
}

export function parseWmSize(output: string): { width: number; height: number } {
    return parseWmSizeStrict(output) ?? { width: 1920, height: 1080 };
}

export function parseWmDensityStrict(output: string): number | undefined {
    const override = output.match(/Override density:\s*(\d+)/);
    if (override) {
        return Number.parseInt(override[1]!, 10);
    }
    const physical = output.match(/Physical density:\s*(\d+)/);
    if (physical) {
        return Number.parseInt(physical[1]!, 10);
    }
    return undefined;
}

export function parseWmDensity(output: string): number {
    return parseWmDensityStrict(output) ?? 320;
}
