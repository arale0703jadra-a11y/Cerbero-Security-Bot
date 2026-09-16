import type { DatabaseClient } from "../database/client.js";
import {
  createAuditEntry,
  createSecurityEvent,
} from "../database/repositories/events-repository.js";

export async function publishEvent(
  db: DatabaseClient,
  groupId: number,
  eventType: string,
  details: Record<string, unknown>,
  userId?: number,
): Promise<void> {
  const eventDetails = details;
  await createSecurityEvent(db, {
    group_id: groupId,
    event_type: eventType,
    user_id: userId,
    details,
    group_title: typeof eventDetails.groupTitle === "string" ? eventDetails.groupTitle : undefined,
    username: typeof eventDetails.username === "string" ? eventDetails.username : undefined,
    message_id: typeof eventDetails.messageId === "number" ? eventDetails.messageId : undefined,
    severity: typeof eventDetails.severity === "string" ? eventDetails.severity : undefined,
    action: typeof eventDetails.actionPerformed === "string" ? eventDetails.actionPerformed : undefined,
    result: typeof eventDetails.result === "string" ? eventDetails.result : undefined,
    error: typeof eventDetails.actionError === "string" ? eventDetails.actionError : undefined,
    executor: "Cerbero",
  });
}

export async function publishAudit(
  db: DatabaseClient,
  action: string,
  result: string,
): Promise<void> {
  await createAuditEntry(db, action, result);
}
