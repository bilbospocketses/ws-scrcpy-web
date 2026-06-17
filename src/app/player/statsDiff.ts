/**
 * True when two string arrays differ in length or in any element. Replaces an
 * inline loop in drawStats whose post-increment bound (`i++ < length`) skipped
 * index 0 and then compared one element past the end of the array. (#91)
 */
export function stringArraysDiffer(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) {
        return true;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return true;
        }
    }
    return false;
}
