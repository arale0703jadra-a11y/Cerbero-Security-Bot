export function isSupportedAction(action: string): boolean {
  return [
    "DELETE_MESSAGE",
    "MUTE_USER",
    "UNMUTE_USER",
    "BAN_USER",
    "UNBAN_USER",
    "KICK_USER",
    "UPDATE_SECURITY_CONFIG",
    "UPDATE_PROTECTED_USER",
  ].includes(action);
}
