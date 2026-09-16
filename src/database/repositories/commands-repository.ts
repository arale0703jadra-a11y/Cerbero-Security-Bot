import type { DatabaseClient } from "../client.js";
import type { SecurityCommand } from "../types.js";

export async function claimNextCommand(
  db: DatabaseClient,
  instanceId: string,
): Promise<SecurityCommand | undefined> {
  const { data, error } = await db.rpc("claim_security_command", {
    p_instance_id: instanceId,
  });
  if (error) throw error;
  const command = Array.isArray(data) ? data[0] : data;
  return (command as SecurityCommand | undefined) ?? undefined;
}

export async function completeCommand(
  db: DatabaseClient,
  commandId: string,
  status: "completed" | "failed",
  errorMessage?: string,
): Promise<void> {
  const { error } = await db
    .from("security_commands")
    .update({
      status,
      executed_at: new Date().toISOString(),
      processing_instance_id: null,
      processing_at: null,
      last_error: errorMessage ?? null,
    })
    .eq("id", commandId)
    .eq("status", "processing");
  if (error) throw error;
}

export async function cancelCommand(
  db: DatabaseClient,
  commandId: string,
): Promise<void> {
  const { error } = await db
    .from("security_commands")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      processing_instance_id: null,
      processing_at: null,
    })
    .eq("id", commandId)
    .in("status", ["pending", "processing"]);
  if (error) throw error;
}
