/**
 * Arguments for extracting a dependency tarball: never take the ARCHIVE's
 * owners or permission bits.
 *
 * Run as root, GNU tar restores each entry's recorded owner by default
 * (`--same-owner`), and nodejs.org's Linux tarballs record uid/gid 1001. The
 * system service runs as root, so its Node tree came out owned by uid 1001 --
 * a real account on many machines, which could then replace the `node` the
 * root service executes (D16, qa-harness L3 on beta.147). The copy into
 * `dependencies/` kept those owners (libuv's copyfile preserves them as root).
 *
 * `--no-same-owner` makes every extracted entry belong to whoever runs tar;
 * `--no-same-permissions` applies that process's umask instead of the archive's
 * bits. For a non-root user both are already tar's default, so nothing changes
 * there. GNU tar and bsdtar (Windows' System32 tar.exe) both accept them.
 */
export const TAR_SAFE_EXTRACT_FLAGS = ['--no-same-owner', '--no-same-permissions'] as const;

/** `tar -xzf <archive> <safe flags> ...extra`. Pure. */
export function tarExtractArgs(archive: string, extra: readonly string[] = []): string[] {
    return ['-xzf', archive, ...TAR_SAFE_EXTRACT_FLAGS, ...extra];
}
