/**
 * The file name the Local HTTPS CA certificate downloads as.
 *
 * The content is PEM, as it always was; since 0.5.3 the name ends in `.crt`
 * instead of `.pem`. Every platform the install guide covers (Windows, macOS,
 * Linux, Android, iOS / iPadOS) and Firefox accept a PEM certificate under that
 * extension, and Linux's `update-ca-certificates` reads only `*.crt`, so the
 * Linux steps no longer begin with renaming the file.
 *
 * Shared by the server (`GET /api/tls/ca-root`'s Content-Disposition) and the
 * client (the name the panel saves under), so the two cannot disagree.
 */
export const CA_ROOT_DOWNLOAD_FILE_NAME = 'ws-scrcpy-web-local-ca.crt';
