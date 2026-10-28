import type { Bot } from "grammy";
import { recordServiceHealth } from "./resilience.js";

export function installUpdateHealthHandling(
  bot: Bot,
  logError: (message: string) => void = (message) => console.error(message),
): void {
  bot.catch((error) => {
    const health = recordServiceHealth("updates", error.error);
    const message =
      `[CERBERO] update handler failed; health=degraded failures=${health.consecutiveFailures} ` +
      `errorClass=${health.lastErrorClass ?? "unknown"}: ${health.lastError ?? "unknown error"}`;
    try {
      logError(message);
    } catch {
      try {
        console.error(`${message} (error logger failed)`);
      } catch {
        // Do not allow a failing logger to reject grammY's error handler.
      }
    }
  });

  bot.use(async (_ctx, next) => {
    await next();
    recordServiceHealth("updates");
  });
}
