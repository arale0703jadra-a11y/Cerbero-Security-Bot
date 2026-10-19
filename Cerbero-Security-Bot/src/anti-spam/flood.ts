export function isFlood(count: number, windowMs: number, limit = 8): boolean {
  return windowMs > 0 && count > limit;
}
