/**
 * Remote admin without sign-in (`AppConfig.allowRemoteAdmin`), shared by the
 * server's settings batch and the Settings → Users item that stages it.
 */

/** The staged-field id, which is also the config key it writes. */
export const REMOTE_ADMIN_ID = 'allowRemoteAdmin';

/**
 * Why the setting cannot be turned off while the environment forces it on:
 * the Users item's note, and the batch's refusal of an attempt to turn it off,
 * in one wording.
 */
export const REMOTE_ADMIN_FORCED_MESSAGE =
    'forced on by WS_SCRCPY_ALLOW_REMOTE_ADMIN=1 on the server; remove the variable to turn it off.';

/**
 * The `error` of the 403 `requireOperator` answers a caller that is not the
 * operator: off this machine, with neither sign-in nor remote admin to prove
 * otherwise. Shared so Settings can tell that refusal from a role's
 * (`requireAdmin`'s `forbidden`) and say which one it met (0.5.6).
 */
export const OPERATOR_REFUSAL_ERROR = 'admin actions are limited to this machine';
