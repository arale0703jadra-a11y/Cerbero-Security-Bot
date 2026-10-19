export function isRepeatedMessage(
  recentMessages: string[],
  message: string,
  repeats = 3,
): boolean {
  return recentMessages.slice(-repeats).every((item) => item === message);
}
