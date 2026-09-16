import type { DatabaseClient } from "../client.js";

export async function createSecurityEvent(
  db: DatabaseClient,
  event: {
    group_id: number;
    event_type: string;
    user_id?: number;
    details: Record<string, unknown>;
    group_title?: string;
    username?: string;
    message_id?: number;
    severity?: string;
    action?: string;
    result?: string;
    error?: string;
    executor?: string;
  },
): Promise<void> {
  const { error } = await db.from("security_events").insert({
    ...event,
    user_id: event.user_id ?? null,
  });
  if (error) throw error;
}

export async function createAuditEntry(
  db: DatabaseClient,
  action: string,
  result: string,
): Promise<void> {
  const { error } = await db.from("security_audit_log").insert({
    action,
    executed_by: "Cerbero",
    result,
  });
  if (error) throw error;
}
