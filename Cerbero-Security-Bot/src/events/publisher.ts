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
    action:
      typeof eventDetails.actionPerformed === "string"
        ? eventDetails.actionPerformed
        : typeof eventDetails.action === "string"
          ? eventDetails.action
          : undefined,
    result: typeof eventDetails.result === "string" ? eventDetails.result : undefined,
    error:
      typeof eventDetails.actionError === "string"
        ? eventDetails.actionError
        : typeof eventDetails.error === "string"
          ? eventDetails.error
          : undefined,
    executor: "Cerbero",
    command_id: typeof eventDetails.commandId === "string" ? eventDetails.commandId : undefined,
    processing_instance_id:
      typeof eventDetails.processingInstanceId === "string"
        ? eventDetails.processingInstanceId
        : undefined,
    reason: typeof eventDetails.reason === "string" ? eventDetails.reason : undefined,
  });
}

export async function publishAudit(
  db: DatabaseClient,
  action: string,
  result: string,
  metadata: {
    commandId?: string;
    groupId?: number;
    targetUserId?: number;
    targetMessageId?: number;
    processingInstanceId?: string;
    error?: string;
    reason?: string;
  } = {},
): Promise<void> {
  await createAuditEntry(db, action, result, {
    command_id: metadata.commandId,
    group_id: metadata.groupId,
    target_user_id: metadata.targetUserId,
    target_message_id: metadata.targetMessageId,
    processing_instance_id: metadata.processingInstanceId,
    error: metadata.error,
    reason: metadata.reason,
  });
}
