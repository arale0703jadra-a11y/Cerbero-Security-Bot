import type { DatabaseClient } from "../database/client.js";
import { updateHeartbeat } from "../database/repositories/bot-repository.js";
import { safeErrorMessage } from "./resilience.js";

export function startHeartbeat(
  db: DatabaseClient,
  instanceId: string,
  intervalMs = 30_000,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    void updateHeartbeat(db, instanceId).catch((error) => {
      console.error(`[CERBERO] heartbeat failed: ${safeErrorMessage(error)}`);
    });
  }, intervalMs);
  return timer;
}
