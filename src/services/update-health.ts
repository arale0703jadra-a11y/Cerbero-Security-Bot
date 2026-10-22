import type { Bot } from "grammy";
import { recordServiceHealth } from "./resilience.js";

export function installUpdateHealthHandling(
  bot: Bot,
  logError: (message: string) => void = (message) => console.error(message),
): void {
  bot.catch((error) => {
    const health = recordServiceHealth("updates", error.error);
    logError(
      `[CERBERO] update handler failed; health=degraded failures=${health.consecutiveFailures} ` +
        `errorClass=${health.lastErrorClass ?? "unknown"}: ${health.lastError ?? "unknown error"}`,
    );
  });

  bot.use(async (_ctx, next) => {
    await next();
    recordServiceHealth("updates");
  });
}
