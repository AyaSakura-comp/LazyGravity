/**
 * Central allow-list check.
 *
 * Returns true when the user is explicitly listed OR when the allow-list
 * contains the wildcard `*` (ALLOWED_USER_IDS=*), which opens the bot to
 * everyone. ⚠️ `*` grants IDE/command control on the host to anyone who can
 * reach the bot — use only on trusted servers. Revert by removing `*`.
 */
export function isUserAllowed(allowedUserIds: string[], userId: string): boolean {
    return allowedUserIds.includes('*') || allowedUserIds.includes(userId);
}
